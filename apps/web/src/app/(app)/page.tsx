import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Dashboard } from '@/features/shell/dashboard';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Dashboard'))('title') };
}

export default function DashboardPage() {
  return <Dashboard />;
}
