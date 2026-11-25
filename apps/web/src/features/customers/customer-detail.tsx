'use client';

import { ArrowLeft, Eye, EyeOff, Pencil, Plus, Power, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { CustomerDetailDto, CustomFieldDefDto } from '@venueos/shared';
import { FormDialog, NoAccess } from '@/components/resource-ui';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { NewInquiryDialog } from '../leads/new-inquiry-dialog';
import { useFormatters, useSession } from '../shell/session';
import { useCustomer, useCustomFieldDefs, useRevealCustomerField, useUpdateCustomer } from './api';
import { CustomerForm } from './customer-form';

/** How long a revealed value stays on screen. */
const REVEAL_SECONDS = 30;

function Detail({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="grid gap-0.5" data-testid={testId}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

/** The value of one custom field: plain, or masked with a "reveal" button for people with `customer.view_sensitive`. */
function FieldValue({
  customer,
  def,
  fieldKey,
  value,
}: {
  customer: CustomerDetailDto;
  def: CustomFieldDefDto | undefined;
  fieldKey: string;
  value: string | number;
}) {
  const t = useTranslations('Customers.detail');
  const { can } = useSession();
  const reveal = useRevealCustomerField();
  const [clear, setClear] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const sensitive = customer.sensitiveKeys.includes(fieldKey);
  if (!sensitive) return <span className="ltr-isolate">{String(value)}</span>;

  const show = async () => {
    try {
      const result = await reveal.mutateAsync({ id: customer.id, fieldKey });
      setClear(result.value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setClear(null), REVEAL_SECONDS * 1000);
    } catch {
      // The failure was toasted globally (no permission, the value is gone).
    }
  };
  const hide = () => {
    clearTimeout(timer.current);
    setClear(null);
  };

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="ltr-isolate" data-testid={`field-value-${fieldKey}`}>
        {clear ?? String(value)}
      </span>
      {can('customer.view_sensitive') ? (
        clear === null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={show}
            disabled={reveal.isPending}
            aria-label={t('revealNamed', { name: def?.label ?? fieldKey })}
            data-testid={`reveal-${fieldKey}`}
          >
            <Eye aria-hidden />
            {t('reveal')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={hide}
            aria-label={t('hideNamed', { name: def?.label ?? fieldKey })}
            data-testid={`hide-${fieldKey}`}
          >
            <EyeOff aria-hidden />
            {t('hide')}
          </Button>
        )
      ) : null}
    </span>
  );
}

/** One customer: profile, custom fields (masked ones with "reveal"), possible duplicates and their leads. */
export function CustomerDetail({ id }: { id: string }) {
  const t = useTranslations('Customers');
  const { can } = useSession();
  const format = useFormatters();
  const customer = useCustomer(id);
  const defs = useCustomFieldDefs('customer', can('catalogue.view'));
  const update = useUpdateCustomer();
  const [editing, setEditing] = useState(false);
  const [inquiry, setInquiry] = useState(false);

  if (!can('customer.view')) return <NoAccess text={t('noAccess')} />;

  const data = customer.data;
  const defByKey = new Map((defs.data?.data ?? []).map((d) => [d.key, d]));

  const toggleActive = async () => {
    if (!data) return;
    try {
      await update.mutateAsync({ id: data.id, rev: data.rev, active: !data.active });
      toast.success(t('form.saved'));
    } catch {
      // Toasted globally.
    }
  };

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <Link
        href="/customers"
        className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
        {t('detail.back')}
      </Link>

      {customer.isPending ? (
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : customer.isError || !data ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('detail.loadFailed')}</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1">
              <h1 className="text-2xl font-semibold" data-testid="customer-name">
                {data.name}
              </h1>
              {!data.active ? (
                <Badge variant="secondary" className="w-fit">
                  {t('inactive')}
                </Badge>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {can('lead.manage') && data.active ? (
                <Button
                  size="lg"
                  className="h-10"
                  onClick={() => setInquiry(true)}
                  data-testid="customer-new-inquiry"
                >
                  <Plus aria-hidden />
                  {t('detail.newInquiry')}
                </Button>
              ) : null}
              {can('customer.manage') ? (
                <>
                  <Button
                    variant="outline"
                    size="lg"
                    className="h-10"
                    onClick={() => setEditing(true)}
                    data-testid="customer-edit"
                  >
                    <Pencil aria-hidden />
                    {t('detail.edit')}
                  </Button>
                  <Button
                    variant="outline"
                    size="lg"
                    className="h-10"
                    onClick={toggleActive}
                    disabled={update.isPending}
                    data-testid="customer-toggle"
                  >
                    <Power aria-hidden />
                    {data.active ? t('detail.deactivate') : t('detail.reactivate')}
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          {data.duplicates.length > 0 ? (
            <Alert role="status" data-testid="customer-duplicates">
              <TriangleAlert aria-hidden />
              <AlertTitle>{t('duplicates.title', { count: data.duplicates.length })}</AlertTitle>
              <AlertDescription>
                <ul className="grid gap-1">
                  {data.duplicates.map((d) => (
                    <li key={d.id}>
                      <Link href={`/customers/${d.id}`} className="font-medium underline">
                        {d.name}
                      </Link>{' '}
                      <span className="ltr-isolate text-xs">{d.phone}</span>{' '}
                      <span className="text-xs">
                        {d.matchedOn.map((m) => t(`duplicates.matched.${m}`)).join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t('detail.profile')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Detail label={t('fields.phone')} testId="customer-phone">
                  <span className="ltr-isolate">{data.phone}</span>
                </Detail>
                <Detail label={t('fields.altPhone')}>
                  {data.altPhone ? <span className="ltr-isolate">{data.altPhone}</span> : '—'}
                </Detail>
                <Detail label={t('fields.email')}>
                  {data.email ? <span className="ltr-isolate">{data.email}</span> : '—'}
                </Detail>
                <Detail label={t('fields.preferredLocale')}>
                  {data.preferredLocale === 'en'
                    ? t('fields.localeEnglish')
                    : t('fields.localeDefault')}
                </Detail>
                <Detail label={t('fields.address')}>{data.address ?? '—'}</Detail>
                <Detail label={t('fields.notes')}>{data.notes ?? '—'}</Detail>
              </dl>
            </CardContent>
          </Card>

          {Object.keys(data.customFields).length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('fields.custom')}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-2" data-testid="customer-custom-fields">
                  {Object.entries(data.customFields).map(([key, value]) =>
                    value === null ? null : (
                      <Detail key={key} label={defByKey.get(key)?.label ?? key}>
                        <FieldValue
                          customer={data}
                          def={defByKey.get(key)}
                          fieldKey={key}
                          value={value}
                        />
                      </Detail>
                    ),
                  )}
                </dl>
              </CardContent>
            </Card>
          ) : null}

          {can('lead.view') ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('detail.leads')}</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.leads.length === 0 ? (
                  <p className="text-muted-foreground px-4 pb-4 text-sm">{t('detail.noLeads')}</p>
                ) : (
                  <ul className="divide-y" data-testid="customer-leads">
                    {data.leads.map((lead) => (
                      <li key={lead.id}>
                        <Link
                          href={`/leads/${lead.id}`}
                          className="hover:bg-muted/50 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
                        >
                          <Badge variant="outline">{t(`stages.${lead.stage}`)}</Badge>
                          <span className="font-medium">
                            {lead.eventTypeName ?? t('detail.inquiry')}
                          </span>
                          <span className="text-muted-foreground">{lead.venueName}</span>
                          {lead.preferredDate ? (
                            <span className="text-muted-foreground">{lead.preferredDate}</span>
                          ) : null}
                          <span className="text-muted-foreground ms-auto text-xs">
                            {format.date(lead.createdAt)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : null}
          <p className="text-muted-foreground text-xs">{t('detail.bookingsLater')}</p>

          <FormDialog
            open={editing}
            onClose={() => setEditing(false)}
            title={t('editTitle')}
            description={t('formDescription')}
          >
            {editing ? (
              <CustomerForm
                key={`${data.id}:${data.rev}`}
                customer={data}
                onDone={() => setEditing(false)}
              />
            ) : null}
          </FormDialog>
          <NewInquiryDialog
            open={inquiry}
            onClose={() => setInquiry(false)}
            customer={{ id: data.id, name: data.name, phone: data.phone }}
          />
        </>
      )}
    </div>
  );
}
