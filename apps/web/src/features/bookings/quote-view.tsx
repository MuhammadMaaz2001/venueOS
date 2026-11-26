'use client';

import type { LineItemDto, QuoteTotalsDto, QuoteWarningDto, SessionDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useFormatters } from '../shell/session';

/** The priced lines of a quotation or booking, grouped by session, with the booking-level lines (discount, tax) at the end. */
export function QuoteLines({
  sessions,
  lines,
  totals,
}: {
  sessions: readonly Pick<
    SessionDto,
    'index' | 'spaceName' | 'slotName' | 'date' | 'eventTypeName' | 'status'
  >[];
  lines: readonly LineItemDto[];
  totals: QuoteTotalsDto;
}) {
  const t = useTranslations('Bookings.quote');
  const format = useFormatters();
  const money = (value: string | null): string => (value === null ? '—' : format.money(value));
  const hidden = totals.grandTotal === null;
  if (hidden) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="prices-hidden">
        {t('pricesHidden')}
      </p>
    );
  }
  const wholeBooking = lines.filter((line) => line.sessionIndex === null);
  return (
    <div className="grid gap-4" data-testid="quote-lines">
      {sessions.map((session) => {
        const own = lines.filter((line) => line.sessionIndex === session.index);
        if (own.length === 0) return null;
        return (
          <section
            key={session.index}
            className="grid gap-1"
            aria-label={`${session.spaceName} ${session.slotName}`}
          >
            <h4 className="text-sm font-semibold">
              {session.eventTypeName ?? t('session', { n: session.index + 1 })} ·{' '}
              {session.spaceName} · {session.slotName} · {format.dateOnly(session.date)}
            </h4>
            <LineTable lines={own} money={money} />
          </section>
        );
      })}
      {wholeBooking.length > 0 ? <LineTable lines={wholeBooking} money={money} /> : null}
      <dl className="ms-auto grid w-full max-w-xs gap-1 text-sm" data-testid="quote-totals">
        <TotalRow label={t('subtotal')} value={money(totals.subtotal)} />
        {totals.discountTotal !== null && Number(totals.discountTotal) !== 0 ? (
          <TotalRow label={t('discount')} value={money(totals.discountTotal)} />
        ) : null}
        <TotalRow label={t('tax')} value={money(totals.taxTotal)} />
        <TotalRow
          label={t('grandTotal')}
          value={money(totals.grandTotal)}
          strong
          testId="quote-grand-total"
        />
      </dl>
    </div>
  );
}

function TotalRow({
  label,
  value,
  strong,
  testId,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'border-t pt-1 font-semibold' : ''}`}>
      <dt>{label}</dt>
      <dd className="ltr-isolate" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function LineTable({
  lines,
  money,
}: {
  lines: readonly LineItemDto[];
  money: (value: string | null) => string;
}) {
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {lines.map((line, i) => (
        <li
          key={line.id ?? `${line.kind}-${i}`}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2"
          data-testid="quote-line"
          data-kind={line.kind}
        >
          <span className="min-w-0 break-words">{line.description}</span>
          <span className="ltr-isolate shrink-0 tabular-nums">{money(line.grossAmount)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Slots already taken and venue rules that are broken: a warning on a quotation, never a block. */
export function QuoteWarnings({
  warnings,
  sessions,
}: {
  warnings: readonly QuoteWarningDto[];
  sessions: readonly Pick<SessionDto, 'index' | 'spaceName' | 'slotName' | 'date'>[];
}) {
  const t = useTranslations('Bookings.quote');
  if (warnings.length === 0) return null;
  return (
    <Alert role="status" data-testid="quote-warnings">
      <AlertDescription>
        <ul className="grid gap-1">
          {warnings.map((warning, i) => {
            const session = sessions.find((s) => s.index === warning.sessionIndex);
            const where = session
              ? `${session.spaceName}, ${session.slotName}, ${session.date}`
              : '';
            return (
              <li key={`${warning.code}-${warning.sessionIndex}-${i}`} data-code={warning.code}>
                {warning.code === 'SLOT_TAKEN'
                  ? t('warnSlotTaken', { where, number: warning.detail ?? '' })
                  : t('warnLocalRule', { where })}
              </li>
            );
          })}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
