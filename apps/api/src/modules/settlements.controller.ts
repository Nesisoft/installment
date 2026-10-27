import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  PERMISSIONS,
  ReconciliationService,
  SellersOwingReport,
  SettlementService,
} from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators';
import { Idempotent } from '../common/idempotent.decorator';

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
    private readonly sellersOwing: SellersOwingReport,
  ) {}

  /**
   * Sellers whose payable has gone negative — owing Ejua, usually after
   * returns. The ones suspended or offboarded come first: nothing will be
   * paid to them again, so nothing nets the debt off.
   */
  @Get('sellers-owing')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  @ApiOperation({ summary: 'Sellers owing Ejua (negative payable), worst first' })
  async owing() {
    const rows = await this.sellersOwing.list();
    return { summary: this.sellersOwing.summarise(rows), rows };
  }

  @Post('run')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.SETTLEMENTS_RUN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run the daily merchant settlement batch (idempotent per merchant/day)',
  })
  run(@Body() body: { asOf?: string } | undefined) {
    const asOf = body?.asOf ? new Date(body.asOf) : new Date();
    return this.settlements.runDailySettlement(asOf);
  }

  @Post('merchants/:merchantId/run')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.SETTLEMENTS_RUN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Settle a single merchant for the day (idempotent)' })
  runOne(@Param('merchantId') merchantId: string, @Body() body: { asOf?: string } | undefined) {
    const asOf = body?.asOf ? new Date(body.asOf) : new Date();
    return this.settlements.settleMerchant(merchantId, asOf);
  }

  @Post('reconcile')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.SETTLEMENTS_RUN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify in-flight payouts (pending/unknown) against Paystack and resolve them',
  })
  reconcile(@Body() body: { limit?: number } | undefined) {
    return this.reconciliation.reconcilePendingPayouts({ limit: body?.limit });
  }
}
