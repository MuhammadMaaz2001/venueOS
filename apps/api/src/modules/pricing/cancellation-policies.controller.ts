import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CancellationPolicyDto, CancellationPolicyListResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import { CancellationPoliciesService } from './cancellation-policies.service';
import {
  CancellationPolicyListQueryDto,
  CancellationPolicyListResponseDto,
  CancellationPolicyResponseDto,
  CreateCancellationPolicyDto,
  PricingIdParamDto,
  UpdateCancellationPolicyDto,
} from './pricing.dto';

/** Cancellation policies (refund tiers): tenant-wide, one default. Reads need `pricing.view`, writes `pricing.manage`. */
@ApiTags('cancellation-policies')
@Controller('cancellation-policies')
export class CancellationPoliciesController {
  constructor(private readonly policies: CancellationPoliciesService) {}

  @Get()
  @RequirePermission('pricing.view')
  @ApiOperation({ summary: 'List the cancellation policies of the workspace' })
  @ApiOkResponse({ type: CancellationPolicyListResponseDto })
  list(@Query() query: CancellationPolicyListQueryDto): Promise<CancellationPolicyListResponse> {
    return this.policies.list(query.includeInactive === 'true');
  }

  @Post()
  @RequirePermission('pricing.manage')
  @ApiOperation({
    summary: 'Add a cancellation policy',
    description:
      'Tiers are sent from the longest notice to the shortest: `minDaysBefore` strictly descending, the last one 0, `refundPct` 0 to 100. `isDefault: true` takes the flag from the current default.',
  })
  @ApiCreatedResponse({ type: CancellationPolicyResponseDto })
  create(@Body() body: CreateCancellationPolicyDto): Promise<CancellationPolicyDto> {
    return this.policies.create(body);
  }

  @Get(':id')
  @RequirePermission('pricing.view')
  @ApiOkResponse({ type: CancellationPolicyResponseDto })
  get(@Param() params: PricingIdParamDto): Promise<CancellationPolicyDto> {
    return this.policies.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('pricing.manage')
  @ApiOperation({
    summary: 'Edit a cancellation policy',
    description:
      '`rev` is required. A booking keeps the copy it took when it was confirmed. `active: false` is the delete and also clears the default flag.',
  })
  @ApiOkResponse({ type: CancellationPolicyResponseDto })
  update(
    @Param() params: PricingIdParamDto,
    @Body() body: UpdateCancellationPolicyDto,
  ): Promise<CancellationPolicyDto> {
    return this.policies.update(params.id, body);
  }
}
