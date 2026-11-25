import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MenuItemDto, MenuItemListResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CatalogueIdParamDto,
  CreateMenuItemDto,
  MenuItemListQueryDto,
  MenuItemListResponseDto,
  MenuItemResponseDto,
  UpdateMenuItemDto,
} from './catalogue.dto';
import { MenuItemsService } from './menu-items.service';

/** Menu items (dishes): tenant-wide. Reads need `catalogue.view`, writes `catalogue.manage`. */
@ApiTags('menu-items')
@Controller('menu-items')
export class MenuItemsController {
  constructor(private readonly menuItems: MenuItemsService) {}

  @Get()
  @RequirePermission('catalogue.view')
  @ApiOperation({ summary: 'List the menu items of the workspace' })
  @ApiOkResponse({ type: MenuItemListResponseDto })
  list(@Query() query: MenuItemListQueryDto): Promise<MenuItemListResponse> {
    return this.menuItems.list(query.includeInactive === 'true', query.category);
  }

  @Post()
  @RequirePermission('catalogue.manage')
  @ApiOperation({
    summary: 'Add a menu item',
    description:
      'Tenant-wide, so only a caller with access to all venues. Names are unique among active items (409).',
  })
  @ApiCreatedResponse({ type: MenuItemResponseDto })
  create(@Body() body: CreateMenuItemDto): Promise<MenuItemDto> {
    return this.menuItems.create(body);
  }

  @Get(':id')
  @RequirePermission('catalogue.view')
  @ApiOkResponse({ type: MenuItemResponseDto })
  get(@Param() params: CatalogueIdParamDto): Promise<MenuItemDto> {
    return this.menuItems.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('catalogue.manage')
  @ApiOperation({
    summary: 'Edit a menu item',
    description: '`rev` is required. `active: false` is the delete.',
  })
  @ApiOkResponse({ type: MenuItemResponseDto })
  update(
    @Param() params: CatalogueIdParamDto,
    @Body() body: UpdateMenuItemDto,
  ): Promise<MenuItemDto> {
    return this.menuItems.update(params.id, body);
  }
}
