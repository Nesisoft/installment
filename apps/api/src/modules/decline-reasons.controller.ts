import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { DeclineReasonReport, PERMISSIONS } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators';

const DAY_MS = 86_400_000;

/**
 * Ops view of the decline reasons charges have actually come back with, and
 * how the classifier treats each. The daily alert names the unrecognised ones;
 * this is where to read the whole picture — and where the strings to add to
 * `PAYSTACK_DECLINE_MAP` come from, once real declines have run.
 */
@ApiTags('payments')
@ApiBearerAuth()
@Controller('admin/payments/decline-reasons')
export class DeclineReasonsController {
  constructor(private readonly report: DeclineReasonReport) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PLANS_READ)
  @ApiOperation({ summary: 'Decline reasons seen in the last N days (default 30), with counts' })
  list(@Query('days') days?: string) {
    const n = days === undefined ? 30 : Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      throw new BadRequestException('days must be a whole number from 1 to 365');
    }
    return this.report.summarise({ since: new Date(Date.now() - n * DAY_MS) });
  }
}
