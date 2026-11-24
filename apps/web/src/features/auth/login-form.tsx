'use client';

import { EMAIL_NOT_VERIFIED_REASON, LoginSchema } from '@venueos/shared';
import type { LoginInput } from '@venueos/shared';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { PasswordField, SubmitButton, TextField } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessageKey } from '@/lib/api/error-messages';
import { isApiError } from '@/lib/api/errors';
import { safeNextPath } from '@/lib/safe-next';
import { useZodResolver } from '@/lib/validation';
import { AuthCard, InboxNotice } from './auth-card';
import { loginDestination } from './login-destination';
import { useLogin, useResendVerification } from './api';

export function LoginForm({
  next,
  reason,
}: {
  next?: string | undefined;
  reason?: string | undefined;
}) {
  const t = useTranslations();
  const router = useRouter();
  const login = useLogin();
  const resend = useResendVerification();
  const [formError, setFormError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const target = safeNextPath(next);

  const form = useForm<LoginInput>({
    resolver: useZodResolver(LoginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const result = await login.mutateAsync(values);
      router.replace(loginDestination(result, target));
    } catch (error) {
      if (
        isApiError(error) &&
        error.code === 'FORBIDDEN' &&
        error.reason === EMAIL_NOT_VERIFIED_REASON
      ) {
        setUnverifiedEmail(values.email);
      } else if (isApiError(error) && error.code === 'UNAUTHENTICATED') {
        // One message for an unknown address, a wrong password and a locked account (no enumeration).
        setFormError(t('Auth.login.invalidCredentials'));
      } else {
        setFormError(t(isApiError(error) ? errorMessageKey(error) : 'Errors.INTERNAL'));
      }
    }
  });

  if (unverifiedEmail) {
    return (
      <AuthCard title={t('Auth.login.unverifiedTitle')}>
        {resent ? (
          <InboxNotice title={t('Auth.inbox.title')} body={t('Auth.inbox.verify')} />
        ) : (
          <>
            <p className="text-sm">{t('Auth.login.unverifiedBody', { email: unverifiedEmail })}</p>
            <Button
              type="button"
              size="lg"
              className="h-10 w-full"
              disabled={resend.isPending}
              onClick={() => resend.mutate(unverifiedEmail, { onSuccess: () => setResent(true) })}
            >
              {t('Auth.login.resend')}
            </Button>
            {resend.isError ? (
              <p role="alert" className="text-destructive text-sm">
                {t(isApiError(resend.error) ? errorMessageKey(resend.error) : 'Errors.INTERNAL')}
              </p>
            ) : null}
          </>
        )}
        <Button type="button" variant="ghost" onClick={() => setUnverifiedEmail(null)}>
          {t('Common.back')}
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('Auth.login.title')}
      description={t('Auth.login.description')}
      footer={
        <>
          {t('Auth.login.noAccount')}{' '}
          <Link
            href="/signup"
            className="text-primary font-medium underline underline-offset-4 hover:no-underline"
          >
            {t('Auth.login.signupLink')}
          </Link>
        </>
      }
    >
      {reason === 'expired' ? (
        <Alert>
          <AlertDescription>{t('Auth.login.sessionExpired')}</AlertDescription>
        </Alert>
      ) : null}
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
        <PasswordField
          label={t('Auth.fields.password')}
          autoComplete="current-password"
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />
        <div className="-mt-2 text-end text-sm">
          <Link
            href="/forgot-password"
            className="text-primary underline underline-offset-4 hover:no-underline"
          >
            {t('Auth.login.forgot')}
          </Link>
        </div>
        <SubmitButton pending={login.isPending}>{t('Auth.login.submit')}</SubmitButton>
      </form>
    </AuthCard>
  );
}
