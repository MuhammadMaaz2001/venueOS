import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TaxRateDto, TaxRateListResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CreateTaxRateDto,
  PricingIdParamDto,
  TaxRateListQueryDto,
  TaxRateListResponseDto,
  TaxRateResponseDto,
  UpdateTaxRateDto,
} from './pricing.dto';
import { TaxRatesService } from './tax-rates.service';

/** Tax rates: tenant-wide, one default. Reads need `pricing.view`, writes `pricing.manage`. */
@ApiTags('tax-rates')
@Controller('tax-rates')
export class TaxRatesController {
  constructor(private readonly taxRates: TaxRatesService) {}

  @Get()
  @RequirePermission('pricing.view')
  @ApiOperation({ summary: 'List the tax rates of the workspace' })
  @ApiOkResponse({ type: TaxRateListResponseDto })
  list(@Query() query: TaxRateListQueryDto): Promise<TaxRateListResponse> {
    return this.taxRates.list(query.includeInactive === 'true');
  }

  @Post()
  @RequirePermission('pricing.manage')
  @ApiOperation({
    summary: 'Add a tax rate',
    description:
      'Tenant-wide. `isDefault: true` takes the flag from the current default. Names are unique among active rates (409).',
  })
  @ApiCreatedResponse({ type: TaxRateResponseDto })
  create(@Body() body: CreateTaxRateDto): Promise<TaxRateDto> {
    return this.taxRates.create(body);
  }

  @Get(':id')
  @RequirePermission('pricing.view')
  @ApiOkResponse({ type: TaxRateResponseDto })
  get(@Param() params: PricingIdParamDto): Promise<TaxRateDto> {
    return this.taxRates.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('pricing.manage')
  @ApiOperation({
    summary: 'Edit a tax rate',
    description:
      '`rev` is required. `active: false` is the delete and also clears the default flag.',
  })
  @ApiOkResponse({ type: TaxRateResponseDto })
  update(@Param() params: PricingIdParamDto, @Body() body: UpdateTaxRateDto): Promise<TaxRateDto> {
    return this.taxRates.update(params.id, body);
  }
}
