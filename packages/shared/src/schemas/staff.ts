import { z } from 'zod';
import { EmailSchema } from './auth.js';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid id');
const VenueIds = z.array(Id).max(100);

// Staff and staff invitations (docs/04-security.md sections 1 and 2, docs/09 P0-4).

export const StaffMemberSchema = z.object({
  membershipId: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  roleId: z.string(),
  roleName: z.string(),
  venueIds: z.array(z.string()),
  active: z.boolean(),
  rev: z.number().int(),
});
export type StaffMemberDto = z.infer<typeof StaffMemberSchema>;

/** GET /v1/staff (a tenant has few staff: not paged, `nextCursor` is always null). */
export const StaffListResponseSchema = z.object({
  data: z.array(StaffMemberSchema),
  nextCursor: z.null(),
});
export type StaffListResponse = z.infer<typeof StaffListResponseSchema>;

export const MembershipIdParamSchema = z.object({ membershipId: Id });

/** PATCH /v1/staff/{membershipId}: `rev` is the concurrency token returned by the last read. */
export const UpdateStaffSchema = z
  .object({
    rev: z.number().int().min(1),
    roleId: Id.optional(),
    venueIds: VenueIds.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.roleId !== undefined || v.venueIds !== undefined || v.active !== undefined, {
    message: 'Send at least one of roleId, venueIds, active',
  });
export type UpdateStaffInput = z.infer<typeof UpdateStaffSchema>;

/** POST /v1/staff/invitations */
export const CreateInvitationSchema = z.object({
  email: EmailSchema,
  roleId: Id,
  /** Empty = all venues of the tenant (only an unrestricted caller may grant that). */
  venueIds: VenueIds.default([]),
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationSchema>;

export const InvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  roleId: z.string(),
  roleName: z.string().nullable(),
  venueIds: z.array(z.string()),
  status: z.enum(['pending', 'expired']),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type InvitationDto = z.infer<typeof InvitationSchema>;

export const InvitationListResponseSchema = z.object({
  data: z.array(InvitationSchema),
  nextCursor: z.null(),
});
export type InvitationListResponse = z.infer<typeof InvitationListResponseSchema>;

export const InvitationIdParamSchema = z.object({ id: Id });
