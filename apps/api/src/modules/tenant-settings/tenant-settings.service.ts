import { Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx } from '@venueos/db';
import { MoneyError, TenantSettings, parseMoney, parseTenantSettings } from '@venueos/shared';
import type { TenantSettingsResponse, UpdateTenantSettingsInput } from '@venueos/shared';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  FieldValidationError,
  NotFoundError,
  UnauthenticatedError,
  VersionConflictError,
} from '../../common/errors/domain-errors';

interface TenantRow {
  name: string;
  slug: string;
  country: string;
  currency: string;
  timezone: string;
  defaultLocale: string;
  settings: unknown;
  rev: number;
}

function toDto(row: TenantRow): TenantSettingsResponse {
  return {
    name: row.name,
    slug: row.slug,
    country: row.country,
    currency: row.currency,
    timezone: row.timezone,
    defaultLocale: row.defaultLocale,
    settings: parseTenantSettings(row.settings),
    rev: row.rev,
  };
}

@Injectable()
export class TenantSettingsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private get tenantId(): string {
    const id = this.cls.get('access')?.tenantId;
    if (!id) throw new UnauthenticatedError();
    return id;
  }

  async get(): Promise<TenantSettingsResponse> {
    return toDto(await this.tenantDb.tx((tx) => this.load(tx)));
  }

  async update(input: UpdateTenantSettingsInput): Promise<TenantSettingsResponse> {
    const tenantId = this.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const current = await this.load(tx);
      if (current.rev !== input.rev) throw new VersionConflictError();
      const before = toDto(current);

      // Merge into the parsed settings: a key the client did not send keeps its stored value.
      const patch = Object.fromEntries(
        Object.entries(input.settings ?? {}).filter(([, v]) => v !== undefined),
      );
      const merged = TenantSettings.parse({ ...before.settings, ...patch });
      try {
        parseMoney(merged.tokenAmount, current.currency);
      } catch (error) {
        if (!(error instanceof MoneyError)) throw error;
        throw new FieldValidationError('settings.tokenAmount', error.message);
      }

      const changed = await tx.tenant.updateMany({
        where: { id: tenantId, rev: input.rev },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
          ...(input.settings === undefined ? {} : { settings: merged }),
        },
      });
      if (changed.count !== 1) throw new VersionConflictError();

      const after = toDto(await this.load(tx));
      await this.audit.record(tx, {
        action: 'tenant.settings.update',
        entityType: 'tenant',
        entityId: tenantId,
        before: pickAudited(before),
        after: pickAudited(after),
      });
      return after;
    });
  }

  private async load(tx: DbTx): Promise<TenantRow> {
    const row = await tx.tenant.findFirst({ where: { id: this.tenantId } });
    if (!row) throw new NotFoundError();
    return row;
  }
}

/** The editable part only (the slug, country and currency never change here). */
function pickAudited(dto: TenantSettingsResponse) {
  return { name: dto.name, timezone: dto.timezone, settings: dto.settings };
}
