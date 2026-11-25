'use client';

import type { PriceRuleDto } from '@venueos/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { FormDialog, ListState, Row, RowList, TabHeader } from '@/components/resource-ui';
import { Badge } from '@/components/ui/badge';
import { formatDateOnly } from '@/lib/format';
import { useSlots, useSpaces } from '../setup/api';
import { describeDays } from '../setup/logic';
import { useFormatters, useSession } from '../shell/session';
import { usePriceRules } from './api';
import { ruleEffect } from './logic';
import { PriceRuleForm } from './price-rule-form';
import { RentPreviewPanel } from './rent-preview-panel';

/**
 * Price rules (docs/05 section 3 step 2) with the rent preview above them. Anyone with `pricing.manage` may add rules;
 * someone limited to some venues only for a space or slot of their own (the API checks).
 */
export function PriceRulesTab() {
  const t = useTranslations('Pricing.rules');
  const { can } = useSession();
  const mayWrite = can('pricing.manage');
  const rules = usePriceRules({ includeInactive: true });
  const [editing, setEditing] = useState<PriceRuleDto | 'new' | null>(null);

  return (
    <div className="grid gap-6">
      {can('venue.view') ? <RentPreviewPanel /> : null}
      <div className="grid gap-4">
        <TabHeader
          description={t('description')}
          addLabel={mayWrite ? t('add') : undefined}
          onAdd={mayWrite ? () => setEditing('new') : undefined}
          addTestId="price-rule-add"
        />
        <ListState
          pending={rules.isPending}
          failed={rules.isError}
          empty={rules.isSuccess && rules.data.data.length === 0}
          emptyText={t('empty')}
          loadFailedText={t('loadFailed')}
        >
          <RowList testId="price-rule-list">
            {(rules.data?.data ?? []).map((rule) => (
              <Row
                key={rule.id}
                testId="price-rule-row"
                onOpen={mayWrite ? () => setEditing(rule) : undefined}
                openLabel={t('edit', { name: rule.name })}
              >
                <RuleSummary rule={rule} />
              </Row>
            ))}
          </RowList>
        </ListState>
      </div>
      <FormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('addTitle') : t('editTitle')}
        description={t('formDescription')}
        wide
      >
        {editing !== null ? (
          <PriceRuleForm
            key={editing === 'new' ? 'new' : `${editing.id}:${editing.rev}`}
            rule={editing === 'new' ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}

function RuleSummary({ rule }: { rule: PriceRuleDto }) {
  const t = useTranslations('Pricing.rules');
  const td = useTranslations('Setup.days');
  const locale = useLocale();
  const fmt = useFormatters();

  const when =
    rule.kind === 'DAY_OF_WEEK'
      ? describeDays(rule.daysOfWeek, td('every'), (d) => td(`short.${d}`))
      : rule.kind === 'DATE_RANGE' && rule.startDate && rule.endDate
        ? `${formatDateOnly(rule.startDate, locale)} – ${formatDateOnly(rule.endDate, locale)}`
        : rule.startDate
          ? formatDateOnly(rule.startDate, locale)
          : '';

  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{rule.name}</span>
        <span className="text-muted-foreground block text-xs">
          {when} · <ScopeLabel rule={rule} /> · {t('priorityValue', { priority: rule.priority })}
        </span>
      </span>
      <span className="text-sm font-medium tabular-nums" data-testid="rule-effect">
        {ruleEffect(rule.adjustment, rule.value, fmt.money)}
      </span>
      {!rule.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
    </>
  );
}

/** "Hall A · Dinner", "All spaces · Dinner", "Every space and slot": names come from the venue's own lists. */
function ScopeLabel({ rule }: { rule: PriceRuleDto }) {
  const t = useTranslations('Pricing.rules');
  const { can } = useSession();
  if (rule.venueId === null) return <>{t('everywhere')}</>;
  if (!can('venue.view')) return <>{t('someSpaces')}</>;
  return <ScopeNames rule={rule} venueId={rule.venueId} />;
}

function ScopeNames({ rule, venueId }: { rule: PriceRuleDto; venueId: string }) {
  const t = useTranslations('Pricing.rules');
  const spaces = useSpaces(venueId, { includeInactive: true });
  const slots = useSlots(venueId, { includeInactive: true });
  const space =
    rule.spaceId === null
      ? t('allSpaces')
      : (spaces.data?.data.find((s) => s.id === rule.spaceId)?.name ?? t('someSpaces'));
  const slot =
    rule.slotId === null
      ? t('allSlots')
      : (slots.data?.data.find((s) => s.id === rule.slotId)?.name ?? t('someSlots'));
  return <>{`${space} · ${slot}`}</>;
}
