'use client';

import { CreateVenueSchema, UpdateVenueSchema } from '@venueos/shared';
import type { VenueDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { SubmitButton, TextField } from '@/components/form-fields';
import { useCreateVenue, useUpdateVenue } from './api';
import type { Translate } from './form-resolver';
import {
  numberOrUndefined,
  showServerFieldErrors,
  textOrNull,
  textOrUndefined,
  useSharedSchemaResolver,
} from './form-resolver';

interface Values {
  name: string;
  city: string;
  address: string;
  opensAt: string;
  closesAt: string;
  latestEndTime: string;
  maxGuests: string;
}

function initial(venue: VenueDto | undefined): Values {
  return {
    name: venue?.name ?? '',
    city: venue?.city ?? '',
    address: venue?.address ?? '',
    opensAt: venue?.opensAt ?? '',
    closesAt: venue?.closesAt ?? '',
    latestEndTime: venue?.localRules.latestEndTime ?? '',
    maxGuests: venue?.localRules.maxGuests === undefined ? '' : String(venue.localRules.maxGuests),
  };
}

/** The local rules as the API wants them: only the keys that are filled in. */
function localRules(v: Values) {
  const maxGuests = numberOrUndefined(v.maxGuests);
  return {
    ...(textOrUndefined(v.latestEndTime) === undefined
      ? {}
      : { latestEndTime: v.latestEndTime.trim() }),
    ...(maxGuests === undefined ? {} : { maxGuests }),
  };
}

/**
 * Add a venue, or edit one (`venue` given: the form sends the `rev` it was built from). Opening hours are for
 * hourly slots; both or none.
 */
export function VenueForm({
  venue,
  onDone,
  submitLabel,
}: {
  venue?: VenueDto;
  onDone?: (venue: VenueDto) => void;
  submitLabel: string;
}) {
  const t = useTranslations('Setup');
  const tv = useTranslations('Validation');
  const create = useCreateVenue();
  const update = useUpdateVenue();

  const toPayload = (v: Values) =>
    venue
      ? {
          rev: venue.rev,
          name: v.name.trim(),
          city: textOrNull(v.city),
          address: textOrNull(v.address),
          opensAt: textOrNull(v.opensAt),
          closesAt: textOrNull(v.closesAt),
          localRules: localRules(v),
        }
      : {
          name: v.name.trim(),
          ...(textOrUndefined(v.city) === undefined ? {} : { city: v.city.trim() }),
          ...(textOrUndefined(v.address) === undefined ? {} : { address: v.address.trim() }),
          ...(textOrUndefined(v.opensAt) === undefined ? {} : { opensAt: v.opensAt }),
          ...(textOrUndefined(v.closesAt) === undefined ? {} : { closesAt: v.closesAt }),
          localRules: localRules(v),
        };

  const form = useForm<Values>({
    defaultValues: initial(venue),
    resolver: useSharedSchemaResolver<Values>(
      venue ? UpdateVenueSchema : CreateVenueSchema,
      toPayload,
    ),
  });
  const errors = form.formState.errors;
  const pending = create.isPending || update.isPending;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = toPayload(values);
      const saved = venue
        ? await update.mutateAsync({
            ...(payload as Parameters<typeof update.mutateAsync>[0]),
            id: venue.id,
          })
        : await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('venue.saved'));
      onDone?.(saved);
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="venue-form">
      <TextField
        label={t('fields.venueName')}
        autoComplete="off"
        error={errors.name?.message}
        {...form.register('name')}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={t('fields.city')}
          error={errors.city?.message}
          {...form.register('city')}
        />
        <TextField
          label={t('fields.address')}
          error={errors.address?.message}
          {...form.register('address')}
        />
      </div>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">{t('fields.openingHours')}</legend>
        <p className="text-muted-foreground text-xs">{t('fields.openingHoursHint')}</p>
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label={t('fields.opensAt')}
            type="time"
            error={errors.opensAt?.message}
            {...form.register('opensAt')}
          />
          <TextField
            label={t('fields.closesAt')}
            type="time"
            error={errors.closesAt?.message}
            {...form.register('closesAt')}
          />
        </div>
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">{t('fields.localRules')}</legend>
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label={t('fields.latestEndTime')}
            type="time"
            error={errors.latestEndTime?.message}
            {...form.register('latestEndTime')}
          />
          <TextField
            label={t('fields.maxGuests')}
            inputMode="numeric"
            error={errors.maxGuests?.message}
            {...form.register('maxGuests')}
          />
        </div>
      </fieldset>
      <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
    </form>
  );
}
