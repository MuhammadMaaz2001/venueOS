import { Global, Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { JobQueue } from '@venueos/db';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config.module';
import { EmailOutbox } from './email-outbox.service';

/**
 * Enqueue side of the background jobs. The API only ever INSERTS jobs, and only with the business
 * transaction (`venueos_app` can enqueue; it cannot fetch, update or delete jobs). The worker runs them.
 */
@Global()
@Module({
  providers: [
    {
      provide: JobQueue,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new JobQueue({ connectionString: config.DATABASE_URL }),
    },
    EmailOutbox,
  ],
  exports: [JobQueue, EmailOutbox],
})
export class JobsModule implements OnApplicationShutdown {
  constructor(@Inject(JobQueue) private readonly queue: JobQueue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
