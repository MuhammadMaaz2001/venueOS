import { Module } from '@nestjs/common';
import { DatabaseHealthService } from './database-health.service';
import { HealthController } from './health.controller';
import { QueueHealthService } from './queue-health.service';

@Module({
  controllers: [HealthController],
  providers: [DatabaseHealthService, QueueHealthService],
})
export class HealthModule {}
