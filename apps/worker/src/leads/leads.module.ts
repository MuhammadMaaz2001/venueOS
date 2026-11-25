import { Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { JobQueue } from '@venueos/db';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { ScannersModule } from '../scanners/scanners.module';
import { LEADS_JOB_QUEUE, LeadFollowUpNotifyJob } from './lead-follow-up-notify.job';
import { LeadsFollowUpScanner } from './leads-follow-up.scanner';

/**
 * Module 5's jobs: the follow-up scanner (`venueos_jobs`, ids only) and the per-lead notify job (`venueos_app`, inside
 * the tenant). The `JobQueue` is the same enqueue-only queue the API uses (`venueos_app` can insert jobs, not run them);
 * the notify job sends its email through it in the same transaction as the lead's "notified" stamp.
 */
@Module({
  imports: [ScannersModule],
  providers: [
    {
      provide: LEADS_JOB_QUEUE,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => new JobQueue({ connectionString: config.DATABASE_URL }),
    },
    LeadsFollowUpScanner,
    LeadFollowUpNotifyJob,
  ],
  exports: [LeadsFollowUpScanner, LeadFollowUpNotifyJob],
})
export class LeadsModule implements OnApplicationShutdown {
  constructor(@Inject(LEADS_JOB_QUEUE) private readonly queue: JobQueue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
