import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { CustomerPlansService, PERMISSIONS } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';

@ApiTags('plans')
@ApiBearerAuth()
@Controller('admin/installments')
export class InstallmentsController {
  constructor(private readonly plans: CustomerPlansService) {}

  @Post(':scheduleId/record-payment')
  @RequirePermissions(PERMISSIONS.COLLECTIONS_ACT)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record an out-of-band payment against an installment (admin override)',
  })
  recordPayment(
    @Param('scheduleId') scheduleId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.plans.recordManualPayment(scheduleId, body, actorOf(user));
  }
}
