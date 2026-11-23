import { Body, Controller, Delete, Get, Patch, Post, Put } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Public } from '../../common/access/access.decorators';
import { NotFoundError } from '../../common/errors/domain-errors';

// Test-only controller mounted by the integration tests; it is not part of the application.

const EchoSchema = z.object({
  name: z.string().min(1).max(50),
  guests: z.number().int().min(1).max(100_000),
});
class EchoDto extends createZodDto(EchoSchema) {}

@Public()
@Controller('_probe')
export class ProbeController {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
  ) {}

  @Post('echo')
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }

  @Get('not-found')
  notFound(): never {
    throw new NotFoundError();
  }

  @Get('boom')
  boom(): never {
    throw new Error(
      'connect ECONNREFUSED postgresql://venueos_app:hunter2@db.internal:5432/venueos',
    );
  }

  /** What Prisma + the pg driver adapter raise when the exclusion constraint fires. */
  @Get('slot-taken')
  slotTaken(): never {
    const cause = Object.assign(new Error('conflicting key value violates exclusion constraint'), {
      code: '23P01',
      constraint: 'space_occupancies_no_overlap',
    });
    throw Object.assign(new Error('Invalid `tx.$executeRaw()` invocation'), { cause });
  }

  /** Stands in for the P0-4 / P0-5 guards that fill the context. */
  @Get('context')
  context(): { ok: true } {
    this.cls.set('tenantId', 'tenant_probe');
    this.cls.set('userId', 'user_probe');
    this.logger.info('inside request');
    return { ok: true };
  }

  @Post('log-sensitive')
  logSensitive(): { ok: true } {
    this.logger.info(
      {
        password: 'pw-top-level',
        user: {
          email: 'nested@example.test',
          profile: { phone: '+923001234567', cnic: '35202-1234567-1' },
        },
        list: [{ token: 'tok-in-array' }],
        headers: {
          authorization: 'Bearer abc.def.ghi',
          cookie: '__Host-vos_session=sess-secret',
          'set-cookie': ['sid=cookie-secret'],
        },
        body: { note: 'body-secret' },
      },
      'probe log',
    );
    return { ok: true };
  }

  // One handler per method: stacked method decorators would keep only the last one.
  @Post('csrf')
  csrfPost(): { ok: true } {
    return { ok: true };
  }

  @Patch('csrf')
  csrfPatch(): { ok: true } {
    return { ok: true };
  }

  @Put('csrf')
  csrfPut(): { ok: true } {
    return { ok: true };
  }

  @Delete('csrf')
  csrfDelete(): { ok: true } {
    return { ok: true };
  }
}
