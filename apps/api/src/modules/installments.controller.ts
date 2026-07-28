import { Body, Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { CustomerPlansService, PERMISSIONS, renderReceiptHtml } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';
import { recordManualPaymentSchema } from '@installment/core';
import { ApiZodBody } from '../common/api-zod';

@ApiTags('plans')
@ApiBearerAuth()
@Controller('admin/installments')
export class InstallmentsController {
  constructor(private readonly plans: CustomerPlansService) {}

  @Post(':scheduleId/record-payment')
  @ApiZodBody(recordManualPaymentSchema)
  @RequirePermissions(PERMISSIONS.COLLECTIONS_ACT)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record an out-of-band payment against an installment (admin override)',
  })
  recordPayment(
    @Param('scheduleId') scheduleId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.plans.recordManualPayment(scheduleId, body, actorOf(user));
  }

  @Post(':scheduleId/refund')
  @RequirePermissions(PERMISSIONS.COLLECTIONS_ACT)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Refund a paid installment — flips schedule to refunded, bumps outstanding, and reverses the proportional ledger accrual',
  })
  refund(
    @Param('scheduleId') scheduleId: string,
    @Body() body: { reason?: string } | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.plans.refundInstallment(scheduleId, { reason: body?.reason }, actorOf(user));
  }

  @Get(':scheduleId/receipt')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({ summary: 'Payment receipt for a paid installment (structured JSON)' })
  receipt(@Param('scheduleId') scheduleId: string) {
    return this.plans.getReceipt(scheduleId);
  }

  @Get(':scheduleId/receipt.html')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Printable HTML receipt for a paid installment (print → PDF)' })
  async receiptHtml(@Param('scheduleId') scheduleId: string): Promise<string> {
    return renderReceiptHtml(await this.plans.getReceipt(scheduleId));
  }
}
