import { Injectable } from '@nestjs/common';
import { AuthDb } from '@venueos/db';
import { PinoLogger } from 'nestjs-pino';
import {
  MAIL_EMAIL_WINDOW_MS,
  MAIL_IP_WINDOW_MS,
  MAIL_REQUESTS_PER_EMAIL,
  MAIL_REQUESTS_PER_IP,
  hashEmail,
} from './auth.constants';

export type MailRequestKind = 'signup' | 'resend_verification' | 'password_forgot';

/** `kind` of a row that was refused: it counts toward the IP limit, not toward the email limit. */
const LIMITED = 'limited';

/**
 * Abuse limits of the endpoints that make us send an email (docs/04-security.md section 5): at most 3 emails
 * per email address per hour and 20 requests per IP per 15 minutes, counted in `auth_requests` so they hold
 * across API instances. The caller answers the SAME generic response whether or not the request was
 * allowed, and sends nothing when it was not (no enumeration, no mail bombing).
 *
 * Refused requests are recorded too, but only count toward the IP limit: someone hammering an address
 * cannot extend the lock on that address beyond the hour of the three requests that were allowed.
 */
@Injectable()
export class AbuseLimitsService {
  constructor(
    private readonly authDb: AuthDb,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AbuseLimitsService.name);
  }

  /** Record the request and say whether it may send an email. */
  async allow(kind: MailRequestKind, email: string, ip: string | undefined): Promise<boolean> {
    const emailHash = hashEmail(email);
    const now = Date.now();
    const { authRequest } = this.authDb.client;

    const [forEmail, forIp] = await Promise.all([
      authRequest.count({
        where: {
          emailHash,
          kind: { not: LIMITED },
          createdAt: { gte: new Date(now - MAIL_EMAIL_WINDOW_MS) },
        },
      }),
      ip
        ? authRequest.count({
            where: { ip, createdAt: { gte: new Date(now - MAIL_IP_WINDOW_MS) } },
          })
        : Promise.resolve(0),
    ]);

    const allowed = forEmail < MAIL_REQUESTS_PER_EMAIL && forIp < MAIL_REQUESTS_PER_IP;
    await authRequest.create({
      data: { kind: allowed ? kind : LIMITED, emailHash, ip: ip ?? null },
    });
    if (!allowed) {
      // The hash prefix lets operators correlate; the address itself is never logged.
      this.logger.warn(
        {
          kind,
          emailHashPrefix: emailHash.slice(0, 8),
          reason: forEmail >= MAIL_REQUESTS_PER_EMAIL ? 'email' : 'ip',
        },
        'Auth mail request over the limit: answered generically, nothing sent',
      );
    }
    return allowed;
  }
}
