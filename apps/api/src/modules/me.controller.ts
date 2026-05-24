import { Controller, Get, Param } from '@nestjs/common';
import {
  CustomerNotFoundError,
  CustomerPlanNotFoundError,
  CustomerPlansService,
  CustomersService,
  UsersService,
} from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators';

/**
 * Customer self-service. The JWT identifies a `users` row; the domain
 * `customers` record is resolved by the account's (canonicalised) phone.
 */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
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
    const customerId = await this.resolveCustomerId(user);
    const plan = await this.plans.get(id);
    // Don't leak the existence of other customers' plans.
    if (plan.customer_id !== customerId) throw new CustomerPlanNotFoundError(id);
    return this.plans.getSchedule(id);
  }

  private async resolveCustomerId(user: AuthenticatedUser): Promise<string> {
    const account = await this.users.getById(user.id);
    const customer = account.phone ? await this.customers.findByPhone(account.phone) : undefined;
    if (!customer) throw new CustomerNotFoundError(user.id);
    return customer.id;
  }
}
