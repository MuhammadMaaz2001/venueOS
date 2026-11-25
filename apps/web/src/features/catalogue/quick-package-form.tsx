'use client';

import { CreatePackageSchema } from '@venueos/shared';
import type { PackageDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { SubmitButton, TextField } from '@/components/form-fields';
import {
  numberOrUndefined,
  showServerFieldErrors,
  useSharedSchemaResolver,
} from '../setup/form-resolver';
import type { Translate } from '../setup/form-resolver';
import { useSession } from '../shell/session';
import { useCreatePackage } from './api';

interface Values {
  name: string;
  perHeadRate: string;
  minGuests: string;
}

/**
 * The short form of the setup wizard: a package's name, price per guest and minimum guests. The dishes are added
 * later on the catalogue page, where the whole package can be edited.
 */
export function QuickPackageForm({
  onDone,
  submitLabel,
}: {
  onDone?: (pkg: PackageDto) => void;
  submitLabel: string;
}) {
  const t = useTranslations('Catalogue.packages');
  const tv = useTranslations('Validation');
  const { tenant } = useSession();
  const create = useCreatePackage();

  const toPayload = (v: Values) => ({
    name: v.name.trim(),
    perHeadRate: v.perHeadRate.trim(),
    minGuests: numberOrUndefined(v.minGuests) ?? 0,
    items: [],
  });
  const form = useForm<Values>({
    defaultValues: { name: '', perHeadRate: '', minGuests: '0' },
    resolver: useSharedSchemaResolver<Values>(CreatePackageSchema, toPayload),
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const saved = await create.mutateAsync(toPayload(values));
      toast.success(t('saved'));
      onDone?.(saved);
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="quick-package-form">
      <TextField
        label={t('name')}
        autoComplete="off"
        error={errors.name?.message}
        {...form.register('name')}
      />
      <TextField
        label={t('perHeadRate')}
        hint={t('perHeadHint', { currency: tenant.currency })}
        inputMode="decimal"
        isolate
        error={errors.perHeadRate?.message}
        {...form.register('perHeadRate')}
      />
      <TextField
        label={t('minGuests')}
        hint={t('minGuestsHint')}
        inputMode="numeric"
        isolate
        error={errors.minGuests?.message}
        {...form.register('minGuests')}
      />
      <SubmitButton pending={create.isPending}>{submitLabel}</SubmitButton>
    </form>
  );
}
