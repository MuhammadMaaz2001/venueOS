import { Module } from '@nestjs/common';
import { AuthPurgeJob } from '../auth/auth-purge.job';
import { AuthPurgeModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { EmailSendJob } from '../email/email-send.job';
import { DeadLetterCheckJob } from '../ops/dead-letter-check.job';
import { LeadFollowUpNotifyJob } from '../leads/lead-follow-up-notify.job';
import { LeadsFollowUpScanner } from '../leads/leads-follow-up.scanner';
import { LeadsModule } from '../leads/leads.module';
import { OpsModule } from '../ops/ops.module';
import { PdfRenderJob } from '../pdf/pdf-render.job';
import { PdfModule } from '../pdf/pdf.module';
import { QueueModule } from '../queue/queue.module';
import { ScannersModule } from '../scanners/scanners.module';
import { JOBS, JobRunner } from './job-runner';
import { ScheduleRegistrar } from './schedule-registrar';

/**
 * Every job this worker runs. The runner registers each with pg-boss; the registrar schedules the ones that
 * declare a `schedule`. Add a job: provide it in its module, export it, and add its class here (and its queue
 * in a migration). Scanners are listed here too, next to `ScannersModule` which gives them their connection.
 */
export const BASE_JOBS = [
  EmailSendJob,
  AuthPurgeJob,
  PdfRenderJob,
  DeadLetterCheckJob,
  LeadsFollowUpScanner,
  LeadFollowUpNotifyJob,
] as const;

@Module({
  imports: [
    QueueModule,
    ScannersModule,
    EmailModule,
    AuthPurgeModule,
    OpsModule,
    PdfModule,
    LeadsModule,
  ],
  providers: [
    { provide: JOBS, inject: [...BASE_JOBS], useFactory: (...jobs: unknown[]) => jobs },
    JobRunner,
    ScheduleRegistrar,
  ],
})
export class JobsModule {}
