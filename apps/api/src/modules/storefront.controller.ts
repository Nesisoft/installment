import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { FulfilmentService, StorefrontService } from '@installment/commerce';
import { PlanQuoteService, PlanTemplatesService, planQuoteSchema } from '@installment/core';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { ApiModel } from '../common/api-model';
import { ApiZodBody } from '../common/api-zod';
import { RateLimit } from '../common/rate-limit.decorator';

const numOrUndefined = (v: unknown): number | undefined =>
  v === undefined || v === '' ? undefined : Number(v);

/**
 * Public (unauthenticated) storefront reads for the shopping apps.
 *
 * Everything here is filtered to active products in active stores — the shop as
 * a shopper sees it. The admin controllers cover management and draft/suspended
 * visibility, and `ProductsService` (merchant CRUD) is deliberately not the
 * service behind these routes: what a seller may write and what a shopper may
 * see are different questions that drifted apart the moment the app needed
 * ratings and vendor names on a card.
 */
@ApiTags('storefront')
@Controller('storefront')
export class StorefrontController {
  constructor(
    private readonly planTemplates: PlanTemplatesService,
    private readonly storefront: StorefrontService,
    private readonly quotes: PlanQuoteService,
    private readonly fulfilment: FulfilmentService,
  ) {}

  /**
   * The home screen in one call.
   *
   * A handset on a Ghanaian mobile network pays for every round trip, so the
   * four rails the design shows are assembled server-side rather than by four
   * requests that each re-run the same joins.
   */
  @Public()
  @Get('home')
  @ApiOperation({ summary: 'Home feed: categories, live deals, instalment picks, newest' })
  @ApiModel('HomeFeed')
  home(@Query() query: Record<string, string>) {
    return this.storefront.home({ city: query.city });
  }

  @Public()
  @Get('stores/:slug')
  @ApiOperation({ summary: 'A store as its shopfront: profile plus rating, orders and on-time %' })
  @ApiModel('StorefrontStore')
  store(@Param('slug') slug: string) {
    return this.storefront.store(slug);
  }

  /**
   * Full-text search. Also the record behind "trending" — the term, the city and
   * the result count are logged so the trending list is real rather than a
   * hard-coded guess that would be wrong the day it shipped.
   */
  @Public()
  @Get('search')
  @ApiOperation({ summary: 'Search the catalogue' })
  @ApiModel('PaginatedProducts')
  search(@Query() query: Record<string, string>) {
    return this.storefront.search(query, { city: query.city });
  }

  @Public()
  @Get('trending')
  @ApiOperation({ summary: 'What people near you are searching for' })
  trending(@Query() query: Record<string, string>) {
    return this.storefront.trending(query);
  }

  /**
   * Browse and filter. Accepts everything the filter sheet offers — sort, price
   * band, instalment-only, in-stock — and returns a total, because "N items" is
   * on the screen and a bare array cannot answer it.
   */
  @Public()
  @Get('products')
  @ApiOperation({ summary: 'Browse the catalogue with sorting and filters' })
  @ApiModel('PaginatedProducts')
  productList(@Query() query: Record<string, string>) {
    return this.storefront.browse(query);
  }

  @Public()
  @Get('products/:id')
  @ApiModel('StorefrontProductDetails')
  product(@Param('id') id: string) {
    return this.storefront.product(id);
  }

  @Public()
  @Get('products/:id/reviews')
  @ApiOperation({ summary: 'Published reviews for a product' })
  reviews(@Param('id') id: string, @Query() query: Record<string, string>) {
    return this.storefront.reviews(id, query);
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'Active categories with artwork and product counts' })
  @ApiModel('StorefrontCategory', { array: true })
  categoryList(@Query() query: Record<string, string>) {
    return this.storefront.categories(query);
  }

  /**
   * The instalment plans currently on offer. Public because a shopper must see
   * "from GHS X / week" before signing in, and because `POST /me/checkout` needs
   * a `plan_template_id` the client can only obtain by reading this.
   */
  @Public()
  @Get('plan-templates')
  @ApiModel('PlanTemplate', { array: true })
  planTemplateList(@Query() query: Record<string, string>) {
    return this.planTemplates.list({
      business_model: query.business_model,
      is_active: true,
      effective_at: new Date().toISOString(),
      limit: numOrUndefined(query.limit) ?? 200,
      offset: numOrUndefined(query.offset),
    });
  }

  /**
   * What a plan would cost for an amount, as a full schedule.
   *
   * This runs the engine's own `ScheduleGenerator` — the same class that creates
   * the real rows at activation — so the preview on the product and checkout
   * screens is the contract, not an approximation of it. There is deliberately
   * no second implementation of this arithmetic anywhere for a client to drift
   * from.
   *
   * A POST because the input is a body (an amount and a set of template ids),
   * not because it changes anything: it is a pure read and safe to retry.
   */
  @Public()
  @Post('plan-quote')
  @HttpCode(200)
  @RateLimit({ limit: 120, windowSeconds: 60, bucket: 'storefront' })
  @ApiOperation({ summary: "What an instalment plan would cost — the engine's own schedule" })
  @ApiZodBody(planQuoteSchema)
  @ApiModel('PlanQuote', { array: true })
  planQuote(@Body() body: unknown) {
    return this.quotes.quote(body);
  }

  @Public()
  @Get('pickup-hubs')
  @ApiOperation({ summary: 'Collection points, for the pickup option at checkout' })
  @ApiModel('PickupHub', { array: true })
  pickupHubs(@Query() query: Record<string, string>) {
    return this.fulfilment.pickupHubs(query);
  }

  /**
   * What courier delivery costs and when it would arrive. Resolution is
   * city → region → national, and the national row is seeded, so a quote is
   * always answerable — checkout cannot price an order it has no rate for.
   */
  @Public()
  @Get('delivery-quote')
  @ApiOperation({ summary: 'Delivery fee and arrival window for a place' })
  @ApiModel('DeliveryQuote')
  deliveryQuote(@Query() query: Record<string, string>) {
    return this.fulfilment.deliveryQuote(query);
  }
}
