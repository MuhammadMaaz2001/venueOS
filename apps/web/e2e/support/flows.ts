import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import en from '../../src/messages/en.json';
import ur from '../../src/messages/ur.json';
import { LINK, linkFromMail } from './mail';

export const PASSWORD = 'correct horse battery staple 42';

export type Locale = 'en' | 'ur';
export const MESSAGES = { en, ur } as const;

/** Console messages about a blocked resource (Content Security Policy): the journeys must produce none. */
export const cspViolations: string[] = [];

/** A browser context that speaks `locale` (the app reads it from the NEXT_LOCALE cookie). */
export async function newContext(
  browser: Browser,
  locale: Locale,
  viewport?: { width: number; height: number },
): Promise<BrowserContext> {
  const context = await browser.newContext(viewport ? { viewport } : {});
  await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3000' }]);
  context.on('console', (message) => {
    if (/content[- ]security[- ]policy/i.test(message.text())) cspViolations.push(message.text());
  });
  return context;
}

/** Open a page and wait until React has taken over (typed text would be lost before that). */
export async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator('html[data-hydrated="true"]').waitFor();
}

export interface Person {
  name: string;
  email: string;
  tenantName: string;
}

/** Fill the signup form and wait for the "check your inbox" screen. */
export async function signup(page: Page, locale: Locale, person: Person): Promise<void> {
  const m = MESSAGES[locale].Auth;
  await open(page, '/signup');
  await page.getByLabel(m.fields.name, { exact: true }).fill(person.name);
  await page.getByLabel(m.fields.email, { exact: true }).fill(person.email);
  await page.getByLabel(m.fields.newPassword, { exact: true }).fill(PASSWORD);
  await page.getByLabel(m.fields.tenantName, { exact: true }).fill(person.tenantName);
  await page.getByRole('button', { name: m.signup.submit }).click();
  await page.getByRole('heading', { name: m.inbox.title }).waitFor();
}

/** Open the verification link from the email. Returns how many POSTs the page sent for the token. */
export async function verifyEmail(page: Page, locale: Locale, email: string): Promise<number> {
  const m = MESSAGES[locale].Auth;
  const link = await linkFromMail(email, LINK.verify);
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/v1/auth/verify-email'))
      posts += 1;
  });
  await open(page, link);
  await page.getByRole('heading', { name: m.verify.doneTitle }).waitFor();
  // Give a (wrong) second request time to show up before the caller counts.
  await page.waitForTimeout(500);
  return posts;
}

export async function login(page: Page, locale: Locale, email: string): Promise<void> {
  const m = MESSAGES[locale].Auth;
  await open(page, '/login');
  await page.getByLabel(m.fields.email, { exact: true }).fill(email);
  await page.getByLabel(m.fields.password, { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: m.login.submit }).click();
}

/** Signup + verify + login for a person, in their own browser context. Returns the logged-in page. */
export async function registerAndLogin(
  browser: Browser,
  locale: Locale,
  person: Person,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newContext(browser, locale);
  const page = await context.newPage();
  await signup(page, locale, person);
  await verifyEmail(page, locale, person.email);
  await login(page, locale, person.email);
  await page.getByTestId('tenant-name').or(page.getByTestId('tenant-switcher')).first().waitFor();
  return { context, page };
}

/** Invite `email` from the staff page (the logged-in user needs `staff.manage`) and see it listed as pending. */
export async function invite(
  page: Page,
  locale: Locale,
  email: string,
  role: string,
): Promise<void> {
  const m = MESSAGES[locale].Staff;
  await open(page, '/staff');
  await page.getByTestId('invite-open').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(m.invite.email, { exact: true }).fill(email);
  await dialog.getByLabel(m.invite.role, { exact: true }).selectOption({ label: role });
  await dialog.getByRole('button', { name: m.invite.submit }).click();
  await expect(page.getByTestId('invitation-list').getByText(email)).toBeVisible();
}

/** A person who got an invitation by email chooses name and password (the "new account" path). */
export async function acceptNewInvite(
  browser: Browser,
  locale: Locale,
  person: { name: string; email: string },
): Promise<void> {
  const m = MESSAGES[locale].Auth;
  const context = await newContext(browser, locale);
  const page = await context.newPage();
  await open(page, await linkFromMail(person.email, LINK.invite));
  await page.getByLabel(m.fields.name, { exact: true }).fill(person.name);
  await page.getByLabel(m.fields.newPassword, { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: m.invite.submit }).click();
  await expect(page.getByRole('heading', { name: m.invite.doneTitle })).toBeVisible();
  await context.close();
}
