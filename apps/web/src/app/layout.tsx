import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { Toaster } from '@/components/ui/sonner';
import { directionOf, type Locale } from '@/i18n/config';
import { QueryProvider } from '@/lib/api/query-provider';
import { latinFont } from './fonts';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Meta');
  return {
    title: { default: t('title'), template: `%s · ${t('title')}` },
    description: t('description'),
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const dir = directionOf(locale);

  return (
    <html lang={locale} dir={dir} className={latinFont.variable}>
      <body className="bg-background text-foreground min-h-dvh antialiased">
        <NextIntlClientProvider>
          <QueryProvider>
            {children}
            <Toaster dir={dir} position="top-center" richColors closeButton />
          </QueryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
