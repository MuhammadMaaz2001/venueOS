import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ReceivablesPage } from '@/features/payments/receivables-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Payments.receivables'))('title') };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ overdue?: string }>;
}) {
  const { overdue } = await searchParams;
  return <ReceivablesPage initialOverdue={overdue === 'true'} />;
}
