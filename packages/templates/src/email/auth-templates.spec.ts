import { describe, expect, it } from 'vitest';
import { TemplateError } from '../render.js';
import { PRODUCT_NAME, listEmailTemplates, renderEmail } from './render-email.js';

const URL_WITH_QUERY = 'https://app.example.test/verify-email?token=AbC_123-xyz&next=%2Fhome';

const CASES = [
  {
    name: 'auth.verify-email',
    sender: 'product',
    vars: { name: 'Ali', verifyUrl: URL_WITH_QUERY, hours: 24 },
    link: 'verifyUrl',
  },
  {
    name: 'auth.account-exists',
    sender: 'product',
    vars: {
      loginUrl: 'https://app.example.test/login',
      forgotUrl: 'https://app.example.test/forgot',
    },
    link: 'loginUrl',
  },
  {
    name: 'auth.password-reset',
    sender: 'product',
    vars: { name: 'Ali', resetUrl: URL_WITH_QUERY, minutes: 30 },
    link: 'resetUrl',
  },
  {
    name: 'staff.invite',
    sender: 'tenant',
    vars: {
      inviterName: 'Sara',
      tenantName: 'Royal Hall',
      roleName: 'Sales agent',
      acceptUrl: URL_WITH_QUERY,
      days: 3,
    },
    link: 'acceptUrl',
  },
] as const;

describe('account and staff email templates', () => {
  it('are registered', () => {
    for (const c of CASES) expect(listEmailTemplates()).toContain(c.name);
    expect(PRODUCT_NAME).toBe('venueOS');
  });

  for (const c of CASES) {
    describe(c.name, () => {
      it(`renders in English and Urdu, sent under the ${c.sender} name`, () => {
        for (const locale of ['en', 'ur']) {
          const mail = renderEmail(c.name, locale, c.vars);
          expect(mail.locale).toBe(locale);
          expect(mail.sender).toBe(c.sender);
          expect(mail.subject.length).toBeGreaterThan(0);
          expect(mail.subject).not.toMatch(/[\r\n]/);
          expect(mail.text).toContain((c.vars as Record<string, string>)[c.link]);
          expect(mail.html).toContain(locale === 'ur' ? 'dir="rtl"' : 'dir="ltr"');
          expect(mail.html).not.toContain('{{');
          expect(mail.text).not.toContain('{{');
        }
      });

      it('escapes the link inside the href attribute and every other variable', () => {
        const evil = Object.fromEntries(
          Object.entries(c.vars).map(([k, v]) => [
            k,
            typeof v === 'string' ? `${v}"><script>x</script>` : v,
          ]),
        );
        const mail = renderEmail(c.name, 'en', evil);
        expect(mail.html).not.toContain('<script>');
        expect(mail.html).toContain('&quot;&gt;&lt;script&gt;');
      });

      it('refuses to render with a variable missing', () => {
        const [firstKey] = Object.keys(c.vars);
        const partial = { ...c.vars } as Record<string, unknown>;
        delete partial[firstKey as string];
        expect(() => renderEmail(c.name, 'en', partial)).toThrow(TemplateError);
      });
    });
  }

  it('puts the ampersand of a link into the href as an entity (valid HTML)', () => {
    const mail = renderEmail('auth.verify-email', 'en', CASES[0].vars);
    expect(mail.html).toContain(
      'href="https://app.example.test/verify-email?token=AbC_123-xyz&amp;next=%2Fhome"',
    );
    expect(mail.text).toContain('token=AbC_123-xyz&next=%2Fhome');
  });
});
