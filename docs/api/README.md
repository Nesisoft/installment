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

## Scope note — request/response schemas

Request bodies are validated with **Zod inside the domain services**, so the
controllers type bodies as `unknown`. As a result this spec currently documents
routes, params, auth, and tags but **not** detailed request/response body
schemas. Enriching the spec (Zod → OpenAPI) is the prerequisite for generating a
fully-typed `@installment/api-types` client for the web/mobile apps — deferred
until that enrichment lands (roadmap Phase 11 follow-on).
