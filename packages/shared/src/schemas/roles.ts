import { z } from 'zod';
import { PermissionSchema, missingViewPermissions } from '../permissions.js';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid id');
const RoleName = z.string().trim().min(1).max(60);

/** Role limits as sent by a client: the key is required, never silently defaulted. */
const RoleLimitsInput = z.object({ maxDiscountPct: z.number().min(0).max(100) });

export const RoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  permissions: z.array(PermissionSchema),
  limits: z.object({ maxDiscountPct: z.number() }),
  isSystem: z.boolean(),
  /** false = retired: not assignable, not copyable, not editable until restored. */
  active: z.boolean(),
  /** Active members who hold the role (a role with some cannot be retired). */
  memberCount: z.number().int().min(0),
  rev: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type RoleDto = z.infer<typeof RoleSchema>;

/** GET /v1/roles (a tenant has few roles: the list is not paged, `nextCursor` is always null). */
export const RoleListResponseSchema = z.object({
  data: z.array(RoleSchema),
  nextCursor: z.null(),
});
export type RoleListResponse = z.infer<typeof RoleListResponseSchema>;

/** GET /v1/roles?status=: retired roles are hidden unless asked for. */
export const ROLE_STATUS_FILTERS = ['active', 'retired', 'all'] as const;
export const RoleListQuerySchema = z.object({
  status: z.enum(ROLE_STATUS_FILTERS).default('active'),
});
export type RoleListQuery = z.infer<typeof RoleListQuerySchema>;

export const RoleIdParamSchema = z.object({ id: Id });

/** POST /v1/roles: a new custom role starts as a copy of an existing role of the same tenant. */
export const CreateRoleSchema = z.object({
  name: RoleName,
  copyFromRoleId: Id,
});
export type CreateRoleInput = z.infer<typeof CreateRoleSchema>;

/**
 * PATCH /v1/roles/{id}: `rev` is the concurrency token returned by the last read. `active: false` retires a
 * custom role without members, `active: true` restores it.
 */
export const UpdateRoleSchema = z
  .object({
    rev: z.number().int().min(1),
    name: RoleName.optional(),
    permissions: z.array(PermissionSchema).max(100).optional(),
    limits: RoleLimitsInput.optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.permissions !== undefined ||
      v.limits !== undefined ||
      v.active !== undefined,
    'Nothing to change',
  )
  .superRefine((v, ctx) => {
    // A role that may manage an area must also see it (docs/04-security.md section 2).
    for (const { manage, view } of missingViewPermissions(v.permissions ?? [])) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions'],
        message: `"${manage}" also needs "${view}"`,
      });
    }
  });
export type UpdateRoleInput = z.infer<typeof UpdateRoleSchema>;
