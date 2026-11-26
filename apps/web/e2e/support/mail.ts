import { WEB_URL, escapeRegExp } from './stack';

/** Reading the emails the worker sent, from Mailpit's HTTP API (docker compose: SMTP :1025, HTTP :8025). */
const MAILPIT = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';

interface MailpitMessage {
  ID: string;
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${MAILPIT}${path}`);
  if (!response.ok) throw new Error(`Mailpit ${path}: ${response.status}`);
  return (await response.json()) as T;
}

/**
 * The first link matching `pattern` in an email to `to`, waiting for the worker to send it. `pattern` must
 * match the whole URL (see `LINK`).
 */
export async function linkFromMail(
  to: string,
  pattern: RegExp,
  timeoutMs = 90_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await json<{ messages?: MailpitMessage[] }>(
      `/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
    );
    for (const message of found.messages ?? []) {
      const full = await json<{ Text?: string; HTML?: string }>(`/api/v1/message/${message.ID}`);
      const body = `${full.Text ?? ''}\n${full.HTML ?? ''}`.replaceAll('&amp;', '&');
      const match = pattern.exec(body);
      if (match) return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `No email to ${to} with a link matching ${String(pattern)} within ${timeoutMs} ms`,
  );
}

/** The links in the emails start with APP_ORIGIN of the API and worker, which is the web address under test. */
const link = (route: string): RegExp =>
  new RegExp(`${escapeRegExp(WEB_URL)}/${route}\\?token=[\\w-]+`);

export const LINK = {
  verify: link('verify-email'),
  invite: link('accept-invite'),
  reset: link('reset-password'),
} as const;

/** A fresh address per run: the database keeps users of earlier runs. */
export function uniqueEmail(prefix: string): string {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `e2e-${prefix}-${stamp}@example.test`;
}

export interface MailWithAttachments {
  subject: string;
  attachments: { fileName: string; contentType: string; size: number }[];
}

/** The first email to `to` that has an attachment (the quotation PDF), waiting for the worker to send it. */
export async function mailWithAttachment(
  to: string,
  timeoutMs = 90_000,
): Promise<MailWithAttachments> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await json<{ messages?: MailpitMessage[] }>(
      `/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
    );
    for (const message of found.messages ?? []) {
      const full = await json<{
        Subject?: string;
        Attachments?: { FileName: string; ContentType: string; Size: number }[];
      }>(`/api/v1/message/${message.ID}`);
      if ((full.Attachments ?? []).length > 0) {
        return {
          subject: full.Subject ?? '',
          attachments: (full.Attachments ?? []).map((a) => ({
            fileName: a.FileName,
            contentType: a.ContentType,
            size: a.Size,
          })),
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No email with an attachment to ${to} within ${timeoutMs} ms`);
}

export interface MailSummary {
  subject: string;
  text: string;
  attachments: { fileName: string; contentType: string }[];
}

/** Every email sent to `to` so far, newest first. */
export async function mailsTo(to: string): Promise<MailSummary[]> {
  const found = await json<{ messages?: MailpitMessage[] }>(
    `/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
  );
  const out: MailSummary[] = [];
  for (const message of found.messages ?? []) {
    const full = await json<{
      Subject?: string;
      Text?: string;
      Attachments?: { FileName: string; ContentType: string }[];
    }>(`/api/v1/message/${message.ID}`);
    out.push({
      subject: full.Subject ?? '',
      text: full.Text ?? '',
      attachments: (full.Attachments ?? []).map((a) => ({
        fileName: a.FileName,
        contentType: a.ContentType,
      })),
    });
  }
  return out;
}

/** Waits until at least `count` emails to `to` have a subject starting with `prefix`; returns them. */
export async function waitForMails(
  to: string,
  prefix: string,
  count: number,
  timeoutMs = 90_000,
): Promise<MailSummary[]> {
  const deadline = Date.now() + timeoutMs;
  let last: MailSummary[] = [];
  while (Date.now() < deadline) {
    last = (await mailsTo(to)).filter((m) => m.subject.startsWith(prefix));
    if (last.length >= count) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Expected ${count} email(s) "${prefix}..." to ${to}, found ${last.length}`);
}
