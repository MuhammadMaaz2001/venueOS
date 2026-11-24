'use client';

import { EmailOnlySchema } from '@venueos/shared';
import type { EmailOnlyInput } from '@venueos/shared';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { SubmitButton, TextField } from '@/components/form-fields';
import { buttonVariants } from '@/components/ui/button';
import { errorMessageKey } from '@/lib/api/error-messages';
import { isApiError } from '@/lib/api/errors';
import { useTokenAction } from '@/lib/submit-once';
import { cn } from '@/lib/utils';
import { useZodResolver } from '@/lib/validation';
import { AuthCard, InboxNotice } from './auth-card';
import { useResendVerification, verifyEmailRequest } from './api';
import { useStripTokenFromUrl, validToken } from './token';

/** `/verify-email?token=`: confirms the address once, then offers the login (or a new link when it failed). */
export function VerifyEmail({ token: rawToken }: { token: string | null }) {
  const t = useTranslations();
  const token = validToken(rawToken);
  useStripTokenFromUrl();
  // Exactly one POST per token, also under StrictMode's double effects (see lib/submit-once.ts).
  const state = useTokenAction('verify-email', token, verifyEmailRequest);

  if (token && state.status === 'pending') {
    return (
      <AuthCard title={t('Auth.verify.title')}>
        <p
          role="status"
          className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('Auth.verify.working')}
        </p>
      </AuthCard>
    );
  }

  if (token && state.status === 'success') {
    return (
      <AuthCard title={t('Auth.verify.doneTitle')}>
        <div role="status" className="grid justify-items-center gap-3 py-4 text-center">
          <CheckCircle2 className="text-primary size-10" aria-hidden />
          <p className="text-sm">{t('Auth.verify.doneBody')}</p>
        </div>
        <Link href="/login" className={cn(buttonVariants({ size: 'lg' }), 'h-10 w-full')}>
          {t('Auth.verify.toLogin')}
        </Link>
      </AuthCard>
    );
  }

  // A missing, malformed, used or expired link: the API says only "invalid or expired" for all of them.
  const networkProblem =
    state.status === 'error' && isApiError(state.error) && state.error.code !== 'BAD_REQUEST';
  return (
    <AuthCard title={t('Auth.verify.failedTitle')}>
      <div role="alert" className="grid justify-items-center gap-3 py-2 text-center">
        <XCircle className="text-destructive size-10" aria-hidden />
        <p className="text-sm">
          {networkProblem && state.status === 'error' && isApiError(state.error)
            ? t(errorMessageKey(state.error))
            : t('Auth.token.invalid')}
        </p>
      </div>
      <ResendVerification />
    </AuthCard>
  );
}

function ResendVerification() {
  const t = useTranslations();
  const resend = useResendVerification();
  const [sent, setSent] = useState(false);
  const form = useForm<EmailOnlyInput>({
    resolver: useZodResolver(EmailOnlySchema),
    defaultValues: { email: '' },
  });

  if (sent) return <InboxNotice title={t('Auth.inbox.title')} body={t('Auth.inbox.verify')} />;

  const onSubmit = form.handleSubmit(async ({ email }) => {
    try {
      await resend.mutateAsync(email);
      setSent(true);
    } catch {
      form.setError('email', { message: t('Errors.INTERNAL') });
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-3">
      <p className="text-muted-foreground text-sm">{t('Auth.verify.resendHint')}</p>
      <TextField
        label={t('Auth.fields.email')}
        type="email"
        autoComplete="email"
        inputMode="email"
        isolate
        error={form.formState.errors.email?.message}
        {...form.register('email')}
      />
      <SubmitButton pending={resend.isPending}>{t('Auth.verify.resend')}</SubmitButton>
    </form>
  );
}
