import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CollectionsService, PERMISSIONS } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf, numOrUndefined } from '../auth/current-actor';
import { assignCaseSchema, recordActionSchema, closeCaseSchema } from '@installment/core';
import { ApiZodBody } from '../common/api-zod';
import { ApiModel } from '../common/api-model';

@ApiTags('collections')
@ApiBearerAuth()
@Controller('admin/collections')
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get('cases')
  @ApiModel('CollectionsCase', { array: true })
  @RequirePermissions(PERMISSIONS.COLLECTIONS_ACT)
  @ApiOperation({ summary: 'List collections cases (open by default)' })
  list(@Query() query: Record<string, string>) {
    return this.collections.listCases({
      stage: query.stage,
      open: query.open === undefined ? undefined : query.open !== 'false',
      assigned_agent_id: query.assigned_agent_id,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get('cases/:id')
  @ApiModel('CollectionsCase')
  @RequirePermissions(PERMISSIONS.COLLECTIONS_ACT)
  @ApiOperation({ summary: 'Case detail with actions, plan, schedule and customer' })
  get(@Param('id') id: string) {
    return this.collections.getCase(id);
  }

  @Post('cases/:id/assign')
  @ApiModel('CollectionsCase')
  @ApiZodBody(assignCaseSchema)
  @RequirePermissions(PERMISSIONS.COLLECTIONS_ACT)
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign (or reassign) a case to an agent' })
  assign(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.collections.assignAgent(id, body, actorOf(user));
  }

  @Post('cases/:id/actions')
  @ApiModel('CollectionsAction', { created: true })
  @ApiZodBody(recordActionSchema)
  @RequirePermissions(PERMISSIONS.COLLECTIONS_ACT)
  @HttpCode(201)
  @ApiOperation({ summary: 'Record a manual agent action on a case' })
  recordAction(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.collections.recordAction(id, body, actorOf(user));
  }

  @Post('cases/:id/close')
  @ApiModel('CollectionsCase')
  @ApiZodBody(closeCaseSchema)
  @RequirePermissions(PERMISSIONS.COLLECTIONS_ACT)
  @HttpCode(200)
  @ApiOperation({ summary: 'Close a case with a manual resolution' })
  close(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.collections.closeCase(id, body, actorOf(user));
  }
}
