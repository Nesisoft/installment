import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { PERMISSIONS, PlanTemplatesService } from '@installment/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf, numOrUndefined } from '../auth/current-actor';
import { createPlanTemplateSchema, updatePlanTemplateSchema } from '@installment/core';
import { ApiZodBody } from '../common/api-zod';

@ApiTags('plan-templates')
@ApiBearerAuth()
@Controller('admin/plan-templates')
export class PlanTemplatesController {
  constructor(private readonly plans: PlanTemplatesService) {}

  @Post()
  @ApiZodBody(createPlanTemplateSchema)
  @RequirePermissions(PERMISSIONS.PLANS_WRITE)
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.create(body, actorOf(user));
  }

  @Get()
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  list(@Query() query: Record<string, string>) {
    return this.plans.list({
      business_model: query.business_model,
      is_active: query.is_active === undefined ? undefined : query.is_active === 'true',
      effective_at: query.effective_at,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  get(@Param('id') id: string) {
    return this.plans.get(id);
  }

  @Patch(':id')
  @ApiZodBody(updatePlanTemplateSchema)
  @RequirePermissions(PERMISSIONS.PLANS_WRITE)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.update(id, body, actorOf(user));
  }

  @Post(':id/activate')
  @RequirePermissions(PERMISSIONS.PLANS_WRITE)
  @HttpCode(200)
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.activate(id, actorOf(user));
  }

  @Post(':id/deactivate')
  @RequirePermissions(PERMISSIONS.PLANS_WRITE)
  @HttpCode(200)
  deactivate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.deactivate(id, actorOf(user));
  }
}
