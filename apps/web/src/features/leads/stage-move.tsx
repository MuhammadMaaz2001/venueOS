'use client';

import { isOpenLeadStage } from '@venueos/shared';
import type { LeadDto, LeadStage } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { SubmitButton, TextAreaField, TextField } from '@/components/form-fields';
import { FormDialog } from '@/components/resource-ui';
import { Button } from '@/components/ui/button';
import { useSession } from '../shell/session';
import { useUpdateLead } from './api';
import { localInputToInstant, presetFollowUp } from './logic';

interface Pending {
  lead: LeadDto;
  to: LeadStage;
}

/**
 * Moving a lead from one stage to another (the board's move menu and drag-and-drop, and the lead page). Most moves go
 * straight through; LOST asks for the reason, and reopening a lost lead asks for its next follow-up (docs/05 section
 * 12). The API enforces the same rules again.
 */
export function useStageMove(): {
  move: (lead: LeadDto, to: LeadStage) => Promise<void>;
  dialog: ReactNode;
  busy: boolean;
} {
  const t = useTranslations('Leads');
  const { tenant } = useSession();
  const update = useUpdateLead();
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [followUp, setFollowUp] = useState(presetFollowUp(1, tenant.timezone));
  const [error, setError] = useState<string | undefined>();

  const send = async (lead: LeadDto, to: LeadStage, extra: object): Promise<boolean> => {
    try {
      await update.mutateAsync({ id: lead.id, rev: lead.rev, stage: to, ...extra });
      toast.success(t('stageMoved', { stage: t(`stages.${to}`) }));
      return true;
    } catch {
      return false; // toasted globally (a stale card, a move the rules refuse)
    }
  };

  const move = async (lead: LeadDto, to: LeadStage): Promise<void> => {
    if (to === 'LOST' || (lead.stage === 'LOST' && isOpenLeadStage(to))) {
      setReason('');
      setError(undefined);
      setFollowUp(presetFollowUp(1, tenant.timezone));
      setPending({ lead, to });
      return;
    }
    await send(lead, to, {});
  };

  const submit = async () => {
    if (!pending) return;
    if (pending.to === 'LOST') {
      if (reason.trim() === '') return setError(t('stageDialog.reasonRequired'));
      if (await send(pending.lead, 'LOST', { lostReason: reason.trim() })) setPending(null);
      return;
    }
    const instant = localInputToInstant(followUp, tenant.timezone);
    if (!instant) return setError(t('stageDialog.followUpRequired'));
    if (await send(pending.lead, pending.to, { nextFollowUpAt: instant })) setPending(null);
  };

  const dialog = (
    <FormDialog
      open={pending !== null}
      onClose={() => setPending(null)}
      title={pending?.to === 'LOST' ? t('stageDialog.lostTitle') : t('stageDialog.reopenTitle')}
      description={
        pending?.to === 'LOST'
          ? t('stageDialog.lostDescription')
          : t('stageDialog.reopenDescription')
      }
    >
      {pending ? (
        <form
          noValidate
          className="grid gap-4"
          data-testid="stage-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {pending.to === 'LOST' ? (
            <TextAreaField
              label={t('stageDialog.reason')}
              value={reason}
              maxLength={500}
              error={error}
              onChange={(event) => setReason(event.target.value)}
              data-testid="lost-reason"
            />
          ) : (
            <TextField
              label={t('form.nextFollowUp', { timezone: tenant.timezone })}
              type="datetime-local"
              value={followUp}
              error={error}
              onChange={(event) => setFollowUp(event.target.value)}
              data-testid="reopen-follow-up"
            />
          )}
          <div className="flex flex-wrap gap-2">
            <SubmitButton
              pending={update.isPending}
              className="w-auto flex-1"
              data-testid="stage-dialog-submit"
            >
              {pending.to === 'LOST' ? t('stageDialog.markLost') : t('stageDialog.reopen')}
            </SubmitButton>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-10"
              onClick={() => setPending(null)}
            >
              {t('stageDialog.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </FormDialog>
  );

  return { move, dialog, busy: update.isPending };
}
