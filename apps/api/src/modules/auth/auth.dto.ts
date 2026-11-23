import {
  AcceptInvitationNewUserSchema,
  AcceptInvitationResponseSchema,
  AcceptInvitationSchema,
  AcceptedResponseSchema,
  ChangePasswordSchema,
  CreateInvitationSchema,
  EmailOnlySchema,
  InvitationIdParamSchema,
  InvitationListResponseSchema,
  InvitationSchema,
  LoginResponseSchema,
  LoginSchema,
  MeResponseSchema,
  MeTenantsResponseSchema,
  ResetPasswordSchema,
  SignupSchema,
  SwitchTenantSchema,
  VerifyEmailSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class SignupDto extends createZodDto(SignupSchema) {}
export class VerifyEmailDto extends createZodDto(VerifyEmailSchema) {}
export class EmailOnlyDto extends createZodDto(EmailOnlySchema) {}
export class LoginDto extends createZodDto(LoginSchema) {}
export class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}
export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
export class SwitchTenantDto extends createZodDto(SwitchTenantSchema) {}
export class AcceptInvitationNewUserDto extends createZodDto(AcceptInvitationNewUserSchema) {}
export class AcceptInvitationDto extends createZodDto(AcceptInvitationSchema) {}
export class CreateInvitationDto extends createZodDto(CreateInvitationSchema) {}
export class InvitationIdParamDto extends createZodDto(InvitationIdParamSchema) {}

export class AcceptedResponseDto extends createZodDto(AcceptedResponseSchema) {}
export class LoginResponseDto extends createZodDto(LoginResponseSchema) {}
export class MeResponseDto extends createZodDto(MeResponseSchema) {}
export class MeTenantsResponseDto extends createZodDto(MeTenantsResponseSchema) {}
export class AcceptInvitationResponseDto extends createZodDto(AcceptInvitationResponseSchema) {}
export class InvitationResponseDto extends createZodDto(InvitationSchema) {}
export class InvitationListResponseDto extends createZodDto(InvitationListResponseSchema) {}
