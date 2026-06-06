import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SettlementCron } from './settlement.cron';
import { ReserveReleaseCron } from './reserve-release.cron';
import { ReconciliationCron } from './reconciliation.cron';

/**
 * Scheduled workers — daily settlement (06:00 UTC), reserve-release sweep
 * (07:00 UTC), and payout reconciliation (every 30 minutes). Each is gated
 * by ENABLE_SCHEDULED_WORKERS so dev / tests don't spin them up. CoreModule
 * is `@Global`, so the services they depend on resolve automatically.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [SettlementCron, ReserveReleaseCron, ReconciliationCron],
})
export class WorkersModule {}
