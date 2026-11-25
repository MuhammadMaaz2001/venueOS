import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { uniqueEmail } from './support/mail';
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

// Modules 4 and 5: a sales agent records an inquiry with a NEW customer, is warned about a second customer with the same
// phone, moves the lead through the stages to LOST with a reason, and the owner finds the whole story in the activity
// log. A sensitive CNIC field is masked for the agent and revealed (once, on request) only for the owner. Also the
// follow-ups card of the dashboard and a 360 px check. Needs the whole stack and Mailpit (see playwright.config.ts).

const m = MESSAGES.en;
const CNIC = '35202-1234567-1';
const CNIC_MASKED = '*****-*****67-1';

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

test.describe('customers and leads', () => {
  test.beforeEach(() => {
    cspViolations.length = 0;
  });
  test.afterEach(() => {
    expect(cspViolations, 'the Content Security Policy blocked something').toEqual([]);
  });

  test('inquiry with a new customer, stages to LOST, activity log, masked and revealed CNIC', async ({
    browser,
  }) => {
    const stamp = Date.now().toString(36);
    const owner = {
      name: 'CRM Owner',
      email: uniqueEmail('crm-owner'),
      tenantName: `CRM Halls ${stamp}`,
    };
    const agent = { name: 'Sara Agent', email: uniqueEmail('crm-agent') };
    const { context: ownerContext, page: ownerPage } = await registerAndLogin(browser, 'en', owner);

    // ── the owner needs a venue (the first step of the wizard) and a sensitive CNIC field ────────────
    await ownerPage.waitForURL('**/setup');
    await ownerPage.locator('html[data-hydrated="true"]').waitFor();
    await ownerPage.getByLabel(m.Setup.fields.venueName, { exact: true }).fill(`Venue ${stamp}`);
    await ownerPage.getByRole('button', { name: m.Setup.wizard.venue.submit }).click();
    await expect(ownerPage.getByTestId('wizard-step-spaces')).toBeVisible();

    await open(ownerPage, '/pricing');
    await ownerPage.getByTestId('tab-customFields').click();
    await ownerPage.getByTestId('custom-field-add').click();
    const field = ownerPage.getByRole('dialog');
    await field.getByLabel(m.Pricing.fields.label, { exact: true }).fill('CNIC');
    await field.getByLabel(m.Pricing.fields.sensitiveLabel, { exact: true }).check();
    await field.getByRole('button', { name: m.Pricing.fields.create }).click();
    await expect(
      ownerPage.getByTestId('custom-field-row').filter({ hasText: 'CNIC' }),
    ).toContainText(m.Pricing.fields.sensitive);

    // ── a sales agent joins ──────────────────────────────────────────────────────────────────────────
    await invite(ownerPage, 'en', agent.email, 'Sales agent');
    await acceptNewInvite(browser, 'en', agent);
    const agentContext = await newContext(browser);
    const agentPage = await agentContext.newPage();
    await login(agentPage, 'en', agent.email);
    await agentPage
      .getByTestId('tenant-name')
      .or(agentPage.getByTestId('tenant-switcher'))
      .first()
      .waitFor();

    // The navigation shows the new pages; the dashboard has the follow-ups card.
    await expect(
      agentPage.getByRole('link', { name: m.Shell.nav.leads, exact: true }),
    ).toBeVisible();
    await expect(
      agentPage.getByRole('link', { name: m.Shell.nav.customers, exact: true }),
    ).toBeVisible();
    await expect(agentPage.getByTestId('follow-ups-card')).toBeVisible();

    // ── the agent records an inquiry with a NEW customer ─────────────────────────────────────────────
    await open(agentPage, '/leads');
    await agentPage.getByTestId('lead-add').click();
    const inquiry = agentPage.getByRole('dialog');
    await inquiry.getByTestId('inquiry-customer-name').fill('Hina Malik');
    await inquiry.getByTestId('inquiry-customer-phone').fill('0300 1234567');
    await inquiry.getByLabel(m.Leads.form.guests, { exact: true }).fill('300');
    await inquiry.getByTestId('lead-submit').click();
    await agentPage.waitForURL(/\/leads\/[a-z0-9]+$/);
    const leadUrl = agentPage.url();
    await expect(agentPage.getByTestId('lead-title')).toHaveText('Hina Malik');
    await expect(agentPage.getByTestId('lead-stage')).toHaveText(m.Leads.stages.NEW);

    // The customer exists, with the phone stored in E.164.
    await agentPage.getByRole('link', { name: m.Leads.detail.customer }).click();
    await agentPage.waitForURL(/\/customers\/[a-z0-9]+$/);
    const customerUrl = agentPage.url();
    await expect(agentPage.getByTestId('customer-phone')).toContainText('+923001234567');
    await expect(agentPage.getByTestId('customer-leads')).toContainText(m.Leads.stages.NEW);

    // ── a second inquiry with the same phone: warned, never blocked ──────────────────────────────────
    await open(agentPage, '/leads');
    await agentPage.getByTestId('lead-add').click();
    const second = agentPage.getByRole('dialog');
    await second.getByTestId('inquiry-customer-name').fill('Hina (sister)');
    await second.getByTestId('inquiry-customer-phone').fill('+92 300 1234567');
    await expect(second.getByTestId('duplicate-warning')).toBeVisible();
    await expect(second.getByTestId('duplicate-link')).toContainText('Hina Malik');
    await second.getByTestId('duplicate-use').click();
    await expect(second.getByTestId('inquiry-customer-picked')).toContainText('Hina Malik');
    await agentPage.keyboard.press('Escape');

    // ── the CNIC: the agent can enter it, sees it masked, cannot reveal it ───────────────────────────
    await open(agentPage, customerUrl);
    await agentPage.getByTestId('customer-edit').click();
    const edit = agentPage.getByRole('dialog');
    await edit.getByTestId('custom-field-cnic').fill(CNIC);
    await edit.getByRole('button', { name: m.Customers.form.save }).click();
    await expect(agentPage.getByTestId('field-value-cnic')).toHaveText(CNIC_MASKED);
    await expect(agentPage.getByTestId('reveal-cnic')).toHaveCount(0);
    await expect(agentPage.locator('body')).not.toContainText(CNIC);

    // ── the agent moves the lead through the stages to LOST ──────────────────────────────────────────
    await open(agentPage, leadUrl);
    for (const stage of ['CONTACTED', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION'] as const) {
      await agentPage.getByTestId(`stage-${stage}`).click();
      await expect(agentPage.getByTestId('lead-stage')).toHaveText(m.Leads.stages[stage]);
    }
    await agentPage.getByTestId('stage-LOST').click();
    const dialog = agentPage.getByTestId('stage-dialog');
    await dialog.getByTestId('stage-dialog-submit').click();
    await expect(dialog.getByText(m.Leads.stageDialog.reasonRequired)).toBeVisible(); // a reason is required
    await dialog.getByTestId('lost-reason').fill('Booked another hall');
    await dialog.getByTestId('stage-dialog-submit').click();
    await expect(agentPage.getByTestId('lead-stage')).toHaveText(m.Leads.stages.LOST);
    await expect(agentPage.getByTestId('lead-lost-reason')).toContainText('Booked another hall');

    // The board shows it in the LOST column.
    await open(agentPage, '/leads');
    await expect(agentPage.getByTestId('board-column-LOST').getByTestId('lead-card')).toContainText(
      'Hina Malik',
    );
    await expect(agentPage.getByTestId('board-count-NEW')).toHaveText('0');

    // ── the owner sees the story in the activity log, and reveals the CNIC ───────────────────────────
    await open(ownerPage, leadUrl);
    const activity = ownerPage.getByTestId('lead-activity');
    await expect(activity.getByTestId('activity-entry')).toHaveCount(6); // created + 5 stage changes
    await expect(activity).toContainText(m.Leads.activity.actions.lead_stage_change);
    await expect(activity).toContainText(`${m.Leads.stages.NEGOTIATION} → ${m.Leads.stages.LOST}`);
    await expect(activity).toContainText('Booked another hall');
    await expect(activity).toContainText(agent.name);

    await open(ownerPage, customerUrl);
    await expect(ownerPage.getByTestId('field-value-cnic')).toHaveText(CNIC_MASKED);
    await ownerPage.getByTestId('reveal-cnic').click();
    await expect(ownerPage.getByTestId('field-value-cnic')).toHaveText(CNIC);
    await ownerPage.getByTestId('hide-cnic').click();
    await expect(ownerPage.getByTestId('field-value-cnic')).toHaveText(CNIC_MASKED);

    // ... and the audit log says who revealed it, without the value.
    await open(ownerPage, '/audit');
    await expect(
      ownerPage
        .getByTestId('audit-action')
        .filter({ hasText: m.Audit.actions.customer_reveal_sensitive })
        .first(),
    ).toBeVisible();
    await expect(ownerPage.locator('body')).not.toContainText(CNIC);

    // ── 360 px: the pages are usable on a phone ──────────────────────────────────────────────────────
    await agentPage.setViewportSize({ width: 360, height: 740 });
    for (const path of ['/leads', '/customers', leadUrl, customerUrl, '/']) {
      await open(agentPage, path);
      await expect(agentPage.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoSidewaysScroll(agentPage);
    }
    await open(agentPage, '/leads');
    await agentPage.getByTestId('lead-add').click();
    await expect(agentPage.getByRole('dialog')).toBeVisible();
    await expectNoSidewaysScroll(agentPage);

    await agentContext.close();
    await ownerContext.close();
  });
});
