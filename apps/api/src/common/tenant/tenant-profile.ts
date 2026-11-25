import type { DbTx } from '@venueos/db';
import { NotFoundError } from '../errors/domain-errors';

/** What a service needs to know about the workspace to interpret input and format output. */
export interface TenantProfile {
  name: string;
  /** ISO 3166-1 alpha-2: phone numbers without a country code are read with it. */
  country: string;
  currency: string;
  /** IANA zone: "today" and the times in emails. */
  timezone: string;
  defaultLocale: string;
}

export async function tenantProfile(tx: DbTx, tenantId: string): Promise<TenantProfile> {
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: { name: true, country: true, currency: true, timezone: true, defaultLocale: true },
  });
  if (!tenant) throw new NotFoundError();
  return tenant;
}
