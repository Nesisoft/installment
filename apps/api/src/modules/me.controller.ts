import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  CustomerNotFoundError,
  CustomerPlanNotFoundError,
  CustomerPlansService,
  CustomersService,
  PaymentService,
  renderReceiptHtml,
  renderStatementCsv,
  type Customer,
} from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';
import { Idempotent } from '../common/idempotent.decorator';

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
    private readonly payments: PaymentService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: "The authenticated customer's installment plans" })
  async listPlans(@CurrentUser() user: AuthenticatedUser) {
    const customer = await this.resolveCustomer(user);
    return this.plans.listForCustomer(customer.id);
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

  @Get('installments/:scheduleId/receipt')
  @ApiOperation({ summary: 'Receipt for a paid installment on one of my plans' })
  async receipt(@Param('scheduleId') scheduleId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.assertOwnedInstallment(scheduleId, user);
    return this.plans.getReceipt(scheduleId);
  }

  @Get('installments/:scheduleId/receipt.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Printable HTML receipt for a paid installment on one of my plans' })
  async receiptHtml(
    @Param('scheduleId') scheduleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<string> {
    await this.assertOwnedInstallment(scheduleId, user);
    return renderReceiptHtml(await this.plans.getReceipt(scheduleId));
  }

  @Post('installments/:scheduleId/pay')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({ summary: 'Pay one of my installments now with a tokenised card' })
  async pay(
    @Param('scheduleId') scheduleId: string,
    @Body() body: { authorizationCode?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const customer = await this.resolveCustomer(user);
    const installment = await this.plans.getInstallment(scheduleId);
    const plan = await this.plans.get(installment.customer_plan_id);
    if (plan.customer_id !== customer.id) throw new CustomerPlanNotFoundError(scheduleId);

    const authorizationCode = body?.authorizationCode;
    if (typeof authorizationCode !== 'string' || authorizationCode.trim() === '') {
      throw new BadRequestException('authorizationCode is required');
    }
    return this.payments.chargeCard(
      { scheduleId, authorizationCode, email: customer.email },
      actorOf(user),
    );
  }

  @Post('installments/:scheduleId/pay-momo')
  @Idempotent()
  @HttpCode(200)
  @ApiOperation({ summary: 'Pay one of my installments now via Mobile Money' })
  async payMomo(
    @Param('scheduleId') scheduleId: string,
    @Body() body: { phone?: string; provider?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const customer = await this.resolveCustomer(user);
    const installment = await this.plans.getInstallment(scheduleId);
    const plan = await this.plans.get(installment.customer_plan_id);
    if (plan.customer_id !== customer.id) throw new CustomerPlanNotFoundError(scheduleId);

    // Charge against the request body's MoMo details if given; otherwise the saved ones.
    const phone = body?.phone?.trim() || customer.momo_phone || '';
    const provider = body?.provider?.trim() || customer.momo_provider || '';
    if (!phone) {
      throw new BadRequestException('Mobile Money phone is required (none on file)');
    }
    if (provider !== 'mtn' && provider !== 'tgo' && provider !== 'vod') {
      throw new BadRequestException('Mobile Money provider must be one of mtn, tgo, vod');
    }
    return this.payments.chargeMobileMoney(
      { scheduleId, email: customer.email, phone, provider },
      actorOf(user),
    );
  }

  /** Resolves the caller and verifies the plan is theirs (404 otherwise — no leak). */
  private async assertOwnedPlan(planId: string, user: AuthenticatedUser): Promise<void> {
    const customer = await this.resolveCustomer(user);
    const plan = await this.plans.get(planId);
    if (plan.customer_id !== customer.id) throw new CustomerPlanNotFoundError(planId);
  }

  /** Verifies the installment belongs to a plan the caller owns (404 otherwise). */
  private async assertOwnedInstallment(scheduleId: string, user: AuthenticatedUser): Promise<void> {
    const customer = await this.resolveCustomer(user);
    const installment = await this.plans.getInstallment(scheduleId);
    const plan = await this.plans.get(installment.customer_plan_id);
    if (plan.customer_id !== customer.id) throw new CustomerPlanNotFoundError(scheduleId);
  }

  private async resolveCustomer(user: AuthenticatedUser): Promise<Customer> {
    const customer = await this.customers.findByUserId(user.id);
    if (!customer) throw new CustomerNotFoundError(user.id);
    return customer;
  }
}
