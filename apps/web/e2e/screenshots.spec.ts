import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { uniqueEmail } from './support/mail';
import {
  MESSAGES,
  acceptNewInvite,
  invite,
  login,
  newContext,
  open,
  registerAndLogin,
} from './support/flows';

// Screenshots for the P0-7 report: login, the dashboard shell and the staff page, in English and Urdu, on a
// desktop (1280 px) and a phone (360 px). Opt-in (`pnpm --filter @venueos/web e2e:screenshots`); the pictures go to
// e2e/.screenshots (not committed) or E2E_SCREENSHOT_DIR.
const OUT = process.env.E2E_SCREENSHOT_DIR ?? path.resolve(__dirname, '.screenshots');

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 360, height: 740 },
} as const;

/** "Every page usable at 360 px": nothing may make the page wider than the screen. */
async function expectFitsWidth(page: Page, width: number): Promise<void> {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `${page.url()} is wider than ${width}px`).toBeLessThanOrEqual(width);
}

for (const locale of ['en', 'ur'] as const) {
  test(`report screenshots (${locale})`, async ({ browser }) => {
    const m = MESSAGES[locale];
    const stamp = Date.now().toString(36);
    const owner = {
      name: locale === 'ur' ? 'احمد علی' : 'Ahmed Ali',
      email: uniqueEmail('shots'),
      tenantName: locale === 'ur' ? `رائل ہال ${stamp}` : `Royal Hall ${stamp}`,
    };

    // Data: the owner, one accepted member and one pending invitation.
    const { context: setup, page } = await registerAndLogin(browser, locale, owner);
    const member = {
      name: locale === 'ur' ? 'سارہ خان' : 'Sara Khan',
      email: uniqueEmail('member'),
    };
    await invite(page, locale, member.email, 'Sales agent');
    await acceptNewInvite(browser, locale, member);
    await invite(page, locale, uniqueEmail('pending'), 'Accountant');
    await setup.close();

    for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
      const shot = (name: string) => path.join(OUT, `${locale}-${viewportName}-${name}.png`);

      // Login (logged out).
      const anonymous = await newContext(browser, locale, viewport);
      const loginPage = await anonymous.newPage();
      await open(loginPage, '/login');
      await expectFitsWidth(loginPage, viewport.width);
      await loginPage.screenshot({ path: shot('login'), fullPage: true });
      await anonymous.close();

      // Dashboard shell and staff page (logged in).
      const context = await newContext(browser, locale, viewport);
      const shell = await context.newPage();
      await login(shell, locale, owner.email);
      await shell.getByTestId('tenant-name').waitFor();
      await shell.getByRole('heading', { level: 1 }).waitFor();
      await expectFitsWidth(shell, viewport.width);
      await shell.screenshot({ path: shot('dashboard'), fullPage: true });

      if (viewportName === 'phone') {
        await shell.getByRole('button', { name: m.Shell.openMenu }).click();
        await shell.getByRole('dialog').waitFor();
        await shell.waitForTimeout(400); // the sheet slides in
        await shell.screenshot({ path: shot('menu') });
        await shell.keyboard.press('Escape');
      }

      await open(shell, '/staff');
      await shell.getByTestId('staff-row').first().waitFor();
      await shell.getByTestId('invitation-row').first().waitFor();
      await expectFitsWidth(shell, viewport.width);
      await shell.screenshot({ path: shot('staff'), fullPage: true });

      await shell.getByTestId('invite-open').click();
      await shell.getByRole('dialog').waitFor();
      await shell.waitForTimeout(300);
      await expectFitsWidth(shell, viewport.width);
      await shell.screenshot({ path: shot('invite-dialog') });
      await context.close();
    }
  });
}
