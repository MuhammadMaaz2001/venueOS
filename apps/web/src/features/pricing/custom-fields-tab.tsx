'use client';

import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  CreateCustomFieldDefSchema,
  SENSITIVE_FIELD_TYPES,
  UpdateCustomFieldDefSchema,
} from '@venueos/shared';
import type { CustomFieldDefDto, CustomFieldEntity, CustomFieldType } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
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
import { useCreateCustomField, useCustomFields, useUpdateCustomField } from '../catalogue/api';
import { showServerFieldErrors, useSharedSchemaResolver } from '../setup/form-resolver';
import type { Translate } from '../setup/form-resolver';
import { parseOptions, suggestFieldKey } from './logic';

/**
 * Fields a workspace adds to its own records (customers, bookings, sessions, leads). Only the definitions live here;
 * the values are filled in on the records themselves. A sensitive field (a CNIC) is stored encrypted and shown masked.
 */
export function CustomFieldsTab() {
  const t = useTranslations('Pricing.fields');
  const mayWrite = useCanWrite('catalogue.manage');
  const fields = useCustomFields({ includeInactive: true });
  const [editing, setEditing] = useState<CustomFieldDefDto | 'new' | null>(null);

  const byEntity = CUSTOM_FIELD_ENTITIES.map((entity) => ({
    entity,
    fields: (fields.data?.data ?? []).filter((f) => f.entity === entity),
  })).filter((g) => g.fields.length > 0);

  return (
    <div className="grid gap-4">
      <TabHeader
        description={t('description')}
        addLabel={mayWrite ? t('add') : undefined}
        onAdd={mayWrite ? () => setEditing('new') : undefined}
        addTestId="custom-field-add"
      />
      <ListState
        pending={fields.isPending}
        failed={fields.isError}
        empty={fields.isSuccess && fields.data.data.length === 0}
        emptyText={t('empty')}
        loadFailedText={t('loadFailed')}
      >
        <div className="grid gap-4" data-testid="custom-field-list">
          {byEntity.map((group) => (
            <section key={group.entity} className="grid gap-2">
              <h3 className="text-sm font-semibold">{t(`entities.${group.entity}`)}</h3>
              <RowList testId={`custom-field-list-${group.entity}`}>
                {group.fields.map((field) => (
                  <Row
                    key={field.id}
                    testId="custom-field-row"
                    onOpen={mayWrite ? () => setEditing(field) : undefined}
                    openLabel={t('edit', { name: field.label })}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{field.label}</span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {field.key}
                        {field.options.length > 0 ? ` · ${field.options.join(', ')}` : ''}
                      </span>
                    </span>
                    <Badge variant="outline">{t(`types.${field.type}`)}</Badge>
                    {field.required ? <Badge variant="outline">{t('required')}</Badge> : null}
                    {field.sensitive ? <Badge variant="outline">{t('sensitive')}</Badge> : null}
                    {!field.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
                  </Row>
                ))}
              </RowList>
            </section>
          ))}
        </div>
      </ListState>
      <FormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('addTitle') : t('editTitle')}
        description={t('formDescription')}
      >
        {editing !== null ? (
          <CustomFieldForm
            key={editing === 'new' ? 'new' : `${editing.id}:${editing.rev}`}
            field={editing === 'new' ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}

interface Values {
  entity: CustomFieldEntity;
  label: string;
  key: string;
  type: CustomFieldType;
  options: string;
  required: boolean;
  sensitive: boolean;
  sortOrder: string;
}

function CustomFieldForm({
  field,
  onDone,
}: {
  field?: CustomFieldDefDto | undefined;
  onDone: () => void;
}) {
  const t = useTranslations('Pricing.fields');
  const tv = useTranslations('Validation');
  const create = useCreateCustomField();
  const update = useUpdateCustomField();
  const editing = field !== undefined;
  // The key follows the label until the person types their own.
  const [keyTouched, setKeyTouched] = useState(editing);

  const toPayload = (v: Values) =>
    editing
      ? {
          rev: field.rev,
          label: v.label.trim(),
          ...(field.type === 'select' ? { options: parseOptions(v.options) } : {}),
          required: v.required,
          sortOrder: v.sortOrder.trim() === '' ? 0 : Number(v.sortOrder),
        }
      : {
          entity: v.entity,
          key: v.key.trim(),
          label: v.label.trim(),
          type: v.type,
          options: v.type === 'select' ? parseOptions(v.options) : [],
          required: v.required,
          sensitive:
            v.sensitive && v.entity === 'customer' && SENSITIVE_FIELD_TYPES.includes(v.type),
          sortOrder: v.sortOrder.trim() === '' ? 0 : Number(v.sortOrder),
        };
  const form = useForm<Values>({
    defaultValues: {
      entity: field?.entity ?? 'customer',
      label: field?.label ?? '',
      key: field?.key ?? '',
      type: field?.type ?? 'text',
      options: field?.options.join('\n') ?? '',
      required: field?.required ?? false,
      sensitive: field?.sensitive ?? false,
      sortOrder: String(field?.sortOrder ?? 0),
    },
    resolver: useSharedSchemaResolver<Values>(
      editing ? UpdateCustomFieldDefSchema : CreateCustomFieldDefSchema,
      toPayload,
    ),
  });
  const errors = form.formState.errors;
  const type = useWatch({ control: form.control, name: 'type' });
  const entity = useWatch({ control: form.control, name: 'entity' });
  const pending = create.isPending || update.isPending;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = toPayload(values);
      if (field) await update.mutateAsync({ ...(payload as { rev: number }), id: field.id });
      else await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('saved'));
      onDone();
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  const toggle = async () => {
    if (!field) return;
    try {
      await update.mutateAsync({ id: field.id, rev: field.rev, active: !field.active });
      toast.success(t('saved'));
      onDone();
    } catch {
      // Toasted globally.
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="custom-field-form">
      {editing ? null : (
        <SelectField label={t('entity')} {...form.register('entity')}>
          {CUSTOM_FIELD_ENTITIES.map((e) => (
            <option key={e} value={e}>
              {t(`entities.${e}`)}
            </option>
          ))}
        </SelectField>
      )}
      <TextField
        label={t('label')}
        autoComplete="off"
        error={errors.label?.message}
        {...form.register('label', {
          onChange: (event) => {
            if (!keyTouched) form.setValue('key', suggestFieldKey(String(event.target.value)));
          },
        })}
      />
      {editing ? (
        <p className="text-muted-foreground text-sm" data-testid="custom-field-fixed">
          {t('fixed', { key: field.key, type: t(`types.${field.type}`) })}
        </p>
      ) : (
        <>
          <TextField
            label={t('key')}
            hint={t('keyHint')}
            autoComplete="off"
            isolate
            error={errors.key?.message}
            {...form.register('key', { onChange: () => setKeyTouched(true) })}
          />
          <SelectField label={t('type')} error={errors.type?.message} {...form.register('type')}>
            {CUSTOM_FIELD_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`types.${x}`)}
              </option>
            ))}
          </SelectField>
        </>
      )}
      {(editing ? field.type : type) === 'select' ? (
        <div className="grid gap-1.5">
          <label htmlFor="custom-field-options" className="text-sm font-medium">
            {t('options')}
          </label>
          <textarea
            id="custom-field-options"
            rows={4}
            className="border-input bg-background w-full rounded-lg border px-2.5 py-2 text-base md:text-sm"
            aria-invalid={errors.options ? true : undefined}
            {...form.register('options')}
          />
          <p className="text-muted-foreground text-xs">
            {errors.options?.message ? t('optionsInvalid') : t('optionsHint')}
          </p>
        </div>
      ) : null}
      <CheckboxField label={t('requiredLabel')} {...form.register('required')} />
      {editing ? (
        field.sensitive ? (
          <p className="text-muted-foreground text-sm">{t('sensitiveNote')}</p>
        ) : null
      ) : entity === 'customer' && SENSITIVE_FIELD_TYPES.includes(type) ? (
        <div className="grid gap-1">
          <CheckboxField label={t('sensitiveLabel')} {...form.register('sensitive')} />
          <p className="text-muted-foreground text-xs">{t('sensitiveHint')}</p>
        </div>
      ) : null}
      <TextField
        label={t('sortOrder')}
        hint={t('sortOrderHint')}
        inputMode="numeric"
        isolate
        error={errors.sortOrder?.message}
        {...form.register('sortOrder')}
      />
      <SubmitButton pending={pending}>{editing ? t('save') : t('create')}</SubmitButton>
      {field ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10"
          disabled={pending}
          onClick={toggle}
          data-testid="custom-field-toggle"
        >
          {field.active ? t('deactivate') : t('reactivate')}
        </Button>
      ) : null}
    </form>
  );
}
