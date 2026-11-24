import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import type { ReplaceSpaceSlotPricesInput, SpaceSlotPricesResponse } from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  FieldValidationError,
  NotFoundError,
  UnauthenticatedError,
} from '../../common/errors/domain-errors';
import { clientMoney, storedMoney, tenantCurrency } from '../../common/money/tenant-money';

/** The rent of a space per slot template (`space_slot_prices`). */
@Injectable()
export class SpaceSlotPricesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly venueScope: VenueScope,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private get tenantId(): string {
    const id = this.cls.get('access')?.tenantId;
    if (!id) throw new UnauthenticatedError();
    return id;
  }

  async list(spaceId: string): Promise<SpaceSlotPricesResponse> {
    const tenantId = this.tenantId;
    return this.tenantDb.tx(async (tx) => {
      await this.loadSpace(tx, spaceId);
      return { data: await this.read(tx, spaceId, await tenantCurrency(tx, tenantId)) };
    });
  }

  async replace(
    spaceId: string,
    input: ReplaceSpaceSlotPricesInput,
  ): Promise<SpaceSlotPricesResponse> {
    const tenantId = this.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const space = await this.loadSpace(tx, spaceId);
      const currency = await tenantCurrency(tx, tenantId);

      // Slot ids come from the client and no composite FK ties them to this tenant or venue: load them (rule 13).
      const slotIds = input.prices.map((p) => p.slotId);
      const slots = await tx.slotTemplate.findMany({
        where: { tenantId, id: { in: slotIds } },
        select: { id: true, venueId: true },
      });
      if (slots.length !== slotIds.length) throw new NotFoundError();
      if (slots.some((s) => s.venueId !== space.venueId)) {
        throw new FieldValidationError('prices', "Every slot must belong to the space's venue");
      }
      const prices = input.prices.map((p, i) => ({
        slotId: p.slotId,
        rent: clientMoney(p.rent, currency, `prices.${i}.rent`),
      }));

      const before = await this.read(tx, spaceId, currency);
      await tx.spaceSlotPrice.deleteMany({ where: { tenantId, spaceId } });
      if (prices.length > 0) {
        await tx.spaceSlotPrice.createMany({
          data: prices.map((p) => ({ tenantId, spaceId, slotId: p.slotId, rent: p.rent })),
        });
      }
      const after = await this.read(tx, spaceId, currency);
      await this.audit.record(tx, {
        action: 'space.slot_prices.replace',
        entityType: 'space',
        entityId: spaceId,
        before: { prices: before },
        after: { prices: after },
      });
      return { data: after };
    });
  }

  private async read(tx: DbTx, spaceId: string, currency: string) {
    const rows = await tx.spaceSlotPrice.findMany({
      where: { tenantId: this.tenantId, spaceId },
      orderBy: { slotId: 'asc' },
    });
    return rows.map((r) => ({ slotId: r.slotId, rent: storedMoney(r.rent, currency) }));
  }

  private async loadSpace(tx: DbTx, id: string): Promise<{ id: string; venueId: string }> {
    const space = await tx.space.findFirst({
      where: { id, tenantId: this.tenantId },
      select: { id: true, venueId: true },
    });
    if (!space) throw new NotFoundError();
    this.venueScope.assertAccess(space.venueId);
    return space;
  }
}
