'use client';

import type { CancellationPolicyDto } from '@venueos/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { CheckboxField, SubmitButton, TextField } from '@/components/form-fields';
import {
  FormDialog,
  ListState,
  Row,
  RowList,
  TabHeader,
  useCanWrite,
} from '@/components/resource-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useCancellationPolicies,
  useCreateCancellationPolicy,
  useUpdateCancellationPolicy,
} from './api';
import { newTierRow, rowsFromTiers, sortRowsByDays, tierProblem, tiersFromRows } from './logic';
import type { TierRow } from './logic';

/** Cancellation policies (docs/05 section 6): refund tiers by days before the first session. */
export function PoliciesTab() {
  const t = useTranslations('Pricing.policies');
  const mayWrite = useCanWrite('pricing.manage');
  const policies = useCancellationPolicies({ includeInactive: true });
  const [editing, setEditing] = useState<CancellationPolicyDto | 'new' | null>(null);

  return (
    <div className="grid gap-4">
      <TabHeader
        description={t('description')}
        addLabel={mayWrite ? t('add') : undefined}
        onAdd={mayWrite ? () => setEditing('new') : undefined}
        addTestId="policy-add"
      />
      <ListState
        pending={policies.isPending}
        failed={policies.isError}
        empty={policies.isSuccess && policies.data.data.length === 0}
        emptyText={t('empty')}
        loadFailedText={t('loadFailed')}
      >
        <RowList testId="policy-list">
          {(policies.data?.data ?? []).map((policy) => (
            <Row
              key={policy.id}
              testId="policy-row"
              onOpen={mayWrite ? () => setEditing(policy) : undefined}
              openLabel={t('edit', { name: policy.name })}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{policy.name}</span>
                <span className="text-muted-foreground block text-xs">
                  {policy.tiers
                    .map((tier) =>
                      tier.minDaysBefore === 0
                        ? t('tierLast', { pct: tier.refundPct })
                        : t('tierDays', { days: tier.minDaysBefore, pct: tier.refundPct }),
                    )
                    .join(' · ')}
                </span>
              </span>
              {policy.isDefault ? <Badge>{t('default')}</Badge> : null}
              {!policy.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
            </Row>
          ))}
        </RowList>
      </ListState>
      <FormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? t('addTitle') : t('editTitle')}
        description={t('formDescription')}
      >
        {editing !== null ? (
          <PolicyForm
            key={editing === 'new' ? 'new' : `${editing.id}:${editing.rev}`}
            policy={editing === 'new' ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}

const STARTER_ROWS = (): TierRow[] => [newTierRow('0', '0')];

/** The tiers as editable rows: days before, refund percent; add, remove, and "put in order". */
export function TierEditor({
  rows,
  onChange,
}: {
  rows: readonly TierRow[];
  onChange: (rows: TierRow[]) => void;
}) {
  const t = useTranslations('Pricing.policies');
  const problem = tierProblem(rows);
  const set = (key: string, patch: Partial<TierRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <div className="grid gap-2" data-testid="tier-editor">
      <span className="text-sm font-medium">{t('tiers')}</span>
      <p className="text-muted-foreground text-xs">{t('tiersHint')}</p>
      <ul className="grid gap-2">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
            data-testid="tier-row"
          >
            <TextField
              label={t('daysBefore')}
              inputMode="numeric"
              isolate
              value={row.days}
              onChange={(e) => set(row.key, { days: e.target.value })}
              data-testid={`tier-days-${index}`}
            />
            <TextField
              label={t('refundPct')}
              inputMode="decimal"
              isolate
              value={row.pct}
              onChange={(e) => set(row.key, { pct: e.target.value })}
              data-testid={`tier-pct-${index}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10"
              aria-label={t('removeTier')}
              disabled={rows.length <= 1}
              onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
            >
              <Trash2 aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-9"
          onClick={() => onChange([...rows, newTierRow()])}
          data-testid="tier-add"
        >
          <Plus aria-hidden />
          {t('addTier')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-9"
          onClick={() => onChange(sortRowsByDays(rows))}
        >
          {t('sortTiers')}
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="text-destructive text-xs" data-testid="tier-problem">
          {t(`problems.${problem}`)}
        </p>
      ) : null}
    </div>
  );
}

function PolicyForm({
  policy,
  onDone,
}: {
  policy?: CancellationPolicyDto | undefined;
  onDone: () => void;
}) {
  const t = useTranslations('Pricing.policies');
  const create = useCreateCancellationPolicy();
  const update = useUpdateCancellationPolicy();
  const [name, setName] = useState(policy?.name ?? '');
  const [isDefault, setIsDefault] = useState(policy?.isDefault ?? false);
  const [rows, setRows] = useState<TierRow[]>(() =>
    policy ? rowsFromTiers(policy.tiers) : STARTER_ROWS(),
  );
  const [submitted, setSubmitted] = useState(false);

  const problem = tierProblem(rows);
  const nameMissing = name.trim() === '';
  const pending = create.isPending || update.isPending;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (problem || nameMissing) return;
    const body = { name: name.trim(), tiers: tiersFromRows(rows), isDefault };
    try {
      if (policy) await update.mutateAsync({ ...body, id: policy.id, rev: policy.rev });
      else await create.mutateAsync(body);
      toast.success(t('saved'));
      onDone();
    } catch {
      // Toasted globally (a name that is taken, a stale form).
    }
  };

  const toggle = async () => {
    if (!policy) return;
    try {
      await update.mutateAsync({ id: policy.id, rev: policy.rev, active: !policy.active });
      toast.success(t('saved'));
      onDone();
    } catch {
      // Toasted globally.
    }
  };

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" data-testid="policy-form">
      <TextField
        label={t('name')}
        autoComplete="off"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={submitted && nameMissing ? t('nameRequired') : undefined}
      />
      <TierEditor rows={rows} onChange={setRows} />
      {policy && !policy.active ? null : (
        <CheckboxField
          label={t('makeDefault')}
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
      )}
      <SubmitButton pending={pending} disabled={submitted && (problem !== null || nameMissing)}>
        {policy ? t('save') : t('create')}
      </SubmitButton>
      {policy ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-10"
          disabled={pending}
          onClick={toggle}
          data-testid="policy-toggle"
        >
          {policy.active ? t('deactivate') : t('reactivate')}
        </Button>
      ) : null}
    </form>
  );
}
