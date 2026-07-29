import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CustomerPlansService,
  MerchantDashboardService,
  MerchantsService,
  PlanTemplatesService,
  renderMerchantStatementCsv,
  renderMerchantStatementHtml,
  renderStatementCsv,
  renderStatementHtml,
  type CustomerPlan,
} from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentMerchantId } from '../auth/decorators';
import { MerchantScopeGuard } from '../auth/merchant-scope.guard';
import { numOrUndefined } from '../auth/current-actor';

function parsePeriod(q: Record<string, string>): { year: number; month: number } {
  const now = new Date();
  const year = q.year ? Number(q.year) : now.getUTCFullYear();
  const month = q.month ? Number(q.month) : now.getUTCMonth() + 1;
  if (
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2100 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    throw new BadRequestException('Invalid year/month');
  }
  return { year, month };
}

/**
 * Merchant self-service portal. Every route is scoped to the caller's own
 * merchant (resolved by MerchantScopeGuard); plan sub-resources are
 * ownership-checked so a merchant can never read another merchant's data.
 */
@ApiTags('merchant-portal')
@ApiBearerAuth()
@UseGuards(MerchantScopeGuard)
@Controller('merchant')
export class MerchantPortalController {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly dashboard: MerchantDashboardService,
    private readonly merchants: MerchantsService,
    private readonly planTemplates: PlanTemplatesService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'The authenticated merchant profile' })
  me(@CurrentMerchantId() merchantId: string) {
    return this.merchants.get(merchantId);
  }

  @Get('balances')
  balances(@CurrentMerchantId() merchantId: string) {
    return this.dashboard.getBalances(merchantId);
  }

  @Get('payouts')
  payouts(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    return this.dashboard.listPayouts(merchantId, {
      status: q.status,
      limit: numOrUndefined(q.limit),
      offset: numOrUndefined(q.offset),
    });
  }

  @Get('reserves')
  reserves(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    return this.dashboard.listHeldReserves(merchantId, {
      open: q.open === undefined ? undefined : q.open !== 'false',
    });
  }

  @Get('statement')
  @ApiOperation({ summary: 'Monthly account statement (JSON)' })
  statement(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    const { year, month } = parsePeriod(q);
    return this.dashboard.getMonthlyStatement(merchantId, year, month);
  }

  @Get('statement.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="merchant-statement.csv"')
  async statementCsv(
    @CurrentMerchantId() merchantId: string,
    @Query() q: Record<string, string>,
  ): Promise<string> {
    const { year, month } = parsePeriod(q);
    return renderMerchantStatementCsv(
      await this.dashboard.getMonthlyStatement(merchantId, year, month),
    );
  }

  @Get('statement.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async statementHtml(
    @CurrentMerchantId() merchantId: string,
    @Query() q: Record<string, string>,
  ): Promise<string> {
    const { year, month } = parsePeriod(q);
    return renderMerchantStatementHtml(
      await this.dashboard.getMonthlyStatement(merchantId, year, month),
    );
  }

  @Get('plans')
  @ApiOperation({ summary: "The merchant's orders (customer plans), newest first" })
  listPlans(@CurrentMerchantId() merchantId: string, @Query() q: Record<string, string>) {
    return this.plans.listByMerchant(merchantId, {
      status: q.status,
      limit: numOrUndefined(q.limit),
      offset: numOrUndefined(q.offset),
    });
  }

  @Get('plans/:id')
  planGet(@CurrentMerchantId() merchantId: string, @Param('id') id: string) {
    return this.ownPlan(id, merchantId);
  }

  @Get('plans/:id/schedule')
  async planSchedule(@CurrentMerchantId() merchantId: string, @Param('id') id: string) {
    await this.ownPlan(id, merchantId);
    return this.plans.getSchedule(id);
  }

  @Get('plans/:id/statement')
  async planStatement(@CurrentMerchantId() merchantId: string, @Param('id') id: string) {
    await this.ownPlan(id, merchantId);
    return this.plans.getStatement(id);
  }

  @Get('plans/:id/statement.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="statement.csv"')
  async planStatementCsv(
    @CurrentMerchantId() merchantId: string,
    @Param('id') id: string,
  ): Promise<string> {
    await this.ownPlan(id, merchantId);
    return renderStatementCsv(await this.plans.getStatement(id));
  }

  @Get('plans/:id/statement.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async planStatementHtml(
    @CurrentMerchantId() merchantId: string,
    @Param('id') id: string,
  ): Promise<string> {
    await this.ownPlan(id, merchantId);
    return renderStatementHtml(await this.plans.getStatement(id));
  }

  @Get('plans/:id/settlement')
  async planSettlement(@CurrentMerchantId() merchantId: string, @Param('id') id: string) {
    await this.ownPlan(id, merchantId);
    const view = await this.dashboard.getPlanSettlement(id);
    if (!view) throw new NotFoundException(`Plan ${id} not found`);
    return view;
  }

  @Get('plan-templates')
  @ApiOperation({ summary: 'Active plan templates the merchant can offer (read-only)' })
  async planTemplatesList() {
    const all = await this.planTemplates.list({ is_active: true, limit: 200 });
    return all;
  }

  /** Loads a plan and asserts it belongs to this merchant (404 otherwise). */
  private async ownPlan(planId: string, merchantId: string): Promise<CustomerPlan> {
    const plan = await this.plans.get(planId);
    if (plan.merchant_id !== merchantId) {
      throw new NotFoundException(`Plan ${planId} not found`);
    }
    return plan;
  }
}
