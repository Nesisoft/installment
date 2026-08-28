import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  BadRequestException,
} from '@nestjs/common';
import {
  AddressesService,
  CartService,
  OrdersService,
  addCartItemSchema,
  checkoutSchema,
  createAddressSchema,
  setCartItemQuantitySchema,
  updateAddressSchema,
  cancelOrderSchema,
  OrderPaymentService,
  CheckoutDecisionService,
  FulfilmentService,
} from '@installment/commerce';
import { CustomerNotFoundError, CustomerPlansService, CustomersService } from '@installment/core';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators';
import { ApiModel } from '../common/api-model';
import { Idempotent } from '../common/idempotent.decorator';
import { ApiZodBody } from '../common/api-zod';

/**
 * Customer self-service commerce: the authenticated customer's cart and
 * shipping addresses. The JWT identifies a `users` row; the domain `customers`
 * record is resolved via customers.user_id (same as MeController).
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeCommerceController {
  constructor(
    private readonly customers: CustomersService,
    private readonly cart: CartService,
    private readonly addresses: AddressesService,
    private readonly orders: OrdersService,
    private readonly orderPayments: OrderPaymentService,
    private readonly decisions: CheckoutDecisionService,
    private readonly fulfilment: FulfilmentService,
    private readonly plans: CustomerPlansService,
  ) {}

  private async customerId(user: AuthenticatedUser): Promise<string> {
    const customer = await this.customers.findByUserId(user.id);
    if (!customer) throw new CustomerNotFoundError(user.id);
    return customer.id;
  }

  /** The audit actor for a customer-initiated action. */
  private actorFor(customerId: string) {
    return { actorId: customerId, actorType: 'customer' as const };
  }

  // --- Cart -----------------------------------------------------------------

  @Get('cart')
  @ApiModel('CartWithItems')
  async getCart(@CurrentUser() user: AuthenticatedUser) {
    return this.cart.getCart(await this.customerId(user));
  }

  @Post('cart/items')
  @HttpCode(200)
  @ApiZodBody(addCartItemSchema)
  @ApiModel('CartWithItems')
  async addItem(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.cart.addItem(await this.customerId(user), body);
  }

  @Put('cart/items/:variantId')
  @HttpCode(200)
  @ApiZodBody(setCartItemQuantitySchema)
  @ApiModel('CartWithItems')
  async setItemQuantity(
    @Param('variantId') variantId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cart.setItemQuantity(await this.customerId(user), variantId, body);
  }

  @Delete('cart/items/:variantId')
  @HttpCode(200)
  @ApiModel('CartWithItems')
  async removeItem(@Param('variantId') variantId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.cart.removeItem(await this.customerId(user), variantId);
  }

  @Delete('cart')
  @HttpCode(200)
  @ApiModel('CartWithItems')
  async clearCart(@CurrentUser() user: AuthenticatedUser) {
    return this.cart.clear(await this.customerId(user));
  }

  // --- Checkout & orders ----------------------------------------------------

  @Post('checkout')
  @HttpCode(201)
  // Instalment checkout opens a credit line and reserves stock, so it is a
  // financial commitment: a retry on a dropped mobile connection must not
  // become a second order and a second credit application.
  @Idempotent()
  @ApiZodBody(checkoutSchema)
  @ApiModel('DecidedOrder', { array: true, created: true })
  async checkout(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const customerId = await this.customerId(user);
    const actor = this.actorFor(customerId);
    const orders = await this.orders.checkout(customerId, body, actor);
    // Score and activate immediately, so an instalment customer leaves checkout
    // with a decision, a plan and a deposit to pay rather than an order parked
    // in pending_approval waiting for a member of staff. This runs after the
    // checkout transaction has committed because scoring and activation each
    // open their own — see CheckoutDecisionService for what that costs.
    return this.decisions.decideAll(orders, actor);
  }

  @Get('orders')
  @ApiModel('OrderWithItems', { array: true })
  async listOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.listForCustomer(await this.customerId(user));
  }

  /**
   * Lets a customer pay for their own pay-in-full order by Mobile Money.
   *
   * Before this, the only way an order got paid was an operator reconciling the
   * money by hand — there was no way for a customer to pay online at all.
   *
   * `@Idempotent()` because it moves money. The provider reference is also
   * derived from the order id and so is stable across retries, which means a
   * customer who taps Pay again after a timeout sends the provider the same
   * reference rather than starting a second debit.
   */
  @Post('orders/:id/pay-momo')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({ summary: 'Pay for one of my orders by Mobile Money' })
  async payOrderMomo(
    @Param('id') id: string,
    @Body() body: { phone?: string; provider?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const customer = await this.customers.findByUserId(user.id);
    if (!customer) throw new CustomerNotFoundError(user.id);
    const customerId = customer.id;

    // Charge the details on the request if given, otherwise the saved ones.
    const phone = body?.phone?.trim() || customer.momo_phone || '';
    const provider = body?.provider?.trim() || customer.momo_provider || '';
    if (!phone) {
      throw new BadRequestException('Mobile Money phone is required (none on file)');
    }
    if (provider !== 'mtn' && provider !== 'tgo' && provider !== 'vod') {
      throw new BadRequestException('Mobile Money provider must be one of mtn, tgo, vod');
    }

    return this.orderPayments.payWithMobileMoney(
      { orderId: id, customerId, email: customer.email, phone, provider },
      this.actorFor(customerId),
    );
  }

  /**
   * Lets a customer cancel their own unpaid order.
   *
   * This is the common way stock comes back: someone checks out, never pays,
   * and changes their mind. Their units were reserved at checkout, and before
   * this there was no way — for them or for anyone — to release them.
   *
   * The customer id is passed down and checked inside the same transaction as
   * the row lock, so someone else's order id answers 404 rather than confirming
   * it exists.
   */
  @Post('orders/:id/cancel')
  @ApiZodBody(cancelOrderSchema)
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel one of your own unpaid orders' })
  async cancelOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const customerId = await this.customerId(user);
    return this.orders.cancel(id, body, this.actorFor(customerId), { customerId });
  }

  /**
   * One of my orders, with the instalment plan behind it.
   *
   * The confirmation and tracking screens both show the remaining schedule, and
   * without the plan attached here the client would have to discover the plan id
   * from the order, then fetch the plan, then fetch its schedule — three round
   * trips on a handset to render one card.
   */
  @Get('orders/:id')
  @ApiModel('OrderWithPlan')
  async getOrder(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const customerId = await this.customerId(user);
    const order = await this.orders.get(customerId, id);
    if (!order.customer_plan_id) {
      return { ...order, plan: null, schedule: [], pickup_hub: null };
    }
    const [plan, schedule, pickupHub] = await Promise.all([
      this.plans.get(order.customer_plan_id),
      this.plans.getSchedule(order.customer_plan_id),
      order.pickup_hub_id ? this.fulfilment.pickupHub(order.pickup_hub_id) : Promise.resolve(null),
    ]);
    return { ...order, plan, schedule, pickup_hub: pickupHub };
  }

  // --- Addresses ------------------------------------------------------------

  @Get('addresses')
  @ApiModel('Address', { array: true })
  async listAddresses(@CurrentUser() user: AuthenticatedUser) {
    return this.addresses.list(await this.customerId(user));
  }

  @Post('addresses')
  @HttpCode(201)
  @ApiZodBody(createAddressSchema)
  @ApiModel('Address', { created: true })
  async createAddress(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.addresses.create(await this.customerId(user), body);
  }

  @Get('addresses/:id')
  @ApiModel('Address')
  async getAddress(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.addresses.get(await this.customerId(user), id);
  }

  @Patch('addresses/:id')
  @ApiZodBody(updateAddressSchema)
  @ApiModel('Address')
  async updateAddress(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.addresses.update(await this.customerId(user), id, body);
  }

  @Post('addresses/:id/default')
  @HttpCode(200)
  @ApiModel('Address')
  async setDefaultAddress(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.addresses.setDefault(await this.customerId(user), id);
  }

  @Delete('addresses/:id')
  @HttpCode(204)
  async removeAddress(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.addresses.remove(await this.customerId(user), id);
  }
}
