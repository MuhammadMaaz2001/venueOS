import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { RefundsPage } from '@/features/payments/refunds-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Payments.refundQueue'))('title') };
}

export default function Page() {
  return <RefundsPage />;
}
