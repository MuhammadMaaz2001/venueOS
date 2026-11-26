'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { CheckboxField, SelectField, SubmitButton, TextField } from '@/components/form-fields';
import { FormDialog } from '@/components/resource-ui';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { useEventTypes } from '../setup/api';
import { useFormatters, useSession } from '../shell/session';
import { useBookingAction, useCreateQuotation } from './api';
import { CustomerPicker } from './parts';
import type { PickedCustomer } from './parts';
import Link from 'next/link';

export interface QuickHoldTarget {
  spaceId: string;
  spaceName: string;
  slotId: string;
  slotName: string;
  date: string;
}

/**
 * Click a free calendar cell: pick the customer and the number of guests, and the slot is held (a draft quotation is made
 * and held in the same go). The full quotation builder is one link away for packages, add-ons and discounts.
 */
export function QuickHoldDialog({
  venueId,
  target,
  onClose,
}: {
  venueId: string;
  target: QuickHoldTarget | null;
  onClose: () => void;
}) {
  const t = useTranslations('Bookings.quickHold');
  const router = useRouter();
  const format = useFormatters();
  const { can } = useSession();
  const eventTypes = useEventTypes();
  const create = useCreateQuotation();
  const action = useBookingAction();
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [guests, setGuests] = useState('100');
  const [eventTypeId, setEventTypeId] = useState('');
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const close = () => {
    setCustomer(null);
    setError(undefined);
    setOverride(false);
    setReason('');
    onClose();
  };

  const submit = async () => {
    if (!target) return;
    const count = Number(guests);
    if (!customer) return setError(t('customerRequired'));
    if (!Number.isInteger(count) || count < 1) return setError(t('guestsInvalid'));
    if (override && reason.trim().length < 3) return setError(t('reasonRequired'));
    setError(undefined);
    setBusy(true);
    try {
      const quotation = await create.mutateAsync({
        venueId,
        customerId: customer.id,
        sessions: [
          {
            spaceId: target.spaceId,
            date: target.date,
            slotId: target.slotId,
            guests: count,
            addOns: [],
            ...(eventTypeId ? { eventTypeId } : {}),
          },
        ],
      });
      const booking = await unwrap(
        api.GET('/v1/bookings/{id}', { params: { path: { id: quotation.bookingId } } }),
      );
      await action.mutateAsync({
        action: 'hold',
        id: booking.id,
        body: {
          rev: booking.rev,
          overrideRules: override,
          ...(override ? { reason: reason.trim() } : {}),
        },
      });
      toast.success(t('held'));
      close();
      router.push(`/bookings/${booking.id}`);
    } catch {
      // toasted globally with the booking wording (slot taken, venue rule, ...)
    } finally {
      setBusy(false);
    }
  };

  const builderHref = target
    ? `/quotations/new?venueId=${venueId}&spaceId=${target.spaceId}&slotId=${target.slotId}&date=${target.date}${customer ? `&customerId=${customer.id}` : ''}`
    : '/quotations/new';

  return (
    <FormDialog
      open={target !== null}
      onClose={close}
      title={target ? t('title', { space: target.spaceName, slot: target.slotName }) : ''}
      description={target ? format.dateOnly(target.date, 'long') : ''}
    >
      {target ? (
        <form
          noValidate
          className="grid gap-4"
          data-testid="quick-hold"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <CustomerPicker value={customer} onChange={setCustomer} />
          <TextField
            label={t('guests')}
            type="number"
            inputMode="numeric"
            min={1}
            value={guests}
            onChange={(event) => setGuests(event.target.value)}
            data-testid="quick-guests"
          />
          <SelectField
            label={t('eventType')}
            value={eventTypeId}
            onChange={(event) => setEventTypeId(event.target.value)}
            data-testid="quick-event-type"
          >
            <option value="">{t('noEventType')}</option>
            {(eventTypes.data?.data ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </SelectField>
          {can('booking.override_rules') ? (
            <div className="grid gap-2">
              <CheckboxField
                label={t('override')}
                checked={override}
                onChange={(event) => setOverride(event.target.checked)}
              />
              {override ? (
                <TextField
                  label={t('overrideReason')}
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                />
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton pending={busy} className="w-auto flex-1" data-testid="quick-hold-submit">
              {t('submit')}
            </SubmitButton>
            <Button type="button" variant="outline" size="lg" className="h-10" onClick={close}>
              {t('cancel')}
            </Button>
          </div>
          <Link href={builderHref} className="text-sm underline" data-testid="quick-builder-link">
            {t('fullBuilder')}
          </Link>
        </form>
      ) : null}
    </FormDialog>
  );
}
