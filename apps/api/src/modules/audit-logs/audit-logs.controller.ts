import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuditLogDetailDto, AuditLogListResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  AuditLogDetailResponseDto,
  AuditLogIdParamDto,
  AuditLogListQueryDto,
  AuditLogListResponseDto,
} from './audit-logs.dto';
import { AuditLogsService } from './audit-logs.service';

/** The audit trail (docs/04-security.md section 8). Read-only: rows are written by the services that change things. */
@ApiTags('audit-logs')
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @RequirePermission('audit.view')
  @ApiOperation({
    summary: 'List audit entries, newest first',
    description:
      'Cursor pagination (`limit` 25, max 100). `from`/`to` are `YYYY-MM-DD` (whole days of the workspace time zone, inclusive) or ISO instants. A caller limited to some venues only sees entries of those venues, never tenant-wide ones.',
  })
  @ApiOkResponse({ type: AuditLogListResponseDto })
  list(@Query() query: AuditLogListQueryDto): Promise<AuditLogListResponse> {
    return this.auditLogs.list(query);
  }

  @Get(':id')
  @RequirePermission('audit.view')
  @ApiOperation({
    summary: 'One audit entry with the full before/after',
    description: 'Sensitive fields are masked exactly as they were stored.',
  })
  @ApiOkResponse({ type: AuditLogDetailResponseDto })
  get(@Param() params: AuditLogIdParamDto): Promise<AuditLogDetailDto> {
    return this.auditLogs.get(params.id);
  }
}
