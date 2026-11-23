import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AcceptedResponse, LoginResponse } from '@venueos/shared';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { AuthenticatedOnly, Public } from '../../common/access/access.decorators';
import { UnauthenticatedError } from '../../common/errors/domain-errors';
import type { RequestContext } from '../../common/context/request-context';
import {
  AcceptedResponseDto,
  ChangePasswordDto,
  EmailOnlyDto,
  LoginDto,
  LoginResponseDto,
  ResetPasswordDto,
  SignupDto,
  VerifyEmailDto,
} from './auth.dto';
import { AuthService } from './auth.service';
import type { RequestInfo } from './auth.service';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './session-cookie';
import { SessionService } from './session.service';

const GENERIC: AcceptedResponse = {
  message: 'If this address can be used, we have sent you an email.',
};

function requestInfo(req: Request): RequestInfo {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

/** Sign up, verify, log in and out, reset the password (docs/04-security.md section 1). */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  private get authContext(): NonNullable<RequestContext['auth']> {
    const auth = this.cls.get('auth');
    if (!auth) throw new UnauthenticatedError();
    return auth;
  }

  @Post('signup')
  @Public()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Create an account and a workspace',
    description:
      'Always answers 202 with the same body, whether or not the address already has an account. A verification email follows.',
  })
  @ApiAcceptedResponse({ type: AcceptedResponseDto })
  async signup(@Body() body: SignupDto, @Req() req: Request): Promise<AcceptedResponse> {
    await this.auth.signup(body, requestInfo(req));
    return GENERIC;
  }

  @Post('verify-email')
  @Public()
  @HttpCode(204)
  @ApiOperation({ summary: 'Confirm an email address with the token from the email' })
  @ApiNoContentResponse()
  async verifyEmail(@Body() body: VerifyEmailDto): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  @Post('resend-verification')
  @Public()
  @HttpCode(202)
  @ApiOperation({ summary: 'Send the verification email again (generic answer)' })
  @ApiAcceptedResponse({ type: AcceptedResponseDto })
  async resendVerification(
    @Body() body: EmailOnlyDto,
    @Req() req: Request,
  ): Promise<AcceptedResponse> {
    await this.auth.resendVerification(body.email, requestInfo(req));
    return GENERIC;
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Log in with email and password',
    description:
      'Sets the __Host-vos_session cookie. Wrong email, wrong password and a locked account answer identically.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const presented = readSessionCookie(req);
    const presentedSession = presented
      ? await this.sessions.resolve(presented).catch(() => undefined)
      : undefined;
    const result = await this.auth.login(body, requestInfo(req), presentedSession?.sessionId);
    setSessionCookie(res, result.sessionToken);
    return result.body;
  }

  @Post('logout')
  @AuthenticatedOnly()
  @HttpCode(204)
  @ApiOperation({ summary: 'End this session' })
  @ApiNoContentResponse()
  async logout(@Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(this.authContext.sessionId);
    clearSessionCookie(res);
  }

  @Post('logout-all')
  @AuthenticatedOnly()
  @HttpCode(204)
  @ApiOperation({ summary: 'End every session of this user ("log out everywhere")' })
  @ApiNoContentResponse()
  async logoutAll(@Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logoutEverywhere(this.authContext.userId);
    clearSessionCookie(res);
  }

  @Post('password/forgot')
  @Public()
  @HttpCode(202)
  @ApiOperation({ summary: 'Ask for a password reset email (generic answer)' })
  @ApiAcceptedResponse({ type: AcceptedResponseDto })
  async forgotPassword(@Body() body: EmailOnlyDto, @Req() req: Request): Promise<AcceptedResponse> {
    await this.auth.forgotPassword(body.email, requestInfo(req));
    return GENERIC;
  }

  @Post('password/reset')
  @Public()
  @HttpCode(204)
  @ApiOperation({ summary: 'Set a new password with the token from the email; ends every session' })
  @ApiNoContentResponse()
  async resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(body);
  }

  @Post('password/change')
  @AuthenticatedOnly()
  @HttpCode(204)
  @ApiOperation({ summary: 'Change the password; ends the other sessions' })
  @ApiNoContentResponse()
  async changePassword(@Body() body: ChangePasswordDto): Promise<void> {
    const { userId, sessionId } = this.authContext;
    await this.auth.changePassword(userId, sessionId, body);
  }
}
