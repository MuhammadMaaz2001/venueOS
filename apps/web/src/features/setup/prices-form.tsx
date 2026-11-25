'use client';

import { ReplaceSpaceSlotPricesSchema } from '@venueos/shared';
import type { SlotTemplateDto, SpaceDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { SubmitButton, TextField } from '@/components/form-fields';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../shell/session';
import { useReplaceSlotPrices, useSlotPrices } from './api';
import { showServerFieldErrors, useSharedSchemaResolver } from './form-resolver';
import type { Translate } from './form-resolver';
import { endsNextDay } from './logic';

type Values = Record<string, string>;

/** What a space charges per slot (per hour for hourly slots). An empty box means "no own price". */
export function PricesForm({
  space,
  slots,
  onDone,
  submitLabel,
}: {
  space: SpaceDto;
  slots: readonly SlotTemplateDto[];
  onDone?: () => void;
  submitLabel: string;
}) {
  const prices = useSlotPrices(space.id);
  const t = useTranslations('Setup');
  if (prices.isPending) return <Skeleton className="h-24 w-full" aria-busy="true" />;
  if (prices.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t('prices.loadFailed')}
      </p>
    );
  }
  // Keyed by the saved prices: a reload with newer data starts a fresh form.
  const key = prices.data.data.map((p) => `${p.slotId}:${p.rent}`).join('|');
  return (
    <PricesFields
      key={`${space.id}:${key}`}
      space={space}
      slots={slots}
      saved={prices.data.data}
      onDone={onDone}
      submitLabel={submitLabel}
    />
  );
}

function PricesFields({
  space,
  slots,
  saved,
  onDone,
  submitLabel,
}: {
  space: SpaceDto;
  slots: readonly SlotTemplateDto[];
  saved: readonly { slotId: string; rent: string }[];
  onDone?: (() => void) | undefined;
  submitLabel: string;
}) {
  const t = useTranslations('Setup');
  const tv = useTranslations('Validation');
  const { tenant } = useSession();
  const replace = useReplaceSlotPrices();

  const toPayload = (values: Values) => ({
    prices: slots
      .filter((slot) => (values[slot.id] ?? '').trim() !== '')
      .map((slot) => ({ slotId: slot.id, rent: (values[slot.id] ?? '').trim() })),
  });
  const form = useForm<Values>({
    defaultValues: Object.fromEntries(
      slots.map((slot) => [slot.id, saved.find((p) => p.slotId === slot.id)?.rent ?? '']),
    ),
    resolver: useSharedSchemaResolver<Values>(ReplaceSpaceSlotPricesSchema, toPayload),
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await replace.mutateAsync({ spaceId: space.id, ...toPayload(values) });
      toast.success(t('prices.saved'));
      onDone?.();
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-3" data-testid="prices-form">
      {slots.map((slot) => (
        <TextField
          key={slot.id}
          label={
            slot.mode === 'FULL_DAY'
              ? slot.name
              : `${slot.name} (${slot.startTime}–${slot.endTime})`
          }
          hint={
            slot.mode === 'HOURLY'
              ? t('prices.perHour', { currency: tenant.currency })
              : endsNextDay(slot)
                ? t('prices.perSlotOvernight', { currency: tenant.currency })
                : t('prices.perSlot', { currency: tenant.currency })
          }
          inputMode="decimal"
          isolate
          {...form.register(slot.id)}
        />
      ))}
      {form.formState.errors.prices?.message ? (
        <p role="alert" className="text-destructive text-xs">
          {t('prices.invalid')}
        </p>
      ) : null}
      <SubmitButton pending={replace.isPending}>{submitLabel}</SubmitButton>
    </form>
  );
}
