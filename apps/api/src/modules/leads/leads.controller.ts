import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  LeadActivityListResponse,
  LeadAssigneeListResponse,
  LeadDto,
  LeadFollowUpsDto,
  LeadListResponse,
} from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CreateLeadDto,
  LeadActivityListResponseDto,
  LeadAssigneeListResponseDto,
  LeadAssigneesQueryDto,
  LeadFollowUpsQueryDto,
  LeadFollowUpsResponseDto,
  LeadIdParamDto,
  LeadListQueryDto,
  LeadListResponseDto,
  LeadResponseDto,
  UpdateLeadDto,
} from './leads.dto';
import { LeadsService } from './leads.service';

/** Leads / inquiries (docs/01 module 5). Venue scoped. Reads `lead.view`, writes `lead.manage`. */
@ApiTags('leads')
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequirePermission('lead.view')
  @ApiOperation({
    summary: 'List leads (board columns and the list view), newest first',
    description:
      'Filters: venueId, stage, assigneeId (membership) / unassigned, source, customerId, followUp=overdue|today, search (customer name or phone). Only leads of the caller’s venues; `venueId` only narrows. Cursor pagination.',
  })
  @ApiOkResponse({ type: LeadListResponseDto })
  list(@Query() query: LeadListQueryDto): Promise<LeadListResponse> {
    return this.leads.list(query);
  }

  // The fixed paths are declared before `:id`.
  @Get('follow-ups')
  @RequirePermission('lead.view')
  @ApiOperation({
    summary: 'Follow-ups that are overdue or due today (the dashboard card)',
    description:
      'Counts and the most urgent open leads, in the caller’s venues. `assignee=me` (default) only counts leads assigned to the caller.',
  })
  @ApiOkResponse({ type: LeadFollowUpsResponseDto })
  followUps(@Query() query: LeadFollowUpsQueryDto): Promise<LeadFollowUpsDto> {
    return this.leads.followUps(query);
  }

  @Get('assignees')
  @RequirePermission('lead.view')
  @ApiOperation({
    summary: 'Members a lead can be assigned to',
    description:
      'Active members whose role holds `lead.manage` and whose venues cover `venueId` (all venues when omitted).',
  })
  @ApiOkResponse({ type: LeadAssigneeListResponseDto })
  assignees(@Query() query: LeadAssigneesQueryDto): Promise<LeadAssigneeListResponse> {
    return this.leads.assignees(query);
  }

  @Post()
  @RequirePermission('lead.manage')
  @ApiOperation({
    summary: 'Record an inquiry',
    description:
      'Give `customerId` or a new `customer` (inline; needs `customer.manage`). Starts in NEW; `nextFollowUpAt` is required. The assignee defaults to the caller; the assignee gets an email (not when it is the caller).',
  })
  @ApiCreatedResponse({ type: LeadResponseDto })
  create(@Body() body: CreateLeadDto): Promise<LeadDto> {
    return this.leads.create(body);
  }

  @Get(':id')
  @RequirePermission('lead.view')
  @ApiOkResponse({ type: LeadResponseDto })
  get(@Param() params: LeadIdParamDto): Promise<LeadDto> {
    return this.leads.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('lead.manage')
  @ApiOperation({
    summary: 'Edit a lead, move its stage, assign it',
    description:
      '`rev` is required. `stage` moves it (LOST needs `lostReason`; an open stage needs a follow-up; WON is final; a LOST lead can be reopened). The assignee must be an active member with `lead.manage` whose venues cover the lead’s venue.',
  })
  @ApiOkResponse({ type: LeadResponseDto })
  update(@Param() params: LeadIdParamDto, @Body() body: UpdateLeadDto): Promise<LeadDto> {
    return this.leads.update(params.id, body);
  }

  @Get(':id/activity')
  @RequirePermission('lead.view')
  @ApiOperation({
    summary: 'Activity log of a lead',
    description:
      'Stage changes, assignments and other edits (notes included), newest first, read from the audit rows.',
  })
  @ApiOkResponse({ type: LeadActivityListResponseDto })
  activity(@Param() params: LeadIdParamDto): Promise<LeadActivityListResponse> {
    return this.leads.activity(params.id);
  }
}
