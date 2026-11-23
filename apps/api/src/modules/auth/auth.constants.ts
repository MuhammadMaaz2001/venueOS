import { createHash, randomBytes } from 'node:crypto';

// Numbers of docs/04-security.md section 1. Change them there first.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SESSION_COOKIE_NAME = '__Host-vos_session';
/** 12 h without a request ends a session. */
export const SESSION_IDLE_MS = 12 * HOUR;
/** 30 days after login ends it whatever happens. */
export const SESSION_ABSOLUTE_MS = 30 * DAY;
/** `last_seen_at` is written at most this often (one UPDATE per request would be wasteful). */
export const SESSION_TOUCH_INTERVAL_MS = MINUTE;

export const LOGIN_WINDOW_MS = 15 * MINUTE;
/** Failed logins per email hash inside the window that lock the account. */
export const LOGIN_MAX_FAILURES_PER_EMAIL = 5;
export const LOGIN_LOCK_MS = 15 * MINUTE;
/** Login attempts (any outcome) per IP inside the window before answering 429. */
export const LOGIN_MAX_ATTEMPTS_PER_IP = 20;

/** Limits of the endpoints that send email (signup, resend-verification, password/forgot). */
export const MAIL_REQUESTS_PER_EMAIL = 3;
export const MAIL_EMAIL_WINDOW_MS = HOUR;
export const MAIL_REQUESTS_PER_IP = 20;
export const MAIL_IP_WINDOW_MS = 15 * MINUTE;

export const EMAIL_VERIFY_TTL_MS = 24 * HOUR;
export const PASSWORD_RESET_TTL_MS = 30 * MINUTE;
export const INVITATION_TTL_MS = 72 * HOUR;
export const TRIAL_DAYS = 14;
export const TRIAL_PLAN_CODE = 'starter';

/** A random one-time secret: base64url of 32 bytes (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored of a token (session, one-time token, invitation): the SHA-256 hash, never the token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** What `login_attempts` / `auth_requests` store of an email: a hash of the normalized address. */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}
