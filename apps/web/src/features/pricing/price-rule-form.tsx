'use client';

import { ADJUSTMENT_KINDS, CreatePriceRuleSchema, PRICE_RULE_KINDS } from '@venueos/shared';
import type { AdjustmentKind, PriceRuleDto, PriceRuleKind } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { CheckboxField, SelectField, SubmitButton, TextField } from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { useSlots, useSpaces, useVenues } from '../setup/api';
import { showServerFieldErrors, useSharedSchemaResolver } from '../setup/form-resolver';
import type { Translate } from '../setup/form-resolver';
import { useSession } from '../shell/session';
import { useCreatePriceRule, useUpdatePriceRule } from './api';

interface Values {
  name: string;
  kind: PriceRuleKind;
  venueId: string;
  spaceId: string;
  slotId: string;
  daysOfWeek: number[];
  startDate: string;
  endDate: string;
  adjustment: AdjustmentKind;
  value: string;
  priority: string;
}

const DAYS = [1, 2, 3, 4, 5, 6, 0] as const; // Monday first

function initial(rule: PriceRuleDto | undefined, firstVenue: string): Values {
  return {
    name: rule?.name ?? '',
    kind: rule?.kind ?? 'DAY_OF_WEEK',
    venueId: rule?.venueId ?? firstVenue,
    spaceId: rule?.spaceId ?? '',
    slotId: rule?.slotId ?? '',
    daysOfWeek: rule?.daysOfWeek ?? [],
    startDate: rule?.startDate ?? '',
    endDate: rule?.endDate ?? '',
    adjustment: rule?.adjustment ?? 'PERCENT',
    value: rule?.value ?? '',
    priority: String(rule?.priority ?? 0),
  };
}

/** The API's body for a form's values. Only what the rule's kind uses is sent; the rest is cleared. */
export function priceRulePayload(v: Values) {
  return {
    name: v.name.trim(),
    kind: v.kind,
    spaceId: v.spaceId === '' ? null : v.spaceId,
    slotId: v.slotId === '' ? null : v.slotId,
    daysOfWeek: v.kind === 'DAY_OF_WEEK' ? v.daysOfWeek : [],
    startDate: v.kind === 'DAY_OF_WEEK' || v.startDate === '' ? null : v.startDate,
    endDate: v.kind !== 'DATE_RANGE' || v.endDate === '' ? null : v.endDate,
    adjustment: v.adjustment,
    value: v.value.trim(),
    priority: v.priority.trim() === '' ? 0 : Number(v.priority),
  };
}

/**
 * Add or edit a price rule: when it applies (weekdays, a season, one date), where (all spaces and slots, or one
 * space and/or slot of a venue) and what it does (percent, fixed amount, or the rent becomes exactly this).
 */
export function PriceRuleForm({
  rule,
  onDone,
}: {
  rule?: PriceRuleDto | undefined;
  onDone: () => void;
}) {
  const t = useTranslations('Pricing.rules');
  const td = useTranslations('Setup.days');
  const tv = useTranslations('Validation');
  const { tenant, access } = useSession();
  const create = useCreatePriceRule();
  const update = useUpdatePriceRule();
  const venues = useVenues();
  // Someone limited to some venues can only add rules for a space or slot of theirs, never "everywhere".
  const limited = access.venueIds.length > 0;

  const form = useForm<Values>({
    defaultValues: initial(rule, limited ? (access.venueIds[0] ?? '') : ''),
    resolver: useSharedSchemaResolver<Values>(CreatePriceRuleSchema, priceRulePayload),
  });
  const errors = form.formState.errors;
  const kind = useWatch({ control: form.control, name: 'kind' });
  const venueId = useWatch({ control: form.control, name: 'venueId' });
  const adjustment = useWatch({ control: form.control, name: 'adjustment' });
  const spaces = useSpaces(venueId === '' ? undefined : venueId);
  const slots = useSlots(venueId === '' ? undefined : venueId);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = priceRulePayload(values);
      if (rule) await update.mutateAsync({ ...payload, id: rule.id, rev: rule.rev });
      else await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(t('saved'));
      onDone();
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  const toggle = async () => {
    if (!rule) return;
    try {
      await update.mutateAsync({ id: rule.id, rev: rule.rev, active: !rule.active });
      toast.success(t('saved'));
      onDone();
    } catch {
      // Toasted globally.
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="price-rule-form">
      <TextField
        label={t('name')}
        placeholder={t('namePlaceholder')}
        autoComplete="off"
        error={errors.name?.message}
        {...form.register('name')}
      />

      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">{t('when')}</legend>
        <SelectField label={t('kind')} {...form.register('kind')} data-testid="rule-kind">
          {PRICE_RULE_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`kinds.${k}`)}
            </option>
          ))}
        </SelectField>
        {kind === 'DAY_OF_WEEK' ? (
          <Controller
            control={form.control}
            name="daysOfWeek"
            render={({ field }) => (
              <div className="grid gap-1.5">
                <div
                  className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4"
                  role="group"
                  aria-label={t('days')}
                >
                  {DAYS.map((day) => (
                    <CheckboxField
                      key={day}
                      label={td(String(day))}
                      checked={field.value.includes(day)}
                      onChange={(e) =>
                        field.onChange(
                          e.target.checked
                            ? [...field.value, day]
                            : field.value.filter((d) => d !== day),
                        )
                      }
                      data-testid={`rule-day-${day}`}
                    />
                  ))}
                </div>
                {errors.daysOfWeek?.message ? (
                  <p role="alert" className="text-destructive text-xs">
                    {t('daysInvalid')}
                  </p>
                ) : null}
              </div>
            )}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label={kind === 'DATE_RANGE' ? t('from') : t('date')}
              type="date"
              isolate
              error={errors.startDate?.message}
              data-testid="rule-start"
              {...form.register('startDate')}
            />
            {kind === 'DATE_RANGE' ? (
              <TextField
                label={t('to')}
                type="date"
                isolate
                error={errors.endDate?.message}
                data-testid="rule-end"
                {...form.register('endDate')}
              />
            ) : null}
          </div>
        )}
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">{t('where')}</legend>
        <SelectField
          label={t('venue')}
          {...form.register('venueId', {
            onChange: () => {
              form.setValue('spaceId', '');
              form.setValue('slotId', '');
            },
          })}
        >
          {limited ? null : <option value="">{t('everywhere')}</option>}
          {venues.data?.data.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </SelectField>
        {venueId !== '' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label={t('space')}
              error={errors.spaceId?.message}
              {...form.register('spaceId')}
              data-testid="rule-space"
            >
              {limited ? null : <option value="">{t('allSpaces')}</option>}
              {limited && form.getValues('spaceId') === '' ? (
                <option value="">{t('chooseSpace')}</option>
              ) : null}
              {spaces.data?.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={t('slot')}
              error={errors.slotId?.message}
              {...form.register('slotId')}
              data-testid="rule-slot"
            >
              <option value="">{t('allSlots')}</option>
              {slots.data?.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectField>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">{t('what')}</legend>
        <SelectField
          label={t('adjustment')}
          {...form.register('adjustment')}
          data-testid="rule-adjustment"
        >
          {ADJUSTMENT_KINDS.map((a) => (
            <option key={a} value={a}>
              {t(`adjustments.${a}`)}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t(`valueLabel.${adjustment}`)}
          hint={t(`valueHint.${adjustment}`, { currency: tenant.currency })}
          inputMode="decimal"
          isolate
          error={errors.value?.message}
          data-testid="rule-value"
          {...form.register('value')}
        />
        <TextField
          label={t('priority')}
          hint={t('priorityHint')}
          inputMode="numeric"
          isolate
          error={errors.priority?.message}
          {...form.register('priority')}
        />
      </fieldset>

      <SubmitButton pending={create.isPending || update.isPending}>
        {rule ? t('save') : t('create')}
      </SubmitButton>
      {rule ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10"
          disabled={update.isPending}
          onClick={toggle}
          data-testid="rule-toggle"
        >
          {rule.active ? t('deactivate') : t('reactivate')}
        </Button>
      ) : null}
    </form>
  );
}
