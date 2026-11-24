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
 * match the whole URL, e.g. /http:\/\/localhost:3000\/verify-email\?token=[\w-]+/.
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

export const LINK = {
  verify: /http:\/\/localhost:3000\/verify-email\?token=[\w-]+/,
  invite: /http:\/\/localhost:3000\/accept-invite\?token=[\w-]+/,
  reset: /http:\/\/localhost:3000\/reset-password\?token=[\w-]+/,
} as const;

/** A fresh address per run: the database keeps users of earlier runs. */
export function uniqueEmail(prefix: string): string {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return `e2e-${prefix}-${stamp}@example.test`;
}
