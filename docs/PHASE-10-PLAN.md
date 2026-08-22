# Phase 10 — Frontends, Polish & Launch Prep

> Companion to `DEVELOPMENT-PLAN.md` §Phase 10. The backend (NestJS modular
> monolith) is complete through its own phases 1–10; this phase builds the three
> React apps on top of it and closes the backend gaps they need.

## Status

**Foundation: complete and verified** (`pnpm typecheck`, `pnpm lint`, per-app
`vite build`, and `prettier --check` on new files all pass).

| Piece                    | What landed                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API CORS                 | `apps/api/src/main.ts` — env-driven `CORS_ORIGINS` (defaults to the three Vite dev ports).                                                                                                                       |
| `@installment/api-types` | Browser-safe contracts: enums, `formatGhs`/`bpsToPercent` money helpers, auth + form Zod schemas, domain row + view-model types.                                                                                 |
| `@installment/ui`        | shadcn-style components (Button, Card, Input, Label, Badge, Spinner, Skeleton, StatusBadge) + brand Tailwind preset + `globals.css`. Brand green `#0F6B4F`, cream accent, mist background.                       |
| `@installment/web-kit`   | Axios client with single-flight token refresh, `AuthProvider`/`useAuth`, React Query client, localStorage session store.                                                                                         |
| `apps/customer-web`      | **Mobile-first shopping app**: public storefront (search + categories), product detail with instalment estimate, cart, checkout (address + full/instalment + plan pick), orders, plans with MoMo pay. Port 5173. |
| `apps/merchant-web`      | **Responsive** (sidebar desktop / bottom tabs mobile). Email/password login; live Dashboard, Orders, Settlements, Statements, Plan templates wired to `/merchant/*`. Port 5174.                                  |
| `apps/admin-web`         | Staff login, ops sidebar (8 sections), dashboard + placeholders. Port 5175.                                                                                                                                      |

Each app authenticates against the real backend today; feature screens are the
next iterations.

**admin-web live screens (done):**

- Live ops dashboard — pending+manual application counts, active merchant count, telco status (auto-refresh).
- Application review queue — filter by status, paginated, row → detail (`GET /admin/applications`).
- Application detail — summary, **scoring playground** (dry-run preview + score-&-persist), latest decision with rule breakdown, and human decision form incl. counter-offer / decline (`/score`, `/score/dry-run`, `/decision`, `GET /decision`).
- Telco health — per-network success cards, 30s auto-refresh (`GET /admin/telco-health`).
- Merchants — list (filter/paginate), onboarding form, detail with lifecycle transitions, Paystack-recipient attach, balances, recent payouts, open reserves, and authed statement view.
- Customers — list (KYC/blocklist filters), registration form, detail with Ghana Card verify/attach, MoMo, consents, blocklist add/remove.
- Plan templates — list (filters) + create/edit editor (GHS↔pesewas, %↔bps conversions; schedule-shape fields locked on edit) + activate/deactivate.
- Collections — case queue (stage/open filters) + case detail with context, action timeline, assign-to-me/assign-by-id, record-action, and manual close (paid/waived/restructured). **Required new backend endpoints** (built this session, see below).
- Plan operations — plan lookup → detail with schedule, settlement footprint, per-installment **record manual payment / refund / receipt**, and plan **write-off**. Application detail gained an **Activate to plan** button (`POST /admin/plans/from-application/:id`).
- Shared additions: `Table` primitive in `@installment/ui`; `ScoringDecision`/`ScoreResult`/`TelcoHealth`/`FeatureVector` + form schemas (decision, merchant/customer/plan-template, collections, plan-ops) in `@installment/api-types`.

**Admin is feature-complete** — only an optional standalone scoring playground (arbitrary feature vector) remains.

**merchant-web live screens (done):** responsive shell (sidebar on desktop, bottom tab bar on mobile); Dashboard (balances + recent orders), Orders (list + read-only detail with schedule / settlement footprint / statement view+CSV), Settlements (balances + payouts + reserves), Statements (monthly + print/CSV), Plan templates (read-only). All scoped to the caller's merchant via `/merchant/*` (`MerchantScopeGuard`). Dev login: `merchant@demo.local` / `password123`.

**customer-web live screens (done):**

- Shop — public search + category browse (browsing needs no account).
- Product detail — variants, stock, and an **instalment estimate** ("from GHS X / week") from the product's own `plan_template_ids`, clearly labelled an estimate.
- Cart — quantity +/-, remove, subtotal (`/me/cart*`).
- Checkout — delivery address pick/create, **pay in full or in instalments**, plan selection, place order (`POST /me/checkout`).
- Orders — list + detail, with financing status ("under review" → link to the plan once approved).
- Plans — list + detail with outstanding balance, next due, full schedule, **Pay now by Mobile Money** (sends a per-attempt `Idempotency-Key`, reused on retry so a double-tap cannot double-charge) and printable receipts.

**New backend endpoint for it:** `GET /storefront/plan-templates` (public, active + currently-effective). Required because `POST /me/checkout` demands a `plan_template_id` and no customer-reachable plan-template read existed — only admin-permissioned and merchant-scoped ones.

## Architecture decisions

- **Shared packages consumed as source** (`exports` → `src/*.ts(x)`), so no build
  step is needed before `vite dev`; Vite transpiles them and Tailwind scans
  `../../packages/ui/src` for classes. They have `typecheck`/`lint` scripts only.
- **Auth is pure Bearer** (no cookies). Access token (15 min) kept in the session
  store; refresh token (30 d) drives a single-flight refresh on 401, then retries
  once. `permissions[]` from login gates the UI (server re-checks every request).
- **Money/bps formatting lives only in `api-types`** — every amount from the API is
  integer pesewas / basis points; UI never does ad-hoc division.
- **Design fidelity:** brand-inspired with shadcn defaults (per the Phase 10
  decision), not a pixel rebuild of the prototypes.

## Backend gaps to close (build-as-we-go)

Discovered during the API mapping. Each is built alongside the UI that needs it.

| Gap                                           | Needed by               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ CORS                                       | all apps                | Done.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ✅ Rate limiting                              | all apps                | Done. Hand-rolled Redis fixed-window `RateLimitGuard` (no new dependency, matching the house style of the idempotency interceptor). Global default via `RATE_LIMIT_*`; `@RateLimit()` tightens auth (OTP-start 5/5min because each call sends a paid SMS; login/verify 10/5min) with a shared `auth` bucket so rotating between auth routes cannot refresh the allowance. `@SkipRateLimit()` exempts webhooks (a throttled Paystack retry is a lost payment notification) and health. Buckets by user when authenticated, else IP — set `TRUST_PROXY` behind a load balancer. Fails open if Redis is down. |
| ✅ Collections HTTP endpoints                 | admin collections queue | Done. Added read + agent-action methods to `CollectionsService` + `CollectionsController`: `GET /admin/collections/cases`, `GET /admin/collections/cases/:id`, `POST .../{assign,actions,close}` (collections:act), with 4 new integration tests. Manual close is paid/waived/restructured; default/write-off stay on the dunning sweep path.                                                                                                                                                                                                                                                              |
| Customer self-onboarding                      | customer onboarding     | OTP login only works for **pre-provisioned** customers; no public signup or Ghana Card upload-by-customer. Need public register + OTP-bootstrap.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Customer-facing checkout / application submit | customer checkout       | Applications are created via `POST /admin/applications` (needs `applications:review`). Need a customer/merchant-scoped submit + live plan calculator (calculator can be client-side from `plan_templates`).                                                                                                                                                                                                                                                                                                                                                                                                |
| Restructure request                           | customer + admin        | No restructure-request endpoint surfaced; collections restructure is internal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ✅ Merchant tenant-scoping                    | merchant app            | Done. `/merchant/*` portal scoped by `MerchantScopeGuard` (resolves the caller's merchant from `users.metadata.merchant_id`); plan sub-resources are ownership-checked. Migration-free link; a dedicated FK column is the future hardening. 4 integration tests.                                                                                                                                                                                                                                                                                                                                           |
| Browser Sentry                                | all apps                | Backend Sentry exists; add `@sentry/react` per app with `VITE_SENTRY_DSN`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Richer OpenAPI (optional)                     | typed codegen           | Controllers lack `@ApiProperty`/`@ApiResponse`, so `/docs-json` bodies are `unknown`. `api-types` is the contract source instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Per-app screen roadmap (wired to existing endpoints)

### customer-web (`/me/*` + `/auth/customer/*`)

- Onboarding (phone+OTP, Ghana Card upload) — _needs self-onboarding endpoints_
- Plans list & detail + schedule timeline — `GET /me/plans`, `/me/plans/:id/schedule`
- Pay early / pay MoMo — `/me` pay endpoints + Paystack inline (`VITE_PAYSTACK_PUBLIC_KEY`)
- Statements (view/print) — plan statement HTML
- Restructure request — _needs endpoint_

### merchant-web (`/admin/merchants/:id/*`, `/admin/plans/*`, `/admin/plan-templates/*`)

- Dashboard — `GET /admin/merchants/:id/balances`
- Orders / plans — `GET /admin/plans/:id`, `/admin/plans/:id/schedule`, `/admin/plans/:id/settlement`
- Settlements — `/admin/merchants/:id/payouts`, `/admin/merchants/:id/reserves`
- Statements — `/admin/merchants/:id/statement(.csv/.html)`
- Plan templates — `/admin/plan-templates` CRUD + activate/deactivate
- _All gated behind merchant tenant-scoping work._

### admin-web (`/admin/*`)

- Application review queue + decision + scoring playground — `/admin/applications`, `/admin/applications/:id/score[/dry-run]`, `/admin/applications/:id/decision`
- Collections cases queue — _needs new endpoints_
- Merchants onboarding — `/admin/merchants` CRUD + transition + paystack-recipient
- Customers — `/admin/customers` CRUD + KYC/ghana-card/momo/consent/blocklist
- Plan template editor — `/admin/plan-templates`
- Manual payment / refund / write-off — `/admin/installments/:id/record-payment`, `/refund`, `/admin/plans/:id/default`
- Telco health — `GET /admin/telco-health`
- Users & roles — `/admin/users/*`

## Running locally

```bash
pnpm install
cp .env.example .env            # backend; sets CORS_ORIGINS for the dev ports
pnpm db:up && pnpm db:reset && pnpm db:seed:dev
pnpm dev:api                    # API on :3000
# each app: cp apps/<x>-web/.env.example apps/<x>-web/.env  (VITE_API_BASE_URL)
pnpm dev:customer               # :5173    pnpm dev:merchant  :5174    pnpm dev:admin  :5175
pnpm dev:web                    # all three frontends together
```

## Known issues

**Customer-app API gaps worth closing**

- **No public customer signup.** OTP login only authenticates a pre-provisioned `users` row, so a brand-new shopper cannot self-register — customers must be created in the admin console first.
- **Browsing is search-only.** `GET /storefront/search` requires a non-empty `q`; there is no public "list products in category", so the home screen searches by category name instead of listing.
- **Cart lines carry no product title** (`variant_id` + price only) and there is no public variant→product lookup. The app caches labels locally when an item is added (`lib/variant-cache.ts`) and degrades to "Item" for carts built elsewhere. Denormalising a title/image onto the cart line, or adding a variant lookup, would fix it properly.
- **Local `.env` blocks API boot after the engine work.** The new validation refuses `SMS_PROVIDER=hubtel` with blank credentials; set `SMS_PROVIDER=console` for dev (as `.env.example` does).

- **CRLF drift:** the repo has no `.gitattributes`, so a Windows checkout gets
  CRLF and `pnpm format:check` flags pre-existing files locally (CI on Linux is
  green). Adding `.gitattributes` with `* text=auto eol=lf` would fix it
  repo-wide (separate, large renormalization — do deliberately).
