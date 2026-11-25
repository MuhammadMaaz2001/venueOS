'use client';

import { CreateInvitationSchema } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { SelectField, SubmitButton, TextField } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useZodResolver } from '@/lib/validation';
import { useSession } from '../shell/session';
import { useRoleName } from '../roles/use-role-name';
import { useAssignableRoles, useInviteStaff } from './api';
import { inviteVenueScope } from './venue-scope';
import { VenueScopePicker } from './venue-scope-picker';

const InviteFormSchema = CreateInvitationSchema.pick({ email: true, roleId: true });

interface FormValues {
  email: string;
  roleId: string;
}

/**
 * Invite someone by email with a role the inviter may give. The venue scope is NOT chosen here: the invitation
 * carries the inviter's own scope (all venues only for someone who has all venues), see `inviteVenueScope`.
 */
export function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('Staff.invite');
  const { access } = useSession();
  const roles = useAssignableRoles(open);
  const roleName = useRoleName();
  const invite = useInviteStaff();
  const form = useForm<FormValues>({
    resolver: useZodResolver(InviteFormSchema),
    defaultValues: { email: '', roleId: '' },
  });
  const errors = form.formState.errors;
  // What the picker says; `undefined` until it is used (or when it is not available): the inviter's own scope.
  const [picked, setPicked] = useState<string[] | null | undefined>(undefined);
  const scope = picked ?? inviteVenueScope(access.venueIds);
  const scopeInvalid = picked === null;

  const close = (next: boolean) => {
    if (!next) {
      form.reset();
      invite.reset();
      setPicked(undefined);
    }
    onOpenChange(next);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await invite.mutateAsync({ ...values, venueIds: scope });
      toast.success(t('sent', { email: values.email }));
      close(false);
    } catch {
      // The global handler already showed the translated reason (duplicate, plan limit, no access).
    }
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <TextField
            label={t('email')}
            type="email"
            autoComplete="off"
            inputMode="email"
            isolate
            error={errors.email?.message}
            {...form.register('email')}
          />
          <SelectField
            label={t('role')}
            error={errors.roleId ? t('chooseRole') : undefined}
            disabled={roles.isPending}
            {...form.register('roleId')}
          >
            <option value="">{t('rolePlaceholder')}</option>
            {roles.data?.data.map((role) => (
              <option key={role.id} value={role.id}>
                {roleName(role.name)}
              </option>
            ))}
          </SelectField>
          <VenueScopePicker value={inviteVenueScope(access.venueIds)} onChange={setPicked} />
          {picked === undefined ? (
            <p className="text-muted-foreground text-xs">
              {scope.length === 0 ? t('scopeAll') : t('scopeOwn', { count: scope.length })}
            </p>
          ) : null}
          {roles.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t('rolesFailed')}</AlertDescription>
            </Alert>
          ) : null}
          <SubmitButton pending={invite.isPending} disabled={scopeInvalid}>
            {t('submit')}
          </SubmitButton>
        </form>
      </DialogContent>
    </Dialog>
  );
}
