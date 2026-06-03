import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv, type Env } from './config/env.validation';
import { DbModule } from './db/db.module';
import { RedisModule } from './redis/redis.module';
import { CoreModule } from './core/core.module';
import { HealthModule } from './health/health.module';
import { AuthController } from './auth/auth.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './auth/permissions.guard';
import { MerchantsController } from './modules/merchants.controller';
import { CustomersController } from './modules/customers.controller';
import { EmployersController } from './modules/employers.controller';
import { PlanTemplatesController } from './modules/plan-templates.controller';
import { UsersController } from './modules/users.controller';
import { ScoringController } from './modules/scoring.controller';
import { PlansController } from './modules/plans.controller';
import { InstallmentsController } from './modules/installments.controller';
import { SettlementsController } from './modules/settlements.controller';
import { MeController } from './modules/me.controller';
import { WebhookController } from './modules/webhook.controller';
import { DomainExceptionFilter } from './common/domain-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['../../.env', '.env'],
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const isDev = config.get('NODE_ENV', { infer: true }) !== 'production';
        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),
            transport: isDev ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
        };
      },
    }),
    DbModule,
    RedisModule,
    CoreModule,
    HealthModule,
  ],
  controllers: [
    AuthController,
    MerchantsController,
    CustomersController,
    EmployersController,
    PlanTemplatesController,
    UsersController,
    ScoringController,
    PlansController,
    InstallmentsController,
    SettlementsController,
    MeController,
    WebhookController,
  ],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    // Order matters: authenticate first, then check permissions.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
