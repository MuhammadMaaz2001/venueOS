'use client';

import { CreatePackageSchema, UpdatePackageSchema } from '@venueos/shared';
import type { MenuItemDto, PackageDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { SubmitButton, TextField } from '@/components/form-fields';
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
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  numberOrUndefined,
  showServerFieldErrors,
  textOrNull,
  textOrUndefined,
  useSharedSchemaResolver,
} from '../setup/form-resolver';
import type { Translate } from '../setup/form-resolver';
import { useFormatters, useSession } from '../shell/session';
import { useCreatePackage, useMenuItems, usePackages, useUpdatePackage } from './api';

/** Per-head packages (docs/05 section 3 step 3): a rate per guest, a minimum number of guests and the dishes. */
export function PackagesTab() {
  const t = useTranslations('Catalogue.packages');
  const fmt = useFormatters();
  const mayWrite = useCanWrite('catalogue.manage');
  const packages = usePackages({ includeInactive: true });
  const [editing, setEditing] = useState<PackageDto | 'new' | null>(null);

  return (
    <div className="grid gap-4">
      <TabHeader
        description={t('description')}
        addLabel={mayWrite ? t('add') : undefined}
        onAdd={mayWrite ? () => setEditing('new') : undefined}
        addTestId="package-add"
      />
      <ListState
        pending={packages.isPending}
        failed={packages.isError}
        empty={packages.isSuccess && packages.data.data.length === 0}
        emptyText={t('empty')}
        loadFailedText={t('loadFailed')}
      >
        <RowList testId="package-list">
          {(packages.data?.data ?? []).map((pkg) => (
            <Row
              key={pkg.id}
              testId="package-row"
              onOpen={mayWrite ? () => setEditing(pkg) : undefined}
              openLabel={t('edit', { name: pkg.name })}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{pkg.name}</span>
                <span className="text-muted-foreground block text-xs">
                  {t('summary', { dishes: pkg.items.length, minGuests: pkg.minGuests })}
                </span>
              </span>
              <span className="text-sm tabular-nums" data-testid="package-rate">
                {pkg.perHeadRate === null
                  ? t('rateHidden')
                  : t('perHead', { rate: fmt.money(pkg.perHeadRate) })}
              </span>
              {!pkg.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
            </Row>
          ))}
        </RowList>
      </ListState>
      <FormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('addTitle') : t('editTitle')}
        description={t('formDescription')}
        wide
      >
        {editing !== null ? (
          <PackageForm
            key={editing === 'new' ? 'new' : `${editing.id}:${editing.rev}`}
            pkg={editing === 'new' ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}

interface Values {
  name: string;
  perHeadRate: string;
  minGuests: string;
  description: string;
}

/** The dishes of the package: tick a dish to add it, give how many of it a guest gets. */
export function DishPicker({
  dishes,
  selected,
  onChange,
}: {
  dishes: readonly MenuItemDto[];
  selected: Readonly<Record<string, string>>;
  onChange: (next: Record<string, string>) => void;
}) {
  const t = useTranslations('Catalogue.packages');
  if (dishes.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('noDishes')}</p>;
  }
  return (
    <ul
      className="max-h-64 divide-y overflow-y-auto rounded-lg border"
      aria-label={t('dishes')}
      data-testid="dish-picker"
    >
      {dishes.map((dish) => {
        const checked = dish.id in selected;
        const id = `dish-${dish.id}`;
        return (
          <li key={dish.id} className="flex min-h-11 items-center gap-3 px-3 py-1.5">
            <input
              id={id}
              type="checkbox"
              className="size-4 shrink-0"
              checked={checked}
              onChange={(event) => {
                const next = { ...selected };
                if (event.target.checked) next[dish.id] = '1';
                else delete next[dish.id];
                onChange(next);
              }}
            />
            <label
              htmlFor={id}
              className={cn('min-w-0 flex-1 text-sm', !dish.active && 'opacity-60')}
            >
              <span className="block truncate">{dish.name}</span>
              <span className="text-muted-foreground block text-xs">
                {[dish.category, dish.active ? null : t('dishInactive')]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </label>
            {checked ? (
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                aria-label={t('quantityOf', { name: dish.name })}
                className="border-input bg-background h-9 w-16 shrink-0 rounded-lg border px-2 text-base md:text-sm"
                value={selected[dish.id]}
                onChange={(event) => onChange({ ...selected, [dish.id]: event.target.value })}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function PackageForm({ pkg, onDone }: { pkg?: PackageDto | undefined; onDone: () => void }) {
  const t = useTranslations('Catalogue.packages');
  const tv = useTranslations('Validation');
  const { tenant } = useSession();
  const menu = useMenuItems({ includeInactive: true });
  const create = useCreatePackage();
  const update = useUpdatePackage();
  const [selected, setSelected] = useState<Record<string, string>>(() =>
    Object.fromEntries((pkg?.items ?? []).map((i) => [i.menuItemId, String(i.quantity)])),
  );

  const items = Object.entries(selected).map(([menuItemId, quantity]) => ({
    menuItemId,
    quantity: Number(quantity),
  }));
  const toPayload = (v: Values) =>
    pkg
      ? {
          rev: pkg.rev,
          name: v.name.trim(),
          perHeadRate: v.perHeadRate.trim(),
          minGuests: numberOrUndefined(v.minGuests) ?? 0,
          description: textOrNull(v.description),
          items,
        }
      : {
          name: v.name.trim(),
          perHeadRate: v.perHeadRate.trim(),
          minGuests: numberOrUndefined(v.minGuests) ?? 0,
          ...(textOrUndefined(v.description) === undefined
            ? {}
            : { description: v.description.trim() }),
          items,
        };
  const form = useForm<Values>({
    defaultValues: {
      name: pkg?.name ?? '',
      perHeadRate: pkg?.perHeadRate ?? '',
      minGuests: String(pkg?.minGuests ?? 0),
      description: pkg?.description ?? '',
    },
    resolver: useSharedSchemaResolver<Values>(
      pkg ? UpdatePackageSchema : CreatePackageSchema,
      toPayload,
    ),
  });
  const errors = form.formState.errors;
  const itemsError = (errors as Record<string, { message?: string } | undefined>)['items']?.message;
  // Dishes: the active ones, and any deactivated dish this package already has (it may stay, it cannot be added).
  const dishes = (menu.data?.data ?? []).filter((d) => d.active || d.id in selected);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = toPayload(values);
      if (pkg) await update.mutateAsync({ ...(payload as { rev: number }), id: pkg.id });
      else await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('saved'));
      onDone();
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  const toggle = async () => {
    if (!pkg) return;
    try {
      await update.mutateAsync({ id: pkg.id, rev: pkg.rev, active: !pkg.active });
      toast.success(t('saved'));
      onDone();
    } catch {
      // Toasted globally.
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="package-form">
      <TextField
        label={t('name')}
        autoComplete="off"
        error={errors.name?.message}
        {...form.register('name')}
      />
      <div className="grid gap-4 sm:grid-cols-2">
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
      </div>
      <TextField
        label={t('descriptionLabel')}
        autoComplete="off"
        error={errors.description?.message}
        {...form.register('description')}
      />
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">{t('dishes')}</span>
        {menu.isPending ? (
          <Skeleton className="h-24 w-full" aria-busy="true" />
        ) : (
          <DishPicker dishes={dishes} selected={selected} onChange={setSelected} />
        )}
        {itemsError ? (
          <p role="alert" className="text-destructive text-xs">
            {t('itemsInvalid')}
          </p>
        ) : null}
      </div>
      <SubmitButton pending={create.isPending || update.isPending}>
        {pkg ? t('save') : t('create')}
      </SubmitButton>
      {pkg ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10"
          disabled={update.isPending}
          onClick={toggle}
          data-testid="package-toggle"
        >
          {pkg.active ? t('deactivate') : t('reactivate')}
        </Button>
      ) : null}
    </form>
  );
}
