import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { ScannerDb } from './scanner-db';

/** The `venueos_jobs` read connection for scanners. Scanner classes themselves are listed in `JobsModule`. */
@Module({
  imports: [QueueModule],
  providers: [ScannerDb],
  exports: [ScannerDb, QueueModule],
})
export class ScannersModule {}
