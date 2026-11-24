import { LayoutDashboard, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Permission } from '@venueos/shared';

export interface NavItem {
  href: string;
  /** Key in the `Shell.nav` messages. */
  label: 'dashboard' | 'staff';
  icon: LucideIcon;
  /** The item is shown only to roles that hold this permission (display only: the API enforces it). */
  permission?: Permission;
}

/** The sidebar. Modules add their entry here when they ship (docs/09, "MVP module order"). */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'dashboard', icon: LayoutDashboard },
  { href: '/staff', label: 'staff', icon: Users, permission: 'staff.manage' },
];
