'use client';

import { REFUND_STATUSES } from '@venueos/shared';
import type { RefundRequestDto, RefundStatus } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { SelectField, SubmitButton, TextAreaField, TextField } from '@/components/form-fields';
import { FormDialog, ListState, NoAccess } from '@/components/resource-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useFormatters, useSession } from '../shell/session';
import { newIdempotencyKey, useDecideRefund, usePayRefund, useRefundRequests } from './api';
import { MANUAL_METHODS, needsReference, refundActions, refundTone } from './logic';
import type { ManualMethod } from './logic';

type Pending = { kind: 'approve' | 'reject' | 'pay'; request: RefundRequestDto } | null;

const TONE_CLASS = {
  success: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  warning: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  danger: 'bg-destructive/10 text-destructive',
  muted: 'bg-muted text-muted-foreground',
} as const;

function DecisionForm({
  pending,
  onClose,
}: {
  pending: NonNullable<Pending>;
  onClose: () => void;
}) {
  const t = useTranslations('Payments.refundQueue');
  const tm = useTranslations('Payments.methods');
  const format = useFormatters();
  const decide = useDecideRefund();
  const pay = usePayRefund();
  const [key] = useState(newIdempotencyKey);
  const { kind, request } = pending;
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<ManualMethod>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    try {
      if (kind === 'reject') {
        if (note.trim().length < 3) return setError(t('noteRequired'));
        await decide.mutateAsync({
          action: 'reject',
          id: request.id,
          rev: request.rev,
          note: note.trim(),
        });
        toast.success(t('rejected'));
      } else if (kind === 'approve') {
        await decide.mutateAsync({
          action: 'approve',
          id: request.id,
          rev: request.rev,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        toast.success(t('approved'));
      } else {
        if (needsReference(method) && reference.trim() === '') return setError(t('chequeRequired'));
        await pay.mutateAsync({
          id: request.id,
          key,
          rev: request.rev,
          method,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        });
        toast.success(method === 'CHEQUE' ? t('paidCheque') : t('paid'));
      }
      onClose();
    } catch {
      // toasted globally (a request someone else decided, the two-person rule, ...)
    }
  };

  return (
    <form
      noValidate
      className="grid gap-4"
      data-testid={`refund-${kind}-form`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm">
        <span className="font-medium">{format.money(request.amount)}</span> · {request.customerName}
        {request.bookingNumber ? ` · ${request.bookingNumber}` : ''}
      </p>
      <p className="text-muted-foreground text-sm">{request.reason}</p>
      {kind === 'pay' ? (
        <>
          <SelectField
            label={t('method')}
            value={method}
            onChange={(event) => setMethod(event.target.value as ManualMethod)}
            data-testid="refund-method"
          >
            {MANUAL_METHODS.map((m) => (
              <option key={m} value={m}>
                {tm(m)}
              </option>
            ))}
          </SelectField>
          <TextField
            label={needsReference(method) ? t('chequeNumber') : t('reference')}
            value={reference}
            maxLength={100}
            error={error}
            onChange={(event) => setReference(event.target.value)}
            data-testid="refund-reference"
          />
        </>
      ) : (
        <TextAreaField
          label={kind === 'reject' ? t('noteReject') : t('noteApprove')}
          value={note}
          maxLength={1000}
          error={error}
          onChange={(event) => setNote(event.target.value)}
          data-testid="refund-note"
        />
      )}
      <div className="flex flex-wrap gap-2">
        <SubmitButton
          pending={decide.isPending || pay.isPending}
          variant={kind === 'reject' ? 'destructive' : 'default'}
          className="w-auto flex-1"
          data-testid="refund-decision-submit"
        >
          {t(`submit.${kind}`)}
        </SubmitButton>
        <Button type="button" variant="outline" size="lg" className="h-10" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The refund queue (accountants): approve or reject what staff asked for, then pay it out. */
export function RefundsPage() {
  const t = useTranslations('Payments.refundQueue');
  const { can, user } = useSession();
  const format = useFormatters();
  const [status, setStatus] = useState<RefundStatus | ''>('REQUESTED');
  const [pending, setPending] = useState<Pending>(null);
  const refunds = useRefundRequests({ status }, can('payment.view'));
  if (!can('payment.view')) return <NoAccess text={t('noAccess')} />;
  const rows = refunds.data?.pages.flatMap((p) => p.data) ?? [];
  const me = {
    userId: user.id,
    canApprove: can('payment.refund.approve'),
    canPay: can('payment.record'),
  };

  return (
    <div className="mx-auto grid max-w-4xl gap-4" data-testid="refunds-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <div className="min-w-44">
          <SelectField
            label={t('status')}
            value={status}
            onChange={(event) => setStatus(event.target.value as RefundStatus | '')}
            data-testid="refunds-status"
          >
            <option value="">{t('all')}</option>
            {REFUND_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statuses.${s}`)}
              </option>
            ))}
          </SelectField>
        </div>
      </div>

      <ListState
        pending={refunds.isPending}
        failed={refunds.isError}
        empty={rows.length === 0}
        emptyText={t('empty')}
        loadFailedText={t('loadFailed')}
      >
        <ul className="grid gap-3" data-testid="refund-list">
          {rows.map((r) => {
            const actions = refundActions(r, me);
            return (
              <li key={r.id} data-testid="refund-row" data-status={r.status} data-reason={r.reason}>
                <Card>
                  <CardContent className="grid gap-3 pt-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="grid gap-0.5">
                        <span className="text-base font-semibold tabular-nums">
                          {format.money(r.amount)}
                        </span>
                        <Link href={`/bookings/${r.bookingId}`} className="text-sm underline">
                          {r.bookingNumber ?? t('draft')} · {r.customerName}
                        </Link>
                      </div>
                      <Badge variant="secondary" className={TONE_CLASS[refundTone(r.status)]}>
                        {t(`statuses.${r.status}`)}
                        {r.status === 'APPROVED' && r.paymentStatus === 'PENDING'
                          ? ` · ${t('chequePending')}`
                          : ''}
                      </Badge>
                    </div>
                    <p className="text-sm">{r.reason}</p>
                    <p className="text-muted-foreground text-xs">
                      {t('requestedBy', {
                        name: r.requestedByName,
                        at: format.dateTime(r.createdAt),
                      })}
                      {r.approvedByName
                        ? ` · ${t(r.status === 'REJECTED' ? 'rejectedBy' : 'approvedBy', { name: r.approvedByName })}${r.selfApproved ? ` (${t('selfApproved')})` : ''}`
                        : ''}
                      {r.decisionNote ? ` · ${r.decisionNote}` : ''}
                    </p>
                    {actions.approve || actions.pay ? (
                      <div className="flex flex-wrap gap-2">
                        {actions.approve ? (
                          <Button
                            size="sm"
                            onClick={() => setPending({ kind: 'approve', request: r })}
                            data-testid="refund-approve"
                          >
                            {t('approve')}
                          </Button>
                        ) : null}
                        {actions.reject ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPending({ kind: 'reject', request: r })}
                            data-testid="refund-reject"
                          >
                            {t('reject')}
                          </Button>
                        ) : null}
                        {actions.pay ? (
                          <Button
                            size="sm"
                            onClick={() => setPending({ kind: 'pay', request: r })}
                            data-testid="refund-pay"
                          >
                            {t('pay')}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {actions.ownRequest && r.status === 'REQUESTED' && actions.approve ? (
                      <p className="text-muted-foreground text-xs">{t('ownHint')}</p>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
        {refunds.hasNextPage ? (
          <Button
            variant="outline"
            className="w-fit"
            disabled={refunds.isFetchingNextPage}
            onClick={() => void refunds.fetchNextPage()}
          >
            {t('more')}
          </Button>
        ) : null}
      </ListState>

      <FormDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending ? t(`dialog.${pending.kind}.title`) : ''}
        description={pending ? t(`dialog.${pending.kind}.description`) : ''}
      >
        {pending ? <DecisionForm pending={pending} onClose={() => setPending(null)} /> : null}
      </FormDialog>
    </div>
  );
}
