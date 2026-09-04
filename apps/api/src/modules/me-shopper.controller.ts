import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  DevicesService,
  FulfilmentService,
  ReviewsService,
  WishlistService,
  createReviewSchema,
  registerDeviceSchema,
} from '@installment/commerce';
import {
  CustomerCreditService,
  CustomerNotFoundError,
  CustomerPlansService,
  CustomersService,
  InstallmentsFeedService,
  attachGhanaCardSchema,
  setMomoSchema,
  updateCustomerSchema,
} from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators';
import { ApiModel } from '../common/api-model';
import { ApiZodBody } from '../common/api-zod';
import { keyBelongsTo } from '../media/upload-policy';

/**
 * What a customer may change about themselves.
 *
 * Deliberately a narrow slice of `updateCustomerSchema`: phone is the login
 * identity and changing it is a re-verification flow, not a profile edit, and
 * KYC, blocklist and consent fields are written by their own audited paths.
 */
export const updateProfileSchema = updateCustomerSchema.pick({
  first_name: true,
  last_name: true,
  email: true,
});

export const setAutopaySchema = z.object({ enabled: z.boolean() });

export const addWishlistSchema = z.object({ product_id: z.string().uuid() });

/**
 * The authenticated customer's own view of themselves: profile, credit standing,
 * instalments across every plan, saved items, reviews and devices.
 *
 * Split from `MeCommerceController` (cart, checkout, orders, addresses) because
 * that one is the buying journey and this one is the account — and because a
 * single `/me` controller with twenty-odd routes stops being reviewable.
 *
 * Ownership is enforced the way the rest of the `/me` surface does it: the
 * customer id goes into the WHERE clause, so another customer's row is
 * indistinguishable from a missing one (404, never 403).
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeShopperController {
  constructor(
    private readonly customers: CustomersService,
    private readonly credit: CustomerCreditService,
    private readonly feed: InstallmentsFeedService,
    private readonly plans: CustomerPlansService,
    private readonly wishlist: WishlistService,
    private readonly reviews: ReviewsService,
    private readonly devices: DevicesService,
    private readonly fulfilment: FulfilmentService,
  ) {}

  private async customerId(user: AuthenticatedUser): Promise<string> {
    const customer = await this.customers.findByUserId(user.id);
    if (!customer) throw new CustomerNotFoundError(user.id);
    return customer.id;
  }

  // --- Profile --------------------------------------------------------------

  /**
   * Everything the account screen needs in one call: who the customer is, their
   * MoMo instrument, KYC standing, and the three counts the header tiles show.
   */
  @Get('profile')
  @ApiOperation({ summary: 'My profile, with order / plan / saved-item counts' })
  @ApiModel('CustomerProfile')
  async profile(@CurrentUser() user: AuthenticatedUser) {
    const customer = await this.customers.findByUserId(user.id);
    if (!customer) throw new CustomerNotFoundError(user.id);

    const [credit, savedItems, plans] = await Promise.all([
      this.credit.forCustomer(customer.id),
      this.wishlist.count(customer.id),
      this.plans.listForCustomer(customer.id),
    ]);

    return {
      id: customer.id,
      first_name: customer.first_name,
      last_name: customer.last_name,
      email: customer.email,
      phone: customer.phone,
      momo_phone: customer.momo_phone,
      momo_provider: customer.momo_provider,
      kyc_tier: customer.kyc_tier,
      ghana_card_verified: customer.ghana_card_verified,
      // Consents are surfaced as timestamps, not booleans: "when did I agree to
      // a credit check" is the question a customer (and a regulator) actually
      // asks, and a boolean cannot answer it.
      consents: {
        data_processing_at: customer.data_processing_consent_at,
        credit_scoring_at: customer.credit_scoring_consent_at,
        marketing_at: customer.marketing_consent_at,
      },
      credit,
      counts: {
        active_plans: plans.filter((p) => p.status === 'active').length,
        total_plans: plans.length,
        saved_items: savedItems,
      },
      created_at: customer.created_at,
    };
  }

  // --- Ghana Card -----------------------------------------------------------

  /**
   * A customer's own Ghana Card, sent from their own phone.
   *
   * Until this, `attachGhanaCard` had exactly one caller — the admin console —
   * so a shopper could not submit a card at all, and `POST /me/uploads` has
   * been minting presigned URLs for `kyc_document` with nothing to attach the
   * key to. Without a card, `verifyGhanaCard` refuses, `kyc_tier` stays 0, and
   * the 50 points a verified card is worth are unreachable from the app.
   *
   * The key is checked against the prefix this customer's uploads are issued
   * under — the same guard the merchant KYC route uses. Without it a customer
   * could submit the object at somebody else's key as their own identity
   * document, which is the one thing an identity check must not allow.
   */
  @Get('ghana-card')
  @ApiOperation({ summary: 'The state of my Ghana Card, and why it was rejected' })
  async ghanaCard(@CurrentUser() user: AuthenticatedUser) {
    const customer = await this.customers.findByUserId(user.id);
    if (!customer) throw new CustomerNotFoundError(user.id);
    return this.customers.ghanaCardStatusFor(customer.id);
  }

  @Post('ghana-card')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send my Ghana Card for review' })
  @ApiZodBody(attachGhanaCardSchema)
  async attachGhanaCard(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const customer = await this.customers.findByUserId(user.id);
    if (!customer) throw new CustomerNotFoundError(user.id);

    const key = (body as { ghana_card_image_key?: unknown }).ghana_card_image_key;
    if (typeof key === 'string' && !keyBelongsTo('kyc_document', key, customer.id)) {
      throw new BadRequestException('ghana_card_image_key was not issued to this customer');
    }

    await this.customers.attachGhanaCard(customer.id, body, {
      actorId: customer.id,
      actorType: 'customer',
    });
    return this.customers.ghanaCardStatusFor(customer.id);
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update my name or email' })
  @ApiZodBody(updateProfileSchema)
  @ApiModel('Customer')
  async updateProfile(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const id = await this.customerId(user);
    const patch = updateProfileSchema.parse(body);
    return this.customers.update(id, patch, { actorId: id, actorType: 'customer' });
  }

  /**
   * Set the MoMo number instalments collect from.
   *
   * Worth its own route rather than a profile field: this is the instrument the
   * auto-debit sweep will charge, so it is an audited change on the customers
   * service, and the reminder cron skips a customer who has not set one.
   */
  @Post('momo')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set my Mobile Money number and network' })
  @ApiZodBody(setMomoSchema)
  @ApiModel('Customer')
  async setMomo(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const id = await this.customerId(user);
    return this.customers.setMomo(id, body, { actorId: id, actorType: 'customer' });
  }

  // --- Credit ---------------------------------------------------------------

  @Get('credit')
  @ApiOperation({ summary: 'My limit, how much is in use, and my repayment record' })
  @ApiModel('CreditStanding')
  async creditStanding(@CurrentUser() user: AuthenticatedUser) {
    return this.credit.forCustomer(await this.customerId(user));
  }

  // --- Instalments across every plan ---------------------------------------

  /**
   * Every instalment the customer owes, in one call.
   *
   * Three screens need exactly this — the home screen's due strip, the due strip
   * on each order card, and the Instalments screen — and the engine only offered
   * it per plan. Assembling it client-side would be one request per plan plus
   * one per schedule, on a mobile network, to render a single line.
   */
  @Get('installments')
  @ApiOperation({ summary: 'My instalments across every plan' })
  @ApiModel('FeedInstallment', { array: true })
  async installments(
    @Query() query: Record<string, string>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.feed.forCustomer(await this.customerId(user), query);
  }

  /**
   * The single next thing owed — the home screen's due strip.
   *
   * Wrapped in an object rather than returned bare: Nest serialises a bare
   * `null` as an EMPTY 200 body, which is not parseable JSON, so a customer
   * with nothing due would crash the client rather than render an empty strip.
   */
  @Get('installments/next')
  @ApiOperation({ summary: 'The single next instalment I owe, if any' })
  async nextInstallment(@CurrentUser() user: AuthenticatedUser) {
    const installment = await this.feed.nextDue(await this.customerId(user));
    return { installment };
  }

  /**
   * Turn automatic Mobile Money collection on or off for one of my plans.
   *
   * Switching it off stops us reaching for the customer's money unasked. It does
   * not waive the instalment — late-fee accrual and the reminder sweep both
   * ignore this flag on purpose, and the app's copy says so.
   */
  @Post('plans/:id/autopay')
  @HttpCode(200)
  @ApiOperation({ summary: 'Turn auto-debit on or off for one of my plans' })
  @ApiZodBody(setAutopaySchema)
  @ApiModel('CustomerPlan')
  async setAutopay(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const customerId = await this.customerId(user);
    const { enabled } = setAutopaySchema.parse(body);
    return this.plans.setAutopay(id, customerId, enabled, {
      actorId: customerId,
      actorType: 'customer',
    });
  }

  // --- Order tracking -------------------------------------------------------

  @Get('orders/:id/tracking')
  @ApiOperation({ summary: 'Where one of my orders has got to' })
  @ApiModel('OrderTracking')
  async tracking(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const customerId = await this.customerId(user);
    const tracking = await this.fulfilment.tracking(id, customerId);
    if (!tracking) throw new NotFoundException(`Order "${id}" not found`);
    return tracking;
  }

  // --- Saved items ----------------------------------------------------------

  @Get('wishlist')
  @ApiOperation({ summary: 'My saved items' })
  @ApiModel('StorefrontProduct', { array: true })
  async savedItems(@CurrentUser() user: AuthenticatedUser) {
    return this.wishlist.list(await this.customerId(user));
  }

  /** Just the ids — what the product grid needs to fill in its hearts. */
  @Get('wishlist/ids')
  @ApiOperation({ summary: 'The product ids I have saved' })
  async savedItemIds(@CurrentUser() user: AuthenticatedUser) {
    return this.wishlist.ids(await this.customerId(user));
  }

  @Post('wishlist')
  @HttpCode(200)
  @ApiOperation({ summary: 'Save a product' })
  @ApiZodBody(addWishlistSchema)
  async saveItem(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    const { product_id } = addWishlistSchema.parse(body);
    await this.wishlist.add(await this.customerId(user), product_id);
    return { saved: true };
  }

  @Delete('wishlist/:productId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a saved product' })
  async unsaveItem(@Param('productId') productId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.wishlist.remove(await this.customerId(user), productId);
    return { saved: false };
  }

  // --- Reviews --------------------------------------------------------------

  @Get('reviews/pending')
  @ApiOperation({ summary: 'Delivered items I have not reviewed yet' })
  async pendingReviews(@CurrentUser() user: AuthenticatedUser) {
    return this.reviews.reviewable(await this.customerId(user));
  }

  @Post('reviews')
  @HttpCode(201)
  @ApiOperation({ summary: 'Review something I bought and received' })
  @ApiZodBody(createReviewSchema)
  async createReview(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.reviews.create(await this.customerId(user), body);
  }

  // --- Devices --------------------------------------------------------------

  @Post('devices')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register this handset for push notifications' })
  @ApiZodBody(registerDeviceSchema)
  async registerDevice(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.devices.register({ customerId: await this.customerId(user) }, body);
  }

  @Delete('devices/:token')
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop sending push to this handset' })
  async deregisterDevice(@Param('token') token: string, @CurrentUser() user: AuthenticatedUser) {
    await this.devices.deactivate({ customerId: await this.customerId(user) }, token);
  }
}
