'use client';

import { ArrowLeft, Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import type { LeadActivityDto, LeadDto } from '@venueos/shared';
import { FormDialog, NoAccess } from '@/components/resource-ui';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCustomFieldDefs } from '../customers/api';
import { useFormatters, useSession } from '../shell/session';
import { useLead, useLeadActivity } from './api';
import { FollowUpBadge } from './lead-card';
import { LeadForm } from './lead-form';
import { reachableStages } from './logic';
import { useStageMove } from './stage-move';

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

/** One entry of the activity log: who did what, with the values that changed. */
function ActivityEntry({
  entry,
  fieldLabels,
}: {
  entry: LeadActivityDto;
  fieldLabels: Map<string, string>;
}) {
  const t = useTranslations('Leads');
  const format = useFormatters();
  const value = (field: string, text: string | null): string => {
    if (text === null) return t('activity.none');
    if (field === 'stage') return t(`stages.${text as LeadDto['stage']}`);
    if (field === 'source') return t(`sources.${text as LeadDto['source']}`);
    if (field === 'nextFollowUpAt') return format.dateTime(text);
    if (field === 'flexibleDates') return text === 'true' ? t('activity.yes') : t('activity.no');
    return text;
  };
  const label = (field: string): string => {
    if (field.startsWith('customFields.')) {
      const key = field.slice('customFields.'.length);
      return fieldLabels.get(key) ?? key;
    }
    return t.has(`activity.fields.${field}`) ? t(`activity.fields.${field}`) : field;
  };
  return (
    <li
      className="grid gap-1 px-4 py-3 text-sm"
      data-testid="activity-entry"
      data-action={entry.action}
    >
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="font-medium">
          {t(`activity.actions.${entry.action.replace('.', '_')}`)}
        </span>
        <span className="text-muted-foreground text-xs">
          {entry.actorName ?? t('activity.system')} · {format.dateTime(entry.createdAt)}
        </span>
      </div>
      {entry.changes.length > 0 ? (
        <ul className="text-muted-foreground grid gap-0.5 text-xs">
          {entry.changes.map((change) => (
            <li key={change.field}>
              <span className="font-medium">{label(change.field)}</span>
              {entry.action === 'lead.create'
                ? `: ${value(change.field, change.to)}`
                : `: ${value(change.field, change.from)} → ${value(change.field, change.to)}`}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** One lead: details, the stage actions, and the activity log (stage changes, notes, assignment). */
export function LeadDetail({ id }: { id: string }) {
  const t = useTranslations('Leads');
  const { can } = useSession();
  const format = useFormatters();
  const lead = useLead(id);
  const activity = useLeadActivity(id);
  const defs = useCustomFieldDefs('lead', can('catalogue.view'));
  const stageMove = useStageMove();
  const [editing, setEditing] = useState(false);

  if (!can('lead.view')) return <NoAccess text={t('noAccess')} />;
  const data = lead.data;
  const labels = new Map((defs.data?.data ?? []).map((d) => [d.key, d.label]));
  const mayManage = can('lead.manage');

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <Link
        href="/leads"
        className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
        {t('detail.back')}
      </Link>
      {lead.isPending ? (
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : lead.isError || !data ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('detail.loadFailed')}</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-2">
              <h1 className="text-2xl font-semibold" data-testid="lead-title">
                {data.customer.name}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <Badge data-testid="lead-stage">{t(`stages.${data.stage}`)}</Badge>
                <FollowUpBadge lead={data} />
                <Link href={`/customers/${data.customer.id}`} className="text-sm underline">
                  {t('detail.customer')}
                </Link>
              </div>
            </div>
            {mayManage ? (
              <Button
                variant="outline"
                size="lg"
                className="h-10"
                onClick={() => setEditing(true)}
                data-testid="lead-edit"
              >
                <Pencil aria-hidden />
                {t('detail.edit')}
              </Button>
            ) : null}
          </div>

          {mayManage && reachableStages(data.stage).length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('detail.moveTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2">
                <div className="flex flex-wrap gap-2" data-testid="lead-stage-actions">
                  {reachableStages(data.stage).map((stage) => (
                    <Button
                      key={stage}
                      variant={stage === 'LOST' ? 'destructive' : 'outline'}
                      size="sm"
                      disabled={stageMove.busy}
                      onClick={() => void stageMove.move(data, stage)}
                      data-testid={`stage-${stage}`}
                    >
                      {t(`stages.${stage}`)}
                    </Button>
                  ))}
                </div>
                <p className="text-muted-foreground text-xs">{t('detail.moveHint')}</p>
              </CardContent>
            </Card>
          ) : null}

          {data.stage === 'LOST' && data.lostReason ? (
            <Alert role="status" data-testid="lead-lost-reason">
              <AlertDescription>
                {t('detail.lostBecause')}: {data.lostReason}
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardContent>
              <dl className="grid gap-4 pt-4 sm:grid-cols-2">
                <Detail label={t('form.venue')}>{data.venueName}</Detail>
                <Detail label={t('form.eventType')}>{data.eventTypeName ?? '—'}</Detail>
                <Detail label={t('form.preferredDate')}>
                  {data.preferredDate ?? '—'}
                  {data.flexibleDates ? ` (${t('detail.flexible')})` : ''}
                </Detail>
                <Detail label={t('form.guests')}>{data.guests ?? '—'}</Detail>
                <Detail label={t('detail.budgetLabel')}>
                  {data.budget ? format.money(data.budget) : '—'}
                </Detail>
                <Detail label={t('form.source')}>{t(`sources.${data.source}`)}</Detail>
                <Detail label={t('form.assignee')} testId="lead-assignee-value">
                  {data.assignee?.name ?? t('unassigned')}
                </Detail>
                <Detail label={t('detail.followUp')}>
                  {data.nextFollowUpAt ? format.dateTime(data.nextFollowUpAt) : '—'}
                </Detail>
                <Detail label={t('detail.contact')}>
                  <span className="ltr-isolate">{data.customer.phone}</span>
                </Detail>
                <Detail label={t('detail.notes')}>{data.notes ?? '—'}</Detail>
                {Object.entries(data.customFields).map(([key, value]) =>
                  value === null ? null : (
                    <Detail key={key} label={labels.get(key) ?? key}>
                      {String(value)}
                    </Detail>
                  ),
                )}
              </dl>
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('activity.title')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {activity.isPending ? (
            <p className="text-muted-foreground px-4 pb-4 text-sm">{t('loading')}</p>
          ) : activity.isError ? (
            <p role="alert" className="text-destructive px-4 pb-4 text-sm">
              {t('activity.loadFailed')}
            </p>
          ) : (
            <ul className="divide-y" data-testid="lead-activity">
              {activity.data.data.map((entry) => (
                <ActivityEntry key={entry.id} entry={entry} fieldLabels={labels} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {data ? (
        <FormDialog
          open={editing}
          onClose={() => setEditing(false)}
          title={t('detail.editTitle')}
          description={t('form.description')}
          wide
        >
          {editing ? (
            <LeadForm key={`${data.id}:${data.rev}`} lead={data} onDone={() => setEditing(false)} />
          ) : null}
        </FormDialog>
      ) : null}
      {stageMove.dialog}
    </div>
  );
}
