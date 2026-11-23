import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { HealthResponse, ReadyResponse } from '@venueos/shared';
import type { Response } from 'express';
import { Public } from '../common/access/access.decorators';
import { DatabaseHealthService } from './database-health.service';
import { HealthResponseDto, ReadyResponseDto } from './health.dto';
import { QueueHealthService } from './queue-health.service';

// Mounted outside /v1 (see configure-app.ts). Public on purpose: they reveal nothing, and the load
// balancer and orchestrator call them without a session. Not rate limited so probes never get a 429.
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly database: DatabaseHealthService,
    private readonly queue: QueueHealthService,
  ) {}

  /** Liveness: the process is up and serving requests. Checks no dependency. */
  @Get()
  @ApiOkResponse({ description: 'The process is up', type: HealthResponseDto })
  check(): HealthResponse {
    return { status: 'ok' };
  }

  /** Readiness: dependencies are reachable (the database, and the job queue's pg-boss schema). */
  @Get('ready')
  @ApiOkResponse({ description: 'Ready to serve traffic', type: ReadyResponseDto })
  @ApiServiceUnavailableResponse({ description: 'A dependency is down', type: ReadyResponseDto })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadyResponse> {
    const [databaseUp, queueUp] = await Promise.all([this.database.isUp(), this.queue.isUp()]);
    const ok = databaseUp && queueUp;
    if (!ok) res.status(503);
    return {
      status: ok ? 'ok' : 'unavailable',
      checks: { database: databaseUp ? 'up' : 'down', queue: queueUp ? 'up' : 'down' },
    };
  }
}
