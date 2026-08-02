import { Controller, Get } from '@nestjs/common';
import { LedgerIntegrityService, PERMISSIONS } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators';

/**
 * Read-only view of the financial record's internal consistency.
 *
 * The hourly cron alerts on drift; this is what an operator opens when it
 * fires, and what an auditor is shown on request. `ledger_entries` is
 * append-only, so a drifted book can only be compensated, never corrected —
 * which makes "is it drifted, and exactly where" the first question worth
 * being able to answer at any moment.
 */
@ApiTags('ledger')
@ApiBearerAuth()
@Controller('admin/ledger')
export class LedgerController {
  constructor(private readonly integrity: LedgerIntegrityService) {}

  @Get('integrity')
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  @ApiOperation({
    summary: 'Trial balance and any unbalanced transactions',
    description:
      'The trial balance sums every account. Individual accounts are expected to be ' +
      'non-zero; their total must be exactly 0, because every transaction posts equal ' +
      'debits and credits. A non-zero total means the books have drifted, and ' +
      'unbalancedTransactions locates it. See docs/runbooks/ledger-imbalance.md.',
  })
  integrityReport() {
    return this.integrity.report();
  }
}
