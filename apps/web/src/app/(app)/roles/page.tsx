import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RolesPage } from '@/features/roles/roles-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Roles'))('title') };
}

export default function Page() {
  return <RolesPage />;
}
