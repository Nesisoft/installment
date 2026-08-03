import pg from 'pg';
import { createDb, type Database } from './client';

/**
 * Test-suite database isolation.
 *
 * Every integration spec used to open `DATABASE_URL` directly and nothing ever
 * cleaned up — no `TRUNCATE`, no `beforeEach`, only `afterAll(() => pool.end())`.
 * Two consequences, both of which cost real debugging time:
 *
 *   - Specs running in parallel workers shared one database, so a sweep that
 *     scans "every merchant" or "every overdue schedule" picked up rows another
 *     spec was mid-way through creating.
 *   - Assertions on a *global* ledger account — `paystack_settlement['main']`,
 *     `default_pool['main']`, `revenue['platform']` — were meaningless, because
 *     the balance carried whatever previous tests had left. One such assertion
 *     passed locally against an accumulated database and failed in CI against a
 *     clean one.
 *
 * The fix has two halves. Each vitest worker gets its own database, cloned from
 * the migrated template, so parallel files cannot see each other. Within a
 * worker files run sequentially, so truncating before each file gives every
 * spec a database holding only the seeded reference data.
 */

/** Tables holding seeded reference data that every spec expects to exist. */
const PRESERVED_TABLES = new Set([
  'schema_migrations',
  'permissions',
  'roles',
  'role_permissions',
  'users', // system actors only — see truncateTransactionalTables
]);

/** How many worker databases to provision. Must match the vitest fork count. */
export const TEST_DB_WORKERS = Number(process.env.VITEST_DB_WORKERS ?? 4);

function requireDatabaseUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set');
  return new URL(raw);
}

/** The worker index vitest assigned this process (1-based). */
function workerId(): number {
  const raw = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '1';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Which suite these databases belong to. `pnpm --filter core --filter commerce
 * test:integration` runs both packages *concurrently*, so without a namespace
 * one suite's globalSetup would drop the databases the other's workers are
 * connected to.
 */
function namespace(): string {
  const ns = process.env.VITEST_DB_NAMESPACE;
  return ns ? `_${ns}` : '';
}

/** `installment` → `installment_core_w3`, keeping every other connection option. */
export function testDatabaseUrl(worker = workerId()): string {
  const url = requireDatabaseUrl();
  url.pathname = `/${templateName()}${namespace()}_w${worker}`;
  return url.toString();
}

/** The migrated database every worker copy is cloned from. */
function templateName(): string {
  return decodeURIComponent(requireDatabaseUrl().pathname.replace(/^\//, ''));
}

/** Opens this worker's own database. Integration specs use this, never `createDb`. */
export function createTestDb(): { db: Database; pool: pg.Pool } {
  return createDb({ connectionString: testDatabaseUrl() });
}

/**
 * Clones the migrated template into one database per worker. Runs once, in the
 * vitest main process, before any worker starts.
 *
 * `CREATE DATABASE ... TEMPLATE` is effectively a file copy, so this stays fast
 * however many migrations accumulate — but Postgres refuses it while anything
 * else is connected to the template, which is why open sessions are closed
 * first. That is safe here: the template is a development database, and the
 * suite is about to rewrite it anyway.
 */
export async function provisionTestDatabases(workers = TEST_DB_WORKERS): Promise<void> {
  const url = requireDatabaseUrl();
  const template = templateName();
  const suffix = namespace();

  // Connect to `postgres`, not the template — you cannot clone a database you
  // are connected to.
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();

  try {
    const migrated = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_database WHERE datname = $1`,
      [template],
    );
    if (Number(migrated.rows[0]?.n ?? 0) === 0) {
      throw new Error(
        `Template database "${template}" does not exist. Run \`pnpm migrate\` first.`,
      );
    }

    for (let worker = 1; worker <= workers; worker++) {
      const name = `${template}${suffix}_w${worker}`;
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }

    // Close template sessions *after* dropping the clones, so a clone's own
    // connections are not what blocks us.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [template],
    );

    for (let worker = 1; worker <= workers; worker++) {
      const name = `${template}${suffix}_w${worker}`;
      await admin.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(template)}`);
    }
  } finally {
    await admin.end();
  }
}

/** Drops the per-worker databases. Best-effort — a leftover is harmless. */
export async function dropTestDatabases(workers = TEST_DB_WORKERS): Promise<void> {
  const url = requireDatabaseUrl();
  const template = `${templateName()}${namespace()}`;
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    for (let worker = 1; worker <= workers; worker++) {
      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdent(`${template}_w${worker}`)} WITH (FORCE)`,
      );
    }
  } finally {
    await admin.end();
  }
}

/**
 * Empties every transactional table, leaving the seeded RBAC rows and system
 * actors. Called before each spec file.
 *
 * `TRUNCATE` rather than `DELETE` for a reason beyond speed: `ledger_entries`
 * and `audit_events` carry `BEFORE DELETE` triggers that refuse the operation
 * outright — that append-only guarantee is deliberate and tested. `TRUNCATE`
 * does not fire row-level triggers, so it is the only way to reset those tables
 * without weakening the guard the production path depends on.
 */
export async function truncateTransactionalTables(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const targets = rows
      .map((r) => r.tablename)
      .filter((t) => !PRESERVED_TABLES.has(t))
      .map(quoteIdent);

    if (targets.length > 0) {
      await client.query(`TRUNCATE TABLE ${targets.join(', ')} RESTART IDENTITY CASCADE`);
    }
    // Staff/customer accounts created by specs go; the nine seeded system
    // actors stay, because SYSTEM_ACTORS ids are referenced by name everywhere.
    await client.query(`DELETE FROM users WHERE user_type <> 'system'`);
  } finally {
    await client.end();
  }
}

/** Quotes an identifier for interpolation into DDL (no parameters allowed there). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
