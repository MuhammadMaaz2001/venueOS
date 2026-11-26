'use client';

import type { AvailabilityCellDto, AvailabilityDto } from '@venueos/shared';
import { localDateIn } from '@venueos/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { SelectField } from '@/components/form-fields';
import { FormDialog, NoAccess } from '@/components/resource-ui';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useVenues } from '../setup/api';
import { useFormatters, useSession } from '../shell/session';
import { useAvailability } from './api';
import {
  cellKey,
  datesBetween,
  indexCells,
  shiftDate,
  shiftMonth,
  slotOffered,
  viewRange,
} from './logic';
import { QuickHoldDialog } from './quick-hold-dialog';
import type { QuickHoldTarget } from './quick-hold-dialog';
import { HoldCountdown, StatusBadge } from './parts';

type View = 'month' | 'week';
type Slot = AvailabilityDto['slots'][number];
type Space = AvailabilityDto['spaces'][number];

/** Phones (under 640 px) get a list of one day; larger screens the grid. Only one of them is in the page. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia('(max-width: 639px)');
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia('(max-width: 639px)').matches,
    () => false,
  );
}

const CELL_CLASS = {
  free: 'bg-background hover:bg-muted/60 text-muted-foreground',
  HELD: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  CONFIRMED: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  off: 'bg-muted/40 text-muted-foreground/60',
} as const;

interface CellProps {
  space: Space;
  slot: Slot;
  date: string;
  cell: AvailabilityCellDto | undefined;
  canHold: boolean;
  onFree: (target: QuickHoldTarget) => void;
  onBooked: (cell: AvailabilityCellDto, space: Space, slot: Slot) => void;
  compact?: boolean;
}

function Cell({ space, slot, date, cell, canHold, onFree, onBooked, compact }: CellProps) {
  const t = useTranslations('Bookings.calendar');
  if (!slotOffered(slot, date)) {
    return (
      <div
        className={cn('flex h-10 items-center justify-center rounded text-xs', CELL_CLASS.off)}
        data-testid="cal-cell"
        data-status="off"
        aria-label={t('notOffered', { space: space.name, slot: slot.name, date })}
      >
        –
      </div>
    );
  }
  const status = cell?.status ?? 'free';
  const first = cell?.entries[0];
  const label = cell
    ? `${space.name}, ${slot.name}, ${date}: ${t(cell.status === 'HELD' ? 'held' : 'confirmed')}${first ? `, ${first.customerName}` : ''}`
    : `${space.name}, ${slot.name}, ${date}: ${t('free')}`;
  const common = {
    'data-testid': 'cal-cell',
    'data-status': status,
    'data-space': space.name,
    'data-slot': slot.name,
    'data-date': date,
    'aria-label': label,
    className: cn(
      'flex h-10 w-full items-center justify-center overflow-hidden rounded border px-1 text-xs',
      CELL_CLASS[status],
      compact && 'h-12 justify-start px-3 text-sm',
    ),
  };
  if (cell) {
    return (
      <button type="button" {...common} onClick={() => onBooked(cell, space, slot)}>
        <span className="truncate">
          {compact || !first
            ? `${first?.customerName ?? ''}`
            : (first.number ?? t(cell.status === 'HELD' ? 'heldShort' : 'confirmedShort'))}
        </span>
      </button>
    );
  }
  if (!canHold) {
    return (
      <div {...common}>
        <span aria-hidden>{compact ? t('free') : ''}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      {...common}
      onClick={() =>
        onFree({
          spaceId: space.id,
          spaceName: space.name,
          slotId: slot.id,
          slotName: slot.name,
          date,
        })
      }
    >
      <span>{compact ? t('free') : ''}</span>
    </button>
  );
}

function Legend() {
  const t = useTranslations('Bookings.calendar');
  return (
    <ul
      className="flex flex-wrap gap-3 text-xs"
      aria-label={t('legend')}
      data-testid="calendar-legend"
    >
      {(['free', 'HELD', 'CONFIRMED', 'off'] as const).map((key) => (
        <li key={key} className="flex items-center gap-1.5">
          <span className={cn('inline-block size-4 rounded border', CELL_CLASS[key])} aria-hidden />
          {t(`legendItems.${key}`)}
        </li>
      ))}
    </ul>
  );
}

/** The grid: a row per space and slot, a column per day; scrolls sideways inside its own box. */
function Grid({
  data,
  dates,
  ...handlers
}: {
  data: AvailabilityDto;
  dates: string[];
  canHold: boolean;
  onFree: (target: QuickHoldTarget) => void;
  onBooked: (cell: AvailabilityCellDto, space: Space, slot: Slot) => void;
}) {
  const t = useTranslations('Bookings.calendar');
  const format = useFormatters();
  const index = useMemo(() => indexCells(data.cells), [data.cells]);
  return (
    <div className="overflow-x-auto rounded-lg border" data-testid="calendar-grid">
      <table className="w-max min-w-full border-collapse text-sm">
        <caption className="sr-only">{t('gridCaption')}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="bg-background sticky start-0 z-10 min-w-36 border-b p-2 text-start"
            >
              {t('spaceSlot')}
            </th>
            {dates.map((date) => (
              <th
                key={date}
                scope="col"
                className="min-w-14 border-b p-1 text-center text-xs font-medium"
              >
                {format.dateOnly(date, 'short')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.spaces.map((space) =>
            data.slots.map((slot) => (
              <tr key={`${space.id}-${slot.id}`} data-testid="calendar-row">
                <th
                  scope="row"
                  className="bg-background sticky start-0 z-10 border-b p-2 text-start font-normal"
                >
                  <span className="font-medium">{space.name}</span>
                  <span className="text-muted-foreground block text-xs">
                    {slot.name} · {slot.startTime}–{slot.endTime}
                  </span>
                </th>
                {dates.map((date) => (
                  <td key={date} className="border-b p-0.5">
                    <Cell
                      space={space}
                      slot={slot}
                      date={date}
                      cell={index.get(cellKey(space.id, date, slot.id))}
                      {...handlers}
                    />
                  </td>
                ))}
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The phone layout: one day at a time, each space with its slots. */
function DayList({
  data,
  day,
  onDay,
  from,
  to,
  ...handlers
}: {
  data: AvailabilityDto;
  day: string;
  onDay: (day: string) => void;
  from: string;
  to: string;
  canHold: boolean;
  onFree: (target: QuickHoldTarget) => void;
  onBooked: (cell: AvailabilityCellDto, space: Space, slot: Slot) => void;
}) {
  const t = useTranslations('Bookings.calendar');
  const format = useFormatters();
  const index = useMemo(() => indexCells(data.cells), [data.cells]);
  const current = day < from ? from : day > to ? to : day;
  return (
    <div className="grid gap-3" data-testid="calendar-daylist">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label={t('prevDay')}
          disabled={current <= from}
          onClick={() => onDay(shiftDate(current, -1))}
        >
          <ChevronLeft className="rtl:rotate-180" aria-hidden />
        </Button>
        <p className="text-sm font-medium" data-testid="daylist-date">
          {format.dateOnly(current, 'long')}
        </p>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('nextDay')}
          disabled={current >= to}
          onClick={() => onDay(shiftDate(current, 1))}
        >
          <ChevronRight className="rtl:rotate-180" aria-hidden />
        </Button>
      </div>
      {data.spaces.map((space) => (
        <section key={space.id} className="grid gap-1.5" aria-label={space.name}>
          <h3 className="text-sm font-semibold">{space.name}</h3>
          {data.slots.map((slot) => (
            <div key={slot.id} className="grid grid-cols-[6rem_1fr] items-center gap-2">
              <span className="text-muted-foreground text-xs">
                {slot.name}
                <br />
                {slot.startTime}–{slot.endTime}
              </span>
              <Cell
                space={space}
                slot={slot}
                date={current}
                cell={index.get(cellKey(space.id, current, slot.id))}
                compact
                {...handlers}
              />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** What is behind a taken cell: who holds it. Prices are never part of the availability answer. */
function BookedDialog({
  picked,
  onClose,
  mayOpen,
}: {
  picked: { cell: AvailabilityCellDto; space: Space; slot: Slot } | null;
  onClose: () => void;
  mayOpen: boolean;
}) {
  const t = useTranslations('Bookings.calendar');
  const format = useFormatters();
  return (
    <FormDialog
      open={picked !== null}
      onClose={onClose}
      title={picked ? `${picked.space.name} · ${picked.slot.name}` : ''}
      description={picked ? format.dateOnly(picked.cell.date, 'long') : ''}
    >
      {picked ? (
        <ul className="grid gap-3" data-testid="booked-detail">
          {picked.cell.entries.map((entry) => (
            <li key={entry.sessionId} className="grid gap-1 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={entry.status === 'HELD' ? 'TENTATIVE' : 'CONFIRMED'} />
                <span className="font-medium">{entry.number ?? t('noNumber')}</span>
              </div>
              <span>{entry.customerName}</span>
              {entry.eventTypeName ? (
                <span className="text-muted-foreground">{entry.eventTypeName}</span>
              ) : null}
              {entry.blockedBy && entry.blockedBy !== picked.space.id ? (
                <span className="text-muted-foreground text-xs">
                  {t('blockedByComponent', {
                    name: picked.space.name,
                  })}
                </span>
              ) : null}
              {entry.holdExpiresAt ? (
                <span className="text-muted-foreground text-xs">
                  {t('holdEnds')}: <HoldCountdown holdExpiresAt={entry.holdExpiresAt} />
                </span>
              ) : null}
              {mayOpen ? (
                <Link
                  href={`/bookings/${entry.bookingId}`}
                  className="w-fit text-sm underline"
                  data-testid="booked-open"
                >
                  {t('openBooking')}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </FormDialog>
  );
}

/** The availability calendar (module 6): month or week, one venue at a time. */
export function CalendarPage() {
  const t = useTranslations('Bookings.calendar');
  const { can, tenant } = useSession();
  const venues = useVenues({ enabled: can('venue.view') });
  const today = useMemo(() => localDateIn(new Date(), tenant.timezone), [tenant.timezone]);
  const [venueChoice, setVenueChoice] = useState('');
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(today);
  const [day, setDay] = useState(today);
  const [free, setFree] = useState<QuickHoldTarget | null>(null);
  const [booked, setBooked] = useState<{
    cell: AvailabilityCellDto;
    space: Space;
    slot: Slot;
  } | null>(null);
  const narrow = useNarrow();

  const venueList = venues.data?.data ?? [];
  const venueId = venueChoice || venueList[0]?.id || '';

  // The phone shows a month of data too, and a day of it at a time.
  const effectiveView: View = narrow ? 'month' : view;
  const range = viewRange(effectiveView, anchor);
  const availability = useAvailability(venueId, range.from, range.to);
  const dates = datesBetween(range.from, range.to);
  const format = useFormatters();

  if (!can('booking.view')) return <NoAccess text={t('noAccess')} />;
  const canHold = can('booking.create') && can('quotation.manage') && can('booking.hold');
  const step = (direction: 1 | -1) => {
    if (effectiveView === 'month') setAnchor(shiftMonth(anchor, direction));
    else setAnchor(shiftDate(anchor, 7 * direction));
    setDay(
      effectiveView === 'month' ? shiftMonth(anchor, direction) : shiftDate(anchor, 7 * direction),
    );
  };

  return (
    <div className="grid gap-4" data-testid="calendar-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-44">
            <SelectField
              label={t('venue')}
              value={venueId}
              onChange={(event) => setVenueChoice(event.target.value)}
              data-testid="calendar-venue"
            >
              {venueList.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  {venue.name}
                </option>
              ))}
            </SelectField>
          </div>
          {!narrow ? (
            <div className="flex gap-1" role="group" aria-label={t('view')}>
              {(['month', 'week'] as const).map((id) => (
                <Button
                  key={id}
                  type="button"
                  variant={view === id ? 'default' : 'outline'}
                  className="h-10"
                  aria-pressed={view === id}
                  onClick={() => setView(id)}
                  data-testid={`calendar-view-${id}`}
                >
                  {t(id)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label={t('previous')} onClick={() => step(-1)}>
            <ChevronLeft className="rtl:rotate-180" aria-hidden />
          </Button>
          <Button
            variant="outline"
            className="h-10"
            onClick={() => {
              setAnchor(today);
              setDay(today);
            }}
          >
            {t('today')}
          </Button>
          <Button variant="outline" size="icon" aria-label={t('next')} onClick={() => step(1)}>
            <ChevronRight className="rtl:rotate-180" aria-hidden />
          </Button>
        </div>
        <p className="text-sm font-medium" data-testid="calendar-range">
          {format.dateOnly(range.from, 'short')} – {format.dateOnly(range.to, 'short')}
        </p>
      </div>
      <Legend />

      {venueList.length === 0 && !venues.isPending ? (
        <Alert role="status">
          <AlertDescription>{t('noVenues')}</AlertDescription>
        </Alert>
      ) : availability.isPending && venueId !== '' ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : availability.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : availability.data ? (
        availability.data.spaces.length === 0 || availability.data.slots.length === 0 ? (
          <Alert role="status">
            <AlertDescription>{t('nothingToShow')}</AlertDescription>
          </Alert>
        ) : narrow ? (
          <DayList
            data={availability.data}
            day={day}
            onDay={setDay}
            from={range.from}
            to={range.to}
            canHold={canHold}
            onFree={setFree}
            onBooked={(cell, space, slot) => setBooked({ cell, space, slot })}
          />
        ) : (
          <Grid
            data={availability.data}
            dates={dates}
            canHold={canHold}
            onFree={setFree}
            onBooked={(cell, space, slot) => setBooked({ cell, space, slot })}
          />
        )
      ) : null}

      <BookedDialog picked={booked} onClose={() => setBooked(null)} mayOpen={can('booking.view')} />
      <QuickHoldDialog venueId={venueId} target={free} onClose={() => setFree(null)} />
    </div>
  );
}
