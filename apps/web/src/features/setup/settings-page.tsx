'use client';

import { UpdateTenantSettingsSchema } from '@venueos/shared';
import type { EventTypeDto, TenantSettingsResponse } from '@venueos/shared';
import { Pencil, Plus, Power } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { SubmitButton, TextField } from '@/components/form-fields';
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
import {
  useCreateEventType,
  useEventTypes,
  useTenantSettings,
  useUpdateEventType,
  useUpdateTenantSettings,
} from './api';
import { showServerFieldErrors, useSharedSchemaResolver } from './form-resolver';
import type { Translate } from './form-resolver';

/** Workspace settings (`tenant.settings.manage`) and the event types of the workspace (`venue.manage`). */
export function SettingsPage() {
  const t = useTranslations('Setup.settings');
  const { can } = useSession();
  const settings = useTenantSettings();

  if (!can('tenant.settings.manage')) {
    return (
      <Alert variant="destructive" role="alert" className="mx-auto max-w-3xl">
        <AlertDescription>{t('noAccess')}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      {settings.isPending ? (
        <Skeleton className="h-64 w-full" aria-busy="true" />
      ) : settings.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent>
            <SettingsForm key={settings.data.rev} settings={settings.data} />
          </CardContent>
        </Card>
      )}
      {can('venue.manage') ? <EventTypesSection /> : null}
    </div>
  );
}

interface Values {
  name: string;
  timezone: string;
  bookingPrefix: string;
  holdHours: string;
  advancePct: string;
  tokenAmount: string;
  balanceDueDays: string;
  guestLockDays: string;
  reminderDays: string;
  eventReminderDays: string;
  minHours: string;
}

const NUMERIC = [
  'holdHours',
  'advancePct',
  'balanceDueDays',
  'guestLockDays',
  'reminderDays',
  'eventReminderDays',
  'minHours',
] as const;

function SettingsForm({ settings }: { settings: TenantSettingsResponse }) {
  const t = useTranslations('Setup.settings');
  const tv = useTranslations('Validation');
  const update = useUpdateTenantSettings();

  const toPayload = (v: Values) => ({
    rev: settings.rev,
    name: v.name.trim(),
    timezone: v.timezone.trim(),
    settings: {
      bookingPrefix: v.bookingPrefix.trim(),
      tokenAmount: v.tokenAmount.trim(),
      ...Object.fromEntries(
        NUMERIC.map((key) => [key, v[key].trim() === '' ? undefined : Number(v[key])]),
      ),
    },
  });

  const form = useForm<Values>({
    defaultValues: {
      name: settings.name,
      timezone: settings.timezone,
      bookingPrefix: settings.settings.bookingPrefix,
      tokenAmount: settings.settings.tokenAmount,
      ...Object.fromEntries(NUMERIC.map((key) => [key, String(settings.settings[key])])),
    } as Values,
    resolver: useSharedSchemaResolver<Values>(UpdateTenantSettingsSchema, toPayload),
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await update.mutateAsync(toPayload(values) as Parameters<typeof update.mutateAsync>[0]);
      toast.success(t('saved'));
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  const number = (key: (typeof NUMERIC)[number], hint?: string) => (
    <TextField
      label={t(`fields.${key}`)}
      hint={hint}
      inputMode="numeric"
      error={errors[key]?.message}
      {...form.register(key)}
    />
  );

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-6" data-testid="settings-form">
      <section className="grid gap-4">
        <h2 className="text-lg font-medium">{t('workspace')}</h2>
        <TextField
          label={t('fields.name')}
          error={errors.name?.message}
          {...form.register('name')}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label={t('fields.currency')}
            value={settings.currency}
            readOnly
            disabled
            hint={t('currencyFixed')}
          />
          <TextField label={t('fields.country')} value={settings.country} readOnly disabled />
          <TextField
            label={t('fields.timezone')}
            hint={t('timezoneHint')}
            isolate
            error={errors.timezone?.message}
            {...form.register('timezone')}
          />
        </div>
      </section>
      <section className="grid gap-4">
        <h2 className="text-lg font-medium">{t('bookings')}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('fields.bookingPrefix')}
            hint={t('bookingPrefixHint')}
            isolate
            error={errors.bookingPrefix?.message}
            {...form.register('bookingPrefix')}
          />
          {number('holdHours', t('holdHoursHint'))}
          {number('guestLockDays', t('guestLockDaysHint'))}
          {number('minHours', t('minHoursHint'))}
        </div>
      </section>
      <section className="grid gap-4">
        <h2 className="text-lg font-medium">{t('payments')}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {number('advancePct', t('advancePctHint'))}
          <TextField
            label={t('fields.tokenAmount', { currency: settings.currency })}
            hint={t('tokenAmountHint')}
            inputMode="decimal"
            isolate
            error={errors.tokenAmount?.message}
            {...form.register('tokenAmount')}
          />
          {number('balanceDueDays', t('balanceDueDaysHint'))}
        </div>
      </section>
      <section className="grid gap-4">
        <h2 className="text-lg font-medium">{t('reminders')}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {number('reminderDays', t('reminderDaysHint'))}
          {number('eventReminderDays', t('eventReminderDaysHint'))}
        </div>
      </section>
      <SubmitButton pending={update.isPending} className="sm:w-fit sm:px-8">
        {t('save')}
      </SubmitButton>
    </form>
  );
}

// ───────────────────────────── event types ─────────────────────────────

function EventTypesSection() {
  const t = useTranslations('Setup.eventTypes');
  const { access } = useSession();
  const eventTypes = useEventTypes({ includeInactive: true });
  const update = useUpdateEventType();
  const [dialog, setDialog] = useState<
    { kind: 'add' } | { kind: 'edit'; type: EventTypeDto } | null
  >(null);
  // Event types belong to the whole workspace: someone limited to some venues may look, not change.
  const mayEdit = access.venueIds.length === 0;

  const toggle = async (type: EventTypeDto) => {
    try {
      await update.mutateAsync({ id: type.id, rev: type.rev, active: !type.active });
    } catch {
      // Toasted globally.
    }
  };

  return (
    <section aria-labelledby="event-types-heading" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="event-types-heading" className="text-lg font-medium">
            {t('title')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {mayEdit ? (
          <Button
            type="button"
            size="lg"
            className="h-10"
            onClick={() => setDialog({ kind: 'add' })}
            data-testid="event-type-add"
          >
            <Plus aria-hidden />
            {t('add')}
          </Button>
        ) : null}
      </div>
      {eventTypes.isPending ? (
        <Skeleton className="h-16 w-full" aria-busy="true" />
      ) : eventTypes.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : eventTypes.data.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y" data-testid="event-type-list">
              {eventTypes.data.data.map((type) => (
                <li
                  key={type.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                  data-testid="event-type-row"
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {type.color ? (
                      <span
                        className="inline-block size-3 rounded-full"
                        style={{ backgroundColor: type.color }}
                        aria-hidden
                      />
                    ) : null}
                    {type.name}
                    {!type.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
                  </span>
                  {mayEdit ? (
                    <span className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="h-9"
                        onClick={() => setDialog({ kind: 'edit', type })}
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
                        onClick={() => toggle(type)}
                      >
                        <Power aria-hidden />
                        {type.active ? t('deactivate') : t('reactivate')}
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.kind === 'edit' ? t('editTitle') : t('addTitle')}</DialogTitle>
            <DialogDescription>{t('formDescription')}</DialogDescription>
          </DialogHeader>
          {dialog ? (
            <EventTypeForm
              key={dialog.kind === 'edit' ? `${dialog.type.id}:${dialog.type.rev}` : 'new'}
              {...(dialog.kind === 'edit' ? { type: dialog.type } : {})}
              onDone={() => setDialog(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function EventTypeForm({ type, onDone }: { type?: EventTypeDto; onDone: () => void }) {
  const t = useTranslations('Setup.eventTypes');
  const tv = useTranslations('Validation');
  const create = useCreateEventType();
  const update = useUpdateEventType();
  const [name, setName] = useState(type?.name ?? '');
  const [color, setColor] = useState(type?.color ?? '');
  const [nameError, setNameError] = useState<string | undefined>();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') {
      setNameError(tv('required'));
      return;
    }
    setNameError(undefined);
    try {
      if (type) {
        await update.mutateAsync({
          id: type.id,
          rev: type.rev,
          name: name.trim(),
          color: color.trim() === '' ? null : color.trim(),
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          ...(color.trim() === '' ? {} : { color: color.trim() }),
        });
      }
      toast.success(t('saved'));
      onDone();
    } catch {
      // Toasted globally (duplicate name, bad colour, a newer version).
    }
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4" data-testid="event-type-form">
      <TextField
        label={t('fields.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={nameError}
        autoComplete="off"
      />
      <TextField
        label={t('fields.color')}
        hint={t('colorHint')}
        value={color}
        onChange={(e) => setColor(e.target.value)}
        isolate
        placeholder="#FF8800"
      />
      <SubmitButton pending={create.isPending || update.isPending}>{t('save')}</SubmitButton>
    </form>
  );
}
