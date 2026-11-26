'use client';

import type { BookingStatus } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { TextField } from '@/components/form-fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDebounced } from '@/lib/use-debounced';
import { useCustomers } from '../customers/api';
import { useSession } from '../shell/session';
import { holdTimer, statusTone } from './logic';
import type { StatusTone } from './logic';

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: '',
  muted: 'bg-muted text-muted-foreground',
  warning: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  success: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  danger: 'bg-destructive/10 text-destructive',
};

/** The status of a booking as a coloured badge (colour is never the only signal: the text says it too). */
export function StatusBadge({ status }: { status: BookingStatus }) {
  const t = useTranslations('Bookings.status');
  return (
    <Badge
      variant="secondary"
      className={TONE_CLASS[statusTone(status)]}
      data-testid="booking-status"
    >
      {t(status)}
    </Badge>
  );
}

/** "1 day 4 h left" style text of a hold, refreshed every 30 seconds. */
export function HoldCountdown({ holdExpiresAt }: { holdExpiresAt: string }) {
  const t = useTranslations('Bookings.hold');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const left = holdTimer(holdExpiresAt, now);
  if (left.expired) return <span data-testid="hold-countdown">{t('ended')}</span>;
  const days = Math.floor(left.hours / 24);
  const hours = left.hours % 24;
  return (
    <span data-testid="hold-countdown">
      {days > 0
        ? t('leftDays', { days, hours })
        : t('leftHours', { hours: left.hours, minutes: left.minutes })}
    </span>
  );
}

export interface PickedCustomer {
  id: string;
  name: string;
  phone: string;
}

/** Search the customers of the workspace and pick one (the quotation needs a customer or a lead). */
export function CustomerPicker({
  value,
  onChange,
  error,
}: {
  value: PickedCustomer | null;
  onChange: (customer: PickedCustomer | null) => void;
  error?: string | undefined;
}) {
  const t = useTranslations('Bookings.customer');
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim());
  const found = useCustomers({
    search: debounced,
    enabled: can('customer.view') && debounced.length >= 2 && value === null,
  });
  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="picked-customer">
        <span className="text-sm font-medium">{value.name}</span>
        <span className="ltr-isolate text-muted-foreground text-sm">{value.phone}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          {t('change')}
        </Button>
      </div>
    );
  }
  const rows = found.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <div className="grid gap-2">
      <TextField
        label={t('label')}
        value={search}
        error={error}
        hint={t('hint')}
        autoComplete="off"
        onChange={(event) => setSearch(event.target.value)}
        data-testid="customer-search"
      />
      {debounced.length >= 2 ? (
        <ul className="divide-y rounded-lg border" data-testid="customer-results">
          {rows.length === 0 ? (
            <li className="text-muted-foreground p-3 text-sm">
              {found.isPending ? t('searching') : t('none')}
            </li>
          ) : (
            rows.slice(0, 8).map((customer) => (
              <li key={customer.id}>
                <button
                  type="button"
                  className="hover:bg-muted/50 flex min-h-11 w-full flex-wrap items-center gap-x-3 px-3 py-2 text-start text-sm"
                  onClick={() =>
                    onChange({ id: customer.id, name: customer.name, phone: customer.phone })
                  }
                  data-testid="customer-result"
                >
                  <span className="font-medium">{customer.name}</span>
                  <span className="ltr-isolate text-muted-foreground">{customer.phone}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
