import {
  CreateLeadSchema,
  IdParamSchema,
  LeadActivityListResponseSchema,
  LeadAssigneeListResponseSchema,
  LeadAssigneesQuerySchema,
  LeadFollowUpsQuerySchema,
  LeadFollowUpsSchema,
  LeadListQuerySchema,
  LeadListResponseSchema,
  LeadSchema,
  UpdateLeadSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class LeadIdParamDto extends createZodDto(IdParamSchema) {}
export class LeadResponseDto extends createZodDto(LeadSchema) {}
export class LeadListResponseDto extends createZodDto(LeadListResponseSchema) {}
export class LeadListQueryDto extends createZodDto(LeadListQuerySchema) {}
export class LeadFollowUpsQueryDto extends createZodDto(LeadFollowUpsQuerySchema) {}
export class LeadFollowUpsResponseDto extends createZodDto(LeadFollowUpsSchema) {}
export class LeadAssigneesQueryDto extends createZodDto(LeadAssigneesQuerySchema) {}
export class LeadAssigneeListResponseDto extends createZodDto(LeadAssigneeListResponseSchema) {}
export class LeadActivityListResponseDto extends createZodDto(LeadActivityListResponseSchema) {}
export class CreateLeadDto extends createZodDto(CreateLeadSchema) {}
export class UpdateLeadDto extends createZodDto(UpdateLeadSchema) {}
