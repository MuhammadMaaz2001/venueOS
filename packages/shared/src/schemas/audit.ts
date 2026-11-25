import { z } from 'zod';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid id');
/** `role.update`, `staff.invite.accept`, `space.slot_prices.replace`. */
const ActionName = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+){0,3}$/, 'Invalid action');
const EntityTypeName = z.string().regex(/^[a-z0-9_]{1,64}$/, 'Invalid entity type');

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
/** A whole day of the workspace's time zone (`2027-02-14`) or an exact instant (ISO 8601). */
export const AuditDateBoundSchema = z.union([DateOnly, z.iso.datetime({ offset: true })]);

export const AUDIT_PAGE_SIZE_DEFAULT = 25;
export const AUDIT_PAGE_SIZE_MAX = 100;

/** GET /v1/audit-logs */
export const AuditLogListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_SIZE_MAX).default(AUDIT_PAGE_SIZE_DEFAULT),
  cursor: z.string().min(1).max(200).optional(),
  entityType: EntityTypeName.optional(),
  entityId: Id.optional(),
  actorUserId: Id.optional(),
  action: ActionName.optional(),
  /** First day (inclusive, tenant time zone) or instant. */
  from: AuditDateBoundSchema.optional(),
  /** Last day (inclusive, tenant time zone) or instant (inclusive). */
  to: AuditDateBoundSchema.optional(),
});
export type AuditLogListQuery = z.infer<typeof AuditLogListQuerySchema>;

/** A row of the list: who did what to which thing, and when. `before`/`after` are only in the detail. */
export const AuditLogItemSchema = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  actorType: z.enum(['USER', 'SYSTEM', 'PLATFORM_ADMIN']),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  venueId: z.string().nullable(),
});
export type AuditLogItemDto = z.infer<typeof AuditLogItemSchema>;

/** GET /v1/audit-logs/{id}: sensitive fields are masked as they were stored (`[REDACTED]`, `a***@x.com`). */
export const AuditLogDetailSchema = AuditLogItemSchema.extend({
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
});
export type AuditLogDetailDto = z.infer<typeof AuditLogDetailSchema>;

export const AuditLogListResponseSchema = z.object({
  data: z.array(AuditLogItemSchema),
  nextCursor: z.string().nullable(),
});
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;

export const AuditLogIdParamSchema = z.object({ id: Id });
