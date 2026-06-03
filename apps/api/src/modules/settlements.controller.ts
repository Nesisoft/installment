import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { PERMISSIONS, ReconciliationService, SettlementService } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators';

/**
 * Operator-facing settlement controls. The daily run normally fires from a
 * scheduled job; these endpoints let operators trigger or re-run it on demand.
 */
@ApiTags('settlements')
@ApiBearerAuth()
@Controller('admin/settlements')
export class SettlementsController {
  constructor(
    private readonly settlements: SettlementService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Post('run')
  @RequirePermissions(PERMISSIONS.PLANS_WRITE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run the daily merchant settlement batch (idempotent per merchant/day)',
  })
  run(@Body() body: { asOf?: string } | undefined) {
    const asOf = body?.asOf ? new Date(body.asOf) : new Date();
    return this.settlements.runDailySettlement(asOf);
  }

  @Post('merchants/:merchantId/run')
  @RequirePermissions(PERMISSIONS.PLANS_WRITE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Settle a single merchant for the day (idempotent)' })
  runOne(@Param('merchantId') merchantId: string, @Body() body: { asOf?: string } | undefined) {
    const asOf = body?.asOf ? new Date(body.asOf) : new Date();
    return this.settlements.settleMerchant(merchantId, asOf);
  }

  @Post('reconcile')
  @RequirePermissions(PERMISSIONS.PLANS_WRITE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify in-flight payouts (pending/unknown) against Paystack and resolve them',
  })
  reconcile(@Body() body: { limit?: number } | undefined) {
    return this.reconciliation.reconcilePendingPayouts({ limit: body?.limit });
  }
}
