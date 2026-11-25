import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PackageDto, PackageListResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CatalogueIdParamDto,
  CreatePackageDto,
  PackageListQueryDto,
  PackageListResponseDto,
  PackageResponseDto,
  UpdatePackageDto,
} from './catalogue.dto';
import { PackagesService } from './packages.service';

/** Per-head packages with their dishes: tenant-wide. Reads need `catalogue.view`, writes `catalogue.manage`. */
@ApiTags('packages')
@Controller('packages')
export class PackagesController {
  constructor(private readonly packages: PackagesService) {}

  @Get()
  @RequirePermission('catalogue.view')
  @ApiOperation({
    summary: 'List the packages of the workspace',
    description:
      '`perHeadRate` is `null` unless the caller has `catalogue.manage` or `booking.view_prices`.',
  })
  @ApiOkResponse({ type: PackageListResponseDto })
  list(@Query() query: PackageListQueryDto): Promise<PackageListResponse> {
    return this.packages.list(query.includeInactive === 'true');
  }

  @Post()
  @RequirePermission('catalogue.manage')
  @ApiOperation({
    summary: 'Add a package',
    description:
      'Tenant-wide. The dishes must be active menu items of the workspace (404 / 400). Names are unique among active packages (409).',
  })
  @ApiCreatedResponse({ type: PackageResponseDto })
  create(@Body() body: CreatePackageDto): Promise<PackageDto> {
    return this.packages.create(body);
  }

  @Get(':id')
  @RequirePermission('catalogue.view')
  @ApiOkResponse({ type: PackageResponseDto })
  get(@Param() params: CatalogueIdParamDto): Promise<PackageDto> {
    return this.packages.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('catalogue.manage')
  @ApiOperation({
    summary: 'Edit a package',
    description:
      '`rev` is required. `items`, when sent, replaces the whole dish list. `active: false` is the delete. Existing bookings keep their frozen prices.',
  })
  @ApiOkResponse({ type: PackageResponseDto })
  update(
    @Param() params: CatalogueIdParamDto,
    @Body() body: UpdatePackageDto,
  ): Promise<PackageDto> {
    return this.packages.update(params.id, body);
  }
}
