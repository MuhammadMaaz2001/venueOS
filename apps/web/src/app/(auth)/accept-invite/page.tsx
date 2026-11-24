import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AcceptInvite } from '@/features/auth/accept-invite';

// A page with a one-time token in its link: never cached, never indexed.
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Auth.invite'))('title'), robots: { index: false } };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <AcceptInvite token={token ?? null} />;
}
