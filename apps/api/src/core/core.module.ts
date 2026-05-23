import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  AuditLogger,
  AuthService,
  CustomerEmploymentService,
  CustomersService,
  EmployersService,
  JwtService,
  MerchantsService,
  MockGhanaCardVerifier,
  OtpService,
  PasswordService,
  PlanTemplatesService,
  UsersService,
  type SmsSender,
} from '@installment/core';
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
  ],
})
export class CoreModule {}
