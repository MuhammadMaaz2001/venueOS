import { Injectable } from '@nestjs/common';
import type { Permission } from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../context/request-context';
import { UnauthenticatedError } from '../errors/domain-errors';
import type { TenantAccess } from './access-context';

/** The caller of the current request, as TenantGuard established it (tenant, permissions). Never from the body. */
@Injectable()
export class Caller {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  get access(): TenantAccess {
    const access = this.cls.get('access');
    if (!access) throw new UnauthenticatedError();
    return access;
  }

  get tenantId(): string {
    return this.access.tenantId;
  }

  has(permission: Permission): boolean {
    return this.access.permissions.includes(permission);
  }

  /**
   * Catalogue prices are pricing information: a reader who only has `catalogue.view` (e.g. Operations, who need the
   * dishes, not the rates) gets `null` unless they also manage the catalogue or may see booking prices.
   */
  get canSeeCataloguePrices(): boolean {
    return this.has('catalogue.manage') || this.has('booking.view_prices');
  }
}
