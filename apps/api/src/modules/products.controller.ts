import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
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
  takeDownProductSchema,
  updateProductSchema,
  type ProductActor,
} from '@installment/commerce';
import { type AuditActorType } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { ApiZodBody } from '../common/api-zod';
import { ApiModel } from '../common/api-model';

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
  // By explicit token: the test build ignores `emitDecoratorMetadata`.
  constructor(
    @Inject(ProductsService) private readonly products: ProductsService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
  ) {}

  private actor(user: AuthenticatedUser): ProductActor {
    return { actorId: user.id, actorType: toActorType(user.userType) };
  }

  @Post()
  @ApiModel('ProductDetails', { created: true })
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(createProductSchema)
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.products.create(body, this.actor(user));
  }

  @Get()
  @ApiModel('Product', { array: true })
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
  @ApiModel('Inventory')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  getInventory(@Param('variantId') variantId: string) {
    return this.inventory.getByVariant(variantId);
  }

  @Put('variants/:variantId/inventory')
  @ApiModel('Inventory')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(setStockSchema)
  @HttpCode(200)
  setStock(@Param('variantId') variantId: string, @Body() body: unknown) {
    return this.inventory.setStock(variantId, body);
  }

  @Post('variants/:variantId/inventory/adjust')
  @ApiModel('Inventory')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(adjustStockSchema)
  @HttpCode(200)
  adjustStock(@Param('variantId') variantId: string, @Body() body: unknown) {
    return this.inventory.adjust(variantId, body);
  }

  @Get(':id')
  @ApiModel('ProductDetails')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  get(@Param('id') id: string) {
    return this.products.getWithDetails(id);
  }

  @Patch(':id')
  @ApiModel('Product')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(updateProductSchema)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.products.update(id, body, this.actor(user));
  }

  @Post(':id/take-down')
  @ApiModel('Product')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(takeDownProductSchema)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Take a listing off sale, with a reason the seller sees',
    description:
      'Archives the product and holds it there: the seller may still edit the listing, but no ' +
      'one can publish it until the takedown is lifted. 409 if it is already taken down.',
  })
  takeDown(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.products.takeDown(id, body, this.actor(user));
  }

  @Post(':id/lift-takedown')
  @ApiModel('Product')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Lift a takedown, returning the listing to the status it was taken down from',
  })
  liftTakedown(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.products.liftTakedown(id, this.actor(user));
  }

  @Post(':id/variants')
  @ApiModel('ProductVariant', { created: true })
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
  @ApiModel('ProductImage', { created: true })
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
