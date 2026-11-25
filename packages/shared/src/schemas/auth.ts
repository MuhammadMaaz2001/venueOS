import { z } from 'zod';
import { currencyCodeSchema } from '../currency.js';

// Request and response bodies of the auth endpoints (docs/04-security.md section 1, docs/09 P0-4).

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid id');

/** Trimmed, lower-cased, at most 254 characters: the only form in which an email is stored or compared. */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const PASSWORD_MIN_LENGTH = 10;
/** Upper bound only protects the hasher from huge inputs; there are no composition rules (docs/04). */
export const PASSWORD_MAX_LENGTH = 128;
export const PasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** One-time token as it appears in an emailed link: base64url of 32 random bytes. */
export const OneTimeTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/, 'Invalid token');

const PersonName = z.string().trim().min(1).max(100);
const Locale = z
  .string()
  .regex(/^[a-z]{2,3}$/)
  .default('en');

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The 202 body of every enumeration-safe endpoint: it is the same whether or not the account exists. */
export const AcceptedResponseSchema = z.object({ message: z.string() });
export type AcceptedResponse = z.infer<typeof AcceptedResponseSchema>;

// ───────────────────────────── signup, verification ─────────────────────────────

export const SignupSchema = z.object({
  name: PersonName,
  email: EmailSchema,
  password: PasswordSchema,
  tenantName: z.string().trim().min(2).max(100),
  country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, upper case'),
  currency: currencyCodeSchema,
  timezone: z.string().max(64).refine(isTimeZone, 'Unknown IANA time zone'),
  /** Language of the workspace and of the first emails. */
  defaultLocale: Locale,
});
export type SignupInput = z.infer<typeof SignupSchema>;

export const VerifyEmailSchema = z.object({ token: OneTimeTokenSchema });
export type VerifyEmailInput = z.infer<typeof VerifyEmailSchema>;

export const EmailOnlySchema = z.object({ email: EmailSchema });
export type EmailOnlyInput = z.infer<typeof EmailOnlySchema>;

// ───────────────────────────── login, session, password ─────────────────────────────

/** Login accepts any non-empty password string: the policy applies when one is SET, not when it is used. */
export const LoginSchema = z.object({ email: EmailSchema, password: z.string().min(1).max(1024) });
export type LoginInput = z.infer<typeof LoginSchema>;

export const ResetPasswordSchema = z.object({
  token: OneTimeTokenSchema,
  newPassword: PasswordSchema,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: PasswordSchema,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

export const SwitchTenantSchema = z.object({ tenantId: Id });
export type SwitchTenantInput = z.infer<typeof SwitchTenantSchema>;

export const UserSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

/**
 * `details.reason` of the 403 that login answers (after the CORRECT password) for an address that has not
 * confirmed its email. Shared by the API and the web app, so the two cannot drift apart.
 */
export const EMAIL_NOT_VERIFIED_REASON = 'EMAIL_NOT_VERIFIED';

export const TenantSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']),
  /** ISO 3166-1 alpha-2. */
  country: z.string(),
  /** ISO 4217 code: the web app formats money with its minor units. */
  currency: z.string(),
  /** IANA zone of the tenant (the web app's date fallback until a venue's own zone is available). */
  timezone: z.string(),
  defaultLocale: z.string(),
});
export type TenantSummary = z.infer<typeof TenantSummarySchema>;

/** POST /v1/auth/login: the cookie carries the session; the body says who and where. */
export const LoginResponseSchema = z.object({
  user: UserSummarySchema,
  activeTenantId: z.string().nullable(),
  tenants: z.array(TenantSummarySchema),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** What the caller may do in the active tenant (the same facts the guards use). */
export const AccessSummarySchema = z.object({
  tenantId: z.string(),
  roleName: z.string(),
  permissions: z.array(z.string()),
  venueIds: z.array(z.string()),
  limits: z.object({ maxDiscountPct: z.number() }),
});
export type AccessSummary = z.infer<typeof AccessSummarySchema>;

/** GET /v1/me */
export const MeResponseSchema = z.object({
  user: UserSummarySchema,
  activeTenantId: z.string().nullable(),
  /** Null when no tenant is active, or the membership there is no longer active. */
  access: AccessSummarySchema.nullable(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** GET /v1/me/tenants: the caller's active memberships. */
export const MeTenantsResponseSchema = z.object({
  data: z.array(TenantSummarySchema),
  activeTenantId: z.string().nullable(),
});
export type MeTenantsResponse = z.infer<typeof MeTenantsResponseSchema>;

// ───────────────────────────── invitations ─────────────────────────────

/** POST /v1/auth/invitations/accept: a NEW user accepts (existing accounts use /v1/me/invitations/accept). */
export const AcceptInvitationNewUserSchema = z.object({
  token: OneTimeTokenSchema,
  name: PersonName,
  password: PasswordSchema,
});
export type AcceptInvitationNewUserInput = z.infer<typeof AcceptInvitationNewUserSchema>;

/** POST /v1/me/invitations/accept */
export const AcceptInvitationSchema = z.object({ token: OneTimeTokenSchema });
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;

export const AcceptInvitationResponseSchema = z.object({ tenantId: z.string() });
export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponseSchema>;
