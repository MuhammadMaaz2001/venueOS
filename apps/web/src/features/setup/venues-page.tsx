'use client';

import { Building2, ChevronRight, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../shell/session';
import { useVenues } from './api';
import { VenueForm } from './venue-form';

/** The venues (branches) of the workspace; people limited to some venues see only theirs. */
export function VenuesPage() {
  const t = useTranslations('Setup.venues');
  const { can, access } = useSession();
  const venues = useVenues({ includeInactive: true });
  const [adding, setAdding] = useState(false);

  if (!can('venue.manage')) {
    return (
      <Alert variant="destructive" role="alert" className="mx-auto max-w-3xl">
        <AlertDescription>{t('noAccess')}</AlertDescription>
      </Alert>
    );
  }
  // A new venue is outside the scope of someone limited to some venues, so only people with all venues add one.
  const mayAdd = access.venueIds.length === 0;

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {mayAdd ? (
          <Button
            size="lg"
            className="h-10"
            onClick={() => setAdding(true)}
            data-testid="venue-add"
          >
            <Plus aria-hidden />
            {t('add')}
          </Button>
        ) : null}
      </div>

      {venues.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : venues.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : venues.data.data.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3">
            <p className="text-muted-foreground text-sm">{t('empty')}</p>
            {mayAdd ? (
              <Button asChild className="h-10">
                <Link href="/setup">{t('startSetup')}</Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y" data-testid="venue-list">
              {venues.data.data.map((venue) => (
                <li key={venue.id} data-testid="venue-row">
                  <Link
                    href={`/venues/${venue.id}`}
                    className="hover:bg-muted/50 flex min-h-16 items-center gap-3 px-4 py-3"
                  >
                    <Building2 className="text-muted-foreground size-5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="truncate">{venue.name}</span>
                        {!venue.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {[venue.city, venue.address].filter(Boolean).join(' · ') || t('noAddress')}
                      </span>
                    </span>
                    <ChevronRight
                      className="text-muted-foreground size-4 shrink-0 rtl:rotate-180"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('addTitle')}</DialogTitle>
            <DialogDescription>{t('addDescription')}</DialogDescription>
          </DialogHeader>
          <VenueForm submitLabel={t('addSubmit')} onDone={() => setAdding(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
