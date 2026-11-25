'use client';

import { ArrowLeft, Pencil, Plus, Power, Tag } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import type { SlotTemplateDto, SpaceDto, VenueDto } from '@venueos/shared';
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
import { isApiError } from '@/lib/api/errors';
import { useFormatters, useSession } from '../shell/session';
import {
  useSlots,
  useSpaces,
  useUpdateSlot,
  useUpdateSpace,
  useUpdateVenue,
  useVenue,
} from './api';
import { describeDays, endsNextDay } from './logic';
import { PricesForm } from './prices-form';
import { SlotForm } from './slot-form';
import { SpaceForm } from './space-form';
import { VenueForm } from './venue-form';

/** One venue: its details, its spaces (with rent per slot) and its slot templates. */
export function VenueDetail({ id }: { id: string }) {
  const t = useTranslations('Setup.venue');
  const { can } = useSession();
  const venue = useVenue(id);
  const canEdit = can('venue.manage');

  if (!can('venue.view')) {
    return (
      <Alert variant="destructive" role="alert" className="mx-auto max-w-3xl">
        <AlertDescription>{t('noAccess')}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <Link
        href="/venues"
        className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
        {t('back')}
      </Link>
      {venue.isPending ? (
        <Skeleton className="h-40 w-full" aria-busy="true" />
      ) : venue.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {isApiError(venue.error) && venue.error.code === 'NOT_FOUND'
              ? t('notFound')
              : t('loadFailed')}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <VenueSection venue={venue.data} canEdit={canEdit} />
          <SpacesSection venue={venue.data} canEdit={canEdit} />
          <SlotsSection venue={venue.data} canEdit={canEdit} />
        </>
      )}
    </div>
  );
}

function VenueSection({ venue, canEdit }: { venue: VenueDto; canEdit: boolean }) {
  const t = useTranslations('Setup.venue');
  const tf = useTranslations('Setup.fields');
  const update = useUpdateVenue();

  const toggle = async () => {
    try {
      await update.mutateAsync({ id: venue.id, rev: venue.rev, active: !venue.active });
      toast.success(venue.active ? t('deactivated') : t('reactivated'));
    } catch {
      // The global handler showed the reason (plan limit when reactivating, a newer version, ...).
    }
  };

  return (
    <section aria-labelledby="venue-heading" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="venue-heading" className="flex items-center gap-2 text-2xl font-semibold">
          {venue.name}
          {!venue.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
        </h1>
        {canEdit ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-10"
            disabled={update.isPending}
            onClick={toggle}
            data-testid="venue-toggle"
          >
            <Power aria-hidden />
            {venue.active ? t('deactivate') : t('reactivate')}
          </Button>
        ) : null}
      </div>
      <Card>
        <CardContent>
          {/* Keyed by the version: after a save or a reload the form starts from what the server has. */}
          {canEdit ? (
            <VenueForm key={`${venue.id}:${venue.rev}`} venue={venue} submitLabel={t('save')} />
          ) : (
            <dl className="grid gap-2 text-sm" data-testid="venue-readonly">
              {[
                [tf('city'), venue.city],
                [tf('address'), venue.address],
                [
                  tf('openingHours'),
                  venue.opensAt && venue.closesAt ? `${venue.opensAt}–${venue.closesAt}` : null,
                ],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-wrap gap-2">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd>{value ?? '—'}</dd>
                </div>
              ))}
            </dl>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ───────────────────────────── spaces ─────────────────────────────

type SpaceDialog =
  { kind: 'add' } | { kind: 'edit'; space: SpaceDto } | { kind: 'prices'; space: SpaceDto };

function SpacesSection({ venue, canEdit }: { venue: VenueDto; canEdit: boolean }) {
  const t = useTranslations('Setup.spaces');
  const tk = useTranslations('Setup.kinds');
  const { money } = useFormatters();
  const spaces = useSpaces(venue.id, { includeInactive: true });
  const slots = useSlots(venue.id);
  const update = useUpdateSpace();
  const [dialog, setDialog] = useState<SpaceDialog | null>(null);

  const toggle = async (space: SpaceDto) => {
    try {
      await update.mutateAsync({ id: space.id, rev: space.rev, active: !space.active });
      toast.success(space.active ? t('deactivated') : t('reactivated'));
    } catch {
      // Toasted globally (plan limit, "part of a combined space", a newer version).
    }
  };
  const all = spaces.data?.data ?? [];

  return (
    <section aria-labelledby="spaces-heading" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="spaces-heading" className="text-lg font-medium">
          {t('title')}
        </h2>
        {canEdit ? (
          <Button
            type="button"
            size="lg"
            className="h-10"
            disabled={!venue.active}
            onClick={() => setDialog({ kind: 'add' })}
            data-testid="space-add"
          >
            <Plus aria-hidden />
            {t('add')}
          </Button>
        ) : null}
      </div>
      {spaces.isPending ? (
        <Skeleton className="h-16 w-full" aria-busy="true" />
      ) : spaces.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : all.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y" data-testid="space-list">
              {all.map((space) => (
                <li key={space.id} className="grid gap-2 px-4 py-3" data-testid="space-row">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{space.name}</span>
                    <Badge variant="outline">{tk(space.kind)}</Badge>
                    {space.isCombined ? <Badge variant="secondary">{t('combined')}</Badge> : null}
                    {!space.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {[
                      space.capacitySeated === null
                        ? null
                        : t('seated', { count: space.capacitySeated }),
                      space.capacityStanding === null
                        ? null
                        : t('standing', { count: space.capacityStanding }),
                      space.baseRent === null
                        ? null
                        : t('baseRent', { amount: money(space.baseRent) }),
                      space.isCombined
                        ? t('madeOf', {
                            names: space.componentIds
                              .map((c) => all.find((s) => s.id === c)?.name)
                              .filter(Boolean)
                              .join(' + '),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {canEdit ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="h-9"
                        onClick={() => setDialog({ kind: 'edit', space })}
                      >
                        <Pencil aria-hidden />
                        {t('edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="h-9"
                        disabled={!space.active || (slots.data?.data.length ?? 0) === 0}
                        onClick={() => setDialog({ kind: 'prices', space })}
                      >
                        <Tag aria-hidden />
                        {t('prices')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="lg"
                        className="h-9"
                        disabled={update.isPending}
                        onClick={() => toggle(space)}
                      >
                        <Power aria-hidden />
                        {space.active ? t('deactivate') : t('reactivate')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          {dialog?.kind === 'add' ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('addTitle')}</DialogTitle>
                <DialogDescription>{t('addDescription')}</DialogDescription>
              </DialogHeader>
              <SpaceForm
                venueId={venue.id}
                physicalSpaces={all.filter((s) => s.active)}
                submitLabel={t('addSubmit')}
                onDone={() => setDialog(null)}
              />
            </>
          ) : null}
          {dialog?.kind === 'edit' ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('editTitle', { name: dialog.space.name })}</DialogTitle>
                <DialogDescription>{t('editDescription')}</DialogDescription>
              </DialogHeader>
              <SpaceForm
                key={`${dialog.space.id}:${dialog.space.rev}`}
                venueId={venue.id}
                space={dialog.space}
                physicalSpaces={all.filter((s) => s.active)}
                submitLabel={t('save')}
                onDone={() => setDialog(null)}
              />
            </>
          ) : null}
          {dialog?.kind === 'prices' ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('pricesTitle', { name: dialog.space.name })}</DialogTitle>
                <DialogDescription>{t('pricesDescription')}</DialogDescription>
              </DialogHeader>
              <PricesForm
                space={dialog.space}
                slots={slots.data?.data ?? []}
                submitLabel={t('save')}
                onDone={() => setDialog(null)}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ───────────────────────────── slots ─────────────────────────────

type SlotDialog = { kind: 'add' } | { kind: 'edit'; slot: SlotTemplateDto };

function SlotsSection({ venue, canEdit }: { venue: VenueDto; canEdit: boolean }) {
  const t = useTranslations('Setup.slots');
  const tm = useTranslations('Setup.modes');
  const td = useTranslations('Setup.days');
  const slots = useSlots(venue.id, { includeInactive: true });
  const update = useUpdateSlot();
  const [dialog, setDialog] = useState<SlotDialog | null>(null);

  const toggle = async (slot: SlotTemplateDto) => {
    try {
      await update.mutateAsync({ id: slot.id, rev: slot.rev, active: !slot.active });
      toast.success(slot.active ? t('deactivated') : t('reactivated'));
    } catch {
      // Toasted globally.
    }
  };

  return (
    <section aria-labelledby="slots-heading" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="slots-heading" className="text-lg font-medium">
          {t('title')}
        </h2>
        {canEdit ? (
          <Button
            type="button"
            size="lg"
            className="h-10"
            disabled={!venue.active}
            onClick={() => setDialog({ kind: 'add' })}
            data-testid="slot-add"
          >
            <Plus aria-hidden />
            {t('add')}
          </Button>
        ) : null}
      </div>
      {slots.isPending ? (
        <Skeleton className="h-16 w-full" aria-busy="true" />
      ) : slots.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : slots.data.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y" data-testid="slot-list">
              {slots.data.data.map((slot) => (
                <li key={slot.id} className="grid gap-2 px-4 py-3" data-testid="slot-row">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{slot.name}</span>
                    <Badge variant="outline">{tm(slot.mode)}</Badge>
                    {!slot.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {[
                      slot.mode === 'FULL_DAY'
                        ? t('wholeDay')
                        : `${slot.startTime}–${slot.endTime}${endsNextDay(slot) ? ` ${t('nextDay')}` : ''}`,
                      describeDays(slot.daysOfWeek, td('every'), (day) => td(`short.${day}`)),
                      slot.minHours === null ? null : t('minHours', { count: slot.minHours }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {canEdit ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="h-9"
                        onClick={() => setDialog({ kind: 'edit', slot })}
                      >
                        <Pencil aria-hidden />
                        {t('edit')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="lg"
                        className="h-9"
                        disabled={update.isPending}
                        onClick={() => toggle(slot)}
                      >
                        <Power aria-hidden />
                        {slot.active ? t('deactivate') : t('reactivate')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === 'edit' ? t('editTitle', { name: dialog.slot.name }) : t('addTitle')}
            </DialogTitle>
            <DialogDescription>{t('formDescription')}</DialogDescription>
          </DialogHeader>
          {dialog ? (
            <SlotForm
              key={dialog.kind === 'edit' ? `${dialog.slot.id}:${dialog.slot.rev}` : 'new'}
              venueId={venue.id}
              {...(dialog.kind === 'edit' ? { slot: dialog.slot } : {})}
              submitLabel={dialog.kind === 'edit' ? t('save') : t('addSubmit')}
              onDone={() => setDialog(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
