'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { CheckboxField, SelectField, TextField } from '@/components/form-fields';
import { ListState, NoAccess, RowList } from '@/components/resource-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useVenues } from '../setup/api';
import { useFormatters, useSession } from '../shell/session';
import { NO_RECEIVABLE_FILTERS, useReceivables, useReceivablesSummary } from './api';
import type { ReceivableFilters } from './api';

/** What the customers still owe on confirmed bookings, overdue first. */
export function ReceivablesPage({ initialOverdue = false }: { initialOverdue?: boolean }) {
  const t = useTranslations('Payments.receivables');
  const { can } = useSession();
  const format = useFormatters();
  const venues = useVenues({ enabled: can('venue.view') });
  const [filters, setFilters] = useState<ReceivableFilters>({
    ...NO_RECEIVABLE_FILTERS,
    overdue: initialOverdue,
  });
  const receivables = useReceivables(filters, can('payment.view'));
  const summary = useReceivablesSummary(can('payment.view'));
  if (!can('payment.view')) return <NoAccess text={t('noAccess')} />;
  const rows = receivables.data?.pages.flatMap((p) => p.data) ?? [];
  const set = (patch: Partial<ReceivableFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  const sum = summary.data;

  return (
    <div className="mx-auto grid max-w-5xl gap-4" data-testid="receivables-page">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      {sum ? (
        <div className="grid gap-3 sm:grid-cols-3" data-testid="receivables-summary">
          {(['overdue', 'dueThisWeek', 'outstanding'] as const).map((key) => (
            <Card key={key}>
              <CardContent className="grid gap-0.5 pt-4" data-testid={`summary-${key}`}>
                <span className="text-muted-foreground text-xs">{t(`summary.${key}`)}</span>
                <span className="text-lg font-semibold tabular-nums">
                  {format.money(sum[key].amount)}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t('bookings', { count: sum[key].count })}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        role="search"
        aria-label={t('filters')}
        onSubmit={(event) => event.preventDefault()}
      >
        <SelectField
          label={t('venue')}
          value={filters.venueId}
          onChange={(event) => set({ venueId: event.target.value })}
        >
          <option value="">{t('allVenues')}</option>
          {(venues.data?.data ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('from')}
          type="date"
          value={filters.from}
          onChange={(e) => set({ from: e.target.value })}
        />
        <TextField
          label={t('to')}
          type="date"
          value={filters.to}
          onChange={(e) => set({ to: e.target.value })}
        />
        <div className="flex items-end pb-2">
          <CheckboxField
            label={t('overdueOnly')}
            checked={filters.overdue}
            onChange={(event) => set({ overdue: event.target.checked })}
            data-testid="receivables-overdue"
          />
        </div>
      </form>

      <ListState
        pending={receivables.isPending}
        failed={receivables.isError}
        empty={rows.length === 0}
        emptyText={t('empty')}
        loadFailedText={t('loadFailed')}
      >
        <RowList testId="receivables-list">
          {rows.map((r) => (
            <li
              key={r.bookingId}
              data-testid="receivable-row"
              data-overdue={r.overdueDays !== null}
            >
              <Link href={`/bookings/${r.bookingId}`} className="hover:bg-muted/50 block">
                <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.number ?? t('draft')}</span>
                      {r.overdueDays !== null ? (
                        <Badge variant="secondary" className="bg-destructive/10 text-destructive">
                          {t('overdueDays', { days: r.overdueDays })}
                        </Badge>
                      ) : null}
                    </div>
                    <span className="truncate text-sm">
                      {r.customer.name} · {r.venueName}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {r.nextDueDate
                        ? t('nextDue', {
                            date: format.dateOnly(r.nextDueDate),
                            amount: format.money(r.nextDueAmount ?? '0'),
                          })
                        : t('noSchedule')}
                    </span>
                  </div>
                  <div className="grid text-end">
                    <span className="ltr-isolate text-sm font-semibold tabular-nums">
                      {format.money(r.balanceDue)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t('paidOf', {
                        paid: format.money(r.paidTotal),
                        total: format.money(r.grandTotal),
                      })}
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </RowList>
        {receivables.hasNextPage ? (
          <Button
            variant="outline"
            className="w-fit"
            disabled={receivables.isFetchingNextPage}
            onClick={() => void receivables.fetchNextPage()}
          >
            {t('more')}
          </Button>
        ) : null}
      </ListState>
    </div>
  );
}
