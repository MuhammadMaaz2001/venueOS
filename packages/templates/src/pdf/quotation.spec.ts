import { describe, expect, it } from 'vitest';
import { renderEmail } from '../email/render-email.js';
import { renderPdfHtml } from './render-pdf-html.js';
import type { QuotationPdfVars } from './quotation.js';

const vars: QuotationPdfVars = {
  tenantName: 'Royal Hall <Banquet>',
  number: 'BK-Q-2027-0042',
  version: 2,
  issuedOn: '14 Feb 2027',
  validUntil: '28 Feb 2027',
  customer: { name: 'Hina "Malik"', phone: '+923001234567', email: 'hina@example.test' },
  venueName: 'Main Hall',
  currency: 'PKR',
  sessions: [
    {
      title: 'Mehndi',
      date: 'Sat, 20 Mar 2027',
      time: '19:00 - 23:30',
      space: 'Hall B',
      guests: '120 guests',
      notes: 'Marigold decor <b>only</b>',
      lines: [
        {
          description: 'Rent: Mehndi, Hall B, Dinner',
          quantity: '1',
          unitPrice: '80,000.00',
          amount: '80,000.00',
        },
        {
          description: 'Gold menu: 120 guests',
          quantity: '120',
          unitPrice: '1,500.00',
          amount: '180,000.00',
        },
      ],
      subtotal: '260,000.00',
    },
    {
      title: 'Barat',
      date: 'Sun, 21 Mar 2027',
      time: '19:00 - 23:30',
      space: 'Hall A',
      guests: '250 guests',
      notes: null,
      lines: [
        {
          description: 'Rent: Barat, Hall A, Dinner',
          quantity: '1',
          unitPrice: '100,000.00',
          amount: '100,000.00',
        },
      ],
      subtotal: '100,000.00',
    },
  ],
  extraLines: [{ description: 'GST (16%)', amount: '57,600.00' }],
  totals: {
    subtotal: '360,000.00',
    discount: '-36,000.00',
    tax: '51,840.00',
    taxIncluded: false,
    grand: '375,840.00',
  },
  terms: [
    'This quotation is valid until 28 Feb 2027.',
    'Dates are held only after a hold or an advance.',
  ],
};

describe('quotation PDF template', () => {
  it('renders sessions, lines, totals, validity and terms as a self-contained English document', () => {
    const out = renderPdfHtml('quotation', 'en', vars);
    expect(out).toMatchObject({ lang: 'en', dir: 'ltr' });
    for (const text of [
      'BK-Q-2027-0042',
      'version 2',
      'Valid until 28 Feb 2027',
      'Mehndi',
      'Barat',
      'Hall B',
      '120 guests',
      '80,000.00',
      '260,000.00',
      'Session total',
      'Discount',
      '-36,000.00',
      'GST (16%)',
      '375,840.00',
      'Dates are held only after a hold or an advance.',
      'Prepared for',
      'Main Hall',
    ]) {
      expect(out.html, text).toContain(text);
    }
    expect(out.html).toContain('<title>Quotation BK-Q-2027-0042</title>');
    expect(out.html).not.toMatch(/<script/i);
    expect(out.html).not.toMatch(/https?:\/\//);
    expect(out.html).toContain("default-src 'none'");
  });

  it('escapes every variable (tenant name, customer name, notes)', () => {
    const { html } = renderPdfHtml('quotation', 'en', vars);
    expect(html).toContain('Royal Hall &lt;Banquet&gt;');
    expect(html).toContain('Hina &quot;Malik&quot;');
    expect(html).toContain('Marigold decor &lt;b&gt;only&lt;/b&gt;');
    expect(html).not.toContain('<Banquet>');
    expect(html).not.toContain('<b>only</b>');
  });

  it('shows "includes tax" for inclusive tax and leaves out the optional parts', () => {
    const inclusive = renderPdfHtml('quotation', 'en', {
      ...vars,
      validUntil: null,
      customer: { ...vars.customer, email: null },
      extraLines: [],
      totals: {
        subtotal: '116,000.00',
        discount: null,
        tax: '16,000.00',
        taxIncluded: true,
        grand: '116,000.00',
      },
    }).html;
    expect(inclusive).toContain('Includes tax');
    expect(inclusive).not.toContain('Valid until');
    expect(inclusive).not.toContain('hina@example.test');
    expect(inclusive).not.toContain('<td>Discount</td>');
  });

  it('refuses unexpected variables instead of printing a hole', () => {
    expect(() => renderPdfHtml('quotation', 'en', { tenantName: 'x' })).toThrow();
  });
});

describe('booking email templates', () => {
  const quotation = {
    customerName: 'Hina Malik',
    tenantName: 'Royal Hall',
    agentName: 'Sara',
    quotationNumber: 'BK-Q-2027-0042',
    version: 2,
    validUntil: '2027-02-28',
    grandTotal: 'PKR 375840.00',
    summary: 'Mehndi: 2027-03-20\nBarat: 2027-03-21',
    message: 'See you soon.',
  };
  it('quotation.send is sent under the tenant name and keeps the summary lines', () => {
    const mail = renderEmail('quotation.send', 'en', quotation);
    expect(mail.sender).toBe('tenant');
    expect(mail.subject).toBe('Quotation BK-Q-2027-0042 from Royal Hall');
    expect(mail.text).toContain('Mehndi: 2027-03-20\nBarat: 2027-03-21');
    expect(mail.text).toContain('Total: PKR 375840.00');
    expect(mail.html).toContain('white-space:pre-line');
  });

  it('hold.expired and hold.expiring link to the booking', () => {
    const base = {
      agentName: 'Sara',
      bookingNumber: 'BK-2027-0007',
      customerName: 'Hina',
      bookingUrl: 'https://app.example.test/bookings/b1',
    };
    const expired = renderEmail('hold.expired', 'en', {
      ...base,
      firstSession: 'Sat, 20 Mar 2027, 19:00',
    });
    expect(expired.subject).toBe('Hold expired: BK-2027-0007 (Hina)');
    expect(expired.html).toContain('href="https://app.example.test/bookings/b1"');
    const expiring = renderEmail('hold.expiring', 'en', {
      ...base,
      expiresAt: 'Tue, 16 Mar 2027, 10:00',
    });
    expect(expiring.text).toContain('ends Tue, 16 Mar 2027, 10:00');
  });
});
