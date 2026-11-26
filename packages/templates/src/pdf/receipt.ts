import type { Escape } from '../render.js';
import type { PdfTemplateDefinition } from './types.js';

/**
 * What the receipt prints. Everything is already formatted text (money with the workspace currency's decimals, dates in the
 * venue time zone): the template decides the layout, never a number.
 */
export interface ReceiptPdfVars {
  tenantName: string;
  receiptNo: string;
  receivedOn: string;
  customer: { name: string; phone: string };
  venueName: string;
  bookingNumber: string;
  currency: string;
  amount: string;
  method: string;
  /** Cheque number, bank reference, ... */
  reference: string | null;
  /** `Received` for money in hand, `Cheque received: not cleared yet` for a pending cheque. */
  status: string;
  notes: string | null;
  /** The booking after this payment. */
  bookingTotal: string;
  paidToDate: string;
  balanceDue: string;
  /** Set when this receipt was reversed: the receipt is shown as cancelled. */
  voidNote: string | null;
}

const isVars = (value: unknown): value is ReceiptPdfVars =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ReceiptPdfVars).receiptNo === 'string' &&
  typeof (value as ReceiptPdfVars).amount === 'string';

/**
 * `receipt`: the English receipt of module 9. A4, the bundled font, the receipt number, who paid and for which booking, the
 * amount and how it was paid, and where the booking stands after it (total, paid to date, balance). A pending cheque says so;
 * a reversed receipt is marked as cancelled. Built in code with every value escaped.
 */
export const receiptDocument: PdfTemplateDefinition = {
  title: 'Receipt {{ receiptNo }}',
  css: `
@page { size: A4; margin: 16mm 14mm; }
* { box-sizing: border-box; }
html { font-family: 'Noto Sans', sans-serif; font-size: 10pt; color: #1b1f24; }
body { margin: 0; line-height: 1.45; }
h1 { font-size: 18pt; margin: 0; }
.top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.5pt solid #1b1f24; padding-bottom: 4mm; margin-bottom: 6mm; }
.logo { width: 16mm; height: 16mm; border: 0.75pt dashed #9aa5b1; border-radius: 3mm; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14pt; color: #3b4652; margin-inline-end: 4mm; }
.brand { display: flex; align-items: center; }
.meta { font-size: 9pt; color: #3b4652; text-align: end; }
.cols { display: flex; gap: 8mm; margin-bottom: 6mm; }
.cols > div { flex: 1; }
.label { font-size: 8.5pt; color: #5d6b7a; text-transform: uppercase; letter-spacing: 0.04em; }
.paid { border: 1.2pt solid #1b1f24; border-radius: 2mm; padding: 5mm; margin-bottom: 6mm; text-align: center; }
.paid .amount { font-size: 22pt; font-weight: 700; font-variant-numeric: tabular-nums; }
.status { font-size: 9.5pt; color: #3b4652; }
.void { border: 1.2pt solid #b42318; color: #b42318; border-radius: 2mm; padding: 3mm; margin-bottom: 6mm; text-align: center; font-weight: 700; }
table { width: 100%; border-collapse: collapse; }
td { padding: 1.6mm 2mm; border-bottom: 0.4pt solid #d5dbe1; }
td.num { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
tr.strong td { font-weight: 700; border-top: 1.2pt solid #1b1f24; }
.foot { margin-top: 8mm; font-size: 8.5pt; color: #3b4652; border-top: 0.5pt solid #9aa5b1; padding-top: 3mm; }
bdi { unicode-bidi: isolate; }
`,
  body: '',
  build(vars: unknown, esc: Escape): string {
    if (!isVars(vars)) throw new TypeError('receipt: unexpected variables');
    const v = vars;
    const initials = esc(
      v.tenantName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0] ?? '')
        .join('')
        .toUpperCase() || 'R',
    );
    return `
<div class="top">
  <div class="brand"><div class="logo">${initials}</div><div><h1>${esc(v.tenantName)}</h1><div class="meta" style="text-align:start">Receipt</div></div></div>
  <div class="meta">
    <div><strong>${esc(v.receiptNo)}</strong></div>
    <div>${esc(v.receivedOn)}</div>
  </div>
</div>
${v.voidNote ? `<div class="void">${esc(v.voidNote)}</div>` : ''}
<div class="cols">
  <div><div class="label">Received from</div><strong>${esc(v.customer.name)}</strong><br><bdi>${esc(v.customer.phone)}</bdi></div>
  <div><div class="label">For booking</div><strong>${esc(v.bookingNumber)}</strong><br>${esc(v.venueName)}</div>
</div>
<div class="paid">
  <div class="label">Amount received (${esc(v.currency)})</div>
  <div class="amount">${esc(v.amount)}</div>
  <div class="status">${esc(v.method)}${v.reference ? ` · <bdi>${esc(v.reference)}</bdi>` : ''} · ${esc(v.status)}</div>
</div>
<table>
  <tbody>
    <tr><td>Booking total</td><td class="num">${esc(v.bookingTotal)}</td></tr>
    <tr><td>Paid to date</td><td class="num">${esc(v.paidToDate)}</td></tr>
    <tr class="strong"><td>Balance due (${esc(v.currency)})</td><td class="num">${esc(v.balanceDue)}</td></tr>
  </tbody>
</table>
${v.notes ? `<p>${esc(v.notes)}</p>` : ''}
<div class="foot">Thank you. This receipt confirms the payment above; a cheque counts once it has cleared.</div>`;
  },
};
