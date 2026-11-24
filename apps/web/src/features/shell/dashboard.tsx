'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { useVenues } from '../setup/api';
import { useSession } from './session';

/** The landing page of the shell. The real dashboard (calendar, today's events) arrives with its module. */
export function Dashboard() {
  const t = useTranslations('Dashboard');
  const { user, tenant, access, can } = useSession();
  const router = useRouter();

  // First login of a new workspace: no venue yet, so the setup wizard comes first. Only for people who may set
  // venues up and see all of them (someone limited to some venues cannot create the first one).
  const mayRunSetup = can('venue.manage') && access.venueIds.length === 0;
  const venues = useVenues({ includeInactive: true, enabled: mayRunSetup });
  const needsSetup = venues.isSuccess && venues.data.data.length === 0;
  useEffect(() => {
    if (needsSetup) router.replace('/setup');
  }, [needsSetup, router]);

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('welcome', { name: user.name })}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle', { tenant: tenant.name })}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>{t('workspace')}</CardDescription>
            <p className="text-lg font-medium">{tenant.name}</p>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{t(`status.${tenant.status}`)}</Badge>
            <span className="text-muted-foreground text-xs">
              {tenant.currency} · {tenant.timezone}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>{t('yourRole')}</CardDescription>
            <p className="text-lg font-medium">{access.roleName}</p>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            {access.venueIds.length === 0
              ? t('allVenues')
              : t('someVenues', { count: access.venueIds.length })}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="text-muted-foreground text-sm">{t('comingSoon')}</CardContent>
      </Card>
    </div>
  );
}
