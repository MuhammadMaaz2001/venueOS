import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CalendarPage } from '@/features/bookings/calendar-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Bookings.calendar'))('title') };
}

export default function Page() {
  return <CalendarPage />;
}
