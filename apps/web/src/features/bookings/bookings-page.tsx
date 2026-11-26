'use client';

import { BOOKING_STATUSES } from '@venueos/shared';
import type { BookingStatus } from '@venueos/shared';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { SelectField, TextField } from '@/components/form-fields';
import { ListState, NoAccess, RowList } from '@/components/resource-ui';
import { Button } from '@/components/ui/button';
import { useDebounced } from '@/lib/use-debounced';
import { useVenues } from '../setup/api';
import { useFormatters, useSession } from '../shell/session';
import { NO_BOOKING_FILTERS, useBookings } from './api';
import type { BookingFilters } from './api';
import { HoldCountdown, StatusBadge } from './parts';

/** The bookings list (module 8): filter by status, venue, date range and customer. Drafts are the quotations not yet held. */
export function BookingsPage() {
  const t = useTranslations('Bookings.list');
  const ts = useTranslations('Bookings.status');
  const { can } = useSession();
  const format = useFormatters();
  const venues = useVenues({ enabled: can('venue.view') });
  const [filters, setFilters] = useState<BookingFilters>(NO_BOOKING_FILTERS);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim());
  const effective = { ...filters, search: debounced };
  const bookings = useBookings(effective);
  if (!can('booking.view')) return <NoAccess text={t('noAccess')} />;
  const rows = bookings.data?.pages.flatMap((p) => p.data) ?? [];
  const set = (patch: Partial<BookingFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  const rangeInvalid = filters.from !== '' && filters.to !== '' && filters.from > filters.to;

  return (
    <div className="mx-auto grid max-w-5xl gap-4" data-testid="bookings-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        {can('quotation.manage') && can('booking.create') ? (
          <Button asChild size="lg" className="h-10">
            <Link href="/quotations/new" data-testid="new-quotation">
              <Plus aria-hidden />
              {t('newQuotation')}
            </Link>
          </Button>
        ) : null}
      </div>

      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        role="search"
        aria-label={t('filters')}
        onSubmit={(event) => event.preventDefault()}
      >
        <TextField
          label={t('search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-testid="bookings-search"
        />
        <SelectField
          label={t('status')}
          value={filters.status}
          onChange={(event) => set({ status: event.target.value as BookingStatus | '' })}
          data-testid="bookings-status"
        >
          <option value="">{t('allStatuses')}</option>
          {BOOKING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {ts(status)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('venue')}
          value={filters.venueId}
          onChange={(event) => set({ venueId: event.target.value })}
          data-testid="bookings-venue"
        >
          <option value="">{t('allVenues')}</option>
          {(venues.data?.data ?? []).map((venue) => (
            <option key={venue.id} value={venue.id}>
              {venue.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('from')}
          type="date"
          value={filters.from}
          onChange={(event) => set({ from: event.target.value })}
          data-testid="bookings-from"
        />
        <TextField
          label={t('to')}
          type="date"
          value={filters.to}
          error={rangeInvalid ? t('rangeInvalid') : undefined}
          onChange={(event) => set({ to: event.target.value })}
          data-testid="bookings-to"
        />
      </form>

      <ListState
        pending={bookings.isPending}
        failed={bookings.isError}
        empty={rows.length === 0}
        emptyText={t('empty')}
        loadFailedText={t('loadFailed')}
      >
        <RowList testId="bookings-list">
          {rows.map((booking) => (
            <li key={booking.id} data-testid="booking-row" data-status={booking.status}>
              <Link
                href={`/bookings/${booking.id}`}
                className="hover:bg-muted/50 block"
                data-testid="booking-open"
              >
                <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{booking.number ?? t('draft')}</span>
                      <StatusBadge status={booking.status} />
                    </div>
                    <span className="truncate text-sm">
                      {booking.customer.name} · {booking.venueName}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {booking.firstSessionAt
                        ? format.dateTime(booking.firstSessionAt)
                        : t('noSession')}
                      {booking.sessionCount > 1
                        ? ` · ${t('sessions', { n: booking.sessionCount })}`
                        : ''}
                      {booking.status === 'TENTATIVE' && booking.holdExpiresAt ? (
                        <>
                          {' · '}
                          <HoldCountdown holdExpiresAt={booking.holdExpiresAt} />
                        </>
                      ) : null}
                    </span>
                  </div>
                  {booking.grandTotal !== null ? (
                    <span className="ltr-isolate text-sm tabular-nums">
                      {format.money(booking.grandTotal)}
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </RowList>
        {bookings.hasNextPage ? (
          <Button
            variant="outline"
            className="w-fit"
            disabled={bookings.isFetchingNextPage}
            onClick={() => void bookings.fetchNextPage()}
            data-testid="bookings-more"
          >
            {t('more')}
          </Button>
        ) : null}
      </ListState>
    </div>
  );
}
