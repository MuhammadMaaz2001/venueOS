import { getTranslations } from 'next-intl/server';

export default async function HomePage() {
  const t = await getTranslations('Home');

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="text-lg">{t('tagline')}</p>
      <p className="text-muted-foreground text-sm">{t('status')}</p>
    </main>
  );
}
