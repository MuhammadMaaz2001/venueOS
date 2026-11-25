import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CustomerDetail } from '@/features/customers/customer-detail';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Customers'))('title') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerDetail id={id} />;
}
