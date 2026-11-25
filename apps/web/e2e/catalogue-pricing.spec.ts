import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { uniqueEmail } from './support/mail';
import { MESSAGES, cspViolations, open, registerAndLogin } from './support/flows';

// Module 3: the owner sets up a venue with the wizard (including the optional first package), then adds a menu
// item, a package with that dish, an add-on, a weekend +20% rule and a January season override, and the rent preview
// shows the right totals for four days. Also a tax rate, a cancellation policy with tiers and a custom field, and a
// 360 px check of both pages. Needs the whole stack and Mailpit running (see playwright.config.ts).

const m = MESSAGES.en;

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

/** Money as the page writes it: the currency code, a (non-breaking) space, grouped digits, 2 decimals. */
const pkr = (amount: string) => new RegExp(`PKR\\s*${amount.replace('.', '\\.')}`);

test.describe('catalogue and pricing', () => {
  test.beforeEach(() => {
    cspViolations.length = 0;
  });
  test.afterEach(() => {
    expect(cspViolations, 'the Content Security Policy blocked something').toEqual([]);
  });

  test('menu item, package, add-on, price rules and the rent preview', async ({ browser }) => {
    const stamp = Date.now().toString(36);
    const owner = {
      name: 'Catalogue Owner',
      email: uniqueEmail('catalogue-owner'),
      tenantName: `Catalogue Halls ${stamp}`,
    };
    const { context, page } = await registerAndLogin(browser, 'en', owner);

    // ── the wizard: a venue with a space and slots, a rent for Dinner, and the optional first package ───
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

    // The package step is skippable: with nothing added, the button says so.
    const packageStep = page.getByTestId('wizard-step-package');
    await expect(packageStep).toBeVisible();
    await expect(page.getByTestId('wizard-package-next')).toHaveText(m.Setup.wizard.package.skip);
    await packageStep.getByLabel(m.Catalogue.packages.name, { exact: true }).fill('Starter menu');
    await packageStep.getByLabel(m.Catalogue.packages.perHeadRate, { exact: true }).fill('1200');
    await packageStep.getByLabel(m.Catalogue.packages.minGuests, { exact: true }).fill('100');
    await packageStep.getByRole('button', { name: m.Setup.wizard.package.addFirst }).click();
    await expect(page.getByTestId('wizard-package-list')).toContainText('Starter menu');
    await expect(page.getByTestId('wizard-package-next')).toHaveText(m.Setup.wizard.package.next);
    await page.getByTestId('wizard-package-next').click();
    await expect(page.getByTestId('wizard-step-done')).toBeVisible();
    await page.getByTestId('wizard-finish').click();
    await page.waitForURL((url) => url.pathname === '/');

    // ── the navigation shows both new pages ──────────────────────────────────────────────────────────
    await expect(page.getByRole('link', { name: m.Shell.nav.catalogue })).toBeVisible();
    await expect(page.getByRole('link', { name: m.Shell.nav.pricing })).toBeVisible();

    // ── catalogue: a menu item ───────────────────────────────────────────────────────────────────────
    await open(page, '/catalogue');
    await page.getByTestId('menu-item-add').click();
    const dishDialog = page.getByRole('dialog');
    await dishDialog.getByLabel(m.Catalogue.menuItems.name, { exact: true }).fill('Chicken karahi');
    await dishDialog.getByLabel(m.Catalogue.menuItems.category, { exact: true }).fill('Main');
    await dishDialog.getByRole('button', { name: m.Catalogue.menuItems.create }).click();
    await expect(page.getByTestId('menu-item-list')).toContainText('Chicken karahi');
    await expect(
      page.getByTestId('menu-item-row').filter({ hasText: 'Chicken karahi' }),
    ).toContainText('Main');

    // The same name again is refused with its own message.
    await page.getByTestId('menu-item-add').click();
    await page
      .getByRole('dialog')
      .getByLabel(m.Catalogue.menuItems.name, { exact: true })
      .fill('chicken KARAHI');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: m.Catalogue.menuItems.create })
      .click();
    await expect(page.getByText(m.Catalogue.errors.duplicate)).toBeVisible();
    await page.keyboard.press('Escape');

    // ── catalogue: a package with that dish ──────────────────────────────────────────────────────────
    await page.getByTestId('tab-packages').click();
    await expect(page.getByTestId('package-list')).toContainText('Starter menu');
    await page.getByTestId('package-add').click();
    const packageDialog = page.getByRole('dialog');
    await packageDialog.getByLabel(m.Catalogue.packages.name, { exact: true }).fill('Gold menu');
    await packageDialog.getByLabel(m.Catalogue.packages.perHeadRate, { exact: true }).fill('1500');
    await packageDialog.getByLabel(m.Catalogue.packages.minGuests, { exact: true }).fill('150');
    await packageDialog.getByTestId('dish-picker').getByText('Chicken karahi').click();
    await packageDialog.getByRole('button', { name: m.Catalogue.packages.create }).click();
    const goldRow = page.getByTestId('package-row').filter({ hasText: 'Gold menu' });
    await expect(goldRow).toBeVisible();
    await expect(goldRow.getByTestId('package-rate')).toContainText(pkr('1,500.00'));
    await expect(goldRow).toContainText('1');
    await expectNoSidewaysScroll(page);

    // ── catalogue: an add-on ─────────────────────────────────────────────────────────────────────────
    await page.getByTestId('tab-addOns').click();
    await page.getByTestId('add-on-add').click();
    const addOnDialog = page.getByRole('dialog');
    await addOnDialog.getByLabel(m.Catalogue.addOns.name, { exact: true }).fill('DJ');
    await addOnDialog
      .getByLabel(m.Catalogue.addOns.pricing, { exact: true })
      .selectOption({ label: m.Catalogue.addOns.pricings.PER_HOUR });
    await addOnDialog.getByLabel(m.Catalogue.addOns.price, { exact: true }).fill('5000');
    await addOnDialog.getByRole('button', { name: m.Catalogue.addOns.create }).click();
    const djRow = page.getByTestId('add-on-row').filter({ hasText: 'DJ' });
    await expect(djRow.getByTestId('add-on-price')).toContainText(pkr('5,000.00'));
    await expect(djRow.getByTestId('add-on-price')).toContainText('per hour');

    // ── pricing: a weekend +20% rule and a January season that overrides the rent ────────────────────
    await open(page, '/pricing');
    await page.getByTestId('price-rule-add').click();
    let rule = page.getByRole('dialog');
    await rule.getByLabel(m.Pricing.rules.name, { exact: true }).fill('Weekend');
    await rule.getByTestId('rule-day-5').check();
    await rule.getByTestId('rule-day-6').check();
    await rule.getByTestId('rule-value').fill('20');
    await rule.getByLabel(m.Pricing.rules.priority, { exact: true }).fill('1');
    await rule.getByRole('button', { name: m.Pricing.rules.create }).click();
    const weekendRow = page.getByTestId('price-rule-row').filter({ hasText: 'Weekend' });
    await expect(weekendRow.getByTestId('rule-effect')).toHaveText('+20%');

    await page.getByTestId('price-rule-add').click();
    rule = page.getByRole('dialog');
    await rule.getByLabel(m.Pricing.rules.name, { exact: true }).fill('January season');
    await rule.getByTestId('rule-kind').selectOption('DATE_RANGE');
    await rule.getByTestId('rule-start').fill('2027-01-01');
    await rule.getByTestId('rule-end').fill('2027-01-31');
    await rule.getByTestId('rule-adjustment').selectOption('OVERRIDE');
    await rule.getByTestId('rule-value').fill('150000');
    await rule.getByLabel(m.Pricing.rules.priority, { exact: true }).fill('5');
    await rule.getByRole('button', { name: m.Pricing.rules.create }).click();
    const seasonRow = page.getByTestId('price-rule-row').filter({ hasText: 'January season' });
    await expect(seasonRow.getByTestId('rule-effect')).toContainText(pkr('150,000.00'));
    await expectNoSidewaysScroll(page);

    // A season that ends before it starts is refused on the form.
    await page.getByTestId('price-rule-add').click();
    rule = page.getByRole('dialog');
    await rule.getByLabel(m.Pricing.rules.name, { exact: true }).fill('Backwards');
    await rule.getByTestId('rule-kind').selectOption('DATE_RANGE');
    await rule.getByTestId('rule-start').fill('2027-03-01');
    await rule.getByTestId('rule-end').fill('2027-02-01');
    await rule.getByTestId('rule-value').fill('10');
    await rule.getByRole('button', { name: m.Pricing.rules.create }).click();
    await expect(rule.getByText(m.Validation.invalid)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('price-rule-row')).toHaveCount(2);

    // ── the rent preview: the totals for four days ───────────────────────────────────────────────────
    const preview = page.getByTestId('rent-preview');
    await preview.getByTestId('preview-space').selectOption({ label: 'Main Hall' });
    await preview.getByTestId('preview-slot').selectOption({ label: 'Dinner' });
    const finalFor = async (date: string) => {
      await preview.getByTestId('preview-date').fill(date);
      return preview.getByTestId('preview-final');
    };
    // Saturday 2 January: the season replaces 100,000 with 150,000, then the weekend adds 20%.
    await expect(await finalFor('2027-01-02')).toContainText(pkr('180,000.00'));
    await expect(preview.getByTestId('preview-base')).toContainText(pkr('100,000.00'));
    await expect(preview.getByTestId('preview-adjustment')).toHaveCount(2);
    // Monday 4 January: the season only.
    await expect(await finalFor('2027-01-04')).toContainText(pkr('150,000.00'));
    await expect(preview.getByTestId('preview-adjustment')).toHaveCount(1);
    // Saturday 6 February: the weekend only. Monday 1 February: no rule.
    await expect(await finalFor('2027-02-06')).toContainText(pkr('120,000.00'));
    await expect(await finalFor('2027-02-01')).toContainText(pkr('100,000.00'));
    await expect(preview.getByTestId('preview-adjustment')).toHaveCount(0);
    // Lunch has no rent of its own and the space has no base rent: the preview says so.
    await preview.getByTestId('preview-slot').selectOption({ label: 'Lunch' });
    await expect(preview.getByTestId('preview-error')).toContainText(m.Pricing.preview.noRent);
    await expectNoSidewaysScroll(page);

    // ── pricing: a tax rate ──────────────────────────────────────────────────────────────────────────
    await page.getByTestId('tab-taxRates').click();
    await page.getByTestId('tax-rate-add').click();
    const tax = page.getByRole('dialog');
    await tax.getByLabel(m.Pricing.tax.name, { exact: true }).fill('GST');
    await tax.getByLabel(m.Pricing.tax.ratePct, { exact: true }).fill('16');
    await tax.getByLabel(m.Pricing.tax.makeDefault, { exact: true }).check();
    await tax.getByRole('button', { name: m.Pricing.tax.create }).click();
    const gst = page.getByTestId('tax-rate-row').filter({ hasText: 'GST' });
    await expect(gst).toContainText('16.00%');
    await expect(gst).toContainText(m.Pricing.tax.default);
    await expect(gst).toContainText(m.Pricing.tax.exclusive);

    // ── pricing: a cancellation policy with tiers ────────────────────────────────────────────────────
    await page.getByTestId('tab-policies').click();
    await page.getByTestId('policy-add').click();
    const policy = page.getByRole('dialog');
    await policy.getByLabel(m.Pricing.policies.name, { exact: true }).fill('Standard');
    // The starter row is "0 days, 0%". Add the two longer tiers, out of order, and let "put in order" fix it.
    await policy.getByTestId('tier-add').click();
    await policy.getByTestId('tier-days-1').fill('30');
    await policy.getByTestId('tier-pct-1').fill('50');
    await policy.getByTestId('tier-add').click();
    await policy.getByTestId('tier-days-2').fill('60');
    await policy.getByTestId('tier-pct-2').fill('80');
    await expect(policy.getByTestId('tier-problem')).toContainText(
      m.Pricing.policies.problems.order,
    );
    await policy.getByRole('button', { name: m.Pricing.policies.sortTiers }).click();
    await expect(policy.getByTestId('tier-problem')).toHaveCount(0);
    await policy.getByRole('button', { name: m.Pricing.policies.create }).click();
    const standard = page.getByTestId('policy-row').filter({ hasText: 'Standard' });
    await expect(standard).toContainText('60+ days: 80%');
    await expect(standard).toContainText('30+ days: 50%');

    // ── pricing: a custom field ──────────────────────────────────────────────────────────────────────
    await page.getByTestId('tab-customFields').click();
    await page.getByTestId('custom-field-add').click();
    const field = page.getByRole('dialog');
    await field.getByLabel(m.Pricing.fields.label, { exact: true }).fill('Family name');
    await expect(field.getByLabel(m.Pricing.fields.key, { exact: true })).toHaveValue(
      'family_name',
    );
    await field.getByRole('button', { name: m.Pricing.fields.create }).click();
    const fieldRow = page.getByTestId('custom-field-row').filter({ hasText: 'Family name' });
    await expect(fieldRow).toContainText('family_name');
    await expect(fieldRow).toContainText(m.Pricing.fields.types.text);
    await expectNoSidewaysScroll(page);

    // ── both pages are usable on a 360 px phone ──────────────────────────────────────────────────────
    await page.setViewportSize({ width: 360, height: 740 });
    for (const path of ['/catalogue', '/pricing']) {
      await open(page, path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoSidewaysScroll(page);
    }
    await page.getByTestId('price-rule-add').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoSidewaysScroll(page);

    await context.close();
  });
});
