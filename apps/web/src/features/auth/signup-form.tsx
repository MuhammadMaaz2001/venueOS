'use client';

import { SignupSchema } from '@venueos/shared';
import type { z } from 'zod';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useForm } from 'react-hook-form';
import { PasswordField, SelectField, SubmitButton, TextField } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { errorMessageKey } from '@/lib/api/error-messages';
import { isApiError } from '@/lib/api/errors';
import { serverFieldMessages, useZodResolver } from '@/lib/validation';
import { AuthCard, InboxNotice } from './auth-card';
import { useSignup } from './api';
import { COUNTRY_CODES, COUNTRY_DEFAULTS, CURRENCY_CODES, FALLBACK_TIME_ZONES } from './regions';

const subscribeNever = () => () => undefined;
let cachedZones: readonly string[] | null = null;

function browserTimeZones(): readonly string[] {
  if (!cachedZones) {
    try {
      const all = Intl.supportedValuesOf('timeZone');
      cachedZones =
        all.length === 0 ? FALLBACK_TIME_ZONES : all.includes('UTC') ? all : [...all, 'UTC'];
    } catch {
      cachedZones = FALLBACK_TIME_ZONES;
    }
  }
  return cachedZones;
}

const serverTimeZones = (): readonly string[] => FALLBACK_TIME_ZONES;

type FormValues = z.input<typeof SignupSchema>;

function displayNames(locale: string, type: 'region' | 'currency'): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type });
  } catch {
    return null;
  }
}

export function SignupForm() {
  const t = useTranslations();
  const tv = useTranslations('Validation');
  const locale = useLocale();
  const signup = useSignup();
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // The browser knows every time zone; the server render and hydration use the short list.
  const zones = useSyncExternalStore(subscribeNever, browserTimeZones, serverTimeZones);

  const countryNames = useMemo(() => displayNames(locale, 'region'), [locale]);
  const currencyNames = useMemo(() => displayNames(locale, 'currency'), [locale]);

  const form = useForm<FormValues, unknown, z.output<typeof SignupSchema>>({
    resolver: useZodResolver<FormValues, z.output<typeof SignupSchema>>(SignupSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      tenantName: '',
      country: 'PK',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      defaultLocale: locale === 'ur' ? 'ur' : 'en',
    },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signup.mutateAsync(values);
      setSentTo(values.email);
    } catch (error) {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        const messages = serverFieldMessages(tv, error);
        for (const [field, message] of Object.entries(messages)) {
          form.setError(field as keyof FormValues, { message });
        }
        return;
      }
      setFormError(t(isApiError(error) ? errorMessageKey(error) : 'Errors.INTERNAL'));
    }
  });

  if (sentTo) {
    return (
      <AuthCard title={t('Auth.signup.title')}>
        <InboxNotice title={t('Auth.inbox.title')} body={t('Auth.inbox.verify')} />
        <Link
          href="/login"
          className="text-primary text-center text-sm underline underline-offset-4 hover:no-underline"
        >
          {t('Auth.backToLogin')}
        </Link>
      </AuthCard>
    );
  }

  const onCountryChange = (code: string) => {
    const defaults = COUNTRY_DEFAULTS[code];
    if (defaults) {
      form.setValue('currency', defaults.currency, { shouldValidate: true });
      form.setValue('timezone', defaults.timezone, { shouldValidate: true });
    }
  };
  const countryField = form.register('country');

  return (
    <AuthCard
      title={t('Auth.signup.title')}
      description={t('Auth.signup.description')}
      footer={
        <>
          {t('Auth.signup.haveAccount')}{' '}
          <Link
            href="/login"
            className="text-primary font-medium underline underline-offset-4 hover:no-underline"
          >
            {t('Auth.signup.loginLink')}
          </Link>
        </>
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
        <TextField
          label={t('Auth.fields.email')}
          type="email"
          autoComplete="email"
          inputMode="email"
          isolate
          error={errors.email?.message}
          {...form.register('email')}
        />
        <PasswordField
          label={t('Auth.fields.newPassword')}
          autoComplete="new-password"
          hint={t('Auth.fields.passwordHint', { min: 10 })}
          error={errors.password?.message}
          {...form.register('password')}
        />
        <TextField
          label={t('Auth.fields.tenantName')}
          autoComplete="organization"
          hint={t('Auth.fields.tenantNameHint')}
          error={errors.tenantName?.message}
          {...form.register('tenantName')}
        />
        <SelectField
          label={t('Auth.fields.country')}
          autoComplete="country"
          error={errors.country?.message}
          {...countryField}
          onChange={(event) => {
            void countryField.onChange(event);
            onCountryChange(event.target.value);
          }}
        >
          {COUNTRY_CODES.map((code) => (
            <option key={code} value={code}>
              {countryNames?.of(code) ?? code}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('Auth.fields.currency')}
          error={errors.currency?.message}
          {...form.register('currency')}
        >
          {CURRENCY_CODES.map((code) => (
            <option key={code} value={code}>
              {code} · {currencyNames?.of(code) ?? code}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('Auth.fields.timezone')}
          error={errors.timezone?.message}
          {...form.register('timezone')}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('Auth.fields.workspaceLanguage')}
          hint={t('Auth.fields.workspaceLanguageHint')}
          error={errors.defaultLocale?.message}
          {...form.register('defaultLocale')}
        >
          <option value="en">English</option>
          <option value="ur">اردو</option>
        </SelectField>
        <SubmitButton pending={signup.isPending}>{t('Auth.signup.submit')}</SubmitButton>
      </form>
    </AuthCard>
  );
}
