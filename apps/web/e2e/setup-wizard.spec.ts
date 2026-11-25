import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { uniqueEmail } from './support/mail';
import {
  MESSAGES,
  cspViolations,
  login,
  newContext,
  open,
  signup,
  verifyEmail,
} from './support/flows';

// Module 1: signup -> first login lands in the setup wizard -> venue -> space -> Lunch/Dinner slots -> price ->
// done -> the venue pages show it. Runs on a 360 px phone screen: the wizard must be usable there, and no page may
// scroll sideways. Needs the whole stack and Mailpit running (see playwright.config.ts).

const m = MESSAGES.en;

/** No horizontal scrollbar: nothing is wider than the 360 px screen. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

test.describe('setup wizard (360 px)', () => {
  test.beforeEach(() => {
    cspViolations.length = 0;
  });
  test.afterEach(() => {
    expect(cspViolations, 'the Content Security Policy blocked something').toEqual([]);
  });

  test('signup, wizard, first venue with Lunch and Dinner slots', async ({ browser }) => {
    const stamp = Date.now().toString(36);
    const person = {
      name: 'Setup Owner',
      email: uniqueEmail('setup-owner'),
      tenantName: `Setup Halls ${stamp}`,
    };
    const venueName = `Royal Marquee ${stamp}`;

    const context = await newContext(browser, { width: 360, height: 740 });
    const page = await context.newPage();
    await signup(page, 'en', person);
    await verifyEmail(page, 'en', person.email);
    await login(page, 'en', person.email);

    // ── a workspace without a venue goes straight to the wizard ───────────────────────────────────────
    await page.waitForURL('**/setup');
    await page.locator('html[data-hydrated="true"]').waitFor();
    const wizard = page.getByTestId('wizard');
    await expect(wizard.getByRole('heading', { level: 1 })).toHaveText(m.Setup.wizard.title);
    await expect(page.getByTestId('wizard-step-venue')).toBeVisible();
    await expectNoSidewaysScroll(page);

    // Step 1: the venue
    await page.getByLabel(m.Setup.fields.venueName, { exact: true }).fill(venueName);
    await page.getByLabel(m.Setup.fields.city, { exact: true }).fill('Lahore');
    await page.getByRole('button', { name: m.Setup.wizard.venue.submit }).click();

    // Step 2: a space (the form shows the validation message for an empty name first)
    const spaceStep = page.getByTestId('wizard-step-spaces');
    await expect(spaceStep).toBeVisible();
    await expect(page.getByTestId('wizard-next')).toBeDisabled();
    await spaceStep.getByRole('button', { name: m.Setup.wizard.spaces.addFirst }).click();
    await expect(spaceStep.getByText(m.Validation.required)).toBeVisible();
    await spaceStep.getByLabel(m.Setup.fields.spaceName, { exact: true }).fill('Main Hall');
    await spaceStep.getByLabel(m.Setup.fields.capacitySeated, { exact: true }).fill('500');
    await spaceStep.getByRole('button', { name: m.Setup.wizard.spaces.addFirst }).click();
    await expect(page.getByTestId('wizard-space-list')).toContainText('Main Hall');
    await expectNoSidewaysScroll(page);
    await page.getByTestId('wizard-next').click();

    // Step 3: Lunch and Dinner in one tap each
    await expect(page.getByTestId('wizard-step-slots')).toBeVisible();
    await expect(page.getByTestId('wizard-next')).toBeDisabled();
    await page.getByTestId('preset-lunch').click();
    await expect(page.getByTestId('wizard-slot-list')).toContainText('Lunch');
    await page.getByTestId('preset-dinner').click();
    const slotList = page.getByTestId('wizard-slot-list');
    await expect(slotList).toContainText('Dinner');
    await expect(slotList).toContainText('12:00–16:00');
    await expect(slotList).toContainText('19:00–23:30');
    await expectNoSidewaysScroll(page);
    await page.getByTestId('wizard-next').click();

    // Step 4: a price for Lunch, none for Dinner
    await expect(page.getByTestId('wizard-step-prices')).toBeVisible();
    await page.getByLabel('Lunch (12:00–16:00)', { exact: true }).fill('150000');
    await page.getByRole('button', { name: m.Setup.wizard.prices.save }).click();
    await expect(page.getByText(m.Setup.prices.saved)).toBeVisible();
    await page.getByTestId('wizard-next').click();

    // Step 5 (optional): the first package. Skipped here; catalogue-pricing.spec.ts adds one.
    await expect(page.getByTestId('wizard-step-package')).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.getByTestId('wizard-package-next').click();

    // Done
    await expect(page.getByTestId('wizard-step-done')).toBeVisible();
    await page.getByTestId('wizard-finish').click();
    await page.waitForURL((url) => url.pathname === '/');
    // The wizard does not come back: the workspace has a venue now.
    await expect(page.getByRole('heading', { level: 1 })).toContainText(person.name);
    await expect(page).not.toHaveURL(/setup/);

    // ── the venue pages show what was set up ──────────────────────────────────────────────────────────
    await open(page, '/venues');
    const row = page.getByTestId('venue-row').filter({ hasText: venueName });
    await expect(row).toBeVisible();
    await expectNoSidewaysScroll(page);
    await row.getByRole('link').click();

    await expect(page.getByRole('heading', { level: 1 })).toContainText(venueName);
    await expect(page.getByTestId('space-list')).toContainText('Main Hall');
    const slots = page.getByTestId('slot-row');
    await expect(slots).toHaveCount(2);
    await expect(slots.filter({ hasText: 'Lunch' })).toContainText('12:00–16:00');
    await expect(slots.filter({ hasText: 'Dinner' })).toContainText('19:00–23:30');
    await expectNoSidewaysScroll(page);

    // The price of Lunch was saved, in the workspace currency with its decimals.
    await page
      .getByTestId('space-row')
      .getByRole('button', { name: m.Setup.spaces.prices })
      .click();
    await expect(page.getByLabel('Lunch (12:00–16:00)', { exact: true })).toHaveValue('150000.00');

    // Settings page is reachable for the Owner and shows the defaults.
    await page.keyboard.press('Escape');
    await open(page, '/settings');
    await expect(page.getByTestId('settings-form')).toBeVisible();
    await expect(page.getByLabel(m.Setup.settings.fields.holdHours, { exact: true })).toHaveValue(
      '48',
    );
    await expectNoSidewaysScroll(page);

    await context.close();
  });
});
