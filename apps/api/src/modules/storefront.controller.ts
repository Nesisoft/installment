import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { CategoriesService, ProductsService, StoresService } from '@installment/commerce';
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
}
