'use client';

import { CreateTaxRateSchema, UpdateTaxRateSchema } from '@venueos/shared';
import type { TaxRateDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { CheckboxField, SelectField, SubmitButton, TextField } from '@/components/form-fields';
import {
  FormDialog,
  ListState,
  Row,
  RowList,
  TabHeader,
  useCanWrite,
} from '@/components/resource-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { showServerFieldErrors, useSharedSchemaResolver } from '../setup/form-resolver';
import type { Translate } from '../setup/form-resolver';
import { useCreateTaxRate, useTaxRates, useUpdateTaxRate } from './api';

/** Tax rates (docs/05 section 3 step 6): exclusive or inclusive, and the one the workspace uses by default. */
export function TaxRatesTab() {
  const t = useTranslations('Pricing.tax');
  const mayWrite = useCanWrite('pricing.manage');
  const rates = useTaxRates({ includeInactive: true });
  const [editing, setEditing] = useState<TaxRateDto | 'new' | null>(null);

  return (
    <div className="grid gap-4">
      <TabHeader
        description={t('description')}
        addLabel={mayWrite ? t('add') : undefined}
        onAdd={mayWrite ? () => setEditing('new') : undefined}
        addTestId="tax-rate-add"
      />
      <ListState
        pending={rates.isPending}
        failed={rates.isError}
        empty={rates.isSuccess && rates.data.data.length === 0}
        emptyText={t('empty')}
        loadFailedText={t('loadFailed')}
      >
        <RowList testId="tax-rate-list">
          {(rates.data?.data ?? []).map((rate) => (
            <Row
              key={rate.id}
              testId="tax-rate-row"
              onOpen={mayWrite ? () => setEditing(rate) : undefined}
              openLabel={t('edit', { name: rate.name })}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{rate.name}</span>
              <span className="text-sm tabular-nums">{t('rate', { rate: rate.ratePct })}</span>
              <Badge variant="outline">{rate.inclusive ? t('inclusive') : t('exclusive')}</Badge>
              {rate.isDefault ? <Badge>{t('default')}</Badge> : null}
              {!rate.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
            </Row>
          ))}
        </RowList>
      </ListState>
      <FormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('addTitle') : t('editTitle')}
        description={t('formDescription')}
      >
        {editing !== null ? (
          <TaxRateForm
            key={editing === 'new' ? 'new' : `${editing.id}:${editing.rev}`}
            rate={editing === 'new' ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}

interface Values {
  name: string;
  ratePct: string;
  mode: 'exclusive' | 'inclusive';
  isDefault: boolean;
}

function TaxRateForm({ rate, onDone }: { rate?: TaxRateDto | undefined; onDone: () => void }) {
  const t = useTranslations('Pricing.tax');
  const tv = useTranslations('Validation');
  const create = useCreateTaxRate();
  const update = useUpdateTaxRate();

  const toPayload = (v: Values) => ({
    ...(rate ? { rev: rate.rev } : {}),
    name: v.name.trim(),
    ratePct: v.ratePct.trim(),
    inclusive: v.mode === 'inclusive',
    isDefault: v.isDefault,
  });
  const form = useForm<Values>({
    defaultValues: {
      name: rate?.name ?? '',
      ratePct: rate?.ratePct ?? '',
      mode: rate?.inclusive ? 'inclusive' : 'exclusive',
      isDefault: rate?.isDefault ?? false,
    },
    resolver: useSharedSchemaResolver<Values>(
      rate ? UpdateTaxRateSchema : CreateTaxRateSchema,
      toPayload,
    ),
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = toPayload(values);
      if (rate) await update.mutateAsync({ ...(payload as { rev: number }), id: rate.id });
      else await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('saved'));
      onDone();
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  const toggle = async () => {
    if (!rate) return;
    try {
      await update.mutateAsync({ id: rate.id, rev: rate.rev, active: !rate.active });
      toast.success(t('saved'));
      onDone();
    } catch {
      // Toasted globally.
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="tax-rate-form">
      <TextField
        label={t('name')}
        placeholder={t('namePlaceholder')}
        autoComplete="off"
        error={errors.name?.message}
        {...form.register('name')}
      />
      <TextField
        label={t('ratePct')}
        hint={t('ratePctHint')}
        inputMode="decimal"
        isolate
        error={errors.ratePct?.message}
        {...form.register('ratePct')}
      />
      <SelectField label={t('mode')} hint={t('modeHint')} {...form.register('mode')}>
        <option value="exclusive">{t('exclusiveOption')}</option>
        <option value="inclusive">{t('inclusiveOption')}</option>
      </SelectField>
      {rate && !rate.active ? null : (
        <CheckboxField label={t('makeDefault')} {...form.register('isDefault')} />
      )}
      <SubmitButton pending={create.isPending || update.isPending}>
        {rate ? t('save') : t('create')}
      </SubmitButton>
      {rate ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10"
          disabled={update.isPending}
          onClick={toggle}
          data-testid="tax-rate-toggle"
        >
          {rate.active ? t('deactivate') : t('reactivate')}
        </Button>
      ) : null}
    </form>
  );
}
