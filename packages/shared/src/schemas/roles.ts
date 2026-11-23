import { z } from 'zod';
import { PermissionSchema } from '../permissions.js';

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

export const RoleIdParamSchema = z.object({ id: Id });

/** POST /v1/roles: a new custom role starts as a copy of an existing role of the same tenant. */
export const CreateRoleSchema = z.object({
  name: RoleName,
  copyFromRoleId: Id,
});
export type CreateRoleInput = z.infer<typeof CreateRoleSchema>;

/** PATCH /v1/roles/{id}: `rev` is the concurrency token returned by the last read. */
export const UpdateRoleSchema = z
  .object({
    rev: z.number().int().min(1),
    name: RoleName.optional(),
    permissions: z.array(PermissionSchema).max(100).optional(),
    limits: RoleLimitsInput.optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.permissions !== undefined || v.limits !== undefined,
    'Nothing to change',
  );
export type UpdateRoleInput = z.infer<typeof UpdateRoleSchema>;
