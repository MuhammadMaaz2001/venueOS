import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LeadDetail } from '@/features/leads/lead-detail';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Leads'))('title') };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LeadDetail id={id} />;
}
