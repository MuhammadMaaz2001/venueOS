import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ForgotPasswordForm } from '@/features/auth/forgot-password-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Auth.forgot'))('title') };
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
