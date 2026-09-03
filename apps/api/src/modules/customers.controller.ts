import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CustomersService, PERMISSIONS } from '@installment/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf, numOrUndefined } from '../auth/current-actor';
import {
  registerCustomerSchema,
  updateCustomerSchema,
  attachGhanaCardSchema,
  rejectGhanaCardSchema,
  setMomoSchema,
  recordConsentSchema,
  setBlocklistSchema,
} from '@installment/core';
import { ApiZodBody } from '../common/api-zod';
import { ApiModel } from '../common/api-model';

@ApiTags('customers')
@ApiBearerAuth()
@Controller('admin/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @ApiModel('Customer', { created: true })
  @ApiZodBody(registerCustomerSchema)
  @RequirePermissions(PERMISSIONS.CUSTOMERS_WRITE)
  @HttpCode(201)
  register(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.register(body, actorOf(user));
  }

  @Get()
  @ApiModel('Customer', { array: true })
  @RequirePermissions(PERMISSIONS.CUSTOMERS_READ)
  list(@Query() query: Record<string, string>) {
    return this.customers.list({
      kyc_tier: query.kyc_tier === undefined ? undefined : numOrUndefined(query.kyc_tier),
      is_on_blocklist:
        query.is_on_blocklist === undefined ? undefined : query.is_on_blocklist === 'true',
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get(':id')
  @ApiModel('Customer')
  @RequirePermissions(PERMISSIONS.CUSTOMERS_READ)
  get(@Param('id') id: string) {
    return this.customers.get(id);
  }

  @Patch(':id')
  @ApiModel('Customer')
  @ApiZodBody(updateCustomerSchema)
  @RequirePermissions(PERMISSIONS.CUSTOMERS_WRITE)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.update(id, body, actorOf(user));
  }

  @Post(':id/ghana-card')
  @ApiModel('Customer')
  @ApiZodBody(attachGhanaCardSchema)
  @RequirePermissions(PERMISSIONS.CUSTOMERS_WRITE)
  @HttpCode(200)
  attachGhanaCard(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.attachGhanaCard(id, body, actorOf(user));
  }

  @Post(':id/ghana-card/verify')
  @ApiModel('Customer')
  @RequirePermissions(PERMISSIONS.CUSTOMERS_WRITE)
  @HttpCode(200)
  verifyGhanaCard(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.verifyGhanaCard(id, actorOf(user));
  }

  @Post(':id/ghana-card/reject')
  @ApiModel('Customer')
  @ApiZodBody(rejectGhanaCardSchema)
  @RequirePermissions(PERMISSIONS.CUSTOMERS_WRITE)
  @HttpCode(200)
  rejectGhanaCard(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.rejectGhanaCard(id, body, actorOf(user));
  }

  @Post(':id/momo')
  @ApiModel('Customer')
  @ApiZodBody(setMomoSchema)
  @RequirePermissions(PERMISSIONS.CUSTOMERS_WRITE)
  @HttpCode(200)
  setMomo(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.setMomo(id, body, actorOf(user));
  }

  @Post(':id/consent')
  @ApiModel('Customer')
  @ApiZodBody(recordConsentSchema)
  @RequirePermissions(PERMISSIONS.CUSTOMERS_WRITE)
  @HttpCode(200)
  recordConsent(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.recordConsent(id, body, actorOf(user));
  }

  @Post(':id/blocklist')
  @ApiModel('Customer')
  @ApiZodBody(setBlocklistSchema)
  @RequirePermissions(PERMISSIONS.CUSTOMERS_WRITE)
  @HttpCode(200)
  blocklist(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customers.setBlocklist(id, body, actorOf(user));
  }

  @Delete(':id/blocklist')
  @ApiModel('Customer')
  @RequirePermissions(PERMISSIONS.CUSTOMERS_WRITE)
  @HttpCode(200)
  unblock(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.customers.removeBlocklist(id, actorOf(user));
  }
}
