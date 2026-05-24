import { Controller, Get, Header, Param } from '@nestjs/common';
import {
  CustomerNotFoundError,
  CustomerPlanNotFoundError,
  CustomerPlansService,
  CustomersService,
  renderStatementCsv,
} from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators';

/**
 * Customer self-service. The JWT identifies a `users` row; the domain
 * `customers` record is resolved by the explicit customers.user_id link.
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly customers: CustomersService,
    private readonly plans: CustomerPlansService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: "The authenticated customer's installment plans" })
  async listPlans(@CurrentUser() user: AuthenticatedUser) {
    const customerId = await this.resolveCustomerId(user);
    return this.plans.listForCustomer(customerId);
  }

  @Get('plans/:id/schedule')
  @ApiOperation({ summary: 'The installment schedule for one of the customer’s own plans' })
  async planSchedule(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.assertOwnedPlan(id, user);
    return this.plans.getSchedule(id);
  }

  @Get('plans/:id/statement')
  @ApiOperation({ summary: 'Statement (structured JSON) for one of the customer’s own plans' })
  async statement(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.assertOwnedPlan(id, user);
    return this.plans.getStatement(id);
  }

  @Get('plans/:id/statement.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="statement.csv"')
  @ApiOperation({ summary: 'Statement as a CSV download for one of the customer’s own plans' })
  async statementCsv(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<string> {
    await this.assertOwnedPlan(id, user);
    return renderStatementCsv(await this.plans.getStatement(id));
  }

  /** Resolves the caller and verifies the plan is theirs (404 otherwise — no leak). */
  private async assertOwnedPlan(planId: string, user: AuthenticatedUser): Promise<void> {
    const customerId = await this.resolveCustomerId(user);
    const plan = await this.plans.get(planId);
    if (plan.customer_id !== customerId) throw new CustomerPlanNotFoundError(planId);
  }

  private async resolveCustomerId(user: AuthenticatedUser): Promise<string> {
    const customer = await this.customers.findByUserId(user.id);
    if (!customer) throw new CustomerNotFoundError(user.id);
    return customer.id;
  }
}
