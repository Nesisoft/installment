import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SettlementCron } from './settlement.cron';
import { ReserveReleaseCron } from './reserve-release.cron';
import { ReconciliationCron } from './reconciliation.cron';
import { DebitSchedulerCron } from './debit-scheduler.cron';
import { RetryWorker } from './retry.worker';

/**
 * Scheduled + queued workers — hourly auto-debit sweep, daily settlement
 * (06:00 UTC), reserve-release sweep (07:00 UTC), payout reconciliation (every
 * 30 minutes), and the BullMQ retry consumer. Each is gated by
 * ENABLE_SCHEDULED_WORKERS so dev / tests don't spin them up. CoreModule is
 * `@Global`, so the services they depend on (incl. DebitRunner) resolve
 * automatically. The retry *producer* lives in CoreModule (PaymentService
 * needs it); the *consumer* (RetryWorker) lives here.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    SettlementCron,
    ReserveReleaseCron,
    ReconciliationCron,
    DebitSchedulerCron,
    RetryWorker,
  ],
})
export class WorkersModule {}
