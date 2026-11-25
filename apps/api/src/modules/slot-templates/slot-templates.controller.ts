import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { SlotTemplateDto, SlotTemplateListResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CreateSlotTemplateDto,
  SlotTemplateIdParamDto,
  SlotTemplateListQueryDto,
  SlotTemplateListResponseDto,
  SlotTemplateResponseDto,
  UpdateSlotTemplateDto,
} from './slot-templates.dto';
import { SlotTemplatesService } from './slot-templates.service';

/** Slot templates per venue: FIXED shifts (Lunch, Dinner), HOURLY, FULL_DAY. Reads need `venue.view`, writes `venue.manage`. */
@ApiTags('slot-templates')
@Controller('slot-templates')
export class SlotTemplatesController {
  constructor(private readonly slots: SlotTemplatesService) {}

  @Get()
  @RequirePermission('venue.view')
  @ApiOperation({ summary: 'List slot templates of the venues the caller can see' })
  @ApiOkResponse({ type: SlotTemplateListResponseDto })
  list(@Query() query: SlotTemplateListQueryDto): Promise<SlotTemplateListResponse> {
    return this.slots.list(query.venueId, query.includeInactive === 'true');
  }

  @Post()
  @RequirePermission('venue.manage')
  @ApiOperation({
    summary: 'Add a slot template to a venue',
    description:
      'FIXED needs start and end. HOURLY defaults to the venue opening hours. FULL_DAY has no times.',
  })
  @ApiCreatedResponse({ type: SlotTemplateResponseDto })
  create(@Body() body: CreateSlotTemplateDto): Promise<SlotTemplateDto> {
    return this.slots.create(body);
  }

  @Get(':id')
  @RequirePermission('venue.view')
  @ApiOkResponse({ type: SlotTemplateResponseDto })
  get(@Param() params: SlotTemplateIdParamDto): Promise<SlotTemplateDto> {
    return this.slots.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('venue.manage')
  @ApiOperation({
    summary: 'Edit a slot template',
    description: '`rev` is required. `active: false` is the delete. Venue and mode are fixed.',
  })
  @ApiOkResponse({ type: SlotTemplateResponseDto })
  update(
    @Param() params: SlotTemplateIdParamDto,
    @Body() body: UpdateSlotTemplateDto,
  ): Promise<SlotTemplateDto> {
    return this.slots.update(params.id, body);
  }
}
