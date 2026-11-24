'use client';

import { Languages } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { LOCALES, LOCALE_NAMES, isLocale } from '@/i18n/config';
import type { Locale } from '@/i18n/config';
import { setLocale } from '@/i18n/actions';

/** Switch between English and Urdu (a cookie, no URL change) and re-render the page in the new language. */
export function useChangeLocale() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const change = (locale: Locale) =>
    startTransition(async () => {
      await setLocale(locale);
      router.refresh();
    });
  return { change, pending };
}

/** A compact button for the pages without a user menu (login, signup, ...): shows the OTHER language. */
export function LanguageSwitcher() {
  const t = useTranslations('Common');
  const current = useLocale();
  const { change, pending } = useChangeLocale();
  const other = LOCALES.find((l) => l !== current) ?? 'en';
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => isLocale(other) && change(other)}
      aria-label={t('changeLanguage')}
      lang={other}
    >
      <Languages aria-hidden />
      {LOCALE_NAMES[other]}
    </Button>
  );
}
