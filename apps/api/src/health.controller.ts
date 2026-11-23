import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

// Liveness only. The readiness check (DB + queue) is added with the API foundation (P0-3).
// Public on purpose: it is mounted outside /v1 and reveals nothing. Once the guard stack
// exists (P0-5) this handler gets an explicit @Public() like every other open endpoint.
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOkResponse({ description: 'The process is up', schema: { example: { status: 'ok' } } })
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
