'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Permission, RoleDto } from '@venueos/shared';
import { TextField } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { errorMessageKey } from '@/lib/api/error-messages';
import type { ErrorMessageOverrides } from '@/lib/api/error-messages';
import { isApiError } from '@/lib/api/errors';
import { useSession } from '../shell/session';
import { RETIRE_ROLE_MESSAGES, SAVE_ROLE_MESSAGES, useUpdateRole } from './api';
import {
  PERMISSION_GROUP_LIST,
  isRequiredByManage,
  permissionKey,
  togglePermission,
} from './labels';
import { useRoleName } from './use-role-name';

/** Edit a role in a side sheet: name, discount limit, permissions by area; retire or restore it. */
export function RoleEditor({
  role,
  onChange,
  onClose,
}: {
  role: RoleDto | null;
  /** The saved role (new `rev`): the editor starts over from it. */
  onChange: (role: RoleDto) => void;
  onClose: () => void;
}) {
  const t = useTranslations('Roles.edit');
  const roleName = useRoleName();
  return (
    <Sheet open={role !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        {role ? (
          <>
            <SheetHeader>
              <SheetTitle>
                {t(role.active ? 'title' : 'retiredTitle', { name: roleName(role.name) })}
              </SheetTitle>
              <SheetDescription>
                {t(role.active ? 'description' : 'retiredDescription')}
              </SheetDescription>
            </SheetHeader>
            {/* Keyed: a newer version of the same role (or another role) starts a fresh form. */}
            <EditorForm
              key={`${role.id}:${role.rev}`}
              role={role}
              onChange={onChange}
              onClose={onClose}
            />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

const sameSet = (a: ReadonlySet<Permission>, b: ReadonlySet<Permission>) =>
  a.size === b.size && [...a].every((p) => b.has(p));

function EditorForm({
  role,
  onChange,
  onClose,
}: {
  role: RoleDto;
  onChange: (role: RoleDto) => void;
  onClose: () => void;
}) {
  const t = useTranslations();
  const { access } = useSession();
  const roleName = useRoleName();
  const save = useUpdateRole(SAVE_ROLE_MESSAGES);
  const retire = useUpdateRole(RETIRE_ROLE_MESSAGES);
  const restore = useUpdateRole(SAVE_ROLE_MESSAGES);

  const readOnly = !role.active;
  const held = new Set<string>(access.permissions);
  const original = new Set<Permission>(role.permissions);
  const [name, setName] = useState(role.name);
  const [discount, setDiscount] = useState(String(role.limits.maxDiscountPct));
  const [permissions, setPermissions] = useState<ReadonlySet<Permission>>(original);
  const [error, setError] = useState<string | null>(null);

  const discountValue = discount.trim() === '' ? Number.NaN : Number(discount);
  const discountValid =
    Number.isFinite(discountValue) && discountValue >= 0 && discountValue <= 100;
  const nameValid = name.trim().length >= 1 && name.trim().length <= 60;
  const nameChanged = !role.isSystem && name.trim() !== role.name;
  const discountChanged = discountValid && discountValue !== role.limits.maxDiscountPct;
  const permissionsChanged = !sameSet(permissions, original);
  const changed = nameChanged || discountChanged || permissionsChanged;

  /** Run one update; on failure show the translated reason in the sheet (a conflict reloads and closes). */
  const run = async (
    mutation: typeof save,
    patch: {
      name?: string;
      permissions?: Permission[];
      limits?: { maxDiscountPct: number };
      active?: boolean;
    },
    overrides: ErrorMessageOverrides,
    done: string,
    closeAfter: boolean,
  ) => {
    setError(null);
    try {
      const updated = await mutation.mutateAsync({ id: role.id, rev: role.rev, ...patch });
      toast.success(t(done));
      if (closeAfter) onClose();
      else onChange(updated);
    } catch (cause) {
      if (isApiError(cause) && cause.code === 'VERSION_CONFLICT') {
        toast.error(t(errorMessageKey(cause, overrides)));
        onClose();
        return;
      }
      setError(t(isApiError(cause) ? errorMessageKey(cause, overrides) : 'Errors.INTERNAL'));
    }
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!changed || !nameValid || !discountValid) return;
    void run(
      save,
      {
        ...(nameChanged ? { name: name.trim() } : {}),
        ...(permissionsChanged ? { permissions: [...permissions] } : {}),
        ...(discountChanged ? { limits: { maxDiscountPct: discountValue } } : {}),
      },
      SAVE_ROLE_MESSAGES,
      'Roles.edit.saved',
      false,
    );
  };

  const busy = save.isPending || retire.isPending || restore.isPending;

  return (
    <form onSubmit={onSubmit} className="grid gap-5 px-4 pb-6" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert" data-testid="role-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <TextField
        label={t('Roles.edit.name')}
        value={role.isSystem ? roleName(role.name) : name}
        onChange={(event) => setName(event.target.value)}
        disabled={role.isSystem || readOnly}
        hint={role.isSystem ? t('Roles.edit.systemNameLocked') : undefined}
        autoComplete="off"
        maxLength={60}
      />
      <TextField
        label={t('Roles.edit.maxDiscount')}
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        step="0.5"
        value={discount}
        onChange={(event) => setDiscount(event.target.value)}
        disabled={readOnly}
        error={discountValid ? undefined : t('Validation.required')}
      />

      <fieldset className="grid gap-4" disabled={readOnly}>
        <legend className="text-sm font-medium">{t('Roles.edit.permissions')}</legend>
        {PERMISSION_GROUP_LIST.map(({ group, permissions: inGroup }) => (
          <div key={group} className="grid gap-2">
            <p className="text-muted-foreground text-xs font-medium uppercase">
              {t(`Roles.groups.${group}`)}
            </p>
            <ul className="grid gap-1.5">
              {inGroup.map((permission) => {
                const checked = permissions.has(permission);
                const needed = checked && isRequiredByManage(permissions, permission);
                // Anyone with role.manage may remove a permission; adding needs holding it yourself.
                const cannotGrant = !checked && !held.has(permission);
                const disabled = readOnly || needed || cannotGrant;
                const hintText = needed
                  ? t('Roles.edit.needsView')
                  : cannotGrant
                    ? t('Roles.edit.cannotGrant')
                    : null;
                return (
                  <li key={permission}>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-current"
                        checked={checked}
                        disabled={disabled}
                        data-permission={permission}
                        onChange={(event) =>
                          setPermissions((current) =>
                            togglePermission(current, permission, event.target.checked),
                          )
                        }
                      />
                      <span className="grid">
                        <span>{t(`Permissions.${permissionKey(permission)}`)}</span>
                        {hintText ? (
                          <span className="text-muted-foreground text-xs">{hintText}</span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </fieldset>

      {readOnly ? null : (
        <Button
          type="submit"
          size="lg"
          className="h-10 w-full"
          disabled={busy || !changed || !nameValid || !discountValid}
          aria-busy={save.isPending}
          data-testid="role-save"
        >
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t('Roles.edit.save')}
        </Button>
      )}

      {role.active ? (
        role.isSystem ? (
          <p className="text-muted-foreground text-xs">{t('Roles.edit.retireBlockedSystem')}</p>
        ) : (
          <div className="grid gap-2 border-t pt-4">
            <p className="text-muted-foreground text-xs">{t('Roles.edit.retireHint')}</p>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-10"
              disabled={busy}
              onClick={() =>
                void run(
                  retire,
                  { active: false },
                  RETIRE_ROLE_MESSAGES,
                  'Roles.edit.retired',
                  true,
                )
              }
              data-testid="role-retire"
            >
              {t('Roles.edit.retire')}
            </Button>
          </div>
        )
      ) : (
        <Button
          type="button"
          size="lg"
          className="h-10"
          disabled={busy}
          onClick={() =>
            void run(restore, { active: true }, SAVE_ROLE_MESSAGES, 'Roles.edit.restored', true)
          }
          data-testid="role-restore"
        >
          {t('Roles.edit.restore')}
        </Button>
      )}
    </form>
  );
}
