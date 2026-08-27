import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApplicationsService, PERMISSIONS } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf, numOrUndefined } from '../auth/current-actor';
import { submitApplicationSchema, recordDecisionSchema } from '@installment/core';
import { ApiZodBody } from '../common/api-zod';
import { ApiModel } from '../common/api-model';

@ApiTags('applications')
@ApiBearerAuth()
@Controller('admin/applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Post()
  @ApiModel('Application', { created: true })
  @ApiZodBody(submitApplicationSchema)
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  @HttpCode(201)
  @ApiOperation({ summary: 'Submit a new financing application' })
  submit(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.applications.submit(body, actorOf(user));
  }

  @Get()
  @ApiModel('Application', { array: true })
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  list(@Query() query: Record<string, string>) {
    // Query params arrive as strings; the service's schema wants numbers.
    return this.applications.list({
      customer_id: query.customer_id,
      merchant_id: query.merchant_id,
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get(':id')
  @ApiModel('Application')
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  get(@Param('id') id: string) {
    return this.applications.get(id);
  }

  @Post(':id/decision')
  @ApiModel('Application')
  @ApiZodBody(recordDecisionSchema)
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  @HttpCode(200)
  @ApiOperation({ summary: 'Record a human-override decision on an application' })
  decision(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.applications.recordDecision(id, body, actorOf(user));
  }
}
