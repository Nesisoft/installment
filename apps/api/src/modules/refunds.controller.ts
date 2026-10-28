import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PERMISSIONS,
  RefundService,
  listRefundsSchema,
  settleRefundManuallySchema,
} from '@installment/core';
import { ApiZodBody } from '../common/api-zod';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';
import { Idempotent } from '../common/idempotent.decorator';

@ApiTags('refunds')
@ApiBearerAuth()
@Controller('admin/refunds')
export class RefundsController {
  // By explicit token: the test build ignores `emitDecoratorMetadata`, so a
  // reflected type resolves to undefined there (see OrdersController).
  constructor(@Inject(RefundService) private readonly refunds: RefundService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({
    summary: 'Refunds across every plan and return, newest first',
    description:
      '`queue` narrows it to one kind of work: to_send, in_flight, unresolved, failed, ' +
      'to_pay_by_hand or paid. Each row says which queue it is in and who the money is for.',
  })
  list(@Query() query: Record<string, string>) {
    return this.refunds.list(listRefundsSchema.parse(query));
  }

  // Declared before `:reference`, which would otherwise take "summary" as one.
  @Get('summary')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({
    summary: 'How many refunds, and how much money, are in each queue',
  })
  summary() {
    return this.refunds.summary();
  }

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
    summary: 'Send a refund to the provider now instead of waiting for the worker',
    description:
      'Only for a refund not yet sent (queue `to_send`). One parked as `unknown` is never ' +
      're-sent: Paystack takes no client reference, so a second send would be a second ' +
      'refund. The reconciler resolves those against Paystack.',
  })
  send(@Param('reference') reference: string) {
    return this.refunds.disburse(reference);
  }

  @Post(':reference/settle-manual')
  @Idempotent()
  @ApiZodBody(settleRefundManuallySchema)
  @RequirePermissions(PERMISSIONS.REFUNDS_ACT)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record that a refund was paid back by hand',
    description:
      'For a refund whose money came in outside Paystack (queue `to_pay_by_hand`), or one ' +
      'Paystack refused (`failed`) and that was then paid some other way. `note` records how ' +
      'it was paid. An `unresolved` refund needs `checked_paystack: true` and a `note`: the ' +
      'caller looked the charge up in the Paystack dashboard and it carries no refund. ' +
      'Refused (409) for one Paystack holds and is still processing (`in_flight`), one sent in ' +
      'the last two minutes, and one already paid.',
  })
  settleManual(
    @Param('reference') reference: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { note, checked_paystack } = settleRefundManuallySchema.parse(body ?? {});
    return this.refunds.settleManual(reference, actorOf(user), {
      note,
      checkedPaystack: checked_paystack,
    });
  }
}
