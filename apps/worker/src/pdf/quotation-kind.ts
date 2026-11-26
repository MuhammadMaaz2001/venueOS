import { QuotePreviewSchema, formatMoney, money, roundMoney } from '@venueos/shared';
import type { QuotationPdfVars } from '@venueos/templates';
import { date, group, time } from './format';
import type { PdfKindHandler } from './pdf-kind';

const Snapshot = QuotePreviewSchema.pick({
  sessions: true,
  lines: true,
  totals: true,
  taxRate: true,
});

/**
 * `quotation`: the PDF of one quotation version. It prints the FROZEN snapshot of that version (`quotations.line_items`), so
 * a later change of the booking or the catalogue never alters a document that was sent. With inclusive tax each line shows
 * what the customer pays (net + the tax it contains) and the tax is listed once as "includes tax". The key is recorded in
 * `quotations.pdf_key` (a key, never a URL).
 */
export const quotationKind: PdfKindHandler = {
  kind: 'quotation',
  template: 'quotation',

  async load(tx, payload) {
    const q = await tx.quotation.findFirst({
      where: { id: payload.entityId, tenantId: payload.tenantId },
      include: {
        booking: {
          include: {
            customer: { select: { name: true, phone: true, email: true, preferredLocale: true } },
            venue: { select: { name: true, timezone: true } },
          },
        },
      },
    });
    if (!q) return null;
    const tenant = await tx.tenant.findFirst({
      where: { id: payload.tenantId },
      select: { name: true, timezone: true, defaultLocale: true },
    });
    if (!tenant) return null;
    const snapshot = Snapshot.safeParse(q.lineItems);
    if (!snapshot.success) return null;
    const { sessions, lines, totals, taxRate } = snapshot.data;
    const timeZone = q.booking.venue.timezone ?? tenant.timezone;
    const currency = q.currency;
    const inclusive = taxRate?.inclusive === true;
    const text = (value: string | null): string => group(value ?? '0');

    const sessionBlocks: QuotationPdfVars['sessions'] = sessions.map((s) => {
      const own = lines.filter((l) => l.sessionIndex === s.index);
      const starts = new Date(s.startsAt);
      const ends = new Date(s.endsAt);
      return {
        title: s.eventTypeName ?? 'Event',
        date: date(starts, timeZone),
        time: `${time(starts, timeZone)} - ${time(ends, timeZone)}`,
        space: s.spaceName,
        guests:
          s.billedGuests === s.guests
            ? `${s.guests} guests`
            : `${s.guests} guests (billed for ${s.billedGuests})`,
        notes: s.setupNotes,
        lines: own.map((l) => {
          const qty = money(l.quantity);
          const gross = money(l.grossAmount ?? '0');
          // The unit price a customer reads: the gross amount per unit (net + contained tax), rounded to the currency.
          const unit = qty.isZero() || qty.eq(1) ? gross : roundMoney(gross.div(qty), currency);
          return {
            description: l.description,
            quantity: l.quantity,
            unitPrice: group(formatMoney(unit.toString(), currency)),
            amount: text(l.grossAmount),
          };
        }),
        subtotal: group(
          formatMoney(
            own.reduce((sum, l) => sum.plus(l.grossAmount ?? '0'), money('0')).toString(),
            currency,
          ),
        ),
      };
    });

    const sessionLines = lines.filter((l) => l.sessionIndex !== null);
    const gross = sessionLines.reduce((sum, l) => sum.plus(l.grossAmount ?? '0'), money('0'));
    const discountLines = lines.filter((l) => l.kind === 'DISCOUNT');
    const discount = discountLines.reduce((sum, l) => sum.plus(l.grossAmount ?? '0'), money('0'));
    const taxLine = lines.find((l) => l.kind === 'TAX');
    const validUntil = q.validUntil ? date(q.validUntil, 'UTC') : null;

    const vars: QuotationPdfVars = {
      tenantName: tenant.name,
      number: q.number,
      version: q.version,
      issuedOn: date(q.createdAt, timeZone),
      validUntil,
      customer: {
        name: q.booking.customer.name,
        phone: q.booking.customer.phone,
        email: q.booking.customer.email,
      },
      venueName: q.booking.venue.name,
      currency,
      sessions: sessionBlocks,
      extraLines:
        !inclusive && taxLine
          ? [{ description: taxLine.description, amount: text(taxLine.amount) }]
          : [],
      totals: {
        subtotal: group(formatMoney(gross.toString(), currency)),
        discount:
          discountLines.length > 0 ? group(formatMoney(discount.toString(), currency)) : null,
        tax: taxLine ? text(taxLine.amount) : null,
        taxIncluded: inclusive,
        grand: text(totals.grandTotal),
      },
      terms: [
        ...(validUntil ? [`This quotation is valid until ${validUntil}.`] : []),
        'Dates are not reserved until a hold or an advance payment is confirmed.',
        `All amounts are in ${currency}${taxRate ? (inclusive ? ` and include ${taxRate.name} (${taxRate.ratePct}%).` : `; ${taxRate.name} (${taxRate.ratePct}%) is added.`) : '.'}`,
        'Prices may change if the dates, venue spaces, guests or services change.',
      ],
    };
    return {
      locale: q.booking.customer.preferredLocale ?? tenant.defaultLocale,
      vars: vars as unknown as Record<string, unknown>,
    };
  },

  async saveKey(tx, payload, key) {
    await tx.quotation.updateMany({
      where: { id: payload.entityId, tenantId: payload.tenantId },
      data: { pdfKey: key },
    });
  },
};
