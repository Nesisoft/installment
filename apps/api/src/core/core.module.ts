import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  ApplicationsService,
  AttemptRepository,
  AuditLogger,
  AuthService,
  CustomerEmploymentService,
  ChargeReceiptService,
  CollectionsNotifierService,
  CollectionsService,
  CustomerPlansService,
  CustomersService,
  DebitRunner,
  DefaultService,
  EmployersService,
  VerifyRunner,
  EventBus,
  FeatureCollector,
  DrizzleIdempotencyStore,
  IdempotencyService,
  JwtService,
  LedgerService,
  LedgerIntegrityService,
  MerchantsService,
  MockGhanaCardVerifier,
  OtpService,
  PasswordService,
  MerchantDashboardService,
  NotificationService,
  PaymentService,
  PaymentLinkDispatcher,
  PayoutRecorder,
  ReminderRunner,
  ReconciliationService,
  RefundService,
  ReserveReleaseService,
  SettlementService,
  PlanTemplatesService,
  PlanCashLedger,
  RedisLock,
  RulesetLoader,
  ScheduleStateService,
  ScoringEngine,
  ScoringService,
  CustomerCreditService,
  InstallmentsFeedService,
  LateFeeService,
  PlanQuoteService,
  StuckScheduleRunner,
  TelcoHealthMonitor,
  UsersService,
  WebhookService,
  type SmsSender,
  CardAuthorizationService,
} from '@installment/core';
import {
  AddressesService,
  CartService,
  CategoriesService,
  CheckoutDecisionService,
  DevicesService,
  FulfilmentService,
  MediaService,
  ReviewsService,
  StorefrontService,
  WishlistService,
  InventoryService,
  OrdersService,
  ProductsService,
  StoresService,
  OrderPaymentService,
} from '@installment/commerce';
import { PaystackClient } from '@installment/paystack-client';
import type { StorageDriver } from '@installment/storage-client';
import type { Database } from '@installment/db';
import { captureAlert } from '../common/alerting';
import { DRIZZLE } from '../db/db.module';
import { REDIS } from '../redis/redis.module';
import { RedisTelcoHealthStore } from './redis-telco-store';
import type { Env } from '../config/env.validation';
import { RedisOtpStore } from './redis-otp-store';
import { createSmsSender } from './sms-sender.factory';
import { BullMqRetryScheduler } from '../workers/bullmq-retry-scheduler';
import { createDriverFromEnv, resolveMediaBaseUrl } from './storage.factory';
import { LocalMediaConfig } from '../media/local-media.config';
import { UploadsService } from '../media/uploads.service';

export const SMS_SENDER = Symbol('SMS_SENDER');
export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');

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
    {
      provide: SMS_SENDER,
      useFactory: (config: ConfigService<Env, true>) => createSmsSender(config),
      inject: [ConfigService],
    },
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
      provide: StoresService,
      useFactory: (db: Database, audit: AuditLogger) => new StoresService(db, audit),
      inject: [DRIZZLE, AuditLogger],
    },
    {
      provide: CategoriesService,
      useFactory: (db: Database, audit: AuditLogger) => new CategoriesService(db, audit),
      inject: [DRIZZLE, AuditLogger],
    },
    {
      provide: ProductsService,
      useFactory: (db: Database, audit: AuditLogger) => new ProductsService(db, audit),
      inject: [DRIZZLE, AuditLogger],
    },
    {
      provide: InventoryService,
      useFactory: (db: Database) => new InventoryService(db),
      inject: [DRIZZLE],
    },
    {
      provide: AddressesService,
      useFactory: (db: Database) => new AddressesService(db),
      inject: [DRIZZLE],
    },
    {
      provide: STORAGE_DRIVER,
      useFactory: (config: ConfigService<Env, true>) => createDriverFromEnv(config),
      inject: [ConfigService],
    },
    {
      provide: UploadsService,
      useFactory: (config: ConfigService<Env, true>, driver: StorageDriver) =>
        new UploadsService(driver, {
          maxUploadBytes: config.get('STORAGE_MAX_UPLOAD_BYTES', { infer: true }),
          uploadTtlSeconds: config.get('STORAGE_UPLOAD_TTL_SECONDS', { infer: true }),
        }),
      inject: [ConfigService, STORAGE_DRIVER],
    },
    {
      provide: LocalMediaConfig,
      useFactory: (config: ConfigService<Env, true>) =>
        new LocalMediaConfig(
          config.get('STORAGE_DRIVER', { infer: true }) === 'local',
          config.get('STORAGE_LOCAL_DIR', { infer: true }),
          config.get('STORAGE_UPLOAD_SECRET', { infer: true }),
          config.get('STORAGE_MAX_UPLOAD_BYTES', { infer: true }),
        ),
      inject: [ConfigService],
    },
    {
      provide: MediaService,
      // Both MEDIA_BASE_URL and the driver's public prefix unset means every
      // image URL resolves to null, which the apps render as their placeholder
      // tile rather than a broken image — so a deployment without object
      // storage degrades quietly instead of loudly.
      useFactory: (config: ConfigService<Env, true>, driver: StorageDriver) =>
        new MediaService(
          resolveMediaBaseUrl(config.get('MEDIA_BASE_URL', { infer: true }), driver),
        ),
      inject: [ConfigService, STORAGE_DRIVER],
    },
    {
      provide: StorefrontService,
      useFactory: (db: Database, media: MediaService) => new StorefrontService(db, media),
      inject: [DRIZZLE, MediaService],
    },
    {
      provide: FulfilmentService,
      // The plans service is what turns a delivery into a reserve release, so a
      // deployment without it would mark orders delivered and never start the
      // merchant's payout clock.
      useFactory: (db: Database, audit: AuditLogger, plans: CustomerPlansService) =>
        new FulfilmentService(db, audit, plans),
      inject: [DRIZZLE, AuditLogger, CustomerPlansService],
    },
    {
      provide: WishlistService,
      useFactory: (db: Database, storefront: StorefrontService) =>
        new WishlistService(db, storefront),
      inject: [DRIZZLE, StorefrontService],
    },
    {
      provide: ReviewsService,
      useFactory: (db: Database) => new ReviewsService(db),
      inject: [DRIZZLE],
    },
    {
      provide: DevicesService,
      useFactory: (db: Database) => new DevicesService(db),
      inject: [DRIZZLE],
    },
    {
      provide: PlanQuoteService,
      useFactory: (db: Database) => new PlanQuoteService(db),
      inject: [DRIZZLE],
    },
    {
      provide: CustomerCreditService,
      useFactory: (db: Database) => new CustomerCreditService(db),
      inject: [DRIZZLE],
    },
    {
      provide: InstallmentsFeedService,
      useFactory: (db: Database) => new InstallmentsFeedService(db),
      inject: [DRIZZLE],
    },
    {
      provide: LateFeeService,
      useFactory: (db: Database, audit: AuditLogger) => new LateFeeService(db, audit),
      inject: [DRIZZLE, AuditLogger],
    },
    {
      provide: CartService,
      useFactory: (db: Database, media: MediaService) => new CartService(db, media),
      inject: [DRIZZLE, MediaService],
    },
    {
      provide: OrdersService,
      useFactory: (
        db: Database,
        inventory: InventoryService,
        applications: ApplicationsService,
        plans: CustomerPlansService,
        ledger: LedgerService,
        audit: AuditLogger,
        fulfilment: FulfilmentService,
      ) => new OrdersService(db, inventory, applications, plans, ledger, audit, fulfilment),
      inject: [
        DRIZZLE,
        InventoryService,
        ApplicationsService,
        CustomerPlansService,
        LedgerService,
        AuditLogger,
        FulfilmentService,
      ],
    },
    {
      provide: CheckoutDecisionService,
      useFactory: (
        db: Database,
        orders: OrdersService,
        applications: ApplicationsService,
        scoring: ScoringService,
        plans: CustomerPlansService,
        credit: CustomerCreditService,
      ) => new CheckoutDecisionService(db, orders, applications, scoring, plans, credit),
      inject: [
        DRIZZLE,
        OrdersService,
        ApplicationsService,
        ScoringService,
        CustomerPlansService,
        CustomerCreditService,
      ],
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
      provide: LedgerIntegrityService,
      useFactory: (db: Database) => new LedgerIntegrityService(db),
      inject: [DRIZZLE],
    },
    {
      provide: PlanCashLedger,
      useFactory: (ledger: LedgerService) => new PlanCashLedger(ledger),
      inject: [LedgerService],
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
      provide: RefundService,
      useFactory: (
        db: Database,
        ledger: LedgerService,
        audit: AuditLogger,
        paystack: PaystackClient,
      ) => new RefundService(db, ledger, audit, paystack),
      inject: [DRIZZLE, LedgerService, AuditLogger, PaystackClient],
    },
    {
      provide: ReconciliationService,
      useFactory: (
        db: Database,
        settlement: SettlementService,
        paystack: PaystackClient,
        refunds: RefundService,
      ) => new ReconciliationService(db, settlement, paystack, refunds, paystack),
      inject: [DRIZZLE, SettlementService, PaystackClient, RefundService],
    },
    {
      provide: MerchantDashboardService,
      useFactory: (db: Database, ledger: LedgerService) => new MerchantDashboardService(db, ledger),
      inject: [DRIZZLE, LedgerService],
    },
    {
      provide: CollectionsNotifierService,
      useFactory: (
        plans: CustomerPlansService,
        customers: CustomersService,
        notifications: NotificationService,
      ) => new CollectionsNotifierService(plans, customers, notifications),
      inject: [CustomerPlansService, CustomersService, NotificationService],
    },
    {
      provide: CollectionsService,
      useFactory: (
        db: Database,
        audit: AuditLogger,
        plans: CustomerPlansService,
        stageNotifier: CollectionsNotifierService,
      ) => new CollectionsService(db, audit, plans, stageNotifier),
      inject: [DRIZZLE, AuditLogger, CustomerPlansService, CollectionsNotifierService],
    },
    {
      provide: CustomerPlansService,
      useFactory: (
        db: Database,
        audit: AuditLogger,
        payouts: PayoutRecorder,
        reserves: ReserveReleaseService,
        defaults: DefaultService,
        cashLedger: PlanCashLedger,
        refunds: RefundService,
      ) =>
        new CustomerPlansService(
          db,
          audit,
          undefined,
          payouts,
          reserves,
          defaults,
          cashLedger,
          refunds,
        ),
      inject: [
        DRIZZLE,
        AuditLogger,
        PayoutRecorder,
        ReserveReleaseService,
        DefaultService,
        PlanCashLedger,
        RefundService,
      ],
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
      provide: BullMqRetryScheduler,
      useFactory: (config: ConfigService<Env, true>) => new BullMqRetryScheduler(config),
      inject: [ConfigService],
    },
    {
      provide: ChargeReceiptService,
      useFactory: (
        plans: CustomerPlansService,
        customers: CustomersService,
        notifications: NotificationService,
      ) => new ChargeReceiptService(plans, customers, notifications),
      inject: [CustomerPlansService, CustomersService, NotificationService],
    },
    {
      provide: TelcoHealthMonitor,
      useFactory: (redis: Redis) => new TelcoHealthMonitor(new RedisTelcoHealthStore(redis)),
      inject: [REDIS],
    },
    {
      provide: CardAuthorizationService,
      useFactory: (db: Database) => new CardAuthorizationService(db),
      inject: [DRIZZLE],
    },
    {
      provide: PaymentService,
      useFactory: (
        plans: CustomerPlansService,
        scheduleState: ScheduleStateService,
        attempts: AttemptRepository,
        paystack: PaystackClient,
        retryScheduler: BullMqRetryScheduler,
        receipts: ChargeReceiptService,
        telco: TelcoHealthMonitor,
        lock: RedisLock,
        cards: CardAuthorizationService,
      ) =>
        new PaymentService(
          plans,
          scheduleState,
          attempts,
          paystack,
          retryScheduler,
          receipts,
          telco,
          lock,
          cards,
        ),
      inject: [
        CustomerPlansService,
        ScheduleStateService,
        AttemptRepository,
        PaystackClient,
        BullMqRetryScheduler,
        ChargeReceiptService,
        TelcoHealthMonitor,
        RedisLock,
        CardAuthorizationService,
      ],
    },
    {
      provide: IdempotencyService,
      useFactory: (db: Database) => new IdempotencyService(new DrizzleIdempotencyStore(db)),
      inject: [DRIZZLE],
    },
    {
      provide: StuckScheduleRunner,
      useFactory: (db: Database, attempts: AttemptRepository, payments: PaymentService) =>
        new StuckScheduleRunner(db, attempts, payments, {
          stuck: (detail) => captureAlert('installment stuck in processing', 'error', detail),
        }),
      inject: [DRIZZLE, AttemptRepository, PaymentService],
    },
    {
      provide: DebitRunner,
      useFactory: (
        plans: CustomerPlansService,
        customers: CustomersService,
        payments: PaymentService,
        cards: CardAuthorizationService,
      ) => new DebitRunner(plans, customers, payments, cards),
      inject: [CustomerPlansService, CustomersService, PaymentService, CardAuthorizationService],
    },
    {
      provide: VerifyRunner,
      useFactory: (attempts: AttemptRepository, payments: PaymentService) =>
        new VerifyRunner(attempts, payments),
      inject: [AttemptRepository, PaymentService],
    },
    {
      provide: NotificationService,
      useFactory: (db: Database, sms: SmsSender, config: ConfigService<Env, true>) =>
        new NotificationService(db, sms, config.get('SMS_SENDER_ID', { infer: true })),
      inject: [DRIZZLE, SMS_SENDER, ConfigService],
    },
    {
      provide: PaymentLinkDispatcher,
      useFactory: (
        plans: CustomerPlansService,
        customers: CustomersService,
        attempts: AttemptRepository,
        notifications: NotificationService,
        paystack: PaystackClient,
      ) => new PaymentLinkDispatcher(plans, customers, attempts, notifications, paystack),
      inject: [
        CustomerPlansService,
        CustomersService,
        AttemptRepository,
        NotificationService,
        PaystackClient,
      ],
    },
    {
      provide: ReminderRunner,
      useFactory: (
        plans: CustomerPlansService,
        customers: CustomersService,
        notifications: NotificationService,
      ) => new ReminderRunner(plans, customers, notifications),
      inject: [CustomerPlansService, CustomersService, NotificationService],
    },
    {
      provide: OrderPaymentService,
      useFactory: (db: Database, orders: OrdersService, paystack: PaystackClient) =>
        new OrderPaymentService(db, orders, paystack),
      inject: [DRIZZLE, OrdersService, PaystackClient],
    },
    {
      provide: WebhookService,
      useFactory: (
        db: Database,
        paystack: PaystackClient,
        attempts: AttemptRepository,
        plans: CustomerPlansService,
        scheduleState: ScheduleStateService,
        payments: PaymentService,
        settlements: SettlementService,
        refunds: RefundService,
        orderPayments: OrderPaymentService,
        cards: CardAuthorizationService,
      ) =>
        // Share PaymentService's failure pipeline so a webhook-delivered
        // decline runs the same retry ladder as a synchronous one.
        new WebhookService(
          db,
          paystack,
          attempts,
          plans,
          scheduleState,
          payments.failureEscalator,
          { unhandled: (detail) => captureAlert('paystack webhook not applied', 'error', detail) },
          // Lets transfer.* events settle or reverse the matching payout.
          settlements,
          // ...and refund.* events discharge the customer's refund.
          refunds,
          // A charge.success matching no installment attempt may be a customer
          // paying for an order; those carry their reference on the order row.
          orderPayments,
          // A card paid on a hosted page only ever surfaces here, so this is
          // where the reusable authorization is kept.
          cards,
        ),
      inject: [
        DRIZZLE,
        PaystackClient,
        AttemptRepository,
        CustomerPlansService,
        ScheduleStateService,
        PaymentService,
        SettlementService,
        RefundService,
        OrderPaymentService,
        CardAuthorizationService,
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
        customers: CustomersService,
      ) =>
        new AuthService({
          users,
          passwords,
          jwt,
          otp,
          sms,
          smsSenderId: config.get('SMS_SENDER_ID', { infer: true }),
          // Customer self-signup creates the domain record alongside the login.
          customers,
        }),
      inject: [
        UsersService,
        PasswordService,
        JwtService,
        OtpService,
        SMS_SENDER,
        ConfigService,
        CustomersService,
      ],
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
    StoresService,
    CategoriesService,
    ProductsService,
    InventoryService,
    AddressesService,
    CartService,
    OrdersService,
    OrderPaymentService,
    MediaService,
    STORAGE_DRIVER,
    UploadsService,
    LocalMediaConfig,
    StorefrontService,
    FulfilmentService,
    WishlistService,
    ReviewsService,
    DevicesService,
    CheckoutDecisionService,
    PlanQuoteService,
    CustomerCreditService,
    InstallmentsFeedService,
    LateFeeService,
    CustomersService,
    EmployersService,
    CustomerEmploymentService,
    PlanTemplatesService,
    ApplicationsService,
    ScoringService,
    RulesetLoader,
    CustomerPlansService,
    LedgerService,
    LedgerIntegrityService,
    PayoutRecorder,
    ReserveReleaseService,
    DefaultService,
    SettlementService,
    ReconciliationService,
    RefundService,
    MerchantDashboardService,
    CollectionsService,
    PaymentService,
    IdempotencyService,
    StuckScheduleRunner,
    DebitRunner,
    VerifyRunner,
    NotificationService,
    PaymentLinkDispatcher,
    CardAuthorizationService,
    ReminderRunner,
    TelcoHealthMonitor,
    WebhookService,
  ],
})
export class CoreModule {}
