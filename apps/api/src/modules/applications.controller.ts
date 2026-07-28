import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApplicationsService, PERMISSIONS } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';
import { submitApplicationSchema, recordDecisionSchema } from '@installment/core';
import { ApiZodBody } from '../common/api-zod';

@ApiTags('applications')
@ApiBearerAuth()
@Controller('admin/applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Post()
  @ApiZodBody(submitApplicationSchema)
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  @HttpCode(201)
  @ApiOperation({ summary: 'Submit a new financing application' })
  submit(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.applications.submit(body, actorOf(user));
  }

  @Get()
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  list(@Query() query: Record<string, string>) {
    return this.applications.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  get(@Param('id') id: string) {
    return this.applications.get(id);
  }

  @Post(':id/decision')
  @ApiZodBody(recordDecisionSchema)
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  @HttpCode(200)
  @ApiOperation({ summary: 'Record a human-override decision on an application' })
  decision(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.applications.recordDecision(id, body, actorOf(user));
  }
}
