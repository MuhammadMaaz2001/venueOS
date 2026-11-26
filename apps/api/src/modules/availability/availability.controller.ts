import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AvailabilityDto } from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';
import { AvailabilityQuerySchema, AvailabilitySchema } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import { AvailabilityService } from './availability.service';

class AvailabilityQueryDto extends createZodDto(AvailabilityQuerySchema) {}
class AvailabilityResponseDto extends createZodDto(AvailabilitySchema) {}

/** The availability calendar (docs/01 module 6). */
@ApiTags('availability')
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @RequirePermission('booking.view')
  @ApiOperation({
    summary: 'Spaces x dates x slots of a venue: what is held or confirmed',
    description:
      'Up to 62 days. Only taken cells are listed; every other cell of the grid is free. Each taken cell names the booking number and the customer (no prices). A combined space is taken when any component is, and the other way round. A venue outside the caller scope is 404.',
  })
  @ApiOkResponse({ type: AvailabilityResponseDto })
  get(@Query() query: AvailabilityQueryDto): Promise<AvailabilityDto> {
    return this.availability.get(query);
  }
}
