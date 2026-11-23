import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_ROLES, PERMISSIONS, PERMISSION_GROUPS } from '@venueos/shared';
import { describe, expect, it } from 'vitest';

// docs/04-security.md section 2 is the source of truth for permission names; packages/shared must mirror it.

const doc = readFileSync(path.resolve(process.cwd(), '../../docs/04-security.md'), 'utf8');

function documentedPermissions(): Record<string, string[]> {
  const start = doc.indexOf('**MVP permission list**');
  expect(start).toBeGreaterThan(-1);
  const section = doc.slice(start, doc.indexOf('`booking.create` / `booking.edit`', start));
  const byArea: Record<string, string[]> = {};
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const area = cells[1];
    if (cells.length < 4 || !area || area === 'Area' || /^-+$/.test(area)) continue;
    byArea[area] = [...(cells[2] ?? '').matchAll(/`([a-z_.]+)`/g)].map((m) => m[1] as string);
  }
  return byArea;
}

describe('permissions.ts mirrors docs/04-security.md', () => {
  const docs = documentedPermissions();
  const areaToGroup: Record<string, keyof typeof PERMISSION_GROUPS> = {
    Tenant: 'tenant',
    Setup: 'setup',
    CRM: 'crm',
    Bookings: 'bookings',
    Money: 'money',
    Operations: 'operations',
    Reports: 'reports',
  };

  it('documents exactly the areas the code groups', () => {
    expect(Object.keys(docs).sort()).toEqual(Object.keys(areaToGroup).sort());
  });

  it.each(Object.entries(areaToGroup))(
    'area %s lists the same permissions as the %s group',
    (area, group) => {
      expect([...(docs[area] ?? [])].sort()).toEqual([...PERMISSION_GROUPS[group]].sort());
    },
  );

  it('has the same total, nothing extra and nothing missing', () => {
    const all = Object.values(docs).flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...PERMISSIONS].sort());
  });
});

describe('DEFAULT_ROLES mirrors the table in docs/01-product-scope.md', () => {
  const scope = readFileSync(path.resolve(process.cwd(), '../../docs/01-product-scope.md'), 'utf8');
  const start = scope.indexOf('**Default permission sets**');
  const section = scope.slice(start, scope.indexOf('Owner-only by default', start));

  const rows = new Map<string, { limit: number; permissions: string[] }>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const name = cells[1];
    const limit = Number(cells[2]);
    if (cells.length < 5 || !name || Number.isNaN(limit)) continue;
    rows.set(name, {
      limit,
      permissions: [...(cells[3] ?? '').matchAll(/`([a-z_.]+)`/g)].map((m) => m[1] as string),
    });
  }

  it('has a row for every default role', () => {
    expect([...rows.keys()]).toEqual(DEFAULT_ROLES.map((r) => r.name));
  });

  it.each(DEFAULT_ROLES.map((r) => [r.name, r] as const))(
    '%s: limit and permissions match',
    (name, role) => {
      const row = rows.get(name);
      expect(row?.limit).toBe(role.limits.maxDiscountPct);
      if (role.key === 'owner') return; // documented as "All of them"
      expect([...(row?.permissions ?? [])].sort()).toEqual([...role.permissions].sort());
    },
  );
});
