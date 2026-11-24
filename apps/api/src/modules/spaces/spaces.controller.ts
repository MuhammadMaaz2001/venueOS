import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { SpaceDto, SpaceListResponse, SpaceSlotPricesResponse } from '@venueos/shared';
import { Entitlement, RequirePermission } from '../../common/access/access.decorators';
import {
  CreateSpaceDto,
  ReplaceSpaceSlotPricesDto,
  SpaceIdParamDto,
  SpaceListQueryDto,
  SpaceListResponseDto,
  SpaceResponseDto,
  SpaceSlotPricesResponseDto,
  UpdateSpaceDto,
} from './spaces.dto';
import { SpaceSlotPricesService } from './space-slot-prices.service';
import { SpacesService } from './spaces.service';

/** Spaces (halls, lawns, ...) and combined spaces, plus their per-slot rent. Everything needs `venue.manage`. */
@ApiTags('spaces')
@Controller('spaces')
export class SpacesController {
  constructor(
    private readonly spaces: SpacesService,
    private readonly prices: SpaceSlotPricesService,
  ) {}

  @Get()
  @RequirePermission('venue.manage')
  @ApiOperation({ summary: 'List spaces of the venues the caller can see (optionally one venue)' })
  @ApiOkResponse({ type: SpaceListResponseDto })
  list(@Query() query: SpaceListQueryDto): Promise<SpaceListResponse> {
    return this.spaces.list(query.venueId, query.includeInactive === 'true');
  }

  @Post()
  @RequirePermission('venue.manage')
  @Entitlement('maxSpaces')
  @ApiOperation({
    summary: 'Add a space, or a combined space made of existing ones',
    description: '402 at the plan limit. The venue and every component must belong to the tenant.',
  })
  @ApiCreatedResponse({ type: SpaceResponseDto })
  create(@Body() body: CreateSpaceDto): Promise<SpaceDto> {
    return this.spaces.create(body);
  }

  @Get(':id')
  @RequirePermission('venue.manage')
  @ApiOkResponse({ type: SpaceResponseDto })
  get(@Param() params: SpaceIdParamDto): Promise<SpaceDto> {
    return this.spaces.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('venue.manage')
  @ApiOperation({
    summary: 'Edit a space',
    description:
      '`rev` is required. `active: false` is the delete. `componentIds` replaces the components of a combined space.',
  })
  @ApiOkResponse({ type: SpaceResponseDto })
  update(@Param() params: SpaceIdParamDto, @Body() body: UpdateSpaceDto): Promise<SpaceDto> {
    return this.spaces.update(params.id, body);
  }

  @Get(':id/slot-prices')
  @RequirePermission('venue.manage')
  @ApiOperation({ summary: "A space's rent per slot template" })
  @ApiOkResponse({ type: SpaceSlotPricesResponseDto })
  slotPrices(@Param() params: SpaceIdParamDto): Promise<SpaceSlotPricesResponse> {
    return this.prices.list(params.id);
  }

  @Put(':id/slot-prices')
  @RequirePermission('venue.manage')
  @ApiOperation({
    summary: "Replace a space's rent per slot template",
    description:
      "A slot that is not listed has no own price. Slots must belong to the space's venue.",
  })
  @ApiOkResponse({ type: SpaceSlotPricesResponseDto })
  replaceSlotPrices(
    @Param() params: SpaceIdParamDto,
    @Body() body: ReplaceSpaceSlotPricesDto,
  ): Promise<SpaceSlotPricesResponse> {
    return this.prices.replace(params.id, body);
  }
}
