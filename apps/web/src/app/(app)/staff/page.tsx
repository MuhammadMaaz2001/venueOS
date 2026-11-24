import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { StaffPage } from '@/features/staff/staff-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Staff'))('title') };
}

export default function Page() {
  return <StaffPage />;
}
