import { Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import { ClsService } from 'nestjs-cls';
import { Entitlement, RequirePermission } from '../../common/access/access.decorators';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';

// Test-only controller (never part of the application) exercising the guards and helpers.

@Controller('_access')
export class AccessProbeController {
  constructor(
    private readonly cls: ClsService,
    private readonly scope: VenueScope,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** A read: allowed on a suspended tenant. Echoes what the guards stored in CLS. */
  @Get('read')
  @RequirePermission('customer.view')
  read(): Record<string, unknown> {
    return {
      tenantId: this.cls.get('tenantId'),
      userId: this.cls.get('userId'),
      access: this.cls.get('access'),
    };
  }

  /** A write: refused on a suspended tenant. */
  @Post('write')
  @RequirePermission('customer.manage')
  write(): { ok: true } {
    return { ok: true };
  }

  @Patch('write')
  @RequirePermission('customer.manage')
  writePatch(): { ok: true } {
    return { ok: true };
  }

  @Put('write')
  @RequirePermission('customer.manage')
  writePut(): { ok: true } {
    return { ok: true };
  }

  @Delete('write')
  @RequirePermission('customer.manage')
  writeDelete(): { ok: true } {
    return { ok: true };
  }

  @Post('venue')
  @RequirePermission('venue.manage')
  @Entitlement('maxVenues')
  createVenue(): { ok: true } {
    return { ok: true };
  }

  @Post('user')
  @RequirePermission('staff.manage')
  @Entitlement('maxUsers')
  createUser(): { ok: true } {
    return { ok: true };
  }

  @Post('space')
  @RequirePermission('venue.manage')
  @Entitlement('maxSpaces')
  createSpace(): { ok: true } {
    return { ok: true };
  }

  @Get('venues')
  @RequirePermission('venue.manage')
  venues(@Query('venueId') venueId?: string): { filter: string[] | null; unrestricted: boolean } {
    const filter = this.scope.filterIds(venueId ? [venueId] : undefined);
    return { filter: filter ?? null, unrestricted: this.scope.unrestricted };
  }

  @Get('venues/:venueId')
  @RequirePermission('venue.manage')
  venue(@Param('venueId') venueId: string): { ok: true } {
    this.scope.assertAccess(venueId);
    return { ok: true };
  }

  /** TenantDb with the ambient context: counts the members RLS lets the caller's tenant see. */
  @Get('members')
  @RequirePermission('staff.manage')
  async members(): Promise<{ count: number }> {
    return { count: await this.tenantDb.tx((tx) => tx.membership.count()) };
  }

  /** Audit row and a following failure in the same transaction: both must disappear. */
  @Post('audit/:mode')
  @RequirePermission('audit.view')
  async auditTx(@Param('mode') mode: string): Promise<{ ok: true }> {
    await this.tenantDb.tx(async (tx) => {
      await this.audit.record(tx, {
        action: `probe.${mode}`,
        entityType: 'probe',
        entityId: 'probe_1',
        after: { mode, password: 'hunter2' },
      });
      if (mode === 'rollback') throw new Error('boom after audit');
    });
    return { ok: true };
  }
}
