import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mailWithAttachment, uniqueEmail } from './support/mail';
import { MESSAGES, cspViolations, open, registerAndLogin } from './support/flows';

// Modules 6-8: from a lead to a quotation with two sessions (Mehndi and Barat), sent by email with the PDF, held, shown on the
// calendar, confirmed with an override, cancelled, and free on the calendar again. Also the calendar at 360 px (a day list).
// Needs the whole stack, Mailpit, the local S3 and the worker with Chromium (see playwright.config.ts).

const m = MESSAGES.en;

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

/** A date a few days ahead (UTC arithmetic; the venue is in Karachi, so it is never in the past there either). */
function inDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const cell = (page: Page, date: string) =>
  page.locator(`[data-testid="cal-cell"][data-slot="Dinner"][data-date="${date}"]`).first();

/** Shows the month of `date` on the calendar page (one click on "next" when it is in the next month). */
async function showDate(page: Page, date: string): Promise<void> {
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  if ((await cell(page, date).count()) === 0) {
    await page.getByRole('button', { name: m.Bookings.calendar.next, exact: true }).click();
  }
  await expect(cell(page, date)).toBeVisible();
}

test.describe('bookings and the calendar', () => {
  test.beforeEach(() => {
    cspViolations.length = 0;
  });
  test.afterEach(() => {
    expect(cspViolations, 'the Content Security Policy blocked something').toEqual([]);
  });

  test('lead -> quotation (two sessions) -> send -> hold -> calendar -> confirm with override -> cancel -> free again', async ({
    browser,
  }) => {
    const stamp = Date.now().toString(36);
    const owner = {
      name: 'Booking Owner',
      email: uniqueEmail('book-owner'),
      tenantName: `Booking Halls ${stamp}`,
    };
    const customerEmail = uniqueEmail('book-customer');
    const { page } = await registerAndLogin(browser, 'en', owner);

    // ── set-up: a venue with Main Hall, Lunch and Dinner (rent 100000 for Dinner) ───────────────────
    await page.waitForURL('**/setup');
    await page.locator('html[data-hydrated="true"]').waitFor();
    await page.getByLabel(m.Setup.fields.venueName, { exact: true }).fill(`Venue ${stamp}`);
    await page.getByRole('button', { name: m.Setup.wizard.venue.submit }).click();
    const spaceStep = page.getByTestId('wizard-step-spaces');
    await spaceStep.getByLabel(m.Setup.fields.spaceName, { exact: true }).fill('Main Hall');
    await spaceStep.getByRole('button', { name: m.Setup.wizard.spaces.addFirst }).click();
    await expect(page.getByTestId('wizard-space-list')).toContainText('Main Hall');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('preset-lunch').click();
    await expect(page.getByTestId('wizard-slot-list')).toContainText('Lunch');
    await page.getByTestId('preset-dinner').click();
    await expect(page.getByTestId('wizard-slot-list')).toContainText('Dinner');
    await page.getByTestId('wizard-next').click();
    await page.getByLabel('Dinner (19:00–23:30)', { exact: true }).fill('100000');
    await page.getByRole('button', { name: m.Setup.wizard.prices.save }).click();
    await expect(page.getByText(m.Setup.prices.saved)).toBeVisible();
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-package-next').click(); // skip the package
    await page.getByTestId('wizard-finish').click();
    await page.waitForURL((url) => url.pathname === '/');

    // Event types: Mehndi and Barat.
    await open(page, '/settings');
    for (const name of ['Mehndi', 'Barat']) {
      await page.getByTestId('event-type-add').click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(m.Setup.eventTypes.fields.name, { exact: true }).fill(name);
      await dialog.getByRole('button', { name: m.Setup.eventTypes.save }).click();
      await expect(page.getByTestId('event-type-list')).toContainText(name);
    }

    // The navigation shows the new pages.
    await expect(page.getByRole('link', { name: m.Shell.nav.calendar, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: m.Shell.nav.bookings, exact: true })).toBeVisible();

    // ── a lead with a new customer ───────────────────────────────────────────────────────────────────
    await open(page, '/leads');
    await page.getByTestId('lead-add').click();
    const inquiry = page.getByRole('dialog');
    await inquiry.getByTestId('inquiry-customer-name').fill('Hina Malik');
    await inquiry.getByTestId('inquiry-customer-phone').fill('0300 7654321');
    await inquiry.getByTestId('lead-submit').click();
    await page.waitForURL(/\/leads\/[a-z0-9]+$/);

    // ── the quotation: two sessions ──────────────────────────────────────────────────────────────────
    const day1 = inDays(5);
    const day2 = inDays(6);
    await page.getByTestId('lead-create-quotation').click();
    await page.waitForURL(/\/quotations\/new\?leadId=/);
    await expect(page.getByTestId('builder-customer')).toContainText('Hina Malik');
    const first = page.getByTestId('session-editor').nth(0);
    await first.getByTestId('session-event-type').selectOption({ label: 'Mehndi' });
    await first.getByTestId('session-space').selectOption({ label: 'Main Hall' });
    await first.getByTestId('session-date').fill(day1);
    await first.getByTestId('session-slot').selectOption({ label: 'Dinner (19:00–23:30)' });
    await first.getByTestId('session-guests').fill('150');
    await page.getByTestId('add-session').click();
    const second = page.getByTestId('session-editor').nth(1);
    await second.getByTestId('session-event-type').selectOption({ label: 'Barat' });
    await second.getByTestId('session-space').selectOption({ label: 'Main Hall' });
    await second.getByTestId('session-date').fill(day2);
    await second.getByTestId('session-slot').selectOption({ label: 'Dinner (19:00–23:30)' });
    await second.getByTestId('session-guests').fill('300');
    // The live price comes from the server: 2 x 100,000 rent.
    await expect(page.getByTestId('quote-grand-total')).toContainText(/PKR\s*200,000\.00/);
    await expect(page.getByTestId('quote-line')).toHaveCount(2);
    await page.getByTestId('builder-save').click();
    await page.waitForURL(/\/bookings\/[a-z0-9]+$/);
    const bookingUrl = page.url();
    await expect(page.getByTestId('booking-status')).toHaveText(m.Bookings.status.DRAFT);
    await expect(page.getByTestId('booking-session')).toHaveCount(2);

    // ── send: the email arrives with the PDF attached ────────────────────────────────────────────────
    const send = page.getByTestId('quotation-send');
    await expect(send).toBeEnabled({ timeout: 150_000 }); // the worker renders the PDF
    await send.click();
    const sendDialog = page.getByTestId('dialog-send');
    await sendDialog.getByTestId('send-to').fill(customerEmail);
    await sendDialog.getByTestId('send-submit').click();
    await expect(page.getByTestId('quotation-version')).toContainText(m.Bookings.quotations.latest);
    const mail = await mailWithAttachment(customerEmail);
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]).toMatchObject({ contentType: 'application/pdf' });
    expect(mail.attachments[0]?.fileName).toMatch(/\.pdf$/);

    // ── hold ─────────────────────────────────────────────────────────────────────────────────────────
    await page.getByTestId('action-hold').click();
    await page.getByTestId('dialog-hold').getByTestId('dialog-submit').click();
    await expect(page.getByTestId('booking-status')).toHaveText(m.Bookings.status.TENTATIVE);
    await expect(page.getByTestId('hold-countdown')).toBeVisible();
    await expect(page.getByTestId('booking-title')).toContainText(/-\d{4}-\d{4}$/);
    const number = (await page.getByTestId('booking-title').textContent()) ?? '';

    // ── the calendar shows both days as held; a taken cell opens the booking ─────────────────────────
    await open(page, '/calendar');
    await showDate(page, day1);
    await expect(cell(page, day1)).toHaveAttribute('data-status', 'HELD');
    await expect(cell(page, day2)).toHaveAttribute('data-status', 'HELD');
    await expect(page.getByTestId('calendar-legend')).toBeVisible();
    await cell(page, day1).click();
    await expect(page.getByTestId('booked-detail')).toContainText('Hina Malik');
    await expect(page.getByTestId('booked-detail')).toContainText(number);
    await page.getByTestId('booked-open').click();
    await page.waitForURL(bookingUrl);

    // ── confirm without the advance (the owner may override, with a reason) ──────────────────────────
    await page.getByTestId('action-confirm').click();
    const confirm = page.getByTestId('dialog-confirm');
    await confirm.getByTestId('dialog-submit').click();
    // Without the advance and without the override, the API says so.
    await expect(page.getByText(m.Bookings.errors.advanceRequired)).toBeVisible();
    await confirm.getByTestId('dialog-override').check();
    await confirm.getByTestId('dialog-reason').fill('Family customer, pays on the day');
    await confirm.getByTestId('dialog-submit').click();
    await expect(page.getByTestId('booking-status')).toHaveText(m.Bookings.status.CONFIRMED);
    await expect(page.getByTestId('booking-timeline')).toContainText(
      m.Bookings.timeline.actions.booking_confirm,
    );
    await expect(page.getByTestId('booking-timeline')).toContainText(
      'Family customer, pays on the day',
    );

    await open(page, '/calendar');
    await showDate(page, day1);
    await expect(cell(page, day1)).toHaveAttribute('data-status', 'CONFIRMED');

    // ── cancel: the slots are free again ─────────────────────────────────────────────────────────────
    await open(page, bookingUrl.replace(/^https?:\/\/[^/]+/, ''));
    await page.getByTestId('action-cancel').click();
    const cancel = page.getByTestId('dialog-cancel');
    await cancel.getByTestId('dialog-reason').fill('Customer changed the date');
    await cancel.getByTestId('dialog-submit').click();
    await expect(page.getByTestId('booking-status')).toHaveText(m.Bookings.status.CANCELLED);
    await expect(page.getByTestId('booking-cancelled')).toContainText('Customer changed the date');

    await open(page, '/calendar');
    await showDate(page, day1);
    await expect(cell(page, day1)).toHaveAttribute('data-status', 'free');
    await expect(cell(page, day2)).toHaveAttribute('data-status', 'free');

    // The list finds it by status.
    await open(page, '/bookings');
    await page.getByTestId('bookings-status').selectOption('CANCELLED');
    await expect(page.getByTestId('booking-row').filter({ hasText: number })).toBeVisible();

    // ── quick hold from a free cell, then 360 px ─────────────────────────────────────────────────────
    await open(page, '/calendar');
    await showDate(page, day1);
    await cell(page, day1).click();
    const quick = page.getByTestId('quick-hold');
    await quick.getByTestId('customer-search').fill('Hina');
    await quick.getByTestId('customer-result').first().click();
    await quick.getByTestId('quick-hold-submit').click();
    await page.waitForURL(/\/bookings\/[a-z0-9]+$/);
    await expect(page.getByTestId('booking-status')).toHaveText(m.Bookings.status.TENTATIVE);

    await page.setViewportSize({ width: 360, height: 800 });
    await open(page, '/calendar');
    await expect(page.getByTestId('calendar-daylist')).toBeVisible();
    await expect(page.getByTestId('calendar-grid')).toHaveCount(0);
    await expectNoSidewaysScroll(page);
    await open(page, '/bookings');
    await expectNoSidewaysScroll(page);
    await open(page, bookingUrl.replace(/^https?:\/\/[^/]+/, ''));
    await expectNoSidewaysScroll(page);
    await open(page, '/quotations/new');
    await expectNoSidewaysScroll(page);
  });
});
