'use client';

import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { EmailSchema, normalizePhone } from '@venueos/shared';
import type { CustomerDuplicateDto } from '@venueos/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useDebounced } from '@/lib/use-debounced';
import { useSession } from '../shell/session';
import { useCustomerDuplicates } from './api';

/**
 * "This looks like somebody you already have" (docs/05 section 12): a warning shown while a phone or email is
 * typed, with a link to each match, never a block. Once the phone or email is complete it asks the API, which
 * compares the normalised number and the lower-cased email. `onUse` (the inquiry form) lets the person pick the
 * existing customer instead of creating another.
 */
export function DuplicateWarning({
  phone,
  email,
  excludeId,
  onUse,
}: {
  phone: string;
  email: string;
  excludeId?: string | undefined;
  onUse?: ((customer: CustomerDuplicateDto) => void) | undefined;
}) {
  const t = useTranslations('Customers.duplicates');
  const { tenant } = useSession();
  const debouncedPhone = useDebounced(phone.trim());
  const debouncedEmail = useDebounced(email.trim());
  const phoneOk = debouncedPhone !== '' && normalizePhone(debouncedPhone, tenant.country).ok;
  const emailOk = debouncedEmail !== '' && EmailSchema.safeParse(debouncedEmail).success;
  const check = useCustomerDuplicates({
    phone: phoneOk ? debouncedPhone : '',
    email: emailOk ? debouncedEmail : '',
    excludeId,
    enabled: phoneOk || emailOk,
  });
  const matches = check.data?.data ?? [];
  if (matches.length === 0) return null;

  return (
    <Alert role="status" data-testid="duplicate-warning">
      <TriangleAlert aria-hidden />
      <AlertTitle>{t('title', { count: matches.length })}</AlertTitle>
      <AlertDescription>
        <p>{t('description')}</p>
        <ul className="mt-2 grid gap-2">
          {matches.map((match) => (
            <li key={match.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Link
                href={`/customers/${match.id}`}
                target="_blank"
                className="font-medium underline"
                data-testid="duplicate-link"
              >
                {match.name}
              </Link>
              <span className="ltr-isolate text-xs">{match.phone}</span>
              <span className="text-xs">
                {match.matchedOn.map((m) => t(`matched.${m}`)).join(', ')}
              </span>
              {onUse ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onUse(match)}
                  data-testid="duplicate-use"
                >
                  {t('use')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
