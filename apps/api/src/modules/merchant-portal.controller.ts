import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  FulfilmentService,
  MerchantStatsService,
  OrdersService,
  markDeliveredSchema,
  markOutForDeliverySchema,
  markShippedSchema,
} from '@installment/commerce';
import {
  CustomerPlansService,
  DevicesService,
  MerchantDashboardService,
  MerchantKycService,
  MerchantsService,
  PayoutAccountService,
  PlanTemplatesService,
  registerDeviceSchema,
  resolvePayoutAccountSchema,
  setPayoutAccountSchema,
  submitKycDocumentSchema,
  renderMerchantStatementCsv,
  renderMerchantStatementHtml,
  renderStatementCsv,
  renderStatementHtml,
  type CustomerPlan,
} from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentMerchantId } from '../auth/decorators';
import { ApiModel } from '../common/api-model';
import { ApiZodBody } from '../common/api-zod';
import { MerchantScopeGuard } from '../auth/merchant-scope.guard';
import { numOrUndefined } from '../auth/current-actor';
import { keyBelongsTo } from '../media/upload-policy';

function parsePeriod(q: Record<string, string>): { year: number; month: number } {
  const now = new Date();
  const year = q.year ? Number(q.year) : now.getUTCFullYear();
  const month = q.month ? Number(q.month) : now.getUTCMonth() + 1;
  if (
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2100 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    throw new BadRequestException('Invalid year/month');
  }
  return { year, month };
}

/**
 * Merchant self-service portal. Every route is scoped to the caller's own
 * merchant (resolved by MerchantScopeGuard); plan sub-resources are
 * ownership-checked so a merchant can never read another merchant's data.
 */
@ApiTags('merchant-portal')
@ApiBearerAuth()
@UseGuards(MerchantScopeGuard)
@Controller('merchant')
export class MerchantPortalController {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly dashboard: MerchantDashboardService,
    private readonly stats: MerchantStatsService,
    private readonly merchants: MerchantsService,
    private readonly planTemplates: PlanTemplatesService,
    private readonly fulfilment: FulfilmentService,
    private readonly orders: OrdersService,
    private readonly payoutAccount: PayoutAccountService,
    private readonly kyc: MerchantKycService,
    private readonly devices: DevicesService,
  ) {}

  // --- Fulfilment -----------------------------------------------------------
  //
  // Every route here passes the caller's own merchant id into the service,
  // which puts it in the WHERE clause — so another merchant's order is
  // indistinguishable from one that does not exist, the same rule the rest of
  // the scoped surface follows.

  /**
   * A merchant's own orders.
   *
   * The fulfilment routes below let a merchant ship and deliver; until this
   * there was no way for them to SEE what they had sold, so the whole loop was
   * only reachable by someone who already knew an order's uuid. The merchant id
   * comes from MerchantScopeGuard and goes into the WHERE clause, never a check
   * after the fact — another merchant's order reads as one that does not exist.
   */
  @Get('orders')
  @ApiOperation({ summary: 'List my orders' })
  @ApiModel('OrderWithItems', { array: true })
  listOrders(@Query() query: Record<string, string>, @CurrentMerchantId() merchantId?: string) {
    return this.orders.listForMerchant(merchantId!, {
      status: query.status || undefined,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'One of my orders' })
  @ApiModel('OrderWithItems')
  getOrder(@Param('id') id: string, @CurrentMerchantId() merchantId?: string) {
    return this.orders.getForMerchant(merchantId!, id);
  }

  /**
   * "We are packing it." Optional — marking an order shipped moves it through
   * this state on its own — but a seller who wants to tell the customer
   * something is happening can say so.
   */
  @Post('orders/:id/fulfilling')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start preparing one of my orders' })
  @ApiModel('Order')
  startFulfilment(@Param('id') id: string, @CurrentMerchantId() merchantId: string) {
    return this.fulfilment.startFulfilment(id, this.actor(merchantId), { merchantId });
  }

  /** The order has left the seller. Creates the shipment with whatever courier detail exists. */
  @Post('orders/:id/ship')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark one of my orders shipped' })
  @ApiZodBody(markShippedSchema)
  @ApiModel('Order')
  markShipped(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentMerchantId() merchantId: string,
  ) {
    return this.fulfilment.markShipped(id, body, this.actor(merchantId), { merchantId });
  }

  @Post('orders/:id/out-for-delivery')
  @HttpCode(200)
  @ApiOperation({ summary: 'The rider is on the way with one of my orders' })
  @ApiZodBody(markOutForDeliverySchema)
  @ApiModel('Order')
  markOutForDelivery(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentMerchantId() merchantId: string,
  ) {
    return this.fulfilment.markOutForDelivery(id, body, this.actor(merchantId), { merchantId });
  }

  /**
   * Delivery — the event the rest of the system waits for.
   *
   * It starts the customer's return window, makes the line reviewable, and on a
   * financed order releases the layaway reserve against a real signal rather
   * than a staff member's estimate.
   */
  @Post('orders/:id/delivered')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark one of my orders delivered or collected' })
  @ApiZodBody(markDeliveredSchema)
  @ApiModel('Order')
  markDelivered(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentMerchantId() merchantId: string,
  ) {
    return this.fulfilment.markDelivered(id, body, this.actor(merchantId), { merchantId });
  }

  /** A merchant acts as themselves; the audit trail records the merchant id. */
  private actor(merchantId: string) {
    return { actorId: merchantId, actorType: 'merchant' as const };
  }

  @Get('me')
  @ApiOperation({ summary: 'The authenticated merchant profile' })
  me(@CurrentMerchantId() merchantId: string) {
    return this.merchants.get(merchantId);
  }

  // --- Push devices ---------------------------------------------------------
  //
  // `push_devices` shipped in 0015 with customer_id NOT NULL, so a merchant
  // handset could not be registered at all — and nothing anywhere sent a push,
  // which is the other half this slice closes. A merchant who is not told an
  // order arrived does not confirm it, and the dashboard's "confirm within 24h
  // to keep your rating" is a promise the app could not keep.

  @Post('devices')
  @HttpCode(201)
  @ApiOperation({ summary: 'Register this handset for order notifications' })
  @ApiZodBody(registerDeviceSchema)
  registerDevice(@Body() body: unknown, @CurrentMerchantId() merchantId: string) {
    return this.devices.register({ merchantId }, body);
  }

  @Delete('devices/:token')
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop sending notifications to this handset' })
  async deactivateDevice(
    @Param('token') token: string,
    @CurrentMerchantId() merchantId: string,
  ): Promise<void> {
    // Scoped to the caller, so signing out cannot silence somebody else's phone.
    await this.devices.deactivate({ merchantId }, token);
  }

  // --- KYC ------------------------------------------------------------------
  //
  // A merchant could sign themselves up (#62) and then had no way to send any
  // evidence at all: the Ghana Card columns are on `customers` and the
  // `kyc_document` upload purpose belongs to a customer. Leaving `pending_kyc`
  // meant an admin pressing Activate against nothing.

  @Get('kyc')
  @ApiOperation({ summary: 'My KYC documents and what is still outstanding' })
  kycStatus(@CurrentMerchantId() merchantId: string) {
    return this.kyc.statusFor(merchantId);
  }

  /**
   * Attach a document already uploaded through `POST /merchant/uploads`.
   *
   * The key comes back from the client, which is the same door the product-image
   * route has to guard: without `keyBelongsTo` a merchant could submit the
   * object at another merchant's key as their own evidence.
   */
  @Post('kyc/documents')
  @HttpCode(201)
  @ApiOperation({ summary: 'Submit a KYC document for review' })
  @ApiZodBody(submitKycDocumentSchema)
  submitKyc(@Body() body: unknown, @CurrentMerchantId() merchantId: string) {
    const key = (body as { storage_key?: unknown } | null)?.storage_key;
    if (typeof key === 'string' && !keyBelongsTo('merchant_kyc_document', key, merchantId)) {
      throw new BadRequestException('storage_key was not issued to this merchant');
    }
    return this.kyc.submit(merchantId, body, this.actor(merchantId));
  }

  // --- Payout account -------------------------------------------------------
  //
  // Until these routes, `merchants.paystack_recipient_code` could only be set
  // by an admin pasting a code out of the Paystack dashboard, so a merchant who
  // signed themselves up accrued a payable balance the daily settlement run
  // skipped every day with "no Paystack recipient code".

  @Get('payout-account/destinations')
  @ApiOperation({ summary: 'Banks and mobile-money wallets I can be paid into' })
  destinations() {
    return this.payoutAccount.listDestinations();
  }

  @Get('payout-account')
  @ApiOperation({ summary: 'Where my settlements are sent' })
  payoutAccountGet(@CurrentMerchantId() merchantId: string) {
    return this.payoutAccount.get(merchantId);
  }

  /**
   * Who the bank says owns an account, without saving anything — so the console
   * can show the name back before the merchant commits.
   */
  @Post('payout-account/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check an account number with the bank' })
  @ApiZodBody(resolvePayoutAccountSchema)
  resolvePayoutAccount(@Body() body: unknown, @CurrentMerchantId() merchantId: string) {
    return this.payoutAccount.resolve(merchantId, body);
  }

  @Post('payout-account')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set where my settlements are sent' })
  @ApiZodBody(setPayoutAccountSchema)
  @ApiModel('Merchant')
  setPayoutAccount(@Body() body: unknown, @CurrentMerchantId() merchantId: string) {
    return this.payoutAccount.set(merchantId, body, this.actor(merchantId));
  }

  @Get('balances')
  balances(@CurrentMerchantId() merchantId: string) {
    return this.dashboard.getBalances(merchantId);
  }

  /**
   * The merchant's own trading figures, over 7, 30 or 90 days.
   *
   * `days` is validated in the service and refused if it is not one of those,
   * rather than clamped: a client asking for 45 and being handed 30 would read
   * the answer as 45.
   *
   * No traffic-source breakdown. The design has a card for one and there is no
   * attribution model in this system to fill it — see `MerchantStatsService`.
   */
  @Get('stats')
  @ApiOperation({ summary: 'Sales, orders, average basket and cancellations over a window' })
  merchantStats(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    return this.stats.forMerchant(merchantId, q.days === undefined ? {} : { days: q.days });
  }

  @Get('payouts')
  payouts(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    return this.dashboard.listPayouts(merchantId, {
      status: q.status,
      limit: numOrUndefined(q.limit),
      offset: numOrUndefined(q.offset),
    });
  }

  @Get('reserves')
  reserves(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    return this.dashboard.listHeldReserves(merchantId, {
      open: q.open === undefined ? undefined : q.open !== 'false',
    });
  }

  @Get('statement')
  @ApiOperation({ summary: 'Monthly account statement (JSON)' })
  statement(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    const { year, month } = parsePeriod(q);
    return this.dashboard.getMonthlyStatement(merchantId, year, month);
  }

  @Get('statement.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="merchant-statement.csv"')
  async statementCsv(
    @CurrentMerchantId() merchantId: string,
    @Query() q: Record<string, string>,
  ): Promise<string> {
    const { year, month } = parsePeriod(q);
    return renderMerchantStatementCsv(
      await this.dashboard.getMonthlyStatement(merchantId, year, month),
    );
  }

  @Get('statement.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async statementHtml(
    @CurrentMerchantId() merchantId: string,
    @Query() q: Record<string, string>,
  ): Promise<string> {
    const { year, month } = parsePeriod(q);
    return renderMerchantStatementHtml(
      await this.dashboard.getMonthlyStatement(merchantId, year, month),
    );
  }

  @Get('plans')
  @ApiOperation({ summary: "The merchant's orders (customer plans), newest first" })
  listPlans(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    return this.plans.listByMerchant(merchantId, {
      status: q.status,
      limit: numOrUndefined(q.limit),
      offset: numOrUndefined(q.offset),
    });
  }

  @Get('plans/:id')
  planGet(@CurrentMerchantId() merchantId: string, @Param('id') id: string) {
    return this.ownPlan(id, merchantId);
  }

  @Get('plans/:id/schedule')
  async planSchedule(@CurrentMerchantId() merchantId: string, @Param('id') id: string) {
    await this.ownPlan(id, merchantId);
    return this.plans.getSchedule(id);
  }

  @Get('plans/:id/statement')
  async planStatement(@CurrentMerchantId() merchantId: string, @Param('id') id: string) {
    await this.ownPlan(id, merchantId);
    return this.plans.getStatement(id);
  }

  @Get('plans/:id/statement.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="statement.csv"')
  async planStatementCsv(
    @CurrentMerchantId() merchantId: string,
    @Param('id') id: string,
  ): Promise<string> {
    await this.ownPlan(id, merchantId);
    return renderStatementCsv(await this.plans.getStatement(id));
  }

  @Get('plans/:id/statement.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async planStatementHtml(
    @CurrentMerchantId() merchantId: string,
    @Param('id') id: string,
  ): Promise<string> {
    await this.ownPlan(id, merchantId);
    return renderStatementHtml(await this.plans.getStatement(id));
  }

  @Get('plans/:id/settlement')
  async planSettlement(@CurrentMerchantId() merchantId: string, @Param('id') id: string) {
    await this.ownPlan(id, merchantId);
    const view = await this.dashboard.getPlanSettlement(id);
    if (!view) throw new NotFoundException(`Plan ${id} not found`);
    return view;
  }

  @Get('plan-templates')
  @ApiOperation({ summary: 'Active plan templates the merchant can offer (read-only)' })
  async planTemplatesList() {
    const all = await this.planTemplates.list({ is_active: true, limit: 200 });
    return all;
  }

  /** Loads a plan and asserts it belongs to this merchant (404 otherwise). */
  private async ownPlan(planId: string, merchantId: string): Promise<CustomerPlan> {
    const plan = await this.plans.get(planId);
    if (plan.merchant_id !== merchantId) {
      throw new NotFoundException(`Plan ${planId} not found`);
    }
    return plan;
  }
}
