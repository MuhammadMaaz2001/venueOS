import { z } from 'zod';

// The booking lifecycle (docs/05 section 2) as a pure state machine, shared by the API and the web app (which only uses it
// to decide which buttons to offer; the API decides again).

export const BOOKING_STATUSES = [
  'DRAFT',
  'TENTATIVE',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
] as const;
export const BookingStatusSchema = z.enum(BOOKING_STATUSES);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

/** Statuses whose sessions block the calendar (the database derives `space_occupancies.active` from the same rule). */
export const BLOCKING_STATUSES: readonly BookingStatus[] = ['TENTATIVE', 'CONFIRMED', 'COMPLETED'];
export const isBlockingStatus = (status: BookingStatus): boolean =>
  BLOCKING_STATUSES.includes(status);

export const BOOKING_ACTIONS = [
  'hold',
  'confirm',
  'cancel',
  'expire',
  'complete',
  'restore',
  'rehold',
] as const;
export type BookingAction = (typeof BOOKING_ACTIONS)[number];

export type BookingTransition =
  | { allowed: true; to: BookingStatus }
  | { allowed: false; reason: 'NOT_FROM_THIS_STATUS' | 'NOTHING_TO_RESTORE' };

/**
 * Where an action leads, or why it is refused.
 *  - hold: DRAFT -> TENTATIVE;  confirm: TENTATIVE -> CONFIRMED;  cancel: DRAFT, TENTATIVE or CONFIRMED -> CANCELLED;
 *  - expire (the hold job): TENTATIVE -> EXPIRED;  complete (the job): CONFIRMED -> COMPLETED;
 *  - restore: CANCELLED -> the status it was cancelled from (`cancelledFrom`);  rehold: EXPIRED -> TENTATIVE.
 * COMPLETED is final.
 */
export function bookingTransition(
  from: BookingStatus,
  action: BookingAction,
  cancelledFrom?: BookingStatus | null,
): BookingTransition {
  const ok = (to: BookingStatus): BookingTransition => ({ allowed: true, to });
  const refused: BookingTransition = { allowed: false, reason: 'NOT_FROM_THIS_STATUS' };
  switch (action) {
    case 'hold':
      return from === 'DRAFT' ? ok('TENTATIVE') : refused;
    case 'confirm':
      return from === 'TENTATIVE' ? ok('CONFIRMED') : refused;
    case 'cancel':
      return from === 'DRAFT' || from === 'TENTATIVE' || from === 'CONFIRMED'
        ? ok('CANCELLED')
        : refused;
    case 'expire':
      return from === 'TENTATIVE' ? ok('EXPIRED') : refused;
    case 'complete':
      return from === 'CONFIRMED' ? ok('COMPLETED') : refused;
    case 'rehold':
      return from === 'EXPIRED' ? ok('TENTATIVE') : refused;
    case 'restore':
      if (from !== 'CANCELLED') return refused;
      return cancelledFrom && cancelledFrom !== 'CANCELLED'
        ? ok(cancelledFrom)
        : { allowed: false, reason: 'NOTHING_TO_RESTORE' };
  }
}

/** The actions worth offering for a status (a button list), in the order a person normally uses them. */
export function availableBookingActions(status: BookingStatus): BookingAction[] {
  return (['hold', 'confirm', 'cancel', 'restore', 'rehold'] as const).filter(
    (action) =>
      bookingTransition(status, action, status === 'CANCELLED' ? 'TENTATIVE' : null).allowed,
  );
}

/** Sentences for a refused transition (the API answers 422 INVALID_STATE_TRANSITION with them). */
export const BOOKING_TRANSITION_MESSAGES = {
  NOT_FROM_THIS_STATUS: 'This is not possible in the booking’s current status.',
  NOTHING_TO_RESTORE: 'This booking cannot be restored.',
} as const;

/** Sessions may be added, changed or cancelled while the booking is in one of these statuses. */
export const EDITABLE_STATUSES: readonly BookingStatus[] = ['DRAFT', 'TENTATIVE', 'CONFIRMED'];
export const isEditableStatus = (status: BookingStatus): boolean =>
  EDITABLE_STATUSES.includes(status);
