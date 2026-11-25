import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CustomersPage } from '@/features/customers/customers-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Customers'))('title') };
}

export default function Page() {
  return <CustomersPage />;
}
