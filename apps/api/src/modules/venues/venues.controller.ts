import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { VenueDto, VenueListResponse } from '@venueos/shared';
import { Entitlement, RequirePermission } from '../../common/access/access.decorators';
import {
  CreateVenueDto,
  UpdateVenueDto,
  VenueIdParamDto,
  VenueListQueryDto,
  VenueListResponseDto,
  VenueResponseDto,
} from './venues.dto';
import { VenuesService } from './venues.service';

/** Venues / branches (docs/01 module 1). Reads need `venue.view`, writes `venue.manage`; the caller's venue scope applies. */
@ApiTags('venues')
@Controller('venues')
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  @Get()
  @RequirePermission('venue.view')
  @ApiOperation({ summary: 'List the venues the caller can see (active ones unless asked)' })
  @ApiOkResponse({ type: VenueListResponseDto })
  list(@Query() query: VenueListQueryDto): Promise<VenueListResponse> {
    return this.venues.list(query.includeInactive === 'true');
  }

  @Post()
  @RequirePermission('venue.manage')
  @Entitlement('maxVenues')
  @ApiOperation({
    summary: 'Add a venue',
    description: 'Only a caller with access to all venues. 402 at the plan limit.',
  })
  @ApiCreatedResponse({ type: VenueResponseDto })
  create(@Body() body: CreateVenueDto): Promise<VenueDto> {
    return this.venues.create(body);
  }

  @Get(':id')
  @RequirePermission('venue.view')
  @ApiOkResponse({ type: VenueResponseDto })
  get(@Param() params: VenueIdParamDto): Promise<VenueDto> {
    return this.venues.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('venue.manage')
  @ApiOperation({
    summary: 'Edit a venue',
    description:
      '`rev` is required (409 VERSION_CONFLICT when stale). `active: false` is the delete.',
  })
  @ApiOkResponse({ type: VenueResponseDto })
  update(@Param() params: VenueIdParamDto, @Body() body: UpdateVenueDto): Promise<VenueDto> {
    return this.venues.update(params.id, body);
  }
}
