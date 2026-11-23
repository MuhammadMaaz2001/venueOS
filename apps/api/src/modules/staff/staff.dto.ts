import {
  MembershipIdParamSchema,
  StaffListResponseSchema,
  StaffMemberSchema,
  UpdateStaffSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class MembershipIdParamDto extends createZodDto(MembershipIdParamSchema) {}
export class UpdateStaffDto extends createZodDto(UpdateStaffSchema) {}
export class StaffMemberResponseDto extends createZodDto(StaffMemberSchema) {}
export class StaffListResponseDto extends createZodDto(StaffListResponseSchema) {}
