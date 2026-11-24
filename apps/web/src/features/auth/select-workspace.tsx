'use client';

import { Building2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { safeNextPath } from '@/lib/safe-next';
import { useSwitchTenant, useTenants } from '../me/api';
import { useLogout } from './api';
import { AuthCard } from './auth-card';

/** Shown after a login that has no active workspace (the user belongs to several). */
export function SelectWorkspace({ next }: { next?: string | undefined }) {
  const t = useTranslations();
  const router = useRouter();
  const tenants = useTenants();
  const switchTenant = useSwitchTenant();
  const logout = useLogout();
  const target = safeNextPath(next);

  const choose = (tenantId: string) =>
    switchTenant.mutate(tenantId, { onSuccess: () => router.replace(target) });

  return (
    <AuthCard title={t('Auth.workspace.title')} description={t('Auth.workspace.description')}>
      {tenants.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : tenants.data && tenants.data.data.length > 0 ? (
        <ul className="grid gap-2">
          {tenants.data.data.map((tenant) => (
            <li key={tenant.id}>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-12 w-full justify-start gap-3"
                disabled={switchTenant.isPending}
                onClick={() => choose(tenant.id)}
              >
                <Building2 aria-hidden />
                <span className="truncate">{tenant.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : tenants.isSuccess ? (
        <p className="text-muted-foreground text-sm">{t('Auth.workspace.none')}</p>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        onClick={() => logout.mutate(false, { onSettled: () => router.replace('/login') })}
      >
        {t('Shell.user.logout')}
      </Button>
    </AuthCard>
  );
}
