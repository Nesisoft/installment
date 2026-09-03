import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  MerchantDashboardService,
  MerchantKycService,
  MerchantsService,
  PERMISSIONS,
  rejectKycDocumentSchema,
  renderMerchantStatementCsv,
  renderMerchantStatementHtml,
  type AuditActorType,
  type MerchantActor,
} from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import {
  createMerchantSchema,
  updateMerchantSchema,
  transitionMerchantSchema,
  attachPaystackRecipientSchema,
} from '@installment/core';
import { ApiZodBody } from '../common/api-zod';
import { ApiModel } from '../common/api-model';

function toActorType(userType: string): AuditActorType {
  switch (userType) {
    case 'merchant':
      return 'merchant';
    case 'customer':
      return 'customer';
    case 'system':
      return 'system';
    default:
      return 'admin'; // admin / agent staff
  }
}

const numOrUndefined = (v: unknown): number | undefined =>
  v === undefined || v === '' ? undefined : Number(v);

@ApiTags('merchants')
@ApiBearerAuth()
@Controller('admin/merchants')
export class MerchantsController {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly dashboard: MerchantDashboardService,
    private readonly kycService: MerchantKycService,
  ) {}

  private actor(user: AuthenticatedUser): MerchantActor {
    return { actorId: user.id, actorType: toActorType(user.userType) };
  }

  @Post()
  @ApiModel('Merchant', { created: true })
  @ApiZodBody(createMerchantSchema)
  @RequirePermissions(PERMISSIONS.MERCHANTS_WRITE)
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.merchants.create(body, this.actor(user));
  }

  @Get()
  @ApiModel('Merchant', { array: true })
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  list(@Query() query: Record<string, string>) {
    return this.merchants.list({
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get(':id')
  @ApiModel('Merchant')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  get(@Param('id') id: string) {
    return this.merchants.get(id);
  }

  @Patch(':id')
  @ApiModel('Merchant')
  @ApiZodBody(updateMerchantSchema)
  @RequirePermissions(PERMISSIONS.MERCHANTS_WRITE)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.merchants.update(id, body, this.actor(user));
  }

  @Post(':id/transition')
  @ApiModel('Merchant')
  @ApiZodBody(transitionMerchantSchema)
  @RequirePermissions(PERMISSIONS.MERCHANTS_WRITE)
  @HttpCode(200)
  transition(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.merchants.transition(id, body, this.actor(user));
  }

  @Post(':id/paystack-recipient')
  @ApiModel('Merchant')
  @ApiZodBody(attachPaystackRecipientSchema)
  @RequirePermissions(PERMISSIONS.MERCHANTS_WRITE)
  @HttpCode(200)
  attachPaystackRecipient(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.merchants.attachPaystackRecipient(id, body, this.actor(user));
  }

  // --- KYC review -----------------------------------------------------------
  //
  // The reviewer's half of merchant onboarding. Before this, activation was a
  // button with no document behind it; `MerchantsService.transition` now
  // refuses a first activation until the required types below are approved.

  @Get(':id/kyc')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  @ApiOperation({ summary: "A merchant's KYC documents and what is outstanding" })
  kyc(@Param('id') id: string) {
    return this.kycService.statusFor(id);
  }

  @Post(':id/kyc/:documentId/approve')
  @RequirePermissions(PERMISSIONS.MERCHANTS_WRITE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve one KYC document' })
  approveKyc(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kycService.approve(documentId, this.actor(user));
  }

  @Post(':id/kyc/:documentId/reject')
  @RequirePermissions(PERMISSIONS.MERCHANTS_WRITE)
  @ApiZodBody(rejectKycDocumentSchema)
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject one KYC document, with a reason' })
  rejectKyc(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kycService.reject(documentId, body, this.actor(user));
  }

  @Get(':id/balances')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  balances(@Param('id') id: string) {
    return this.dashboard.getBalances(id);
  }

  @Get(':id/payouts')
  @ApiModel('Payout', { array: true })
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  payouts(@Param('id') id: string, @Query() query: Record<string, string>) {
    return this.dashboard.listPayouts(id, {
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get(':id/reserves')
  @ApiModel('HeldReserve', { array: true })
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  reserves(@Param('id') id: string, @Query() query: Record<string, string>) {
    const open = query.open === undefined ? true : query.open !== 'false';
    return this.dashboard.listHeldReserves(id, { open });
  }

  @Get(':id/statement')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  @ApiOperation({ summary: 'Monthly merchant account statement (JSON) — ?year=&month=' })
  statement(@Param('id') id: string, @Query() query: Record<string, string>) {
    const { year, month } = parsePeriod(query);
    return this.dashboard.getMonthlyStatement(id, year, month);
  }

  @Get(':id/statement.csv')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="merchant-statement.csv"')
  @ApiOperation({ summary: 'Monthly merchant statement as a CSV download — ?year=&month=' })
  async statementCsv(
    @Param('id') id: string,
    @Query() query: Record<string, string>,
  ): Promise<string> {
    const { year, month } = parsePeriod(query);
    return renderMerchantStatementCsv(await this.dashboard.getMonthlyStatement(id, year, month));
  }

  @Get(':id/statement.html')
  @RequirePermissions(PERMISSIONS.MERCHANTS_READ)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({
    summary: 'Monthly merchant statement as printable HTML (print → PDF) — ?year=&month=',
  })
  async statementHtml(
    @Param('id') id: string,
    @Query() query: Record<string, string>,
  ): Promise<string> {
    const { year, month } = parsePeriod(query);
    return renderMerchantStatementHtml(await this.dashboard.getMonthlyStatement(id, year, month));
  }
}

/** Parses + validates ?year=&month= (defaults to the current UTC month). */
function parsePeriod(query: Record<string, string>): { year: number; month: number } {
  const now = new Date();
  const year = query.year ? Number(query.year) : now.getUTCFullYear();
  const month = query.month ? Number(query.month) : now.getUTCMonth() + 1;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new BadRequestException('year must be a 4-digit year');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new BadRequestException('month must be 1..12');
  }
  return { year, month };
}
