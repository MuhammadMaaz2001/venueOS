import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuditPage } from '@/features/audit/audit-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Audit'))('title') };
}

export default function Page() {
  return <AuditPage />;
}
