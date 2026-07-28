import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  CATALOG_PERMISSIONS,
  StoresService,
  createStoreSchema,
  transitionStoreSchema,
  updateStoreSchema,
  type StoreActor,
} from '@installment/commerce';
import { type AuditActorType } from '@installment/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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

@ApiTags('stores')
@ApiBearerAuth()
@Controller('admin/stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  private actor(user: AuthenticatedUser): StoreActor {
    return { actorId: user.id, actorType: toActorType(user.userType) };
  }

  @Post()
  @ApiModel('Store', { created: true })
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(createStoreSchema)
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.stores.create(body, this.actor(user));
  }

  @Get()
  @ApiModel('Store', { array: true })
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  list(@Query() query: Record<string, string>) {
    return this.stores.list({
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get(':id')
  @ApiModel('Store')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_READ)
  get(@Param('id') id: string) {
    return this.stores.get(id);
  }

  @Patch(':id')
  @ApiModel('Store')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(updateStoreSchema)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.stores.update(id, body, this.actor(user));
  }

  @Post(':id/transition')
  @ApiModel('Store')
  @RequirePermissions(CATALOG_PERMISSIONS.CATALOG_WRITE)
  @ApiZodBody(transitionStoreSchema)
  @HttpCode(200)
  transition(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.stores.transition(id, body, this.actor(user));
  }
}
