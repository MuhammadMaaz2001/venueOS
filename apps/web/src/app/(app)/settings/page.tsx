import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SettingsPage } from '@/features/setup/settings-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Setup.settings'))('title') };
}

export default function Page() {
  return <SettingsPage />;
}
