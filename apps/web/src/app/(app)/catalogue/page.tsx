import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CataloguePage } from '@/features/catalogue/catalogue-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Catalogue'))('title') };
}

export default function Page() {
  return <CataloguePage />;
}
