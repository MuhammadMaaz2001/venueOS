import { describe, expect, it } from 'vitest';
import { TemplateError } from '../render.js';
import { listEmailTemplates, renderEmail } from './render-email.js';

const LEAD_URL = 'https://app.example.test/leads/clx123';

const ASSIGNED = {
  assigneeName: 'Sara',
  assignedBy: 'Ali',
  customerName: 'Hina <Malik>',
  eventType: 'Walima',
  venueName: 'Royal Hall',
  preferredDate: '2027-02-14',
  guests: '400',
  source: 'WhatsApp',
  followUpAt: 'Mon 14 Dec 2026, 10:00',
  leadUrl: LEAD_URL,
};
const FOLLOW_UP = {
  assigneeName: 'Sara',
  customerName: 'Hina Malik',
  eventType: 'Walima',
  venueName: 'Royal Hall',
  stage: 'Contacted',
  followUpAt: 'Mon 14 Dec 2026, 10:00',
  leadUrl: LEAD_URL,
};

describe('lead email templates', () => {
  it('are registered', () => {
    expect(listEmailTemplates()).toEqual(
      expect.arrayContaining(['lead.assigned', 'lead.follow-up-due']),
    );
  });

  it('lead.assigned: tenant sender, link in both parts, customer name escaped', () => {
    const mail = renderEmail('lead.assigned', 'en', ASSIGNED);
    expect(mail.sender).toBe('tenant');
    expect(mail.subject).toBe('New lead assigned to you: Hina <Malik>');
    expect(mail.html).toContain(`href="${LEAD_URL}"`);
    expect(mail.html).toContain('Hina &lt;Malik&gt;');
    expect(mail.html).not.toContain('<Malik>');
    expect(mail.text).toContain(LEAD_URL);
    expect(mail.html).not.toContain('{{');
  });

  it('lead.follow-up-due: names the customer and the stage', () => {
    const mail = renderEmail('lead.follow-up-due', 'ur', FOLLOW_UP); // falls back to English
    expect(mail.locale).toBe('en');
    expect(mail.subject).toBe('Follow-up due: Hina Malik');
    expect(mail.text).toContain('"Contacted"');
    expect(mail.text).toContain(LEAD_URL);
  });

  it('refuse a missing variable instead of printing a hole', () => {
    const incomplete: Record<string, string> = { ...FOLLOW_UP };
    delete incomplete.leadUrl;
    expect(() => renderEmail('lead.follow-up-due', 'en', incomplete)).toThrow(TemplateError);
  });
});
