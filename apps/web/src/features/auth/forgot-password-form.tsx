'use client';

import { EmailOnlySchema } from '@venueos/shared';
import type { EmailOnlyInput } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { SubmitButton, TextField } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { errorMessageKey } from '@/lib/api/error-messages';
import { isApiError } from '@/lib/api/errors';
import { useZodResolver } from '@/lib/validation';
import { AuthCard, InboxNotice } from './auth-card';
import { useForgotPassword } from './api';

export function ForgotPasswordForm() {
  const t = useTranslations();
  const forgot = useForgotPassword();
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<EmailOnlyInput>({
    resolver: useZodResolver(EmailOnlySchema),
    defaultValues: { email: '' },
  });

  const onSubmit = form.handleSubmit(async ({ email }) => {
    setFormError(null);
    try {
      await forgot.mutateAsync(email);
      // The same screen whether or not the address has an account.
      setSent(true);
    } catch (error) {
      setFormError(t(isApiError(error) ? errorMessageKey(error) : 'Errors.INTERNAL'));
    }
  });

  return (
    <AuthCard
      title={t('Auth.forgot.title')}
      description={sent ? undefined : t('Auth.forgot.description')}
      footer={
        <Link
          href="/login"
          className="text-primary font-medium underline underline-offset-4 hover:no-underline"
        >
          {t('Auth.backToLogin')}
        </Link>
      }
    >
      {sent ? (
        <InboxNotice title={t('Auth.inbox.title')} body={t('Auth.inbox.reset')} />
      ) : (
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          {formError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
          <TextField
            label={t('Auth.fields.email')}
            type="email"
            autoComplete="email"
            inputMode="email"
            isolate
            error={form.formState.errors.email?.message}
            {...form.register('email')}
          />
          <SubmitButton pending={forgot.isPending}>{t('Auth.forgot.submit')}</SubmitButton>
        </form>
      )}
    </AuthCard>
  );
}
