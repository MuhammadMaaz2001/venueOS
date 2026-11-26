import type { TestApp } from './create-test-app';
import { code, makeEventType, makeSlot, makeSpace, makeVenue, setupCaller } from './setup-fixtures';
import type { Caller } from './setup-fixtures';
import { authHeader } from './test-auth';
import type { TestMember, World } from './world';

// A workspace ready to be quoted and booked: a venue with Hall A, Hall B and the combined Hall A+B, Lunch and Dinner slots, two
// event types, a package, four add-ons and a customer. Everything is created through the API itself, so it exercises the real rules.

/** A date far in the future (outside the guest lock window and any hold timer): `day(0)` is 2031-01-01. */
export const day = (n: number): string =>
  new Date(Date.UTC(2031, 0, 1 + n)).toISOString().slice(0, 10);

export interface BookingWorld {
  c: Caller;
  venue: { id: string; name: string };
  hallA: { id: string };
  hallB: { id: string };
  hallAB: { id: string };
  lunch: { id: string };
  dinner: { id: string };
  mehndi: { id: string };
  barat: { id: string };
  pkg: { id: string };
  addOns: { fixed: string; perHead: string; perHour: string; perUnit: string };
  customer: { id: string; name: string };
}

export interface BookingWorldOptions {
  /** Hall A's cleanup buffer in minutes (default 0). */
  cleanupBufferMin?: number;
  localRules?: Record<string, unknown>;
  tax?: { ratePct: string; inclusive: boolean };
  /** Tenant plan; the default (enterprise) has no limits in the way. */
  policy?: boolean;
}

let counter = 0;

export async function bookingWorld(
  t: TestApp,
  world: World,
  options: BookingWorldOptions = {},
): Promise<BookingWorld> {
  const c = await setupCaller(world, t);
  const post = async (path: string, body: object) => {
    const res = await t.http().post(path).set(c.auth).send(body);
    if (res.status !== 201) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; name?: string };
  };
  const venue = await makeVenue(t, c.auth, {
    name: 'Royal Hall',
    ...(options.localRules ? { localRules: options.localRules } : {}),
  });
  const hallA = await makeSpace(t, c.auth, venue.id, {
    name: 'Hall A',
    baseRent: '100000',
    cleanupBufferMin: options.cleanupBufferMin ?? 0,
  });
  const hallB = await makeSpace(t, c.auth, venue.id, { name: 'Hall B', baseRent: '80000' });
  const hallAB = await makeSpace(t, c.auth, venue.id, {
    name: 'Hall A+B',
    isCombined: true,
    componentIds: [hallA.id, hallB.id],
    baseRent: '250000',
  });
  const lunch = await makeSlot(t, c.auth, venue.id, {
    name: 'Lunch',
    startTime: '12:00',
    endTime: '16:00',
  });
  const dinner = await makeSlot(t, c.auth, venue.id, {
    name: 'Dinner',
    startTime: '19:00',
    endTime: '23:30',
  });
  const mehndi = await makeEventType(t, c.auth, { name: 'Mehndi' });
  const barat = await makeEventType(t, c.auth, { name: 'Barat' });
  const pkg = await post('/v1/packages', {
    name: 'Gold menu',
    perHeadRate: '1500',
    minGuests: 100,
    items: [],
  });
  const addOn = async (name: string, pricing: string, price: string) =>
    (await post('/v1/add-ons', { name, pricing, price })).id;
  const addOns = {
    fixed: await addOn('Stage decor', 'FIXED', '5000'),
    perHead: await addOn('Soft drinks', 'PER_HEAD', '100'),
    perHour: await addOn('DJ', 'PER_HOUR', '2000'),
    perUnit: await addOn('Extra chairs', 'PER_UNIT', '300'),
  };
  if (options.tax) {
    await post('/v1/tax-rates', {
      name: 'GST',
      ratePct: options.tax.ratePct,
      inclusive: options.tax.inclusive,
      isDefault: true,
    });
  }
  if (options.policy !== false) {
    await post('/v1/cancellation-policies', {
      name: 'Standard',
      tiers: [
        { minDaysBefore: 60, refundPct: 80 },
        { minDaysBefore: 30, refundPct: 50 },
        { minDaysBefore: 0, refundPct: 0 },
      ],
      isDefault: true,
    });
  }
  const customerRes = await t
    .http()
    .post('/v1/customers')
    .set(c.auth)
    .send({
      name: `Hina Malik ${++counter}`,
      phone: `0300 ${String(5000000 + counter)}`,
      email: `hina${counter}@example.test`,
    });
  if (customerRes.status !== 201) throw new Error(`customer: ${JSON.stringify(customerRes.body)}`);
  return {
    c,
    venue: { id: venue.id, name: venue.name },
    hallA,
    hallB,
    hallAB,
    lunch,
    dinner,
    mehndi,
    barat,
    pkg,
    addOns,
    customer: { id: customerRes.body.id, name: customerRes.body.name },
  };
}

/** A session body of a quotation. */
export function session(
  fx: BookingWorld,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    spaceId: fx.hallA.id,
    date: day(0),
    slotId: fx.dinner.id,
    eventTypeId: fx.barat.id,
    guests: 200,
    ...over,
  };
}

/** A quotation body for one session (or the given sessions). */
export function quoteBody(
  fx: BookingWorld,
  sessions?: Record<string, unknown>[],
  over: Record<string, unknown> = {},
) {
  return {
    venueId: fx.venue.id,
    customerId: fx.customer.id,
    sessions: sessions ?? [session(fx)],
    ...over,
  };
}

export const memberAuth = (
  t: TestApp,
  m: Pick<TestMember, 'userId'>,
  c: Caller,
): Record<string, string> => t.as(authHeader(m.userId, c.tenant.id));

/** Create a quotation as `auth` (the owner by default) and return the body. */
export async function createQuotation(
  t: TestApp,
  fx: BookingWorld,
  body: object = quoteBody(fx),
  auth: Record<string, string> = fx.c.auth,
) {
  const res = await t.http().post('/v1/quotations').set(auth).send(body);
  if (res.status !== 201)
    throw new Error(`createQuotation: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as {
    id: string;
    bookingId: string;
    number: string;
    version: number;
    totals: { grandTotal: string };
  };
}

export async function getBooking(t: TestApp, fx: BookingWorld, id: string, auth = fx.c.auth) {
  const res = await t.http().get(`/v1/bookings/${id}`).set(auth);
  if (res.status !== 200) throw new Error(`getBooking: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Create a quotation and hold it; returns the held booking. */
export async function heldBooking(
  t: TestApp,
  fx: BookingWorld,
  body: object = quoteBody(fx),
  auth: Record<string, string> = fx.c.auth,
) {
  const q = await createQuotation(t, fx, body, auth);
  const booking = await getBooking(t, fx, q.bookingId, auth);
  const res = await t
    .http()
    .post(`/v1/bookings/${q.bookingId}/hold`)
    .set(auth)
    .send({ rev: booking.rev });
  if (res.status !== 200) throw new Error(`hold: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export { code };
