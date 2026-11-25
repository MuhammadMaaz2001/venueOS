import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RoleDto, RoleListResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CreateRoleDto,
  RoleResponseDto,
  RoleIdParamDto,
  RoleListQueryDto,
  RoleListResponseDto,
  UpdateRoleDto,
} from './roles.dto';
import { RolesService } from './roles.service';

/** Role administration (docs/04-security.md section 2). Every endpoint needs `role.manage`. */
@ApiTags('roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('role.manage')
  @ApiOperation({
    summary: 'List the roles of the current tenant',
    description: 'Active roles unless `status=retired` or `status=all` is given.',
  })
  @ApiOkResponse({ type: RoleListResponseDto })
  list(@Query() query: RoleListQueryDto): Promise<RoleListResponse> {
    return this.roles.list(query);
  }

  @Get(':id')
  @RequirePermission('role.manage')
  @ApiOkResponse({ type: RoleResponseDto })
  get(@Param() params: RoleIdParamDto): Promise<RoleDto> {
    return this.roles.get(params.id);
  }

  @Post()
  @RequirePermission('role.manage')
  @ApiOperation({ summary: 'Create a custom role as a copy of an existing one' })
  @ApiCreatedResponse({ type: RoleResponseDto })
  create(@Body() body: CreateRoleDto): Promise<RoleDto> {
    return this.roles.create(body);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('role.manage')
  @ApiOperation({
    summary: 'Edit a role: name (custom roles only), permissions, limits; retire or restore it',
    description:
      '`active: false` retires a custom role that has no active members (422 otherwise); a retired role is frozen until `active: true`. A role that holds `<area>.manage` must hold `<area>.view` where it exists (400).',
  })
  @ApiOkResponse({ type: RoleResponseDto })
  update(@Param() params: RoleIdParamDto, @Body() body: UpdateRoleDto): Promise<RoleDto> {
    return this.roles.update(params.id, body);
  }
}
