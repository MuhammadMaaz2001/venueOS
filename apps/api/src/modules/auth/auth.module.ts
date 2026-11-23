import { Global, Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { AuthDb } from '@venueos/db';
import { AuthContextProvider } from '../../common/access/auth-context.provider';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import { AbuseLimitsService } from './abuse-limits.service';
import { AuthController } from './auth.controller';
import { AuthMailer } from './auth-mailer.service';
import { AuthService } from './auth.service';
import { InvitationAcceptController, InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { PasswordService } from './password.service';
import { SessionAuthContextProvider } from './session-auth-context.provider';
import { SessionService } from './session.service';

/**
 * Authentication: accounts, sessions, password reset, invitations, "who am I". This module ALONE holds the
 * AuthDb connection (role venueos_auth): the auth tables are invisible to every other code path
 * (CLAUDE.md rule 1). It provides the AuthContextProvider that AuthGuard asks "who is calling?".
 */
@Global()
@Module({
  controllers: [AuthController, MeController, InvitationsController, InvitationAcceptController],
  providers: [
    {
      provide: AuthDb,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new AuthDb({ connectionString: config.AUTH_DATABASE_URL }),
    },
    { provide: AuthContextProvider, useClass: SessionAuthContextProvider },
    PasswordService,
    SessionService,
    AbuseLimitsService,
    AuthMailer,
    MeService,
    AuthService,
    InvitationsService,
  ],
  exports: [AuthContextProvider],
})
export class AuthModule implements OnApplicationShutdown {
  constructor(@Inject(AuthDb) private readonly authDb: AuthDb) {}

  async onApplicationShutdown(): Promise<void> {
    await this.authDb.close();
  }
}
