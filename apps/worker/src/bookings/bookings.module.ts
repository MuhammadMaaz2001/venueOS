import { Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { JobQueue } from '@venueos/db';
import { WORKER_CONFIG } from '../config/config.module';
import type { WorkerConfig } from '../config/config.module';
import { ScannersModule } from '../scanners/scanners.module';
import {
  BOOKINGS_JOB_QUEUE,
  BookingCompleteRunJob,
  BookingsCompleteScanner,
  HoldExpireRunJob,
  HoldWarnRunJob,
  HoldsScanner,
} from './hold-jobs';

/**
 * Modules 6-8 in the worker: the hold scanner (`holds.expire`) with the expire and warn jobs, and the hourly completion of
 * finished bookings. The `JobQueue` is the enqueue-only one the API uses (`venueos_app`): the jobs queue their emails
 * with it in the same transaction as the change.
 */
@Module({
  imports: [ScannersModule],
  providers: [
    {
      provide: BOOKINGS_JOB_QUEUE,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => new JobQueue({ connectionString: config.DATABASE_URL }),
    },
    HoldsScanner,
    BookingsCompleteScanner,
    HoldExpireRunJob,
    HoldWarnRunJob,
    BookingCompleteRunJob,
  ],
  exports: [
    HoldsScanner,
    BookingsCompleteScanner,
    HoldExpireRunJob,
    HoldWarnRunJob,
    BookingCompleteRunJob,
  ],
})
export class WorkerBookingsModule implements OnApplicationShutdown {
  constructor(@Inject(BOOKINGS_JOB_QUEUE) private readonly queue: JobQueue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
