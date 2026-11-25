'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { CheckboxField } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useFormatters } from '../shell/session';
import { useAuditLog } from './api';
import { diffJson, formatDiffValue } from './diff';
import type { DiffRow } from './diff';
import { useAuditLabels } from './use-audit-labels';

/** One audit entry in a side sheet: who, when, what, and a field-by-field before/after. */
export function AuditDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTranslations('Audit.detail');
  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('title')}</SheetTitle>
          <SheetDescription>{t('description')}</SheetDescription>
        </SheetHeader>
        {id ? <DetailBody id={id} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function DetailBody({ id }: { id: string }) {
  const t = useTranslations('Audit');
  const entry = useAuditLog(id);
  const formatters = useFormatters();
  const labels = useAuditLabels();
  const [showSame, setShowSame] = useState(false);

  const rows = useMemo(
    () => (entry.data ? diffJson(entry.data.before, entry.data.after) : []),
    [entry.data],
  );

  if (entry.isPending) {
    return (
      <div className="grid gap-2 px-4" aria-busy="true">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (entry.isError) {
    return (
      <Alert variant="destructive" role="alert" className="mx-4 w-auto">
        <AlertDescription>{t('detail.loadFailed')}</AlertDescription>
      </Alert>
    );
  }

  const data = entry.data;
  const actor = data.actorType === 'SYSTEM' ? t('system') : (data.actorName ?? t('unknownActor'));
  const visible = showSame ? rows : rows.filter((row) => row.kind !== 'same');

  return (
    <div className="grid gap-5 px-4 pb-6" data-testid="audit-detail">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t('detail.when')}</dt>
        <dd>{formatters.dateTime(data.createdAt)}</dd>
        <dt className="text-muted-foreground">{t('detail.who')}</dt>
        <dd>{actor}</dd>
        <dt className="text-muted-foreground">{t('detail.action')}</dt>
        <dd className="font-medium">{labels.action(data.action)}</dd>
        <dt className="text-muted-foreground">{t('detail.entity')}</dt>
        <dd>{labels.entityType(data.entityType)}</dd>
        <dt className="text-muted-foreground">{t('detail.entityId')}</dt>
        <dd className="ltr-text break-all">{data.entityId}</dd>
        {data.ip ? (
          <>
            <dt className="text-muted-foreground">{t('detail.ip')}</dt>
            <dd className="ltr-text">{data.ip}</dd>
          </>
        ) : null}
      </dl>

      <section className="grid gap-3" aria-label={t('detail.changes')}>
        <h3 className="text-sm font-medium">{t('detail.changes')}</h3>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('detail.noChanges')}</p>
        ) : (
          <>
            {rows.some((row) => row.kind === 'same') ? (
              <CheckboxField
                label={t('detail.showUnchanged')}
                checked={showSame}
                onChange={(event) => setShowSame(event.target.checked)}
              />
            ) : null}
            <ul className="grid gap-2" data-testid="audit-diff">
              {visible.map((row) => (
                <DiffItem key={row.path || 'value'} row={row} />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

const KIND_STYLE: Record<DiffRow['kind'], string> = {
  added: 'border-s-emerald-600',
  removed: 'border-s-red-600',
  changed: 'border-s-amber-500',
  same: 'border-s-transparent',
};

function DiffItem({ row }: { row: DiffRow }) {
  const t = useTranslations('Audit.detail');
  return (
    <li
      className={cn(
        'bg-muted/40 grid gap-1 rounded-md border-s-4 px-3 py-2 text-sm',
        KIND_STYLE[row.kind],
      )}
      data-kind={row.kind}
    >
      <p className="flex flex-wrap items-center gap-2 text-xs">
        <span className="ltr-text font-mono font-medium">{row.path || '—'}</span>
        {row.kind === 'same' ? null : <span className="text-muted-foreground">{t(row.kind)}</span>}
      </p>
      {row.addedItems || row.removedItems ? (
        <div className="grid gap-0.5 break-words">
          {row.addedItems && row.addedItems.length > 0 ? (
            <p className="text-emerald-700 dark:text-emerald-400">
              {t('items.added', { items: row.addedItems.join(', ') })}
            </p>
          ) : null}
          {row.removedItems && row.removedItems.length > 0 ? (
            <p className="text-red-700 dark:text-red-400">
              {t('items.removed', { items: row.removedItems.join(', ') })}
            </p>
          ) : null}
        </div>
      ) : row.kind === 'same' ? (
        <p className="ltr-text break-words">{formatDiffValue(row.after)}</p>
      ) : (
        <div className="grid gap-0.5 break-words">
          {row.kind !== 'added' ? (
            <p>
              <span className="text-muted-foreground">{t('before')}: </span>
              <span className="ltr-text line-through decoration-red-600/60">
                {formatDiffValue(row.before)}
              </span>
            </p>
          ) : null}
          {row.kind !== 'removed' ? (
            <p>
              <span className="text-muted-foreground">{t('after')}: </span>
              <span className="ltr-text">{formatDiffValue(row.after)}</span>
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}
