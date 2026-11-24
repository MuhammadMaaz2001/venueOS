import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { LINK, linkFromMail, uniqueEmail } from './support/mail';
import {
  MESSAGES,
  PASSWORD,
  cspViolations,
  invite,
  login,
  newContext,
  open,
  registerAndLogin,
  signup,
  verifyEmail,
} from './support/flows';

// signup -> verify (link from Mailpit) -> login -> switch workspace -> invite -> accept -> logout, in English (the
// MVP's only language; a language added later is one more entry in the loop below). Needs the whole stack and Mailpit running (see playwright.config.ts).

/** The message boxes of the page (Next's route announcer is also role=alert, so select by slot). */
const alertOf = (page: Page) => page.locator('[data-slot="alert"]');

for (const locale of ['en'] as const) {
  test.describe(`owner journey (${locale})`, () => {
    const m = MESSAGES[locale];

    test.beforeEach(() => {
      cspViolations.length = 0;
    });
    test.afterEach(() => {
      expect(cspViolations, 'the Content Security Policy blocked something').toEqual([]);
    });

    test('signup, verify once, login, invite, accept as new and existing user, switch workspace, logout', async ({
      browser,
    }) => {
      const stamp = Date.now().toString(36);
      const ownerA = {
        name: 'Owner A',
        email: uniqueEmail('owner-a'),
        tenantName: `Alpha Halls ${stamp}`,
      };
      const ownerB = {
        name: 'Owner B',
        email: uniqueEmail('owner-b'),
        tenantName: `Beta Banquets ${stamp}`,
      };

      // ── A signs up, confirms the address (one POST for the token), logs in ─────────────────────────
      const contextA = await newContext(browser);
      const pageA = await contextA.newPage();
      await signup(pageA, locale, ownerA);

      // Logging in before confirming is answered with the "confirm your email" screen, not an error.
      await login(pageA, locale, ownerA.email);
      await expect(
        pageA.getByRole('heading', { name: m.Auth.login.unverifiedTitle }),
      ).toBeVisible();

      const posts = await verifyEmail(pageA, locale, ownerA.email);
      expect(posts, 'the token is sent exactly once, also under StrictMode in development').toBe(1);
      // The token is gone from the address bar.
      expect(new URL(pageA.url()).search).toBe('');

      await login(pageA, locale, ownerA.email);
      await expect(pageA.getByTestId('tenant-name')).toHaveText(ownerA.tenantName);
      await expect(pageA.getByRole('heading', { level: 1 })).toContainText(ownerA.name);
      expect(await pageA.locator('html').getAttribute('dir')).toBe('ltr');

      // ── A invites a NEW person; they accept and log in ──────────────────────────────────────────────
      const newcomer = { name: 'Sales Newcomer', email: uniqueEmail('newcomer') };
      await invite(pageA, locale, newcomer.email, 'Sales agent');

      const contextC = await newContext(browser);
      const pageC = await contextC.newPage();
      const inviteLink = await linkFromMail(newcomer.email, LINK.invite);
      await open(pageC, inviteLink);
      expect(new URL(pageC.url()).search, 'the token leaves the address bar').toBe('');
      await pageC.getByLabel(m.Auth.fields.name, { exact: true }).fill(newcomer.name);
      await pageC.getByLabel(m.Auth.fields.newPassword, { exact: true }).fill(PASSWORD);
      await pageC.getByRole('button', { name: m.Auth.invite.submit }).click();
      await expect(pageC.getByRole('heading', { name: m.Auth.invite.doneTitle })).toBeVisible();
      await login(pageC, locale, newcomer.email);
      await expect(pageC.getByTestId('tenant-name')).toHaveText(ownerA.tenantName);
      // A sales agent cannot manage staff: no entry in the navigation, and the page says so.
      await expect(pageC.getByRole('link', { name: m.Shell.nav.staff })).toHaveCount(0);
      await open(pageC, '/staff');
      await expect(alertOf(pageC)).toContainText(m.Staff.noAccess);
      await contextC.close();

      // The new member now shows in A's staff list.
      await open(pageA, '/staff');
      await expect(pageA.getByTestId('staff-list')).toContainText(newcomer.name);

      // ── The last Owner cannot be switched off: the reason is explained in the dialog ────────────────
      await pageA
        .getByRole('button', { name: m.Staff.members.editNamed.replace('{name}', ownerA.name) })
        .click();
      const dialog = pageA.getByRole('dialog');
      await dialog.getByLabel(m.Staff.edit.active, { exact: true }).uncheck();
      await dialog.getByRole('button', { name: m.Staff.edit.save }).click();
      await expect(dialog.getByTestId('edit-error')).toContainText(m.Staff.errors.lastOwner);
      await pageA.keyboard.press('Escape');

      // ── B signs up in another workspace and invites A's existing account ─────────────────────────────
      const { context: contextB, page: pageB } = await registerAndLogin(browser, locale, ownerB);
      await invite(pageB, locale, ownerA.email, 'Accountant');

      // A (logged in, own workspace) opens the link: accept with the account that is logged in.
      const existingLink = await linkFromMail(ownerA.email, LINK.invite);
      await open(pageA, existingLink);
      await expect(pageA.getByRole('heading', { name: m.Auth.invite.memberTitle })).toBeVisible();
      await pageA.getByRole('button', { name: m.Auth.invite.accept }).click();

      // Accepting switches to the new workspace.
      await expect(pageA.getByTestId('tenant-switcher')).toContainText(ownerB.tenantName);

      // ── Switch back to A's workspace with the switcher ─────────────────────────────────────────────
      await pageA.getByTestId('tenant-switcher').click();
      await pageA.getByRole('menuitem', { name: ownerA.tenantName }).click();
      await expect(pageA.getByTestId('tenant-switcher')).toContainText(ownerA.tenantName);
      await expect(pageA.getByRole('link', { name: m.Shell.nav.staff })).toBeVisible();

      // ── Logout, and the app is closed again ────────────────────────────────────────────────────────
      await pageA.getByTestId('user-menu').click();
      await pageA.getByTestId('logout').click();
      await expect(pageA).toHaveURL(/\/login/);
      await open(pageA, '/staff');
      await expect(pageA).toHaveURL(/\/login\?next=%2Fstaff/);

      // A now belongs to two workspaces: logging in asks which one, then goes on to the page they wanted.
      await pageA.getByLabel(m.Auth.fields.email, { exact: true }).fill(ownerA.email);
      await pageA.getByLabel(m.Auth.fields.password, { exact: true }).fill(PASSWORD);
      await pageA.getByRole('button', { name: m.Auth.login.submit }).click();
      await expect(pageA.getByRole('heading', { name: m.Auth.workspace.title })).toBeVisible();
      await pageA.getByRole('button', { name: ownerB.tenantName }).click();
      await expect(pageA.getByTestId('tenant-switcher')).toContainText(ownerB.tenantName);
      await expect(pageA).toHaveURL(/\/staff$/);

      await contextA.close();
      await contextB.close();
    });

    test('a wrong password and an unknown address get the same message; a bad link is explained', async ({
      browser,
    }) => {
      const context = await newContext(browser);
      const page = await context.newPage();

      await open(page, '/login');
      await page.getByLabel(m.Auth.fields.email, { exact: true }).fill(uniqueEmail('nobody'));
      await page
        .getByLabel(m.Auth.fields.password, { exact: true })
        .fill('not the password at all');
      await page.getByRole('button', { name: m.Auth.login.submit }).click();
      await expect(alertOf(page)).toContainText(m.Auth.login.invalidCredentials);

      // Forgot password answers the same way for any address.
      await open(page, '/forgot-password');
      await page.getByLabel(m.Auth.fields.email, { exact: true }).fill(uniqueEmail('nobody'));
      await page.getByRole('button', { name: m.Auth.forgot.submit }).click();
      await expect(page.getByRole('heading', { name: m.Auth.inbox.title })).toBeVisible();

      // A token that never existed.
      await open(page, `/verify-email?token=${'x'.repeat(43)}`);
      await expect(page.getByRole('heading', { name: m.Auth.verify.failedTitle })).toBeVisible();
      await expect(page.getByText(m.Auth.token.invalid)).toBeVisible();

      await context.close();
    });
  });
}
