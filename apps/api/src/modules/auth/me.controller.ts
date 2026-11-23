import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AcceptInvitationResponse, MeResponse, MeTenantsResponse } from '@venueos/shared';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { AuthenticatedOnly } from '../../common/access/access.decorators';
import type { AuthContext } from '../../common/access/access-context';
import type { RequestContext } from '../../common/context/request-context';
import { UnauthenticatedError } from '../../common/errors/domain-errors';
import {
  AcceptInvitationDto,
  AcceptInvitationResponseDto,
  MeResponseDto,
  MeTenantsResponseDto,
  SwitchTenantDto,
} from './auth.dto';
import { InvitationsService } from './invitations.service';
import { MeService } from './me.service';
import { setSessionCookie } from './session-cookie';

/** The logged-in user's own view: identity, workspaces, switching. A login is enough (no tenant needed). */
@ApiTags('me')
@AuthenticatedOnly()
@Controller('me')
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly invitations: InvitationsService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private get auth(): AuthContext {
    const auth = this.cls.get('auth');
    if (!auth) throw new UnauthenticatedError();
    return auth;
  }

  @Get()
  @ApiOperation({ summary: 'Who am I, and what may I do in the active workspace' })
  @ApiOkResponse({ type: MeResponseDto })
  get(): Promise<MeResponse> {
    return this.me.me(this.auth);
  }

  @Get('tenants')
  @ApiOperation({ summary: 'The workspaces I am an active member of' })
  @ApiOkResponse({ type: MeTenantsResponseDto })
  tenants(): Promise<MeTenantsResponse> {
    return this.me.tenants(this.auth);
  }

  @Post('switch-tenant')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Work in another of my workspaces',
    description:
      'Rotates the session token (a new cookie is set). A workspace I am not a member of is 404.',
  })
  @ApiOkResponse({ type: MeResponseDto })
  async switchTenant(
    @Body() body: SwitchTenantDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse> {
    const auth = this.auth;
    const token = await this.me.switchTenant(auth, body.tenantId);
    setSessionCookie(res, token);
    return this.me.me({ ...auth, activeTenantId: body.tenantId });
  }

  @Post('invitations/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Accept a staff invitation with my existing account' })
  @ApiOkResponse({ type: AcceptInvitationResponseDto })
  accept(@Body() body: AcceptInvitationDto): Promise<AcceptInvitationResponse> {
    return this.invitations.acceptAsExistingUser(this.auth.userId, body.token);
  }
}
