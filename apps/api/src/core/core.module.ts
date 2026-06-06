import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  ApplicationsService,
  AttemptRepository,
  AuditLogger,
  AuthService,
  CustomerEmploymentService,
  CustomerPlansService,
  CustomersService,
  DefaultService,
  EmployersService,
  EventBus,
  FeatureCollector,
  JwtService,
  LedgerService,
  MerchantsService,
  MockGhanaCardVerifier,
  OtpService,
  PasswordService,
  MerchantDashboardService,
  PaymentService,
  PayoutRecorder,
  ReconciliationService,
  ReserveReleaseService,
  SettlementService,
  PlanTemplatesService,
  RedisLock,
  RulesetLoader,
  ScheduleStateService,
  ScoringEngine,
  ScoringService,
  UsersService,
  WebhookService,
  type SmsSender,
} from '@installment/core';
import { PaystackClient } from '@installment/paystack-client';
import type { Database } from '@installment/db';
import { DRIZZLE } from '../db/db.module';
import { REDIS } from '../redis/redis.module';
import type { Env } from '../config/env.validation';
import { RedisOtpStore } from './redis-otp-store';
import { ConsoleSmsSender } from './console-sms-sender';

export const SMS_SENDER = Symbol('SMS_SENDER');

/**
 * Wires the framework-free @installment/core services into Nest providers.
 * Core stays NestJS-agnostic; all DI/config plumbing lives here.
 */
@Global()
@Module({
  providers: [
    { provide: AuditLogger, useFactory: () => new AuditLogger() },
    { provide: PasswordService, useFactory: () => new PasswordService() },
    {
      provide: JwtService,
      useFactory: (config: ConfigService<Env, true>) =>
        new JwtService({
          accessSecret: config.get('JWT_ACCESS_SECRET', { infer: true }),
          refreshSecret: config.get('JWT_REFRESH_SECRET', { infer: true }),
          accessTtlSeconds: config.get('JWT_ACCESS_TTL_SECONDS', { infer: true }),
          refreshTtlSeconds: config.get('JWT_REFRESH_TTL_SECONDS', { infer: true }),
          issuer: 'installment',
        }),
      inject: [ConfigService],
    },
    {
      provide: OtpService,
      useFactory: (redis: Redis) => new OtpService(new RedisOtpStore(redis)),
      inject: [REDIS],
    },
    { provide: SMS_SENDER, useClass: ConsoleSmsSender },
    {
      provide: UsersService,
      useFactory: (db: Database, audit: AuditLogger, passwords: PasswordService) =>
        new UsersService(db, audit, passwords),
      inject: [DRIZZLE, AuditLogger, PasswordService],
    },
    {
      provide: MerchantsService,
      useFactory: (db: Database, audit: AuditLogger) => new MerchantsService(db, audit),
      inject: [DRIZZLE, AuditLogger],
    },
    {
      provide: CustomersService,
      // Real NIA Ghana Card verification arrives in a later phase; mock for now.
      useFactory: (db: Database, audit: AuditLogger) =>
        new CustomersService(db, audit, new MockGhanaCardVerifier()),
      inject: [DRIZZLE, AuditLogger],
    },
    {
      provide: EmployersService,
      useFactory: (db: Database, audit: AuditLogger) => new EmployersService(db, audit),
      inject: [DRIZZLE, AuditLogger],
    },
    {
      provide: CustomerEmploymentService,
      useFactory: (db: Database, audit: AuditLogger) => new CustomerEmploymentService(db, audit),
      inject: [DRIZZLE, AuditLogger],
    },
    {
      provide: PlanTemplatesService,
      useFactory: (db: Database, audit: AuditLogger) => new PlanTemplatesService(db, audit),
      inject: [DRIZZLE, AuditLogger],
    },
    {
      provide: ApplicationsService,
      useFactory: (db: Database, audit: AuditLogger) => new ApplicationsService(db, audit),
      inject: [DRIZZLE, AuditLogger],
    },
    {
      provide: ScoringService,
      useFactory: (db: Database, applications: ApplicationsService) =>
        new ScoringService(db, FeatureCollector.fromDb(db), new ScoringEngine(), applications),
      inject: [DRIZZLE, ApplicationsService],
    },
    {
      provide: RulesetLoader,
      useFactory: (db: Database) => new RulesetLoader(db),
      inject: [DRIZZLE],
    },
    {
      provide: LedgerService,
      useFactory: (db: Database) => new LedgerService(db),
      inject: [DRIZZLE],
    },
    {
      provide: PayoutRecorder,
      useFactory: (db: Database, ledger: LedgerService) => new PayoutRecorder(db, ledger),
      inject: [DRIZZLE, LedgerService],
    },
    {
      provide: ReserveReleaseService,
      useFactory: (db: Database, ledger: LedgerService) => new ReserveReleaseService(db, ledger),
      inject: [DRIZZLE, LedgerService],
    },
    {
      provide: DefaultService,
      useFactory: (db: Database, ledger: LedgerService, reserves: ReserveReleaseService) =>
        new DefaultService(db, ledger, reserves),
      inject: [DRIZZLE, LedgerService, ReserveReleaseService],
    },
    {
      provide: SettlementService,
      useFactory: (
        db: Database,
        ledger: LedgerService,
        audit: AuditLogger,
        paystack: PaystackClient,
      ) => new SettlementService(db, ledger, audit, paystack),
      inject: [DRIZZLE, LedgerService, AuditLogger, PaystackClient],
    },
    {
      provide: ReconciliationService,
      useFactory: (db: Database, settlement: SettlementService, paystack: PaystackClient) =>
        new ReconciliationService(db, settlement, paystack),
      inject: [DRIZZLE, SettlementService, PaystackClient],
    },
    {
      provide: MerchantDashboardService,
      useFactory: (db: Database, ledger: LedgerService) => new MerchantDashboardService(db, ledger),
      inject: [DRIZZLE, LedgerService],
    },
    {
      provide: CustomerPlansService,
      useFactory: (
        db: Database,
        audit: AuditLogger,
        payouts: PayoutRecorder,
        reserves: ReserveReleaseService,
        defaults: DefaultService,
      ) => new CustomerPlansService(db, audit, undefined, payouts, reserves, defaults),
      inject: [DRIZZLE, AuditLogger, PayoutRecorder, ReserveReleaseService, DefaultService],
    },
    { provide: EventBus, useFactory: () => new EventBus() },
    {
      provide: RedisLock,
      useFactory: (redis: Redis) => new RedisLock(redis),
      inject: [REDIS],
    },
    {
      provide: ScheduleStateService,
      useFactory: (db: Database, audit: AuditLogger, lock: RedisLock, bus: EventBus) =>
        new ScheduleStateService(db, audit, lock, bus),
      inject: [DRIZZLE, AuditLogger, RedisLock, EventBus],
    },
    {
      provide: AttemptRepository,
      useFactory: (db: Database) => new AttemptRepository(db),
      inject: [DRIZZLE],
    },
    {
      provide: PaystackClient,
      useFactory: (config: ConfigService<Env, true>) =>
        new PaystackClient({
          // Empty key in dev → a placeholder so boot works; real calls 401 until set.
          secretKey: config.get('PAYSTACK_SECRET_KEY', { infer: true }) || 'sk_test_unset',
          baseUrl: config.get('PAYSTACK_BASE_URL', { infer: true }),
        }),
      inject: [ConfigService],
    },
    {
      provide: PaymentService,
      useFactory: (
        plans: CustomerPlansService,
        scheduleState: ScheduleStateService,
        attempts: AttemptRepository,
        paystack: PaystackClient,
      ) => new PaymentService(plans, scheduleState, attempts, paystack),
      inject: [CustomerPlansService, ScheduleStateService, AttemptRepository, PaystackClient],
    },
    {
      provide: WebhookService,
      useFactory: (
        db: Database,
        paystack: PaystackClient,
        attempts: AttemptRepository,
        plans: CustomerPlansService,
        scheduleState: ScheduleStateService,
      ) => new WebhookService(db, paystack, attempts, plans, scheduleState),
      inject: [
        DRIZZLE,
        PaystackClient,
        AttemptRepository,
        CustomerPlansService,
        ScheduleStateService,
      ],
    },
    {
      provide: AuthService,
      useFactory: (
        users: UsersService,
        passwords: PasswordService,
        jwt: JwtService,
        otp: OtpService,
        sms: SmsSender,
        config: ConfigService<Env, true>,
      ) =>
        new AuthService({
          users,
          passwords,
          jwt,
          otp,
          sms,
          smsSenderId: config.get('SMS_SENDER_ID', { infer: true }),
        }),
      inject: [UsersService, PasswordService, JwtService, OtpService, SMS_SENDER, ConfigService],
    },
  ],
  exports: [
    AuditLogger,
    PasswordService,
    JwtService,
    OtpService,
    UsersService,
    AuthService,
    MerchantsService,
    CustomersService,
    EmployersService,
    CustomerEmploymentService,
    PlanTemplatesService,
    ApplicationsService,
    ScoringService,
    RulesetLoader,
    CustomerPlansService,
    LedgerService,
    PayoutRecorder,
    ReserveReleaseService,
    DefaultService,
    SettlementService,
    ReconciliationService,
    MerchantDashboardService,
    PaymentService,
    WebhookService,
  ],
})
export class CoreModule {}
