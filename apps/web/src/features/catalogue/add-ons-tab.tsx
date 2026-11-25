'use client';

import { ADD_ON_PRICINGS, CreateAddOnSchema, UpdateAddOnSchema } from '@venueos/shared';
import type { AddOnDto, AddOnPricing } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { SelectField, SubmitButton, TextField } from '@/components/form-fields';
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
import { useFormatters, useSession } from '../shell/session';
import { useAddOns, useCreateAddOn, useUpdateAddOn } from './api';

/** Extras sold on top of the rent and the package (docs/05 section 3 step 4). */
export function AddOnsTab() {
  const t = useTranslations('Catalogue.addOns');
  const fmt = useFormatters();
  const mayWrite = useCanWrite('catalogue.manage');
  const addOns = useAddOns({ includeInactive: true });
  const [editing, setEditing] = useState<AddOnDto | 'new' | null>(null);

  return (
    <div className="grid gap-4">
      <TabHeader
        description={t('description')}
        addLabel={mayWrite ? t('add') : undefined}
        onAdd={mayWrite ? () => setEditing('new') : undefined}
        addTestId="add-on-add"
      />
      <ListState
        pending={addOns.isPending}
        failed={addOns.isError}
        empty={addOns.isSuccess && addOns.data.data.length === 0}
        emptyText={t('empty')}
        loadFailedText={t('loadFailed')}
      >
        <RowList testId="add-on-list">
          {(addOns.data?.data ?? []).map((addOn) => (
            <Row
              key={addOn.id}
              testId="add-on-row"
              onOpen={mayWrite ? () => setEditing(addOn) : undefined}
              openLabel={t('edit', { name: addOn.name })}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{addOn.name}</span>
              <span className="text-sm tabular-nums" data-testid="add-on-price">
                {addOn.price === null
                  ? t('priceHidden')
                  : t(`priced.${addOn.pricing}`, { price: fmt.money(addOn.price) })}
              </span>
              {!addOn.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
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
          <AddOnForm
            key={editing === 'new' ? 'new' : `${editing.id}:${editing.rev}`}
            addOn={editing === 'new' ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}

interface Values {
  name: string;
  pricing: AddOnPricing;
  price: string;
}

function AddOnForm({ addOn, onDone }: { addOn?: AddOnDto | undefined; onDone: () => void }) {
  const t = useTranslations('Catalogue.addOns');
  const tv = useTranslations('Validation');
  const { tenant } = useSession();
  const create = useCreateAddOn();
  const update = useUpdateAddOn();

  const toPayload = (v: Values) => ({
    ...(addOn ? { rev: addOn.rev } : {}),
    name: v.name.trim(),
    pricing: v.pricing,
    price: v.price.trim(),
  });
  const form = useForm<Values>({
    defaultValues: {
      name: addOn?.name ?? '',
      pricing: addOn?.pricing ?? 'FIXED',
      price: addOn?.price ?? '',
    },
    resolver: useSharedSchemaResolver<Values>(
      addOn ? UpdateAddOnSchema : CreateAddOnSchema,
      toPayload,
    ),
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = toPayload(values);
      if (addOn) await update.mutateAsync({ ...(payload as { rev: number }), id: addOn.id });
      else await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('saved'));
      onDone();
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  const toggle = async () => {
    if (!addOn) return;
    try {
      await update.mutateAsync({ id: addOn.id, rev: addOn.rev, active: !addOn.active });
      toast.success(t('saved'));
      onDone();
    } catch {
      // Toasted globally.
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="add-on-form">
      <TextField
        label={t('name')}
        autoComplete="off"
        error={errors.name?.message}
        {...form.register('name')}
      />
      <SelectField
        label={t('pricing')}
        error={errors.pricing?.message}
        {...form.register('pricing')}
      >
        {ADD_ON_PRICINGS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`pricings.${kind}`)}
          </option>
        ))}
      </SelectField>
      <TextField
        label={t('price')}
        hint={t('priceHint', { currency: tenant.currency })}
        inputMode="decimal"
        isolate
        error={errors.price?.message}
        {...form.register('price')}
      />
      <SubmitButton pending={create.isPending || update.isPending}>
        {addOn ? t('save') : t('create')}
      </SubmitButton>
      {addOn ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10"
          disabled={update.isPending}
          onClick={toggle}
          data-testid="add-on-toggle"
        >
          {addOn.active ? t('deactivate') : t('reactivate')}
        </Button>
      ) : null}
    </form>
  );
}
