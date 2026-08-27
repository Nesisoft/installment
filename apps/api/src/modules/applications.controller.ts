import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApplicationsService, PERMISSIONS } from '@installment/core';
import { OrdersService } from '@installment/commerce';
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
  constructor(
    private readonly applications: ApplicationsService,
    private readonly orders: OrdersService,
  ) {}

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
  @ApiOperation({
    summary: 'Record a human-override decision on an application',
    description:
      'Order-aware, the same way activation is. A declined decision on an application that ' +
      'came from a commerce checkout also declines the ORDER and releases the stock it was ' +
      'holding — otherwise the order sits in `pending_approval` forever, keeping units out ' +
      'of sale and showing the customer "financing under review" for an answer already given.',
  })
  async decision(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const actor = actorOf(user);
    const application = await this.applications.recordDecision(id, body, actor);

    // Read the resulting status rather than the requested outcome: the state
    // machine decides, and only a real decline should close the order.
    // counter_offer and manual_review leave the application live, so their
    // orders must stay in pending_approval.
    if (application.status === 'declined') {
      const order = await this.orders.findByApplication(id);
      // Best effort: the decision is already committed and is the record that
      // matters. If this fails the order is left in pending_approval, where the
      // hourly sweep will catch it now that its application is terminal.
      if (order) await this.orders.declineFinancing(order.id, actor).catch(() => undefined);
    }
    return application;
  }
}
