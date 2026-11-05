import { Global, Module, type OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDb, type Database, type Pool } from '@installment/db';
import type { Env } from '../config/env.validation';

export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');

/** The one pool and its Drizzle client: both tokens hand out the same connections. */
const DB_HANDLE = Symbol('DB_HANDLE');

@Global()
@Module({
  providers: [
    {
      // One pool for the process. Building the pool and the Drizzle client
      // separately opened two, doubling the connections the API holds against
      // a hosted Postgres whose pooler caps clients (Supabase's session mode
      // refuses past its pool size), and the second was never closed.
      provide: DB_HANDLE,
      useFactory: (config: ConfigService<Env, true>) =>
        createDb({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: config.get('DATABASE_POOL_MAX', { infer: true }),
        }),
      inject: [ConfigService],
    },
    {
      provide: PG_POOL,
      useFactory: (handle: { pool: Pool }) => handle.pool,
      inject: [DB_HANDLE],
    },
    {
      provide: DRIZZLE,
      useFactory: (handle: { db: Database }) => handle.db,
      inject: [DB_HANDLE],
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
