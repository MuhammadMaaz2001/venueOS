'use client';

import { useTranslations } from 'next-intl';
import { systemRoleKey } from './labels';

/**
 * The name of a role for display. System roles (Owner, Sales agent, ...) are translated through the messages file;
 * a custom role shows the name its workspace gave it. The API stores and sends the English name of a system role,
 * which is locked and unique per workspace, so a custom role can never be mistaken for one.
 */
export function useRoleName(): (name: string) => string {
  const t = useTranslations('Roles.system');
  return (name) => {
    const key = systemRoleKey(name);
    return key ? t(key) : name;
  };
}
