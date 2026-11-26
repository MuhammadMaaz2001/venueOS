'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { useFormatters, useSession } from '../shell/session';
import { useReceivablesSummary } from './api';

/** The dashboard cards "due this week" and "overdue" (`payment.view`). */
export function PaymentsCard() {
  const t = useTranslations('Payments.dashboard');
  const { can } = useSession();
  const format = useFormatters();
  const summary = useReceivablesSummary(can('payment.view'));
  if (!can('payment.view')) return null;
  const data = summary.data;
  return (
    <div className="grid gap-4 sm:grid-cols-2" data-testid="payments-card">
      {(['dueThisWeek', 'overdue'] as const).map((key) => (
        <Card key={key}>
          <CardHeader>
            <CardDescription>{t(key)}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-1" data-testid={`dashboard-${key}`}>
            {data ? (
              <>
                <p
                  className={`text-lg font-semibold tabular-nums ${key === 'overdue' && data.overdue.count > 0 ? 'text-destructive' : ''}`}
                >
                  {format.money(data[key].amount)}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t('bookings', { count: data[key].count })}
                </p>
                <Link
                  href={key === 'overdue' ? '/receivables?overdue=true' : '/receivables'}
                  className="text-sm underline"
                >
                  {t('open')}
                </Link>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">{t('loading')}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
