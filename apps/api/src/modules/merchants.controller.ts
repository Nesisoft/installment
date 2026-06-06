import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  MerchantDashboardService,
  MerchantsService,
  PERMISSIONS,
  type AuditActorType,
  type MerchantActor,
} from '@installment/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';

function toActorType(userType: string): AuditActorType {
  switch (userType) {
    case 'merchant':
      return 'merchant';
    case 'customer':
      return 'customer';
    case 'system':
      return 'system';
    default:
      return 'admin'; // admin / agent staff
  }
}

const numOrUndefined = (v: unknown): number | undefined =>
  v === undefined || v === '' ? undefined : Number(v);

@ApiTags('merchants')
@ApiBearerAuth()
@Controller('admin/merchants')
export class MerchantsController {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly dashboard: MerchantDashboardService,
  ) {}

  private actor(user: AuthenticatedUser): MerchantActor {
    return { actorId: user.id, actorType: toActorType(user.userType) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.MERCHANTS_WRITE)
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.merchants.create(body, this.actor(user));
  }

  @Get()
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  list(@Query() query: Record<string, string>) {
    return this.merchants.list({
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  get(@Param('id') id: string) {
    return this.merchants.get(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.MERCHANTS_WRITE)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.merchants.update(id, body, this.actor(user));
  }

  @Post(':id/transition')
  @RequirePermissions(PERMISSIONS.MERCHANTS_WRITE)
  @HttpCode(200)
  transition(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.merchants.transition(id, body, this.actor(user));
  }

  @Post(':id/paystack-recipient')
  @RequirePermissions(PERMISSIONS.MERCHANTS_WRITE)
  @HttpCode(200)
  attachPaystackRecipient(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.merchants.attachPaystackRecipient(id, body, this.actor(user));
  }

  @Get(':id/balances')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  balances(@Param('id') id: string) {
    return this.dashboard.getBalances(id);
  }

  @Get(':id/payouts')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  payouts(@Param('id') id: string, @Query() query: Record<string, string>) {
    return this.dashboard.listPayouts(id, {
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get(':id/reserves')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  reserves(@Param('id') id: string, @Query() query: Record<string, string>) {
    const open = query.open === undefined ? true : query.open !== 'false';
    return this.dashboard.listHeldReserves(id, { open });
  }
}
