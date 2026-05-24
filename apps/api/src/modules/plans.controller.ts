import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CustomerPlansService, PERMISSIONS } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';

@ApiTags('plans')
@ApiBearerAuth()
@Controller('admin/plans')
export class PlansController {
  constructor(private readonly plans: CustomerPlansService) {}

  @Post('from-application/:applicationId')
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  @HttpCode(201)
  @ApiOperation({ summary: 'Activate an approved application into a plan + installment schedule' })
  activate(@Param('applicationId') applicationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.activateFromApplication(applicationId, actorOf(user));
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  get(@Param('id') id: string) {
    return this.plans.get(id);
  }

  @Get(':id/schedule')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({ summary: 'The installment schedule for a plan, ordered by sequence' })
  schedule(@Param('id') id: string) {
    return this.plans.getSchedule(id);
  }
}
