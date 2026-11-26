'use client';

import type { PaymentDto, PaymentsOverviewDto } from '@venueos/shared';
import { Download, Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useFormatters, useSession } from '../shell/session';
import { fetchReceiptLink, useClearCheque, usePaymentsOverview, useResendReceipt } from './api';
import {
  ReasonDialog,
  RecordPaymentDialog,
  RefundRequestDialog,
  ScheduleDialog,
} from './payment-dialogs';
import {
  canBounce,
  canClear,
  canReverse,
  effectOf,
  paymentTone,
  refundTone,
  scheduleTone,
} from './logic';
import type { Tone } from './logic';

const TONE: Record<Tone, string> = {
  success: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  warning: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  danger: 'bg-destructive/10 text-destructive',
  muted: 'bg-muted text-muted-foreground',
};

function ToneBadge({
  tone,
  children,
  testId,
}: {
  tone: Tone;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Badge variant="secondary" className={TONE[tone]} data-testid={testId}>
      {children}
    </Badge>
  );
}

function Stat({
  label,
  value,
  testId,
  strong,
}: {
  label: string;
  value: string;
  testId: string;
  strong?: boolean;
}) {
  return (
    <div className="grid gap-0.5" data-testid={testId}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn('ltr-isolate text-sm tabular-nums', strong && 'text-base font-semibold')}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The Payments tab of a booking: what the customer owes and has paid, the schedule with its FIFO status, every entry with
 * its receipt, cheque clearing, reversal, and refund requests. Nothing here works out money: the API sends every figure.
 */
export function PaymentsPanel({
  bookingId,
  onConfirm,
}: {
  bookingId: string;
  /** Opens the confirm dialog of the booking page (a cleared advance only says "ready"; confirming is a click). */
  onConfirm: () => void;
}) {
  const t = useTranslations('Payments');
  const { can } = useSession();
  const format = useFormatters();
  const overview = usePaymentsOverview(bookingId, can('payment.view'));
  const clear = useClearCheque();
  const resend = useResendReceipt();
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [reversing, setReversing] = useState<PaymentDto | null>(null);
  const [bouncing, setBouncing] = useState<PaymentDto | null>(null);

  if (overview.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (overview.isError || !overview.data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{t('loadFailed')}</AlertDescription>
      </Alert>
    );
  }
  const o: PaymentsOverviewDto = overview.data;
  const s = o.summary;
  const money = (v: string) => format.money(v);
  const open = ['TENTATIVE', 'CONFIRMED', 'COMPLETED'].includes(o.bookingStatus);
  const mayRecord = can('payment.record') && open;
  const mayEditSchedule =
    can('payment.record') && (o.bookingStatus === 'TENTATIVE' || o.bookingStatus === 'CONFIRMED');
  const mayRequestRefund =
    can('payment.refund.request') && o.bookingStatus !== 'DRAFT' && Number(s.refundable) > 0;
  const byId = new Map(o.payments.map((p) => [p.id, p]));
  const nextOpen = o.schedule.find((i) => i.status !== 'PAID');

  const openReceipt = async (id: string) => {
    try {
      const { url } = await fetchReceiptLink(id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      toast.error(t('receipt.failed'));
    }
  };

  return (
    <div className="grid gap-6" data-testid="payments-panel">
      {s.readyToConfirm && can('booking.confirm') ? (
        <Alert role="status" data-testid="ready-to-confirm">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('ready.text')}</span>
            <Button size="sm" onClick={onConfirm} data-testid="ready-confirm">
              {t('ready.action')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {o.bookingStatus === 'CONFIRMED' && !s.advanceMet ? (
        <Alert variant="destructive" role="status" data-testid="advance-lost">
          <AlertDescription>
            {t('advanceLost', { required: money(s.advanceRequired) })}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="pt-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label={t('summary.total')} value={money(s.grandTotal)} testId="summary-total" />
            <Stat
              label={t('summary.paid')}
              value={money(s.paidTotal)}
              testId="summary-paid"
              strong
            />
            <Stat
              label={t('summary.balance')}
              value={money(s.balanceDue)}
              testId="summary-balance"
            />
            <Stat
              label={t('summary.advance', { pct: s.advancePct })}
              value={`${money(s.advanceRequired)} · ${s.advanceMet ? t('summary.advanceIn') : t('summary.advanceOut')}`}
              testId="summary-advance"
            />
            {Number(s.pendingCheques) > 0 ? (
              <Stat
                label={t('summary.pending')}
                value={money(s.pendingCheques)}
                testId="summary-pending"
              />
            ) : null}
            {Number(s.credit) > 0 ? (
              <Stat label={t('summary.credit')} value={money(s.credit)} testId="summary-credit" />
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('schedule.title')}</CardTitle>
          {mayEditSchedule && o.schedule.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
              data-testid="schedule-edit"
            >
              {t('schedule.edit')}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {o.schedule.length === 0 ? (
            <p className="text-muted-foreground px-4 pb-4 text-sm">{t('schedule.empty')}</p>
          ) : (
            <ul className="divide-y" data-testid="payment-schedule">
              {o.schedule.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                  data-testid="schedule-row"
                  data-label={item.label}
                  data-status={item.status}
                >
                  <div className="grid gap-0.5">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-muted-foreground text-xs">
                      {t('schedule.due', { date: format.dateOnly(item.dueDate) })}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="ltr-isolate tabular-nums">{money(item.amount)}</span>
                    <ToneBadge tone={scheduleTone(item.status)}>
                      {t(`schedule.status.${item.status}`)}
                    </ToneBadge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('entries.title')}</CardTitle>
          <div className="flex flex-wrap gap-2">
            {mayRecord ? (
              <Button size="sm" onClick={() => setRecording(true)} data-testid="record-payment">
                {t('entries.record')}
              </Button>
            ) : null}
            {mayRequestRefund ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRefunding(true)}
                data-testid="request-refund"
              >
                {t('entries.requestRefund')}
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {o.payments.length === 0 ? (
            <p className="text-muted-foreground px-4 pb-4 text-sm">{t('entries.empty')}</p>
          ) : (
            <ul className="divide-y" data-testid="payment-list">
              {o.payments.map((p) => (
                <li
                  key={p.id}
                  className="grid gap-2 px-4 py-3 text-sm"
                  data-testid="payment-row"
                  data-type={p.entryType}
                  data-status={p.status}
                  data-method={p.method}
                  data-receipt={p.receiptNo ?? ''}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="grid gap-0.5">
                      <span className="font-medium">
                        {p.entryType === 'RECEIPT'
                          ? (p.receiptNo ?? t('entries.receipt'))
                          : t(`entries.type.${p.entryType}`)}{' '}
                        <span className="text-muted-foreground font-normal">
                          · {t(`methods.${p.method}`)}
                        </span>
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {format.dateTime(p.receivedAt)}
                        {p.reference ? ` · ${p.reference}` : ''}
                        {p.receivedByName ? ` · ${p.receivedByName}` : ''}
                      </span>
                      {p.notes ? <span className="text-xs">{p.notes}</span> : null}
                      {p.reversedById ? (
                        <span className="text-destructive text-xs">{t('entries.reversed')}</span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="ltr-isolate font-medium tabular-nums">
                        {effectOf(p, byId) === '+' ? '+' : '−'}
                        {money(p.amount)}
                      </span>
                      <ToneBadge tone={paymentTone(p.status)} testId="payment-status">
                        {t(`entries.status.${p.status}`)}
                      </ToneBadge>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {p.entryType === 'RECEIPT' && p.receiptNo ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!p.receiptReady}
                        onClick={() => void openReceipt(p.id)}
                        data-testid="payment-receipt"
                      >
                        <Download aria-hidden />
                        {p.receiptReady ? t('receipt.download') : t('receipt.preparing')}
                      </Button>
                    ) : null}
                    {can('payment.record') &&
                    p.entryType === 'RECEIPT' &&
                    p.status === 'CLEARED' &&
                    p.receiptReady ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={resend.isPending}
                        onClick={() =>
                          resend.mutate(
                            { id: p.id },
                            { onSuccess: (r) => toast.success(t('receipt.sent', { to: r.to })) },
                          )
                        }
                        data-testid="payment-resend"
                      >
                        <Mail aria-hidden />
                        {t('receipt.resend')}
                      </Button>
                    ) : null}
                    {can('payment.record') && canClear(p) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={clear.isPending}
                        onClick={() =>
                          clear.mutate(p.id, {
                            onSuccess: () => toast.success(t('cheque.cleared')),
                          })
                        }
                        data-testid="payment-clear"
                      >
                        {t('cheque.clear')}
                      </Button>
                    ) : null}
                    {can('payment.record') && canBounce(p) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setBouncing(p)}
                        data-testid="payment-bounce"
                      >
                        {t('cheque.bounce')}
                      </Button>
                    ) : null}
                    {can('payment.reverse') && canReverse(p) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setReversing(p)}
                        data-testid="payment-reverse"
                      >
                        {t('reverse.action')}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {o.refundRequests.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('refunds.title')}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y" data-testid="booking-refunds">
              {o.refundRequests.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                  data-testid="booking-refund"
                  data-status={r.status}
                >
                  <div className="grid gap-0.5">
                    <span className="font-medium">{r.reason}</span>
                    <span className="text-muted-foreground text-xs">
                      {r.requestedByName} · {format.dateTime(r.createdAt)}
                      {r.approvedByName
                        ? ` · ${t('refunds.decidedBy', { name: r.approvedByName })}`
                        : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="ltr-isolate tabular-nums">{money(r.amount)}</span>
                    <ToneBadge tone={refundTone(r.status)}>
                      {t(`refunds.status.${r.status}`)}
                    </ToneBadge>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <RecordPaymentDialog
        open={recording}
        bookingId={bookingId}
        currency={o.currency}
        defaultAmount={nextOpen ? nextOpen.remaining : ''}
        onClose={() => setRecording(false)}
      />
      <ScheduleDialog open={editing} overview={o} onClose={() => setEditing(false)} />
      <RefundRequestDialog
        open={refunding}
        bookingId={bookingId}
        currency={o.currency}
        suggested={s.suggestedRefund}
        refundable={s.refundable}
        onClose={() => setRefunding(false)}
      />
      <ReasonDialog kind="reverse" payment={reversing} onClose={() => setReversing(null)} />
      <ReasonDialog kind="bounce" payment={bouncing} onClose={() => setBouncing(null)} />
    </div>
  );
}
