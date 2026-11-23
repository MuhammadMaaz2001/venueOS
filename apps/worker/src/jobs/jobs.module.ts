import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { EmailSendJob } from '../email/email-send.job';
import { QueueModule } from '../queue/queue.module';
import { JOBS, JobRunner } from './job-runner';

// Add a job here and in `JOBS` below; the runner registers every listed job with pg-boss.
@Module({
  imports: [QueueModule, EmailModule],
  providers: [
    { provide: JOBS, inject: [EmailSendJob], useFactory: (...jobs: unknown[]) => jobs },
    JobRunner,
  ],
})
export class JobsModule {}
