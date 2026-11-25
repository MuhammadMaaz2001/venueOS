import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PriceRuleDto, PriceRuleListResponse, RentPreviewDto } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CreatePriceRuleDto,
  PriceRuleListQueryDto,
  PriceRuleListResponseDto,
  PriceRuleResponseDto,
  PricingIdParamDto,
  RentPreviewQueryDto,
  RentPreviewResponseDto,
  UpdatePriceRuleDto,
} from './pricing.dto';
import { PriceRulesService } from './price-rules.service';
import { RentPreviewService } from './rent-preview.service';

/** Price rules (weekday, season, specific date) and the rent preview. Reads need `pricing.view`, writes `pricing.manage`. */
@ApiTags('price-rules')
@Controller()
export class PriceRulesController {
  constructor(
    private readonly rules: PriceRulesService,
    private readonly preview: RentPreviewService,
  ) {}

  @Get('price-rules')
  @RequirePermission('pricing.view')
  @ApiOperation({ summary: 'List the price rules of the workspace' })
  @ApiOkResponse({ type: PriceRuleListResponseDto })
  list(@Query() query: PriceRuleListQueryDto): Promise<PriceRuleListResponse> {
    return this.rules.list(query.includeInactive === 'true', query.spaceId, query.slotId);
  }

  @Post('price-rules')
  @RequirePermission('pricing.manage')
  @ApiOperation({
    summary: 'Add a price rule',
    description:
      'DAY_OF_WEEK needs weekdays, DATE_RANGE a first and last day, SPECIFIC_DATE one day. A rule that names no space or slot applies everywhere and needs access to all venues; a venue-limited manager may add rules for a space or slot of their venues.',
  })
  @ApiCreatedResponse({ type: PriceRuleResponseDto })
  create(@Body() body: CreatePriceRuleDto): Promise<PriceRuleDto> {
    return this.rules.create(body);
  }

  @Get('price-rules/:id')
  @RequirePermission('pricing.view')
  @ApiOkResponse({ type: PriceRuleResponseDto })
  get(@Param() params: PricingIdParamDto): Promise<PriceRuleDto> {
    return this.rules.get(params.id);
  }

  @Patch('price-rules/:id')
  @HttpCode(200)
  @RequirePermission('pricing.manage')
  @ApiOperation({
    summary: 'Edit a price rule',
    description:
      '`rev` is required. The merged rule is validated like a new one. `active: false` is the delete. Existing bookings keep their frozen prices.',
  })
  @ApiOkResponse({ type: PriceRuleResponseDto })
  update(
    @Param() params: PricingIdParamDto,
    @Body() body: UpdatePriceRuleDto,
  ): Promise<PriceRuleDto> {
    return this.rules.update(params.id, body);
  }

  @Get('pricing/rent-preview')
  @RequirePermission('pricing.view')
  @ApiOperation({
    summary: 'Preview the rent of a space for a slot on a day',
    description:
      'Base rent, every matching price rule in the order applied (docs/05 section 3) and the final rent. Read-only. An HOURLY slot needs `hours`.',
  })
  @ApiOkResponse({ type: RentPreviewResponseDto })
  rentPreview(@Query() query: RentPreviewQueryDto): Promise<RentPreviewDto> {
    return this.preview.preview(query);
  }
}
