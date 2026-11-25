import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../context/request-context';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../errors/domain-errors';

/**
 * Venue scoping (docs/04-security.md section 2): a membership with `venueIds` may only touch those
 * venues; an empty list means all venues of the tenant. Services use this instead of trusting a
 * `venueId` they received from the client.
 */
@Injectable()
export class VenueScope {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  private get venueIds(): readonly string[] {
    const access = this.cls.get('access');
    if (!access) throw new UnauthenticatedError();
    return access.venueIds;
  }

  /** True when the caller may see every venue of the tenant. */
  get unrestricted(): boolean {
    return this.venueIds.length === 0;
  }

  /** Tenant-wide data (catalogue, tax rates, ...) can only be changed by someone with access to all venues. */
  assertTenantWide(message: string): void {
    if (!this.unrestricted) throw new ForbiddenError(message);
  }

  /** One venue the caller names (path/body). Outside their scope -> 404, never 403. */
  assertAccess(venueId: string): void {
    if (!this.unrestricted && !this.venueIds.includes(venueId)) throw new NotFoundError();
  }

  /**
   * Venue filter for a list query. `requested` is whatever the client asked for (a `venueId` query
   * param); it only narrows, it never widens. Returns `undefined` when no venue filter is needed
   * (unrestricted caller, nothing requested); otherwise the venue ids to filter by, possibly empty
   * (the caller asked for venues they cannot see: the list is empty, not an error).
   */
  filterIds(requested?: readonly string[]): string[] | undefined {
    if (this.unrestricted) return requested && requested.length > 0 ? [...requested] : undefined;
    const allowed = this.venueIds;
    return requested && requested.length > 0
      ? requested.filter((id) => allowed.includes(id))
      : [...allowed];
  }
}
