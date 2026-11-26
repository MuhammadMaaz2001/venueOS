import { describe, expect, it } from 'vitest';
import { clearedNet } from './ledger';
import type { LedgerRow } from './ledger';

const row = (over: Partial<LedgerRow> & { id: string }): LedgerRow => ({
  entryType: 'RECEIPT',
  status: 'CLEARED',
  amount: '100.00',
  reversesId: null,
  ...over,
});

describe('clearedNet (docs/03 "Paid total")', () => {
  it('adds cleared receipts and takes off cleared refunds', () => {
    expect(
      clearedNet([
        row({ id: 'a', amount: '500.50' }),
        row({ id: 'b', amount: '250.25' }),
        row({ id: 'r', entryType: 'REFUND', amount: '300.00' }),
      ]),
    ).toBe('450.75');
  });

  it('a pending or bounced cheque never counts', () => {
    expect(
      clearedNet([
        row({ id: 'a', amount: '100' }),
        row({ id: 'p', status: 'PENDING', amount: '900' }),
        row({ id: 'b', status: 'BOUNCED', amount: '700' }),
      ]),
    ).toBe('100');
  });

  it('a cleared reversal takes back the receipt it points to, and gives back a refund', () => {
    expect(
      clearedNet([
        row({ id: 'a', amount: '1000' }),
        row({ id: 'x', entryType: 'REVERSAL', amount: '1000', reversesId: 'a' }),
      ]),
    ).toBe('0');
    expect(
      clearedNet([
        row({ id: 'a', amount: '1000' }),
        row({ id: 'r', entryType: 'REFUND', amount: '400' }),
        row({ id: 'x', entryType: 'REVERSAL', amount: '400', reversesId: 'r' }),
      ]),
    ).toBe('1000');
  });

  it('a reversal of an entry that is not cleared (or not there) changes nothing', () => {
    expect(
      clearedNet([
        row({ id: 'p', status: 'PENDING', amount: '500' }),
        row({ id: 'x', entryType: 'REVERSAL', amount: '500', reversesId: 'p' }),
        row({ id: 'y', entryType: 'REVERSAL', amount: '500', reversesId: 'gone' }),
      ]),
    ).toBe('0');
  });

  it('a bounce AFTER clearing lowers the total (the row is BOUNCED now)', () => {
    const cleared = [row({ id: 'a', amount: '60000' })];
    expect(clearedNet(cleared)).toBe('60000');
    expect(clearedNet([row({ id: 'a', amount: '60000', status: 'BOUNCED' })])).toBe('0');
  });

  it('is exact with cents and can go negative when more was refunded than received', () => {
    expect(clearedNet([row({ id: 'a', amount: '0.10' }), row({ id: 'b', amount: '0.20' })])).toBe(
      '0.3',
    );
    expect(clearedNet([row({ id: 'r', entryType: 'REFUND', amount: '5' })])).toBe('-5');
    expect(clearedNet([])).toBe('0');
  });
});
