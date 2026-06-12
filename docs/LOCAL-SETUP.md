# Local setup & per-phase verification

This guide walks you through booting the Installment Payment Engine on your
laptop and verifying every phase end-to-end. Most steps are copy-paste.

> If you've never set this up: do [Bootstrap](#bootstrap) once, then run any of
> the per-phase verifications in any order.
>
> If you already set it up earlier: skim [Refresh from main](#refresh-from-main)
> and jump to [Verification by phase](#verification-by-phase).

## TL;DR — does the whole thing work?

```bash
git checkout claude/setup-monorepo-phase-1-DZnU4
git pull --ff-only
pnpm install                      # deps
pnpm db:up                        # Postgres 16 + Redis 7 in Docker
pnpm db:reset                     # drops + recreates the schema
pnpm db:seed:dev                  # admin user, perms, sample merchant/customer
pnpm typecheck && pnpm lint       # static gates
pnpm test                         # 280 hermetic tests
pnpm --filter @installment/core test:integration  # integration suite (needs DB)
pnpm --filter @installment/api dev                # API on :3000
```

If all of those pass, the engine works locally. The rest of this doc is for
when one of them doesn't, or you want to verify a specific phase manually.

## Bootstrap

### 1. Prereqs

- **Node.js ≥ 22** (`node -v`)
- **pnpm ≥ 10** (`pnpm -v` — `corepack enable` if missing)
- **Docker + Docker Compose** (`docker info` should print engine details)

### 2. Clone & branch

```bash
git clone <repo-url> installment
cd installment
git checkout claude/setup-monorepo-phase-1-DZnU4
```

### 3. Environment

```bash
cp .env.example .env
# Defaults are fine for local dev. Production secrets are NOT in this file.
```

Notable defaults:

- `DATABASE_URL=postgresql://installment:installment@localhost:5432/installment`
- `REDIS_URL=redis://localhost:6379`
- `ENABLE_SCHEDULED_WORKERS=false` (keep workers OFF locally unless verifying
  them, otherwise they'll spin up the moment the API boots)

> Port 5432 already taken by a system Postgres? Edit BOTH `POSTGRES_PORT` and
> the port in `DATABASE_URL` to something free (e.g. 5433).

### 4. Bring up Postgres + Redis

```bash
pnpm db:up
# wait ~5s for the healthcheck, then:
docker ps   # should show installment-postgres + installment-redis "(healthy)"
```

### 5. Install + migrate + seed

```bash
pnpm install
pnpm db:reset      # drops + recreates the schema (idempotent first run too)
pnpm db:seed:dev   # admin user, plan templates, sample merchant + customer
```

You should now have a working schema. Verify:

```bash
docker exec -it installment-postgres \
  psql -U installment -d installment -c '\dt'
# expect tables: customers, merchants, customer_plans, installment_schedule,
# ledger_entries, payouts, held_reserves, collections_cases, notifications, …
```

## Refresh from main

If you already had this set up before and just want the latest:

```bash
git fetch origin
git checkout claude/setup-monorepo-phase-1-DZnU4
git pull --ff-only
pnpm install
pnpm db:reset && pnpm db:seed:dev   # only if you want a clean DB
```

## The five gates that always must pass

Run these any time, anywhere:

| Gate              | Command                                            | Needs DB | Needs Redis |
| ----------------- | -------------------------------------------------- | -------- | ----------- |
| Typecheck         | `pnpm typecheck`                                   | no       | no          |
| Lint              | `pnpm lint`                                        | no       | no          |
| Build             | `pnpm build`                                       | no       | no          |
| Hermetic tests    | `pnpm test`                                        | no       | no          |
| Integration tests | `pnpm --filter @installment/core test:integration` | **yes**  | no\*        |

\* Some specs spin up an in-process Redis-style fixture; you don't need a live
Redis for `core`'s integration suite. The API integration tests (when added)
will need both.

If the four hermetic gates pass, the build is sound. If the integration suite
also passes, the engine works against a real Postgres.

## Verification by phase

Each section is a 30-second smoke test for a specific area. They're
independent — run any of them on demand.

### Phase 1–2 · Core math + state machines (no DB)

```bash
pnpm --filter @installment/core test --run \
  src/shared/money/money.spec.ts \
  src/modules/schedules/state-machine.spec.ts \
  src/modules/schedules/schedule-generator.spec.ts
```

### Phase 3–4 · Customers / merchants / applications

```bash
pnpm --filter @installment/core test:integration --run \
  src/modules/customers/customers.integration.spec.ts \
  src/modules/merchants/merchants.integration.spec.ts \
  src/modules/applications/applications.integration.spec.ts
```

### Phase 5 · Scoring engine

```bash
pnpm --filter @installment/core test --run src/modules/scoring/
```

### Phase 6 · Customer plans + receipts/statements

```bash
pnpm --filter @installment/core test:integration --run \
  src/modules/schedules/customer-plans.integration.spec.ts
```

### Phase 7 · Payments (charge + retry + verify)

```bash
pnpm --filter @installment/core test:integration --run \
  src/modules/payments/
```

### Phase 8 · Settlement engine

```bash
pnpm --filter @installment/core test:integration --run \
  src/modules/settlements/
```

Books accruals → reserves → settles → reconciles → defaults → merchant
dashboard + monthly statement.

### Phase 9 · Notifications + collections

```bash
pnpm --filter @installment/core test --run src/modules/notifications/
pnpm --filter @installment/core test:integration --run src/modules/collections/
```

### Workers (cron + BullMQ retry)

The workers are wired into the API but **gated by `ENABLE_SCHEDULED_WORKERS`**.
For local verification, run the API with workers on, watch the logs:

```bash
ENABLE_SCHEDULED_WORKERS=true pnpm --filter @installment/api dev
```

Then in another shell, force a debit sweep by setting an installment's due
date to today and watching the hourly cron pick it up (or trigger the runner
directly via a node REPL — easiest is to wait for the next cron tick or
shortcut the schedule expression in the cron class temporarily).

To smoke-test the BullMQ retry path: configure `REDIS_URL`, enable workers,
trigger a retryable decline via the API, and watch the queue / worker logs.

## End-to-end smoke (API)

With the API running:

```bash
pnpm --filter @installment/api dev      # in one shell
./scripts/smoke.sh                      # in another (see scripts/smoke.sh)
```

The smoke script registers a merchant + customer, submits + approves an
application, activates a plan, manually settles an installment, and verifies
the ledger booked the accrual.

## Troubleshooting

- **`pnpm db:reset` fails with "role already exists"**: the volume has stale
  data. `pnpm db:down && docker volume rm installment-engine_postgres_data &&
pnpm db:up && pnpm db:reset`.
- **Integration tests skip everything**: `DATABASE_URL` is unset. They
  `describe.skipIf(!process.env.DATABASE_URL)` by design. Source your `.env`
  or run them with `pnpm` (which auto-loads `.env`).
- **`pnpm build` errors on `bullmq` types**: `pnpm install` may not have
  finished writing types. Re-run `pnpm install`.
- **API boots but `curl /health` 404**: it's mounted at `/health`. If you
  curl `localhost:3000`, you'll get a 404 — that's expected, there's no root
  route.
- **Workers spam the logs**: set `ENABLE_SCHEDULED_WORKERS=false` in `.env`.
