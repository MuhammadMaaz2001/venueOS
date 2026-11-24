'use client';

import { isPermission } from '@venueos/shared';
import type { Permission } from '@venueos/shared';
import { Menu } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { directionOf } from '@/i18n/config';
import type { Locale } from '@/i18n/config';
import { useMe, useTenants } from '../me/api';
import { SessionProvider } from './session';
import type { Session } from './session';
import { SidebarNav } from './sidebar-nav';
import { TenantSwitcher } from './tenant-switcher';
import { UserMenu } from './user-menu';
import { LanguageSwitcher } from '@/components/language-switcher';

function Brand() {
  const t = useTranslations('Meta');
  return <span className="text-lg font-bold tracking-tight">{t('title')}</span>;
}

function ShellSkeleton() {
  return (
    <div className="grid min-h-dvh place-items-center p-6" aria-busy="true">
      <div className="grid w-full max-w-sm gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}

/**
 * The frame of every logged-in page: sidebar (a sheet on a phone), workspace switcher, account menu. It loads
 * `/v1/me` first; a lost session (401) is handled globally and sends the user to the login page, and a login
 * without an active workspace goes to the workspace picker.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations('Shell');
  const router = useRouter();
  const locale = useLocale() as Locale;
  const [menuOpen, setMenuOpen] = useState(false);
  const me = useMe();
  const tenants = useTenants();

  const noWorkspace = me.isSuccess && me.data.access === null;
  useEffect(() => {
    if (noWorkspace) router.replace('/select-workspace');
  }, [noWorkspace, router]);

  const session = useMemo<Session | null>(() => {
    const access = me.data?.access;
    const tenant = tenants.data?.data.find((candidate) => candidate.id === me.data?.activeTenantId);
    if (!me.data || !access || !tenant) return null;
    const held = new Set<Permission>(access.permissions.filter(isPermission));
    return { user: me.data.user, tenant, access, can: (permission) => held.has(permission) };
  }, [me.data, tenants.data]);

  if (!session) {
    if (me.isError || tenants.isError) {
      return (
        <div className="grid min-h-dvh place-items-center p-6">
          <Alert variant="destructive" role="alert" className="max-w-sm">
            <AlertDescription>{t('loadFailed')}</AlertDescription>
          </Alert>
        </div>
      );
    }
    return <ShellSkeleton />;
  }

  const sheetSide = directionOf(locale) === 'rtl' ? 'right' : 'left';
  const readOnly = session.tenant.status === 'SUSPENDED';

  return (
    <SessionProvider session={session}>
      <div className="min-h-dvh md:grid md:grid-cols-[16rem_1fr]">
        <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border hidden border-e md:block">
          <div className="sticky top-0 grid gap-6 p-4">
            <Brand />
            <SidebarNav />
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="bg-background/95 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-3 backdrop-blur md:px-6">
            <Button
              variant="ghost"
              size="icon"
              className="size-10 md:hidden"
              aria-label={t('openMenu')}
              onClick={() => setMenuOpen(true)}
            >
              <Menu aria-hidden />
            </Button>
            <div className="min-w-0 flex-1">
              <TenantSwitcher />
            </div>
            <UserMenu />
          </header>

          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetContent side={sheetSide} className="bg-sidebar w-72 max-w-[85vw]">
              <SheetHeader>
                <SheetTitle>
                  <Brand />
                </SheetTitle>
                <SheetDescription className="sr-only">{t('menuDescription')}</SheetDescription>
              </SheetHeader>
              <div className="px-4">
                <SidebarNav onNavigate={() => setMenuOpen(false)} />
              </div>
              <div className="mt-auto p-4">
                <LanguageSwitcher />
              </div>
            </SheetContent>
          </Sheet>

          {readOnly ? (
            <Alert className="m-3 md:mx-6" role="status">
              <AlertDescription>{t('suspended')}</AlertDescription>
            </Alert>
          ) : null}

          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </div>
    </SessionProvider>
  );
}
