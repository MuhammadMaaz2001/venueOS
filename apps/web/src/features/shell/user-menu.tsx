'use client';

import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLogout } from '../auth/api';
import { useSession } from './session';

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? '');
  return letters.join('').toUpperCase() || '?';
}

/** The account menu: who I am, my role here, log out (here or on every device). */
export function UserMenu() {
  const t = useTranslations('Shell.user');
  const router = useRouter();
  const { user, access } = useSession();
  const logout = useLogout();

  const leave = (everywhere: boolean) =>
    logout.mutate(everywhere, { onSettled: () => router.replace('/login') });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-9 gap-2 px-1.5"
          aria-label={t('menu')}
          data-testid="user-menu"
        >
          <Avatar>
            <AvatarFallback>{initials(user.name)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="text-foreground truncate text-sm font-medium">{user.name}</span>
          {user.email ? (
            <span className="ltr-text truncate text-xs font-normal">{user.email}</span>
          ) : null}
          <span className="text-xs font-normal">{access.roleName}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => leave(false)} data-testid="logout">
          <LogOut aria-hidden />
          {t('logout')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => leave(true)} data-testid="logout-all">
          <LogOut aria-hidden />
          {t('logoutAll')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
