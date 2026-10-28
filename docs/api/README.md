# API contract (OpenAPI)

`openapi.json` is the published OpenAPI 3.0 contract for the Installment Payment
Engine API — the engine (auth, merchants, customers, plan templates, scoring,
plans, settlements, collections, webhooks) **and** the commerce layer (stores,
categories, products, public storefront). It is generated from the live NestJS
application's route metadata, so it always reflects the real routes, methods,
path/query params, tags, and Bearer-auth requirements.

It doubles as the integration contract for partners consuming the engine as an
open API (Ejua, Meko, Pharmacy POS).

## Regenerate

The emitter boots the app **without opening an HTTP port**, but the app's
providers connect to Postgres + Redis on construction, so both must be
reachable:

```bash
pnpm db:up          # local Postgres + Redis, or point DATABASE_URL / REDIS_URL elsewhere
pnpm openapi:emit   # builds the workspace, boots headless, writes docs/api/openapi.json
```

- Document definition (title, version, tags, security): `apps/api/src/openapi.ts`
  — the same builder feeds the live Swagger UI at `GET /docs` (JSON at `/docs-json`).
- Emitter: `apps/api/src/tools/emit-openapi.ts`.

## What the spec describes

Every route, with its method, path and query parameters, tags, Bearer-auth requirement and,
where the controller declares one, a summary. Beyond that, coverage is partial — as of the
2026-10-28 regeneration, of 263 operations:

- **85 document their request body.** `@ApiZodBody(schema)` (`apps/api/src/common/api-zod.ts`)
  converts the same Zod schema the service validates with, so a documented body cannot drift
  from what is accepted. The remaining bodies are typed `unknown` in the controller and appear
  without a schema.
- **134 document their response.** `@ApiModel('Name')` (`apps/api/src/common/api-model.ts`)
  points at a component schema derived from the Drizzle table (`apps/api/src/openapi.ts`), so the
  read models track the database. Composite responses — lists with totals, console rows with
  joined names — mostly appear without one.

To close a gap, add `@ApiZodBody` with the service's schema, or `@ApiModel` with a component, to
the route and regenerate.

## Relationship to `@installment/api-types`

`packages/api-types` is **not** generated from this file. It is written by hand for the web and
mobile apps, and `apps/api/src/common/api-types-mirror.spec.ts` holds the parts that must match
the backend — enums, permissions, Zod schemas, product fields — to it in CI. This spec is for
partners and for anyone reading the API from outside the repo.
