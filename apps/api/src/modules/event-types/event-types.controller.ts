import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { EventTypeDto, EventTypeListResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CreateEventTypeDto,
  EventTypeIdParamDto,
  EventTypeListQueryDto,
  EventTypeListResponseDto,
  EventTypeResponseDto,
  UpdateEventTypeDto,
} from './event-types.dto';
import { EventTypesService } from './event-types.service';

/** Event types (Mehndi, Barat, Walima, ...): tenant-wide. Everything needs `venue.manage`. */
@ApiTags('event-types')
@Controller('event-types')
export class EventTypesController {
  constructor(private readonly eventTypes: EventTypesService) {}

  @Get()
  @RequirePermission('venue.manage')
  @ApiOperation({ summary: 'List the event types of the workspace' })
  @ApiOkResponse({ type: EventTypeListResponseDto })
  list(@Query() query: EventTypeListQueryDto): Promise<EventTypeListResponse> {
    return this.eventTypes.list(query.includeInactive === 'true');
  }

  @Post()
  @RequirePermission('venue.manage')
  @ApiOperation({
    summary: 'Add an event type',
    description: 'Tenant-wide, so only a caller with access to all venues. Names are unique (409).',
  })
  @ApiCreatedResponse({ type: EventTypeResponseDto })
  create(@Body() body: CreateEventTypeDto): Promise<EventTypeDto> {
    return this.eventTypes.create(body);
  }

  @Get(':id')
  @RequirePermission('venue.manage')
  @ApiOkResponse({ type: EventTypeResponseDto })
  get(@Param() params: EventTypeIdParamDto): Promise<EventTypeDto> {
    return this.eventTypes.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('venue.manage')
  @ApiOperation({
    summary: 'Edit an event type',
    description: '`rev` is required. `active: false` is the delete.',
  })
  @ApiOkResponse({ type: EventTypeResponseDto })
  update(
    @Param() params: EventTypeIdParamDto,
    @Body() body: UpdateEventTypeDto,
  ): Promise<EventTypeDto> {
    return this.eventTypes.update(params.id, body);
  }
}
