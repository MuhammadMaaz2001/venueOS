import type { DbTx } from '@venueos/db';
import { MoneyError, formatMoney, minorUnits, parseMoney } from '@venueos/shared';
import { FieldValidationError, NotFoundError } from '../errors/domain-errors';

/** The workspace currency (ISO 4217): the one every amount of the tenant is written in. */
export async function tenantCurrency(tx: DbTx, tenantId: string): Promise<string> {
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { currency: true } });
  if (!tenant) throw new NotFoundError();
  return tenant.currency;
}

/**
 * An amount from a client, checked against the currency (no more decimals than its minor unit, so "10.005"
 * PKR is a 400, never silently rounded) and returned in the storage/API form ("1500.00").
 */
export function clientMoney(value: string, currency: string, path: string): string {
  try {
    return formatMoney(parseMoney(value, currency), currency);
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    throw new FieldValidationError(path, error.message);
  }
}

/** A stored `Decimal(18,3)` shown with exactly the currency's decimals. */
export function storedMoney(value: { toFixed(digits: number): string }, currency: string): string {
  return value.toFixed(minorUnits(currency));
}
