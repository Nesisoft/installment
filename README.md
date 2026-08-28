# Installment Payment Engine

Reusable installment payment engine for the Ghanaian / West African e-commerce
market. Standalone microservice consumable by Ejua, Meko, Pharmacy POS, and
future Nesisoft products.

> Stack: Node.js (NestJS) · PostgreSQL 16 · Redis 7 · Drizzle ORM · pnpm
> workspaces · Turborepo. See [`docs/DEVELOPMENT-PLAN.md`](docs/DEVELOPMENT-PLAN.md)
> for the full architecture and phased roadmap.

## Repository layout

```
apps/
  api/              NestJS HTTP entry point
  workers/          BullMQ workers
  customer-mobile/  Ejua shopping app — Expo / React Native  ← Phase 14
  customer-web/     React customer dashboard
  merchant-web/     React merchant dashboard  (placeholder)
  admin-web/        React admin / ops console (placeholder)
packages/
  db/               Drizzle schema + migration runner
  core/             Installment engine domain modules
  commerce/         Catalogue, cart, orders, fulfilment, storefront reads
  paystack-client/  Typed Paystack wrapper
  sms-client/       Hubtel / Arkesel wrapper
  api-types/        Shared wire types (web + mobile)
  web-kit/          Browser client layer: API client, auth context, query defaults
  mobile-kit/       React Native client layer: same, on SecureStore
  ui/               shadcn/ui — WEB ONLY
infra/docker/       docker-compose: Postgres + Redis + pgAdmin
docs/               Development plan, design artifacts, ADRs
```

The customer app has its own guide:
[`apps/customer-mobile/README.md`](apps/customer-mobile/README.md), and the design-to-engine
reconciliation behind it is
[`docs/design/customer-app.md`](docs/design/customer-app.md).

## Prerequisites

- Node.js >= 22
- pnpm >= 10 (`corepack enable` or `npm i -g pnpm`)
- Docker + Docker Compose (for local Postgres / Redis)

## Local setup

> **No Docker?** `./scripts/local-stack.sh up` starts Postgres 16 and Redis 7 from the system
> binaries and applies the migrations — which is what the remote/CI container needs, since it
> ships both but no Docker daemon.

```bash
# 1. Install dependencies
pnpm install

# 2. Create your env file
cp .env.example .env

# 3. Start Postgres 16 + Redis 7 (+ pgAdmin on :5050)
pnpm db:up

# 4. Apply the initial database migration (creates all 20 tables)
pnpm migrate

# 5. Generate the typed Drizzle schema from the migrated DB
pnpm db:introspect

# 6. Run the API (http://localhost:3000)
pnpm dev
```

Verify the service is healthy:

```bash
curl -i http://localhost:3000/health
# 200 OK -> {"status":"ok","info":{"db":"up","redis":"up"},...}
# 503    -> {"status":"degraded",...} if DB or Redis is unreachable
```

## Scripts

| Command                  | What it does                                               |
| ------------------------ | ---------------------------------------------------------- |
| `pnpm dev`               | Boot the API in watch mode on `:3000`                      |
| `pnpm build`             | Turborepo build of all packages                            |
| `pnpm lint`              | ESLint across the workspace                                |
| `pnpm typecheck`         | TypeScript no-emit check                                   |
| `pnpm test`              | Vitest unit tests                                          |
| `pnpm format`            | Prettier write                                             |
| `pnpm migrate`           | Apply pending SQL migrations (`packages/db/drizzle/*.sql`) |
| `pnpm db:reset`          | Drop & recreate `public`, then re-migrate (dev/test only)  |
| `pnpm db:introspect`     | Regenerate typed Drizzle schema from the live DB           |
| `pnpm db:up` / `db:down` | Start / stop the docker-compose stack                      |

## Database migrations

The canonical schema is `docs/design/0001_installment_engine_init.sql`. It is
copied byte-for-byte to `packages/db/drizzle/0000_installment_engine_init.sql`
and applied by a thin custom runner. **Migrations are immutable once applied** —
add `000N_*.sql` files for changes; never edit an applied migration. See
[`docs/adr/0001-sql-first-migrations.md`](docs/adr/0001-sql-first-migrations.md)
for the rationale.

## Contributing

Branch names, commit format and the checks to run before pushing are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## CI

`.github/workflows/ci.yml` runs on every pull request: spins up Postgres 16 +
Redis 7 service containers, applies the migration, then runs lint, typecheck,
test, and build.
