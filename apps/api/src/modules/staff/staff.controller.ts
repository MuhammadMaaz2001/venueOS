import { Body, Controller, Get, HttpCode, Param, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { StaffListResponse, StaffMemberDto } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  MembershipIdParamDto,
  StaffListResponseDto,
  StaffMemberResponseDto,
  UpdateStaffDto,
} from './staff.dto';
import { StaffService } from './staff.service';

/** The people of the current tenant (`staff.manage`). Invitations: `/v1/staff/invitations`. */
@ApiTags('staff')
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequirePermission('staff.manage')
  @ApiOperation({ summary: 'List the members of the current tenant' })
  @ApiOkResponse({ type: StaffListResponseDto })
  list(): Promise<StaffListResponse> {
    return this.staff.list();
  }

  @Patch(':membershipId')
  @HttpCode(200)
  @RequirePermission('staff.manage')
  @ApiOperation({
    summary: 'Change a member: role, venues, active',
    description: 'A workspace always keeps at least one active Owner (422 otherwise).',
  })
  @ApiOkResponse({ type: StaffMemberResponseDto })
  update(
    @Param() params: MembershipIdParamDto,
    @Body() body: UpdateStaffDto,
  ): Promise<StaffMemberDto> {
    return this.staff.update(params.membershipId, body);
  }
}
