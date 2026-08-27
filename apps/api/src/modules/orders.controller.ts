import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { PERMISSIONS } from '@installment/core';
import { OrdersService, confirmOrderPaymentSchema } from '@installment/commerce';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';
import { ApiZodBody } from '../common/api-zod';
import { Idempotent } from '../common/idempotent.decorator';

/**
 * Operator-facing controls for orders.
 *
 * A pay-in-full checkout leaves its order in `pending_payment` with stock
 * reserved, and until now nothing could move it on: `OrdersService.confirmPayment`
 * was fully implemented and tested but had no caller anywhere in the codebase.
 * Its instalment sibling `activateFinancing` was wired from PlansController; this
 * one was not. Every pay-in-full order was therefore a dead end — the customer
 * was never recorded as having paid, the merchant was never credited, the
 * marketplace commission was never booked, and the reserved units never sold.
 *
 * The service's own doc says it is driven by "webhook / admin". This is the
 * admin half, which is what settles the payment methods that actually exist
 * today: cash on delivery, bank transfer, and a Mobile Money payment reconciled
 * by hand. The webhook half needs a customer-initiated charge to exist first,
 * and `payment_attempts` is currently NOT NULL on `schedule_id` /
 * `customer_plan_id`, so routing an order charge through it needs a migration.
 */
@ApiTags('orders')
@ApiBearerAuth()
@Controller('admin/orders')
export class OrdersController {
  /**
   * Injected by explicit token rather than reflected parameter type. The
   * production build (tsc) emits `design:paramtypes`, but the test build
   * (esbuild) ignores `emitDecoratorMetadata`, so type-based DI resolves to
   * undefined under vitest — the same reason IdempotencyInterceptor and
   * RateLimitGuard are explicit. Being explicit is what makes this controller
   * testable at all.
   */
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  /**
   * Records that a pay-in-full order has been paid.
   *
   * Carries SETTLEMENTS_RUN rather than a lighter permission because this books
   * real money: cash in against the settlement account, a payable to the
   * merchant, and the platform's commission. That is the same money authority
   * as running a settlement batch, and the same operator does both.
   *
   * `@Idempotent()` because it is a financial commitment and a retried request
   * must not book the ledger twice. The service is independently guarded — it
   * locks the row and re-checks the status inside the transaction — so a
   * concurrent double-submit fails on the status guard rather than double-paying.
   */
  @Post(':id/confirm-payment')
  @Idempotent()
  @ApiZodBody(confirmOrderPaymentSchema)
  @RequirePermissions(PERMISSIONS.SETTLEMENTS_RUN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Settle a pay-in-full order: books the commission split and commits stock',
    description:
      'For an order in `pending_payment`. Books cash in, the merchant payable and the ' +
      'marketplace commission, commits the stock reserved at checkout, and advances the ' +
      'order to `paid`. `provider_reference` is the payment reference being reconciled ' +
      '(a Paystack reference, a bank transfer reference, or a till/receipt number) and is ' +
      'recorded on every ledger entry so the booking can be traced back to the money.',
  })
  confirmPayment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.confirmPayment(id, body, actorOf(user));
  }
}
