import { Body, Controller, Get, HttpCode, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { TenantSettingsResponse } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import { TenantSettingsResponseDto, UpdateTenantSettingsDto } from './tenant-settings.dto';
import { TenantSettingsService } from './tenant-settings.service';

/** The workspace's own settings (docs/05 section 15). Both routes need `tenant.settings.manage`. */
@ApiTags('tenant')
@Controller('tenant/settings')
export class TenantSettingsController {
  constructor(private readonly settings: TenantSettingsService) {}

  @Get()
  @RequirePermission('tenant.settings.manage')
  @ApiOperation({
    summary: 'Workspace name, time zone and booking/payment settings (defaults filled in)',
  })
  @ApiOkResponse({ type: TenantSettingsResponseDto })
  get(): Promise<TenantSettingsResponse> {
    return this.settings.get();
  }

  @Patch()
  @HttpCode(200)
  @RequirePermission('tenant.settings.manage')
  @ApiOperation({
    summary: 'Change name, time zone or settings keys',
    description:
      '`rev` is required. Only the keys you send change. Currency and country are fixed after signup.',
  })
  @ApiOkResponse({ type: TenantSettingsResponseDto })
  update(@Body() body: UpdateTenantSettingsDto): Promise<TenantSettingsResponse> {
    return this.settings.update(body);
  }
}
