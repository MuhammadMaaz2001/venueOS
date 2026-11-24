import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { SelectWorkspace } from '@/features/auth/select-workspace';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('Auth.workspace'))('title') };
}

export default async function SelectWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <SelectWorkspace next={next} />;
}
