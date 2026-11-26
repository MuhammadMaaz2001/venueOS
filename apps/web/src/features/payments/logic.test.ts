import type { PaymentDto } from '@venueos/shared';
import { describe, expect, it } from 'vitest';
import {
  canBounce,
  canClear,
  canReverse,
  checkSchedule,
  effectOf,
  isPositiveAmount,
  needsReference,
  paymentTone,
  refundActions,
  refundTone,
  scheduleGap,
  scheduleTone,
  sumAmounts,
} from './logic';

const payment = (over: Partial<PaymentDto>): PaymentDto => ({
  id: 'p',
  bookingId: 'b',
  entryType: 'RECEIPT',
  method: 'CASH',
  amount: '100.00',
  status: 'CLEARED',
  clearedAt: null,
  reference: null,
  receiptNo: 'BK-R-2031-00001',
  receivedAt: '2031-01-01T00:00:00.000Z',
  receivedByName: null,
  notes: null,
  reversesId: null,
  reversedById: null,
  refundRequestId: null,
  receiptReady: false,
  createdAt: '2031-01-01T00:00:00.000Z',
  ...over,
});

describe('money strings are added exactly', () => {
  it('sums without a float and keeps the decimals', () => {
    expect(sumAmounts(['0.10', '0.20'])).toBe('0.30');
    expect(sumAmounts(['100000.00', '50000.50'])).toBe('150000.50');
    expect(sumAmounts(['1000.001', '0.009'], 3)).toBe('1000.010');
    expect(sumAmounts(['5000', '4999'], 0)).toBe('9999');
    expect(sumAmounts([])).toBe('0');
    expect(sumAmounts(['99999999999999.99', '0.01'], 2)).toBe('100000000000000.00');
  });
  it('handles negatives and empty boxes', () => {
    expect(sumAmounts(['100.00', '-30.50'], 2)).toBe('69.50');
    expect(sumAmounts(['10.00', '-10.00'], 2)).toBe('0.00');
    expect(sumAmounts(['10.00', '-25.00'], 2)).toBe('-15.00');
    expect(sumAmounts(['', '5.00'], 2)).toBe('5.00');
  });
  it('knows a positive amount with the currency decimals', () => {
    expect(isPositiveAmount('10.00', 2)).toBe(true);
    expect(isPositiveAmount('10', 2)).toBe(true);
    expect(isPositiveAmount('0.00', 2)).toBe(false);
    expect(isPositiveAmount('10.005', 2)).toBe(false);
    expect(isPositiveAmount('-1', 2)).toBe(false);
    expect(isPositiveAmount('ten', 2)).toBe(false);
    expect(isPositiveAmount('12.5', 3)).toBe(true);
    expect(isPositiveAmount('12.5', 0)).toBe(false);
  });
});

describe('checking an edited schedule', () => {
  const rows = [
    { label: 'Advance', dueDate: '2031-01-03', amount: '50000.00' },
    { label: 'Balance', dueDate: '2031-02-07', amount: '50000.00' },
  ];
  it('accepts items that add up to the grand total', () => {
    expect(checkSchedule(rows, '100000.00', 2)).toBeNull();
  });
  it('says what is wrong: nothing, a bad row, or the total', () => {
    expect(checkSchedule([], '100000.00', 2)).toEqual({ problem: 'EMPTY' });
    expect(checkSchedule([{ ...rows[0]!, label: ' ' }], '50000.00', 2)).toEqual({
      problem: 'ROW',
      row: 0,
    });
    expect(checkSchedule([rows[0]!, { ...rows[1]!, dueDate: '' }], '100000.00', 2)).toEqual({
      problem: 'ROW',
      row: 1,
    });
    expect(checkSchedule([rows[0]!, { ...rows[1]!, amount: '0' }], '50000.00', 2)).toEqual({
      problem: 'ROW',
      row: 1,
    });
    expect(checkSchedule(rows, '100000.01', 2)).toEqual({ problem: 'TOTAL' });
  });
  it('shows the gap to fill (negative when there is too much)', () => {
    expect(scheduleGap(rows, '100000.00', 2)).toBe('0.00');
    expect(scheduleGap([rows[0]!], '100000.00', 2)).toBe('50000.00');
    expect(
      scheduleGap([...rows, { label: 'X', dueDate: '2031-03-01', amount: '1.50' }], '100000.00', 2),
    ).toBe('-1.50');
  });
});

describe('what an entry can do', () => {
  it('only a pending cheque clears (a received one or a refund cheque)', () => {
    expect(canClear(payment({ method: 'CHEQUE', status: 'PENDING' }))).toBe(true);
    expect(canClear(payment({ method: 'CHEQUE', status: 'PENDING', entryType: 'REFUND' }))).toBe(
      true,
    );
    expect(canClear(payment({ method: 'CHEQUE', status: 'CLEARED' }))).toBe(false);
    expect(canClear(payment({ method: 'CASH' }))).toBe(false);
  });
  it('a received cheque bounces from pending or cleared, until it is bounced or reversed; refunds never', () => {
    expect(canBounce(payment({ method: 'CHEQUE', status: 'PENDING' }))).toBe(true);
    expect(canBounce(payment({ method: 'CHEQUE', status: 'CLEARED' }))).toBe(true);
    expect(canBounce(payment({ method: 'CHEQUE', status: 'BOUNCED' }))).toBe(false);
    expect(canBounce(payment({ method: 'CHEQUE', status: 'CLEARED', reversedById: 'x' }))).toBe(
      false,
    );
    expect(canBounce(payment({ method: 'CHEQUE', status: 'PENDING', entryType: 'REFUND' }))).toBe(
      false,
    );
    expect(canBounce(payment({ method: 'CASH' }))).toBe(false);
  });
  it('only a cleared receipt that was not reversed is reversed', () => {
    expect(canReverse(payment({}))).toBe(true);
    expect(canReverse(payment({ reversedById: 'x' }))).toBe(false);
    expect(canReverse(payment({ status: 'PENDING', method: 'CHEQUE' }))).toBe(false);
    expect(canReverse(payment({ entryType: 'REFUND' }))).toBe(false);
    expect(canReverse(payment({ entryType: 'REVERSAL' }))).toBe(false);
  });
  it('a cheque needs its number', () => {
    expect(needsReference('CHEQUE')).toBe(true);
    expect(needsReference('CASH')).toBe(false);
  });
  it('shows the effect: receipt +, refund -, reversal opposite to its target', () => {
    const receipt = payment({ id: 'r' });
    const refund = payment({ id: 'f', entryType: 'REFUND' });
    const byId = new Map([receipt, refund].map((p) => [p.id, p]));
    expect(effectOf(receipt, byId)).toBe('+');
    expect(effectOf(refund, byId)).toBe('-');
    expect(effectOf(payment({ entryType: 'REVERSAL', reversesId: 'r' }), byId)).toBe('-');
    expect(effectOf(payment({ entryType: 'REVERSAL', reversesId: 'f' }), byId)).toBe('+');
  });
  it('tones', () => {
    expect(scheduleTone('OVERDUE')).toBe('danger');
    expect(scheduleTone('PAID')).toBe('success');
    expect(scheduleTone('PARTLY')).toBe('warning');
    expect(scheduleTone('UNPAID')).toBe('muted');
    expect(paymentTone('PENDING')).toBe('warning');
    expect(paymentTone('BOUNCED')).toBe('danger');
    expect(refundTone('APPROVED')).toBe('warning');
    expect(refundTone('PAID')).toBe('success');
  });
});

describe('the refund queue buttons', () => {
  const me = { userId: 'u1', canApprove: true, canPay: true };
  it('approve and reject only while REQUESTED, pay only once APPROVED', () => {
    expect(refundActions({ status: 'REQUESTED', requestedById: 'u2' }, me)).toEqual({
      approve: true,
      reject: true,
      pay: false,
      ownRequest: false,
    });
    expect(refundActions({ status: 'APPROVED', requestedById: 'u2' }, me)).toMatchObject({
      approve: false,
      pay: true,
    });
    expect(refundActions({ status: 'PAID', requestedById: 'u2' }, me)).toMatchObject({
      approve: false,
      pay: false,
    });
  });
  it('follows the permissions, and notes one request of my own', () => {
    expect(
      refundActions({ status: 'REQUESTED', requestedById: 'u1' }, { ...me, canApprove: false }),
    ).toMatchObject({ approve: false, ownRequest: true });
    expect(
      refundActions({ status: 'APPROVED', requestedById: 'u2' }, { ...me, canPay: false }),
    ).toMatchObject({ pay: false });
  });
});
