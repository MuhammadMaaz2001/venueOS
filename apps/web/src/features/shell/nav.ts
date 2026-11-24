import { Building2, LayoutDashboard, Settings, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Permission } from '@venueos/shared';

export interface NavItem {
  href: string;
  /** Key in the `Shell.nav` messages. */
  label: 'dashboard' | 'venues' | 'staff' | 'settings';
  icon: LucideIcon;
  /** The item is shown only to roles that hold this permission (display only: the API enforces it). */
  permission?: Permission;
}

/** The sidebar. Modules add their entry here when they ship (docs/09, "MVP module order"). */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'dashboard', icon: LayoutDashboard },
  { href: '/venues', label: 'venues', icon: Building2, permission: 'venue.manage' },
  { href: '/staff', label: 'staff', icon: Users, permission: 'staff.manage' },
  { href: '/settings', label: 'settings', icon: Settings, permission: 'tenant.settings.manage' },
];
