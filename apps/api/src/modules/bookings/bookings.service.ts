import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx, Prisma } from '@venueos/db';
import {
  BOOKING_TRANSITION_MESSAGES,
  CancellationSnapshotSchema,
  bookingTransition,
  isBlockingStatus,
  isEditableStatus,
  LocalRulesSchema,
} from '@venueos/shared';
import type {
  AddSessionInput,
  BookingAction,
  BookingDetailDto,
  BookingListQuery,
  BookingListResponse,
  BookingStatus,
  BookingSummaryDto,
  CancelBookingInput,
  CancelResultDto,
  CancelSessionInput,
  ConfirmBookingInput,
  HoldBookingInput,
  RevOnlyInput,
  UpdateBookingInput,
  UpdateSessionInput,
} from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  AdvanceRequiredError,
  FieldValidationError,
  ForbiddenError,
  InvalidStateTransitionError,
  LocalRuleError,
  NotFoundError,
  VersionConflictError,
} from '../../common/errors/domain-errors';
import { searchTerm } from '../../common/like';
import {
  addDays,
  daysBetween,
  localDateOf,
  localTimeOf,
  zonedInstant,
} from '../../common/time/zoned';
import { advanceMet, requiredAdvance, suggestRefund } from '../../booking/refund';
import { localRuleBreaches } from '../../booking/timing';
import type { LocalRuleBreach } from '../../booking/timing';
import { FrozenSessionPricingSchema } from '../../pricing';
import { BookingWriter } from './core/booking-writer.service';
import { QuoteBuilder } from './core/quote-builder.service';
import type { BuildSessionInput, PhysicalSpace } from './core/quote-builder.service';
import {
  LeadLink,
  clearedReceived,
  fmt,
  loadTenantContext,
  nextNumber,
  toTotalsDto,
} from './core/support';
import type { TenantContext } from './core/support';
import {
  BOOKING_INCLUDE,
  SESSION_INCLUDE,
  lineDtos,
  readBookingPricing,
  sessionDto,
  sessionSubtotalsById,
} from './core/views';
import type { SessionRow } from './core/views';

const BOOKING_ROW = { include: BOOKING_INCLUDE } satisfies Prisma.BookingDefaultArgs;
type BookingRow = Prisma.BookingGetPayload<typeof BOOKING_ROW>;

const encodeCursor = (id: string): string => Buffer.from(`b1:${id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith('b1:') || decoded.length < 4)
    throw new FieldValidationError('cursor', 'Invalid cursor');
  return decoded.slice(3);
}

const MS_DAY = 86_400_000;

interface RequoteOptions {
  /** The discount the new quote carries. */
  discount: { type: 'PERCENT' | 'AMOUNT'; value: string } | null;
  /** The discount is new or changed: the role's limit applies. Otherwise it stays as it was, whoever re-prices. */
  discountChanged: boolean;
  mode: 'FROZEN' | 'CURRENT';
  bookingData?: Prisma.BookingUncheckedUpdateManyInput;
  overridden: { reason: string } | null;
}

/**
 * Bookings (docs/01 module 8, docs/05 sections 2, 4 and 6): the life of a booking from the quotation (DRAFT) through the
 * hold (TENTATIVE: the calendar is blocked) and the confirmation to completion, and its changes and cancellation.
 *
 * The calendar is guarded by the database: a hold writes `space_occupancies` and the exclusion constraint refuses an
 * overlap, which the error filter answers as 409 SLOT_TAKEN (never an application-level pre-check alone). `active` of those
 * rows follows the booking and session status by trigger. Every state change and every price change is audited.
 */
@Injectable()
export class BookingsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly caller: Caller,
    private readonly venueScope: VenueScope,
    private readonly builder: QuoteBuilder,
    private readonly writer: BookingWriter,
    private readonly leadLink: LeadLink,
  ) {}

  private get canSeePrices(): boolean {
    return this.caller.has('booking.view_prices');
  }

  private scope(): Prisma.BookingWhereInput {
    const ids = this.venueScope.filterIds();
    return ids ? { venueId: { in: ids } } : {};
  }

  // ───────────────────────────── reads ─────────────────────────────

  async list(query: BookingListQuery): Promise<BookingListResponse> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const tenant = await loadTenantContext(tx, tenantId);
      const where: Prisma.BookingWhereInput = { tenantId };
      const venueIds = this.venueScope.filterIds(query.venueId ? [query.venueId] : undefined);
      if (venueIds) where.venueId = { in: venueIds };
      if (query.status) where.status = query.status;
      if (query.customerId) where.customerId = query.customerId;
      if (query.leadId) where.leadId = query.leadId;
      if (query.from || query.to) {
        // A booking is in a date range when one of its sessions starts in it (workspace time zone).
        where.sessions = {
          some: {
            status: 'ACTIVE',
            startsAt: {
              ...(query.from ? { gte: zonedInstant(query.from, '00:00', tenant.timezone) } : {}),
              ...(query.to
                ? { lt: zonedInstant(addDays(query.to, 1), '00:00', tenant.timezone) }
                : {}),
            },
          },
        };
      }
      if (query.search) {
        const term = searchTerm(query.search);
        where.OR = term
          ? [
              { number: { contains: term, mode: 'insensitive' } },
              { customer: { name: { contains: term, mode: 'insensitive' } } },
              { customer: { phone: { contains: term.replace(/\D/g, '') || term } } },
            ]
          : [{ id: { in: [] } }]; // nothing but wildcards: nothing matches
      }
      let cursorId: string | undefined;
      if (query.cursor !== undefined) {
        cursorId = decodeCursor(query.cursor);
        const known = await tx.booking.findFirst({
          where: { id: cursorId, tenantId, ...this.scope() },
          select: { id: true },
        });
        if (!known) throw new FieldValidationError('cursor', 'Invalid cursor');
      }
      const rows = await tx.booking.findMany({
        where,
        ...BOOKING_ROW,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
      });
      const page = rows.slice(0, query.limit);
      const stats = await tx.bookingSession.groupBy({
        by: ['bookingId'],
        where: { tenantId, bookingId: { in: page.map((b) => b.id) }, status: 'ACTIVE' },
        _min: { startsAt: true },
        _count: { _all: true },
      });
      const byBooking = new Map(stats.map((s) => [s.bookingId, s]));
      const last = page.at(-1);
      return {
        data: page.map((b) => this.summary(b, byBooking.get(b.id))),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
      };
    });
  }

  async get(id: string): Promise<BookingDetailDto> {
    return this.tenantDb.tx(async (tx) => this.detail(tx, await this.load(tx, id)));
  }

  private async load(tx: DbTx, id: string): Promise<BookingRow> {
    const row = await tx.booking.findFirst({
      where: { id, tenantId: this.caller.tenantId, ...this.scope() },
      ...BOOKING_ROW,
    });
    if (!row) throw new NotFoundError();
    return row;
  }

  private async loadForAction(tx: DbTx, id: string, rev: number): Promise<BookingRow> {
    const row = await this.load(tx, id);
    if (row.rev !== rev) throw new VersionConflictError();
    return row;
  }

  private summary(
    b: BookingRow,
    stats: { _min: { startsAt: Date | null }; _count: { _all: number } } | undefined,
  ): BookingSummaryDto {
    const visible = this.canSeePrices;
    return {
      id: b.id,
      number: b.number,
      status: b.status,
      venueId: b.venueId,
      venueName: b.venue.name,
      customer: { id: b.customer.id, name: b.customer.name, phone: b.customer.phone },
      leadId: b.leadId,
      firstSessionAt: stats?._min.startsAt?.toISOString() ?? null,
      sessionCount: stats?._count._all ?? 0,
      quoteVersion: b.quoteVersion,
      holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
      grandTotal: visible ? fmt(b.grandTotal, b.currency) : null,
      paidTotal: visible ? fmt(b.paidTotal, b.currency) : null,
      rev: b.rev,
      createdAt: b.createdAt.toISOString(),
    };
  }

  private async sessionRows(tx: DbTx, bookingId: string): Promise<SessionRow[]> {
    return tx.bookingSession.findMany({
      where: { tenantId: this.caller.tenantId, bookingId },
      include: SESSION_INCLUDE,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async detail(tx: DbTx, b: BookingRow): Promise<BookingDetailDto> {
    const tenantId = this.caller.tenantId;
    const visible = this.canSeePrices;
    const timezone = b.venue.timezone ?? (await loadTenantContext(tx, tenantId)).timezone;
    const sessions = await this.sessionRows(tx, b.id);
    const lineRows = await tx.bookingLineItem.findMany({ where: { tenantId, bookingId: b.id } });
    const subtotals = sessionSubtotalsById(lineRows);
    const indexById = new Map(sessions.map((s, i) => [s.id, i]));
    const versions = await tx.quotation.findMany({
      where: { tenantId, bookingId: b.id },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        number: true,
        grandTotal: true,
        validUntil: true,
        sentAt: true,
        acceptedAt: true,
        pdfKey: true,
        createdAt: true,
        currency: true,
      },
    });
    const auditRows = await tx.auditLog.findMany({
      where: { tenantId, entityType: 'booking', entityId: b.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        action: true,
        createdAt: true,
        after: true,
        actorUser: { select: { name: true } },
      },
    });
    const snapshot = CancellationSnapshotSchema.safeParse(b.cancellationSnapshot);
    const pricing = readBookingPricing(b.pricing);

    let warnings: BookingDetailDto['warnings'] = [];
    if (b.status === 'DRAFT') warnings = await this.draftWarnings(tx, b, sessions);

    return {
      ...this.summary(b, {
        _min: { startsAt: sessions.find((s) => s.status === 'ACTIVE')?.startsAt ?? null },
        _count: { _all: sessions.filter((s) => s.status === 'ACTIVE').length },
      }),
      currency: b.currency,
      sessions: sessions.map((s, i) =>
        sessionDto(s, i, timezone, b.currency, visible ? (subtotals.get(s.id) ?? '0') : null),
      ),
      lines: lineDtos(lineRows, indexById, b.currency, visible),
      totals: toTotalsDto(
        {
          subtotal: b.subtotal.toString(),
          discountTotal: b.discountTotal.toString(),
          taxTotal: b.taxTotal.toString(),
          grandTotal: b.grandTotal.toString(),
        },
        b.currency,
        visible,
      ),
      taxRate: pricing.taxRate,
      discount: pricing.discount,
      warnings,
      notes: b.notes,
      holdExtensions: b.holdExtensions,
      confirmedAt: b.confirmedAt?.toISOString() ?? null,
      cancelledAt: b.cancelledAt?.toISOString() ?? null,
      cancelReason: b.cancelReason,
      suggestedRefund: visible && b.suggestedRefund ? fmt(b.suggestedRefund, b.currency) : null,
      cancellationPolicy: snapshot.success ? snapshot.data : null,
      quotations: versions.map((v) => ({
        id: v.id,
        version: v.version,
        number: v.number,
        grandTotal: visible ? fmt(v.grandTotal, v.currency) : null,
        validUntil: v.validUntil?.toISOString().slice(0, 10) ?? null,
        sentAt: v.sentAt?.toISOString() ?? null,
        acceptedAt: v.acceptedAt?.toISOString() ?? null,
        pdfReady: v.pdfKey !== null,
        createdAt: v.createdAt.toISOString(),
      })),
      timeline: auditRows.map((r) => {
        const after = (typeof r.after === 'object' && r.after !== null ? r.after : {}) as {
          reason?: unknown;
        };
        return {
          id: r.id,
          action: r.action,
          at: r.createdAt.toISOString(),
          actorName: r.actorUser?.name ?? null,
          reason: typeof after.reason === 'string' ? after.reason : null,
        };
      }),
    };
  }

  /** A draft's taken-slot warnings, from a read-only look at the calendar; any failure just means no warnings. */
  private async draftWarnings(
    tx: DbTx,
    b: BookingRow,
    sessions: SessionRow[],
  ): Promise<BookingDetailDto['warnings']> {
    try {
      const active = sessions.filter((s) => s.status === 'ACTIVE');
      const physical = await this.builder.physicalSpaces(tx, [
        ...new Set(active.map((s) => s.spaceId)),
      ]);
      const warnings: BookingDetailDto['warnings'] = [];
      for (const [index, s] of active.entries()) {
        for (const p of physical.get(s.spaceId) ?? []) {
          const taken = await tx.spaceOccupancy.findFirst({
            where: {
              tenantId: this.caller.tenantId,
              spaceId: p.id,
              active: true,
              startsAt: { lt: new Date(s.endsAt.getTime() + p.cleanupBufferMin * 60_000) },
              endsAt: { gt: new Date(s.startsAt.getTime() - p.setupBufferMin * 60_000) },
              session: { bookingId: { not: b.id } },
            },
            select: { session: { select: { booking: { select: { number: true } } } } },
          });
          if (taken) {
            warnings.push({
              code: 'SLOT_TAKEN',
              sessionIndex: index,
              detail: this.caller.has('booking.view')
                ? (taken.session.booking.number ?? null)
                : null,
            });
            break;
          }
        }
      }
      return warnings;
    } catch {
      return [];
    }
  }

  // ───────────────────────────── transitions ─────────────────────────────

  private transition(b: BookingRow, action: BookingAction): BookingStatus {
    const t = bookingTransition(b.status, action, b.cancelledFrom);
    if (!t.allowed) {
      throw new InvalidStateTransitionError(BOOKING_TRANSITION_MESSAGES[t.reason], {
        status: b.status,
        action,
      });
    }
    return t.to;
  }

  /** The booking's cancellation policy (or the default one) as the frozen copy a booking keeps (docs/05 section 6). */
  private async loadPolicy(tx: DbTx, b: BookingRow) {
    const tenantId = this.caller.tenantId;
    const policy = b.cancellationPolicyId
      ? await tx.cancellationPolicy.findFirst({ where: { id: b.cancellationPolicyId, tenantId } })
      : await tx.cancellationPolicy.findFirst({
          where: { tenantId, active: true, isDefault: true },
        });
    if (!policy) return null;
    return {
      policyId: policy.id,
      snapshot: {
        policyId: policy.id,
        name: policy.name,
        tiers: policy.tiers,
      } as Prisma.InputJsonValue,
    };
  }

  private activeSessions(rows: SessionRow[]): SessionRow[] {
    return rows.filter((s) => s.status === 'ACTIVE');
  }

  /** Venue rule breaches of the stored sessions; allowed with `booking.override_rules` and a reason (docs/05 section 1). */
  private async checkRules(
    tx: DbTx,
    b: BookingRow,
    sessions: SessionRow[],
    tenant: TenantContext,
    override: { overrideRules: boolean; reason?: string | undefined },
  ): Promise<{ reason: string } | null> {
    const parsed = LocalRulesSchema.safeParse(
      (
        await tx.venue.findFirst({
          where: { id: b.venueId, tenantId: tenant.id },
          select: { localRules: true },
        })
      )?.localRules ?? {},
    );
    const rules = parsed.success ? parsed.data : {};
    const timezone = b.venue.timezone ?? tenant.timezone;
    const breaches: { sessionIndex: number; breach: LocalRuleBreach }[] = [];
    for (const [index, s] of sessions.entries()) {
      for (const breach of localRuleBreaches(
        rules,
        { startsAt: s.startsAt, endsAt: s.endsAt, guests: s.guests },
        timezone,
      )) {
        breaches.push({ sessionIndex: index, breach });
      }
    }
    if (breaches.length === 0) return null;
    if (override.overrideRules) {
      if (!this.caller.has('booking.override_rules'))
        throw new ForbiddenError('You may not override venue rules.');
      if (!override.reason)
        throw new FieldValidationError('reason', 'Give the reason for overriding the rule');
      return { reason: override.reason };
    }
    throw new LocalRuleError('A rule of this venue prevents this.', { breaches });
  }

  async hold(id: string, input: HoldBookingInput): Promise<BookingDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadForAction(tx, id, input.rev);
      const to = this.transition(b, 'hold');
      const tenant = await loadTenantContext(tx, tenantId);
      const sessions = this.activeSessions(await this.sessionRows(tx, b.id));
      if (sessions.length === 0)
        throw new InvalidStateTransitionError('A booking needs at least one session to be held.');
      const overridden = await this.checkRules(tx, b, sessions, tenant, input);

      const number = b.number ?? (await nextNumber(tx, tenant, 'booking'));
      const holdExpiresAt = new Date(Date.now() + tenant.settings.holdHours * 3_600_000);
      const policy = await this.loadPolicy(tx, b);
      const updated = await tx.booking.updateMany({
        where: { id, tenantId, rev: input.rev },
        data: {
          status: to,
          number,
          holdExpiresAt,
          holdWarnedAt: null,
          ...(policy
            ? { cancellationPolicyId: policy.policyId, cancellationSnapshot: policy.snapshot }
            : {}),
        },
      });
      if (updated.count !== 1) throw new VersionConflictError();

      // The calendar: after the status change, so the rows are born active; an overlap is the constraint's 409 SLOT_TAKEN.
      const physical = await this.builder.physicalSpaces(tx, [
        ...new Set(sessions.map((s) => s.spaceId)),
      ]);
      for (const s of sessions) {
        await this.writer.replaceOccupancies(
          tx,
          s.id,
          s,
          physical.get(s.spaceId) as PhysicalSpace[],
        );
      }
      await this.audit.record(tx, {
        action: 'booking.hold',
        entityType: 'booking',
        entityId: id,
        venueId: b.venueId,
        before: { status: b.status },
        after: {
          status: to,
          number,
          holdExpiresAt: holdExpiresAt.toISOString(),
          ...(overridden ? { overrideRules: true, reason: overridden.reason } : {}),
        },
      });
      return this.detail(tx, await this.load(tx, id));
    });
  }

  /** The agent extends once by the hold duration; further extensions need `booking.extend_hold` (docs/05 section 2). */
  async extendHold(id: string, input: RevOnlyInput): Promise<BookingDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadForAction(tx, id, input.rev);
      if (b.status !== 'TENTATIVE' || !b.holdExpiresAt) {
        throw new InvalidStateTransitionError('Only a tentative hold can be extended.');
      }
      if (b.holdExtensions >= 1 && !this.caller.has('booking.extend_hold')) {
        throw new ForbiddenError(
          'A hold can be extended once. More extensions need booking.extend_hold.',
        );
      }
      const tenant = await loadTenantContext(tx, tenantId);
      const from = Math.max(Date.now(), b.holdExpiresAt.getTime());
      const holdExpiresAt = new Date(from + tenant.settings.holdHours * 3_600_000);
      const updated = await tx.booking.updateMany({
        where: { id, tenantId, rev: input.rev },
        data: { holdExpiresAt, holdExtensions: { increment: 1 }, holdWarnedAt: null },
      });
      if (updated.count !== 1) throw new VersionConflictError();
      await this.audit.record(tx, {
        action: 'booking.extend_hold',
        entityType: 'booking',
        entityId: id,
        venueId: b.venueId,
        before: { holdExpiresAt: b.holdExpiresAt.toISOString(), holdExtensions: b.holdExtensions },
        after: { holdExpiresAt: holdExpiresAt.toISOString(), holdExtensions: b.holdExtensions + 1 },
      });
      return this.detail(tx, await this.load(tx, id));
    });
  }

  /** TENTATIVE -> CONFIRMED when the cleared receipts cover the advance, or with `booking.confirm_override` and a reason. */
  async confirm(id: string, input: ConfirmBookingInput): Promise<BookingDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadForAction(tx, id, input.rev);
      const to = this.transition(b, 'confirm');
      const tenant = await loadTenantContext(tx, tenantId);
      const received = await clearedReceived(tx, tenantId, id);
      const met = advanceMet(received, b.grandTotal.toString(), tenant.settings.advancePct);
      let overridden: { reason: string } | null = null;
      if (!met) {
        if (!input.override) {
          throw new AdvanceRequiredError(
            'The required advance has not been received yet.',
            this.canSeePrices
              ? {
                  advancePct: tenant.settings.advancePct,
                  required: fmt(
                    requiredAdvance(b.grandTotal.toString(), tenant.settings.advancePct),
                    b.currency,
                  ),
                  received: fmt(received, b.currency),
                }
              : undefined,
          );
        }
        if (!this.caller.has('booking.confirm_override'))
          throw new ForbiddenError('You may not confirm without the advance.');
        if (!input.reason)
          throw new FieldValidationError(
            'reason',
            'Give the reason for confirming without the advance',
          );
        overridden = { reason: input.reason };
      }
      const policy = await this.loadPolicy(tx, b);
      const updated = await tx.booking.updateMany({
        where: { id, tenantId, rev: input.rev },
        data: {
          status: to,
          confirmedAt: new Date(),
          holdExpiresAt: null,
          // docs/05 section 2: the policy is copied at confirmation, so later edits never change this booking.
          ...(policy
            ? { cancellationPolicyId: policy.policyId, cancellationSnapshot: policy.snapshot }
            : {}),
        },
      });
      if (updated.count !== 1) throw new VersionConflictError();
      await this.leadLink.advance(tx, tenantId, b.leadId, 'WON');
      await this.audit.record(tx, {
        action: 'booking.confirm',
        entityType: 'booking',
        entityId: id,
        venueId: b.venueId,
        before: { status: b.status },
        after: {
          status: to,
          advanceMet: met,
          ...(overridden ? { override: true, reason: overridden.reason } : {}),
        },
      });
      return this.detail(tx, await this.load(tx, id));
    });
  }

  /** Cancels a quotation, hold or confirmed booking: frees the calendar and suggests the refund the policy snapshot allows. */
  async cancel(id: string, input: CancelBookingInput): Promise<CancelResultDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadForAction(tx, id, input.rev);
      const to = this.transition(b, 'cancel');
      const tenant = await loadTenantContext(tx, tenantId);
      const sessions = this.activeSessions(await this.sessionRows(tx, b.id));
      const timezone = b.venue.timezone ?? tenant.timezone;

      let refund: CancelResultDto['refund'] = null;
      let suggested: string | null = null;
      if (b.status !== 'DRAFT') {
        const snapshot = CancellationSnapshotSchema.safeParse(b.cancellationSnapshot);
        const first = sessions[0];
        const daysBefore = first
          ? daysBetween(localDateOf(new Date(), timezone), localDateOf(first.startsAt, timezone))
          : 0;
        const received = await clearedReceived(tx, tenantId, id);
        const s = suggestRefund(
          snapshot.success ? snapshot.data.tiers : [],
          daysBefore,
          received,
          b.currency,
        );
        suggested = s.suggested;
        refund = {
          daysBefore,
          refundPct: s.refundPct,
          received: this.canSeePrices ? fmt(s.received, b.currency) : null,
          suggested: this.canSeePrices ? fmt(s.suggested, b.currency) : null,
        };
      }
      const updated = await tx.booking.updateMany({
        where: { id, tenantId, rev: input.rev },
        data: {
          status: to,
          cancelledAt: new Date(),
          cancelReason: input.reason,
          cancelledFrom: b.status,
          holdExpiresAt: null,
          suggestedRefund: suggested,
        },
      });
      if (updated.count !== 1) throw new VersionConflictError();
      await this.audit.record(tx, {
        action: 'booking.cancel',
        entityType: 'booking',
        entityId: id,
        venueId: b.venueId,
        before: { status: b.status },
        after: {
          status: to,
          reason: input.reason,
          ...(refund ? { refundPct: refund.refundPct, suggestedRefund: suggested } : {}),
        },
      });
      return { ...(await this.detail(tx, await this.load(tx, id))), refund };
    });
  }

  /** CANCELLED -> the status it was cancelled from. The slot must still be free: else 409 SLOT_TAKEN from the constraint. */
  async restore(id: string, input: RevOnlyInput): Promise<BookingDetailDto> {
    return this.reopen(id, input, 'restore');
  }

  /** EXPIRED -> TENTATIVE with a new hold; fails with 409 SLOT_TAKEN when somebody took the slot meanwhile. */
  async rehold(id: string, input: RevOnlyInput): Promise<BookingDetailDto> {
    return this.reopen(id, input, 'rehold');
  }

  private async reopen(
    id: string,
    input: RevOnlyInput,
    action: 'restore' | 'rehold',
  ): Promise<BookingDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadForAction(tx, id, input.rev);
      const to = this.transition(b, action);
      const tenant = await loadTenantContext(tx, tenantId);
      const holds = to === 'TENTATIVE';
      const updated = await tx.booking.updateMany({
        where: { id, tenantId, rev: input.rev },
        data: {
          status: to,
          cancelledAt: null,
          cancelReason: null,
          cancelledFrom: null,
          suggestedRefund: null,
          holdWarnedAt: null,
          ...(holds
            ? {
                holdExpiresAt: new Date(Date.now() + tenant.settings.holdHours * 3_600_000),
                holdExtensions: 0,
              }
            : {}),
        },
      });
      if (updated.count !== 1) throw new VersionConflictError();
      await this.audit.record(tx, {
        action: action === 'restore' ? 'booking.restore' : 'booking.rehold',
        entityType: 'booking',
        entityId: id,
        venueId: b.venueId,
        before: { status: b.status },
        after: { status: to },
      });
      return this.detail(tx, await this.load(tx, id));
    });
  }

  // ───────────────────────────── changes and re-quoting ─────────────────────────────

  /** PATCH: notes, the cancellation policy, the discount and (a DRAFT only) the whole list of sessions. */
  async update(id: string, input: UpdateBookingInput): Promise<BookingDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadForAction(tx, id, input.rev);
      if (!isEditableStatus(b.status)) {
        throw new InvalidStateTransitionError('This booking can no longer be changed.');
      }
      if (input.sessions !== undefined && b.status !== 'DRAFT') {
        throw new InvalidStateTransitionError(
          'Change the sessions of a held or confirmed booking one at a time.',
        );
      }
      if (input.cancellationPolicyId) {
        const policy = await tx.cancellationPolicy.findFirst({
          where: { id: input.cancellationPolicyId, tenantId, active: true },
          select: { id: true },
        });
        if (!policy) throw new NotFoundError();
      }
      const data: Prisma.BookingUncheckedUpdateManyInput = {
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.cancellationPolicyId === undefined
          ? {}
          : { cancellationPolicyId: input.cancellationPolicyId }),
      };
      const stored = readBookingPricing(b.pricing);
      const discountChanged = input.discount !== undefined;
      const repricing =
        input.sessions !== undefined || discountChanged || input.requote === 'CURRENT';

      if (!repricing) {
        if (Object.keys(data).length > 0) {
          const updated = await tx.booking.updateMany({
            where: { id, tenantId, rev: input.rev },
            data,
          });
          if (updated.count !== 1) throw new VersionConflictError();
          await this.audit.record(tx, {
            action: 'booking.update',
            entityType: 'booking',
            entityId: id,
            venueId: b.venueId,
            after: { notes: input.notes, cancellationPolicyId: input.cancellationPolicyId },
          });
        }
        return this.detail(tx, await this.load(tx, id));
      }

      const rows = await this.sessionRows(tx, b.id);
      let inputs: BuildSessionInput[];
      let ids: (string | null)[];
      if (input.sessions) {
        const known = new Map(rows.map((r) => [r.id, r]));
        inputs = [];
        ids = [];
        for (const s of input.sessions) {
          if (s.id !== undefined && !known.has(s.id)) throw new NotFoundError();
          inputs.push({ ...s });
          ids.push(s.id ?? null);
        }
        // Sessions that are no longer listed are cancelled (sessions are never deleted).
        const kept = new Set(ids.filter((v): v is string => v !== null));
        const dropped = this.activeSessions(rows).filter((r) => !kept.has(r.id));
        for (const r of dropped) {
          await tx.bookingSession.update({
            where: { id: r.id },
            data: { status: 'CANCELLED', cancelledAt: new Date() },
          });
        }
      } else {
        const active = this.activeSessions(rows);
        inputs = active.map((r) => this.toInput(r, b, input.requote === 'CURRENT'));
        ids = active.map((r) => r.id);
      }
      const discount = discountChanged ? (input.discount ?? null) : stored.discount;
      await this.requote(
        tx,
        b,
        rows,
        inputs,
        ids,
        {
          discount,
          discountChanged,
          mode: input.requote ?? 'FROZEN',
          bookingData: data,
          overridden: null,
        },
        'booking.update',
      );
      return this.detail(tx, await this.load(tx, id));
    });
  }

  async addSession(id: string, input: AddSessionInput): Promise<BookingDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadForAction(tx, id, input.rev);
      if (!isEditableStatus(b.status))
        throw new InvalidStateTransitionError('This booking can no longer be changed.');
      const tenant = await loadTenantContext(tx, tenantId);
      const rows = await this.sessionRows(tx, b.id);
      const active = this.activeSessions(rows);
      const added: BuildSessionInput = { ...input.session };
      delete added.id;
      const inputs = [...active.map((r) => this.toInput(r, b, input.requote === 'CURRENT')), added];
      const ids: (string | null)[] = [...active.map((r) => r.id), null];
      await this.requote(
        tx,
        b,
        rows,
        inputs,
        ids,
        {
          discount: readBookingPricing(b.pricing).discount,
          discountChanged: false,
          mode: input.requote ?? 'FROZEN',
          overridden: null,
        },
        'booking.session.add',
        { guardNew: { overrideRules: input.overrideRules, reason: input.reason }, tenant },
      );
      return this.detail(tx, await this.load(tx, id));
    });
  }

  async updateSession(
    id: string,
    sessionId: string,
    input: UpdateSessionInput,
  ): Promise<BookingDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadForAction(tx, id, input.rev);
      if (!isEditableStatus(b.status))
        throw new InvalidStateTransitionError('This booking can no longer be changed.');
      const tenant = await loadTenantContext(tx, tenantId);
      const rows = await this.sessionRows(tx, b.id);
      const active = this.activeSessions(rows);
      const target = active.find((r) => r.id === sessionId);
      if (!target) throw new NotFoundError();
      const mode = input.requote ?? 'FROZEN';
      const inputs = active.map((r) => {
        const base = this.toInput(r, b, mode === 'CURRENT');
        if (r.id !== sessionId) return base;
        const next: BuildSessionInput = { ...base };
        if (input.spaceId !== undefined) next.spaceId = input.spaceId;
        if (input.date !== undefined) next.date = input.date;
        if (input.slotId !== undefined) next.slotId = input.slotId;
        if (input.startTime !== undefined) next.startTime = input.startTime;
        if (input.endTime !== undefined) next.endTime = input.endTime;
        // A slot change without new times falls back to the slot's own times.
        if (input.slotId !== undefined && input.startTime === undefined) delete next.startTime;
        if (input.slotId !== undefined && input.endTime === undefined) delete next.endTime;
        if (input.eventTypeId !== undefined) next.eventTypeId = input.eventTypeId;
        if (input.packageId !== undefined) next.packageId = input.packageId;
        if (input.guests !== undefined) next.guests = input.guests;
        if (input.guaranteedGuests !== undefined) next.guaranteedGuests = input.guaranteedGuests;
        if (input.addOns !== undefined) next.addOns = input.addOns;
        if (input.setupNotes !== undefined) next.setupNotes = input.setupNotes;
        if (input.kitchenNotes !== undefined) next.kitchenNotes = input.kitchenNotes;
        return next;
      });
      await this.requote(
        tx,
        b,
        rows,
        inputs,
        active.map((r) => r.id),
        {
          discount: readBookingPricing(b.pricing).discount,
          discountChanged: false,
          mode,
          overridden: null,
        },
        'booking.session.update',
        {
          guardNew: { overrideRules: input.overrideRules, reason: input.reason },
          tenant,
          touched: sessionId,
        },
      );
      return this.detail(tx, await this.load(tx, id));
    });
  }

  /** Soft-cancels one session (never deleted): its occupancy is released and the booking is re-quoted without it. */
  async cancelSession(
    id: string,
    sessionId: string,
    input: CancelSessionInput,
  ): Promise<BookingDetailDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const b = await this.loadForAction(tx, id, input.rev);
      if (!isEditableStatus(b.status))
        throw new InvalidStateTransitionError('This booking can no longer be changed.');
      const tenant = await loadTenantContext(tx, tenantId);
      const rows = await this.sessionRows(tx, b.id);
      const active = this.activeSessions(rows);
      const target = active.find((r) => r.id === sessionId);
      if (!target) throw new NotFoundError();
      if (active.length === 1) {
        throw new InvalidStateTransitionError(
          'This is the last session: cancel the booking instead.',
        );
      }
      this.assertNotLocked(b, [target.startsAt], tenant);
      await tx.bookingSession.update({
        where: { id: sessionId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      const remaining = active.filter((r) => r.id !== sessionId);
      await this.requote(
        tx,
        b,
        rows,
        remaining.map((r) => this.toInput(r, b, false)),
        remaining.map((r) => r.id),
        {
          discount: readBookingPricing(b.pricing).discount,
          discountChanged: false,
          mode: 'FROZEN',
          overridden: input.reason ? { reason: input.reason } : null,
        },
        'booking.session.cancel',
        { cancelledSessionId: sessionId },
      );
      return this.detail(tx, await this.load(tx, id));
    });
  }

  /** A stored session as quote input; `fresh` drops the frozen prices (re-quote at current rates). */
  private toInput(row: SessionRow, b: BookingRow, fresh: boolean): BuildSessionInput {
    const timezone = b.venue.timezone ?? 'UTC';
    const frozen = FrozenSessionPricingSchema.safeParse(row.pricing);
    const date = localDateOf(row.startsAt, timezone);
    const selections = Array.isArray(row.addOns)
      ? (row.addOns as { addOnId?: unknown; quantity?: unknown }[]).flatMap((a) =>
          typeof a.addOnId === 'string' && typeof a.quantity === 'number'
            ? [{ addOnId: a.addOnId, quantity: a.quantity }]
            : [],
        )
      : [];
    return {
      id: row.id,
      spaceId: row.spaceId,
      date,
      slotId: row.slotId ?? '',
      ...(row.slot?.mode === 'HOURLY'
        ? {
            startTime: localTimeOf(row.startsAt, timezone),
            endTime: localTimeOf(row.endsAt, timezone),
          }
        : {}),
      eventTypeId: row.eventTypeId,
      packageId: row.packageId,
      guests: row.guests,
      guaranteedGuests: row.guaranteedGuests,
      addOns: selections,
      setupNotes: row.setupNotes,
      kitchenNotes: row.kitchenNotes,
      reuse:
        !fresh && frozen.success && b.status !== 'DRAFT'
          ? { frozen: frozen.data, spaceId: row.spaceId, slotId: row.slotId ?? '', date }
          : undefined,
    };
  }

  /** Changes inside the guest-lock window need `booking.edit_locked` (docs/05 section 4); only held or confirmed bookings are locked. */
  private assertNotLocked(b: BookingRow, instants: Date[], tenant: TenantContext): void {
    if (b.status !== 'TENTATIVE' && b.status !== 'CONFIRMED') return;
    if (this.caller.has('booking.edit_locked')) return;
    const limit = Date.now() + tenant.settings.guestLockDays * MS_DAY;
    if (instants.some((at) => at.getTime() < limit)) {
      throw new ForbiddenError(
        `This session is within ${tenant.settings.guestLockDays} days: changing it needs booking.edit_locked.`,
      );
    }
  }

  /**
   * Re-prices the booking from `inputs` (the ACTIVE sessions, in order; `ids[i]` is the stored session or null for a new one),
   * writes the sessions, the occupancy of the ones that moved, the new line items and a new quotation version, and audits the
   * change with the totals before and after.
   */
  private async requote(
    tx: DbTx,
    b: BookingRow,
    rows: SessionRow[],
    inputs: BuildSessionInput[],
    ids: (string | null)[],
    options: RequoteOptions,
    auditAction: string,
    extra: {
      guardNew?: { overrideRules: boolean; reason?: string | undefined };
      tenant?: TenantContext;
      touched?: string;
      cancelledSessionId?: string;
    } = {},
  ): Promise<void> {
    const stored = readBookingPricing(b.pricing);
    const mode = options.mode;
    const draft = b.status === 'DRAFT';
    const built = await this.builder.build(tx, {
      venueId: b.venueId,
      sessions: inputs,
      discount: options.discount,
      taxRate: draft || mode === 'CURRENT' ? undefined : stored.taxRate,
      excludeBookingId: b.id,
      maxDiscountPct: options.discountChanged ? this.caller.access.limits.maxDiscountPct : 100,
      warn: draft,
      canSeeBookingNumbers: this.caller.has('booking.view'),
    });
    const tenant = extra.tenant ?? built.tenant;
    const blocking = isBlockingStatus(b.status);

    // Which stored sessions moved (time or space), and what is new: those need guards and occupancy.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const changedIdx: number[] = [];
    for (const s of built.sessions) {
      const old = ids[s.index] ? byId.get(ids[s.index] as string) : undefined;
      const moved =
        !old ||
        old.spaceId !== s.dto.spaceId ||
        old.startsAt.getTime() !== s.times.startsAt.getTime() ||
        old.endsAt.getTime() !== s.times.endsAt.getTime();
      const edited =
        !!old &&
        (old.guests !== s.input.guests ||
          old.guaranteedGuests !== (s.input.guaranteedGuests ?? null) ||
          old.packageId !== (s.input.packageId ?? null) ||
          JSON.stringify(old.addOns) !== JSON.stringify(s.input.addOns));
      if (moved) changedIdx.push(s.index);
      if (
        (moved || edited) &&
        (extra.touched === undefined || extra.touched === ids[s.index] || !old)
      ) {
        this.assertNotLockedFor(
          b,
          old ? [old.startsAt, s.times.startsAt] : [s.times.startsAt],
          tenant,
        );
      }
    }
    let overridden = options.overridden;
    if (
      blocking &&
      changedIdx.length > 0 &&
      built.breaches.some((x) => changedIdx.includes(x.sessionIndex))
    ) {
      const guard = extra.guardNew ?? { overrideRules: false };
      const first = built.breaches.find((x) => changedIdx.includes(x.sessionIndex));
      if (guard.overrideRules) {
        if (!this.caller.has('booking.override_rules'))
          throw new ForbiddenError('You may not override venue rules.');
        if (!guard.reason)
          throw new FieldValidationError('reason', 'Give the reason for overriding the rule');
        overridden = { reason: guard.reason };
      } else {
        throw new LocalRuleError('A rule of this venue prevents this.', { breaches: [first] });
      }
    }

    const before = { grandTotal: b.grandTotal.toString(), quoteVersion: b.quoteVersion };
    const written = await this.writer.write(tx, built, null, {
      booking: { id: b.id, status: b.status, rev: b.rev, quoteVersion: b.quoteVersion },
      sessionIds: ids,
      bookingData: options.bookingData,
    });
    // Existing sessions take over the new values and the frozen prices of this version.
    for (const s of built.sessions) {
      const existing = ids[s.index];
      if (existing) {
        await tx.bookingSession.update({
          where: { id: existing },
          data: this.writer.sessionColumns(s),
        });
      }
    }
    if (blocking) {
      for (const index of changedIdx) {
        const s = built.sessions[index] as (typeof built.sessions)[number];
        await this.writer.replaceOccupancies(
          tx,
          written.sessionIds[index] as string,
          s.times,
          s.physical,
        );
      }
    }
    await this.audit.record(tx, {
      action: auditAction,
      entityType: 'booking',
      entityId: b.id,
      venueId: b.venueId,
      before,
      after: {
        quoteVersion: written.version,
        newVersion: written.newVersion,
        grandTotal: built.result.grandTotal,
        mode,
        sessionId: extra.cancelledSessionId ?? extra.touched ?? null,
        ...(options.discountChanged ? { discount: built.discount } : {}),
        ...(overridden ? { reason: overridden.reason } : {}),
      },
    });
  }

  private assertNotLockedFor(b: BookingRow, instants: Date[], tenant: TenantContext): void {
    this.assertNotLocked(b, instants, tenant);
  }
}
