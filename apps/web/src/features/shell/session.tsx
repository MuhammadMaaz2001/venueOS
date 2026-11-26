'use client';

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useLocale } from 'next-intl';
import type { AccessSummary, Permission, TenantSummary, UserSummary } from '@venueos/shared';
import { formatDate, formatDateOnly, formatDateTime, formatMoney, formatTime } from '@/lib/format';
import type { DateOnlyStyle } from '@/lib/format';

/** Who is working, in which workspace, with which rights: one object for every screen below the shell. */
export interface Session {
  user: UserSummary;
  tenant: TenantSummary;
  access: AccessSummary;
  /** Does my role in this workspace include the permission? (The API checks it again on every call.) */
  can: (permission: Permission) => boolean;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside the app shell');
  return session;
}

/**
 * Money and date formatters bound to the workspace: its currency (with the ISO 4217 minor units), its time zone
 * and the language of the page. Screens call these and never `Intl` directly (lib/format.ts is the only place).
 */
export function useFormatters() {
  const { tenant } = useSession();
  const locale = useLocale();
  return useMemo(() => {
    const options = { locale, timeZone: tenant.timezone };
    return {
      money: (value: string) => formatMoney(value, tenant.currency, locale),
      date: (instant: string | Date) => formatDate(instant, options),
      time: (instant: string | Date) => formatTime(instant, options),
      dateTime: (instant: string | Date) => formatDateTime(instant, options),
      dateOnly: (value: string, style?: DateOnlyStyle) => formatDateOnly(value, locale, style),
    };
  }, [locale, tenant.currency, tenant.timezone]);
}
