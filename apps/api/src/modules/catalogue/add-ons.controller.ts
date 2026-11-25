import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AddOnDto, AddOnListResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  AddOnListQueryDto,
  AddOnListResponseDto,
  AddOnResponseDto,
  CatalogueIdParamDto,
  CreateAddOnDto,
  UpdateAddOnDto,
} from './catalogue.dto';
import { AddOnsService } from './add-ons.service';

/** Add-ons (FIXED / PER_HEAD / PER_HOUR / PER_UNIT): tenant-wide. Reads need `catalogue.view`, writes `catalogue.manage`. */
@ApiTags('add-ons')
@Controller('add-ons')
export class AddOnsController {
  constructor(private readonly addOns: AddOnsService) {}

  @Get()
  @RequirePermission('catalogue.view')
  @ApiOperation({
    summary: 'List the add-ons of the workspace',
    description:
      '`price` is `null` unless the caller has `catalogue.manage` or `booking.view_prices`.',
  })
  @ApiOkResponse({ type: AddOnListResponseDto })
  list(@Query() query: AddOnListQueryDto): Promise<AddOnListResponse> {
    return this.addOns.list(query.includeInactive === 'true');
  }

  @Post()
  @RequirePermission('catalogue.manage')
  @ApiOperation({
    summary: 'Add an add-on',
    description: 'Tenant-wide. Names are unique among active add-ons (409).',
  })
  @ApiCreatedResponse({ type: AddOnResponseDto })
  create(@Body() body: CreateAddOnDto): Promise<AddOnDto> {
    return this.addOns.create(body);
  }

  @Get(':id')
  @RequirePermission('catalogue.view')
  @ApiOkResponse({ type: AddOnResponseDto })
  get(@Param() params: CatalogueIdParamDto): Promise<AddOnDto> {
    return this.addOns.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('catalogue.manage')
  @ApiOperation({
    summary: 'Edit an add-on',
    description: '`rev` is required. `active: false` is the delete.',
  })
  @ApiOkResponse({ type: AddOnResponseDto })
  update(@Param() params: CatalogueIdParamDto, @Body() body: UpdateAddOnDto): Promise<AddOnDto> {
    return this.addOns.update(params.id, body);
  }
}
