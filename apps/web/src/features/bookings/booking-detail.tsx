'use client';

import type { BookingDetailDto, QuotationVersionDto } from '@venueos/shared';
import { ArrowLeft, Download, MessageCircle, Pencil, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { CheckboxField, SubmitButton, TextAreaField, TextField } from '@/components/form-fields';
import { FormDialog, NoAccess } from '@/components/resource-ui';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormatters, useSession } from '../shell/session';
import {
  fetchQuotationPdf,
  fetchQuotationWhatsApp,
  useBooking,
  useBookingAction,
  useCancelSession,
  useSendQuotation,
} from './api';
import { offeredActions, subtract } from './logic';
import { HoldCountdown, StatusBadge } from './parts';
import { QuoteLines, QuoteWarnings } from './quote-view';

type Dialog = 'hold' | 'confirm' | 'cancel' | { cancelSession: string } | null;

function Detail({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="grid gap-0.5" data-testid={testId}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

/** One question with an optional reason: hold (override venue rules), confirm (without the advance), cancel (reason required). */
function ReasonDialog({
  kind,
  booking,
  onClose,
}: {
  kind: 'hold' | 'confirm' | 'cancel';
  booking: BookingDetailDto;
  onClose: () => void;
}) {
  const t = useTranslations('Bookings.dialog');
  const { can } = useSession();
  const action = useBookingAction();
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  const mayOverride =
    kind === 'hold'
      ? can('booking.override_rules')
      : kind === 'confirm'
        ? can('booking.confirm_override')
        : false;
  const reasonNeeded = kind === 'cancel' || override;

  const submit = async () => {
    if (reasonNeeded && reason.trim().length < 3) return setError(t('reasonRequired'));
    setError(undefined);
    const text = reason.trim();
    try {
      if (kind === 'hold') {
        await action.mutateAsync({
          action: 'hold',
          id: booking.id,
          body: {
            rev: booking.rev,
            overrideRules: override,
            ...(override ? { reason: text } : {}),
          },
        });
        toast.success(t('held'));
      } else if (kind === 'confirm') {
        await action.mutateAsync({
          action: 'confirm',
          id: booking.id,
          body: { rev: booking.rev, override, ...(override ? { reason: text } : {}) },
        });
        toast.success(t('confirmed'));
      } else {
        await action.mutateAsync({
          action: 'cancel',
          id: booking.id,
          body: { rev: booking.rev, reason: text },
        });
        toast.success(t('cancelled'));
      }
      onClose();
    } catch {
      // toasted globally with the booking wording
    }
  };

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t(`${kind}.title`)}
      description={t(`${kind}.description`)}
    >
      <form
        noValidate
        className="grid gap-4"
        data-testid={`dialog-${kind}`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mayOverride ? (
          <CheckboxField
            label={t(`${kind}.override`)}
            checked={override}
            onChange={(event) => setOverride(event.target.checked)}
            data-testid="dialog-override"
          />
        ) : null}
        {reasonNeeded ? (
          <TextAreaField
            label={t('reason')}
            value={reason}
            maxLength={500}
            error={error}
            onChange={(event) => setReason(event.target.value)}
            data-testid="dialog-reason"
          />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <SubmitButton
            pending={action.isPending}
            className="w-auto flex-1"
            variant={kind === 'cancel' ? 'destructive' : 'default'}
            data-testid="dialog-submit"
          >
            {t(`${kind}.submit`)}
          </SubmitButton>
          <Button type="button" variant="outline" size="lg" className="h-10" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}

function CancelSessionDialog({
  booking,
  sessionId,
  onClose,
}: {
  booking: BookingDetailDto;
  sessionId: string;
  onClose: () => void;
}) {
  const t = useTranslations('Bookings.dialog');
  const cancel = useCancelSession();
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('cancelSession.title')}
      description={t('cancelSession.description')}
    >
      <form
        className="grid gap-4"
        data-testid="dialog-cancel-session"
        onSubmit={(event) => {
          event.preventDefault();
          cancel.mutate(
            {
              id: booking.id,
              sessionId,
              rev: booking.rev,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <TextAreaField
          label={t('reasonOptional')}
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
        <SubmitButton pending={cancel.isPending} variant="destructive" data-testid="dialog-submit">
          {t('cancelSession.submit')}
        </SubmitButton>
      </form>
    </FormDialog>
  );
}

function SendDialog({
  quotation,
  defaultTo,
  onClose,
}: {
  quotation: QuotationVersionDto;
  defaultTo: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('Bookings.send');
  const send = useSendQuotation();
  const [to, setTo] = useState(defaultTo ?? '');
  const [message, setMessage] = useState('');
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('title', { number: quotation.number, version: quotation.version })}
      description={t('description')}
    >
      <form
        noValidate
        className="grid gap-4"
        data-testid="dialog-send"
        onSubmit={(event) => {
          event.preventDefault();
          send.mutate(
            {
              id: quotation.id,
              ...(to.trim() ? { to: to.trim() } : {}),
              ...(message.trim() ? { message: message.trim() } : {}),
            },
            {
              onSuccess: (done) => {
                toast.success(t('sent', { to: done.to }));
                onClose();
              },
            },
          );
        }}
      >
        <TextField
          label={t('to')}
          type="email"
          value={to}
          hint={t('toHint')}
          onChange={(event) => setTo(event.target.value)}
          data-testid="send-to"
        />
        <TextAreaField
          label={t('message')}
          value={message}
          maxLength={1000}
          onChange={(event) => setMessage(event.target.value)}
        />
        <SubmitButton pending={send.isPending} data-testid="send-submit">
          {t('submit')}
        </SubmitButton>
      </form>
    </FormDialog>
  );
}

/** The quotation versions: send by email (with the PDF), a WhatsApp link, the PDF. */
function Quotations({ booking }: { booking: BookingDetailDto }) {
  const t = useTranslations('Bookings.quotations');
  const { can } = useSession();
  const format = useFormatters();
  const [sending, setSending] = useState<QuotationVersionDto | null>(null);
  const mayView = can('booking.view_prices') && can('quotation.manage');
  const maySend = can('quotation.send') && mayView;
  if (!mayView) return null;

  const open = async (kind: 'pdf' | 'whatsapp', id: string) => {
    try {
      const { url } =
        kind === 'pdf' ? await fetchQuotationPdf(id) : await fetchQuotationWhatsApp(id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      toast.error(t(kind === 'pdf' ? 'pdfFailed' : 'whatsappFailed'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y" data-testid="quotation-versions">
          {booking.quotations.map((q, i) => (
            <li
              key={q.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
              data-testid="quotation-version"
              data-version={q.version}
            >
              <div className="grid gap-0.5">
                <span className="font-medium">
                  {q.number} · {t('version', { n: q.version })}
                  {i === 0 ? ` · ${t('latest')}` : ''}
                </span>
                <span className="text-muted-foreground text-xs">
                  {q.grandTotal !== null ? `${format.money(q.grandTotal)} · ` : ''}
                  {q.validUntil ? `${t('validUntil')} ${format.dateOnly(q.validUntil)} · ` : ''}
                  {q.sentAt ? t('sentAt', { at: format.dateTime(q.sentAt) }) : t('notSent')}
                  {q.acceptedAt ? ` · ${t('accepted')}` : ''}
                  {!q.pdfReady ? ` · ${t('pdfPending')}` : ''}
                </span>
              </div>
              {maySend ? (
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!q.pdfReady}
                    onClick={() => void open('pdf', q.id)}
                    data-testid="quotation-pdf"
                  >
                    <Download aria-hidden />
                    {t('pdf')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void open('whatsapp', q.id)}
                    data-testid="quotation-whatsapp"
                  >
                    <MessageCircle aria-hidden />
                    {t('whatsapp')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!q.pdfReady}
                    onClick={() => setSending(q)}
                    data-testid="quotation-send"
                  >
                    <Send aria-hidden />
                    {t('send')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
      {sending ? (
        <SendDialog quotation={sending} defaultTo={null} onClose={() => setSending(null)} />
      ) : null}
    </Card>
  );
}

function Timeline({ booking }: { booking: BookingDetailDto }) {
  const t = useTranslations('Bookings.timeline');
  const format = useFormatters();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ol className="divide-y" data-testid="booking-timeline">
          {booking.timeline.map((entry) => (
            <li
              key={entry.id}
              className="grid gap-0.5 px-4 py-3 text-sm"
              data-action={entry.action}
              data-testid="timeline-entry"
            >
              <span className="font-medium">
                {t.has(`actions.${entry.action.replaceAll('.', '_')}`)
                  ? t(`actions.${entry.action.replaceAll('.', '_')}`)
                  : entry.action}
              </span>
              <span className="text-muted-foreground text-xs">
                {entry.actorName ?? t('system')} · {format.dateTime(entry.at)}
              </span>
              {entry.reason ? (
                <span className="text-xs">
                  {t('reason')}: {entry.reason}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/** One booking: status and hold timer, the actions, sessions, the priced lines, the quotation versions and the timeline. */
export function BookingDetail({ id }: { id: string }) {
  const t = useTranslations('Bookings.detail');
  const { can } = useSession();
  const format = useFormatters();
  const booking = useBooking(id);
  const action = useBookingAction();
  const [dialog, setDialog] = useState<Dialog>(null);

  if (!can('booking.view')) return <NoAccess text={t('noAccess')} />;
  const data = booking.data;
  const actions = data ? offeredActions(data.status) : [];
  const allowed = (name: (typeof actions)[number]): boolean => {
    if (!actions.includes(name)) return false;
    switch (name) {
      case 'hold':
      case 'extend-hold':
      case 'rehold':
        return can('booking.hold');
      case 'confirm':
        return can('booking.confirm');
      case 'cancel':
      case 'restore':
        return can('booking.cancel');
    }
  };
  const simple = async (name: 'extend-hold' | 'rehold' | 'restore') => {
    if (!data) return;
    try {
      await action.mutateAsync({ action: name, id: data.id, body: { rev: data.rev } });
      toast.success(t(`done.${name}`));
    } catch {
      // toasted globally
    }
  };

  return (
    <div className="mx-auto grid max-w-4xl gap-6" data-testid="booking-detail">
      <Link
        href="/bookings"
        className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
        {t('back')}
      </Link>
      {booking.isPending ? (
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : booking.isError || !data ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-2">
              <h1 className="text-2xl font-semibold" data-testid="booking-title">
                {data.number ?? t('draftTitle')}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge status={data.status} />
                {data.status === 'TENTATIVE' && data.holdExpiresAt ? (
                  <span data-testid="hold-info">
                    {t('holdEnds')}: <HoldCountdown holdExpiresAt={data.holdExpiresAt} /> (
                    {format.dateTime(data.holdExpiresAt)})
                  </span>
                ) : null}
                <Link href={`/customers/${data.customer.id}`} className="underline">
                  {data.customer.name}
                </Link>
                {data.leadId && can('lead.view') ? (
                  <Link href={`/leads/${data.leadId}`} className="underline">
                    {t('lead')}
                  </Link>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2" data-testid="booking-actions">
              {data.status === 'DRAFT' && can('booking.edit') && can('quotation.manage') ? (
                <Button asChild variant="outline" size="lg" className="h-10">
                  <Link href={`/quotations/new?bookingId=${data.id}`} data-testid="booking-edit">
                    <Pencil aria-hidden />
                    {t('edit')}
                  </Link>
                </Button>
              ) : null}
              {allowed('hold') ? (
                <Button
                  size="lg"
                  className="h-10"
                  onClick={() => setDialog('hold')}
                  data-testid="action-hold"
                >
                  {t('actions.hold')}
                </Button>
              ) : null}
              {allowed('extend-hold') ? (
                <Button
                  variant="outline"
                  size="lg"
                  className="h-10"
                  disabled={action.isPending}
                  onClick={() => void simple('extend-hold')}
                  data-testid="action-extend"
                >
                  {t('actions.extend')}
                </Button>
              ) : null}
              {allowed('rehold') ? (
                <Button
                  size="lg"
                  className="h-10"
                  disabled={action.isPending}
                  onClick={() => void simple('rehold')}
                  data-testid="action-rehold"
                >
                  {t('actions.rehold')}
                </Button>
              ) : null}
              {allowed('confirm') ? (
                <Button
                  size="lg"
                  className="h-10"
                  onClick={() => setDialog('confirm')}
                  data-testid="action-confirm"
                >
                  {t('actions.confirm')}
                </Button>
              ) : null}
              {allowed('restore') ? (
                <Button
                  size="lg"
                  className="h-10"
                  disabled={action.isPending}
                  onClick={() => void simple('restore')}
                  data-testid="action-restore"
                >
                  {t('actions.restore')}
                </Button>
              ) : null}
              {allowed('cancel') ? (
                <Button
                  variant="destructive"
                  size="lg"
                  className="h-10"
                  onClick={() => setDialog('cancel')}
                  data-testid="action-cancel"
                >
                  {t('actions.cancel')}
                </Button>
              ) : null}
            </div>
          </div>

          {data.status === 'CANCELLED' ? (
            <Alert role="status" data-testid="booking-cancelled">
              <AlertDescription>
                {t('cancelledBecause')}: {data.cancelReason ?? '—'}
                {data.suggestedRefund !== null
                  ? ` · ${t('suggestedRefund')}: ${format.money(data.suggestedRefund)}`
                  : ''}
              </AlertDescription>
            </Alert>
          ) : null}
          <QuoteWarnings warnings={data.warnings} sessions={data.sessions} />

          <Card>
            <CardHeader>
              <CardTitle>{t('sessions')}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y" data-testid="booking-sessions">
                {data.sessions.map((session) => (
                  <li
                    key={session.id ?? session.index}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                    data-testid="booking-session"
                    data-status={session.status}
                  >
                    <div className="grid gap-0.5">
                      <span className="font-medium">
                        {session.eventTypeName ?? t('session', { n: session.index + 1 })} ·{' '}
                        {session.spaceName} · {session.slotName}
                        {session.status === 'CANCELLED' ? ` (${t('sessionCancelled')})` : ''}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {format.dateTime(session.startsAt)} – {format.time(session.endsAt)} ·{' '}
                        {t('guests', { n: session.guests })}
                        {session.billedGuests !== session.guests
                          ? ` (${t('billed', { n: session.billedGuests })})`
                          : ''}
                        {session.packageName ? ` · ${session.packageName}` : ''}
                      </span>
                    </div>
                    {session.status === 'ACTIVE' &&
                    session.id &&
                    can('booking.edit') &&
                    (data.status === 'TENTATIVE' || data.status === 'CONFIRMED') &&
                    data.sessions.filter((s) => s.status === 'ACTIVE').length > 1 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDialog({ cancelSession: session.id as string })}
                        data-testid="session-cancel"
                      >
                        {t('cancelSession')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('pricing')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <QuoteLines sessions={data.sessions} lines={data.lines} totals={data.totals} />
              {data.paidTotal !== null ? (
                <dl className="grid gap-2 sm:grid-cols-2">
                  <Detail label={t('paid')}>{format.money(data.paidTotal)}</Detail>
                  {data.grandTotal !== null ? (
                    <Detail label={t('balance')} testId="booking-balance">
                      {format.money(
                        // The balance is shown from the two strings the API gave: exact, no number arithmetic on money.
                        subtract(data.grandTotal, data.paidTotal),
                      )}
                    </Detail>
                  ) : null}
                </dl>
              ) : null}
              {data.discount ? (
                <p className="text-muted-foreground text-xs">
                  {t('discountApplied', {
                    value:
                      data.discount.type === 'PERCENT'
                        ? `${data.discount.value}%`
                        : format.money(data.discount.value),
                  })}
                </p>
              ) : null}
            </CardContent>
          </Card>

          {data.cancellationPolicy ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('policy')}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p className="font-medium">{data.cancellationPolicy.name}</p>
                <ul className="text-muted-foreground text-xs">
                  {data.cancellationPolicy.tiers.map((tier) => (
                    <li key={tier.minDaysBefore}>
                      {t('tier', { days: tier.minDaysBefore, pct: tier.refundPct })}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {data.notes ? (
            <Card>
              <CardContent className="pt-4 text-sm">{data.notes}</CardContent>
            </Card>
          ) : null}
          <Quotations booking={data} />
          <Timeline booking={data} />

          {dialog === 'hold' || dialog === 'confirm' || dialog === 'cancel' ? (
            <ReasonDialog kind={dialog} booking={data} onClose={() => setDialog(null)} />
          ) : dialog ? (
            <CancelSessionDialog
              booking={data}
              sessionId={dialog.cancelSession}
              onClose={() => setDialog(null)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
