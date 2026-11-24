import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LoginForm } from '@/features/auth/login-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Auth.login'))('title') };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const { next, reason } = await searchParams;
  return <LoginForm next={next} reason={reason} />;
}
