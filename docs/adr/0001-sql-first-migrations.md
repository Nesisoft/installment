# ADR 0001 — SQL-first migrations with a thin custom runner

**Status:** Accepted · Phase 1

## Context

The canonical schema lives in `docs/design/0001_installment_engine_init.sql`: 20
tables, `pgcrypto`/`citext` extensions, partial indexes, `updated_at` triggers,
append-only enforcement triggers (`block_modification()`), and plpgsql function
bodies delimited by `$$`. The Development Plan states migrations are sacred —
once applied, the file is never edited.

Drizzle-kit's own migrator (`drizzle-kit migrate`) splits a migration into
statements on `;` / `--> statement-breakpoint` and wraps them in its own
transaction. That behaviour is unsafe for this file: it would split inside the
`$$ ... $$` plpgsql bodies, and the file's own outer `BEGIN; ... COMMIT;` would
nest inside drizzle's transaction.

## Decision

- The Drizzle migration is `packages/db/drizzle/0000_installment_engine_init.sql`,
  a **byte-for-byte copy** of the design SQL (verified by sha256).
- A thin custom runner (`packages/db/src/migrate.ts`, `pg`-based) applies ordered
  `drizzle/*.sql` files and tracks them in a `schema_migrations` table. It strips
  only the single outer `BEGIN;`/`COMMIT;` _in memory_ so apply + tracking-row
  insert commit atomically in one runner-controlled transaction. The on-disk file
  is never modified.
- `drizzle-kit` is still used — but only for `introspect` (generating typed
  `schema.ts` from the live DB) and for future schema-diff `generate`.

## Consequences

- The canonical SQL stays authoritative and unedited; triggers, partial indexes
  and plpgsql survive intact.
- `pnpm migrate` / `pnpm db:reset` are predictable and idempotent.
- Future migrations are plain ordered `.sql` files (hand-written or
  drizzle-kit-generated), applied by the same runner.
- We own ~120 lines of migration-runner code instead of delegating to
  `drizzle-kit migrate`. Accepted: it is small, tested by the Phase 1
  verification, and removes a class of plpgsql/transaction edge cases.
