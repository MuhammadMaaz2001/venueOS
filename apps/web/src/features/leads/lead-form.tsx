'use client';

import {
  CreateLeadSchema,
  EmailSchema,
  LEAD_SOURCES,
  UpdateLeadSchema,
  isOpenLeadStage,
  normalizePhone,
} from '@venueos/shared';
import type { CustomerDuplicateDto, LeadDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import {
  CheckboxField,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
} from '@/components/form-fields';
import { Button } from '@/components/ui/button';
import { useDebounced } from '@/lib/use-debounced';
import { useCustomFieldDefs, useCustomers } from '../customers/api';
import {
  CustomFieldInputs,
  fieldPayload,
  initialFieldTexts,
  missingRequired,
} from '../customers/custom-field-inputs';
import type { FieldTexts } from '../customers/custom-field-inputs';
import { DuplicateWarning } from '../customers/duplicate-warning';
import {
  numberOrNull,
  numberOrUndefined,
  showServerFieldErrors,
  textOrNull,
  textOrUndefined,
  useSharedSchemaResolver,
} from '../setup/form-resolver';
import type { Translate } from '../setup/form-resolver';
import { useEventTypes, useVenues } from '../setup/api';
import { useSession } from '../shell/session';
import { useCreateLead, useLeadAssignees, useUpdateLead } from './api';
import { instantToLocalInput, localInputToInstant, presetFollowUp } from './logic';

interface Values {
  venueId: string;
  eventTypeId: string;
  preferredDate: string;
  flexibleDates: boolean;
  guests: string;
  budget: string;
  source: string;
  assigneeId: string;
  nextFollowUpAt: string;
  notes: string;
}

interface PickedCustomer {
  id: string;
  name: string;
  phone: string;
}

/** Who the inquiry is from: a customer picked from the list, or a new one typed in. */
function CustomerChooser({
  picked,
  onPick,
  fixed,
  mode,
  setMode,
  fresh,
  setFresh,
  error,
}: {
  picked: PickedCustomer | null;
  onPick: (customer: PickedCustomer | null) => void;
  fixed: boolean;
  mode: 'existing' | 'new';
  setMode: (mode: 'existing' | 'new') => void;
  fresh: { name: string; phone: string; email: string };
  setFresh: (value: { name: string; phone: string; email: string }) => void;
  error: string | undefined;
}) {
  const t = useTranslations('Leads.form');
  const tc = useTranslations('Customers.fields');
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim());
  const found = useCustomers({
    search: debounced,
    enabled: mode === 'existing' && debounced.length >= 2 && !picked,
  });

  if (fixed && picked) {
    return (
      <p className="text-sm" data-testid="inquiry-customer-fixed">
        <span className="text-muted-foreground">{t('customer')}: </span>
        <span className="font-medium">{picked.name}</span>{' '}
        <span className="ltr-isolate text-muted-foreground">{picked.phone}</span>
      </p>
    );
  }
  return (
    <fieldset className="grid gap-3" data-testid="inquiry-customer">
      <legend className="mb-1 text-sm font-medium">{t('customer')}</legend>
      {can('customer.manage') ? (
        <div className="flex gap-2" role="group" aria-label={t('customer')}>
          <Button
            type="button"
            size="sm"
            variant={mode === 'new' ? 'default' : 'outline'}
            aria-pressed={mode === 'new'}
            onClick={() => setMode('new')}
            data-testid="inquiry-customer-new"
          >
            {t('customerNew')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'existing' ? 'default' : 'outline'}
            aria-pressed={mode === 'existing'}
            onClick={() => setMode('existing')}
            data-testid="inquiry-customer-existing"
          >
            {t('customerExisting')}
          </Button>
        </div>
      ) : null}
      {mode === 'new' ? (
        <>
          <TextField
            label={tc('name')}
            autoComplete="off"
            value={fresh.name}
            onChange={(e) => setFresh({ ...fresh, name: e.target.value })}
            data-testid="inquiry-customer-name"
          />
          <TextField
            label={tc('phone')}
            type="tel"
            isolate
            autoComplete="off"
            value={fresh.phone}
            onChange={(e) => setFresh({ ...fresh, phone: e.target.value })}
            data-testid="inquiry-customer-phone"
          />
          <TextField
            label={tc('email')}
            type="email"
            isolate
            autoComplete="off"
            value={fresh.email}
            onChange={(e) => setFresh({ ...fresh, email: e.target.value })}
          />
          <DuplicateWarning
            phone={fresh.phone}
            email={fresh.email}
            onUse={(match: CustomerDuplicateDto) => {
              onPick({ id: match.id, name: match.name, phone: match.phone });
              setMode('existing');
            }}
          />
        </>
      ) : picked ? (
        <div
          className="flex flex-wrap items-center gap-2 text-sm"
          data-testid="inquiry-customer-picked"
        >
          <span className="font-medium">{picked.name}</span>
          <span className="ltr-isolate text-muted-foreground">{picked.phone}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => onPick(null)}>
            {t('customerChange')}
          </Button>
        </div>
      ) : (
        <>
          <TextField
            label={t('customerSearch')}
            autoComplete="off"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="inquiry-customer-search"
          />
          <ul className="grid gap-1" data-testid="inquiry-customer-results">
            {(found.data?.pages[0]?.data ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="hover:bg-muted/50 flex w-full flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-start text-sm"
                  onClick={() => onPick({ id: c.id, name: c.name, phone: c.phone })}
                  data-testid="inquiry-customer-result"
                >
                  <span className="font-medium">{c.name}</span>
                  <span className="ltr-isolate text-muted-foreground">{c.phone}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * Create an inquiry (`lead` undefined: the customer is picked or created inline) or edit one. The stage is not part of
 * this form: moving a lead has its own actions on the lead page and the board.
 */
export function LeadForm({
  lead,
  customer,
  onDone,
}: {
  lead?: LeadDto | undefined;
  /** A customer the inquiry is for (the customer page). */
  customer?: PickedCustomer | undefined;
  onDone: (saved: LeadDto) => void;
}) {
  const t = useTranslations('Leads.form');
  const ts = useTranslations('Leads');
  const tv = useTranslations('Validation');
  const tc = useTranslations('Customers.fields');
  const { tenant, user } = useSession();
  const create = useCreateLead();
  const update = useUpdateLead();
  const venues = useVenues();
  const eventTypes = useEventTypes();
  const defsQuery = useCustomFieldDefs('lead');
  const defs = (defsQuery.data?.data ?? []).filter((d) => d.active);

  const open = lead ? isOpenLeadStage(lead.stage) : true;
  const venueList = (venues.data?.data ?? []).filter((v) => v.active);

  const initialTexts = initialFieldTexts(defs, lead?.customFields);
  const [texts, setTexts] = useState<FieldTexts | null>(null);
  const currentTexts = texts ?? initialTexts;
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [picked, setPicked] = useState<PickedCustomer | null>(customer ?? null);
  const [mode, setMode] = useState<'existing' | 'new'>(customer ? 'existing' : 'new');
  const [fresh, setFresh] = useState({ name: '', phone: '', email: '' });
  const [customerError, setCustomerError] = useState<string | undefined>();

  const toPayload = (v: Values) => {
    const nextFollowUpAt = localInputToInstant(v.nextFollowUpAt, tenant.timezone) ?? '';
    if (lead) {
      return {
        rev: lead.rev,
        ...(v.venueId !== lead.venueId ? { venueId: v.venueId } : {}),
        eventTypeId: textOrNull(v.eventTypeId),
        preferredDate: textOrNull(v.preferredDate),
        flexibleDates: v.flexibleDates,
        guests: numberOrNull(v.guests),
        budget: textOrNull(v.budget),
        source: v.source,
        ...(v.assigneeId !== (lead.assignee?.membershipId ?? 'none')
          ? { assigneeId: v.assigneeId === 'none' ? null : v.assigneeId }
          : {}),
        ...(open ? { nextFollowUpAt } : {}),
        notes: textOrNull(v.notes),
      };
    }
    return {
      venueId: v.venueId,
      ...(picked
        ? { customerId: picked.id }
        : { customer: { name: fresh.name.trim(), phone: fresh.phone.trim() } }),
      ...(textOrUndefined(v.eventTypeId) === undefined ? {} : { eventTypeId: v.eventTypeId }),
      ...(textOrUndefined(v.preferredDate) === undefined ? {} : { preferredDate: v.preferredDate }),
      flexibleDates: v.flexibleDates,
      ...(numberOrUndefined(v.guests) === undefined ? {} : { guests: numberOrUndefined(v.guests) }),
      ...(textOrUndefined(v.budget) === undefined ? {} : { budget: v.budget.trim() }),
      source: v.source,
      ...(v.assigneeId === '' ? {} : { assigneeId: v.assigneeId === 'none' ? null : v.assigneeId }),
      nextFollowUpAt,
      ...(textOrUndefined(v.notes) === undefined ? {} : { notes: v.notes.trim() }),
    };
  };

  const form = useForm<Values>({
    defaultValues: {
      venueId: lead?.venueId ?? '',
      eventTypeId: lead?.eventTypeId ?? '',
      preferredDate: lead?.preferredDate ?? '',
      flexibleDates: lead?.flexibleDates ?? false,
      guests: lead?.guests == null ? '' : String(lead.guests),
      budget: lead?.budget ?? '',
      source: lead?.source ?? 'phone',
      assigneeId: lead ? (lead.assignee?.membershipId ?? 'none') : '',
      nextFollowUpAt: lead?.nextFollowUpAt
        ? instantToLocalInput(lead.nextFollowUpAt, tenant.timezone)
        : presetFollowUp(1, tenant.timezone),
      notes: lead?.notes ?? '',
    },
    resolver: useSharedSchemaResolver<Values>(
      lead ? UpdateLeadSchema : CreateLeadSchema,
      toPayload,
    ),
  });
  const errors = form.formState.errors;
  const venueId = useWatch({ control: form.control, name: 'venueId' });

  // A workspace with one venue does not ask which one.
  useEffect(() => {
    if (!lead && venueId === '' && venueList.length === 1 && venueList[0]) {
      form.setValue('venueId', venueList[0].id);
    }
  }, [lead, venueId, venueList, form]);

  const assignees = useLeadAssignees(venueId, venueId !== '');
  const assigneeOptions = assignees.data?.data ?? [];

  const onSubmit = form.handleSubmit(async (values) => {
    let blocked = false;
    setCustomerError(undefined);
    if (!lead && !picked) {
      if (fresh.name.trim() === '') {
        setCustomerError(tv('required'));
        blocked = true;
      } else if (!normalizePhone(fresh.phone, tenant.country).ok) {
        setCustomerError(ts('form.phoneInvalid'));
        blocked = true;
      } else if (fresh.email.trim() !== '' && !EmailSchema.safeParse(fresh.email).success) {
        setCustomerError(tv('email'));
        blocked = true;
      }
    }
    const missing = missingRequired(defs, currentTexts, lead?.customFields);
    setFieldErrors(Object.fromEntries(missing.map((k) => [k, tv('required')])));
    if (blocked || missing.length > 0) return;

    try {
      const customFields = fieldPayload(defs, currentTexts, lead ? initialTexts : undefined);
      const base = toPayload(values) as Record<string, unknown>;
      if (!lead && !picked && fresh.email.trim() !== '') {
        (base.customer as Record<string, unknown>).email = fresh.email.trim();
      }
      const payload = { ...base, ...(customFields ? { customFields } : {}) };
      const saved = lead
        ? await update.mutateAsync({ ...(payload as { rev: number }), id: lead.id })
        : await create.mutateAsync(payload as Parameters<typeof create.mutateAsync>[0]);
      toast.success(lead ? ts('form.saved') : ts('form.created'));
      onDone(saved);
    } catch (error) {
      showServerFieldErrors(form, tv as Translate, error);
    }
  });

  const setFollowUp = (days: number) =>
    form.setValue('nextFollowUpAt', presetFollowUp(days, tenant.timezone), { shouldDirty: true });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="lead-form">
      {lead ? null : (
        <CustomerChooser
          picked={picked}
          onPick={setPicked}
          fixed={customer !== undefined}
          mode={mode}
          setMode={setMode}
          fresh={fresh}
          setFresh={setFresh}
          error={
            customerError ??
            (errors as Record<string, { message?: string }>).customer?.message ??
            (errors as Record<string, { message?: string }>).customerId?.message
          }
        />
      )}
      <SelectField label={t('venue')} error={errors.venueId?.message} {...form.register('venueId')}>
        <option value="">{t('chooseVenue')}</option>
        {venueList.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </SelectField>
      <SelectField label={t('eventType')} {...form.register('eventTypeId')}>
        <option value="">{t('noEventType')}</option>
        {(eventTypes.data?.data ?? [])
          .filter((e) => e.active || e.id === lead?.eventTypeId)
          .map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
      </SelectField>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={t('preferredDate')}
          type="date"
          error={errors.preferredDate?.message}
          {...form.register('preferredDate')}
        />
        <TextField
          label={t('guests')}
          inputMode="numeric"
          autoComplete="off"
          isolate
          error={errors.guests?.message}
          {...form.register('guests')}
        />
      </div>
      <CheckboxField label={t('flexibleDates')} {...form.register('flexibleDates')} />
      <TextField
        label={t('budget', { currency: tenant.currency })}
        inputMode="decimal"
        autoComplete="off"
        isolate
        error={errors.budget?.message}
        {...form.register('budget')}
      />
      <SelectField label={t('source')} error={errors.source?.message} {...form.register('source')}>
        {LEAD_SOURCES.map((s) => (
          <option key={s} value={s}>
            {ts(`sources.${s}`)}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t('assignee')}
        hint={lead ? undefined : t('assigneeHint')}
        error={errors.assigneeId?.message}
        {...form.register('assigneeId')}
        data-testid="lead-assignee"
      >
        {lead ? null : <option value="">{t('assigneeDefault')}</option>}
        <option value="none">{t('assigneeNobody')}</option>
        {assigneeOptions.map((a) => (
          <option key={a.membershipId} value={a.membershipId}>
            {a.userId === user.id ? t('assigneeMe', { name: a.name }) : a.name}
          </option>
        ))}
      </SelectField>
      {open ? (
        <div className="grid gap-2">
          <TextField
            label={t('nextFollowUp', { timezone: tenant.timezone })}
            type="datetime-local"
            error={errors.nextFollowUpAt?.message ? tv('required') : undefined}
            {...form.register('nextFollowUpAt')}
            data-testid="lead-follow-up"
          />
          <div className="flex flex-wrap gap-2">
            {([1, 3, 7] as const).map((days) => (
              <Button
                key={days}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFollowUp(days)}
              >
                {t(`preset.${days}`)}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <TextAreaField
        label={tc('notes')}
        error={errors.notes?.message}
        {...form.register('notes')}
      />
      <CustomFieldInputs
        defs={defs}
        texts={currentTexts}
        onChange={(key, value) => setTexts({ ...currentTexts, [key]: value })}
        stored={lead?.customFields}
        errors={fieldErrors}
      />
      <SubmitButton pending={create.isPending || update.isPending} data-testid="lead-submit">
        {lead ? t('save') : t('create')}
      </SubmitButton>
    </form>
  );
}
