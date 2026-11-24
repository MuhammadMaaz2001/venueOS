import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';

/** The frame of the pages that need no login: a narrow centred column, readable at 360 px. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('Meta');
  return (
    <div className="bg-muted/40 flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 py-3">
        <span className="text-lg font-bold tracking-tight">{t('title')}</span>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-10">
        {children}
      </main>
    </div>
  );
}
