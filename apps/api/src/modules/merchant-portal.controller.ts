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
  MERCHANT_ORDER_BUCKETS,
  MerchantOrdersService,
  MERCHANT_PLAN_BUCKETS,
  MERCHANT_RETURN_BUCKETS,
  MerchantPlansService,
  MerchantReturnsService,
  type MerchantReturnBucket,
  isMerchantOrderBucket,
  isMerchantPlanBucket,
  OrdersService,
  ReturnsService,
  markDeliveredSchema,
  markOutForDeliverySchema,
  markShippedSchema,
  rejectReturnSchema,
  sellerFees,
} from '@installment/commerce';
import {
  CustomerPlansService,
  DevicesService,
  MerchantDashboardService,
  MerchantKycService,
  MerchantsService,
  PayoutAccountService,
  payoutsForSeller,
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
import { RateLimit } from '../common/rate-limit.decorator';
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
    private readonly orderReturns: ReturnsService,
    private readonly merchants: MerchantsService,
    private readonly planTemplates: PlanTemplatesService,
    private readonly fulfilment: FulfilmentService,
    private readonly orders: OrdersService,
    private readonly merchantOrders: MerchantOrdersService,
    private readonly merchantPlans: MerchantPlansService,
    private readonly merchantReturns: MerchantReturnsService,
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

  /**
   * The queue, as the app draws it.
   *
   * Separate from `GET orders` rather than an extra flag on it, because the two
   * answer different questions. That route filters on one raw order status and
   * is what the web portal and any integrator use; this one filters on the
   * seller's own buckets — where "new" is two statuses and "confirmed" is
   * `fulfilling`, a status whose name only a developer would recognise — and
   * carries the buyer and what the ledger settled, which a status list does not.
   */
  @Get('queue')
  @ApiOperation({ summary: 'My order queue, with the buyer and what each order settled for' })
  @ApiModel('MerchantOrderPage')
  queue(@Query() query: Record<string, string>, @CurrentMerchantId() merchantId: string) {
    const bucket = query.bucket;
    if (bucket !== undefined && !isMerchantOrderBucket(bucket)) {
      throw new BadRequestException(
        `bucket must be one of ${Object.keys(MERCHANT_ORDER_BUCKETS).join(', ')}`,
      );
    }
    return this.merchantOrders.list(merchantId, {
      bucket,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  /**
   * How many orders sit in each bucket.
   *
   * Its own route so the filter chips can show their counts without six
   * requests, and so the count on a chip is the count of the list behind it —
   * derived from the same bucket table, not from whatever page happens to be
   * loaded.
   */
  @Get('queue/counts')
  @ApiOperation({ summary: 'How many orders are in each bucket of my queue' })
  @ApiModel('MerchantOrderCounts')
  queueCounts(@CurrentMerchantId() merchantId: string) {
    return this.merchantOrders.counts(merchantId);
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'One of my orders' })
  @ApiModel('OrderWithItems')
  getOrder(@Param('id') id: string, @CurrentMerchantId() merchantId?: string) {
    return this.orders.getForMerchant(merchantId!, id);
  }

  /**
   * Everything the order sheet draws: the buyer, where it is going, what the
   * ledger paid, the plan behind it and the order's own history.
   *
   * One route rather than five, because a seller opening an order on a phone
   * should wait for one round trip and not five. The alternative the app would
   * otherwise need — order, then customer, then address, then plan, then
   * schedule — also cannot be expressed: there is no merchant-scoped route over
   * `customers`, `addresses` or `order_events` at all.
   */
  @Get('orders/:id/sheet')
  @ApiOperation({ summary: 'One of my orders, with buyer, delivery, settlement, plan and history' })
  @ApiModel('MerchantOrderDetail')
  getOrderSheet(@Param('id') id: string, @CurrentMerchantId() merchantId: string) {
    return this.merchantOrders.detail(merchantId, id);
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

  /**
   * With `fees`: what a sale actually costs this seller. Every fee the app
   * showed was read from `default_mdr_bps`, which nothing has charged since
   * migration 0009 — so the rule is computed here, once, from the code that
   * charges it, rather than re-derived on a handset.
   */
  @Get('me')
  @ApiOperation({ summary: 'The authenticated merchant profile, with the fees a sale carries' })
  @ApiModel('MerchantProfile')
  async me(@CurrentMerchantId() merchantId: string) {
    const merchant = await this.merchants.get(merchantId);
    return { ...merchant, fees: sellerFees(merchant) };
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

  /**
   * Texts the merchant's phone a code for replacing their payout account with
   * this one. Each send is an SMS we pay for, hence the tight limit.
   */
  @Post('payout-account/code')
  @HttpCode(200)
  @RateLimit({ limit: 5, windowSeconds: 900, bucket: 'payout-account-code' })
  @ApiOperation({ summary: 'Text me a code to change where my settlements are sent' })
  @ApiZodBody(resolvePayoutAccountSchema)
  sendPayoutChangeCode(@Body() body: unknown, @CurrentMerchantId() merchantId: string) {
    return this.payoutAccount.sendChangeCode(merchantId, body);
  }

  /**
   * Replacing an account already on file needs `code` from the route above;
   * the first account does not. A replacement is not paid for 24 hours.
   */
  @Post('payout-account')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set where my settlements are sent' })
  @ApiZodBody(setPayoutAccountSchema)
  @ApiModel('Merchant')
  setPayoutAccount(@Body() body: unknown, @CurrentMerchantId() merchantId: string) {
    return this.payoutAccount.set(merchantId, body, this.actor(merchantId));
  }

  // ------------------------------------------------------------------ returns
  //
  // The seller decides on what comes back. Approving reverses the sale in the
  // ledger, puts the stock back on sale and raises the buyer's refund, all in
  // one transaction — so there is no state in which the order says `returned`
  // and nobody is on the hook for the money.

  @Get('returns')
  @ApiOperation({ summary: 'Returns waiting on me, and the ones I have decided' })
  returns(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    return this.orderReturns.list(q, { merchantId });
  }

  /**
   * The same returns, projected for the seller's queue.
   *
   * Alongside `GET returns` rather than replacing it: that one answers with the
   * `order_returns` rows and is what the web portal and the tests read. This
   * one carries the sale, the buyer and what a decision costs — none of which
   * is on the row, and all of which a card needs. Same split, same reason, as
   * `/merchant/orders` and `/merchant/queue`.
   */
  @Get('return-list')
  @ApiOperation({ summary: 'My returns queue, with the sale and what deciding costs' })
  @ApiModel('MerchantReturnPage')
  returnList(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    const bucket = MERCHANT_RETURN_BUCKETS.includes(q.bucket as MerchantReturnBucket)
      ? (q.bucket as MerchantReturnBucket)
      : undefined;
    return this.merchantReturns.list(merchantId, {
      bucket,
      limit: numOrUndefined(q.limit),
      offset: numOrUndefined(q.offset),
    });
  }

  @Get('return-list/counts')
  @ApiOperation({ summary: 'How many returns are in each bucket' })
  @ApiModel('MerchantReturnCounts')
  returnCounts(@CurrentMerchantId() merchantId: string) {
    return this.merchantReturns.counts(merchantId);
  }

  @Get('return-list/:id')
  @ApiOperation({ summary: 'One of my returns, in full' })
  @ApiModel('MerchantReturnDetail')
  returnListDetail(@Param('id') id: string, @CurrentMerchantId() merchantId: string) {
    return this.merchantReturns.detail(merchantId, id);
  }

  @Get('returns/:id')
  @ApiOperation({ summary: 'One return' })
  returnDetail(@Param('id') id: string, @CurrentMerchantId() merchantId: string) {
    return this.orderReturns.get(id, { merchantId });
  }

  @Post('returns/:id/approve')
  @ApiOperation({ summary: 'Accept the return, refund the buyer and restock' })
  approveReturn(@Param('id') id: string, @CurrentMerchantId() merchantId: string) {
    return this.orderReturns.approve(id, this.actor(merchantId), { merchantId });
  }

  @Post('returns/:id/reject')
  @ApiOperation({ summary: 'Refuse the return, saying why' })
  @ApiZodBody(rejectReturnSchema)
  rejectReturn(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentMerchantId() merchantId: string,
  ) {
    return this.orderReturns.reject(id, body, this.actor(merchantId), { merchantId });
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

  /**
   * The seller's payout history. `lastError` is a sentence written for the
   * seller — what happened and where the money is — not the provider's text,
   * which the admin console's `/merchants/:id/payouts` keeps for operations.
   */
  @Get('payouts')
  async payouts(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    return payoutsForSeller(
      await this.dashboard.listPayouts(merchantId, {
        status: q.status,
        limit: numOrUndefined(q.limit),
        offset: numOrUndefined(q.offset),
      }),
    );
  }

  /**
   * Reserve held against the merchant's plans, with the sale each one came from.
   *
   * The engine's `held_reserves` row knows its plan and nothing else — the link
   * to the order runs the other way — so on its own the list is uuids and cedi
   * amounts and a seller cannot tell which sale is holding their money. The
   * order lookup lives in commerce, which owns `orders`, rather than being
   * joined inside the engine's dashboard service: the dependency runs
   * commerce → core and reaching back the other way to read a commerce table
   * would invert it.
   */
  @Get('reserves')
  @ApiOperation({ summary: 'Reserve held against my plans, and when each releases' })
  @ApiModel('MerchantHeldReserve', { array: true })
  async reserves(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    const rows = await this.dashboard.listHeldReserves(merchantId, {
      open: q.open === undefined ? undefined : q.open !== 'false',
    });
    const orders = await this.merchantOrders.ordersForPlans(
      merchantId,
      rows.map((r) => r.customerPlanId),
    );
    return rows.map((row) => {
      const order = orders.get(row.customerPlanId);
      return {
        ...row,
        // Null, not a placeholder: the reserve outlives the order, and a row
        // reading "—" is honest where an invented reference would not be.
        orderNumber: order?.orderNumber ?? null,
        itemSummary: order?.itemSummary ?? null,
      };
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

  /**
   * The plans as the seller's app draws them.
   *
   * Separate from `GET plans`, which returns bare `customer_plans` rows and is
   * what the web portal and any integrator use. Those rows carry no customer,
   * no product and no schedule — a plan knows none of it, because the link to
   * the order runs the other way — so a list built on them is a column of
   * uuids. This one filters on the seller's own buckets, including `late`,
   * which is not a status: a plan in arrears stays `active` and the overdue
   * rows live on the schedule.
   */
  @Get('plan-list')
  @ApiOperation({ summary: 'My credit plans, with the sale and the schedule behind each' })
  @ApiModel('MerchantPlanPage')
  planList(@Query() query: Record<string, string>, @CurrentMerchantId() merchantId: string) {
    const bucket = query.bucket;
    if (bucket !== undefined && !isMerchantPlanBucket(bucket)) {
      throw new BadRequestException(`bucket must be one of ${MERCHANT_PLAN_BUCKETS.join(', ')}`);
    }
    return this.merchantPlans.list(merchantId, {
      bucket,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get('plan-list/counts')
  @ApiOperation({ summary: 'How many plans are in each bucket' })
  @ApiModel('MerchantPlanCounts')
  planCounts(@CurrentMerchantId() merchantId: string) {
    return this.merchantPlans.counts(merchantId);
  }

  /** One plan: the sale, the schedule, and what the ledger settled on it. */
  @Get('plan-list/:id')
  @ApiOperation({ summary: 'One of my credit plans, in full' })
  @ApiModel('MerchantPlanDetail')
  planDetail(@Param('id') id: string, @CurrentMerchantId() merchantId: string) {
    return this.merchantPlans.detail(merchantId, id);
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
