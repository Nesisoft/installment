import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import {
  AddressesService,
  CartService,
  OrdersService,
  addCartItemSchema,
  checkoutSchema,
  createAddressSchema,
  setCartItemQuantitySchema,
  updateAddressSchema,
} from '@installment/commerce';
import { CustomerNotFoundError, CustomersService } from '@installment/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators';
import { ApiModel } from '../common/api-model';
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
  @ApiZodBody(checkoutSchema)
  @ApiModel('OrderWithItems', { array: true, created: true })
  async checkout(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const customerId = await this.customerId(user);
    return this.orders.checkout(customerId, body, this.actorFor(customerId));
  }

  @Get('orders')
  @ApiModel('OrderWithItems', { array: true })
  async listOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.listForCustomer(await this.customerId(user));
  }

  @Get('orders/:id')
  @ApiModel('OrderWithItems')
  async getOrder(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.orders.get(await this.customerId(user), id);
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
