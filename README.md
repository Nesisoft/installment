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
  api/            NestJS HTTP entry point (Phase 1)
  workers/        BullMQ workers            (Phase 7+, placeholder)
  customer-web/   React customer dashboard  (Phase 10, placeholder)
  merchant-web/   React merchant dashboard  (Phase 10, placeholder)
  admin-web/      React admin / ops console (Phase 10, placeholder)
packages/
  db/             Drizzle schema + migration runner (Phase 1)
  core/           Shared domain modules     (Phase 2+, placeholder)
  paystack-client/ Typed Paystack wrapper   (Phase 2,  placeholder)
  sms-client/     Hubtel / Arkesel wrapper  (Phase 2,  placeholder)
  ui/             Shared shadcn/ui          (Phase 10, placeholder)
  api-types/      Shared backend↔frontend types (Phase 3+, placeholder)
infra/docker/     docker-compose: Postgres + Redis + pgAdmin
docs/             Development plan, design artifacts, ADRs
```

## Prerequisites

- Node.js >= 22
- pnpm >= 10 (`corepack enable` or `npm i -g pnpm`)
- Docker + Docker Compose (for local Postgres / Redis)

## Local setup

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

## CI

`.github/workflows/ci.yml` runs on every pull request: spins up Postgres 16 +
Redis 7 service containers, applies the migration, then runs lint, typecheck,
test, and build.
