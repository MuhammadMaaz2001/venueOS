import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SignupForm } from '@/features/auth/signup-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Auth.signup'))('title') };
}

export default function SignupPage() {
  return <SignupForm />;
}
