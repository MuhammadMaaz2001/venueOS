import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BookingsPage } from '@/features/bookings/bookings-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Bookings.list'))('title') };
}

export default function Page() {
  return <BookingsPage />;
}
