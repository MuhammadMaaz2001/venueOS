'use client';

import { Building2, Check, ChevronsUpDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSwitchTenant, useTenants } from '../me/api';
import { useSession } from './session';

/**
 * The workspace picker of the top bar. A user with one workspace just sees its name; with several, a menu that
 * switches (`POST /v1/me/switch-tenant`), after which everything on screen is reloaded for the new workspace.
 */
export function TenantSwitcher() {
  const t = useTranslations('Shell.tenant');
  const router = useRouter();
  const { tenant } = useSession();
  const tenants = useTenants();
  const switchTenant = useSwitchTenant();
  const others = tenants.data?.data ?? [];

  if (others.length <= 1) {
    return (
      <div
        className="flex min-w-0 items-center gap-2 px-2 text-sm font-medium"
        data-testid="tenant-name"
      >
        <Building2 className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{tenant.name}</span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-9 max-w-full min-w-0 justify-between gap-2"
          aria-label={t('switch')}
          data-testid="tenant-switcher"
          disabled={switchTenant.isPending}
        >
          <Building2 aria-hidden />
          <span className="truncate">{tenant.name}</span>
          <ChevronsUpDown className="opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t('label')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {others.map((candidate) => (
          <DropdownMenuItem
            key={candidate.id}
            disabled={candidate.id === tenant.id}
            onSelect={() => {
              if (candidate.id === tenant.id) return;
              switchTenant.mutate(candidate.id, { onSuccess: () => router.replace('/') });
            }}
          >
            <span className="truncate">{candidate.name}</span>
            {candidate.id === tenant.id ? <Check className="ms-auto" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
