import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ResetPasswordForm } from '@/features/auth/reset-password-form';

// A page with a one-time token in its link: never cached, never indexed.
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Auth.reset'))('title'), robots: { index: false } };
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={token ?? null} />;
}
