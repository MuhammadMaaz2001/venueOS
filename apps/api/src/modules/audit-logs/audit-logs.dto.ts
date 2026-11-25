import {
  AuditLogDetailSchema,
  AuditLogIdParamSchema,
  AuditLogListQuerySchema,
  AuditLogListResponseSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class AuditLogDetailResponseDto extends createZodDto(AuditLogDetailSchema) {}
export class AuditLogListResponseDto extends createZodDto(AuditLogListResponseSchema) {}
export class AuditLogListQueryDto extends createZodDto(AuditLogListQuerySchema) {}
export class AuditLogIdParamDto extends createZodDto(AuditLogIdParamSchema) {}
