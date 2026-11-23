import { Module } from '@nestjs/common';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { EMAIL_PROVIDER } from './email-provider';
import type { EmailProvider } from './email-provider';
import { EmailSendJob } from './email-send.job';
import { SesEmailProvider } from './ses-email.provider';
import { SmtpEmailProvider } from './smtp-email.provider';

/** Builds the provider named by EMAIL_PROVIDER. The config schema guarantees the matching settings exist. */
export function createEmailProvider(config: WorkerConfig): EmailProvider {
  if (config.EMAIL_PROVIDER === 'ses') {
    return new SesEmailProvider({ region: config.AWS_REGION ?? '' });
  }
  return new SmtpEmailProvider(config.SMTP_URL ?? '');
}

@Module({
  providers: [
    { provide: EMAIL_PROVIDER, inject: [WORKER_CONFIG], useFactory: createEmailProvider },
    EmailSendJob,
  ],
  exports: [EmailSendJob, EMAIL_PROVIDER],
})
export class EmailModule {}
