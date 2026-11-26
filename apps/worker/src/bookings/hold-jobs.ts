import { Inject, Injectable } from '@nestjs/common';
import { JobQueue, TenantDb, enqueueEmail } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import {
  JOB_NAMES,
  bookingJobPayloadSchema,
  clearedNet,
  formatInstantForEmail,
  money,
} from '@venueos/shared';
import type { BookingJobPayload } from '@venueos/shared';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import type { JobOutput, ScheduleSpec } from '../jobs/registered-job';
import { TenantJob } from '../jobs/tenant-job';
import type { JobContext } from '../jobs/tenant-job';
import { PgBossService } from '../queue/pg-boss.service';
import { Scanner } from '../scanners/scanner';
import type { ScanContext, ScanTarget } from '../scanners/scanner';
import { ScannerDb } from '../scanners/scanner-db';

/** Injection token of the enqueue-only `JobQueue` (role venueos_app) these jobs send their emails with. */
export const BOOKINGS_JOB_QUEUE = Symbol('BOOKINGS_JOB_QUEUE');

const DEFAULT_APP_ORIGIN = 'http://localhost:3000';
const ACTIVE_TENANTS = `t.status IN ('TRIAL', 'ACTIVE', 'PAST_DUE')`;

const target = (queue: string, expireInSeconds = 300): ScanTarget<BookingJobPayload> => ({
  queue,
  payloadSchema: bookingJobPayloadSchema,
  expireInSeconds,
});
const EXPIRE_TARGET = target(JOB_NAMES.HOLDS_EXPIRE_RUN);
const WARN_TARGET = target(JOB_NAMES.HOLDS_WARN_RUN);
const COMPLETE_TARGET = target(JOB_NAMES.BOOKINGS_COMPLETE_RUN);

/** Tentative holds whose time is up. Only ids leave the database. */
export const ENDED_HOLDS_SQL = `
  SELECT b.id, b.tenant_id
    FROM bookings b JOIN tenants t ON t.id = b.tenant_id
   WHERE b.status = 'TENTATIVE' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= now()
     AND ${ACTIVE_TENANTS}`;

/** Holds that end within the tenant's `holdWarnHours` (default 6) and were not warned about yet. */
export const ENDING_HOLDS_SQL = `
  SELECT b.id, b.tenant_id
    FROM bookings b JOIN tenants t ON t.id = b.tenant_id
   WHERE b.status = 'TENTATIVE' AND b.hold_expires_at IS NOT NULL AND b.hold_warned_at IS NULL
     AND b.hold_expires_at > now()
     AND b.hold_expires_at <= now() + make_interval(hours => COALESCE((t.settings->>'holdWarnHours')::int, 6))
     AND ${ACTIVE_TENANTS}`;

/**
 * `holds.expire` (docs/02, docs/05 section 2): every 5 minutes, one `holds.expire.run` per tentative hold that ended and one
 * `holds.warn.run` per hold that is about to end. Identifiers only; the per-booking jobs do the work inside the tenant.
 */
@Injectable()
export class HoldsScanner extends Scanner {
  readonly queue = JOB_NAMES.HOLDS_EXPIRE;
  override readonly schedule: ScheduleSpec = { cron: '*/5 * * * *', tz: 'UTC' };

  constructor(scannerDb: ScannerDb, pgBoss: PgBossService) {
    super(scannerDb, pgBoss);
  }

  protected async scan(ctx: ScanContext): Promise<void> {
    for await (const page of ctx.pages(ENDED_HOLDS_SQL)) {
      for (const row of page) {
        if (row.tenantId) {
          await ctx.enqueue(
            EXPIRE_TARGET,
            { tenantId: row.tenantId, bookingId: row.id },
            `hold-expire:${row.id}`,
          );
        }
      }
    }
    for await (const page of ctx.pages(ENDING_HOLDS_SQL)) {
      for (const row of page) {
        if (row.tenantId) {
          await ctx.enqueue(
            WARN_TARGET,
            { tenantId: row.tenantId, bookingId: row.id },
            `hold-warn:${row.id}`,
          );
        }
      }
    }
  }
}

/** Confirmed bookings whose last active session ended at least 24 hours ago (docs/05 section 2). */
export const FINISHED_BOOKINGS_SQL = `
  SELECT b.id, b.tenant_id
    FROM bookings b JOIN tenants t ON t.id = b.tenant_id
   WHERE b.status = 'CONFIRMED' AND ${ACTIVE_TENANTS}
     AND EXISTS (SELECT 1 FROM booking_sessions s WHERE s.booking_id = b.id AND s.status = 'ACTIVE')
     AND NOT EXISTS (SELECT 1 FROM booking_sessions s
                      WHERE s.booking_id = b.id AND s.status = 'ACTIVE' AND s.ends_at > now() - interval '24 hours')`;

/** `bookings.complete`: hourly; one `bookings.complete.run` per confirmed booking whose events are over. */
@Injectable()
export class BookingsCompleteScanner extends Scanner {
  readonly queue = JOB_NAMES.BOOKINGS_COMPLETE;
  override readonly schedule: ScheduleSpec = { cron: '7 * * * *', tz: 'UTC' };

  constructor(scannerDb: ScannerDb, pgBoss: PgBossService) {
    super(scannerDb, pgBoss);
  }

  protected async scan(ctx: ScanContext): Promise<void> {
    for await (const page of ctx.pages(FINISHED_BOOKINGS_SQL)) {
      for (const row of page) {
        if (row.tenantId) {
          await ctx.enqueue(
            COMPLETE_TARGET,
            { tenantId: row.tenantId, bookingId: row.id },
            `booking-complete:${row.id}`,
          );
        }
      }
    }
  }
}

/** Writes a SYSTEM audit row (no user acts: a job did). The app role may insert audit rows, never change them. */
function auditSystem(
  tx: DbTx,
  tenantId: string,
  booking: { id: string; venueId: string },
  action: string,
  before: unknown,
  after: unknown,
) {
  return tx.auditLog.create({
    data: {
      tenantId,
      actorType: 'SYSTEM',
      action,
      entityType: 'booking',
      entityId: booking.id,
      venueId: booking.venueId,
      before: before as never,
      after: after as never,
    },
  });
}

/** Shared by the two hold jobs: the booking with what the email prints. */
async function loadHold(tx: DbTx, tenantId: string, bookingId: string) {
  const booking = await tx.booking.findFirst({
    where: { id: bookingId, tenantId },
    include: {
      customer: { select: { name: true } },
      venue: { select: { timezone: true } },
      createdBy: { select: { name: true, email: true } },
      sessions: {
        where: { status: 'ACTIVE' },
        orderBy: { startsAt: 'asc' },
        take: 1,
        select: { startsAt: true },
      },
    },
  });
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: { timezone: true, defaultLocale: true },
  });
  return { booking, tenant };
}

abstract class HoldJob extends TenantJob<BookingJobPayload> {
  protected readonly payloadSchema = bookingJobPayloadSchema;

  constructor(
    tenantDb: TenantDb,
    protected readonly jobQueue: JobQueue,
    protected readonly config: WorkerConfig,
  ) {
    super(tenantDb);
  }

  protected bookingUrl(id: string): string {
    return `${this.config.APP_ORIGIN ?? DEFAULT_APP_ORIGIN}/bookings/${id}`;
  }
}

/**
 * `holds.expire.run`: a tentative hold whose time is up becomes EXPIRED; the database trigger frees its calendar slots in the
 * same statement. Re-checked inside the tenant (a confirmation or extension that just happened wins) and audited as SYSTEM.
 * The agent who made the hold gets an email.
 */
@Injectable()
export class HoldExpireRunJob extends HoldJob {
  readonly queue = JOB_NAMES.HOLDS_EXPIRE_RUN;

  constructor(
    tenantDb: TenantDb,
    @Inject(BOOKINGS_JOB_QUEUE) jobQueue: JobQueue,
    @Inject(WORKER_CONFIG) config: WorkerConfig,
  ) {
    super(tenantDb, jobQueue, config);
  }

  protected handle(ctx: JobContext<BookingJobPayload>): Promise<JobOutput> {
    const { tenantId, bookingId } = ctx.payload;
    return ctx.tx(async (tx): Promise<JobOutput> => {
      const { booking, tenant } = await loadHold(tx, tenantId, bookingId);
      if (!booking) return { result: 'NOT_FOUND' };
      const expired = await tx.booking.updateMany({
        where: { id: bookingId, tenantId, status: 'TENTATIVE', holdExpiresAt: { lte: new Date() } },
        data: { status: 'EXPIRED' },
      });
      if (expired.count !== 1) return { result: 'NOT_EXPIRED' };
      await auditSystem(
        tx,
        tenantId,
        booking,
        'booking.expire',
        { status: 'TENTATIVE' },
        { status: 'EXPIRED' },
      );
      const agent = booking.createdBy;
      if (agent?.email && tenant) {
        const timezone = booking.venue.timezone ?? tenant.timezone;
        const first = booking.sessions[0]?.startsAt;
        await enqueueEmail(this.jobQueue, tx, tenantId, {
          to: agent.email,
          template: 'hold.expired',
          locale: tenant.defaultLocale,
          event: 'hold.expired',
          entityType: 'booking',
          entityId: booking.id,
          vars: {
            agentName: agent.name,
            bookingNumber: booking.number ?? '',
            customerName: booking.customer.name,
            firstSession: first ? formatInstantForEmail(first, timezone) : 'Not set',
            bookingUrl: this.bookingUrl(booking.id),
          },
        });
      }
      return { result: 'EXPIRED' };
    });
  }
}

/** `holds.warn.run`: tells the agent once that the hold ends soon. The stamp `hold_warned_at` does not bump the booking's `rev`. */
@Injectable()
export class HoldWarnRunJob extends HoldJob {
  readonly queue = JOB_NAMES.HOLDS_WARN_RUN;

  constructor(
    tenantDb: TenantDb,
    @Inject(BOOKINGS_JOB_QUEUE) jobQueue: JobQueue,
    @Inject(WORKER_CONFIG) config: WorkerConfig,
  ) {
    super(tenantDb, jobQueue, config);
  }

  protected handle(ctx: JobContext<BookingJobPayload>): Promise<JobOutput> {
    const { tenantId, bookingId } = ctx.payload;
    return ctx.tx(async (tx): Promise<JobOutput> => {
      const { booking, tenant } = await loadHold(tx, tenantId, bookingId);
      if (!booking?.holdExpiresAt) return { result: 'NOT_FOUND' };
      const claimed = await tx.booking.updateMany({
        where: {
          id: bookingId,
          tenantId,
          status: 'TENTATIVE',
          holdWarnedAt: null,
          holdExpiresAt: { gt: new Date() },
        },
        data: { holdWarnedAt: new Date() },
      });
      if (claimed.count !== 1) return { result: 'NOT_NEEDED' };
      const agent = booking.createdBy;
      if (!agent?.email || !tenant) return { result: 'NO_RECIPIENT' };
      const timezone = booking.venue.timezone ?? tenant.timezone;
      await enqueueEmail(this.jobQueue, tx, tenantId, {
        to: agent.email,
        template: 'hold.expiring',
        locale: tenant.defaultLocale,
        event: 'hold.expiring',
        entityType: 'booking',
        entityId: booking.id,
        vars: {
          agentName: agent.name,
          bookingNumber: booking.number ?? '',
          customerName: booking.customer.name,
          expiresAt: formatInstantForEmail(booking.holdExpiresAt, timezone),
          bookingUrl: this.bookingUrl(booking.id),
        },
      });
      return { result: 'WARNED' };
    });
  }
}

/**
 * `bookings.complete.run` (docs/05 section 2): the day after the last session a CONFIRMED booking becomes COMPLETED when its
 * balance is paid (cleared receipts cover the grand total). Otherwise it stays CONFIRMED and shows up in receivables.
 */
@Injectable()
export class BookingCompleteRunJob extends HoldJob {
  readonly queue = JOB_NAMES.BOOKINGS_COMPLETE_RUN;

  constructor(
    tenantDb: TenantDb,
    @Inject(BOOKINGS_JOB_QUEUE) jobQueue: JobQueue,
    @Inject(WORKER_CONFIG) config: WorkerConfig,
  ) {
    super(tenantDb, jobQueue, config);
  }

  protected handle(ctx: JobContext<BookingJobPayload>): Promise<JobOutput> {
    const { tenantId, bookingId } = ctx.payload;
    return ctx.tx(async (tx): Promise<JobOutput> => {
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, tenantId, status: 'CONFIRMED' },
        select: { id: true, venueId: true, grandTotal: true },
      });
      if (!booking) return { result: 'NOT_CONFIRMED' };
      const open = await tx.bookingSession.count({
        where: {
          bookingId,
          tenantId,
          status: 'ACTIVE',
          endsAt: { gt: new Date(Date.now() - 24 * 3_600_000) },
        },
      });
      if (open > 0) return { result: 'NOT_OVER' };
      const rows = await tx.payment.findMany({
        where: { tenantId, bookingId },
        select: { id: true, entryType: true, status: true, amount: true, reversesId: true },
      });
      const received = clearedNet(rows.map((r) => ({ ...r, amount: r.amount.toString() })));
      if (money(received).lt(booking.grandTotal.toString())) return { result: 'BALANCE_DUE' };
      const done = await tx.booking.updateMany({
        where: { id: bookingId, tenantId, status: 'CONFIRMED' },
        data: { status: 'COMPLETED' },
      });
      if (done.count !== 1) return { result: 'CHANGED' };
      await auditSystem(
        tx,
        tenantId,
        booking,
        'booking.complete',
        { status: 'CONFIRMED' },
        { status: 'COMPLETED' },
      );
      return { result: 'COMPLETED' };
    });
  }
}
