'use client';

import { Copy, Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { RoleDto } from '@venueos/shared';
import { CheckboxField } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '../shell/session';
import { useRoles } from './api';
import { CopyRoleDialog } from './copy-role-dialog';
import { RoleEditor } from './role-editor';
import { useRoleName } from './use-role-name';

/** Roles of the workspace (`role.manage`): who holds which permissions, copy a role, edit it, retire it. */
export function RolesPage() {
  const t = useTranslations('Roles');
  const { can } = useSession();
  const [withRetired, setWithRetired] = useState(false);
  const [copying, setCopying] = useState<RoleDto | null>(null);
  const [editing, setEditing] = useState<RoleDto | null>(null);
  const roleName = useRoleName();
  const allowed = can('role.manage');
  const roles = useRoles(withRetired, allowed);

  // The nav hides this page from roles without the permission; this is the page-level answer to a typed URL.
  if (!allowed) {
    return (
      <Alert variant="destructive" role="alert" className="mx-auto max-w-3xl">
        <AlertDescription>{t('noAccess')}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <CheckboxField
          label={t('showRetired')}
          checked={withRetired}
          onChange={(event) => setWithRetired(event.target.checked)}
          data-testid="show-retired"
        />
      </div>

      {roles.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : roles.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y" data-testid="role-list">
              {roles.data.data.map((role) => {
                const name = roleName(role.name);
                return (
                  <li
                    key={role.id}
                    className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_auto] md:items-center md:gap-4"
                    data-testid="role-row"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="truncate" data-testid="role-name">
                          {name}
                        </span>
                        {role.isSystem ? (
                          <Badge variant="secondary">{t('badge.system')}</Badge>
                        ) : null}
                        {role.active ? null : <Badge variant="outline">{t('badge.retired')}</Badge>}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {t('row.members', { count: role.memberCount })} ·{' '}
                        {t('row.permissions', { count: role.permissions.length })}
                      </p>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {t('row.discount', { pct: role.limits.maxDiscountPct })}
                    </p>
                    <div className="flex gap-2 md:justify-self-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="h-9"
                        onClick={() => setEditing(role)}
                        aria-label={t('row.editNamed', { name })}
                      >
                        <Pencil aria-hidden />
                        {role.active ? t('row.edit') : t('row.view')}
                      </Button>
                      {role.active ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="lg"
                          className="h-9"
                          onClick={() => setCopying(role)}
                          aria-label={t('row.copyNamed', { name })}
                        >
                          <Copy aria-hidden />
                          {t('row.copy')}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <CopyRoleDialog
        source={copying}
        onClose={() => setCopying(null)}
        onCreated={(role) => {
          setCopying(null);
          setEditing(role);
        }}
      />
      <RoleEditor role={editing} onChange={setEditing} onClose={() => setEditing(null)} />
    </div>
  );
}
