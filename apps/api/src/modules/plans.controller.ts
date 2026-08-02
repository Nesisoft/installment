import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  CustomerPlansService,
  MerchantDashboardService,
  PERMISSIONS,
  renderStatementCsv,
  renderStatementHtml,
} from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';
import { ApiModel } from '../common/api-model';
import { Idempotent } from '../common/idempotent.decorator';

@ApiTags('plans')
@ApiBearerAuth()
@Controller('admin/plans')
export class PlansController {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly dashboard: MerchantDashboardService,
  ) {}

  @Post('from-application/:applicationId')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  @HttpCode(201)
  @ApiOperation({ summary: 'Activate an approved application into a plan + installment schedule' })
  activate(@Param('applicationId') applicationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.activateFromApplication(applicationId, actorOf(user));
  }

  @Get(':id')
  @ApiModel('CustomerPlan')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  get(@Param('id') id: string) {
    return this.plans.get(id);
  }

  @Post(':id/default')
  @Idempotent()
  @RequirePermissions(PERMISSIONS.COLLECTIONS_ACT)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Write a plan off as defaulted — allocates the unrecovered loss across reserve / merchant / platform per the business model',
  })
  default(
    @Param('id') id: string,
    @Body() body: { reason?: string; unrecoveredAmountPesewas?: number } | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.plans.markPlanDefaulted(
      id,
      { reason: body?.reason, unrecoveredAmountPesewas: body?.unrecoveredAmountPesewas },
      actorOf(user),
    );
  }

  @Get(':id/schedule')
  @ApiModel('InstallmentSchedule', { array: true })
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({ summary: 'The installment schedule for a plan, ordered by sequence' })
  schedule(@Param('id') id: string) {
    return this.plans.getSchedule(id);
  }

  @Get(':id/statement')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({ summary: 'Customer-facing statement (structured JSON)' })
  statement(@Param('id') id: string) {
    return this.plans.getStatement(id);
  }

  @Get(':id/statement.csv')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="statement.csv"')
  @ApiOperation({ summary: 'Statement as a CSV download (opens in Excel)' })
  async statementCsv(@Param('id') id: string): Promise<string> {
    return renderStatementCsv(await this.plans.getStatement(id));
  }

  @Get(':id/statement.html')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Printable HTML statement (print → PDF)' })
  async statementHtml(@Param('id') id: string): Promise<string> {
    return renderStatementHtml(await this.plans.getStatement(id));
  }

  @Get(':id/settlement')
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({
    summary: 'Per-plan settlement view (accruals, refunds, reserve, default footprint)',
  })
  async settlement(@Param('id') id: string) {
    const view = await this.dashboard.getPlanSettlement(id);
    if (!view) throw new NotFoundException(`Plan ${id} not found`);
    return view;
  }
}
