import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CustomerDetailDto,
  CustomerDuplicatesResponse,
  CustomerListResponse,
  RevealedValueDto,
} from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CreateCustomerDto,
  CustomerDetailResponseDto,
  CustomerDuplicatesQueryDto,
  CustomerDuplicatesResponseDto,
  CustomerIdParamDto,
  CustomerListQueryDto,
  CustomerListResponseDto,
  CustomerRevealParamDto,
  RevealedValueResponseDto,
  UpdateCustomerDto,
} from './customers.dto';
import { CustomersService } from './customers.service';

/** Customers (docs/01 module 4). Tenant-wide. Reads `customer.view`, writes `customer.manage`. */
@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('customer.view')
  @ApiOperation({
    summary: 'Search and list customers',
    description:
      '`search` matches name, phone and email (contains, any case; digits also match the number without its leading zero). Cursor pagination, ordered by name.',
  })
  @ApiOkResponse({ type: CustomerListResponseDto })
  list(@Query() query: CustomerListQueryDto): Promise<CustomerListResponse> {
    return this.customers.list(query);
  }

  // Declared before `:id` so that "duplicates" is not read as an id.
  @Get('duplicates')
  @RequirePermission('customer.view')
  @ApiOperation({
    summary: 'Possible duplicates of a phone and / or email',
    description:
      'Other active customers with the same phone (also their alternative phone) or the same email. A warning for the form, never an error: phone is not unique.',
  })
  @ApiOkResponse({ type: CustomerDuplicatesResponseDto })
  duplicates(@Query() query: CustomerDuplicatesQueryDto): Promise<CustomerDuplicatesResponse> {
    return this.customers.duplicates(query);
  }

  @Post()
  @RequirePermission('customer.manage')
  @ApiOperation({
    summary: 'Add a customer',
    description:
      'The phone is stored in E.164 (read with the workspace country when typed the national way). The answer lists `duplicates`: other customers with the same phone or email; the customer is created anyway.',
  })
  @ApiCreatedResponse({ type: CustomerDetailResponseDto })
  create(@Body() body: CreateCustomerDto): Promise<CustomerDetailDto> {
    return this.customers.create(body);
  }

  @Get(':id')
  @RequirePermission('customer.view')
  @ApiOperation({
    summary: 'One customer with their leads and possible duplicates',
    description:
      'Sensitive custom fields come back masked. `leads` needs `lead.view` and only lists leads of the caller’s venues.',
  })
  @ApiOkResponse({ type: CustomerDetailResponseDto })
  get(@Param() params: CustomerIdParamDto): Promise<CustomerDetailDto> {
    return this.customers.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('customer.manage')
  @ApiOperation({
    summary: 'Edit a customer',
    description:
      '`rev` is required. `active: false` is the delete. Custom fields: only the keys sent change, `null` clears one.',
  })
  @ApiOkResponse({ type: CustomerDetailResponseDto })
  update(
    @Param() params: CustomerIdParamDto,
    @Body() body: UpdateCustomerDto,
  ): Promise<CustomerDetailDto> {
    return this.customers.update(params.id, body);
  }

  @Post(':id/reveal/:fieldKey')
  @HttpCode(200)
  @RequirePermission('customer.view_sensitive')
  @ApiOperation({
    summary: 'Show the clear value of a sensitive custom field',
    description:
      'Needs `customer.view_sensitive`. Every call writes an audit row (who, which customer, which field; never the value).',
  })
  @ApiOkResponse({ type: RevealedValueResponseDto })
  reveal(@Param() params: CustomerRevealParamDto): Promise<RevealedValueDto> {
    return this.customers.reveal(params.id, params.fieldKey);
  }
}
