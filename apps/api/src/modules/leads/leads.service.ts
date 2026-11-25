import { Inject, Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { DbTx, Prisma } from '@venueos/db';
import {
  LEAD_SOURCE_LABELS,
  LEAD_STAGE_CHANGE_MESSAGES,
  OPEN_LEAD_STAGES,
  checkLeadStageChange,
  formatInstantForEmail,
  isOpenLeadStage,
  localDateIn,
} from '@venueos/shared';
import type {
  CreateLeadInput,
  LeadActivityChangeDto,
  LeadActivityDto,
  LeadActivityAction,
  LeadActivityListResponse,
  LeadAssigneeListResponse,
  LeadAssigneesQuery,
  LeadDto,
  LeadFollowUpsDto,
  LeadFollowUpsQuery,
  LeadListQuery,
  LeadListResponse,
  LeadSource,
  LeadStage,
  UpdateLeadInput,
} from '@venueos/shared';
import { Caller } from '../../common/access/caller.service';
import { VenueScope } from '../../common/access/venue-scope.service';
import { AuditService } from '../../common/audit/audit.service';
import { CustomFieldValuesService } from '../../common/custom-fields/custom-field-values.service';
import type { FieldDef } from '../../common/custom-fields/custom-field-values.service';
import {
  FieldValidationError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../common/errors/domain-errors';
import { newId } from '../../common/ids';
import { searchTerm } from '../../common/like';
import { EmailOutbox } from '../../common/jobs/email-outbox.service';
import { clientMoney, storedMoney } from '../../common/money/tenant-money';
import { tenantProfile } from '../../common/tenant/tenant-profile';
import type { TenantProfile } from '../../common/tenant/tenant-profile';
import { parseDateOnly, startOfLocalDay, startOfNextLocalDay } from '../../common/time/zoned';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import { CustomersService } from '../customers/customers.service';

const LEAD_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true, email: true } },
  venue: { select: { name: true } },
  eventType: { select: { name: true } },
  assignee: { select: { id: true, userId: true, user: { select: { name: true } } } },
} satisfies Prisma.LeadInclude;
type LeadRow = Prisma.LeadGetPayload<{ include: typeof LEAD_INCLUDE }>;

interface AssigneeInfo {
  membershipId: string;
  userId: string;
  name: string;
  email: string | null;
}

const OPEN = [...OPEN_LEAD_STAGES];
const ACTIVITY_LIMIT = 200;

const encodeCursor = (id: string): string => Buffer.from(`l1:${id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith('l1:') || decoded.length < 4) {
    throw new FieldValidationError('cursor', 'Invalid cursor');
  }
  return decoded.slice(3);
}

function dateOnly(value: string, path: string): Date {
  if (!parseDateOnly(value)) throw new FieldValidationError(path, 'Enter a real date');
  return new Date(`${value}T00:00:00.000Z`);
}

/** Whatever an audit value is, as text for the activity log. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Leads (docs/01 module 5, docs/05 section 12). Venue scoped: a caller limited to some venues only sees and edits those
 * (another venue's lead is 404). Stage rules live in `checkLeadStageChange` (shared); the database CHECKs are the backstop
 * for "LOST needs a reason" and "an open lead needs a follow-up".
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly caller: Caller,
    private readonly venueScope: VenueScope,
    private readonly fields: CustomFieldValuesService,
    private readonly customers: CustomersService,
    private readonly emailOutbox: EmailOutbox,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ───────────────────────────── reads ─────────────────────────────

  async list(query: LeadListQuery): Promise<LeadListResponse> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const profile = await tenantProfile(tx, tenantId);
      const defs = await this.defs(tx);
      const where = await this.listWhere(query, profile);
      let cursorId: string | undefined;
      if (query.cursor !== undefined) {
        cursorId = decodeCursor(query.cursor);
        const known = await tx.lead.findFirst({
          where: { id: cursorId, tenantId, ...this.scopeWhere() },
          select: { id: true },
        });
        if (!known) throw new FieldValidationError('cursor', 'Invalid cursor');
      }
      const rows = await tx.lead.findMany({
        where,
        include: LEAD_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        data: page.map((row) => this.toDto(row, defs, profile.currency)),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
      };
    });
  }

  async get(id: string): Promise<LeadDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const profile = await tenantProfile(tx, tenantId);
      return this.toDto(await this.load(tx, id), await this.defs(tx), profile.currency);
    });
  }

  async followUps(query: LeadFollowUpsQuery): Promise<LeadFollowUpsDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const profile = await tenantProfile(tx, tenantId);
      const defs = await this.defs(tx);
      const now = new Date();
      const tomorrow = startOfNextLocalDay(localDateIn(now, profile.timezone), profile.timezone);
      const base: Prisma.LeadWhereInput = {
        tenantId,
        ...this.scopeWhere(),
        stage: { in: OPEN },
        ...(query.assignee === 'me' ? { assigneeId: this.caller.membershipId } : {}),
      };
      const [overdue, dueToday, rows] = await Promise.all([
        tx.lead.count({ where: { ...base, nextFollowUpAt: { lt: now } } }),
        tx.lead.count({ where: { ...base, nextFollowUpAt: { gte: now, lt: tomorrow } } }),
        tx.lead.findMany({
          where: { ...base, nextFollowUpAt: { lt: tomorrow } },
          include: LEAD_INCLUDE,
          orderBy: [{ nextFollowUpAt: 'asc' }, { id: 'asc' }],
          take: query.limit,
        }),
      ]);
      return { overdue, dueToday, items: rows.map((r) => this.toDto(r, defs, profile.currency)) };
    });
  }

  async assignees(query: LeadAssigneesQuery): Promise<LeadAssigneeListResponse> {
    const tenantId = this.caller.tenantId;
    if (query.venueId !== undefined) this.venueScope.assertAccess(query.venueId);
    return this.tenantDb.tx(async (tx) => {
      if (query.venueId !== undefined) await this.loadVenue(tx, query.venueId);
      const rows = await tx.membership.findMany({
        where: {
          tenantId,
          active: true,
          role: { permissions: { has: 'lead.manage' } },
          ...(query.venueId === undefined
            ? {}
            : { OR: [{ venueIds: { isEmpty: true } }, { venueIds: { has: query.venueId } }] }),
        },
        select: {
          id: true,
          userId: true,
          user: { select: { name: true } },
          role: { select: { name: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return {
        data: rows
          .map((m) => ({
            membershipId: m.id,
            userId: m.userId,
            name: m.user.name,
            roleName: m.role.name,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        nextCursor: null,
      };
    });
  }

  async activity(id: string): Promise<LeadActivityListResponse> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      await this.load(tx, id); // 404 for another tenant's or an out-of-scope lead
      const rows = await tx.auditLog.findMany({
        where: {
          tenantId,
          entityType: 'lead',
          entityId: id,
          action: { in: ['lead.create', 'lead.update', 'lead.stage_change', 'lead.assign'] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: ACTIVITY_LIMIT,
        select: {
          id: true,
          action: true,
          createdAt: true,
          before: true,
          after: true,
          actorUser: { select: { name: true } },
        },
      });
      const data: LeadActivityDto[] = rows.map((r) => ({
        id: r.id,
        action: r.action as LeadActivityAction,
        createdAt: r.createdAt.toISOString(),
        actorName: r.actorUser?.name ?? null,
        changes: diffAudit(r.action, r.before, r.after),
      }));
      return { data, nextCursor: null };
    });
  }

  // ───────────────────────────── writes ─────────────────────────────

  async create(input: CreateLeadInput): Promise<LeadDto> {
    const tenantId = this.caller.tenantId;
    this.venueScope.assertAccess(input.venueId);
    // Creating a customer on the way is a customer permission, not a lead one.
    if (input.customer !== undefined && !this.caller.has('customer.manage')) {
      throw new ForbiddenError('You may not add customers.');
    }
    return this.tenantDb.tx(async (tx) => {
      const profile = await tenantProfile(tx, tenantId);
      const venue = await this.loadVenue(tx, input.venueId);
      const customerId =
        input.customer !== undefined
          ? (await this.customers.createInTx(tx, input.customer, profile)).id
          : await this.loadCustomerId(tx, input.customerId as string);
      const eventType = await this.loadEventType(tx, input.eventTypeId);
      const assignee = await this.resolveAssignee(
        tx,
        input.assigneeId === undefined ? this.caller.membershipId : input.assigneeId,
        input.venueId,
      );
      const defs = await this.defs(tx);
      const id = newId();
      const merged = this.fields.merge({
        defs,
        current: {},
        input: input.customFields,
        tenantId,
        recordId: id,
        country: profile.country,
        creating: true,
      });

      await tx.lead.create({
        data: {
          id,
          tenantId,
          venueId: venue.id,
          customerId,
          eventTypeId: eventType?.id ?? null,
          preferredDate:
            input.preferredDate == null ? null : dateOnly(input.preferredDate, 'preferredDate'),
          flexibleDates: input.flexibleDates,
          guests: input.guests ?? null,
          budget:
            input.budget == null ? null : clientMoney(input.budget, profile.currency, 'budget'),
          source: input.source,
          stage: 'NEW',
          assigneeId: assignee?.membershipId ?? null,
          nextFollowUpAt: new Date(input.nextFollowUpAt),
          notes: input.notes ?? null,
          customFields: merged.stored as Prisma.InputJsonObject,
        },
      });
      const row = await this.load(tx, id);
      await this.audit.record(tx, {
        action: 'lead.create',
        entityType: 'lead',
        entityId: id,
        venueId: venue.id,
        after: { ...this.auditFields(row), stage: row.stage, assignee: assignee?.name ?? null },
      });
      if (assignee) await this.notifyAssigned(tx, row, assignee, profile);
      return this.toDto(row, defs, profile.currency);
    });
  }

  async update(id: string, input: UpdateLeadInput): Promise<LeadDto> {
    const tenantId = this.caller.tenantId;
    return this.tenantDb.tx(async (tx) => {
      const profile = await tenantProfile(tx, tenantId);
      const current = await this.load(tx, id);
      if (current.rev !== input.rev) throw new VersionConflictError();
      const defs = await this.defs(tx);
      const data: Prisma.LeadUncheckedUpdateManyInput = {};

      // venue
      let venueId = current.venueId;
      if (input.venueId !== undefined && input.venueId !== current.venueId) {
        this.venueScope.assertAccess(input.venueId);
        venueId = (await this.loadVenue(tx, input.venueId)).id;
        data.venueId = venueId;
      }
      if (input.eventTypeId !== undefined && input.eventTypeId !== current.eventTypeId) {
        data.eventTypeId = (await this.loadEventType(tx, input.eventTypeId))?.id ?? null;
      }
      if (input.preferredDate !== undefined) {
        data.preferredDate =
          input.preferredDate === null ? null : dateOnly(input.preferredDate, 'preferredDate');
      }
      if (input.flexibleDates !== undefined) data.flexibleDates = input.flexibleDates;
      if (input.guests !== undefined) data.guests = input.guests;
      if (input.budget !== undefined) {
        data.budget =
          input.budget === null ? null : clientMoney(input.budget, profile.currency, 'budget');
      }
      if (input.source !== undefined) data.source = input.source;
      if (input.notes !== undefined) data.notes = input.notes;

      // stage, lost reason, follow-up
      const fromStage = current.stage as LeadStage;
      const toStage = input.stage ?? fromStage;
      if (toStage !== fromStage) {
        const check = checkLeadStageChange(fromStage, toStage);
        if (!check.allowed)
          throw new InvalidStateTransitionError(LEAD_STAGE_CHANGE_MESSAGES[check.reason]);
        data.stage = toStage;
      }
      let lostReason: string | null = null;
      if (toStage === 'LOST') {
        const reason = input.lostReason !== undefined ? input.lostReason : current.lostReason;
        if (!reason || reason.trim() === '') {
          throw new FieldValidationError('lostReason', 'Say why the lead was lost');
        }
        lostReason = reason.trim();
      } else if (input.lostReason) {
        throw new FieldValidationError('lostReason', 'Only a lost lead has a reason');
      }
      if (lostReason !== current.lostReason) data.lostReason = lostReason;

      let nextFollowUpAt: Date | null;
      if (isOpenLeadStage(toStage)) {
        nextFollowUpAt =
          input.nextFollowUpAt === undefined
            ? current.nextFollowUpAt
            : input.nextFollowUpAt === null
              ? null
              : new Date(input.nextFollowUpAt);
        if (!nextFollowUpAt) {
          throw new FieldValidationError('nextFollowUpAt', 'Set the next follow-up');
        }
      } else {
        if (input.nextFollowUpAt) {
          throw new FieldValidationError('nextFollowUpAt', 'A closed lead has no follow-up');
        }
        nextFollowUpAt = null;
      }
      const followUpChanged = nextFollowUpAt?.getTime() !== current.nextFollowUpAt?.getTime();
      if (followUpChanged) data.nextFollowUpAt = nextFollowUpAt;

      // assignee
      let assignee: AssigneeInfo | null | undefined; // undefined = unchanged
      if (input.assigneeId !== undefined) {
        if (input.assigneeId !== current.assigneeId) {
          assignee = await this.resolveAssignee(tx, input.assigneeId, venueId);
        }
      } else if (venueId !== current.venueId && current.assigneeId) {
        // The venue moved: the current assignee must cover the new one.
        await this.resolveAssignee(tx, current.assigneeId, venueId);
      }
      if (assignee !== undefined) data.assigneeId = assignee?.membershipId ?? null;
      // A new follow-up time or a new assignee starts a new "overdue" mail.
      if (followUpChanged || assignee !== undefined) data.followUpNotifiedFor = null;

      let customFieldsChanged: string[] = [];
      if (input.customFields !== undefined) {
        const merged = this.fields.merge({
          defs,
          current: current.customFields,
          input: input.customFields,
          tenantId,
          recordId: id,
          country: profile.country,
          creating: false,
        });
        data.customFields = merged.stored as Prisma.InputJsonObject;
        customFieldsChanged = merged.changed;
      }

      if (Object.keys(data).length === 0) return this.toDto(current, defs, profile.currency);

      const changed = await tx.lead.updateMany({ where: { id, tenantId, rev: input.rev }, data });
      if (changed.count !== 1) throw new VersionConflictError();
      const after = await this.load(tx, id);

      // Audit: stage, assignment and the other edits are separate rows, so the activity log reads clearly.
      if (toStage !== fromStage) {
        await this.audit.record(tx, {
          action: 'lead.stage_change',
          entityType: 'lead',
          entityId: id,
          venueId: after.venueId,
          before: { stage: fromStage, lostReason: current.lostReason },
          after: { stage: toStage, lostReason: after.lostReason },
        });
      }
      if (assignee !== undefined) {
        await this.audit.record(tx, {
          action: 'lead.assign',
          entityType: 'lead',
          entityId: id,
          venueId: after.venueId,
          before: { assignee: current.assignee?.user.name ?? null },
          after: { assignee: assignee?.name ?? null },
        });
      }
      const beforeFields = this.auditFields(current);
      const afterFields = this.auditFields(after);
      const closing = !isOpenLeadStage(toStage) && toStage !== fromStage;
      const beforeDiff: Record<string, unknown> = {};
      const afterDiff: Record<string, unknown> = {};
      for (const key of Object.keys(afterFields)) {
        if (key === 'nextFollowUpAt' && closing) continue; // clearing it is part of closing
        if (key === 'customFields') {
          for (const k of customFieldsChanged) {
            const b = (beforeFields.customFields as Record<string, unknown>)[k] ?? null;
            const a = (afterFields.customFields as Record<string, unknown>)[k] ?? null;
            if (JSON.stringify(a) !== JSON.stringify(b)) {
              beforeDiff[`customFields.${k}`] = b;
              afterDiff[`customFields.${k}`] = a;
            }
          }
          continue;
        }
        if (JSON.stringify(beforeFields[key]) !== JSON.stringify(afterFields[key])) {
          beforeDiff[key] = beforeFields[key];
          afterDiff[key] = afterFields[key];
        }
      }
      if (Object.keys(afterDiff).length > 0) {
        await this.audit.record(tx, {
          action: 'lead.update',
          entityType: 'lead',
          entityId: id,
          venueId: after.venueId,
          before: beforeDiff,
          after: afterDiff,
        });
      }
      if (assignee) await this.notifyAssigned(tx, after, assignee, profile);
      return this.toDto(after, defs, profile.currency);
    });
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private defs(tx: DbTx): Promise<FieldDef[]> {
    return tx.customFieldDef.findMany({
      where: { tenantId: this.caller.tenantId, entity: 'lead' },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }, { id: 'asc' }],
    });
  }

  /** The tenant, plus the caller's venues when they are limited to some. */
  private scopeWhere(): Prisma.LeadWhereInput {
    const ids = this.venueScope.filterIds();
    return ids ? { venueId: { in: ids } } : {};
  }

  private async load(tx: DbTx, id: string): Promise<LeadRow> {
    const row = await tx.lead.findFirst({
      where: { id, tenantId: this.caller.tenantId, ...this.scopeWhere() },
      include: LEAD_INCLUDE,
    });
    if (!row) throw new NotFoundError();
    return row;
  }

  private async loadVenue(tx: DbTx, venueId: string): Promise<{ id: string; name: string }> {
    const venue = await tx.venue.findFirst({
      where: { id: venueId, tenantId: this.caller.tenantId, active: true },
      select: { id: true, name: true },
    });
    if (!venue) throw new NotFoundError();
    return venue;
  }

  private async loadCustomerId(tx: DbTx, customerId: string): Promise<string> {
    const customer = await tx.customer.findFirst({
      where: { id: customerId, tenantId: this.caller.tenantId, active: true },
      select: { id: true },
    });
    if (!customer) throw new NotFoundError();
    return customer.id;
  }

  private async loadEventType(
    tx: DbTx,
    eventTypeId: string | null | undefined,
  ): Promise<{ id: string } | null> {
    if (eventTypeId === null || eventTypeId === undefined) return null;
    const eventType = await tx.eventType.findFirst({
      where: { id: eventTypeId, tenantId: this.caller.tenantId, active: true },
      select: { id: true },
    });
    if (!eventType) throw new NotFoundError();
    return eventType;
  }

  /**
   * The member a lead is given to: active, holds `lead.manage`, and their venues cover the lead's venue. An id that is
   * not a member of this workspace is 404 (CLAUDE.md rule 13); one that is but cannot take leads is a 400 on the field.
   */
  private async resolveAssignee(
    tx: DbTx,
    membershipId: string | null,
    venueId: string,
  ): Promise<AssigneeInfo | null> {
    if (membershipId === null) return null;
    const member = await tx.membership.findFirst({
      where: { id: membershipId, tenantId: this.caller.tenantId },
      select: {
        id: true,
        userId: true,
        active: true,
        venueIds: true,
        user: { select: { name: true, email: true } },
        role: { select: { permissions: true, active: true } },
      },
    });
    if (!member) throw new NotFoundError();
    const coversVenue = member.venueIds.length === 0 || member.venueIds.includes(venueId);
    if (
      !member.active ||
      !member.role.active ||
      !member.role.permissions.includes('lead.manage') ||
      !coversVenue
    ) {
      throw new FieldValidationError(
        'assigneeId',
        'Choose an active team member who manages leads at this venue',
      );
    }
    return {
      membershipId: member.id,
      userId: member.userId,
      name: member.user.name,
      email: member.user.email,
    };
  }

  private async listWhere(
    query: LeadListQuery,
    profile: TenantProfile,
  ): Promise<Prisma.LeadWhereInput> {
    const where: Prisma.LeadWhereInput = { tenantId: this.caller.tenantId };
    const venueIds = this.venueScope.filterIds(query.venueId ? [query.venueId] : undefined);
    if (venueIds) where.venueId = { in: venueIds };
    if (query.stage) where.stage = query.stage;
    if (query.source) where.source = query.source;
    if (query.customerId) where.customerId = query.customerId;
    if (query.unassigned === 'true') where.assigneeId = null;
    else if (query.assigneeId) where.assigneeId = query.assigneeId;
    if (query.followUp) {
      const now = new Date();
      const today = localDateIn(now, profile.timezone);
      // Only open leads have a follow-up: asking for follow-ups of a closed stage matches nothing.
      where.stage = query.stage
        ? isOpenLeadStage(query.stage)
          ? query.stage
          : { in: [] }
        : { in: OPEN };
      if (query.followUp === 'overdue') where.nextFollowUpAt = { lt: now };
      else {
        where.nextFollowUpAt = {
          gte: startOfLocalDay(today, profile.timezone),
          lt: startOfNextLocalDay(today, profile.timezone),
        };
      }
    }
    if (query.search) {
      const term = searchTerm(query.search);
      const digits = query.search.replace(/\D/g, '');
      where.customer = term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' } },
              ...(digits.length >= 3
                ? [{ phone: { contains: digits.replace(/^0+/, '') || digits } }]
                : []),
            ],
          }
        : { id: { in: [] } };
    }
    return where;
  }

  private toDto(row: LeadRow, defs: readonly FieldDef[], currency: string): LeadDto {
    const { values } = this.fields.display(defs, row.customFields);
    return {
      id: row.id,
      venueId: row.venueId,
      venueName: row.venue.name,
      customer: { ...row.customer },
      eventTypeId: row.eventTypeId,
      eventTypeName: row.eventType?.name ?? null,
      preferredDate: row.preferredDate ? row.preferredDate.toISOString().slice(0, 10) : null,
      flexibleDates: row.flexibleDates,
      guests: row.guests,
      budget: row.budget ? storedMoney(row.budget, currency) : null,
      source: row.source as LeadSource,
      stage: row.stage as LeadStage,
      lostReason: row.lostReason,
      assignee: row.assignee
        ? {
            membershipId: row.assignee.id,
            userId: row.assignee.userId,
            name: row.assignee.user.name,
          }
        : null,
      nextFollowUpAt: row.nextFollowUpAt ? row.nextFollowUpAt.toISOString() : null,
      notes: row.notes,
      customFields: values,
      rev: row.rev,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** The editable fields as an audit row shows them (names instead of ids where a person will read it). */
  private auditFields(row: LeadRow): Record<string, unknown> {
    return {
      venue: row.venue.name,
      eventType: row.eventType?.name ?? null,
      preferredDate: row.preferredDate ? row.preferredDate.toISOString().slice(0, 10) : null,
      flexibleDates: row.flexibleDates,
      guests: row.guests,
      budget: row.budget ? row.budget.toString() : null,
      source: row.source,
      nextFollowUpAt: row.nextFollowUpAt ? row.nextFollowUpAt.toISOString() : null,
      notes: row.notes,
      customFields: this.fields.forAudit(row.customFields),
    };
  }

  /** "New lead assigned" to the assignee, unless they assigned it to themselves. */
  private async notifyAssigned(
    tx: DbTx,
    lead: LeadRow,
    assignee: AssigneeInfo,
    profile: TenantProfile,
  ): Promise<void> {
    if (assignee.userId === this.caller.userId || !assignee.email) return;
    const actor = await tx.user.findFirst({
      where: { id: this.caller.userId },
      select: { name: true },
    });
    await this.emailOutbox.enqueue(tx, {
      to: assignee.email,
      template: 'lead.assigned',
      locale: profile.defaultLocale,
      event: 'lead.assigned',
      entityType: 'lead',
      entityId: lead.id,
      vars: {
        assigneeName: assignee.name,
        assignedBy: actor?.name ?? 'A colleague',
        customerName: lead.customer.name,
        eventType: lead.eventType?.name ?? 'event',
        venueName: lead.venue.name,
        preferredDate: lead.preferredDate
          ? lead.preferredDate.toISOString().slice(0, 10)
          : 'Not given',
        guests: lead.guests === null ? 'Not given' : String(lead.guests),
        source: LEAD_SOURCE_LABELS[lead.source as LeadSource],
        followUpAt: lead.nextFollowUpAt
          ? formatInstantForEmail(lead.nextFollowUpAt, profile.timezone)
          : 'Not set',
        leadUrl: `${this.config.APP_ORIGIN}/leads/${lead.id}`,
      },
    });
  }
}

/** What changed between two audit snapshots, as `{ field, from, to }` (a created lead lists what it was created with). */
function diffAudit(action: string, before: unknown, after: unknown): LeadActivityChangeDto[] {
  const flatten = (value: unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
    for (const [key, v] of Object.entries(value)) {
      if (key === 'customFields' && typeof v === 'object' && v !== null) {
        for (const [k, cv] of Object.entries(v)) out[`customFields.${k}`] = cv;
      } else {
        out[key] = v;
      }
    }
    return out;
  };
  const b = flatten(before);
  const a = flatten(after);
  const changes: LeadActivityChangeDto[] = [];
  for (const field of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const from = asText(b[field]);
    const to = asText(a[field]);
    if (from === to) continue;
    changes.push({ field, from, to });
  }
  // Two people can share a name: an assignment is always shown as a change.
  if (action === 'lead.assign' && changes.length === 0) {
    changes.push({ field: 'assignee', from: asText(b.assignee), to: asText(a.assignee) });
  }
  return changes;
}
