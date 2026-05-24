import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from 'dotenv';
import pg from 'pg';

config({ path: process.env.DOTENV_PATH ?? '../../.env' });

const MIGRATIONS_DIR = resolve(__dirname, '../drizzle');
const TRACKING_TABLE = 'schema_migrations';

/**
 * The canonical migration files wrap their whole body in an explicit
 * `BEGIN; ... COMMIT;`. We strip that single outer transaction control so the
 * runner can apply the migration AND record it in {@link TRACKING_TABLE} inside
 * one transaction we control — making "applied" and "recorded" atomic. The .sql
 * file on disk stays byte-for-byte identical to docs/design (it is sacred); only
 * this in-memory copy is adjusted.
 */
function stripOuterTransaction(sql: string): string {
  let body = sql.replace(/^[ \t]*BEGIN(?:[ \t]+TRANSACTION)?[ \t]*;[ \t]*\r?\n/m, '');
  const commitRe = /^[ \t]*COMMIT[ \t]*;[ \t]*\r?\n?/gm;
  let lastIndex = -1;
  let lastLength = 0;
  let match: RegExpExecArray | null;
  while ((match = commitRe.exec(body)) !== null) {
    lastIndex = match.index;
    lastLength = match[0].length;
  }
  if (lastIndex >= 0) {
    body = body.slice(0, lastIndex) + body.slice(lastIndex + lastLength);
  }
  return body;
}

export async function runMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (checked process.env and ../../.env)');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
         filename   TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );

    const applied = new Set<string>(
      (await client.query<{ filename: string }>(`SELECT filename FROM ${TRACKING_TABLE}`)).rows.map(
        (r) => r.filename,
      ),
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    if (files.length === 0) {
      console.warn(`[migrate] no .sql files found in ${MIGRATIONS_DIR}`);
      return;
    }

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] skip   ${file} (already applied)`);
        continue;
      }

      const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const body = stripOuterTransaction(raw);

      console.log(`[migrate] apply  ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(body);
        await client.query(`INSERT INTO ${TRACKING_TABLE} (filename) VALUES ($1)`, [file]);
        await client.query('COMMIT');
        appliedCount += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration failed: ${file}\n${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    console.log(
      appliedCount === 0
        ? '[migrate] nothing to apply — database is up to date'
        : `[migrate] done — applied ${appliedCount} migration(s)`,
    );
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
