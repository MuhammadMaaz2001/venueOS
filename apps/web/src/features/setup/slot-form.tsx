'use client';

import { CreateSlotTemplateSchema, SLOT_MODES, UpdateSlotTemplateSchema } from '@venueos/shared';
import type { SlotMode, SlotTemplateDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { CheckboxField, SelectField, SubmitButton, TextField } from '@/components/form-fields';
import { useCreateSlot, useUpdateSlot } from './api';
import {
  numberOrNull,
  numberOrUndefined,
  showServerFieldErrors,
  textOrUndefined,
  useSharedSchemaResolver,
} from './form-resolver';
import type { Translate } from './form-resolver';

interface Values {
  name: string;
  mode: SlotMode;
  startTime: string;
  endTime: string;
  minHours: string;
  daysOfWeek: number[];
}

function initial(slot: SlotTemplateDto | undefined): Values {
  return {
    name: slot?.name ?? '',
    mode: slot?.mode ?? 'FIXED',
    startTime: slot?.mode === 'FULL_DAY' ? '' : (slot?.startTime ?? ''),
    endTime: slot?.mode === 'FULL_DAY' ? '' : (slot?.endTime ?? ''),
    minHours: slot?.minHours === null || slot?.minHours === undefined ? '' : String(slot.minHours),
    daysOfWeek: slot?.daysOfWeek ?? [],
  };
}

/** Add a slot template (a named shift, an hourly window or a full day) or edit one. Mode and venue are fixed later. */
export function SlotForm({
  venueId,
  slot,
  onDone,
  submitLabel,
}: {
  venueId: string;
  slot?: SlotTemplateDto;
  onDone?: (slot: SlotTemplateDto) => void;
  submitLabel: string;
}) {
  const t = useTranslations('Setup');
  const tv = useTranslations('Validation');
  const create = useCreateSlot();
  const update = useUpdateSlot();
  const editing = slot !== undefined;

  const toPayload = (v: Values) => {
    const mode = slot?.mode ?? v.mode;
    const times =
      mode === 'FULL_DAY'
        ? {}
        : {
            ...(textOrUndefined(v.startTime) === undefined ? {} : { startTime: v.startTime }),
            ...(textOrUndefined(v.endTime) === undefined ? {} : { endTime: v.endTime }),
          };
    if (slot) {
      return {
        rev: slot.rev,
        name: v.name.trim(),
        daysOfWeek: v.daysOfWeek,
        ...times,
        ...(mode === 'HOURLY' ? { minHours: numberOrNull(v.minHours) } : {}),
      };
    }
    const minHours = numberOrUndefined(v.minHours);
    return {
      venueId,
      name: v.name.trim(),
      mode,
      daysOfWeek: v.daysOfWeek,
      ...times,
      ...(mode === 'HOURLY' && minHours !== undefined ? { minHours } : {}),
    };
  };

  const form = useForm<Values>({
    defaultValues: initial(slot),
    resolver: useSharedSchemaResolver<Values>(
      editing ? UpdateSlotTemplateSchema : CreateSlotTemplateSchema,
      toPayload,
    ),
  });
  const errors = form.formState.errors;
  const watchedMode = useWatch({ control: form.control, name: 'mode' });
  const mode = editing ? slot.mode : watchedMode;
  const pending = create.isPending || update.isPending;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = toPayload(values);
      const saved = slot
        ? await update.mutateAsync({
            ...(payload as Parameters<typeof update.mutateAsync>[0]),
            id: slot.id,
          })
        : await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('slots.saved'));
      onDone?.(saved);
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="slot-form">
      <TextField
        label={t('fields.slotName')}
        autoComplete="off"
        error={errors.name?.message}
        {...form.register('name')}
      />
      {!editing ? (
        <SelectField
          label={t('fields.mode')}
          hint={t(`modeHelp.${mode}`)}
          {...form.register('mode')}
        >
          {SLOT_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`modes.${m}`)}
            </option>
          ))}
        </SelectField>
      ) : (
        <p className="text-muted-foreground text-xs">{t(`modeHelp.${mode}`)}</p>
      )}
      {mode !== 'FULL_DAY' ? (
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label={t('fields.startTime')}
            type="time"
            hint={mode === 'HOURLY' ? t('fields.hourlyDefault') : undefined}
            error={errors.startTime?.message}
            {...form.register('startTime')}
          />
          <TextField
            label={t('fields.endTime')}
            type="time"
            hint={mode === 'FIXED' ? t('fields.overnightHint') : undefined}
            error={errors.endTime?.message}
            {...form.register('endTime')}
          />
        </div>
      ) : null}
      {mode === 'HOURLY' ? (
        <TextField
          label={t('fields.minHours')}
          inputMode="numeric"
          error={errors.minHours?.message}
          {...form.register('minHours')}
        />
      ) : null}
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t('fields.days')}</legend>
        <p className="text-muted-foreground text-xs">{t('fields.daysHint')}</p>
        <Controller
          control={form.control}
          name="daysOfWeek"
          render={({ field }) => (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <CheckboxField
                  key={day}
                  label={t(`days.${day}`)}
                  checked={field.value.includes(day)}
                  onChange={(event) =>
                    field.onChange(
                      event.target.checked
                        ? [...field.value, day]
                        : field.value.filter((d) => d !== day),
                    )
                  }
                />
              ))}
            </div>
          )}
        />
      </fieldset>
      <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
    </form>
  );
}
