'use client';

import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { AuditLogItemDto } from '@venueos/shared';
import { SelectField, TextField } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormatters, useSession } from '../shell/session';
import { useStaff } from '../staff/api';
import { useAuditLogs } from './api';
import type { AuditFilters } from './api';
import { AuditDetail } from './audit-detail';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from './labels';
import { useAuditLabels } from './use-audit-labels';

/** The audit trail (`audit.view`): filters, a list that is a table on a desktop and cards on a phone, a detail sheet. */
export function AuditPage() {
  const t = useTranslations('Audit');
  const { can } = useSession();
  const allowed = can('audit.view');
  const [filters, setFilters] = useState<AuditFilters>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const logs = useAuditLogs(filters, allowed);

  // The nav hides this page from roles without the permission; this is the page-level answer to a typed URL.
  if (!allowed) {
    return (
      <Alert variant="destructive" role="alert" className="mx-auto max-w-3xl">
        <AlertDescription>{t('noAccess')}</AlertDescription>
      </Alert>
    );
  }

  const rows = logs.data?.pages.flatMap((page) => page.data) ?? [];
  const set = (patch: AuditFilters) => setFilters((current) => ({ ...current, ...patch }));
  const filtered = Object.values(filters).some((v) => v);

  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <Filters
        filters={filters}
        onChange={set}
        onReset={() => setFilters({})}
        canReset={filtered}
      />

      {logs.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : logs.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="audit-empty">
          {t('empty')}
        </p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div
              className="text-muted-foreground hidden gap-4 border-b px-4 py-2 text-xs font-medium uppercase md:grid md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_auto]"
              aria-hidden
            >
              <span>{t('columns.when')}</span>
              <span>{t('columns.who')}</span>
              <span>{t('columns.action')}</span>
              <span>{t('columns.entity')}</span>
              <span className="w-24" />
            </div>
            <ul className="divide-y" data-testid="audit-list">
              {rows.map((row) => (
                <AuditRow key={row.id} row={row} onOpen={() => setOpenId(row.id)} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {logs.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10 justify-self-center"
          disabled={logs.isFetchingNextPage}
          aria-busy={logs.isFetchingNextPage}
          onClick={() => void logs.fetchNextPage()}
          data-testid="audit-more"
        >
          {t('loadMore')}
        </Button>
      ) : null}

      <AuditDetail id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function AuditRow({ row, onOpen }: { row: AuditLogItemDto; onOpen: () => void }) {
  const t = useTranslations('Audit');
  const formatters = useFormatters();
  const labels = useAuditLabels();
  const actor = row.actorType === 'SYSTEM' ? t('system') : (row.actorName ?? t('unknownActor'));
  const action = labels.action(row.action);
  return (
    <li
      className="grid gap-1 px-4 py-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-4"
      data-testid="audit-row"
      data-action={row.action}
    >
      <p className="text-muted-foreground text-xs md:text-sm">
        {formatters.dateTime(row.createdAt)}
      </p>
      <p className="truncate text-sm">{actor}</p>
      <p className="text-sm font-medium" data-testid="audit-action">
        {action}
      </p>
      <p className="text-muted-foreground truncate text-xs md:text-sm">
        {labels.entityType(row.entityType)}{' '}
        <span className="ltr-text" title={row.entityId}>
          {row.entityId.slice(-6)}
        </span>
      </p>
      <div className="md:justify-self-end">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-9"
          onClick={onOpen}
          aria-label={t('openNamed', { action })}
        >
          {t('open')}
          <ChevronRight aria-hidden className="rtl:rotate-180" />
        </Button>
      </div>
    </li>
  );
}

function Filters({
  filters,
  onChange,
  onReset,
  canReset,
}: {
  filters: AuditFilters;
  onChange: (patch: AuditFilters) => void;
  onReset: () => void;
  canReset: boolean;
}) {
  const t = useTranslations('Audit.filters');
  const labels = useAuditLabels();
  const { can } = useSession();
  // Naming a person needs the staff list (`staff.manage`); without it the filter is simply not offered.
  const staff = useStaff();
  const people = can('staff.manage') ? (staff.data?.data ?? []) : [];

  return (
    <section aria-label={t('title')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <SelectField
        label={t('entityType')}
        value={filters.entityType ?? ''}
        onChange={(event) => onChange({ entityType: event.target.value })}
      >
        <option value="">{t('any')}</option>
        {AUDIT_ENTITY_TYPES.map((type) => (
          <option key={type} value={type}>
            {labels.entityType(type)}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t('action')}
        value={filters.action ?? ''}
        onChange={(event) => onChange({ action: event.target.value })}
      >
        <option value="">{t('any')}</option>
        {AUDIT_ACTIONS.map((action) => (
          <option key={action} value={action}>
            {labels.action(action)}
          </option>
        ))}
      </SelectField>
      {can('staff.manage') ? (
        <SelectField
          label={t('actor')}
          value={filters.actorUserId ?? ''}
          onChange={(event) => onChange({ actorUserId: event.target.value })}
        >
          <option value="">{t('any')}</option>
          {people.map((person) => (
            <option key={person.userId} value={person.userId}>
              {person.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      <TextField
        label={t('from')}
        type="date"
        value={filters.from ?? ''}
        max={filters.to || undefined}
        onChange={(event) => onChange({ from: event.target.value })}
      />
      <TextField
        label={t('to')}
        type="date"
        value={filters.to ?? ''}
        min={filters.from || undefined}
        onChange={(event) => onChange({ to: event.target.value })}
      />
      {canReset ? (
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="h-10 self-end justify-self-start"
          onClick={onReset}
        >
          {t('reset')}
        </Button>
      ) : null}
    </section>
  );
}
