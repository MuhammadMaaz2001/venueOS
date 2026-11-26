import { Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { JobQueue } from '@venueos/db';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { ScannersModule } from '../scanners/scanners.module';
import { PAYMENTS_JOB_QUEUE, PaymentDueRunJob, PaymentDueScanner } from './payment-due';

/** Module 9 in the worker: the payment-due reminder (scanner and per-item job). The receipt document is a `pdf.render` kind. */
@Module({
  imports: [ScannersModule],
  providers: [
    {
      provide: PAYMENTS_JOB_QUEUE,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => new JobQueue({ connectionString: config.DATABASE_URL }),
    },
    PaymentDueScanner,
    PaymentDueRunJob,
  ],
  exports: [PaymentDueScanner, PaymentDueRunJob],
})
export class WorkerPaymentsModule implements OnApplicationShutdown {
  constructor(@Inject(PAYMENTS_JOB_QUEUE) private readonly queue: JobQueue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
