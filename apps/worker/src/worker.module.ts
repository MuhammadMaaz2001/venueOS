import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { JobsModule } from './jobs/jobs.module';
import { LoggingModule } from './logging/logging.module';

// Jobs are registered in JobsModule (email.send now; reminders, scanners and PDFs in later tasks).
@Module({
  imports: [ConfigModule, LoggingModule, DbModule, JobsModule],
})
export class WorkerModule {}
