'use client';

import { PasswordSchema } from '@venueos/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PasswordField, SubmitButton } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { errorMessageKey } from '@/lib/api/error-messages';
import { isApiError } from '@/lib/api/errors';
import { forgetSubmission, submissionKey, submitOnce } from '@/lib/submit-once';
import { cn } from '@/lib/utils';
import { issueText, serverFieldMessages } from '@/lib/validation';
import { AuthCard } from './auth-card';
import { resetPasswordRequest } from './api';
import { useStripTokenFromUrl, validToken } from './token';

interface FormValues {
  newPassword: string;
  confirm: string;
}

/** `/reset-password?token=`: choose a new password; the token is sent once and ends every session. */
export function ResetPasswordForm({ token: rawToken }: { token: string | null }) {
  const t = useTranslations();
  const tv = useTranslations('Validation');
  const token = validToken(rawToken);
  useStripTokenFromUrl();
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const schema = useMemo(
    () =>
      z
        .object({ newPassword: PasswordSchema, confirm: z.string() })
        .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'mismatch' }),
    [],
  );
  const form = useForm<FormValues>({
    resolver: zodResolver(schema, { error: (issue) => issueText(tv, issue) }),
    defaultValues: { newPassword: '', confirm: '' },
  });
  const errors = form.formState.errors;

  if (!token) {
    return (
      <AuthCard title={t('Auth.reset.title')}>
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('Auth.token.invalid')}</AlertDescription>
        </Alert>
        <Link href="/forgot-password" className={cn(buttonVariants({ size: 'lg' }), 'h-10 w-full')}>
          {t('Auth.reset.newLink')}
        </Link>
      </AuthCard>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    setPending(true);
    const key = submissionKey('reset-password', token);
    try {
      // One request per token at a time (a double click or a double submit reuses the first call).
      await submitOnce(key, () => resetPasswordRequest({ token, newPassword: values.newPassword }));
      setDone(true);
    } catch (error) {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        // The password was refused (too common): the token is NOT used up, the user may try another one.
        forgetSubmission(key);
        for (const [field, message] of Object.entries(serverFieldMessages(tv, error))) {
          if (field === 'newPassword') form.setError('newPassword', { message });
          else setFormError(message);
        }
      } else if (isApiError(error) && error.code === 'BAD_REQUEST') {
        // Invalid, expired or already used: nothing to retry with this link.
        setFormError(t('Auth.token.invalid'));
      } else {
        forgetSubmission(key);
        setFormError(t(isApiError(error) ? errorMessageKey(error) : 'Errors.INTERNAL'));
      }
    } finally {
      setPending(false);
    }
  });

  if (done) {
    return (
      <AuthCard title={t('Auth.reset.doneTitle')}>
        <div role="status" className="grid justify-items-center gap-3 py-4 text-center">
          <CheckCircle2 className="text-primary size-10" aria-hidden />
          <p className="text-sm">{t('Auth.reset.doneBody')}</p>
        </div>
        <Link href="/login" className={cn(buttonVariants({ size: 'lg' }), 'h-10 w-full')}>
          {t('Auth.verify.toLogin')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('Auth.reset.title')} description={t('Auth.reset.description')}>
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        {formError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        <PasswordField
          label={t('Auth.fields.newPassword')}
          autoComplete="new-password"
          hint={t('Auth.fields.passwordHint', { min: 10 })}
          error={errors.newPassword?.message}
          {...form.register('newPassword')}
        />
        <PasswordField
          label={t('Auth.fields.confirmPassword')}
          autoComplete="new-password"
          error={
            errors.confirm?.message === 'mismatch'
              ? t('Validation.mismatch')
              : errors.confirm?.message
          }
          {...form.register('confirm')}
        />
        <SubmitButton pending={pending}>{t('Auth.reset.submit')}</SubmitButton>
      </form>
    </AuthCard>
  );
}
