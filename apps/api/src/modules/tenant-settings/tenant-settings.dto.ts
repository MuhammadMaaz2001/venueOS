import { TenantSettingsResponseSchema, UpdateTenantSettingsSchema } from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class TenantSettingsResponseDto extends createZodDto(TenantSettingsResponseSchema) {}
export class UpdateTenantSettingsDto extends createZodDto(UpdateTenantSettingsSchema) {}
