import { Global, Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDb, type Database, type Pool } from '@installment/db';
import type { Env } from '../config/env.validation';

export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (config: ConfigService<Env, true>) => {
        const { pool } = createDb({
          connectionString: config.get('DATABASE_URL', { infer: true }),
        });
        return pool;
      },
      inject: [ConfigService],
    },
    {
      provide: DRIZZLE,
      useFactory: (config: ConfigService<Env, true>) => {
        const { db } = createDb({
          connectionString: config.get('DATABASE_URL', { infer: true }),
        });
        return db;
      },
      inject: [ConfigService],
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DbModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

export type { Database };
