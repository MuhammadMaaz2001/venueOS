'use client';

import { CreateMenuItemSchema, UpdateMenuItemSchema } from '@venueos/shared';
import type { MenuItemDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
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
import {
  showServerFieldErrors,
  textOrNull,
  textOrUndefined,
  useSharedSchemaResolver,
} from '../setup/form-resolver';
import type { Translate } from '../setup/form-resolver';
import { useCreateMenuItem, useMenuItems, useUpdateMenuItem } from './api';

/** The dishes a venue serves (docs/01 module 3). Packages are made of them. */
export function MenuItemsTab() {
  const t = useTranslations('Catalogue.menuItems');
  const mayWrite = useCanWrite('catalogue.manage');
  const items = useMenuItems({ includeInactive: true });
  const [editing, setEditing] = useState<MenuItemDto | 'new' | null>(null);
  const [category, setCategory] = useState('');

  const categories = useMemo(
    () =>
      [
        ...new Set((items.data?.data ?? []).map((i) => i.category).filter((c): c is string => !!c)),
      ].sort((a, b) => a.localeCompare(b)),
    [items.data],
  );
  const shown = (items.data?.data ?? []).filter(
    (i) => category === '' || (i.category ?? '').toLowerCase() === category.toLowerCase(),
  );

  return (
    <div className="grid gap-4">
      <TabHeader
        description={t('description')}
        addLabel={mayWrite ? t('add') : undefined}
        onAdd={mayWrite ? () => setEditing('new') : undefined}
        addTestId="menu-item-add"
      />
      {categories.length > 0 ? (
        <div className="max-w-xs">
          <SelectField
            label={t('filter')}
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            data-testid="menu-item-filter"
          >
            <option value="">{t('allCategories')}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </SelectField>
        </div>
      ) : null}
      <ListState
        pending={items.isPending}
        failed={items.isError}
        empty={items.isSuccess && shown.length === 0}
        emptyText={t('empty')}
        loadFailedText={t('loadFailed')}
      >
        <RowList testId="menu-item-list">
          {shown.map((item) => (
            <Row
              key={item.id}
              testId="menu-item-row"
              onOpen={mayWrite ? () => setEditing(item) : undefined}
              openLabel={t('edit', { name: item.name })}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
              {item.category ? <Badge variant="outline">{item.category}</Badge> : null}
              {!item.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
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
          <MenuItemForm
            key={editing === 'new' ? 'new' : `${editing.id}:${editing.rev}`}
            item={editing === 'new' ? undefined : editing}
            categories={categories}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}

interface Values {
  name: string;
  category: string;
}

function MenuItemForm({
  item,
  categories,
  onDone,
}: {
  item?: MenuItemDto | undefined;
  categories: readonly string[];
  onDone: () => void;
}) {
  const t = useTranslations('Catalogue.menuItems');
  const tv = useTranslations('Validation');
  const create = useCreateMenuItem();
  const update = useUpdateMenuItem();

  const toPayload = (v: Values) =>
    item
      ? { rev: item.rev, name: v.name.trim(), category: textOrNull(v.category) }
      : {
          name: v.name.trim(),
          ...(textOrUndefined(v.category) === undefined ? {} : { category: v.category.trim() }),
        };
  const form = useForm<Values>({
    defaultValues: { name: item?.name ?? '', category: item?.category ?? '' },
    resolver: useSharedSchemaResolver<Values>(
      item ? UpdateMenuItemSchema : CreateMenuItemSchema,
      toPayload,
    ),
  });
  const errors = form.formState.errors;
  const suggestions = [
    ...new Set([
      ...categories,
      ...(['starter', 'main', 'dessert', 'drink', 'bread'] as const).map((k) =>
        t(`suggestions.${k}`),
      ),
    ]),
  ];

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = toPayload(values);
      if (item) await update.mutateAsync({ ...(payload as { rev: number }), id: item.id });
      else await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('saved'));
      onDone();
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  const toggle = async () => {
    if (!item) return;
    try {
      await update.mutateAsync({ id: item.id, rev: item.rev, active: !item.active });
      toast.success(t('saved'));
      onDone();
    } catch {
      // Toasted globally (a stale form, or the name is taken by an active dish when reactivating).
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="menu-item-form">
      <TextField
        label={t('name')}
        autoComplete="off"
        error={errors.name?.message}
        {...form.register('name')}
      />
      <TextField
        label={t('category')}
        hint={t('categoryHint')}
        autoComplete="off"
        list="menu-item-categories"
        error={errors.category?.message}
        {...form.register('category')}
      />
      <datalist id="menu-item-categories">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <SubmitButton pending={create.isPending || update.isPending}>
        {item ? t('save') : t('create')}
      </SubmitButton>
      {item ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10"
          disabled={update.isPending}
          onClick={toggle}
          data-testid="menu-item-toggle"
        >
          {item.active ? t('deactivate') : t('reactivate')}
        </Button>
      ) : null}
    </form>
  );
}
