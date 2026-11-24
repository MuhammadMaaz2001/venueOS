import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { VenuesPage } from '@/features/setup/venues-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Setup.venues'))('title') };
}

export default function Page() {
  return <VenuesPage />;
}
