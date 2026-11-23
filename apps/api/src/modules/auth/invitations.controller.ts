import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type {
  AcceptInvitationResponse,
  InvitationDto,
  InvitationListResponse,
} from '@venueos/shared';
import { Entitlement, Public, RequirePermission } from '../../common/access/access.decorators';
import {
  AcceptInvitationNewUserDto,
  AcceptInvitationResponseDto,
  CreateInvitationDto,
  InvitationIdParamDto,
  InvitationListResponseDto,
  InvitationResponseDto,
} from './auth.dto';
import { InvitationsService } from './invitations.service';

/** Staff invitations of the current tenant (`staff.manage`). */
@ApiTags('staff')
@Controller('staff/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @RequirePermission('staff.manage')
  @Entitlement('maxUsers')
  @ApiOperation({ summary: 'Invite a person by email with a role' })
  @ApiCreatedResponse({ type: InvitationResponseDto })
  create(@Body() body: CreateInvitationDto): Promise<InvitationDto> {
    return this.invitations.create(body);
  }

  @Get()
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'Pending invitations' })
  @ApiOkResponse({ type: InvitationListResponseDto })
  list(): Promise<InvitationListResponse> {
    return this.invitations.list();
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'Revoke an invitation' })
  @ApiNoContentResponse()
  revoke(@Param() params: InvitationIdParamDto): Promise<void> {
    return this.invitations.revoke(params.id);
  }
}

/** The invitee, before any account exists. */
@ApiTags('auth')
@Controller('auth/invitations')
export class InvitationAcceptController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('accept')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation as a NEW user (name and password)',
    description:
      'An address that already has an account gets 409: log in and use POST /v1/me/invitations/accept.',
  })
  @ApiOkResponse({ type: AcceptInvitationResponseDto })
  accept(@Body() body: AcceptInvitationNewUserDto): Promise<AcceptInvitationResponse> {
    return this.invitations.acceptAsNewUser(body);
  }
}
