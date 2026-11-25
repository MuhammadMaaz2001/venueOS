import { Building2, LayoutDashboard, ScrollText, Settings, ShieldCheck, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Permission } from '@venueos/shared';

export interface NavItem {
  href: string;
  /** Key in the `Shell.nav` messages. */
  label: 'dashboard' | 'venues' | 'staff' | 'roles' | 'audit' | 'settings';
  icon: LucideIcon;
  /** The item is shown only to roles that hold this permission (display only: the API enforces it). */
  permission?: Permission;
}

/** The sidebar. Modules add their entry here when they ship (docs/09, "MVP module order"). */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'dashboard', icon: LayoutDashboard },
  { href: '/venues', label: 'venues', icon: Building2, permission: 'venue.view' },
  { href: '/staff', label: 'staff', icon: Users, permission: 'staff.manage' },
  { href: '/roles', label: 'roles', icon: ShieldCheck, permission: 'role.manage' },
  { href: '/audit', label: 'audit', icon: ScrollText, permission: 'audit.view' },
  { href: '/settings', label: 'settings', icon: Settings, permission: 'tenant.settings.manage' },
];
