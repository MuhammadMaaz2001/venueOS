import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { directionOf, type Locale } from '@/i18n/config';
import './globals.css';

export const metadata: Metadata = {
  title: 'venueOS',
  description: 'Booking and operations for event venues',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await getLocale()) as Locale;

  return (
    <html lang={locale} dir={directionOf(locale)}>
      <body className="bg-background text-foreground min-h-dvh antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
