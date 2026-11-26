import { Injectable } from '@nestjs/common';
import { JobQueue } from '@venueos/db';
import type { DbTx, Prisma } from '@venueos/db';
import { JOB_NAMES } from '@venueos/shared';
import type { LineItemDto, QuotePreviewDto, SessionDto } from '@venueos/shared';
import { Caller } from '../../../common/access/caller.service';
import { VersionConflictError } from '../../../common/errors/domain-errors';
import { newId } from '../../../common/ids';
import { addDays, localDateOf } from '../../../common/time/zoned';
import { occupancyRange } from '../../../booking/timing';
import type { BuiltQuote, BuiltSession, PhysicalSpace } from './quote-builder.service';
import { fmt, nextNumber, toLineDto, toTotalsDto } from './support';

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/** The quotation DTO fields every priced thing shares (the preview, a created quotation, a version snapshot). */
export function previewDto(
  built: BuiltQuote,
  maxDiscountPct: number,
  visible: boolean,
  ids?: (string | null)[],
): QuotePreviewDto {
  const { currency } = built.tenant;
  const sessions: SessionDto[] = built.sessions.map((s) => ({
    ...s.dto,
    id: ids?.[s.index] ?? null,
    status: 'ACTIVE',
    subtotal: visible
      ? fmt(built.result.sessions.find((r) => r.index === s.index)?.subtotal ?? '0', currency)
      : null,
  }));
  const lines: LineItemDto[] = built.result.lines.map((l) =>
    toLineDto(
      {
        id: null,
        sessionIndex: l.sessionIndex,
        kind: l.kind,
        description: l.description,
        refType: l.refType,
        refId: l.refId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        taxAmount: l.taxAmount,
      },
      currency,
      visible,
    ),
  );
  return {
    currency,
    sessions,
    lines,
    totals: toTotalsDto(built.result, currency, visible),
    taxRate: built.taxRate,
    discount: built.discount,
    maxDiscountPct,
    warnings: built.warnings,
  };
}

export interface WriteOptions {
  /** The booking being re-priced; a new booking is created when absent. */
  booking?: { id: string; status: string; rev: number; quoteVersion: number } | undefined;
  /** Session ids in the order of `built.sessions` (existing ones, or `null` for a session to create here). */
  sessionIds?: (string | null)[];
  /** Extra columns for the same UPDATE of the booking (status, hold fields, ...). */
  bookingData?: Prisma.BookingUncheckedUpdateManyInput;
  /** Always write a new quotation version, even for an unsent draft. */
  forceNewVersion?: boolean;
}

export interface WriteResult {
  bookingId: string;
  quotationId: string;
  version: number;
  sessionIds: string[];
  /** True when a new `quotations` row was written (rather than the unsent draft's row updated in place). */
  newVersion: boolean;
}

/**
 * Persists a priced quote (docs/05 section 3): the booking's sessions and CURRENT line items, its totals and frozen pricing
 * context, and the `quotations` row of the version (docs/03: the line items of every issued version are frozen in
 * `quotations.line_items`). A DRAFT that was never sent is re-priced in place; anything else (a sent quotation, a held or
 * confirmed booking) gets a NEW version with the same quotation number. Every version queues its PDF.
 */
@Injectable()
export class BookingWriter {
  constructor(
    private readonly caller: Caller,
    private readonly jobQueue: JobQueue,
  ) {}

  /** Creates the sessions rows of `built` that have no id yet and returns every session id in order. */
  async ensureSessions(
    tx: DbTx,
    bookingId: string,
    built: BuiltQuote,
    sessionIds: (string | null)[],
  ): Promise<string[]> {
    const tenantId = this.caller.tenantId;
    const ids: string[] = [];
    for (const s of built.sessions) {
      const existing = sessionIds[s.index] ?? null;
      if (existing) {
        ids.push(existing);
        continue;
      }
      const id = newId();
      await tx.bookingSession.create({
        data: { id, tenantId, bookingId, ...this.sessionColumns(s) },
      });
      ids.push(id);
    }
    return ids;
  }

  /** The columns of a session row that come from a built session (also used to update an existing one). */
  sessionColumns(
    s: BuiltSession,
  ): Omit<Prisma.BookingSessionUncheckedCreateInput, 'id' | 'tenantId' | 'bookingId'> {
    return {
      spaceId: s.dto.spaceId,
      slotId: s.dto.slotId,
      eventTypeId: s.dto.eventTypeId,
      packageId: s.dto.packageId,
      startsAt: s.times.startsAt,
      endsAt: s.times.endsAt,
      guests: s.input.guests,
      guaranteedGuests: s.input.guaranteedGuests ?? null,
      addOns: asJson(s.input.addOns),
      pricing: asJson(s.frozen),
      setupNotes: s.input.setupNotes ?? null,
      kitchenNotes: s.input.kitchenNotes ?? null,
    };
  }

  /** Replaces the occupancy rows of a session (one per physical space, buffers included). A taken slot = SLOT_TAKEN from the constraint. */
  async replaceOccupancies(
    tx: DbTx,
    sessionId: string,
    times: { startsAt: Date; endsAt: Date },
    physical: readonly PhysicalSpace[],
  ): Promise<void> {
    const tenantId = this.caller.tenantId;
    await tx.spaceOccupancy.deleteMany({ where: { tenantId, sessionId } });
    for (const p of physical) {
      const range = occupancyRange(
        times.startsAt,
        times.endsAt,
        p.setupBufferMin,
        p.cleanupBufferMin,
      );
      // `active` is derived by the database from the booking and session status; whatever is written here is overwritten.
      await tx.spaceOccupancy.create({
        data: {
          tenantId,
          sessionId,
          spaceId: p.id,
          startsAt: range.startsAt,
          endsAt: range.endsAt,
        },
      });
    }
  }

  async write(
    tx: DbTx,
    built: BuiltQuote,
    create: {
      customerId: string;
      leadId: string | null;
      notes: string | null;
      cancellationPolicyId: string | null;
    } | null,
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    const tenantId = this.caller.tenantId;
    const { currency } = built.tenant;
    const totals = {
      subtotal: built.result.subtotal,
      discountTotal: built.result.discountTotal,
      taxTotal: built.result.taxTotal,
      grandTotal: built.result.grandTotal,
    };
    const pricing = asJson({ taxRate: built.taxRate, discount: built.discount });

    let bookingId: string;
    let status: string;
    if (create) {
      bookingId = newId();
      status = 'DRAFT';
      await tx.booking.create({
        data: {
          id: bookingId,
          tenantId,
          venueId: built.venue.id,
          customerId: create.customerId,
          leadId: create.leadId,
          status: 'DRAFT',
          quoteVersion: 1,
          currency,
          ...totals,
          pricing,
          notes: create.notes,
          cancellationPolicyId: create.cancellationPolicyId,
          createdById: this.caller.userId,
        },
      });
    } else if (options.booking) {
      bookingId = options.booking.id;
      status = options.booking.status;
    } else {
      throw new Error('BookingWriter.write needs a booking to create or to update');
    }

    const sessionIds = await this.ensureSessions(tx, bookingId, built, options.sessionIds ?? []);

    // Current line items = the lines of this version.
    await tx.bookingLineItem.deleteMany({ where: { tenantId, bookingId } });
    await tx.bookingLineItem.createMany({
      data: built.result.lines.map((l) => ({
        tenantId,
        bookingId,
        sessionId: l.sessionIndex === null ? null : (sessionIds[l.sessionIndex] ?? null),
        kind: l.kind,
        description: l.description,
        refType: l.refType,
        refId: l.refId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        taxAmount: l.taxAmount,
        sortOrder: l.sortOrder,
      })),
    });

    // Which version row: a draft that was never sent is updated in place, everything else gets a new version.
    const latest = create
      ? null
      : await tx.quotation.findFirst({
          where: { tenantId, bookingId },
          orderBy: { version: 'desc' },
          select: { id: true, version: true, number: true, sentAt: true },
        });
    const newVersion =
      latest === null ||
      options.forceNewVersion === true ||
      latest.sentAt !== null ||
      status !== 'DRAFT';
    const version = latest === null ? 1 : newVersion ? latest.version + 1 : latest.version;
    const snapshot = asJson({
      currency,
      sessions: previewDto(built, 100, true, sessionIds).sessions,
      lines: previewDto(built, 100, true).lines,
      totals: previewDto(built, 100, true).totals,
      taxRate: built.taxRate,
      discount: built.discount,
    });
    const today = localDateOf(new Date(), built.tenant.timezone);
    const validUntil = new Date(
      `${addDays(today, built.tenant.settings.quotationValidDays)}T00:00:00.000Z`,
    );

    let quotationId: string;
    if (latest !== null && !newVersion) {
      quotationId = latest.id;
      await tx.quotation.update({
        where: { id: latest.id },
        data: { lineItems: snapshot, ...totals, validUntil, pdfKey: null },
      });
    } else {
      const number = latest?.number ?? (await nextNumber(tx, built.tenant, 'quotation'));
      quotationId = newId();
      await tx.quotation.create({
        data: {
          id: quotationId,
          tenantId,
          bookingId,
          version,
          number,
          currency,
          lineItems: snapshot,
          ...totals,
          validUntil,
          createdById: this.caller.userId,
        },
      });
    }

    // Totals, frozen context and version of the booking, in the one UPDATE that also guards `rev`.
    if (!create) {
      if (options.booking === undefined) throw new Error('unreachable');
      const updated = await tx.booking.updateMany({
        where: { id: bookingId, tenantId, rev: options.booking.rev },
        data: { ...totals, pricing, quoteVersion: version, ...(options.bookingData ?? {}) },
      });
      if (updated.count !== 1) throw new VersionConflictError();
    }

    await this.jobQueue.send(
      tx,
      JOB_NAMES.PDF_RENDER,
      { tenantId, kind: 'quotation', entityId: quotationId },
      { singletonKey: `quotation:${quotationId}` },
    );
    return { bookingId, quotationId, version, sessionIds, newVersion };
  }
}
