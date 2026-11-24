'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import type { StaffMemberDto } from '@venueos/shared';
import { CheckboxField, SelectField, SubmitButton } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { errorMessageKey } from '@/lib/api/error-messages';
import { isApiError } from '@/lib/api/errors';
import { UPDATE_MEMBER_MESSAGES, useAssignableRoles, useUpdateStaff } from './api';

/**
 * Change a member's role or active status. The request carries the `rev` the user saw: if someone else changed
 * the member meanwhile (409), the list reloads and the dialog closes with a message. The last-Owner rule (422)
 * stays in the dialog as a message the user cannot miss. Venue scope is shown on the page but edited once the
 * venues module exists (there is nothing to choose from yet).
 */
export function EditMemberDialog({
  member,
  onClose,
}: {
  member: StaffMemberDto | null;
  onClose: () => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={member !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {member ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('Staff.edit.title', { name: member.name })}</DialogTitle>
              <DialogDescription>{t('Staff.edit.description')}</DialogDescription>
            </DialogHeader>
            {/* Keyed: a different member (or a newer version of the same one) starts a fresh form. */}
            <EditForm
              key={`${member.membershipId}:${member.rev}`}
              member={member}
              onClose={onClose}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ member, onClose }: { member: StaffMemberDto; onClose: () => void }) {
  const t = useTranslations();
  const roles = useAssignableRoles();
  const update = useUpdateStaff();
  const [roleId, setRoleId] = useState(member.roleId);
  const [active, setActive] = useState(member.active);
  const [error, setError] = useState<string | null>(null);

  const roleOptions = roles.data?.data ?? [];
  // The member's current role stays selectable even if it is not one the caller could assign.
  const withCurrent = roleOptions.some((role) => role.id === member.roleId)
    ? roleOptions
    : [{ id: member.roleId, name: member.roleName }, ...roleOptions];
  const changed = roleId !== member.roleId || active !== member.active;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!changed) {
      onClose();
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({
        membershipId: member.membershipId,
        rev: member.rev,
        ...(roleId !== member.roleId ? { roleId } : {}),
        ...(active !== member.active ? { active } : {}),
      });
      toast.success(t('Staff.edit.saved'));
      onClose();
    } catch (cause) {
      if (isApiError(cause) && cause.code === 'VERSION_CONFLICT') {
        // The list is reloading (see useUpdateStaff); the user sees the current state and decides again.
        toast.error(t(errorMessageKey(cause, UPDATE_MEMBER_MESSAGES)));
        onClose();
        return;
      }
      setError(
        t(isApiError(cause) ? errorMessageKey(cause, UPDATE_MEMBER_MESSAGES) : 'Errors.INTERNAL'),
      );
    }
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      {error ? (
        <Alert variant="destructive" role="alert" data-testid="edit-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <SelectField
        label={t('Staff.edit.role')}
        value={roleId}
        onChange={(event) => setRoleId(event.target.value)}
        disabled={roles.isPending}
      >
        {withCurrent.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </SelectField>
      <CheckboxField
        label={t('Staff.edit.active')}
        checked={active}
        onChange={(event) => setActive(event.target.checked)}
      />
      <SubmitButton pending={update.isPending}>{t('Staff.edit.save')}</SubmitButton>
    </form>
  );
}
