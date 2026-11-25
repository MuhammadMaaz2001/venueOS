'use client';

import { CreateCustomerSchema, UpdateCustomerSchema, normalizePhone } from '@venueos/shared';
import type { CustomerDetailDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { SelectField, SubmitButton, TextAreaField, TextField } from '@/components/form-fields';
import {
  showServerFieldErrors,
  textOrNull,
  textOrUndefined,
  useSharedSchemaResolver,
} from '../setup/form-resolver';
import type { Translate } from '../setup/form-resolver';
import { useSession } from '../shell/session';
import { useCreateCustomer, useCustomFieldDefs, useUpdateCustomer } from './api';
import {
  CustomFieldInputs,
  fieldPayload,
  initialFieldTexts,
  missingRequired,
} from './custom-field-inputs';
import type { FieldTexts } from './custom-field-inputs';
import { DuplicateWarning } from './duplicate-warning';

interface Values {
  name: string;
  phone: string;
  altPhone: string;
  email: string;
  address: string;
  preferredLocale: string;
  notes: string;
}

/**
 * Create or edit a customer. The phone is checked with the workspace country as it is typed; a matching phone or
 * email shows the duplicate warning (a hint, never a block). Custom fields come from the tenant's definitions.
 */
export function CustomerForm({
  customer,
  onDone,
}: {
  customer?: CustomerDetailDto | undefined;
  onDone: (saved: CustomerDetailDto) => void;
}) {
  const t = useTranslations('Customers.form');
  const tf = useTranslations('Customers.fields');
  const tv = useTranslations('Validation');
  const { tenant } = useSession();
  const create = useCreateCustomer();
  const update = useUpdateCustomer();
  const defsQuery = useCustomFieldDefs('customer');
  const defs = (defsQuery.data?.data ?? []).filter((d) => d.active);

  const initialTexts = initialFieldTexts(defs, customer?.customFields);
  const [texts, setTexts] = useState<FieldTexts | null>(null);
  const currentTexts = texts ?? initialTexts;
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const toPayload = (v: Values) =>
    customer
      ? {
          rev: customer.rev,
          name: v.name.trim(),
          phone: v.phone.trim(),
          altPhone: textOrNull(v.altPhone),
          email: textOrNull(v.email),
          address: textOrNull(v.address),
          preferredLocale: textOrNull(v.preferredLocale),
          notes: textOrNull(v.notes),
        }
      : {
          name: v.name.trim(),
          phone: v.phone.trim(),
          ...(textOrUndefined(v.altPhone) === undefined ? {} : { altPhone: v.altPhone.trim() }),
          ...(textOrUndefined(v.email) === undefined ? {} : { email: v.email.trim() }),
          ...(textOrUndefined(v.address) === undefined ? {} : { address: v.address.trim() }),
          ...(textOrUndefined(v.preferredLocale) === undefined
            ? {}
            : { preferredLocale: v.preferredLocale }),
          ...(textOrUndefined(v.notes) === undefined ? {} : { notes: v.notes.trim() }),
        };
  const form = useForm<Values>({
    defaultValues: {
      name: customer?.name ?? '',
      phone: customer?.phone ?? '',
      altPhone: customer?.altPhone ?? '',
      email: customer?.email ?? '',
      address: customer?.address ?? '',
      preferredLocale: customer?.preferredLocale ?? '',
      notes: customer?.notes ?? '',
    },
    resolver: useSharedSchemaResolver<Values>(
      customer ? UpdateCustomerSchema : CreateCustomerSchema,
      toPayload,
    ),
  });
  const errors = form.formState.errors;
  const [phone = '', email = ''] = useWatch({ control: form.control, name: ['phone', 'email'] });

  const onSubmit = form.handleSubmit(async (values) => {
    let blocked = false;
    for (const key of ['phone', 'altPhone'] as const) {
      const raw = values[key].trim();
      if (raw !== '' && !normalizePhone(raw, tenant.country).ok) {
        form.setError(key, { type: 'phone', message: t('phoneInvalid') });
        blocked = true;
      }
    }
    const missing = missingRequired(defs, currentTexts, customer?.customFields);
    setFieldErrors(Object.fromEntries(missing.map((k) => [k, tv('required')])));
    if (blocked || missing.length > 0) return;

    try {
      const customFields = fieldPayload(defs, currentTexts, customer ? initialTexts : undefined);
      const payload = { ...toPayload(values), ...(customFields ? { customFields } : {}) };
      const saved = customer
        ? await update.mutateAsync({ ...(payload as { rev: number }), id: customer.id })
        : await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('saved'));
      onDone(saved);
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="customer-form">
      <TextField
        label={tf('name')}
        autoComplete="off"
        error={errors.name?.message}
        {...form.register('name')}
      />
      <TextField
        label={tf('phone')}
        hint={t('phoneHint', { country: tenant.country })}
        type="tel"
        autoComplete="off"
        isolate
        error={errors.phone?.message}
        {...form.register('phone')}
      />
      <TextField
        label={tf('altPhone')}
        type="tel"
        autoComplete="off"
        isolate
        error={errors.altPhone?.message}
        {...form.register('altPhone')}
      />
      <TextField
        label={tf('email')}
        type="email"
        autoComplete="off"
        isolate
        error={errors.email?.message}
        {...form.register('email')}
      />
      <DuplicateWarning phone={phone} email={email} excludeId={customer?.id} />
      <TextField label={tf('address')} autoComplete="off" {...form.register('address')} />
      <SelectField label={tf('preferredLocale')} {...form.register('preferredLocale')}>
        <option value="">{tf('localeDefault')}</option>
        <option value="en">{tf('localeEnglish')}</option>
      </SelectField>
      <TextAreaField label={tf('notes')} {...form.register('notes')} />
      <CustomFieldInputs
        defs={defs}
        texts={currentTexts}
        onChange={(key, value) => setTexts({ ...currentTexts, [key]: value })}
        stored={customer?.customFields}
        errors={fieldErrors}
      />
      <SubmitButton pending={create.isPending || update.isPending}>
        {customer ? t('save') : t('create')}
      </SubmitButton>
    </form>
  );
}
