import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SettlementCron } from './settlement.cron';
import { ReserveReleaseCron } from './reserve-release.cron';
import { ReconciliationCron } from './reconciliation.cron';
import { RefundCron } from './refund.cron';
import { DebitSchedulerCron } from './debit-scheduler.cron';
import { VerifyPollCron } from './verify-poll.cron';
import { CollectionsCron } from './collections.cron';
import { ReminderCron } from './reminder.cron';
import { TelcoAlertCron } from './telco-alert.cron';
import { StuckScheduleCron } from './stuck-schedule.cron';
import { ApplicationExpiryCron } from './application-expiry.cron';
import { OrderExpiryCron } from './order-expiry.cron';
import { IdempotencyReaperCron } from './idempotency-reaper.cron';
import { LedgerIntegrityCron } from './ledger-integrity.cron';
import { RetryWorker } from './retry.worker';

/**
 * Scheduled + queued workers — hourly auto-debit sweep, verify-poll sweep
 * (every 5 min), daily settlement (06:00 UTC), reserve-release sweep
 * (07:00 UTC), payout reconciliation (every 30 min), and the BullMQ retry
 * consumer. Each is gated by ENABLE_SCHEDULED_WORKERS so dev / tests don't spin
 * them up. CoreModule is `@Global`, so the services they depend on (incl.
 * DebitRunner / VerifyRunner) resolve automatically. The retry *producer* lives
 * in CoreModule (PaymentService needs it); the *consumer* (RetryWorker) here.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    SettlementCron,
    ReserveReleaseCron,
    ReconciliationCron,
    RefundCron,
    DebitSchedulerCron,
    VerifyPollCron,
    CollectionsCron,
    ReminderCron,
    TelcoAlertCron,
    StuckScheduleCron,
    ApplicationExpiryCron,
    OrderExpiryCron,
    IdempotencyReaperCron,
    LedgerIntegrityCron,
    RetryWorker,
  ],
})
export class WorkersModule {}
