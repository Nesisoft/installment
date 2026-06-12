import { Controller, Get } from '@nestjs/common';
import { PERMISSIONS, TelcoHealthMonitor } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators';

/**
 * Ops view of Mobile Money network health — per-telco charge success over the
 * rolling window, with a healthy / degraded / down / unknown status.
 */
@ApiTags('telco-health')
@ApiBearerAuth()
@Controller('admin/telco-health')
export class TelcoHealthController {
  constructor(private readonly telco: TelcoHealthMonitor) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({ summary: 'Mobile Money network health snapshot (per telco)' })
  snapshot() {
    return this.telco.snapshot();
  }
}
