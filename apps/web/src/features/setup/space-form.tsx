'use client';

import { CreateSpaceSchema, SPACE_KINDS, UpdateSpaceSchema } from '@venueos/shared';
import type { SpaceDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { CheckboxField, SelectField, SubmitButton, TextField } from '@/components/form-fields';
import { useSession } from '../shell/session';
import { useCreateSpace, useUpdateSpace } from './api';
import {
  numberOrNull,
  numberOrUndefined,
  showServerFieldErrors,
  textOrNull,
  textOrUndefined,
  useSharedSchemaResolver,
} from './form-resolver';
import type { Translate } from './form-resolver';

interface Values {
  name: string;
  kind: (typeof SPACE_KINDS)[number];
  capacitySeated: string;
  capacityStanding: string;
  minGuests: string;
  setupBufferMin: string;
  cleanupBufferMin: string;
  baseRent: string;
  isCombined: boolean;
  componentIds: string[];
}

const text = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

function initial(space: SpaceDto | undefined): Values {
  return {
    name: space?.name ?? '',
    kind: space?.kind ?? 'HALL',
    capacitySeated: text(space?.capacitySeated),
    capacityStanding: text(space?.capacityStanding),
    minGuests: text(space?.minGuests),
    setupBufferMin: text(space?.setupBufferMin ?? 0),
    cleanupBufferMin: text(space?.cleanupBufferMin ?? 0),
    baseRent: space?.baseRent ?? '',
    isCombined: space?.isCombined ?? false,
    componentIds: space?.componentIds ?? [],
  };
}

/**
 * Add a space (a hall, a lawn, or a combined space such as "Hall A+B" made of existing ones) or edit one.
 * `physicalSpaces` are the venue's non-combined spaces a combined space can be made of.
 */
export function SpaceForm({
  venueId,
  space,
  physicalSpaces,
  onDone,
  submitLabel,
}: {
  venueId: string;
  space?: SpaceDto;
  physicalSpaces: readonly SpaceDto[];
  onDone?: (space: SpaceDto) => void;
  submitLabel: string;
}) {
  const t = useTranslations('Setup');
  const tv = useTranslations('Validation');
  const { tenant } = useSession();
  const create = useCreateSpace();
  const update = useUpdateSpace();
  const editing = space !== undefined;

  const toPayload = (v: Values) => {
    const common = {
      name: v.name.trim(),
      kind: v.kind,
      setupBufferMin: Number(v.setupBufferMin.trim() === '' ? '0' : v.setupBufferMin),
      cleanupBufferMin: Number(v.cleanupBufferMin.trim() === '' ? '0' : v.cleanupBufferMin),
    };
    if (space) {
      return {
        ...common,
        rev: space.rev,
        capacitySeated: numberOrNull(v.capacitySeated),
        capacityStanding: numberOrNull(v.capacityStanding),
        minGuests: numberOrNull(v.minGuests),
        baseRent: textOrNull(v.baseRent),
        ...(space.isCombined ? { componentIds: v.componentIds } : {}),
      };
    }
    return {
      ...common,
      venueId,
      isCombined: v.isCombined,
      ...(v.isCombined ? { componentIds: v.componentIds } : {}),
      ...(numberOrUndefined(v.capacitySeated) === undefined
        ? {}
        : { capacitySeated: numberOrUndefined(v.capacitySeated) }),
      ...(numberOrUndefined(v.capacityStanding) === undefined
        ? {}
        : { capacityStanding: numberOrUndefined(v.capacityStanding) }),
      ...(numberOrUndefined(v.minGuests) === undefined
        ? {}
        : { minGuests: numberOrUndefined(v.minGuests) }),
      ...(textOrUndefined(v.baseRent) === undefined ? {} : { baseRent: v.baseRent.trim() }),
    };
  };

  const form = useForm<Values>({
    defaultValues: initial(space),
    resolver: useSharedSchemaResolver<Values>(
      editing ? UpdateSpaceSchema : CreateSpaceSchema,
      toPayload,
    ),
  });
  const errors = form.formState.errors;
  const isCombined = useWatch({ control: form.control, name: 'isCombined' });
  const showComponents = editing ? space.isCombined : isCombined;
  const pending = create.isPending || update.isPending;
  // A space cannot contain itself.
  const choices = physicalSpaces.filter((s) => !s.isCombined && s.id !== space?.id);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = toPayload(values);
      const saved = space
        ? await update.mutateAsync({
            ...(payload as Parameters<typeof update.mutateAsync>[0]),
            id: space.id,
          })
        : await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('spaces.saved'));
      onDone?.(saved);
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="space-form">
      <TextField
        label={t('fields.spaceName')}
        autoComplete="off"
        error={errors.name?.message}
        {...form.register('name')}
      />
      <SelectField label={t('fields.kind')} {...form.register('kind')}>
        {SPACE_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`kinds.${kind}`)}
          </option>
        ))}
      </SelectField>
      <div className="grid grid-cols-2 gap-4">
        <TextField
          label={t('fields.capacitySeated')}
          inputMode="numeric"
          error={errors.capacitySeated?.message}
          {...form.register('capacitySeated')}
        />
        <TextField
          label={t('fields.capacityStanding')}
          inputMode="numeric"
          error={errors.capacityStanding?.message}
          {...form.register('capacityStanding')}
        />
      </div>
      <TextField
        label={t('fields.minGuests')}
        inputMode="numeric"
        error={errors.minGuests?.message}
        {...form.register('minGuests')}
      />
      <div className="grid grid-cols-2 gap-4">
        <TextField
          label={t('fields.setupBuffer')}
          inputMode="numeric"
          hint={t('fields.minutes')}
          error={errors.setupBufferMin?.message}
          {...form.register('setupBufferMin')}
        />
        <TextField
          label={t('fields.cleanupBuffer')}
          inputMode="numeric"
          hint={t('fields.minutes')}
          error={errors.cleanupBufferMin?.message}
          {...form.register('cleanupBufferMin')}
        />
      </div>
      <TextField
        label={t('fields.baseRent', { currency: tenant.currency })}
        hint={t('fields.baseRentHint')}
        inputMode="decimal"
        isolate
        error={errors.baseRent?.message}
        {...form.register('baseRent')}
      />

      {!editing ? (
        <CheckboxField label={t('fields.combined')} {...form.register('isCombined')} />
      ) : null}
      {showComponents ? (
        <fieldset className="grid gap-2" data-testid="space-components">
          <legend className="text-sm font-medium">{t('fields.components')}</legend>
          <p className="text-muted-foreground text-xs">{t('fields.componentsHint')}</p>
          {choices.length < 2 ? (
            <p className="text-muted-foreground text-sm">{t('fields.componentsNeedTwo')}</p>
          ) : null}
          <Controller
            control={form.control}
            name="componentIds"
            render={({ field }) => (
              <div className="grid gap-2">
                {choices.map((choice) => (
                  <CheckboxField
                    key={choice.id}
                    label={choice.name}
                    checked={field.value.includes(choice.id)}
                    onChange={(event) =>
                      field.onChange(
                        event.target.checked
                          ? [...field.value, choice.id]
                          : field.value.filter((id) => id !== choice.id),
                      )
                    }
                  />
                ))}
              </div>
            )}
          />
          {errors.componentIds?.message ? (
            <p role="alert" className="text-destructive text-xs">
              {errors.componentIds.message}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
    </form>
  );
}
