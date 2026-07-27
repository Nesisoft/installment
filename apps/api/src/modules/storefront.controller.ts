import { Controller, Get, Param, Query } from '@nestjs/common';
import { CategoriesService, StoresService } from '@installment/core';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';

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
  ) {}

  @Public()
  @Get('stores/:slug')
  store(@Param('slug') slug: string) {
    return this.stores.getActiveBySlug(slug);
  }

  @Public()
  @Get('categories')
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
