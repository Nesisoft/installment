import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../drizzle/_introspect/schema';

export type Database = NodePgDatabase<typeof schema>;

export interface CreateDbOptions {
  connectionString: string;
  max?: number;
}

/**
 * Creates a Drizzle client backed by a node-postgres Pool.
 * The caller owns the returned pool and is responsible for closing it.
 */
export function createDb(opts: CreateDbOptions): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export { schema };
