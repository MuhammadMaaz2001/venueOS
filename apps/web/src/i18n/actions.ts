'use server';

import { cookies } from 'next/headers';
import { LOCALE_COOKIE, isLocale } from './config';

/** Remember the language in a cookie (one year). The caller refreshes the page to render in it. */
export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: false,
  });
}
