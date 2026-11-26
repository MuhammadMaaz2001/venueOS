'use client';

import { QuoteInputSchema } from '@venueos/shared';
import type { BookingDetailDto, QuoteInput, QuotePreviewDto } from '@venueos/shared';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { SelectField, SubmitButton, TextAreaField, TextField } from '@/components/form-fields';
import { NoAccess } from '@/components/resource-ui';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api/errors';
import { useDebounced } from '@/lib/use-debounced';
import { useAddOns, usePackages } from '../catalogue/api';
import { useLead } from '../leads/api';
import { useCancellationPolicies } from '../pricing/api';
import { useEventTypes, useSlots, useSpaces, useVenues } from '../setup/api';
import { useSession } from '../shell/session';
import { useBooking, useCreateQuotation, useQuotePreview, useUpdateBooking } from './api';
import { CustomerPicker } from './parts';
import type { PickedCustomer } from './parts';
import { QuoteLines, QuoteWarnings } from './quote-view';

interface SessionRow {
  key: string;
  id: string;
  spaceId: string;
  date: string;
  slotId: string;
  startTime: string;
  endTime: string;
  eventTypeId: string;
  packageId: string;
  guests: string;
  guaranteedGuests: string;
  addOns: { addOnId: string; quantity: string }[];
  setupNotes: string;
  kitchenNotes: string;
}

let rowCounter = 0;
const newRow = (over: Partial<SessionRow> = {}): SessionRow => ({
  key: `row-${++rowCounter}`,
  id: '',
  spaceId: '',
  date: '',
  slotId: '',
  startTime: '',
  endTime: '',
  eventTypeId: '',
  packageId: '',
  guests: '100',
  guaranteedGuests: '',
  addOns: [],
  setupNotes: '',
  kitchenNotes: '',
  ...over,
});

/** Rows of the form -> the body the API takes. `null` while a row is not complete enough to be priced. */
export function toQuoteInput(
  venueId: string,
  customerId: string | undefined,
  leadId: string | undefined,
  rows: readonly SessionRow[],
  discount: { type: 'PERCENT' | 'AMOUNT'; value: string } | null,
  policyId: string,
  notes: string,
): QuoteInput | null {
  if (venueId === '' || rows.length === 0) return null;
  const candidate = {
    venueId,
    ...(customerId ? { customerId } : {}),
    ...(leadId ? { leadId } : {}),
    sessions: rows.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      spaceId: row.spaceId,
      date: row.date,
      slotId: row.slotId,
      ...(row.startTime ? { startTime: row.startTime } : {}),
      ...(row.endTime ? { endTime: row.endTime } : {}),
      eventTypeId: row.eventTypeId === '' ? null : row.eventTypeId,
      packageId: row.packageId === '' ? null : row.packageId,
      guests: Number(row.guests),
      guaranteedGuests: row.guaranteedGuests === '' ? null : Number(row.guaranteedGuests),
      addOns: row.addOns.map((a) => ({ addOnId: a.addOnId, quantity: Number(a.quantity) })),
      setupNotes: row.setupNotes === '' ? null : row.setupNotes,
      kitchenNotes: row.kitchenNotes === '' ? null : row.kitchenNotes,
    })),
    discount: discount && discount.value !== '' ? discount : null,
    cancellationPolicyId: policyId === '' ? null : policyId,
    notes: notes === '' ? null : notes,
  };
  const parsed = QuoteInputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function rowsFromBooking(booking: BookingDetailDto): SessionRow[] {
  return booking.sessions
    .filter((s) => s.status === 'ACTIVE')
    .map((s) =>
      newRow({
        id: s.id ?? '',
        spaceId: s.spaceId,
        date: s.date,
        slotId: s.slotId,
        eventTypeId: s.eventTypeId ?? '',
        packageId: s.packageId ?? '',
        guests: String(s.guests),
        guaranteedGuests: s.guaranteedGuests === null ? '' : String(s.guaranteedGuests),
        addOns: s.addOns.map((a) => ({ addOnId: a.addOnId, quantity: String(a.quantity) })),
        setupNotes: s.setupNotes ?? '',
        kitchenNotes: s.kitchenNotes ?? '',
      }),
    );
}

function SessionEditor({
  index,
  row,
  venueId,
  onChange,
  onRemove,
  canRemove,
}: {
  index: number;
  row: SessionRow;
  venueId: string;
  onChange: (patch: Partial<SessionRow>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const t = useTranslations('Bookings.builder');
  const spaces = useSpaces(venueId === '' ? undefined : venueId);
  const slots = useSlots(venueId === '' ? undefined : venueId);
  const eventTypes = useEventTypes();
  const packages = usePackages();
  const addOns = useAddOns();
  const slot = slots.data?.data.find((s) => s.id === row.slotId);
  const hourly = slot?.mode === 'HOURLY';
  const addOnList = addOns.data?.data ?? [];
  const unused = addOnList.filter((a) => !row.addOns.some((x) => x.addOnId === a.id));

  return (
    <Card data-testid="session-editor" data-index={index}>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{t('session', { n: index + 1 })}</CardTitle>
        {canRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label={t('removeSession', { n: index + 1 })}
            data-testid="session-remove"
          >
            <Trash2 aria-hidden />
            {t('remove')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={t('eventType')}
          value={row.eventTypeId}
          onChange={(e) => onChange({ eventTypeId: e.target.value })}
          data-testid="session-event-type"
        >
          <option value="">{t('none')}</option>
          {(eventTypes.data?.data ?? []).map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('space')}
          value={row.spaceId}
          onChange={(e) => onChange({ spaceId: e.target.value })}
          data-testid="session-space"
        >
          <option value="">{t('choose')}</option>
          {(spaces.data?.data ?? []).map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('date')}
          type="date"
          value={row.date}
          onChange={(e) => onChange({ date: e.target.value })}
          data-testid="session-date"
        />
        <SelectField
          label={t('slot')}
          value={row.slotId}
          onChange={(e) => onChange({ slotId: e.target.value })}
          data-testid="session-slot"
        >
          <option value="">{t('choose')}</option>
          {(slots.data?.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.startTime}–{s.endTime})
            </option>
          ))}
        </SelectField>
        {hourly ? (
          <>
            <TextField
              label={t('startTime')}
              type="time"
              value={row.startTime}
              onChange={(e) => onChange({ startTime: e.target.value })}
            />
            <TextField
              label={t('endTime')}
              type="time"
              value={row.endTime}
              onChange={(e) => onChange({ endTime: e.target.value })}
            />
          </>
        ) : null}
        <TextField
          label={t('guests')}
          type="number"
          inputMode="numeric"
          min={1}
          value={row.guests}
          onChange={(e) => onChange({ guests: e.target.value })}
          data-testid="session-guests"
        />
        <TextField
          label={t('guaranteed')}
          hint={t('guaranteedHint')}
          type="number"
          inputMode="numeric"
          min={1}
          value={row.guaranteedGuests}
          onChange={(e) => onChange({ guaranteedGuests: e.target.value })}
          data-testid="session-guaranteed"
        />
        <SelectField
          label={t('package')}
          value={row.packageId}
          onChange={(e) => onChange({ packageId: e.target.value })}
          data-testid="session-package"
        >
          <option value="">{t('none')}</option>
          {(packages.data?.data ?? []).map((pkg) => (
            <option key={pkg.id} value={pkg.id}>
              {pkg.name}
            </option>
          ))}
        </SelectField>
        <div className="grid gap-2 sm:col-span-2">
          <p className="text-sm font-medium">{t('addOns')}</p>
          {row.addOns.map((chosen) => {
            const def = addOnList.find((a) => a.id === chosen.addOnId);
            return (
              <div
                key={chosen.addOnId}
                className="flex flex-wrap items-end gap-2"
                data-testid="session-addon"
              >
                <span className="min-w-32 flex-1 text-sm">{def?.name ?? chosen.addOnId}</span>
                {def?.pricing === 'PER_UNIT' ? (
                  <div className="w-28">
                    <TextField
                      label={t('quantity')}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={chosen.quantity}
                      onChange={(e) =>
                        onChange({
                          addOns: row.addOns.map((a) =>
                            a.addOnId === chosen.addOnId ? { ...a, quantity: e.target.value } : a,
                          ),
                        })
                      }
                    />
                  </div>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('removeAddOn', { name: def?.name ?? '' })}
                  onClick={() =>
                    onChange({ addOns: row.addOns.filter((a) => a.addOnId !== chosen.addOnId) })
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            );
          })}
          {unused.length > 0 ? (
            <SelectField
              label={t('addAddOn')}
              value=""
              onChange={(e) => {
                if (e.target.value)
                  onChange({ addOns: [...row.addOns, { addOnId: e.target.value, quantity: '1' }] });
              }}
              data-testid="session-addon-add"
            >
              <option value="">{t('choose')}</option>
              {unused.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </SelectField>
          ) : null}
        </div>
        <TextAreaField
          label={t('setupNotes')}
          value={row.setupNotes}
          maxLength={2000}
          onChange={(e) => onChange({ setupNotes: e.target.value })}
        />
        <TextAreaField
          label={t('kitchenNotes')}
          value={row.kitchenNotes}
          maxLength={2000}
          onChange={(e) => onChange({ kitchenNotes: e.target.value })}
        />
      </CardContent>
    </Card>
  );
}

/**
 * The quotation builder (module 7): one or more sessions (functions), the customer, a discount within the role's limit,
 * and the live breakdown from the server (`/v1/quotations/preview`; the browser never prices anything). With `?bookingId=`
 * it edits a draft. Saving opens the booking, where the quotation is sent and the slot is held.
 */
export function QuotationBuilder() {
  const t = useTranslations('Bookings.builder');
  const params = useSearchParams();
  const { can } = useSession();
  const bookingId = params.get('bookingId') ?? '';
  const existing = useBooking(bookingId, bookingId !== '');
  if (!can('quotation.manage')) return <NoAccess text={t('noAccess')} />;
  if (bookingId !== '' && existing.isPending) {
    return (
      <div className="mx-auto grid max-w-5xl gap-3" aria-busy="true">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (bookingId !== '' && !existing.data) {
    return (
      <Alert variant="destructive" role="alert" className="mx-auto max-w-3xl">
        <AlertDescription>{t('loadFailed')}</AlertDescription>
      </Alert>
    );
  }
  return <BuilderForm key={bookingId} existing={existing.data ?? null} />;
}

function BuilderForm({ existing }: { existing: BookingDetailDto | null }) {
  const t = useTranslations('Bookings.builder');
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useSession();
  const leadId = params.get('leadId') ?? '';
  const editing = existing !== null;
  const bookingId = existing?.id ?? '';

  const venues = useVenues({ enabled: can('venue.view') });
  const lead = useLead(leadId, leadId !== '');
  const policies = useCancellationPolicies({ enabled: can('pricing.view') });
  const preview = useQuotePreview();
  const create = useCreateQuotation();
  const update = useUpdateBooking();

  // What the person chose; the venue and customer fall back to the lead's, then the first venue (derived, not copied).
  const [venueChoice, setVenueChoice] = useState(existing?.venueId ?? params.get('venueId') ?? '');
  const [picked, setPicked] = useState<PickedCustomer | null>(
    existing
      ? { id: existing.customer.id, name: existing.customer.name, phone: existing.customer.phone }
      : null,
  );
  const [rows, setRows] = useState<SessionRow[]>(() =>
    existing
      ? rowsFromBooking(existing)
      : [
          newRow({
            spaceId: params.get('spaceId') ?? '',
            slotId: params.get('slotId') ?? '',
            date: params.get('date') ?? '',
          }),
        ],
  );
  const [discountType, setDiscountType] = useState<'PERCENT' | 'AMOUNT'>(
    existing?.discount?.type ?? 'PERCENT',
  );
  const [discountValue, setDiscountValue] = useState(existing?.discount?.value ?? '');
  const [policyId, setPolicyId] = useState(existing?.cancellationPolicy?.policyId ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [outcome, setOutcome] = useState<{
    input: string;
    result: QuotePreviewDto | null;
    message: string | undefined;
  } | null>(null);

  const venueId = venueChoice || lead.data?.venueId || venues.data?.data[0]?.id || '';
  const customer: PickedCustomer | null =
    picked ??
    (lead.data
      ? {
          id: lead.data.customer.id,
          name: lead.data.customer.name,
          phone: lead.data.customer.phone,
        }
      : null);
  const setCustomer = setPicked;
  const customerIdParam = params.get('customerId') ?? '';

  const customerId = customer?.id ?? (customerIdParam || undefined);
  const input = useMemo(
    () =>
      toQuoteInput(
        venueId,
        customerId,
        leadId || undefined,
        rows,
        discountValue === '' ? null : { type: discountType, value: discountValue },
        policyId,
        notes,
      ),
    [venueId, customerId, leadId, rows, discountType, discountValue, policyId, notes],
  );
  const debouncedInput = useDebounced(JSON.stringify(input));
  const { mutate: runPreview } = preview;
  useEffect(() => {
    if (debouncedInput === 'null') return;
    runPreview(JSON.parse(debouncedInput) as QuoteInput, {
      onSuccess: (data) => setOutcome({ input: debouncedInput, result: data, message: undefined }),
      onError: (error) =>
        setOutcome({
          input: debouncedInput,
          result: null,
          message: isApiError(error) ? error.code : 'NETWORK',
        }),
    });
  }, [debouncedInput, runPreview]);
  // The answer of the latest complete question; anything else (an incomplete form) shows nothing.
  const current = outcome && outcome.input === debouncedInput ? outcome : null;
  const result = current?.result ?? null;
  const message = current?.message;

  const mayCreate = can('booking.create');
  const complete = input !== null && (customerId !== undefined || leadId !== '');
  const canSave = complete && (editing ? can('booking.edit') : mayCreate) && !preview.isPending;
  const setRow = (key: string, patch: Partial<SessionRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const save = async () => {
    if (!input) return;
    try {
      if (existing) {
        const saved = await update.mutateAsync({
          id: bookingId,
          rev: existing.rev,
          sessions: input.sessions,
          discount: input.discount ?? null,
          notes: input.notes ?? null,
          ...(input.cancellationPolicyId !== undefined
            ? { cancellationPolicyId: input.cancellationPolicyId }
            : {}),
        });
        router.push(`/bookings/${saved.id}`);
      } else {
        const saved = await create.mutateAsync(input);
        router.push(`/bookings/${saved.bookingId}`);
      }
    } catch {
      // toasted globally (discount over the limit, a version that changed, ...)
    }
  };

  const maxDiscount = result?.maxDiscountPct;
  const errorText = message
    ? t.has(`errors.${message}`)
      ? t(`errors.${message}`)
      : t('errors.generic')
    : undefined;

  return (
    <div className="mx-auto grid max-w-5xl gap-6" data-testid="quotation-builder">
      <Link
        href={editing ? `/bookings/${bookingId}` : '/bookings'}
        className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
        {t('back')}
      </Link>
      <h1 className="text-2xl font-semibold">{editing ? t('editTitle') : t('title')}</h1>

      {
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="grid gap-4">
            <Card>
              <CardContent className="grid gap-4 pt-4">
                <SelectField
                  label={t('venue')}
                  value={venueId}
                  disabled={editing}
                  onChange={(e) => {
                    setVenueChoice(e.target.value);
                    setRows((current) => current.map((r) => ({ ...r, spaceId: '', slotId: '' })));
                  }}
                  data-testid="builder-venue"
                >
                  {(venues.data?.data ?? []).map((venue) => (
                    <option key={venue.id} value={venue.id}>
                      {venue.name}
                    </option>
                  ))}
                </SelectField>
                {leadId === '' || customer === null ? (
                  <CustomerPicker value={customer} onChange={setCustomer} />
                ) : (
                  <p className="text-sm" data-testid="builder-customer">
                    <span className="text-muted-foreground">{t('customer')}: </span>
                    <span className="font-medium">{customer.name}</span>{' '}
                    <span className="ltr-isolate text-muted-foreground">{customer.phone}</span>
                  </p>
                )}
              </CardContent>
            </Card>

            {rows.map((row, index) => (
              <SessionEditor
                key={row.key}
                index={index}
                row={row}
                venueId={venueId}
                onChange={(patch) => setRow(row.key, patch)}
                onRemove={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                canRemove={rows.length > 1}
              />
            ))}
            {rows.length < 10 ? (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-10 w-fit"
                onClick={() => setRows((current) => [...current, newRow()])}
                data-testid="add-session"
              >
                <Plus aria-hidden />
                {t('addSession')}
              </Button>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('discountTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label={t('discountType')}
                  value={discountType}
                  onChange={(e) => setDiscountType(e.target.value as 'PERCENT' | 'AMOUNT')}
                  data-testid="discount-type"
                >
                  <option value="PERCENT">{t('percent')}</option>
                  <option value="AMOUNT">{t('amount')}</option>
                </SelectField>
                <TextField
                  label={t('discountValue')}
                  inputMode="decimal"
                  value={discountValue}
                  hint={
                    maxDiscount !== undefined ? t('discountLimit', { pct: maxDiscount }) : undefined
                  }
                  onChange={(e) => setDiscountValue(e.target.value)}
                  data-testid="discount-value"
                />
                {can('pricing.view') ? (
                  <SelectField
                    label={t('policy')}
                    value={policyId}
                    onChange={(e) => setPolicyId(e.target.value)}
                  >
                    <option value="">{t('policyDefault')}</option>
                    {(policies.data?.data ?? []).map((policy) => (
                      <option key={policy.id} value={policy.id}>
                        {policy.name}
                      </option>
                    ))}
                  </SelectField>
                ) : null}
                <div className="sm:col-span-2">
                  <TextAreaField
                    label={t('notes')}
                    value={notes}
                    maxLength={2000}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          <aside className="grid content-start gap-3 lg:sticky lg:top-4" aria-label={t('summary')}>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('summary')}</CardTitle>
              </CardHeader>
              <CardContent
                className="grid gap-3"
                data-testid="builder-summary"
                aria-busy={preview.isPending}
              >
                {errorText ? (
                  <Alert variant="destructive" role="alert" data-testid="builder-error">
                    <AlertDescription>{errorText}</AlertDescription>
                  </Alert>
                ) : null}
                {result ? (
                  <>
                    <QuoteWarnings warnings={result.warnings} sessions={result.sessions} />
                    <QuoteLines
                      sessions={result.sessions}
                      lines={result.lines}
                      totals={result.totals}
                    />
                  </>
                ) : !errorText ? (
                  <p className="text-muted-foreground text-sm">
                    {preview.isPending ? t('pricing') : t('fillIn')}
                  </p>
                ) : null}
              </CardContent>
            </Card>
            <SubmitButton
              type="button"
              pending={create.isPending || update.isPending}
              disabled={!canSave}
              onClick={() => void save()}
              data-testid="builder-save"
            >
              {editing ? t('saveChanges') : t('save')}
            </SubmitButton>
          </aside>
        </div>
      }
    </div>
  );
}
