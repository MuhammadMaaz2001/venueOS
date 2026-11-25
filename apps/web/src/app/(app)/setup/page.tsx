import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SetupWizard } from '@/features/setup/wizard';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Setup.wizard'))('title') };
}

export default function Page() {
  return <SetupWizard />;
}
