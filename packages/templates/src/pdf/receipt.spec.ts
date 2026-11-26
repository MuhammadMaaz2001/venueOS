import { describe, expect, it } from 'vitest';
import { renderEmail } from '../email/render-email.js';
import { renderPdfHtml } from './render-pdf-html.js';
import type { ReceiptPdfVars } from './receipt.js';

const vars: ReceiptPdfVars = {
  tenantName: 'Royal Hall <Banquet>',
  receiptNo: 'BK-R-2027-00042',
  receivedOn: 'Sun, 14 Feb 2027',
  customer: { name: 'Hina "Malik"', phone: '+923001234567' },
  venueName: 'Main Hall',
  bookingNumber: 'BK-2027-0007',
  currency: 'PKR',
  amount: '50,000.00',
  method: 'Cheque',
  reference: 'CH-1001 <x>',
  status: 'Cheque received: not cleared yet',
  notes: 'Advance & token',
  bookingTotal: '200,000.00',
  paidToDate: '50,000.00',
  balanceDue: '150,000.00',
  voidNote: null,
};

describe('receipt PDF template', () => {
  it('prints the receipt, the amount, the method and where the booking stands', () => {
    const { html, lang, dir } = renderPdfHtml('receipt', 'en', vars);
    expect(lang).toBe('en');
    expect(dir).toBe('ltr');
    for (const text of [
      'BK-R-2027-00042',
      'BK-2027-0007',
      '50,000.00',
      'Cheque',
      'Cheque received: not cleared yet',
      '200,000.00',
      '150,000.00',
      'Balance due (PKR)',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('class="void"></div>');
    expect(html).not.toContain('<script');
  });

  it('escapes every value', () => {
    const { html } = renderPdfHtml('receipt', 'en', vars);
    expect(html).not.toContain('Royal Hall <Banquet>');
    expect(html).toContain('Royal Hall &lt;Banquet&gt;');
    expect(html).toContain('Hina &quot;Malik&quot;');
    expect(html).toContain('CH-1001 &lt;x&gt;');
    expect(html).toContain('Advance &amp; token');
  });

  it('marks a reversed receipt as cancelled', () => {
    const { html } = renderPdfHtml('receipt', 'en', {
      ...vars,
      voidNote: 'Cancelled: reversed on 15 Feb 2027',
    });
    expect(html).toContain('class="void">Cancelled: reversed on 15 Feb 2027');
  });

  it('refuses variables that are not a receipt', () => {
    expect(() => renderPdfHtml('receipt', 'en', { nope: true })).toThrow(TypeError);
  });
});

describe('receipt and payment reminder emails', () => {
  it('receipt.sent names the receipt, the amount and the booking, sent under the tenant name', () => {
    const mail = renderEmail('receipt.sent', 'en', {
      customerName: 'Hina <Malik>',
      tenantName: 'Royal Hall',
      receiptNo: 'BK-R-2027-00042',
      amount: 'PKR 50,000.00',
      method: 'Cash',
      receivedOn: '2027-02-14',
      bookingNumber: 'BK-2027-0007',
    });
    expect(mail.subject).toBe('Receipt BK-R-2027-00042 from Royal Hall');
    expect(mail.html).toContain('PKR 50,000.00');
    expect(mail.html).toContain('Hina &lt;Malik&gt;');
    expect(mail.text).toContain('BK-2027-0007');
    expect(mail.sender).toBe('tenant');
  });

  it('payment.due says what is due, how much and when', () => {
    const mail = renderEmail('payment.due', 'en', {
      customerName: 'Hina',
      tenantName: 'Royal Hall',
      bookingNumber: 'BK-2027-0007',
      label: 'Balance',
      amount: 'PKR 100,000.00',
      dueDate: '2027-02-07',
    });
    expect(mail.subject).toBe('Payment due 2027-02-07: booking BK-2027-0007');
    expect(mail.text).toContain('Balance payment of PKR 100,000.00');
  });
});
