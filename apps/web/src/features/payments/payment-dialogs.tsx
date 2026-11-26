'use client';

import { minorUnits } from '@venueos/shared';
import type { PaymentDto, PaymentsOverviewDto, ScheduleItemDto } from '@venueos/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { SelectField, SubmitButton, TextAreaField, TextField } from '@/components/form-fields';
import { FormDialog } from '@/components/resource-ui';
import { Button } from '@/components/ui/button';
import { useFormatters } from '../shell/session';
import {
  newIdempotencyKey,
  useBounceCheque,
  useRecordPayment,
  useReplaceSchedule,
  useRequestRefund,
  useReversePayment,
} from './api';
import {
  MANUAL_METHODS,
  checkSchedule,
  isPositiveAmount,
  needsReference,
  scheduleGap,
} from './logic';
import type { ManualMethod, ScheduleDraftRow } from './logic';

const buttons = (
  pending: boolean,
  submitLabel: string,
  onClose: () => void,
  closeLabel: string,
  testId: string,
) => (
  <div className="flex flex-wrap gap-2">
    <SubmitButton pending={pending} className="w-auto flex-1" data-testid={testId}>
      {submitLabel}
    </SubmitButton>
    <Button type="button" variant="outline" size="lg" className="h-10" onClick={onClose}>
      {closeLabel}
    </Button>
  </div>
);

// ───────────────────────────── record a payment ─────────────────────────────

function RecordForm({
  bookingId,
  currency,
  defaultAmount,
  onClose,
}: {
  bookingId: string;
  currency: string;
  defaultAmount: string;
  onClose: () => void;
}) {
  const t = useTranslations('Payments.record');
  const tm = useTranslations('Payments.methods');
  const record = useRecordPayment(bookingId);
  // One key per opening of the dialog: a retry of the same submission replays, a new payment is a new opening.
  const [key] = useState(newIdempotencyKey);
  const decimals = minorUnits(currency);
  const [method, setMethod] = useState<ManualMethod>('CASH');
  const [amount, setAmount] = useState(defaultAmount);
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; reference?: string }>({});

  const submit = async () => {
    const next: typeof errors = {};
    if (!isPositiveAmount(amount, decimals)) next.amount = t('amountInvalid', { decimals });
    if (needsReference(method) && reference.trim() === '') next.reference = t('referenceRequired');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      const saved = await record.mutateAsync({
        key,
        method,
        amount: amount.trim(),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast.success(
        saved.status === 'PENDING'
          ? t('savedPending')
          : t('saved', { receipt: saved.receiptNo ?? '' }),
      );
      onClose();
    } catch {
      // toasted globally
    }
  };

  return (
    <form
      noValidate
      className="grid gap-4"
      data-testid="record-payment-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <SelectField
        label={t('method')}
        value={method}
        onChange={(event) => setMethod(event.target.value as ManualMethod)}
        data-testid="payment-method"
      >
        {MANUAL_METHODS.map((m) => (
          <option key={m} value={m}>
            {tm(m)}
          </option>
        ))}
      </SelectField>
      <TextField
        label={t('amount', { currency })}
        inputMode="decimal"
        value={amount}
        error={errors.amount}
        onChange={(event) => setAmount(event.target.value)}
        data-testid="payment-amount"
      />
      <TextField
        label={needsReference(method) ? t('chequeNumber') : t('reference')}
        value={reference}
        maxLength={100}
        error={errors.reference}
        hint={needsReference(method) ? t('chequeHint') : undefined}
        onChange={(event) => setReference(event.target.value)}
        data-testid="payment-reference"
      />
      <TextAreaField
        label={t('notes')}
        value={notes}
        maxLength={1000}
        onChange={(event) => setNotes(event.target.value)}
      />
      {buttons(record.isPending, t('submit'), onClose, t('cancel'), 'payment-submit')}
    </form>
  );
}

export function RecordPaymentDialog(props: {
  open: boolean;
  bookingId: string;
  currency: string;
  /** What is still to be paid on the first open item: a sensible first guess. */
  defaultAmount: string;
  onClose: () => void;
}) {
  const t = useTranslations('Payments.record');
  return (
    <FormDialog
      open={props.open}
      onClose={props.onClose}
      title={t('title')}
      description={t('description')}
    >
      {props.open ? <RecordForm {...props} /> : null}
    </FormDialog>
  );
}

// ───────────────────────────── reverse / bounce ─────────────────────────────

function ReasonForm({
  kind,
  payment,
  onClose,
}: {
  kind: 'reverse' | 'bounce';
  payment: PaymentDto;
  onClose: () => void;
}) {
  const t = useTranslations(`Payments.${kind}`);
  const reverse = useReversePayment();
  const bounce = useBounceCheque();
  const [key] = useState(newIdempotencyKey);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const pending = reverse.isPending || bounce.isPending;

  const submit = async () => {
    const text = reason.trim();
    if (kind === 'reverse' && text.length < 3) return setError(t('reasonRequired'));
    if (text !== '' && text.length < 3) return setError(t('reasonRequired'));
    setError(undefined);
    try {
      if (kind === 'reverse') await reverse.mutateAsync({ id: payment.id, key, reason: text });
      else await bounce.mutateAsync({ id: payment.id, ...(text ? { reason: text } : {}) });
      toast.success(t('done'));
      onClose();
    } catch {
      // toasted globally
    }
  };

  return (
    <form
      noValidate
      className="grid gap-4"
      data-testid={`${kind}-form`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm">
        {payment.receiptNo ?? ''} · {payment.amount}
      </p>
      <TextAreaField
        label={kind === 'reverse' ? t('reason') : t('reasonOptional')}
        value={reason}
        maxLength={500}
        error={error}
        onChange={(event) => setReason(event.target.value)}
        data-testid={`${kind}-reason`}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton
          pending={pending}
          variant="destructive"
          className="w-auto flex-1"
          data-testid={`${kind}-submit`}
        >
          {t('submit')}
        </SubmitButton>
        <Button type="button" variant="outline" size="lg" className="h-10" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

export function ReasonDialog({
  kind,
  payment,
  onClose,
}: {
  kind: 'reverse' | 'bounce';
  payment: PaymentDto | null;
  onClose: () => void;
}) {
  const t = useTranslations(`Payments.${kind}`);
  return (
    <FormDialog
      open={payment !== null}
      onClose={onClose}
      title={t('title')}
      description={t('description')}
    >
      {payment ? <ReasonForm kind={kind} payment={payment} onClose={onClose} /> : null}
    </FormDialog>
  );
}

// ───────────────────────────── request a refund ─────────────────────────────

function RefundForm({
  bookingId,
  currency,
  suggested,
  refundable,
  onClose,
}: {
  bookingId: string;
  currency: string;
  suggested: string | null;
  refundable: string;
  onClose: () => void;
}) {
  const t = useTranslations('Payments.refundRequest');
  const request = useRequestRefund(bookingId);
  const [key] = useState(newIdempotencyKey);
  const decimals = minorUnits(currency);
  const [amount, setAmount] = useState(suggested ?? refundable);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});

  const submit = async () => {
    const next: typeof errors = {};
    if (!isPositiveAmount(amount, decimals)) next.amount = t('amountInvalid', { decimals });
    if (reason.trim().length < 3) next.reason = t('reasonRequired');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      await request.mutateAsync({ key, amount: amount.trim(), reason: reason.trim() });
      toast.success(t('done'));
      onClose();
    } catch {
      // toasted globally
    }
  };

  return (
    <form
      noValidate
      className="grid gap-4"
      data-testid="refund-request-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {suggested !== null ? (
        <p className="text-muted-foreground text-sm" data-testid="refund-suggested">
          {t('suggested', { amount: suggested })}
        </p>
      ) : null}
      <TextField
        label={t('amount', { currency })}
        inputMode="decimal"
        value={amount}
        error={errors.amount}
        hint={t('upTo', { amount: refundable })}
        onChange={(event) => setAmount(event.target.value)}
        data-testid="refund-amount"
      />
      <TextAreaField
        label={t('reason')}
        value={reason}
        maxLength={500}
        error={errors.reason}
        onChange={(event) => setReason(event.target.value)}
        data-testid="refund-reason"
      />
      {buttons(request.isPending, t('submit'), onClose, t('cancel'), 'refund-submit')}
    </form>
  );
}

export function RefundRequestDialog(props: {
  open: boolean;
  bookingId: string;
  currency: string;
  suggested: string | null;
  refundable: string;
  onClose: () => void;
}) {
  const t = useTranslations('Payments.refundRequest');
  return (
    <FormDialog
      open={props.open}
      onClose={props.onClose}
      title={t('title')}
      description={t('description')}
    >
      {props.open ? <RefundForm {...props} /> : null}
    </FormDialog>
  );
}

// ───────────────────────────── edit the schedule ─────────────────────────────

function ScheduleForm({
  bookingId,
  currency,
  grandTotal,
  items,
  onClose,
}: {
  bookingId: string;
  currency: string;
  grandTotal: string;
  items: readonly ScheduleItemDto[];
  onClose: () => void;
}) {
  const t = useTranslations('Payments.schedule');
  const format = useFormatters();
  const replace = useReplaceSchedule(bookingId);
  const decimals = minorUnits(currency);
  const [rows, setRows] = useState<ScheduleDraftRow[]>(
    items.map((i) => ({ label: i.label, dueDate: i.dueDate, amount: i.amount })),
  );
  const [error, setError] = useState<string | undefined>();
  const gap = scheduleGap(rows, grandTotal, decimals);
  const setRow = (index: number, patch: Partial<ScheduleDraftRow>) =>
    setRows((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const submit = async () => {
    const problem = checkSchedule(rows, grandTotal, decimals);
    if (problem) {
      setError(
        problem.problem === 'EMPTY'
          ? t('noItems')
          : problem.problem === 'ROW'
            ? t('rowInvalid', { n: (problem.row ?? 0) + 1 })
            : t('totalMismatch', { gap: format.money(gap) }),
      );
      return;
    }
    setError(undefined);
    try {
      await replace.mutateAsync({
        items: rows.map((r) => ({
          label: r.label.trim(),
          dueDate: r.dueDate,
          amount: r.amount.trim(),
        })),
      });
      toast.success(t('saved'));
      onClose();
    } catch {
      // toasted globally
    }
  };

  return (
    <form
      noValidate
      className="grid gap-4"
      data-testid="schedule-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {rows.map((row, i) => (
        <div
          key={i}
          className="grid gap-2 rounded-lg border p-3 sm:grid-cols-3"
          data-testid="schedule-edit-row"
        >
          <TextField
            label={t('label')}
            value={row.label}
            maxLength={40}
            onChange={(event) => setRow(i, { label: event.target.value })}
          />
          <TextField
            label={t('dueDate')}
            type="date"
            value={row.dueDate}
            onChange={(event) => setRow(i, { dueDate: event.target.value })}
          />
          <div className="flex items-end gap-1">
            <div className="min-w-0 flex-1">
              <TextField
                label={t('amount', { currency })}
                inputMode="decimal"
                value={row.amount}
                onChange={(event) => setRow(i, { amount: event.target.value })}
              />
            </div>
            {rows.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('removeRow', { n: i + 1 })}
                onClick={() => setRows((current) => current.filter((_, k) => k !== i))}
              >
                <Trash2 aria-hidden />
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        onClick={() => setRows((current) => [...current, { label: '', dueDate: '', amount: '' }])}
      >
        <Plus aria-hidden />
        {t('addRow')}
      </Button>
      <p className="text-sm" data-testid="schedule-gap">
        {/^-?0+(\.0+)?$/.test(gap)
          ? t('addsUp', { total: format.money(grandTotal) })
          : t('toFill', { gap: format.money(gap), total: format.money(grandTotal) })}
      </p>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {buttons(replace.isPending, t('save'), onClose, t('cancel'), 'schedule-submit')}
    </form>
  );
}

export function ScheduleDialog({
  open,
  overview,
  onClose,
}: {
  open: boolean;
  overview: PaymentsOverviewDto;
  onClose: () => void;
}) {
  const t = useTranslations('Payments.schedule');
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t('title')}
      description={t('description')}
      wide
    >
      {open ? (
        <ScheduleForm
          bookingId={overview.bookingId}
          currency={overview.currency}
          grandTotal={overview.summary.grandTotal}
          items={overview.schedule}
          onClose={onClose}
        />
      ) : null}
    </FormDialog>
  );
}
