import { Injectable } from '@nestjs/common';
import type { DbTx } from '@venueos/db';
import { clearedNet, formatMoney, money, parseTenantSettings } from '@venueos/shared';
import type {
  LeadStage,
  LedgerRow,
  LineItemDto,
  QuoteTotalsDto,
  TenantSettings,
} from '@venueos/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { NotFoundError } from '../../../common/errors/domain-errors';
import { localDateOf } from '../../../common/time/zoned';

/**
 * The next number of a sequence (`booking:2027`, `quotation:2027`, ...): one UPDATE inside the caller's transaction, so a
 * rollback gives the number back and two transactions never get the same one (docs/04 section 7, docs/05 section 13).
 */
export async function nextCounter(tx: DbTx, tenantId: string, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO tenant_counters (tenant_id, key, value) VALUES (${tenantId}, ${key}, 1)
    ON CONFLICT (tenant_id, key) DO UPDATE SET value = tenant_counters.value + 1
    RETURNING value`;
  const value = rows[0]?.value;
  if (value === undefined) throw new Error('tenant_counters returned nothing');
  return Number(value);
}

/** `{prefix}-{year}-{seq:4}` and `{prefix}-Q-{year}-{seq:4}` (docs/05 section 13). The year is the workspace's current year. */
export async function nextNumber(
  tx: DbTx,
  tenant: { id: string; timezone: string; settings: TenantSettings },
  kind: 'booking' | 'quotation',
  now: Date = new Date(),
): Promise<string> {
  const year = localDateOf(now, tenant.timezone).slice(0, 4);
  const seq = await nextCounter(tx, tenant.id, `${kind}:${year}`);
  const prefix = tenant.settings.bookingPrefix;
  const padded = String(seq).padStart(4, '0');
  return kind === 'booking' ? `${prefix}-${year}-${padded}` : `${prefix}-Q-${year}-${padded}`;
}

export interface TenantContext {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  country: string;
  defaultLocale: string;
  settings: TenantSettings;
}

export async function loadTenantContext(tx: DbTx, tenantId: string): Promise<TenantContext> {
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      currency: true,
      timezone: true,
      country: true,
      defaultLocale: true,
      settings: true,
    },
  });
  if (!tenant) throw new NotFoundError();
  return { ...tenant, settings: parseTenantSettings(tenant.settings) };
}

/** Cleared net receipts of a booking, from the payments ledger (module 9 writes it; docs/03 "Paid total"). */
export async function clearedReceived(
  tx: DbTx,
  tenantId: string,
  bookingId: string,
): Promise<string> {
  const rows = await tx.payment.findMany({
    where: { tenantId, bookingId },
    select: { id: true, entryType: true, status: true, amount: true, reversesId: true },
  });
  const ledger: LedgerRow[] = rows.map((r) => ({
    id: r.id,
    entryType: r.entryType,
    status: r.status,
    amount: r.amount.toString(),
    reversesId: r.reversesId,
  }));
  return clearedNet(ledger);
}

/** Moves a lead along when its quotation is made (QUOTED) or its booking is confirmed (WON): docs/05 section 12. */
@Injectable()
export class LeadLink {
  constructor(private readonly audit: AuditService) {}

  async advance(
    tx: DbTx,
    tenantId: string,
    leadId: string | null,
    to: 'QUOTED' | 'WON',
  ): Promise<void> {
    if (!leadId) return;
    const lead = await tx.lead.findFirst({
      where: { id: leadId, tenantId },
      select: { id: true, stage: true, venueId: true },
    });
    if (!lead) return;
    const from = lead.stage as LeadStage;
    const movable =
      to === 'QUOTED'
        ? from === 'NEW' || from === 'CONTACTED' || from === 'SITE_VISIT'
        : from !== 'WON' && from !== 'LOST';
    if (!movable) return;
    const changed = await tx.lead.updateMany({
      where: { id: lead.id, tenantId, stage: lead.stage },
      data:
        to === 'WON'
          ? { stage: 'WON', nextFollowUpAt: null, lostReason: null }
          : { stage: 'QUOTED' },
    });
    if (changed.count !== 1) return;
    await this.audit.record(tx, {
      action: 'lead.stage_change',
      entityType: 'lead',
      entityId: lead.id,
      venueId: lead.venueId,
      before: { stage: from },
      after: { stage: to },
    });
  }
}

// ───────────────────────────── DTO helpers ─────────────────────────────

export const fmt = (value: { toString(): string } | string, currency: string): string =>
  formatMoney(value.toString(), currency);

/** A line as the API shows it. `visible` false (no `booking.view_prices`) blanks every amount. */
export function toLineDto(
  line: {
    id: string | null;
    sessionIndex: number | null;
    kind: LineItemDto['kind'];
    description: string;
    refType: string | null;
    refId: string | null;
    quantity: { toString(): string };
    unitPrice: { toString(): string };
    amount: { toString(): string };
    taxAmount: { toString(): string };
  },
  currency: string,
  visible: boolean,
): LineItemDto {
  const gross = money(line.amount.toString()).plus(line.taxAmount.toString());
  return {
    id: line.id,
    sessionIndex: line.sessionIndex,
    kind: line.kind,
    description: line.description,
    refType: line.refType,
    refId: line.refId,
    quantity: money(line.quantity.toString()).toString(),
    unitPrice: visible ? fmt(line.unitPrice, currency) : null,
    amount: visible ? fmt(line.amount, currency) : null,
    taxAmount: visible ? fmt(line.taxAmount, currency) : null,
    grossAmount: visible ? fmt(gross, currency) : null,
  };
}

export function toTotalsDto(
  totals: { subtotal: string; discountTotal: string; taxTotal: string; grandTotal: string },
  currency: string,
  visible: boolean,
): QuoteTotalsDto {
  return {
    subtotal: visible ? fmt(totals.subtotal, currency) : null,
    discountTotal: visible ? fmt(totals.discountTotal, currency) : null,
    taxTotal: visible ? fmt(totals.taxTotal, currency) : null,
    grandTotal: visible ? fmt(totals.grandTotal, currency) : null,
  };
}
