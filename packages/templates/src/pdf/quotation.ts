import type { Escape } from '../render.js';
import type { PdfTemplateDefinition } from './types.js';

/**
 * What the quotation document prints. Everything is already formatted text (money with the workspace currency's decimals,
 * dates in the venue time zone): the template decides the layout, never a number.
 */
export interface QuotationPdfVars {
  tenantName: string;
  number: string;
  version: number;
  issuedOn: string;
  validUntil: string | null;
  customer: { name: string; phone: string; email: string | null };
  venueName: string;
  currency: string;
  sessions: {
    title: string;
    date: string;
    time: string;
    space: string;
    guests: string;
    notes: string | null;
    lines: { description: string; quantity: string; unitPrice: string; amount: string }[];
    subtotal: string;
  }[];
  /** Lines of the whole booking (discount, tax shown as a line when it is added on top). */
  extraLines: { description: string; amount: string }[];
  totals: {
    subtotal: string;
    discount: string | null;
    tax: string | null;
    taxIncluded: boolean;
    grand: string;
  };
  terms: string[];
}

const isVars = (value: unknown): value is QuotationPdfVars =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as QuotationPdfVars).sessions);

/**
 * `quotation`: the English quotation of module 7. A4, the bundled font, a placeholder where the tenant's logo goes, the
 * customer and venue, one block per session with its lines (rent, price rule adjustments, package, add-ons), the discount and
 * tax, the total, the validity and the terms. Built in code (a loop of sessions and lines is not expressible in the
 * placeholder-only template syntax), with every value escaped through the same `escape` function.
 */
export const quotationDocument: PdfTemplateDefinition = {
  title: 'Quotation {{ number }}',
  css: `
@page { size: A4; margin: 16mm 14mm; }
* { box-sizing: border-box; }
html { font-family: 'Noto Sans', sans-serif; font-size: 10pt; color: #1b1f24; }
body { margin: 0; line-height: 1.45; }
h1 { font-size: 18pt; margin: 0; }
h2 { font-size: 11.5pt; margin: 0 0 2mm; }
.top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.5pt solid #1b1f24; padding-bottom: 4mm; margin-bottom: 5mm; }
.logo { width: 16mm; height: 16mm; border: 0.75pt dashed #9aa5b1; border-radius: 3mm; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14pt; color: #3b4652; margin-inline-end: 4mm; }
.brand { display: flex; align-items: center; }
.meta { font-size: 9pt; color: #3b4652; text-align: end; }
.cols { display: flex; gap: 8mm; margin-bottom: 5mm; }
.cols > div { flex: 1; }
.label { font-size: 8.5pt; color: #5d6b7a; text-transform: uppercase; letter-spacing: 0.04em; }
.session { margin-bottom: 5mm; break-inside: avoid; }
.session .head { background: #eef1f4; padding: 2mm 3mm; border-radius: 1.5mm; }
.session .sub { font-size: 9pt; color: #3b4652; }
table { width: 100%; border-collapse: collapse; margin-top: 1mm; }
th, td { padding: 1.4mm 2mm; vertical-align: top; text-align: start; border-bottom: 0.4pt solid #d5dbe1; }
th { font-size: 8.5pt; color: #5d6b7a; font-weight: 700; }
td.num, th.num { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
.totals { margin-inline-start: auto; width: 82mm; margin-top: 3mm; break-inside: avoid; }
.totals td { border: 0; padding: 1mm 2mm; }
.totals .grand td { border-top: 1.2pt solid #1b1f24; font-weight: 700; font-size: 12pt; padding-top: 2mm; }
.terms { margin-top: 7mm; font-size: 8.5pt; color: #3b4652; border-top: 0.5pt solid #9aa5b1; padding-top: 3mm; }
.terms li { margin-bottom: 1mm; }
bdi { unicode-bidi: isolate; }
`,
  body: '',
  build(vars: unknown, esc: Escape): string {
    if (!isVars(vars)) throw new TypeError('quotation: unexpected variables');
    const v = vars;
    const initials = esc(
      v.tenantName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0] ?? '')
        .join('')
        .toUpperCase() || 'Q',
    );
    const sessions = v.sessions
      .map(
        (s) => `
<div class="session">
  <div class="head"><h2>${esc(s.title)}</h2>
    <div class="sub">${esc(s.date)} · ${esc(s.time)} · ${esc(s.space)} · ${esc(s.guests)}</div>
    ${s.notes ? `<div class="sub">${esc(s.notes)}</div>` : ''}
  </div>
  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount (${esc(v.currency)})</th></tr></thead>
    <tbody>
      ${s.lines
        .map(
          (l) =>
            `<tr><td>${esc(l.description)}</td><td class="num">${esc(l.quantity)}</td><td class="num">${esc(l.unitPrice)}</td><td class="num">${esc(l.amount)}</td></tr>`,
        )
        .join('\n      ')}
      <tr><td colspan="3"><strong>Session total</strong></td><td class="num"><strong>${esc(s.subtotal)}</strong></td></tr>
    </tbody>
  </table>
</div>`,
      )
      .join('\n');
    const extra = v.extraLines
      .map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${esc(l.amount)}</td></tr>`)
      .join('\n');
    const t = v.totals;
    return `
<div class="top">
  <div class="brand"><div class="logo">${initials}</div><div><h1>${esc(v.tenantName)}</h1><div class="meta" style="text-align:start">Quotation</div></div></div>
  <div class="meta">
    <div><strong>${esc(v.number)}</strong> · version ${esc(String(v.version))}</div>
    <div>Issued ${esc(v.issuedOn)}</div>
    ${v.validUntil ? `<div>Valid until ${esc(v.validUntil)}</div>` : ''}
  </div>
</div>
<div class="cols">
  <div><div class="label">Prepared for</div><strong>${esc(v.customer.name)}</strong><br><bdi>${esc(v.customer.phone)}</bdi>${v.customer.email ? `<br><bdi>${esc(v.customer.email)}</bdi>` : ''}</div>
  <div><div class="label">Venue</div><strong>${esc(v.venueName)}</strong></div>
</div>
${sessions}
<table class="totals">
  <tbody>
    <tr><td>Subtotal</td><td class="num">${esc(t.subtotal)}</td></tr>
    ${t.discount ? `<tr><td>Discount</td><td class="num">${esc(t.discount)}</td></tr>` : ''}
    ${extra}
    ${t.tax && t.taxIncluded ? `<tr><td>Includes tax</td><td class="num">${esc(t.tax)}</td></tr>` : ''}
    <tr class="grand"><td>Total (${esc(v.currency)})</td><td class="num">${esc(t.grand)}</td></tr>
  </tbody>
</table>
<ul class="terms">${v.terms.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  },
};
