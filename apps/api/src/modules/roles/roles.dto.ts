import {
  CreateRoleSchema,
  RoleIdParamSchema,
  RoleListResponseSchema,
  RoleSchema,
  UpdateRoleSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class RoleResponseDto extends createZodDto(RoleSchema) {}
export class RoleListResponseDto extends createZodDto(RoleListResponseSchema) {}
export class RoleIdParamDto extends createZodDto(RoleIdParamSchema) {}
export class CreateRoleDto extends createZodDto(CreateRoleSchema) {}
export class UpdateRoleDto extends createZodDto(UpdateRoleSchema) {}
