'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { useFormatters, useSession } from '../shell/session';
import { useLeadFollowUps } from './api';

/** The dashboard card "follow-ups due today / overdue" (`lead.view`): mine by default, or everyone's. */
export function FollowUpsCard() {
  const t = useTranslations('Leads.dashboard');
  const { can } = useSession();
  const format = useFormatters();
  const [scope, setScope] = useState<'me' | 'any'>('me');
  const followUps = useLeadFollowUps(scope, can('lead.view'));
  if (!can('lead.view')) return null;
  const data = followUps.data;

  return (
    <Card data-testid="follow-ups-card">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardDescription>{t('title')}</CardDescription>
          <div className="flex gap-1" role="group" aria-label={t('scope')}>
            {(['me', 'any'] as const).map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant={scope === s ? 'default' : 'outline'}
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
                data-testid={`follow-ups-scope-${s}`}
              >
                {t(`scopes.${s}`)}
              </Button>
            ))}
          </div>
        </div>
        {data ? (
          <div className="flex flex-wrap gap-3">
            <p className="text-lg font-medium">
              <span data-testid="follow-ups-overdue">{data.overdue}</span>{' '}
              <span className="text-muted-foreground text-sm font-normal">{t('overdue')}</span>
            </p>
            <p className="text-lg font-medium">
              <span data-testid="follow-ups-today">{data.dueToday}</span>{' '}
              <span className="text-muted-foreground text-sm font-normal">{t('dueToday')}</span>
            </p>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {followUps.isPending ? (
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        ) : followUps.isError || !data ? (
          <p role="alert" className="text-destructive text-sm">
            {t('loadFailed')}
          </p>
        ) : data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('none')}</p>
        ) : (
          <ul className="grid gap-2" data-testid="follow-ups-list">
            {data.items.map((lead) => (
              <li key={lead.id}>
                <Link
                  href={`/leads/${lead.id}`}
                  className="hover:bg-muted/50 flex flex-wrap items-center gap-2 rounded-md text-sm"
                >
                  <span className="font-medium">{lead.customer.name}</span>
                  <Badge
                    variant={
                      new Date(lead.nextFollowUpAt ?? 0) < new Date() ? 'destructive' : 'outline'
                    }
                  >
                    {lead.nextFollowUpAt ? format.dateTime(lead.nextFollowUpAt) : ''}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link href="/leads" className="mt-3 block text-sm underline">
          {t('openLeads')}
        </Link>
      </CardContent>
    </Card>
  );
}
