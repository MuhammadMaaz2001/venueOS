import { describe, expect, it } from 'vitest';
import {
  BOOKING_ACTIONS,
  BOOKING_STATUSES,
  availableBookingActions,
  bookingTransition,
  isBlockingStatus,
  isEditableStatus,
} from './booking-states.js';

const to = (
  from: (typeof BOOKING_STATUSES)[number],
  action: (typeof BOOKING_ACTIONS)[number],
  cf?: (typeof BOOKING_STATUSES)[number],
) => {
  const t = bookingTransition(from, action, cf);
  return t.allowed ? t.to : t.reason;
};

describe('booking state machine (docs/05 section 2)', () => {
  it('holds a draft, confirms a hold, completes a confirmed booking', () => {
    expect(to('DRAFT', 'hold')).toBe('TENTATIVE');
    expect(to('TENTATIVE', 'confirm')).toBe('CONFIRMED');
    expect(to('CONFIRMED', 'complete')).toBe('COMPLETED');
    expect(to('TENTATIVE', 'expire')).toBe('EXPIRED');
  });

  it('cancels a draft, a hold or a confirmed booking, nothing else', () => {
    for (const from of ['DRAFT', 'TENTATIVE', 'CONFIRMED'] as const)
      expect(to(from, 'cancel')).toBe('CANCELLED');
    for (const from of ['COMPLETED', 'CANCELLED', 'EXPIRED'] as const) {
      expect(to(from, 'cancel')).toBe('NOT_FROM_THIS_STATUS');
    }
  });

  it('restores a cancelled booking to the status it came from, and re-holds an expired one', () => {
    expect(to('CANCELLED', 'restore', 'TENTATIVE')).toBe('TENTATIVE');
    expect(to('CANCELLED', 'restore', 'CONFIRMED')).toBe('CONFIRMED');
    expect(to('CANCELLED', 'restore', 'DRAFT')).toBe('DRAFT');
    expect(to('CANCELLED', 'restore')).toBe('NOTHING_TO_RESTORE');
    expect(to('CANCELLED', 'restore', 'CANCELLED')).toBe('NOTHING_TO_RESTORE');
    expect(to('TENTATIVE', 'restore', 'TENTATIVE')).toBe('NOT_FROM_THIS_STATUS');
    expect(to('EXPIRED', 'rehold')).toBe('TENTATIVE');
    expect(to('CANCELLED', 'rehold')).toBe('NOT_FROM_THIS_STATUS');
  });

  it('COMPLETED is final and the other jumps are refused', () => {
    for (const action of BOOKING_ACTIONS)
      expect(to('COMPLETED', action, 'TENTATIVE')).toBe('NOT_FROM_THIS_STATUS');
    expect(to('DRAFT', 'confirm')).toBe('NOT_FROM_THIS_STATUS');
    expect(to('CONFIRMED', 'hold')).toBe('NOT_FROM_THIS_STATUS');
    expect(to('EXPIRED', 'confirm')).toBe('NOT_FROM_THIS_STATUS');
    expect(to('DRAFT', 'expire')).toBe('NOT_FROM_THIS_STATUS');
  });

  it('which statuses block the calendar and which can be edited', () => {
    expect(BOOKING_STATUSES.filter(isBlockingStatus)).toEqual([
      'TENTATIVE',
      'CONFIRMED',
      'COMPLETED',
    ]);
    expect(BOOKING_STATUSES.filter(isEditableStatus)).toEqual(['DRAFT', 'TENTATIVE', 'CONFIRMED']);
  });

  it('offers the buttons of each status', () => {
    expect(availableBookingActions('DRAFT')).toEqual(['hold', 'cancel']);
    expect(availableBookingActions('TENTATIVE')).toEqual(['confirm', 'cancel']);
    expect(availableBookingActions('CONFIRMED')).toEqual(['cancel']);
    expect(availableBookingActions('CANCELLED')).toEqual(['restore']);
    expect(availableBookingActions('EXPIRED')).toEqual(['rehold']);
    expect(availableBookingActions('COMPLETED')).toEqual([]);
  });
});
