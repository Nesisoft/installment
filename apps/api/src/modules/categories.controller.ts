import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  CategoriesService,
  PERMISSIONS,
  type AuditActorType,
  type CategoryActor,
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
      return 'admin';
  }
}

const numOrUndefined = (v: unknown): number | undefined =>
  v === undefined || v === '' ? undefined : Number(v);

@ApiTags('categories')
@ApiBearerAuth()
@Controller('admin/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  private actor(user: AuthenticatedUser): CategoryActor {
    return { actorId: user.id, actorType: toActorType(user.userType) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CATEGORIES_WRITE)
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.categories.create(body, this.actor(user));
  }

  @Get()
  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  list(@Query() query: Record<string, string>) {
    return this.categories.list({
      parent_id: query.parent_id,
      top_level: query.top_level === 'true' ? true : undefined,
      active_only: query.active_only === 'true' ? true : undefined,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  get(@Param('id') id: string) {
    return this.categories.get(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CATEGORIES_WRITE)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.categories.update(id, body, this.actor(user));
  }
}
