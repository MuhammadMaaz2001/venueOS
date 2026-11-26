import { money } from './money.js';

// The payments ledger arithmetic of docs/03 ("Paid total") and docs/05 section 5, shared by the API (confirming a booking,
// refund suggestions) and the worker (completing a booking). Payments are written by module 9; reading them starts here.

export interface LedgerRow {
  id: string;
  entryType: 'RECEIPT' | 'REFUND' | 'REVERSAL';
  status: 'PENDING' | 'CLEARED' | 'BOUNCED';
  amount: string;
  reversesId: string | null;
}

/**
 * Cleared net receipts of a booking: CLEARED receipts minus CLEARED refunds, where a CLEARED reversal negates the entry it
 * points to (it takes back a receipt, or gives back a refund). Pending and bounced entries never count.
 */
export function clearedNet(rows: readonly LedgerRow[]): string {
  const cleared = rows.filter((r) => r.status === 'CLEARED');
  const byId = new Map(cleared.map((r) => [r.id, r]));
  let total = money('0');
  for (const row of cleared) {
    if (row.entryType === 'RECEIPT') total = total.plus(row.amount);
    else if (row.entryType === 'REFUND') total = total.minus(row.amount);
    else {
      const original = row.reversesId ? byId.get(row.reversesId) : undefined;
      if (original?.entryType === 'RECEIPT') total = total.minus(row.amount);
      else if (original?.entryType === 'REFUND') total = total.plus(row.amount);
    }
  }
  return total.toString();
}
