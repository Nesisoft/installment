import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  CATALOG_PERMISSIONS,
  InventoryService,
  ProductsService,
  addImageSchema,
  addVariantSchema,
  adjustStockSchema,
  createProductSchema,
  setPlanOffersSchema,
  setStockSchema,
  updateProductSchema,
  type ProductActor,
} from '@installment/commerce';
import { type AuditActorType } from '@installment/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { ApiZodBody } from '../common/api-zod';

function toActorType(userType: string): AuditActorType {
  switch (userType) {
    case 'merchant':
      return 'merchant';
    case 'customer':
      return 'customer';
    case 'system':
      return 'system';
    default:
      return 'admin';
  }
}

const numOrUndefined = (v: unknown): number | undefined =>
  v === undefined || v === '' ? undefined : Number(v);

@ApiTags('products')
@ApiBearerAuth()
@Controller('admin/products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly inventory: InventoryService,
  ) {}

  private actor(user: AuthenticatedUser): ProductActor {
    return { actorId: user.id, actorType: toActorType(user.userType) };
  }

  @Post()
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(createProductSchema)
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.products.create(body, this.actor(user));
  }

  @Get()
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  list(@Query() query: Record<string, string>) {
    return this.products.list({
      store_id: query.store_id,
      merchant_id: query.merchant_id,
      category_id: query.category_id,
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get('variants/:variantId/inventory')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  getInventory(@Param('variantId') variantId: string) {
    return this.inventory.getByVariant(variantId);
  }

  @Put('variants/:variantId/inventory')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(setStockSchema)
  @HttpCode(200)
  setStock(@Param('variantId') variantId: string, @Body() body: unknown) {
    return this.inventory.setStock(variantId, body);
  }

  @Post('variants/:variantId/inventory/adjust')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(adjustStockSchema)
  @HttpCode(200)
  adjustStock(@Param('variantId') variantId: string, @Body() body: unknown) {
    return this.inventory.adjust(variantId, body);
  }

  @Get(':id')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  get(@Param('id') id: string) {
    return this.products.getWithDetails(id);
  }

  @Patch(':id')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(updateProductSchema)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.products.update(id, body, this.actor(user));
  }

  @Post(':id/variants')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(addVariantSchema)
  @HttpCode(201)
  addVariant(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.products.addVariant(id, body, this.actor(user));
  }

  @Post(':id/images')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(addImageSchema)
  @HttpCode(201)
  addImage(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.products.addImage(id, body, this.actor(user));
  }

  @Put(':id/plan-offers')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(setPlanOffersSchema)
  @HttpCode(200)
  setPlanOffers(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.products.setPlanOffers(id, body, this.actor(user));
  }
}
