import { Inject, Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx, Prisma } from '@venueos/db';
import type {
  CreateQuotationInput,
  QuoteInput,
  QuotationDto,
  QuotationListQuery,
  QuotationListResponse,
  QuotationPdfDto,
  QuotationWhatsAppDto,
  QuotePreviewDto,
  SendQuotationInput,
  SendQuotationResultDto,
} from '@venueos/shared';
import { QuotePreviewSchema, formatInstantForEmail, pdfObjectKey } from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  FieldValidationError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
} from '../../common/errors/domain-errors';
import { EmailOutbox } from '../../common/jobs/email-outbox.service';
import { PresignService } from '../../common/storage/presign.service';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import { BookingWriter, previewDto } from '../bookings/core/booking-writer.service';
import { QuoteBuilder } from '../bookings/core/quote-builder.service';
import { LeadLink, fmt, loadTenantContext } from '../bookings/core/support';

const Snapshot = QuotePreviewSchema.pick({
  sessions: true,
  lines: true,
  totals: true,
  taxRate: true,
  discount: true,
});

const encodeCursor = (id: string): string => Buffer.from(`q1:${id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith('q1:') || decoded.length < 4)
    throw new FieldValidationError('cursor', 'Invalid cursor');
  return decoded.slice(3);
}

const QUOTATION_INCLUDE = {
  booking: {
    include: {
      customer: {
        select: { id: true, name: true, phone: true, email: true, preferredLocale: true },
      },
      venue: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.QuotationInclude;
type QuotationRow = Prisma.QuotationGetPayload<{ include: typeof QUOTATION_INCLUDE }>;

const dateOnly = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);

/**
 * Quotations (docs/01 module 7, docs/05 sections 3 and 13): price a set of sessions (preview), save it as a DRAFT booking with
 * its first version, and work with the versions: send (email with the PDF attached), mark accepted, download, share on WhatsApp.
 * Prices are only ever computed here from catalogue ids; the client never sends one.
 */
@Injectable()
export class QuotationsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly caller: Caller,
    private readonly venueScope: VenueScope,
    private readonly builder: QuoteBuilder,
    private readonly writer: BookingWriter,
    private readonly leadLink: LeadLink,
    private readonly emailOutbox: EmailOutbox,
    private readonly presign: PresignService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    void this.config;
  }

  /** A quotation is a priced document: a caller who may not see prices has nothing to work with. */
  private requirePrices(): void {
    if (!this.caller.has('booking.view_prices')) {
      throw new ForbiddenError('You may not see prices.');
    }
  }

  private scope(): Prisma.QuotationWhereInput {
    const ids = this.venueScope.filterIds();
    return ids ? { booking: { venueId: { in: ids } } } : {};
  }

  // ───────────────────────────── preview and create ─────────────────────────────

  async preview(input: QuoteInput): Promise<QuotePreviewDto> {
    this.requirePrices();
    this.venueScope.assertAccess(input.venueId);
    const limit = this.caller.access.limits.maxDiscountPct;
    return this.tenantDb.tx(async (tx) => {
      const built = await this.builder.build(tx, {
        venueId: input.venueId,
        sessions: input.sessions,
        discount: input.discount,
        maxDiscountPct: limit,
        warn: true,
        canSeeBookingNumbers: this.caller.has('booking.view'),
      });
      return previewDto(built, limit, true);
    });
  }

  async create(input: CreateQuotationInput): Promise<QuotationDto> {
    this.requirePrices();
    const tenantId = this.caller.tenantId;
    this.venueScope.assertAccess(input.venueId);
    const limit = this.caller.access.limits.maxDiscountPct;
    return this.tenantDb.tx(async (tx) => {
      const { customerId, leadId } = await this.resolveCustomer(tx, input);
      let cancellationPolicyId: string | null = null;
      if (input.cancellationPolicyId) {
        const policy = await tx.cancellationPolicy.findFirst({
          where: { id: input.cancellationPolicyId, tenantId, active: true },
          select: { id: true },
        });
        if (!policy) throw new NotFoundError();
        cancellationPolicyId = policy.id;
      }
      const built = await this.builder.build(tx, {
        venueId: input.venueId,
        sessions: input.sessions,
        discount: input.discount,
        maxDiscountPct: limit,
        warn: true,
        canSeeBookingNumbers: this.caller.has('booking.view'),
      });
      const written = await this.writer.write(
        tx,
        built,
        { customerId, leadId, notes: input.notes ?? null, cancellationPolicyId },
        {},
      );
      await this.leadLink.advance(tx, tenantId, leadId, 'QUOTED');
      await this.audit.record(tx, {
        action: 'quotation.create',
        entityType: 'booking',
        entityId: written.bookingId,
        venueId: input.venueId,
        after: {
          quotationId: written.quotationId,
          version: written.version,
          grandTotal: built.result.grandTotal,
          sessions: built.sessions.length,
          discount: built.discount,
        },
      });
      return this.dto(tx, await this.load(tx, written.quotationId));
    });
  }

  /** The customer of a new quotation: given directly, or the one of the lead (which must agree when both are given). */
  private async resolveCustomer(
    tx: DbTx,
    input: Pick<QuoteInput, 'customerId' | 'leadId'>,
  ): Promise<{ customerId: string; leadId: string | null }> {
    const tenantId = this.caller.tenantId;
    let customerId = input.customerId ?? null;
    let leadId: string | null = null;
    if (input.leadId) {
      const ids = this.venueScope.filterIds();
      const lead = await tx.lead.findFirst({
        where: { id: input.leadId, tenantId, ...(ids ? { venueId: { in: ids } } : {}) },
        select: { id: true, customerId: true },
      });
      if (!lead) throw new NotFoundError();
      if (customerId !== null && customerId !== lead.customerId) {
        throw new FieldValidationError(
          'customerId',
          'This customer is not the customer of the lead',
        );
      }
      customerId = lead.customerId;
      leadId = lead.id;
    }
    if (customerId === null)
      throw new FieldValidationError('customerId', 'Give a customer or a lead');
    const customer = await tx.customer.findFirst({
      where: { id: customerId, tenantId, active: true },
      select: { id: true },
    });
    if (!customer) throw new NotFoundError();
    return { customerId: customer.id, leadId };
  }

  // ───────────────────────────── reads ─────────────────────────────

  async list(query: QuotationListQuery): Promise<QuotationListResponse> {
    this.requirePrices();
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const where: Prisma.QuotationWhereInput = {
        tenantId,
        ...this.scope(),
        ...(query.bookingId ? { bookingId: query.bookingId } : {}),
        ...(query.customerId || query.leadId
          ? {
              booking: {
                ...(query.customerId ? { customerId: query.customerId } : {}),
                ...(query.leadId ? { leadId: query.leadId } : {}),
                ...(this.venueScope.filterIds()
                  ? { venueId: { in: this.venueScope.filterIds() as string[] } }
                  : {}),
              },
            }
          : {}),
      };
      let cursorId: string | undefined;
      if (query.cursor !== undefined) {
        cursorId = decodeCursor(query.cursor);
        const known = await tx.quotation.findFirst({
          where: { id: cursorId, tenantId, ...this.scope() },
          select: { id: true },
        });
        if (!known) throw new FieldValidationError('cursor', 'Invalid cursor');
      }
      const rows = await tx.quotation.findMany({
        where,
        include: QUOTATION_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
      });
      const page = rows.slice(0, query.limit);
      const latest = await this.latestVersions(
        tx,
        page.map((r) => r.bookingId),
      );
      const last = page.at(-1);
      return {
        data: page.map((r) => ({
          id: r.id,
          version: r.version,
          number: r.number,
          grandTotal: fmt(r.grandTotal, r.currency),
          validUntil: dateOnly(r.validUntil),
          sentAt: r.sentAt?.toISOString() ?? null,
          acceptedAt: r.acceptedAt?.toISOString() ?? null,
          pdfReady: r.pdfKey !== null,
          createdAt: r.createdAt.toISOString(),
          bookingId: r.bookingId,
          bookingStatus: r.booking.status,
          customerName: r.booking.customer.name,
          isLatest: latest.get(r.bookingId) === r.version,
        })),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
      };
    });
  }

  async get(id: string): Promise<QuotationDto> {
    this.requirePrices();
    return this.tenantDb.tx(async (tx) => this.dto(tx, await this.load(tx, id)));
  }

  private async load(tx: DbTx, id: string): Promise<QuotationRow> {
    const row = await tx.quotation.findFirst({
      where: { id, tenantId: this.caller.tenantId, ...this.scope() },
      include: QUOTATION_INCLUDE,
    });
    if (!row) throw new NotFoundError();
    return row;
  }

  private async latestVersions(tx: DbTx, bookingIds: string[]): Promise<Map<string, number>> {
    const rows = await tx.quotation.groupBy({
      by: ['bookingId'],
      where: { tenantId: this.caller.tenantId, bookingId: { in: bookingIds } },
      _max: { version: true },
    });
    return new Map(rows.map((r) => [r.bookingId, r._max.version ?? 0]));
  }

  private async dto(tx: DbTx, row: QuotationRow): Promise<QuotationDto> {
    const snapshot = Snapshot.parse(row.lineItems);
    const latest = (await this.latestVersions(tx, [row.bookingId])).get(row.bookingId);
    return {
      id: row.id,
      bookingId: row.bookingId,
      bookingStatus: row.booking.status,
      bookingNumber: row.booking.number,
      number: row.number,
      version: row.version,
      isLatest: latest === row.version,
      currency: row.currency,
      customer: {
        id: row.booking.customer.id,
        name: row.booking.customer.name,
        phone: row.booking.customer.phone,
        email: row.booking.customer.email,
      },
      venueName: row.booking.venue.name,
      sessions: snapshot.sessions,
      lines: snapshot.lines,
      totals: snapshot.totals,
      taxRate: snapshot.taxRate,
      discount: snapshot.discount,
      validUntil: dateOnly(row.validUntil),
      sentAt: row.sentAt?.toISOString() ?? null,
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      pdfReady: row.pdfKey !== null,
      createdAt: row.createdAt.toISOString(),
      rev: row.rev,
    };
  }

  // ───────────────────────────── actions ─────────────────────────────

  /** Emails the quotation (PDF attached) to the customer, or to `to`. Only the newest version can be sent. */
  async send(id: string, input: SendQuotationInput): Promise<SendQuotationResultDto> {
    this.requirePrices();
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const row = await this.load(tx, id);
      await this.assertLatest(tx, row);
      if (
        row.booking.status === 'CANCELLED' ||
        row.booking.status === 'EXPIRED' ||
        row.booking.status === 'COMPLETED'
      ) {
        throw new InvalidStateTransitionError(
          'This booking is closed: its quotation cannot be sent.',
        );
      }
      if (row.pdfKey === null) {
        throw new InvalidStateTransitionError(
          'The PDF is still being prepared. Try again in a moment.',
        );
      }
      const to = input.to ?? row.booking.customer.email;
      if (!to) throw new FieldValidationError('to', 'The customer has no email address');

      const tenant = await loadTenantContext(tx, tenantId);
      const actor = await tx.user.findFirst({
        where: { id: this.caller.userId },
        select: { name: true, email: true },
      });
      const snapshot = Snapshot.parse(row.lineItems);
      const sentAt = new Date();
      await tx.quotation.update({ where: { id: row.id }, data: { sentAt } });
      await this.emailOutbox.enqueue(tx, {
        to,
        ...(actor?.email ? { replyTo: actor.email } : {}),
        template: 'quotation.send',
        locale: row.booking.customer.preferredLocale ?? tenant.defaultLocale,
        event: 'quotation.sent',
        entityType: 'quotation',
        entityId: row.id,
        attachments: [{ key: row.pdfKey, filename: `${row.number}-v${row.version}.pdf` }],
        vars: {
          customerName: row.booking.customer.name,
          tenantName: tenant.name,
          agentName: actor?.name ?? tenant.name,
          quotationNumber: row.number,
          version: row.version,
          validUntil: row.validUntil ? (dateOnly(row.validUntil) ?? 'Not set') : 'Not set',
          grandTotal: `${row.currency} ${snapshot.totals.grandTotal ?? ''}`,
          summary: this.summary(snapshot.sessions, tenant.timezone),
          message: input.message ?? '',
        },
      });
      await this.audit.record(tx, {
        action: 'quotation.send',
        entityType: 'booking',
        entityId: row.bookingId,
        venueId: row.booking.venueId,
        after: { quotationId: row.id, version: row.version, to: '[recipient]' },
      });
      return { sentAt: sentAt.toISOString(), to };
    });
  }

  /** The customer accepted this version (the staff member records it): docs/05 section 2, a changed booking is re-accepted. */
  async accept(id: string): Promise<QuotationDto> {
    this.requirePrices();
    return this.tenantDb.tx(async (tx) => {
      const row = await this.load(tx, id);
      await this.assertLatest(tx, row);
      if (row.acceptedAt === null) {
        await tx.quotation.update({ where: { id: row.id }, data: { acceptedAt: new Date() } });
        await this.audit.record(tx, {
          action: 'quotation.accept',
          entityType: 'booking',
          entityId: row.bookingId,
          venueId: row.booking.venueId,
          after: { quotationId: row.id, version: row.version },
        });
      }
      return this.dto(tx, await this.load(tx, id));
    });
  }

  async pdf(id: string): Promise<QuotationPdfDto> {
    this.requirePrices();
    const tenantId = this.caller.tenantId;
    const row = await this.tenantDb.tx((tx) => this.load(tx, id));
    if (row.pdfKey === null) {
      throw new InvalidStateTransitionError(
        'The PDF is still being prepared. Try again in a moment.',
      );
    }
    // The key is derived from the tenant and the quotation; what the database holds is checked against it.
    if (row.pdfKey !== pdfObjectKey(tenantId, 'quotation', row.id)) throw new NotFoundError();
    const url = await this.presign.downloadUrl(
      tenantId,
      row.pdfKey,
      `${row.number}-v${row.version}.pdf`,
    );
    return { url, expiresInSeconds: 300 };
  }

  /** A `wa.me` link with a text summary: no file link, PDFs stay private (docs/01 module 7). */
  async whatsapp(id: string): Promise<QuotationWhatsAppDto> {
    this.requirePrices();
    return this.tenantDb.tx(async (tx) => {
      const row = await this.load(tx, id);
      const tenant = await loadTenantContext(tx, this.caller.tenantId);
      const snapshot = Snapshot.parse(row.lineItems);
      const lines = [
        `Hello ${row.booking.customer.name},`,
        `Quotation ${row.number} (version ${row.version}) from ${tenant.name}:`,
        this.summary(snapshot.sessions, tenant.timezone),
        `Total: ${row.currency} ${snapshot.totals.grandTotal ?? ''}`,
        ...(row.validUntil ? [`Valid until ${dateOnly(row.validUntil)}.`] : []),
      ];
      const text = lines.join('\n');
      const digits = row.booking.customer.phone.replace(/\D/g, '');
      return { url: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`, text };
    });
  }

  private async assertLatest(tx: DbTx, row: QuotationRow): Promise<void> {
    const latest = (await this.latestVersions(tx, [row.bookingId])).get(row.bookingId);
    if (latest !== row.version) {
      throw new InvalidStateTransitionError('Only the newest version of a quotation can be used.');
    }
  }

  private summary(sessions: QuotationDto['sessions'], timezone: string): string {
    return sessions
      .filter((s) => s.status === 'ACTIVE')
      .map(
        (s) =>
          `${s.eventTypeName ?? 'Event'}: ${s.date}, ${s.slotName}, ${s.spaceName}, ${s.billedGuests} guests (${formatInstantForEmail(new Date(s.startsAt), timezone)})`,
      )
      .join('\n');
  }
}
