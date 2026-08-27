import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { CategoriesService, ProductsService, StoresService } from '@installment/commerce';
import { PlanTemplatesService } from '@installment/core';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { ApiModel } from '../common/api-model';

const numOrUndefined = (v: unknown): number | undefined =>
  v === undefined || v === '' ? undefined : Number(v);

/**
 * Public (unauthenticated) storefront reads for the shopping apps. Only active
 * stores and active categories are exposed here; the admin controllers cover
 * management and draft/suspended visibility.
 */
@ApiTags('storefront')
@Controller('storefront')
export class StorefrontController {
  constructor(
    private readonly stores: StoresService,
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
    private readonly planTemplates: PlanTemplatesService,
  ) {}

  @Public()
  @Get('stores/:slug')
  @ApiModel('Store')
  store(@Param('slug') slug: string) {
    return this.stores.getActiveBySlug(slug);
  }

  @Public()
  @Get('search')
  @ApiModel('Product', { array: true })
  search(@Query() query: Record<string, string>) {
    return this.products.search({
      q: query.q,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  /**
   * Browse the catalogue. Search needs a term, so without this a shopper has no
   * way to see what a category contains — the app could only guess by searching
   * the category's name. Always forced to active products: `status` is not a
   * caller-supplied filter here, or the storefront would happily list drafts.
   */
  @Public()
  @Get('products')
  @ApiModel('Product', { array: true })
  productList(@Query() query: Record<string, string>) {
    return this.products.list({
      category_id: query.category_id,
      store_id: query.store_id,
      status: 'active',
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Public()
  @Get('products/:id')
  @ApiModel('ProductDetails')
  async product(@Param('id') id: string) {
    const product = await this.products.getWithDetails(id);
    if (product.status !== 'active') {
      throw new NotFoundException(`Product "${id}" not found`);
    }
    return product;
  }

  @Public()
  @Get('categories')
  @ApiModel('Category', { array: true })
  categoryList(@Query() query: Record<string, string>) {
    return this.categories.list({
      parent_id: query.parent_id,
      top_level: query.top_level === 'true' ? true : undefined,
      active_only: true,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  /**
   * The installment plans currently on offer. Public because a shopper must see
   * "from GHS X / week" (and the terms behind it) before signing in, and because
   * `POST /me/checkout` needs a `plan_template_id` the client can only obtain by
   * reading the offer catalogue. Active + currently-effective templates only —
   * a product declares which of these apply via `plan_template_ids`.
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
}
