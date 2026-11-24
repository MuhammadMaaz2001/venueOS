import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { VerifyEmail } from '@/features/auth/verify-email';

// A page with a one-time token in its link: never cached, never indexed.
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Auth.verify'))('title'), robots: { index: false } };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <VerifyEmail token={token ?? null} />;
}
