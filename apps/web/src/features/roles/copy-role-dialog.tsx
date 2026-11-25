'use client';

import { CreateRoleSchema } from '@venueos/shared';
import type { RoleDto } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { SubmitButton, TextField } from '@/components/form-fields';
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
import { useZodResolver } from '@/lib/validation';
import { COPY_ROLE_MESSAGES, useCreateRole } from './api';
import { useRoleName } from './use-role-name';

const CopyFormSchema = CreateRoleSchema.pick({ name: true });
interface FormValues {
  name: string;
}

/** A new custom role starts as a copy of `source`; the roles page opens the editor on the copy afterwards. */
export function CopyRoleDialog({
  source,
  onClose,
  onCreated,
}: {
  source: RoleDto | null;
  onClose: () => void;
  onCreated: (role: RoleDto) => void;
}) {
  const t = useTranslations('Roles.copy');
  const roleName = useRoleName();
  return (
    <Dialog open={source !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {source ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('title', { name: roleName(source.name) })}</DialogTitle>
              <DialogDescription>{t('description')}</DialogDescription>
            </DialogHeader>
            <CopyForm key={source.id} source={source} onCreated={onCreated} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CopyForm({ source, onCreated }: { source: RoleDto; onCreated: (role: RoleDto) => void }) {
  const t = useTranslations();
  const create = useCreateRole();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: useZodResolver(CopyFormSchema),
    defaultValues: { name: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const role = await create.mutateAsync({ name: values.name, copyFromRoleId: source.id });
      toast.success(t('Roles.copy.created'));
      onCreated(role);
    } catch (cause) {
      setError(
        t(isApiError(cause) ? errorMessageKey(cause, COPY_ROLE_MESSAGES) : 'Errors.INTERNAL'),
      );
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      {error ? (
        <Alert variant="destructive" role="alert" data-testid="copy-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <TextField
        label={t('Roles.copy.name')}
        autoComplete="off"
        error={form.formState.errors.name?.message}
        {...form.register('name')}
      />
      <SubmitButton pending={create.isPending}>{t('Roles.copy.submit')}</SubmitButton>
    </form>
  );
}
