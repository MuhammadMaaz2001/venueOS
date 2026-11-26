import { describe, expect, it } from 'vitest';
import {
  addDays,
  allocateFifo,
  generateSchedule,
  readyToConfirm,
  scheduleMatchesTotal,
} from './payment-schedule';

const base = {
  grandTotal: '200000.00',
  currency: 'PKR',
  tokenAmount: '0',
  advancePct: 50,
  balanceDueDays: 7,
  today: '2031-01-01',
  advanceDue: '2031-01-03',
  firstSessionDate: '2031-02-14',
};

describe('addDays', () => {
  it('crosses month and year ends without a zone', () => {
    expect(addDays('2031-02-14', -7)).toBe('2031-02-07');
    expect(addDays('2031-01-01', -1)).toBe('2030-12-31');
    expect(addDays('2032-02-28', 1)).toBe('2032-02-29');
  });
  it('refuses a malformed date', () => {
    expect(() => addDays('14/02/2031', 1)).toThrow(RangeError);
  });
});

describe('generateSchedule', () => {
  it('without a token: Advance 50% on the hold deadline and the Balance 7 days before the first session', () => {
    expect(generateSchedule(base)).toEqual([
      { label: 'Advance', dueDate: '2031-01-03', amount: '100000.00' },
      { label: 'Balance', dueDate: '2031-02-07', amount: '100000.00' },
    ]);
  });
  it('a token counts towards the advance: the Advance item is what is left of the advance percentage', () => {
    expect(generateSchedule({ ...base, tokenAmount: '25000' })).toEqual([
      { label: 'Token', dueDate: '2031-01-01', amount: '25000.00' },
      { label: 'Advance', dueDate: '2031-01-03', amount: '75000.00' },
      { label: 'Balance', dueDate: '2031-02-07', amount: '100000.00' },
    ]);
  });
  it('a token larger than the advance leaves no Advance item; a token above the total is cut to the total', () => {
    const big = generateSchedule({ ...base, tokenAmount: '150000' });
    expect(big.map((i) => i.label)).toEqual(['Token', 'Balance']);
    expect(big[1]?.amount).toBe('50000.00');
    const all = generateSchedule({ ...base, tokenAmount: '900000' });
    expect(all).toEqual([{ label: 'Token', dueDate: '2031-01-01', amount: '200000.00' }]);
  });
  it('the items always add up to the grand total, with the currency decimals (rounding goes to the Balance)', () => {
    const odd = generateSchedule({ ...base, grandTotal: '100001.01', advancePct: 33 });
    expect(scheduleMatchesTotal(odd, '100001.01')).toBe(true);
    expect(odd.map((i) => i.amount)).toEqual(['33000.33', '67000.68']);
    const kwd = generateSchedule({
      ...base,
      currency: 'KWD',
      grandTotal: '1000.001',
      advancePct: 50,
    });
    expect(kwd.map((i) => i.amount)).toEqual(['500.001', '500.000']);
    const jpy = generateSchedule({ ...base, currency: 'JPY', grandTotal: '9999', advancePct: 50 });
    expect(jpy.map((i) => i.amount)).toEqual(['5000', '4999']);
  });
  it('the Balance is never due before the advance, nor before the token', () => {
    const soon = generateSchedule({ ...base, firstSessionDate: '2031-01-05' });
    expect(soon.map((i) => i.dueDate)).toEqual(['2031-01-03', '2031-01-03']);
    const noDeadline = generateSchedule({
      ...base,
      advanceDue: null,
      firstSessionDate: '2030-12-01',
    });
    expect(noDeadline.map((i) => i.dueDate)).toEqual(['2031-01-01', '2031-01-01']);
  });
  it('0% advance means everything is the Balance; 100% means everything is the Advance', () => {
    expect(generateSchedule({ ...base, advancePct: 0 }).map((i) => i.label)).toEqual(['Balance']);
    expect(generateSchedule({ ...base, advancePct: 100 }).map((i) => i.label)).toEqual(['Advance']);
  });
  it('a zero total has no schedule; no session date puts the Balance with the advance', () => {
    expect(generateSchedule({ ...base, grandTotal: '0.00' })).toEqual([]);
    expect(generateSchedule({ ...base, firstSessionDate: null })[1]?.dueDate).toBe('2031-01-03');
  });
});

describe('allocateFifo', () => {
  const items = [
    { id: 'balance', dueDate: '2031-02-07', amount: '100000.00', position: 2 },
    { id: 'token', dueDate: '2031-01-01', amount: '25000.00', position: 0 },
    { id: 'advance', dueDate: '2031-01-03', amount: '75000.00', position: 1 },
  ];
  const state = (a: ReturnType<typeof allocateFifo>, id: string) =>
    a.items.find((i) => i.id === id);

  it('pays the earliest due date first, whatever the order of the list', () => {
    const a = allocateFifo(items, '30000', '2030-12-31');
    expect(state(a, 'token')).toMatchObject({ allocated: '25000', remaining: '0', status: 'PAID' });
    expect(state(a, 'advance')).toMatchObject({
      allocated: '5000',
      remaining: '70000',
      status: 'PARTLY',
    });
    expect(state(a, 'balance')).toMatchObject({ allocated: '0', status: 'UNPAID' });
    expect(a.outstanding).toBe('170000');
    expect(a.credit).toBe('0');
  });
  it('flags what is past due and still owed as OVERDUE (also a partly paid item), but not what is paid', () => {
    const a = allocateFifo(items, '30000', '2031-01-04');
    expect(state(a, 'token')?.status).toBe('PAID');
    expect(state(a, 'advance')?.status).toBe('OVERDUE');
    expect(state(a, 'balance')?.status).toBe('UNPAID');
    expect(allocateFifo(items, '0', '2031-03-01').items.map((i) => i.status)).toEqual([
      'OVERDUE',
      'OVERDUE',
      'OVERDUE',
    ]);
  });
  it('an item due today is not overdue yet', () => {
    expect(state(allocateFifo(items, '0', '2031-01-03'), 'advance')?.status).toBe('UNPAID');
  });
  it('an overpayment is credit and every item is PAID', () => {
    const a = allocateFifo(items, '250000.50', '2031-03-01');
    expect(a.items.every((i) => i.status === 'PAID')).toBe(true);
    expect(a.credit).toBe('50000.5');
    expect(a.outstanding).toBe('0');
  });
  it('negative net receipts (refunded more than received) count as nothing', () => {
    const a = allocateFifo(items, '-100', '2030-12-31');
    expect(a.received).toBe('0');
    expect(a.items.every((i) => i.status === 'UNPAID')).toBe(true);
  });
  it('items due the same day are filled in creation order, and cents are exact', () => {
    const a = allocateFifo(
      [
        { id: 'b', dueDate: '2031-01-01', amount: '0.20', position: 1 },
        { id: 'a', dueDate: '2031-01-01', amount: '0.10', position: 0 },
      ],
      '0.10',
      '2030-12-31',
    );
    expect(state(a, 'a')?.status).toBe('PAID');
    expect(state(a, 'b')?.allocated).toBe('0');
  });
});

describe('scheduleMatchesTotal and readyToConfirm', () => {
  it('compares exactly', () => {
    expect(scheduleMatchesTotal([{ amount: '0.1' }, { amount: '0.2' }], '0.3')).toBe(true);
    expect(scheduleMatchesTotal([{ amount: '100.00' }], '100.01')).toBe(false);
  });
  it('is ready only while the hold is open and the cleared receipts reach the advance', () => {
    expect(readyToConfirm('TENTATIVE', '100000', '200000', 50)).toBe(true);
    expect(readyToConfirm('TENTATIVE', '99999.99', '200000', 50)).toBe(false);
    expect(readyToConfirm('CONFIRMED', '200000', '200000', 50)).toBe(false);
    expect(readyToConfirm('DRAFT', '200000', '200000', 50)).toBe(false);
    expect(readyToConfirm('TENTATIVE', '0', '0', 50)).toBe(true);
  });
});
