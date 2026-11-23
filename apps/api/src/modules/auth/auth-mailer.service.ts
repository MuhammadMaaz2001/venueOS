import { Inject, Injectable } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { EnqueueEmailInput } from '@venueos/shared';
import { PinoLogger } from 'nestjs-pino';
import { EmailOutbox } from '../../common/jobs/email-outbox.service';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import { EMAIL_VERIFY_TTL_MS, PASSWORD_RESET_TTL_MS } from './auth.constants';

const HOUR = 3_600_000;
const MINUTE = 60_000;

export interface MailRecipient {
  userId: string;
  email: string;
  name: string;
}

/**
 * The account emails (verification, "account exists", password reset). The `message_logs` row is
 * tenant-scoped (RLS), so a mail with no session belongs to the user's OLDEST membership's tenant (the new
 * tenant for a signup); a user without any membership gets nothing (the caller still answers generically).
 * The tenant id always comes from the database, never from the request. Links that carry a token are sealed
 * secret variables (docs/04-security.md section 6); the sender name is the product's (template metadata).
 */
@Injectable()
export class AuthMailer {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly outbox: EmailOutbox,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthMailer.name);
  }

  private url(path: string, token?: string): string {
    return `${this.config.APP_ORIGIN}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  }

  verificationMail(to: MailRecipient, locale: string, token: string): EnqueueEmailInput {
    return {
      to: to.email,
      template: 'auth.verify-email',
      locale,
      vars: { name: to.name, hours: EMAIL_VERIFY_TTL_MS / HOUR },
      secretVars: { verifyUrl: this.url('/verify-email', token) },
      event: 'auth.verify_email',
      entityType: 'user',
      entityId: to.userId,
    };
  }

  private accountExistsMail(to: MailRecipient, locale: string): EnqueueEmailInput {
    return {
      to: to.email,
      template: 'auth.account-exists',
      locale,
      vars: { loginUrl: this.url('/login'), forgotUrl: this.url('/forgot-password') },
      event: 'auth.account_exists',
      entityType: 'user',
      entityId: to.userId,
    };
  }

  private passwordResetMail(to: MailRecipient, locale: string, token: string): EnqueueEmailInput {
    return {
      to: to.email,
      template: 'auth.password-reset',
      locale,
      vars: { name: to.name, minutes: PASSWORD_RESET_TTL_MS / MINUTE },
      secretVars: { resetUrl: this.url('/reset-password', token) },
      event: 'auth.password_reset',
      entityType: 'user',
      entityId: to.userId,
    };
  }

  /** The tenant that owns this user's pre-session mail, and the language to write in. */
  private async mailboxOf(
    userId: string,
  ): Promise<{ tenantId: string; locale: string } | undefined> {
    return this.tenantDb.asUser(userId, async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { tenantId: true, tenant: { select: { defaultLocale: true } } },
      });
      return membership
        ? { tenantId: membership.tenantId, locale: membership.tenant.defaultLocale }
        : undefined;
    });
  }

  private async send(
    to: MailRecipient,
    kind: string,
    build: (locale: string) => EnqueueEmailInput,
  ): Promise<void> {
    const mailbox = await this.mailboxOf(to.userId);
    if (!mailbox) {
      this.logger.warn({ kind }, 'Account mail not sent: the user has no workspace to log it in');
      return;
    }
    await this.tenantDb.tx({ tenantId: mailbox.tenantId, userId: to.userId }, (tx) =>
      this.outbox.enqueueForTenant(tx, mailbox.tenantId, build(mailbox.locale)),
    );
  }

  sendVerification(to: MailRecipient, token: string): Promise<void> {
    return this.send(to, 'verify_email', (locale) => this.verificationMail(to, locale, token));
  }

  sendAccountExists(to: MailRecipient): Promise<void> {
    return this.send(to, 'account_exists', (locale) => this.accountExistsMail(to, locale));
  }

  sendPasswordReset(to: MailRecipient, token: string): Promise<void> {
    return this.send(to, 'password_reset', (locale) => this.passwordResetMail(to, locale, token));
  }
}
