'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './nav';
import { useSession } from './session';

/** The navigation links, filtered by what the role may see. Used by the desktop rail and the mobile sheet. */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations('Shell.nav');
  const pathname = usePathname();
  const { can } = useSession();

  return (
    <nav aria-label={t('label')} className="grid gap-1">
      {NAV_ITEMS.filter((item) => !item.permission || can(item.permission)).map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
              active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {t(item.label)}
          </Link>
        );
      })}
    </nav>
  );
}
