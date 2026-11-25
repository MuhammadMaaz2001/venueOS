import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CustomFieldDefDto, CustomFieldDefListResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CatalogueIdParamDto,
  CreateCustomFieldDefDto,
  CustomFieldDefListQueryDto,
  CustomFieldDefListResponseDto,
  CustomFieldDefResponseDto,
  UpdateCustomFieldDefDto,
} from './catalogue.dto';
import { CustomFieldsService } from './custom-fields.service';

/** Definitions of tenant-defined fields (customer, booking, session, lead). Reads `catalogue.view`, writes `catalogue.manage`. */
@ApiTags('custom-fields')
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  @RequirePermission('catalogue.view')
  @ApiOperation({ summary: 'List the custom field definitions, optionally of one record type' })
  @ApiOkResponse({ type: CustomFieldDefListResponseDto })
  list(@Query() query: CustomFieldDefListQueryDto): Promise<CustomFieldDefListResponse> {
    return this.fields.list(query.entity, query.includeInactive === 'true');
  }

  @Post()
  @RequirePermission('catalogue.manage')
  @ApiOperation({
    summary: 'Define a custom field',
    description:
      'Tenant-wide. The key is unique per record type, also among deactivated fields (409). A choice field needs choices; only text, number and phone fields can be sensitive.',
  })
  @ApiCreatedResponse({ type: CustomFieldDefResponseDto })
  create(@Body() body: CreateCustomFieldDefDto): Promise<CustomFieldDefDto> {
    return this.fields.create(body);
  }

  @Get(':id')
  @RequirePermission('catalogue.view')
  @ApiOkResponse({ type: CustomFieldDefResponseDto })
  get(@Param() params: CatalogueIdParamDto): Promise<CustomFieldDefDto> {
    return this.fields.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('catalogue.manage')
  @ApiOperation({
    summary: 'Edit a custom field',
    description:
      '`rev` is required. Record type, key, type and sensitivity are fixed. `active: false` is the delete.',
  })
  @ApiOkResponse({ type: CustomFieldDefResponseDto })
  update(
    @Param() params: CatalogueIdParamDto,
    @Body() body: UpdateCustomFieldDefDto,
  ): Promise<CustomFieldDefDto> {
    return this.fields.update(params.id, body);
  }
}
