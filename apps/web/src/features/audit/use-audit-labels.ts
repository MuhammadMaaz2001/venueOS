'use client';

import { useTranslations } from 'next-intl';
import { actionKey } from './labels';

/** Text for an action or entity type: its label, or the raw name for one this version does not know yet. */
export function useAuditLabels() {
  const t = useTranslations('Audit');
  return {
    action: (action: string): string =>
      t.has(`actions.${actionKey(action)}`) ? t(`actions.${actionKey(action)}`) : action,
    entityType: (type: string): string =>
      t.has(`entityTypes.${type}`) ? t(`entityTypes.${type}`) : type,
  };
}
