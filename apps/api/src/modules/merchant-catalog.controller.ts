import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  InventoryService,
  MediaService,
  ProductsService,
  StoresService,
  updateMyStoreSchema,
  addImageSchema,
  addVariantSchema,
  adjustStockSchema,
  createProductSchema,
  setPlanOffersSchema,
  setStockSchema,
  updateProductSchema,
} from '@installment/commerce';
import { CurrentMerchantId } from '../auth/decorators';
import { ApiModel } from '../common/api-model';
import { ApiZodBody } from '../common/api-zod';
import { MerchantScopeGuard } from '../auth/merchant-scope.guard';
import { numOrUndefined } from '../auth/current-actor';
import { keyBelongsTo } from '../media/upload-policy';

/**
 * A merchant's own catalogue.
 *
 * Until this, product writes lived only under `/admin/products` behind
 * `catalog:write` — so a seller could not add or edit their own stock at all,
 * and back-office staff had to do it for them against any store in the
 * marketplace. Everything here is the same service, narrowed to the caller.
 *
 * The narrowing is a WHERE clause, never a check after the read: the merchant
 * id comes from MerchantScopeGuard and is passed as a scope into the service,
 * so another merchant's product answers 404 rather than 403. A 403 would
 * confirm the product exists, which turns uuid enumeration into a catalogue
 * leak — and a competitor's unreleased stock is exactly what is worth leaking.
 *
 * Image bytes never pass through here. The phone or the browser asks
 * `/merchant/uploads` for a presigned PUT, uploads straight to the bucket, and
 * then posts the returned key to `POST products/:id/images`.
 */
@ApiTags('merchant-catalog')
@ApiBearerAuth()
@UseGuards(MerchantScopeGuard)
@Controller('merchant')
export class MerchantCatalogController {
  constructor(
    private readonly products: ProductsService,
    private readonly inventory: InventoryService,
    private readonly stores: StoresService,
    private readonly media: MediaService,
  ) {}

  private actor(merchantId: string) {
    return { actorId: merchantId, actorType: 'merchant' as const };
  }

  /**
   * The merchant's own store. One per merchant — the `stores_merchant_id_key`
   * unique constraint says so — which is why nothing below asks the caller
   * which store they mean.
   */
  @Get('store')
  @ApiOperation({ summary: 'My store' })
  @ApiModel('MerchantStore')
  async store(@CurrentMerchantId() merchantId: string) {
    return this.withArtwork(await this.myStore(merchantId));
  }

  /**
   * Edit my own shopfront: name, blurb, support contacts, logo and banner.
   *
   * Not the slug, and not the status. The slug is the storefront's public URL,
   * so renaming it silently breaks every link anyone has shared and every QR
   * code already printed on a flyer; going live is a transition with its own
   * route and audit trail. Both are platform decisions with an admin behind
   * them rather than settings fields — `updateMyStoreSchema` omits them, so a
   * body carrying either is refused rather than quietly ignored.
   *
   * Artwork keys come back from the client, so each is checked against the
   * prefix this merchant's uploads are issued under — the same guard the
   * product images use, for the same reason: a key is derived server-side and
   * this is the door that takes one back.
   */
  @Patch('store')
  @ApiOperation({ summary: 'Edit my store' })
  @ApiZodBody(updateMyStoreSchema)
  @ApiModel('MerchantStore')
  async updateStore(@Body() body: unknown, @CurrentMerchantId() merchantId: string) {
    const store = await this.myStore(merchantId);
    const patch = (body ?? {}) as Record<string, unknown>;
    for (const [field, purpose] of [
      ['logo_key', 'store_logo'],
      ['banner_key', 'store_banner'],
    ] as const) {
      const key = patch[field];
      if (typeof key === 'string' && !keyBelongsTo(purpose, key, merchantId)) {
        throw new BadRequestException(`${field} was not issued to this merchant`);
      }
    }
    return this.withArtwork(
      await this.stores.update(store.id, body, this.actor(merchantId), { merchantId }),
    );
  }

  /** The caller's own store, or a 404 explaining that they have none yet. */
  private async myStore(merchantId: string) {
    const store = await this.stores.getByMerchant(merchantId);
    if (!store) throw new NotFoundException('No store has been created for this merchant yet');
    return store;
  }

  /** Keys resolved to URLs, so the portal never rebuilds a bucket path. */
  private withArtwork<T extends { logo_key: string | null; banner_key: string | null }>(store: T) {
    return {
      ...store,
      logo_url: this.media.url(store.logo_key),
      banner_url: this.media.url(store.banner_key),
    };
  }

  /**
   * The catalogue in five numbers, for the home screen and the catalogue tab's
   * filter chips.
   *
   * Separate from `GET products` because both callers want the counts across
   * the WHOLE catalogue while showing one page of it — deriving them from the
   * page would under-report the moment a merchant lists more than a page of
   * stock, and "0 variants out of stock" is a worse lie than no number.
   */
  @Get('catalog/summary')
  @ApiOperation({ summary: 'My catalogue at a glance' })
  @ApiModel('MerchantCatalogSummary')
  catalogSummary(@CurrentMerchantId() merchantId: string) {
    return this.products.summaryForMerchant(merchantId);
  }

  @Get('products')
  @ApiOperation({ summary: 'My products' })
  @ApiModel('MerchantProductRow', { array: true })
  async listProducts(
    @Query() query: Record<string, string>,
    @CurrentMerchantId() merchantId: string,
  ) {
    // merchant_id is set from the guard, not read from the query — a
    // `?merchant_id=` in the URL is ignored rather than honoured.
    const rows = await this.products.list({
      merchant_id: merchantId,
      category_id: query.category_id,
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
    // Resolved here rather than in the browser: `storage_key` is a bucket path,
    // and every client that rebuilt the URL itself would have to be changed the
    // day this moves behind a CDN or starts signing.
    const keys = await this.products.primaryImageKeys(rows.map((r) => r.id));
    return rows.map((row) => ({
      ...row,
      primary_image_url: this.media.url(keys.get(row.id)),
    }));
  }

  /**
   * Lists a product into the caller's own store.
   *
   * `store_id` is filled from the merchant's store rather than taken from the
   * body, and the service is scoped as well: two independent reasons a product
   * cannot land in somebody else's shop.
   */
  @Post('products')
  @ApiOperation({ summary: 'List a new product in my store' })
  @ApiZodBody(createProductSchema)
  @ApiModel('ProductDetails', { created: true })
  @HttpCode(201)
  async createProduct(@Body() body: unknown, @CurrentMerchantId() merchantId: string) {
    const store = await this.myStore(merchantId);
    const input = { ...(body as Record<string, unknown>), store_id: store.id };
    return this.products.create(input, this.actor(merchantId), { merchantId });
  }

  @Get('products/:id')
  @ApiOperation({ summary: 'One of my products' })
  @ApiModel('MerchantProductDetails')
  async getProduct(@Param('id') id: string, @CurrentMerchantId() merchantId: string) {
    const product = await this.products.getWithDetails(id, { merchantId });
    return {
      ...product,
      images: product.images.map((image) => ({ ...image, url: this.media.url(image.storage_key) })),
    };
  }

  @Patch('products/:id')
  @ApiOperation({ summary: 'Edit one of my products' })
  @ApiZodBody(updateProductSchema)
  @ApiModel('Product')
  updateProduct(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentMerchantId() merchantId: string,
  ) {
    return this.products.update(id, body, this.actor(merchantId), { merchantId });
  }

  @Post('products/:id/variants')
  @ApiOperation({ summary: 'Add a variant to one of my products' })
  @ApiZodBody(addVariantSchema)
  @ApiModel('ProductVariant', { created: true })
  @HttpCode(201)
  addVariant(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentMerchantId() merchantId: string,
  ) {
    return this.products.addVariant(id, body, this.actor(merchantId), { merchantId });
  }

  /**
   * Records a photo already uploaded through `/merchant/uploads`, by its key.
   *
   * The key comes back from the client, which reopens from the other side the
   * door `upload-policy` closes by deriving keys server-side — so it is checked
   * against the prefix this merchant's uploads are issued under. Without that a
   * seller could point their own listing at a competitor's photograph: product
   * images are public, so it would render perfectly.
   */
  @Post('products/:id/images')
  @ApiOperation({ summary: 'Attach an uploaded photo to one of my products' })
  @ApiZodBody(addImageSchema)
  @ApiModel('MerchantProductImage', { created: true })
  @HttpCode(201)
  async addImage(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentMerchantId() merchantId: string,
  ) {
    const key = (body as { storage_key?: unknown } | null)?.storage_key;
    if (typeof key === 'string' && !keyBelongsTo('product_image', key, merchantId)) {
      throw new BadRequestException('storage_key was not issued to this merchant');
    }
    const image = await this.products.addImage(id, body, this.actor(merchantId), { merchantId });
    return { ...image, url: this.media.url(image.storage_key) };
  }

  @Put('products/:id/plan-offers')
  @ApiOperation({ summary: 'Choose which instalment plans one of my products offers' })
  @ApiZodBody(setPlanOffersSchema)
  @HttpCode(200)
  setPlanOffers(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentMerchantId() merchantId: string,
  ) {
    return this.products.setPlanOffers(id, body, this.actor(merchantId), { merchantId });
  }

  // --- Stock ----------------------------------------------------------------

  @Get('variants/:variantId/inventory')
  @ApiOperation({ summary: 'Stock on one of my variants' })
  @ApiModel('Inventory')
  getInventory(@Param('variantId') variantId: string, @CurrentMerchantId() merchantId: string) {
    return this.inventory.getByVariant(variantId, { merchantId });
  }

  @Put('variants/:variantId/inventory')
  @ApiOperation({ summary: 'Set stock on one of my variants' })
  @ApiZodBody(setStockSchema)
  @ApiModel('Inventory')
  @HttpCode(200)
  setStock(
    @Param('variantId') variantId: string,
    @Body() body: unknown,
    @CurrentMerchantId() merchantId: string,
  ) {
    return this.inventory.setStock(variantId, body, { merchantId });
  }

  @Post('variants/:variantId/inventory/adjust')
  @ApiOperation({ summary: 'Adjust stock on one of my variants' })
  @ApiZodBody(adjustStockSchema)
  @ApiModel('Inventory')
  @HttpCode(200)
  adjustStock(
    @Param('variantId') variantId: string,
    @Body() body: unknown,
    @CurrentMerchantId() merchantId: string,
  ) {
    return this.inventory.adjust(variantId, body, { merchantId });
  }
}
