'use client';

import { AcceptInvitationNewUserSchema, PasswordSchema } from '@venueos/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PasswordField, SubmitButton, TextField } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { errorMessageKey } from '@/lib/api/error-messages';
import { isApiError } from '@/lib/api/errors';
import { forgetSubmission, submissionKey, submitOnce } from '@/lib/submit-once';
import { cn } from '@/lib/utils';
import { issueText, serverFieldMessages } from '@/lib/validation';
import { useAcceptInvitationAsMember, useMe, useSwitchTenant } from '../me/api';
import { AuthCard } from './auth-card';
import { acceptInvitationRequest } from './api';
import {
  clearPendingInvite,
  peekPendingInvite,
  rememberPendingInvite,
  useStripTokenFromUrl,
  validToken,
} from './token';

interface FormValues {
  name: string;
  password: string;
}

/**
 * `/accept-invite?token=`. Two people use this page:
 *  - a NEW person chooses a name and password (`POST /v1/auth/invitations/accept`);
 *  - someone who already has an account signs in and accepts with it (`POST /v1/me/invitations/accept`).
 * The API tells the two apart: an address that has an account answers 409, which sends the user to sign in.
 * While they sign in the token waits in this tab's sessionStorage, so it never travels in a login URL.
 */
export function AcceptInvite({ token: rawToken }: { token: string | null }) {
  const t = useTranslations();
  // The token comes from the link, or from before the login redirect.
  const [token] = useState<string | null>(() => validToken(rawToken));
  useStripTokenFromUrl();

  // sessionStorage exists only in the browser: the server render and hydration see "not read yet".
  const resumed = useSyncExternalStore(subscribeNever, peekPendingInvite, () => null);
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  const active = token ?? resumed;
  const me = useMe({ anonymousOk: true });

  if (!hydrated) return <LoadingCard />;

  if (!active) {
    return (
      <AuthCard title={t('Auth.invite.title')}>
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('Auth.invite.invalid')}</AlertDescription>
        </Alert>
        <Link href="/login" className={cn(buttonVariants({ size: 'lg' }), 'h-10 w-full')}>
          {t('Auth.backToLogin')}
        </Link>
      </AuthCard>
    );
  }

  if (me.isPending) return <LoadingCard />;

  // Logged in: accept with this account (a click, because it may not be the account the invitation is for).
  if (me.data) return <AcceptAsMember token={active} email={me.data.user.email} />;

  return <AcceptAsNewUser token={active} />;
}

const subscribeNever = () => () => undefined;

function LoadingCard() {
  const t = useTranslations();
  return (
    <AuthCard title={t('Auth.invite.title')}>
      <p
        role="status"
        className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('Common.loading')}
      </p>
    </AuthCard>
  );
}

function AcceptAsNewUser({ token }: { token: string }) {
  const t = useTranslations();
  const tv = useTranslations('Validation');
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [existing, setExisting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const schema = useMemo(
    () => z.object({ name: AcceptInvitationNewUserSchema.shape.name, password: PasswordSchema }),
    [],
  );
  const form = useForm<FormValues>({
    resolver: zodResolver(schema, { error: (issue) => issueText(tv, issue) }),
    defaultValues: { name: '', password: '' },
  });
  const errors = form.formState.errors;

  const signInInstead = () => {
    rememberPendingInvite(token);
    router.push('/login?next=%2Faccept-invite');
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    setPending(true);
    const key = submissionKey('accept-invite', token);
    try {
      await submitOnce(key, () => acceptInvitationRequest({ token, ...values }));
      setDone(true);
    } catch (error) {
      if (isApiError(error) && error.code === 'DUPLICATE') {
        // The address already has an account: it accepts while logged in (the token is not used up).
        forgetSubmission(key);
        setExisting(true);
      } else if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        forgetSubmission(key);
        for (const [field, message] of Object.entries(serverFieldMessages(tv, error))) {
          if (field === 'password' || field === 'name') form.setError(field, { message });
          else setFormError(message);
        }
      } else if (isApiError(error) && error.code === 'BAD_REQUEST') {
        setFormError(t('Auth.invite.invalid'));
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
      <AuthCard title={t('Auth.invite.doneTitle')}>
        <div role="status" className="grid justify-items-center gap-3 py-4 text-center">
          <CheckCircle2 className="text-primary size-10" aria-hidden />
          <p className="text-sm">{t('Auth.invite.doneBody')}</p>
        </div>
        <Link href="/login" className={cn(buttonVariants({ size: 'lg' }), 'h-10 w-full')}>
          {t('Auth.verify.toLogin')}
        </Link>
      </AuthCard>
    );
  }

  if (existing) {
    return (
      <AuthCard title={t('Auth.invite.existingTitle')}>
        <p className="text-sm">{t('Auth.invite.existingBody')}</p>
        <Button type="button" size="lg" className="h-10 w-full" onClick={signInInstead}>
          {t('Auth.invite.signIn')}
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('Auth.invite.title')}
      description={t('Auth.invite.description')}
      footer={
        <button
          type="button"
          onClick={signInInstead}
          className="text-primary font-medium underline underline-offset-4 hover:no-underline"
        >
          {t('Auth.invite.haveAccount')}
        </button>
      }
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        {formError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        <TextField
          label={t('Auth.fields.name')}
          autoComplete="name"
          error={errors.name?.message}
          {...form.register('name')}
        />
        <PasswordField
          label={t('Auth.fields.newPassword')}
          autoComplete="new-password"
          hint={t('Auth.fields.passwordHint', { min: 10 })}
          error={errors.password?.message}
          {...form.register('password')}
        />
        <SubmitButton pending={pending}>{t('Auth.invite.submit')}</SubmitButton>
      </form>
    </AuthCard>
  );
}

function AcceptAsMember({ token, email }: { token: string; email: string | null }) {
  const t = useTranslations();
  const router = useRouter();
  const accept = useAcceptInvitationAsMember();
  const switchTenant = useSwitchTenant();
  const [error, setError] = useState<string | null>(null);

  const onAccept = async () => {
    setError(null);
    const key = submissionKey('accept-invite-member', token);
    try {
      const { tenantId } = await submitOnce(key, () => accept.mutateAsync(token));
      clearPendingInvite();
      await switchTenant.mutateAsync(tenantId);
      router.replace('/');
    } catch (cause) {
      forgetSubmission(key);
      // 400 = invalid, expired, used, or for another address.
      setError(
        isApiError(cause) && cause.code === 'BAD_REQUEST'
          ? t('Auth.invite.wrongAccount')
          : t(isApiError(cause) ? errorMessageKey(cause) : 'Errors.INTERNAL'),
      );
    }
  };

  return (
    <AuthCard
      title={t('Auth.invite.memberTitle')}
      description={t('Auth.invite.memberBody', { email: email ?? '' })}
    >
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        type="button"
        size="lg"
        className="h-10 w-full"
        disabled={accept.isPending || switchTenant.isPending}
        onClick={onAccept}
      >
        {t('Auth.invite.accept')}
      </Button>
    </AuthCard>
  );
}
