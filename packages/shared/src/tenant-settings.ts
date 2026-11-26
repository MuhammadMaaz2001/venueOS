import { z } from 'zod';

/**
 * Typed shape of `tenants.settings` (JSONB). Parsing fills every default from
 * docs/05-business-rules.md §15, so code never reads raw keys or hard-codes these numbers:
 *
 *   const settings = parseTenantSettings(tenant.settings);
 *
 * Unknown keys are dropped (older rows, future keys). `tokenAmount` is a money STRING in the
 * tenant's currency; whether its decimals fit that currency is checked with `parseMoney` where the
 * currency is known.
 */
export const TenantSettings = z.object({
  /** Prefix of booking, quotation and receipt numbers (BK-2026-0142). */
  bookingPrefix: z
    .string()
    .regex(/^[A-Z0-9]{1,8}$/, 'Use 1-8 upper-case letters or digits')
    .default('BK'),
  /** Tentative hold duration in hours (and one agent extension). */
  holdHours: z.number().int().min(1).max(720).default(48),
  /** Percent of the grand total needed to confirm. */
  advancePct: z.number().int().min(0).max(100).default(50),
  /** Fixed token amount in the tenant currency ("0" = no token). */
  tokenAmount: z
    .string()
    .regex(/^\d{1,15}(\.\d{1,3})?$/, 'Use a non-negative decimal amount')
    .default('0'),
  /** Days before the first session when the balance is due. */
  balanceDueDays: z.number().int().min(0).max(365).default(7),
  /** Days before a session after which changes need `booking.edit_locked`. */
  guestLockDays: z.number().int().min(0).max(90).default(3),
  /** Payment-due reminder lead time, days. */
  reminderDays: z.number().int().min(0).max(60).default(3),
  /** Event reminder lead time, days. */
  eventReminderDays: z.number().int().min(0).max(60).default(2),
  /** Default minimum hours for HOURLY slots. */
  minHours: z.number().int().min(1).max(24).default(2),
  /** Days a quotation stays valid after it is issued. */
  quotationValidDays: z.number().int().min(1).max(365).default(14),
  /** Hours before a tentative hold ends when the agent gets the "hold expiring" email. */
  holdWarnHours: z.number().int().min(1).max(168).default(6),
});

/** Parsed settings, every key present. */
export type TenantSettings = z.output<typeof TenantSettings>;
/** What a client may send (every key optional). */
export type TenantSettingsInput = z.input<typeof TenantSettings>;

/** Parse the stored JSON (null/undefined/{} give the defaults). Throws a ZodError on invalid values. */
export function parseTenantSettings(json: unknown): TenantSettings {
  return TenantSettings.parse(json ?? {});
}
