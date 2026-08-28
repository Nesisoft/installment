import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CATALOG_PERMISSIONS } from '@installment/commerce';
import { CustomerNotFoundError, CustomersService, PERMISSIONS } from '@installment/core';
import {
  CurrentMerchantId,
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/decorators';
import { MerchantScopeGuard } from '../auth/merchant-scope.guard';
import { ApiZodBody } from '../common/api-zod';
import { UploadsService } from './uploads.service';
import { UploadNotAllowedError, requestUploadSchema, type UploadPurpose } from './upload-policy';

/**
 * Three surfaces, three allowlists.
 *
 * Splitting by caller rather than exposing one `/uploads` with a role check
 * keeps the guard and the permitted purposes in the same place: a merchant
 * token reaching a route that only ever mints category keys is refused by the
 * router, not by a branch someone has to remember to write.
 */

const MERCHANT_PURPOSES: UploadPurpose[] = ['product_image', 'store_logo', 'store_banner'];
const ADMIN_PURPOSES: UploadPurpose[] = ['category_image'];
const CUSTOMER_PURPOSES: UploadPurpose[] = ['kyc_document'];

@ApiTags('uploads')
@ApiBearerAuth()
@UseGuards(MerchantScopeGuard)
@Controller('merchant/uploads')
export class MerchantUploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Get()
  @ApiOperation({ summary: 'What this merchant may upload, and how large' })
  limits() {
    return this.uploads.limits(MERCHANT_PURPOSES);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Mint a one-shot upload URL for a product photo or store artwork',
    description:
      'The returned key is derived server-side and scoped to the calling merchant. PUT the file ' +
      'to `url` with exactly the returned headers, then send `key` to the endpoint that stores it ' +
      '(e.g. POST /admin/products/:id/images).',
  })
  @ApiZodBody(requestUploadSchema)
  request(@Body() body: unknown, @CurrentMerchantId() merchantId?: string) {
    return this.uploads.request(body, merchantId, MERCHANT_PURPOSES);
  }
}

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('admin/uploads')
export class AdminUploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly customers: CustomersService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Mint an upload URL for catalogue artwork' })
  @RequirePermissions(CATALOG_PERMISSIONS.CATEGORIES_WRITE)
  @ApiZodBody(requestUploadSchema)
  request(@Body() body: unknown) {
    return this.uploads.request(body, undefined, ADMIN_PURPOSES);
  }

  /**
   * The read side of a private upload, and the reason the private prefix is not
   * write-only: a compliance officer verifying a Ghana Card has to see it.
   *
   * Deliberately not a redirect — the signed URL is returned as data so the act
   * of viewing personal data is a request the console makes on purpose, and the
   * URL does not leak into a `Referer` the way a redirect chain would.
   */
  @Get('customers/:id/ghana-card')
  @ApiOperation({ summary: 'A short-lived link to a customer’s Ghana Card scan' })
  @RequirePermissions(PERMISSIONS.CUSTOMERS_READ)
  async ghanaCard(@Param('id') id: string) {
    const customer = await this.customers.get(id);
    if (!customer.ghana_card_image_key) {
      throw new NotFoundException('No Ghana Card has been attached to this customer');
    }
    return this.uploads.readPrivate(customer.ghana_card_image_key);
  }
}

@ApiTags('uploads')
@ApiBearerAuth()
@Controller('me/uploads')
export class ShopperUploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly customers: CustomersService,
  ) {}

  /**
   * A customer uploading their own KYC document.
   *
   * The key is namespaced by the *customer* id resolved from the token — not
   * the user id, and never a body field — so the folder matches the one the
   * back office reads from, and the route cannot be pointed at anyone else's
   * even by a caller who controls the whole request.
   */
  @Get()
  @ApiOperation({ summary: 'What a customer may upload, and how large' })
  limits() {
    return this.uploads.limits(CUSTOMER_PURPOSES);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Mint an upload URL for the caller’s own KYC document' })
  @ApiZodBody(requestUploadSchema)
  async request(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    if (user.userType !== 'customer') {
      throw new UploadNotAllowedError('Only a customer can upload their own KYC document');
    }
    const customer = await this.customers.findByUserId(user.id);
    if (!customer) throw new CustomerNotFoundError(user.id);
    return this.uploads.request(body, customer.id, CUSTOMER_PURPOSES);
  }
}
