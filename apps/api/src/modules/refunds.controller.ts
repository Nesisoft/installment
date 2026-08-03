import { Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, RefundService } from '@installment/core';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';
import { Idempotent } from '../common/idempotent.decorator';

@ApiTags('refunds')
@ApiBearerAuth()
@Controller('admin/refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundService) {}

  @Get('plan/:planId')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({
    summary: 'Refunds owed or returned for a plan — what we still owe the customer, and when',
  })
  listForPlan(@Param('planId') planId: string) {
    return this.refunds.listForPlan(planId);
  }

  @Get(':reference')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({ summary: 'One refund by reference' })
  async get(@Param('reference') reference: string) {
    const refund = await this.refunds.findByReference(reference);
    if (!refund) throw new NotFoundException(`Refund ${reference} not found`);
    return refund;
  }

  @Post(':reference/send')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.REFUNDS_ACT)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Send a refund to the provider now instead of waiting for the worker (also retries one parked as unknown)',
  })
  send(@Param('reference') reference: string) {
    return this.refunds.disburse(reference);
  }

  @Post(':reference/settle-manual')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.REFUNDS_ACT)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Record that an out-of-band refund was physically returned — the only way a manual refund reaches a terminal state',
  })
  settleManual(@Param('reference') reference: string, @CurrentUser() user: AuthenticatedUser) {
    return this.refunds.settleManual(reference, actorOf(user));
  }
}
