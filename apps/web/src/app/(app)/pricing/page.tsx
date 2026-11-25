import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PricingPage } from '@/features/pricing/pricing-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Pricing'))('title') };
}

export default function Page() {
  return <PricingPage />;
}
