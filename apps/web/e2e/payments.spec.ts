import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { uniqueEmail, waitForMails } from './support/mail';
import {
  MESSAGES,
  acceptNewInvite,
  cspViolations,
  invite,
  login,
  newContext,
  open,
  registerAndLogin,
} from './support/flows';

// Module 9: a held booking is paid in steps (token in cash, the advance by cheque that clears later), the agent confirms, the
// customer gets a receipt with the PDF, the booking is cancelled, and the refund goes through request (branch manager),
// approval and payment (accountant). Also the dashboard cards, receivables and a 360 px check. Needs the whole stack, Mailpit,
// the local S3 and a worker that can start Chromium (see playwright.config.ts).

const m = MESSAGES.en;
const money = (amount: string) => new RegExp(`PKR\\s*${amount.replace(/\./g, '\\.')}`);

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

function inDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function signedIn(page: Page): Promise<void> {
  await page.getByTestId('tenant-name').or(page.getByTestId('tenant-switcher')).first().waitFor();
}

test.describe('payments and receipts', () => {
  test.beforeEach(() => {
    cspViolations.length = 0;
  });
  test.afterEach(() => {
    expect(cspViolations, 'the Content Security Policy blocked something').toEqual([]);
  });

  test('hold -> token (cash) -> advance (cheque, cleared later) -> confirm -> receipts by email -> cancel -> refund requested, approved, paid', async ({
    browser,
  }) => {
    const stamp = Date.now().toString(36);
    const owner = {
      name: 'Pay Owner',
      email: uniqueEmail('pay-owner'),
      tenantName: `Pay Halls ${stamp}`,
    };
    const accountant = { name: 'Asma Accountant', email: uniqueEmail('pay-accountant') };
    const agent = { name: 'Bilal Agent', email: uniqueEmail('pay-agent') };
    const customerEmail = uniqueEmail('pay-customer');
    const { page: ownerPage } = await registerAndLogin(browser, 'en', owner);

    // ── set-up: a venue with Main Hall and Dinner (100,000), a token of 20,000 ─────────────────────────
    await ownerPage.waitForURL('**/setup');
    await ownerPage.locator('html[data-hydrated="true"]').waitFor();
    await ownerPage.getByLabel(m.Setup.fields.venueName, { exact: true }).fill(`Venue ${stamp}`);
    await ownerPage.getByRole('button', { name: m.Setup.wizard.venue.submit }).click();
    const spaceStep = ownerPage.getByTestId('wizard-step-spaces');
    await spaceStep.getByLabel(m.Setup.fields.spaceName, { exact: true }).fill('Main Hall');
    await spaceStep.getByRole('button', { name: m.Setup.wizard.spaces.addFirst }).click();
    await expect(ownerPage.getByTestId('wizard-space-list')).toContainText('Main Hall');
    await ownerPage.getByTestId('wizard-next').click();
    await ownerPage.getByTestId('preset-dinner').click();
    await expect(ownerPage.getByTestId('wizard-slot-list')).toContainText('Dinner');
    await ownerPage.getByTestId('wizard-next').click();
    await ownerPage.getByLabel('Dinner (19:00–23:30)', { exact: true }).fill('100000');
    await ownerPage.getByRole('button', { name: m.Setup.wizard.prices.save }).click();
    await expect(ownerPage.getByText(m.Setup.prices.saved)).toBeVisible();
    await ownerPage.getByTestId('wizard-next').click();
    await ownerPage.getByTestId('wizard-package-next').click(); // skip the package
    await ownerPage.getByTestId('wizard-finish').click();
    await ownerPage.waitForURL((url) => url.pathname === '/');

    await open(ownerPage, '/settings');
    await ownerPage.getByLabel('Token amount (PKR)', { exact: true }).fill('20000');
    await ownerPage.getByRole('button', { name: m.Setup.settings.save }).click();
    await expect(ownerPage.getByText(m.Setup.settings.saved)).toBeVisible();

    // The customer, with an email address for the receipts.
    await open(ownerPage, '/customers');
    await ownerPage.getByTestId('customer-add').click();
    const customerDialog = ownerPage.getByRole('dialog');
    await customerDialog.getByLabel(m.Customers.fields.name, { exact: true }).fill('Hina Malik');
    await customerDialog.getByLabel(m.Customers.fields.phone, { exact: true }).fill('0300 7654321');
    await customerDialog.getByLabel(m.Customers.fields.email, { exact: true }).fill(customerEmail);
    await customerDialog.getByRole('button', { name: m.Customers.form.create }).click();
    await expect(ownerPage.getByTestId('customer-list')).toContainText('Hina Malik');

    // An accountant and a branch manager (the agent) join.
    await invite(ownerPage, 'en', accountant.email, 'Accountant');
    await acceptNewInvite(browser, 'en', accountant);
    await invite(ownerPage, 'en', agent.email, 'Branch manager');
    await acceptNewInvite(browser, 'en', agent);

    // ── the agent quotes and holds ───────────────────────────────────────────────────────────────────
    const agentPage = await (await newContext(browser)).newPage();
    await login(agentPage, 'en', agent.email);
    await signedIn(agentPage);
    const eventDay = inDays(20);
    await open(agentPage, '/quotations/new');
    await agentPage.getByTestId('customer-search').fill('Hina');
    await agentPage.getByTestId('customer-result').first().click();
    const session = agentPage.getByTestId('session-editor').first();
    await session.getByTestId('session-space').selectOption({ label: 'Main Hall' });
    await session.getByTestId('session-date').fill(eventDay);
    await session.getByTestId('session-slot').selectOption({ label: 'Dinner (19:00–23:30)' });
    await session.getByTestId('session-guests').fill('200');
    await expect(agentPage.getByTestId('quote-grand-total')).toContainText(money('100,000.00'));
    await agentPage.getByTestId('builder-save').click();
    await agentPage.waitForURL(/\/bookings\/[a-z0-9]+$/);
    const bookingPath = new URL(agentPage.url()).pathname;
    await agentPage.getByTestId('action-hold').click();
    await agentPage.getByTestId('dialog-hold').getByTestId('dialog-submit').click();
    await expect(agentPage.getByTestId('booking-status')).toHaveText(m.Bookings.status.TENTATIVE);

    // ── the accountant sees the schedule the hold made, and records the token ────────────────────────
    const accountantContext = await newContext(browser);
    const accountantPage = await accountantContext.newPage();
    await login(accountantPage, 'en', accountant.email);
    await signedIn(accountantPage);
    await open(accountantPage, bookingPath);
    await accountantPage.getByTestId('tab-payments').click();
    const rows = accountantPage.getByTestId('schedule-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Token');
    await expect(rows.nth(0)).toContainText(money('20,000.00'));
    await expect(rows.nth(1)).toContainText('Advance');
    await expect(rows.nth(1)).toContainText(money('30,000.00'));
    await expect(rows.nth(2)).toContainText('Balance');
    await expect(rows.nth(2)).toContainText(money('50,000.00'));
    await expect(accountantPage.getByTestId('summary-paid')).toContainText(money('0.00'));

    await accountantPage.getByTestId('record-payment').click();
    const tokenForm = accountantPage.getByTestId('record-payment-form');
    await tokenForm.getByTestId('payment-method').selectOption('CASH');
    await tokenForm.getByTestId('payment-amount').fill('20000.00');
    await tokenForm.getByTestId('payment-submit').click();
    const cashRow = accountantPage.getByTestId('payment-row').filter({ hasText: 'Cash' });
    await expect(cashRow).toHaveAttribute('data-status', 'CLEARED');
    await expect(cashRow).toHaveAttribute('data-receipt', /^[A-Z]+-R-\d{4}-00001$/);
    await expect(accountantPage.getByTestId('summary-paid')).toContainText(money('20,000.00'));
    await expect(accountantPage.getByTestId('schedule-row').nth(0)).toHaveAttribute(
      'data-status',
      'PAID',
    );
    await expect(accountantPage.getByTestId('schedule-row').nth(1)).toHaveAttribute(
      'data-status',
      'UNPAID',
    );

    // The customer's receipt arrives with the PDF (the worker renders it first).
    const [firstReceipt] = await waitForMails(customerEmail, 'Receipt ', 1);
    expect(firstReceipt?.attachments).toHaveLength(1);
    expect(firstReceipt?.attachments[0]).toMatchObject({ contentType: 'application/pdf' });
    expect(firstReceipt?.text).toContain('PKR 20,000.00');
    await expect(cashRow.getByTestId('payment-receipt')).toBeEnabled({ timeout: 60_000 });

    // ── the advance by cheque: it does not count until it has cleared ────────────────────────────────
    await accountantPage.getByTestId('record-payment').click();
    const chequeForm = accountantPage.getByTestId('record-payment-form');
    await chequeForm.getByTestId('payment-method').selectOption('CHEQUE');
    await chequeForm.getByTestId('payment-amount').fill('30000.00');
    await chequeForm.getByTestId('payment-submit').click();
    // A cheque needs its number.
    await expect(chequeForm.getByText(m.Payments.record.referenceRequired)).toBeVisible();
    await chequeForm.getByTestId('payment-reference').fill('CH-5001');
    await chequeForm.getByTestId('payment-submit').click();
    const chequeRow = accountantPage.getByTestId('payment-row').filter({ hasText: 'CH-5001' });
    await expect(chequeRow).toHaveAttribute('data-status', 'PENDING');
    await expect(accountantPage.getByTestId('summary-paid')).toContainText(money('20,000.00'));
    await expect(accountantPage.getByTestId('summary-pending')).toContainText(money('30,000.00'));

    // The agent sees it is not ready to confirm yet, and confirming without the advance is refused.
    await open(agentPage, bookingPath);
    await agentPage.getByTestId('tab-payments').click();
    await expect(agentPage.getByTestId('ready-to-confirm')).toHaveCount(0);

    // The cheque clears: now the booking is ready to confirm (nothing confirms by itself).
    await chequeRow.getByTestId('payment-clear').click();
    await expect(chequeRow).toHaveAttribute('data-status', 'CLEARED');
    await expect(accountantPage.getByTestId('summary-paid')).toContainText(money('50,000.00'));
    await expect(accountantPage.getByTestId('summary-advance')).toContainText(
      m.Payments.summary.advanceIn,
    );
    await waitForMails(customerEmail, 'Receipt ', 2); // the cheque's receipt goes out when it clears

    await open(agentPage, bookingPath);
    await agentPage.getByTestId('tab-payments').click();
    await expect(agentPage.getByTestId('ready-to-confirm')).toBeVisible();
    await expect(agentPage.getByTestId('booking-status')).toHaveText(m.Bookings.status.TENTATIVE);
    await agentPage.getByTestId('ready-confirm').click();
    await agentPage.getByTestId('dialog-confirm').getByTestId('dialog-submit').click();
    await expect(agentPage.getByTestId('booking-status')).toHaveText(m.Bookings.status.CONFIRMED);
    await expect(agentPage.getByTestId('ready-to-confirm')).toHaveCount(0);

    // ── the accountant's dashboard and the receivables list: the balance is still owed ───────────────
    await open(accountantPage, '/');
    await expect(accountantPage.getByTestId('payments-card')).toBeVisible();
    await open(accountantPage, '/receivables');
    const receivable = accountantPage.getByTestId('receivable-row');
    await expect(receivable).toHaveCount(1);
    await expect(receivable).toContainText('Hina Malik');
    await expect(receivable).toContainText(money('50,000.00'));
    await expectNoSidewaysScroll(accountantPage);

    // ── a mistake is reversed, not edited ────────────────────────────────────────────────────────────
    await open(accountantPage, bookingPath);
    await accountantPage.getByTestId('tab-payments').click();
    await accountantPage.getByTestId('record-payment').click();
    const wrong = accountantPage.getByTestId('record-payment-form');
    await wrong.getByTestId('payment-amount').fill('1000.00');
    await wrong.getByTestId('payment-submit').click();
    const wrongRow = accountantPage
      .getByTestId('payment-row')
      .filter({ hasText: '1,000.00' })
      .filter({ hasText: 'Cash' });
    await expect(wrongRow).toHaveAttribute('data-status', 'CLEARED');
    await expect(accountantPage.getByTestId('summary-paid')).toContainText(money('51,000.00'));
    await wrongRow.getByTestId('payment-reverse').click();
    await accountantPage.getByTestId('reverse-reason').fill('Entered on the wrong booking');
    await accountantPage.getByTestId('reverse-submit').click();
    await expect(accountantPage.getByTestId('summary-paid')).toContainText(money('50,000.00'));
    await expect(
      accountantPage.getByTestId('payment-row').filter({ hasText: 'Entered on the wrong booking' }),
    ).toHaveAttribute('data-type', 'REVERSAL');
    await expect(wrongRow.getByTestId('payment-reverse')).toHaveCount(0); // once only

    // ── the agent cancels; the refund is requested ───────────────────────────────────────────────────
    await open(agentPage, bookingPath);
    await agentPage.getByTestId('action-cancel').click();
    await agentPage
      .getByTestId('dialog-cancel')
      .getByTestId('dialog-reason')
      .fill('The family moved the wedding');
    await agentPage.getByTestId('dialog-cancel').getByTestId('dialog-submit').click();
    await expect(agentPage.getByTestId('booking-status')).toHaveText(m.Bookings.status.CANCELLED);
    await agentPage.getByTestId('tab-payments').click();
    await agentPage.getByTestId('request-refund').click();
    const refundForm = agentPage.getByTestId('refund-request-form');
    await expect(refundForm.getByTestId('refund-suggested')).toBeVisible(); // the policy snapshot's suggestion
    await refundForm.getByTestId('refund-amount').fill('25000.00');
    await refundForm.getByTestId('refund-reason').fill('Refund of half of what was paid');
    await refundForm.getByTestId('refund-submit').click();
    await expect(agentPage.getByTestId('booking-refund')).toHaveAttribute(
      'data-status',
      'REQUESTED',
    );
    // The agent cannot decide: no refund queue actions without payment.refund.approve.
    await open(agentPage, '/refunds');
    await expect(agentPage.getByTestId('refund-approve')).toHaveCount(0);

    // ── the accountant approves and pays it out ──────────────────────────────────────────────────────
    await open(accountantPage, '/refunds');
    const refund = accountantPage
      .getByTestId('refund-row')
      .filter({ hasText: 'Refund of half of what was paid' });
    await expect(refund).toHaveAttribute('data-status', 'REQUESTED');
    await expect(refund).toContainText(agent.name);
    await refund.getByTestId('refund-approve').click();
    await accountantPage
      .getByTestId('refund-approve-form')
      .getByTestId('refund-decision-submit')
      .click();
    await accountantPage.getByTestId('refunds-status').selectOption('APPROVED');
    const approved = accountantPage
      .getByTestId('refund-row')
      .filter({ hasText: 'Refund of half of what was paid' });
    await expect(approved).toHaveAttribute('data-status', 'APPROVED');
    await approved.getByTestId('refund-pay').click();
    const payForm = accountantPage.getByTestId('refund-pay-form');
    await payForm.getByTestId('refund-method').selectOption('BANK_TRANSFER');
    await payForm.getByTestId('refund-decision-submit').click();
    await accountantPage.getByTestId('refunds-status').selectOption('PAID');
    await expect(
      accountantPage
        .getByTestId('refund-row')
        .filter({ hasText: 'Refund of half of what was paid' }),
    ).toHaveAttribute('data-status', 'PAID');

    // The booking shows the REFUND entry and the lower paid total.
    await open(accountantPage, bookingPath);
    await accountantPage.getByTestId('tab-payments').click();
    const refundEntry = accountantPage
      .getByTestId('payment-row')
      .filter({ has: accountantPage.locator('[data-testid="payment-status"]') })
      .filter({ hasText: 'Refund' });
    await expect(refundEntry).toHaveAttribute('data-type', 'REFUND');
    await expect(refundEntry).toHaveAttribute('data-status', 'CLEARED');
    await expect(accountantPage.getByTestId('summary-paid')).toContainText(money('25,000.00'));
    await expect(accountantPage.getByTestId('booking-refund')).toHaveAttribute(
      'data-status',
      'PAID',
    );

    // ── the booking history keeps every money step; 360 px ───────────────────────────────────────────
    await accountantPage.getByTestId('tab-details').click();
    const history = accountantPage.getByTestId('booking-timeline');
    for (const action of [
      'payment_record',
      'payment_clear',
      'payment_reverse',
      'refund_request',
      'refund_approve',
      'refund_pay',
    ]) {
      await expect(history).toContainText(
        m.Bookings.timeline.actions[action as keyof typeof m.Bookings.timeline.actions],
      );
    }
    await accountantPage.setViewportSize({ width: 360, height: 800 });
    for (const path of [bookingPath, '/refunds', '/receivables', '/']) {
      await open(accountantPage, path);
      if (path === bookingPath) await accountantPage.getByTestId('tab-payments').click();
      await expectNoSidewaysScroll(accountantPage);
    }
  });
});
