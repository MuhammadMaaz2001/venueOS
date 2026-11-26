import { Inject, Injectable } from '@nestjs/common';
import { JobQueue, TenantDb, enqueueEmail } from '@venueos/db';
import {
  JOB_NAMES,
  allocateFifo,
  clearedNet,
  formatMoney,
  money,
  paymentDueJobPayloadSchema,
} from '@venueos/shared';
import type { PaymentDueJobPayload } from '@venueos/shared';
import type { JobOutput, ScheduleSpec } from '../jobs/registered-job';
import { TenantJob } from '../jobs/tenant-job';
import type { JobContext } from '../jobs/tenant-job';
import { date, group } from '../pdf/format';
import { PgBossService } from '../queue/pg-boss.service';
import { Scanner } from '../scanners/scanner';
import type { ScanContext, ScanTarget } from '../scanners/scanner';
import { ScannerDb } from '../scanners/scanner-db';

/** Injection token of the enqueue-only `JobQueue` (role venueos_app) the reminder job sends its emails with. */
export const PAYMENTS_JOB_QUEUE = Symbol('PAYMENTS_JOB_QUEUE');

const TARGET: ScanTarget<PaymentDueJobPayload> = {
  queue: JOB_NAMES.PAYMENT_DUE_RUN,
  payloadSchema: paymentDueJobPayloadSchema,
  expireInSeconds: 300,
};

/**
 * Schedule items that are due within the workspace's `reminderDays` (default 3) of ITS local date, were not reminded yet and
 * belong to a held or confirmed booking, once the workspace's local time is 09:00 or later: the "daily 09:00 venue time" of
 * docs/02, done with an hourly scan because the scanner runs on one UTC clock and workspaces live in many time zones.
 * Only ids leave the database.
 */
export const DUE_ITEMS_SQL = `
  SELECT i.id, i.tenant_id
    FROM payment_schedule_items i
    JOIN bookings b ON b.id = i.booking_id
    JOIN tenants t ON t.id = i.tenant_id
   WHERE NOT i.reminded
     AND b.status IN ('TENTATIVE', 'CONFIRMED')
     AND t.status IN ('TRIAL', 'ACTIVE', 'PAST_DUE')
     AND extract(hour FROM (now() AT TIME ZONE t.timezone)) >= 9
     AND i.due_date <= (now() AT TIME ZONE t.timezone)::date + COALESCE((t.settings->>'reminderDays')::int, 3)`;

/** `reminders.payment-due`: hourly; one `reminders.payment-due.run` per item that is due soon and not reminded yet. */
@Injectable()
export class PaymentDueScanner extends Scanner {
  readonly queue = JOB_NAMES.PAYMENT_DUE;
  override readonly schedule: ScheduleSpec = { cron: '5 * * * *', tz: 'UTC' };

  constructor(scannerDb: ScannerDb, pgBoss: PgBossService) {
    super(scannerDb, pgBoss);
  }

  protected async scan(ctx: ScanContext): Promise<void> {
    for await (const page of ctx.pages(DUE_ITEMS_SQL)) {
      for (const row of page) {
        if (row.tenantId) {
          await ctx.enqueue(
            TARGET,
            { tenantId: row.tenantId, itemId: row.id },
            `payment-due:${row.id}`,
          );
        }
      }
    }
  }
}

/**
 * `reminders.payment-due.run` (docs/05 sections 5 and 14): re-checks the item inside the tenant, works out what is still owed
 * on it from the cleared receipts (FIFO, like the API), and emails the customer ONCE. An item that is already paid, or whose
 * customer has no address, is only marked as handled. The `reminded` flag is claimed with a conditional UPDATE in the same
 * transaction that queues the email, so a duplicate job sends nothing.
 */
@Injectable()
export class PaymentDueRunJob extends TenantJob<PaymentDueJobPayload> {
  readonly queue = JOB_NAMES.PAYMENT_DUE_RUN;
  protected readonly payloadSchema = paymentDueJobPayloadSchema;

  constructor(
    tenantDb: TenantDb,
    @Inject(PAYMENTS_JOB_QUEUE) private readonly jobQueue: JobQueue,
  ) {
    super(tenantDb);
  }

  protected handle(ctx: JobContext<PaymentDueJobPayload>): Promise<JobOutput> {
    const { tenantId, itemId } = ctx.payload;
    return ctx.tx(async (tx): Promise<JobOutput> => {
      const item = await tx.paymentScheduleItem.findFirst({
        where: { id: itemId, tenantId },
        include: {
          booking: {
            include: {
              customer: { select: { name: true, email: true, preferredLocale: true } },
            },
          },
        },
      });
      if (!item) return { result: 'NOT_FOUND' };
      if (item.reminded) return { result: 'ALREADY_REMINDED' };
      const b = item.booking;
      if (b.status !== 'TENTATIVE' && b.status !== 'CONFIRMED') return { result: 'NOT_ACTIVE' };
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { name: true, timezone: true, defaultLocale: true },
      });
      if (!tenant) return { result: 'NOT_FOUND' };

      const items = await tx.paymentScheduleItem.findMany({
        where: { tenantId, bookingId: b.id },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const rows = await tx.payment.findMany({
        where: { tenantId, bookingId: b.id },
        select: { id: true, entryType: true, status: true, amount: true, reversesId: true },
      });
      const received = clearedNet(rows.map((r) => ({ ...r, amount: r.amount.toString() })));
      const allocation = allocateFifo(
        items.map((i, position) => ({
          id: i.id,
          dueDate: i.dueDate.toISOString().slice(0, 10),
          amount: i.amount.toString(),
          position,
        })),
        received,
        new Date().toISOString().slice(0, 10),
      );
      const state = allocation.items.find((s) => s.id === item.id);
      const claim = () =>
        tx.paymentScheduleItem.updateMany({
          where: { id: item.id, tenantId, reminded: false },
          data: { reminded: true },
        });

      if (!state || money(state.remaining).lte(0)) {
        await claim();
        return { result: 'PAID' };
      }
      const to = b.customer.email;
      if (!to) {
        await claim();
        return { result: 'NO_RECIPIENT' };
      }
      if ((await claim()).count !== 1) return { result: 'ALREADY_REMINDED' };
      await enqueueEmail(this.jobQueue, tx, tenantId, {
        to,
        template: 'payment.due',
        locale: b.customer.preferredLocale ?? tenant.defaultLocale,
        event: 'payment.due',
        entityType: 'booking',
        entityId: b.id,
        vars: {
          customerName: b.customer.name,
          tenantName: tenant.name,
          bookingNumber: b.number ?? '',
          label: item.label,
          amount: `${b.currency} ${group(formatMoney(state.remaining, b.currency))}`,
          dueDate: date(item.dueDate, 'UTC'),
        },
      });
      return { result: 'REMINDED' };
    });
  }
}
