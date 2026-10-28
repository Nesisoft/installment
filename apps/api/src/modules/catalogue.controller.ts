import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminCatalogService, CATALOG_PERMISSIONS } from '@installment/commerce';
import { RequirePermissions } from '../auth/decorators';

/**
 * The catalogue as staff moderate it: every seller's listings and shops, with
 * names and pictures. Reads only — taking a listing down is on
 * `/admin/products/:id/take-down`, and a shop's status on
 * `/admin/stores/:id/transition`, where the rules and the audit trail live.
 */
@ApiTags('catalogue')
@ApiBearerAuth()
@Controller('admin/catalogue')
export class CatalogueController {
  // By explicit token: the test build ignores `emitDecoratorMetadata`.
  constructor(@Inject(AdminCatalogService) private readonly catalog: AdminCatalogService) {}

  @Get('products')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  @ApiOperation({
    summary: 'Listings across every shop, most recently changed first',
    description:
      'Filter by `status`, `taken_down=true`, `store_id`, `category_id`, or `q` (part of the ' +
      'title). Each row names its shop, seller and category, and carries its first image.',
  })
  products(@Query() query: Record<string, string>) {
    return this.catalog.listProducts(query);
  }

  @Get('products/counts')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  @ApiOperation({ summary: 'How many listings are in each status, and how many are taken down' })
  productCounts() {
    return this.catalog.productCounts();
  }

  @Get('products/:id')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  @ApiOperation({ summary: 'One listing: variants, stock, images, plan offers, shop and seller' })
  product(@Param('id') id: string) {
    return this.catalog.productDetail(id);
  }

  @Get('stores')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  @ApiOperation({
    summary: 'Shops, those awaiting a decision first',
    description: 'Filter by `status` or `q` (part of the name). Each row names its seller.',
  })
  stores(@Query() query: Record<string, string>) {
    return this.catalog.listStores(query);
  }

  @Get('stores/counts')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  @ApiOperation({ summary: 'How many shops are in each status' })
  storeCounts() {
    return this.catalog.storeCounts();
  }
}
