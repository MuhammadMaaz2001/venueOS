import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { uniqueEmail } from './support/mail';
import {
  MESSAGES,
  acceptNewInvite,
  cspViolations,
  invite,
  open,
  registerAndLogin,
} from './support/flows';

// Module 2: the owner copies "Sales agent", changes its permissions, invites a member with it, the member accepts,
// and the owner finds role.create, role.update and staff.invite in the audit log. Also the clear errors of the roles
// page (Owner lock-out, retiring a role that has members) and a 360 px check of both pages. Needs the whole stack
// and Mailpit running (see playwright.config.ts).

const m = MESSAGES.en;

const named = (template: string, name: string) => template.replace('{name}', name);

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

test.describe('roles and audit log', () => {
  test.beforeEach(() => {
    cspViolations.length = 0;
  });
  test.afterEach(() => {
    expect(cspViolations, 'the Content Security Policy blocked something').toEqual([]);
  });

  test('copy a role, edit it, invite with it, and read the trail in the audit log', async ({
    browser,
  }) => {
    const stamp = Date.now().toString(36);
    const owner = {
      name: 'Roles Owner',
      email: uniqueEmail('roles-owner'),
      tenantName: `Roles Halls ${stamp}`,
    };
    const member = { name: 'Front Desk Person', email: uniqueEmail('front-desk') };
    const roleName = `Front desk ${stamp}`;

    const { context, page } = await registerAndLogin(browser, 'en', owner);

    // ── navigation shows both pages to the owner ─────────────────────────────────────────────────────
    await expect(page.getByRole('link', { name: m.Shell.nav.roles })).toBeVisible();
    await expect(page.getByRole('link', { name: m.Shell.nav.audit })).toBeVisible();

    // ── system roles are named from the messages file ────────────────────────────────────────────────
    await open(page, '/roles');
    const list = page.getByTestId('role-list');
    for (const name of Object.values(m.Roles.system)) {
      await expect(list.getByTestId('role-name').filter({ hasText: name })).toHaveCount(1);
    }

    // ── copy "Sales agent": the editor opens on the copy ─────────────────────────────────────────────
    await page
      .getByRole('button', { name: named(m.Roles.row.copyNamed, m.Roles.system.sales_agent) })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(m.Roles.copy.name, { exact: true }).fill(roleName);
    await dialog.getByRole('button', { name: m.Roles.copy.submit }).click();
    const sheet = page.getByRole('dialog').filter({ hasText: named(m.Roles.edit.title, roleName) });
    await expect(sheet).toBeVisible();

    // ── edit the permissions: ticking "manage" also ticks "view" ─────────────────────────────────────
    const box = (permission: string) => sheet.locator(`input[data-permission="${permission}"]`);
    await expect(box('report.view')).not.toBeChecked();
    await box('report.view').check();
    await expect(box('customer.view')).toBeChecked();
    await expect(box('vendor.view')).toBeChecked();
    await expect(box('vendor.manage')).not.toBeChecked();
    await box('vendor.manage').check();
    await expect(box('vendor.view')).toBeChecked();
    await expect(box('vendor.view')).toBeDisabled(); // needed by vendor.manage
    await sheet.getByLabel(m.Roles.edit.maxDiscount).fill('7.5');
    await sheet.getByTestId('role-save').click();
    await expect(page.getByText(m.Roles.edit.saved)).toBeVisible();
    await page.keyboard.press('Escape');

    // ── the Owner role cannot lose role.manage: the reason is shown in the sheet ─────────────────────
    await page
      .getByRole('button', { name: named(m.Roles.row.editNamed, m.Roles.system.owner) })
      .click();
    const ownerSheet = page.getByRole('dialog');
    await ownerSheet.locator('input[data-permission="role.manage"]').uncheck();
    await ownerSheet.getByTestId('role-save').click();
    await expect(ownerSheet.getByTestId('role-error')).toContainText(m.Roles.errors.ownerLockout);
    await page.keyboard.press('Escape');

    // ── invite somebody with the new role; they accept ───────────────────────────────────────────────
    await invite(page, 'en', member.email, roleName);
    await acceptNewInvite(browser, 'en', member);

    // The role has a member now: it cannot be retired, and the page says why.
    await open(page, '/roles');
    await expect(page.getByTestId('role-row').filter({ hasText: roleName })).toContainText(
      '1 member',
    );
    await page.getByRole('button', { name: named(m.Roles.row.editNamed, roleName) }).click();
    await page.getByTestId('role-retire').click();
    await expect(page.getByTestId('role-error')).toContainText(m.Roles.errors.hasMembers);
    await page.keyboard.press('Escape');

    // ── the audit log shows what happened, in words, in order ────────────────────────────────────────
    await open(page, '/audit');
    const rows = page.getByTestId('audit-row');
    await expect(rows.first()).toBeVisible();
    for (const action of ['role.create', 'role.update', 'staff.invite']) {
      await expect(page.locator(`[data-testid="audit-row"][data-action="${action}"]`)).toHaveCount(
        1,
      );
    }
    await expect(
      page.locator('[data-testid="audit-row"][data-action="role.update"]'),
    ).toContainText(m.Audit.actions.role_update);

    // The filter narrows the list.
    await page.getByLabel(m.Audit.filters.action, { exact: true }).selectOption('role.create');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(m.Audit.actions.role_create);
    await page.getByRole('button', { name: m.Audit.filters.reset }).click();

    // The detail shows the before and after of the permission change.
    await page
      .locator('[data-testid="audit-row"][data-action="role.update"]')
      .getByRole('button', {
        name: m.Audit.openNamed.replace('{action}', m.Audit.actions.role_update),
      })
      .click();
    const diff = page.getByTestId('audit-diff');
    await expect(diff).toContainText('permissions');
    await expect(diff).toContainText('report.view');
    await expect(diff).toContainText('vendor.manage');
    await expect(diff).toContainText('7.5');
    await page.keyboard.press('Escape');

    // ── both pages fit a 360 px phone ────────────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page, '/audit');
    await expect(page.getByTestId('audit-row').first()).toBeVisible();
    await expectNoSidewaysScroll(page);
    await open(page, '/roles');
    await expect(page.getByTestId('role-row').first()).toBeVisible();
    await expectNoSidewaysScroll(page);

    await context.close();
  });
});
