import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Scripts run with cwd = packages/db (pnpm --filter). The .env lives at repo root.
config({ path: process.env.DOTENV_PATH ?? '../../.env' });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set (checked process.env and ../../.env)');
}

// Introspect output is isolated under drizzle/_introspect so it never collides
// with the hand-managed, canonical migration SQL in drizzle/*.sql.
export default defineConfig({
  dialect: 'postgresql',
  schema: './drizzle/_introspect/schema.ts',
  out: './drizzle/_introspect',
  dbCredentials: { url },
  introspect: { casing: 'preserve' },
  verbose: true,
  strict: true,
});
