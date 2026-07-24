# Installment Payment Engine — Development Plan

> **Project:** Reusable installment payment engine for the Ghanaian / West African e-commerce market
> **Owner:** Mr. Francis Anlimah · Nesisoft
> **Stack:** Node.js (NestJS) · React · PostgreSQL 16 · Redis 7 · Paystack
> **Strategic positioning:** Standalone microservice consumable by Ejua, Meko, Pharmacy POS, and future Nesisoft products

---

> ⚠️ **Scope update (post-Phase 10).** This document stays the canonical record for the **installment engine** — Phases 1–10, now merged to `main`. The project has since expanded into a **marketplace built on the engine**: Expo mobile apps for buyers and sellers, plus a commerce layer (catalog · cart · internal orders · fulfilment) that the engine powers unchanged. For the current direction and Phases 11+, see **[`PLATFORM-ROADMAP.md`](./PLATFORM-ROADMAP.md)** and the design docs **[`design/commerce-domain.md`](./design/commerce-domain.md)** and **[`design/mobile-apps.md`](./design/mobile-apps.md)**. Where this document and the roadmap differ — e.g. React-web vs **Expo-mobile** customer/merchant apps — **the roadmap wins.**

## 1. Reference Documents

This plan assumes the following design artifacts are in the repository under `/docs/design/`. Each was produced during the architecture phase and should be treated as the canonical source for its respective concern.

### Diagrams (HTML, render in browser)

| File | What it covers |
|---|---|
| `installment-architecture.html` | Six-layer system architecture: clients, edge, core modules, async workers, persistence, external integrations |
| `installment-state-machine.html` | 12-state installment lifecycle with all legal transitions and guards |
| `installment-scoring-engine.html` | Signal collectors, three-stage rules engine, decision outcomes |
| `installment-momo-flow.html` | Paystack MoMo charge flow, retry policy, fallback to payment link, verification polling |
| `installment-settlement-flow.html` | Per-model payout timing, internal ledger structure, settlement worker steps, reserve release rules |

### Reference Code (TypeScript, drop into NestJS modules)

| File | What it covers |
|---|---|
| `installment-schedule.state-machine.ts` | Hand-rolled state machine with transition table, `ScheduleStateService.applyEvent`, Redis lock + DB transaction pattern |
| `scoring-engine.ts` | `FeatureVector` interface, `ScoringEngine.score()` pure function, rules-as-data pattern, signal collector pattern |
| `momo-payment-orchestrator.ts` | Retry policy, failure classification, debit attempt orchestration, webhook handler, verification poll |
| `settlement-engine.ts` | `PayoutCalculator`, `LedgerService` double-entry enforcement, `SettlementWorker`, reserve release policies, default handling |

### Database

| File | What it covers |
|---|---|
| `0001_installment_engine_init.sql` | 20-table initial schema, append-only triggers, partial indexes aligned with worker queries, double-entry invariants |

---

## 2. Guiding Principles

These should govern every implementation decision. Refer back when in doubt.

1. **Money is sacred.** All amounts as `BIGINT` pesewas (GHS × 100). Never floats. Use `Decimal.js` for intermediate math; round to pesewas at the end with `ROUND_HALF_UP`.

2. **Idempotency everywhere.** Every mutating endpoint accepts an idempotency key. Every Paystack call uses a deterministic reference. Every webhook deduplicates on `provider_event_id`.

3. **Double-entry ledger is the only source of financial truth.** Sums of debits must equal sums of credits per `transaction_id`, always. `LedgerService.record()` throws if unbalanced.

4. **State changes flow through the state machine.** No code outside `ScheduleStateService.applyEvent()` may update `installment_schedule.status`. The audit row is in the same transaction as the state change.

5. **Workers are separate processes.** Same codebase, different entry point. A slow Paystack call must never degrade the checkout API.

6. **Append-only is enforced at the DB level.** `credit_profiles`, `ledger_entries`, `audit_events` reject UPDATE/DELETE via trigger.

7. **Trust no webhook alone.** Every `pay_offline` response schedules a verification poll. Two paths to truth, one decisive outcome.

8. **Modular monolith first, extraction later.** All modules deploy as one NestJS app. Module boundaries are real (clean DI seams); extraction is a refactor, not a rewrite.

9. **System actors use sentinel UUIDs.** During Phases 1–2 the `users` table does not yet exist, but `audit_events.actor_id`, `collections_cases.assigned_agent_id`, `collections_actions.performed_by`, and similar columns still need values. Use a fixed set of well-known UUIDs (`00000000-0000-0000-0000-00000000000X`) for system, scheduler, debit worker, webhook, reconciler, and collections bot. When the `users` table arrives in Phase 3, seed it with these exact IDs and only then add FK constraints. This means no schema rewrites, no data backfills, and tests look identical before and after. See Section 4.1 below for the canonical list.

---

## 3.1. System Actor Sentinels

The following UUIDs are reserved across the entire codebase. They appear in `actor_id` columns during Phases 1–2 (before the `users` table exists) and are seeded into `users` in Phase 3.

| Constant | UUID | Used by |
|---|---|---|
| `SYSTEM` | `00000000-0000-0000-0000-000000000001` | Catch-all for actions with no specific worker |
| `SCHEDULER` | `00000000-0000-0000-0000-000000000002` | The hourly Debit Scheduler |
| `DEBIT_WORKER` | `00000000-0000-0000-0000-000000000003` | The Debit Worker (calls Paystack) |
| `WEBHOOK` | `00000000-0000-0000-0000-000000000004` | Paystack webhook handler |
| `RECONCILER` | `00000000-0000-0000-0000-000000000005` | Nightly reconciliation worker |
| `COLLECTIONS_BOT` | `00000000-0000-0000-0000-000000000006` | Automated collections escalation worker |
| `SETTLEMENT_WORKER` | `00000000-0000-0000-0000-000000000007` | Daily merchant settlement worker |
| `VERIFY_WORKER` | `00000000-0000-0000-0000-000000000008` | MoMo verification poll worker |
| `NOTIFICATION_WORKER` | `00000000-0000-0000-0000-000000000009` | SMS / email dispatcher |
| `SEED_ADMIN` | `00000000-0000-0000-0000-000000000099` | Dev / test fixture admin (not used in production) |

These values live in `packages/core/src/shared/constants/system-actors.ts` and are imported everywhere an actor identity is recorded. The reserved range `00000000-0000-0000-0000-00000000XXXX` is set aside for future system actors — never use this range for real users.

**Test fixtures** for simulated humans use a different reserved range:

| Constant | UUID | Used by |
|---|---|---|
| `FIXTURE_ADMIN_JANE` | `aaaaaaaa-aaaa-aaaa-aaaa-000000000001` | Tests simulating an admin user |
| `FIXTURE_AGENT_KOFI` | `aaaaaaaa-aaaa-aaaa-aaaa-000000000002` | Tests simulating a collections agent |
| `FIXTURE_CUSTOMER_AMA` | `aaaaaaaa-aaaa-aaaa-aaaa-000000000003` | Tests simulating a customer-initiated action |

The `aaaaaaaa-...` prefix makes it obvious in logs and test failures that you're looking at a fixture, not a real user or system actor.

---

## 3. Repository Structure

```
installment-engine/
├── docs/
│   ├── design/                      # The diagrams + reference code referenced above
│   │   ├── installment-architecture.html
│   │   ├── installment-state-machine.html
│   │   ├── installment-scoring-engine.html
│   │   ├── installment-momo-flow.html
│   │   ├── installment-settlement-flow.html
│   │   ├── installment-schedule.state-machine.ts
│   │   ├── scoring-engine.ts
│   │   ├── momo-payment-orchestrator.ts
│   │   └── settlement-engine.ts
│   ├── adr/                         # Architecture Decision Records
│   └── api/                         # OpenAPI specs
├── apps/
│   ├── api/                         # NestJS HTTP entry point
│   ├── workers/                     # BullMQ worker entry points
│   ├── customer-web/                # ⌫ superseded → apps/customer-mobile (Expo)  [roadmap P14]
│   ├── merchant-web/                # ⌫ superseded → apps/merchant-mobile (Expo)  [roadmap P15]
│   └── admin-web/                   # React admin / ops console                    [roadmap P16]
├── packages/
│   ├── core/                        # Shared domain modules (the modular monolith)
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── plans/
│   │   │   │   ├── applications/
│   │   │   │   ├── scoring/
│   │   │   │   ├── schedules/
│   │   │   │   ├── payments/
│   │   │   │   ├── settlements/
│   │   │   │   ├── collections/
│   │   │   │   ├── notifications/
│   │   │   │   ├── merchants/
│   │   │   │   ├── customers/
│   │   │   │   ├── employers/
│   │   │   │   ├── audit/
│   │   │   │   └── webhooks/
│   │   │   └── shared/
│   │   │       ├── drizzle/
│   │   │       ├── redis/
│   │   │       ├── lock/
│   │   │       ├── event-bus/
│   │   │       └── money/
│   ├── db/                          # Drizzle schema, migrations
│   ├── paystack-client/             # Typed Paystack SDK wrapper
│   ├── sms-client/                  # Hubtel / Arkesel wrapper
│   ├── ui/                          # Shared shadcn/ui components for React apps
│   └── api-types/                   # Shared TS types between backend and frontends
├── infra/
│   ├── docker/
│   ├── nginx/
│   └── observability/
├── scripts/
├── package.json                     # pnpm workspaces
├── turbo.json                       # Turborepo for builds
└── README.md
```

**Why monorepo?** Shared types between backend (NestJS) and frontends (React), single CI pipeline, atomic refactors across services. pnpm + Turborepo is the standard combo.

---

## 4. Development Phases

The plan is divided into 10 phases. Each phase is independently shippable and adds verifiable value. The order goes infrastructure → domain → integration → UX → operations → polish.

Time estimates assume a focused single developer (Mr. Anlimah) working with Claude Code. Adjust if pair or team work.

---

### Phase 1 — Foundation & Repo Bootstrap

**Goal:** Empty-but-correct repo. Anyone can `pnpm install && pnpm dev` and get a running API + DB.

**Deliverables:**
- Monorepo set up with pnpm workspaces + Turborepo
- NestJS API skeleton in `apps/api/`
- Drizzle ORM config + first migration runner (use the `0001_installment_engine_init.sql` file)
- PostgreSQL 16 + Redis 7 via docker-compose
- ESLint + Prettier + Husky + lint-staged
- Vitest configured for unit tests
- Basic CI: GitHub Actions running lint + typecheck + test on every PR
- README with local setup instructions

**Tasks:**
1. `pnpm init` workspace, create the folder structure above
2. Install NestJS, Drizzle, BullMQ, Zod, Decimal.js, Pino, Sentry SDK
3. Set up docker-compose with Postgres, Redis, pgAdmin
4. Convert `0001_installment_engine_init.sql` into a Drizzle migration; run it; verify all 20 tables exist
5. Generate Drizzle schema files from the migrated DB (`drizzle-kit introspect:pg`)
6. Wire up a `/health` endpoint that pings DB + Redis
7. Configure structured logging with Pino + Sentry error reporting
8. Add `.env.example` with all required environment variables documented

**Files to reference:**
- `0001_installment_engine_init.sql` (run as initial migration)

**Definition of done:**
- `pnpm dev` boots API on :3000, workers idle, DB and Redis healthy
- `pnpm test` runs (even if empty)
- `pnpm migrate` applies the initial migration cleanly
- `pnpm db:reset` drops and reapplies for clean test state

---

### Phase 2 — Core Shared Infrastructure

**Goal:** The cross-cutting plumbing every module will depend on. Build once, use everywhere.

**Deliverables:**
- `Money` value object (pesewas-only, Decimal-backed math)
- `LedgerService` with double-entry enforcement
- `RedisLock` distributed lock helper
- `EventBus` for after-commit domain events
- `AuditLogger` (writes to `audit_events` inside the caller's transaction)
- `IdempotencyService` (request-level dedup using the `idempotency_keys` table)
- `SystemActors` constants module (sentinel UUIDs for workers, scheduler, webhook handler — see Section 3.1)
- `FixtureUsers` constants module for tests
- Custom Zod validators for Ghana-specific data (phone numbers, Ghana Card numbers, MoMo provider codes)
- A typed `PaystackClient` wrapper in `packages/paystack-client/`
- A typed `SmsClient` abstraction with Hubtel + Arkesel adapters

**Tasks:**
1. Create `packages/core/src/shared/money/` with `Money` class (operations: `add`, `subtract`, `multiplyBps`, `format`)
2. Create `packages/core/src/shared/constants/system-actors.ts` with the sentinel UUIDs from Section 3.1 — every worker, scheduler, and webhook handler imports from here for its `actor_id`
3. Create `packages/core/src/shared/test-fixtures/users.ts` with the `FIXTURE_*` UUIDs for tests that simulate human actors
4. Build `LedgerService` (port from `settlement-engine.ts`)
5. Build `RedisLock` with `withLock(key, opts, fn)` API
6. Build `EventBus` with `publish(event, payload)` + `tx.afterCommit(fn)` hook
7. Build `AuditLogger` that takes a Drizzle transaction and appends to `audit_events`
8. Build `IdempotencyService` with `wrap(key, requestHash, handler)` middleware
9. Build `PaystackClient` with methods: `chargeMobileMoney`, `chargeCard`, `verifyTransaction`, `createPaymentLink`, `initiateTransfer`, `verifyTransfer`, `verifySignature`
10. Write unit tests for everything in this phase — these are the foundation, they must be rock-solid

**Files to reference:**
- `settlement-engine.ts` (LedgerService implementation pattern)
- `momo-payment-orchestrator.ts` (PaystackClient method signatures)
- `installment-architecture.html` (which infra components belong where)
- Section 3.1 of this plan (canonical list of system actor UUIDs)

**Definition of done:**
- All shared services have ≥90% test coverage
- `LedgerService.record()` throws on unbalanced transactions (tested)
- `RedisLock` releases on exception (tested with a deliberate throw)
- `PaystackClient.verifySignature` validates a known-good signature (use Paystack's sample)
- `SystemActors` module exports type-safe constants that ESLint can detect misuse of (no raw UUIDs scattered through worker code)

---

### Phase 3 — Domain Foundations

**Goal:** Customers, merchants, plan templates exist and can be created/edited. Pre-financial entities.

**Deliverables:**
- `merchants` module: CRUD, status lifecycle, Paystack recipient code attachment
- `customers` module: registration, Ghana Card upload + verification (mock for now), KYC tier management
- `employers` + `customer_employment` modules: partnership creation, customer linkage, payroll consent capture
- `plan_templates` module: full CRUD via admin endpoints, eligibility rules, effective dating
- Authentication and RBAC for staff (admin console users)
- Auth for customers (phone + OTP) and merchants (email + password)

**Tasks:**
1. Build `merchants` module with full CRUD and a state-machine-style status field
2. Build `customers` module; integrate with S3-compatible storage for Ghana Card images
3. Stub Ghana Card verification as a service interface (real implementation in a later phase)
4. Build `employers` and `customer_employment` modules
5. Build `plan_templates` module with validation (max_amount > min_amount, etc.)
6. Write migration `0002_users_and_rbac.sql`:
   - Create `users` table with `id`, `email`, `name`, `role`, `is_active`, timestamps
   - **Seed the system actor rows first** using the sentinel UUIDs from Section 3.1 (SYSTEM, SCHEDULER, DEBIT_WORKER, etc.) — these are non-deletable rows representing system identities
   - Seed dev-only fixture users in non-production environments (`SEED_ADMIN` and the `FIXTURE_*` IDs)
   - **Verify no orphan actor_ids exist** before adding FKs — run a sanity check query that ensures every value in `collections_cases.assigned_agent_id`, `collections_actions.performed_by`, etc. matches a row in `users`
   - Add FK constraints to `collections_cases.assigned_agent_id`, `collections_actions.performed_by`, and any other columns that should point at real users (with `ON DELETE SET NULL` for audit columns where history should survive user deletion)
   - **Do NOT add FK on `audit_events.actor_id`** — that column is TEXT and intentionally holds non-UUID actors like `"paystack"` for webhooks
7. Implement JWT-based auth with refresh tokens
8. Implement phone+OTP for customers using the `SmsClient`
9. Implement merchant login (email + password with bcrypt)
10. Add RBAC: roles + permissions table, guard decorators for admin endpoints

**Files to reference:**
- `installment-architecture.html` (which modules talk to what)
- `0001_installment_engine_init.sql` (tables 1-4 plus future users table)
- Section 3.1 of this plan (system actor UUIDs to seed into `users`)

**Definition of done:**
- Can create a merchant via API, transition them to `active`
- Can register a customer end-to-end including OTP verification
- Can create a plan template that passes all CHECK constraints
- All endpoints documented in OpenAPI

---

### Phase 4 — Scoring Engine

**Goal:** Submit an application, get a decision. No actual money yet, just the gate.

**Deliverables:**
- `applications` module: submission, expiry, counter-offer acceptance
- `scoring` module: full implementation of the three-stage engine
- Six signal collector services (Identity, Repayment, Behavior, Tenure, Employment, Exposure)
- `credit_profiles` immutable decision log
- Admin endpoint to view a scoring decision with full rule breakdown
- Endpoint to dry-run a scoring decision (for testing rule changes without persisting)

**Tasks:**
1. Build `applications` module with the lifecycle states from the schema
2. Port `scoring-engine.ts` into `modules/scoring/`; the `ScoringEngine` class is a pure provider
3. Build the six collector services. Stub external data sources (Paystack txn history, etc.) behind interfaces — fill in real implementations later
4. Wire collectors to run in parallel via `Promise.allSettled` with fail-soft defaults
5. Implement the `ScoringService` orchestrator that calls collectors, runs the engine, and persists to `credit_profiles`
6. Build the admin "decision details" endpoint that returns the rules-fired breakdown
7. Add the rule definitions loader that reads from `rule_definitions` table for hot-reload
8. Write exhaustive unit tests for `ScoringEngine.score()` with synthetic feature vectors
9. Write a "scoring playground" admin UI screen that lets ops tweak inputs and see outcomes

**Files to reference:**
- `scoring-engine.ts` (drop-in implementation)
- `installment-scoring-engine.html` (architecture for stakeholder review)
- `0001_installment_engine_init.sql` (applications, credit_profiles, rule_definitions tables)

**Definition of done:**
- Can submit an application, get a decision in <500ms
- Decision is reproducible: same features + same ruleset version → identical score
- Hard gates trigger declines correctly
- Counter-offer outcomes return a sensible counter
- All rule logic ≥95% covered by tests
- A decision can be re-scored against a new ruleset version without changing the original `credit_profiles` row

---

### Phase 5 — Schedules & State Machine

**Goal:** Approved applications generate installment schedules. The state machine moves them correctly.

**Deliverables:**
- `schedules` module: generation from approved plans
- `ScheduleStateService` with the full transition table
- Per-business-model schedule generation logic (BNPL, layaway, hybrid, rent-to-own all generate differently)
- `customer_plans` lifecycle management (approval → active → completed/defaulted)
- Manual payment recording endpoint (admin can mark an installment paid out-of-band)
- Customer self-service: view upcoming payments, pay early

**Tasks:**
1. Port `installment-schedule.state-machine.ts` into `modules/schedules/`
2. Build `ScheduleGenerator` service with per-model logic (this is non-trivial — read the settlement diagram carefully)
3. Build `customer_plans` module with the lifecycle hooks
4. Wire approval → schedule generation as an after-commit event handler
5. Build manual payment recording endpoint with admin auth + idempotency
6. Build customer endpoints: `GET /me/plans`, `GET /me/plans/:id/schedule`, `POST /me/plans/:id/pay-early`
7. Add an Excel/PDF statement generator that takes a plan and produces a customer-facing statement (use ReportLab pattern from prior IWC work for the PDF if helpful)
8. Write integration tests that walk a plan from creation through full payoff

**Files to reference:**
- `installment-schedule.state-machine.ts` (drop-in)
- `installment-state-machine.html` (transition diagram)
- `installment-settlement-flow.html` (Section 1 — per-model payout timing affects schedule generation)
- `0001_installment_engine_init.sql` (customer_plans, installment_schedule tables)

**Definition of done:**
- Approving a BNPL plan generates 4 weekly installments
- Approving a hybrid plan generates a down-payment row + 3 monthly installments
- Manual payment transitions schedule status correctly + writes audit row
- Customer can see "GHS 300 due Friday" on their dashboard
- State machine rejects illegal transitions (tested)

---

### Phase 6 — Paystack Integration (Card Charges First)

**Goal:** Real money moves. Card charges work end-to-end before tackling MoMo's async dance.

**Why card first?** Card responses are synchronous. The webhook still confirms, but the happy path is much simpler than MoMo. Get the orchestration scaffolding right with the easier integration, then layer MoMo on top.

**Deliverables:**
- `payments` module: charge orchestration, attempt logging
- `webhooks` module: Paystack signature verification, event dispatch, idempotency
- Card charge flow: customer enters details (Paystack Inline JS), backend charges via Paystack
- Successful charge transitions schedule to `paid`, generates receipt, fires domain event
- Failed charge triggers retry classification (`scoring-engine`'s pattern reused)
- Refund endpoint: admin-initiated, debits revenue/reserve, transitions schedule to `refunded`

**Tasks:**
1. Build the `payments` module with `PaymentService` and `AttemptRepository`
2. Build the `webhooks` module with the Paystack controller from `momo-payment-orchestrator.ts`
3. Implement card charge via Paystack Standard Inline (frontend) + transaction verify (backend)
4. Hook webhook events into `ScheduleStateService.applyEvent`
5. Implement the failure classifier (`classifyFailure` from `momo-payment-orchestrator.ts`)
6. Build receipt generation (HTML email + PDF attachment)
7. Implement refund flow with proper ledger entries
8. Set up Paystack test mode credentials in `.env`; verify against Paystack's test cards

**Files to reference:**
- `momo-payment-orchestrator.ts` (orchestrator pattern, webhook handler)
- `installment-momo-flow.html` (failure classification table)
- `installment-state-machine.html` (transitions triggered by webhooks)
- `0001_installment_engine_init.sql` (payment_attempts, webhook_events tables)

**Definition of done:**
- Test card charge succeeds end-to-end, schedule lands in `paid`
- Test card decline triggers retry flow correctly
- Webhook with bad signature is rejected
- Webhook replay (same `provider_event_id`) is a no-op
- Refund correctly reverses ledger entries

---

### Phase 7 — MoMo Charges with Retry & Fallback

**Goal:** Mobile Money works with all its async messiness handled correctly.

**Deliverables:**
- MoMo charge path through Paystack
- Pre-debit SMS notification (T-1h)
- Verification poll worker (15-min safety net)
- 4-attempt retry policy with exponential backoff
- Channel switch to payment link on attempt 4
- Telco-level outage detection (aggregate failure rate by provider)

**Tasks:**
1. Add MoMo provider configuration to `customers` (mtn/tgo/vod)
2. Extend `PaystackClient.chargeMobileMoney` from the existing orchestrator
3. Build the `DebitScheduler` BullMQ worker that runs hourly
4. Build the `DebitWorker` that consumes from the queue and calls Paystack
5. Build the `VerifyWorker` that polls Paystack's `/transaction/verify` for stuck attempts
6. Implement the retry policy table from `momo-payment-orchestrator.ts`
7. Build pre-debit notification via Notification module
8. Build payment-link generation for attempt 4
9. Build a "telco health monitor" service that pauses MTN/Telecel/AirtelTigo charges if failure rate spikes
10. End-to-end testing using Paystack's MoMo test phone numbers

**Files to reference:**
- `momo-payment-orchestrator.ts` (full reference implementation)
- `installment-momo-flow.html` (decision tree)
- `installment-state-machine.html` (retry-related transitions)

**Definition of done:**
- Test MoMo charge with "approve" outcome → schedule `paid`
- Test MoMo charge with "decline" → retry #1 scheduled at T+4h
- Verification poll resolves a stuck attempt correctly
- 4 failed attempts → grace period → `overdue` transition
- Non-retryable decline (`invalid_account`) skips retries
- SMS notifications fire at correct cadence

---

### Phase 8 — Settlement & Reserve Engine

**Goal:** Merchants get paid. Reserves are held and released correctly. Books always balance.

**Deliverables:**
- `settlements` module with `PayoutCalculator`, `PayoutRecorder`, `SettlementWorker`
- `held_reserves` lifecycle: hold on accrual, release per policy, consume on default
- Daily settlement batch job
- Merchant dashboard showing pending, settled, reserved, defaulted amounts
- Default-handling logic per business model
- Monthly merchant statement (PDF) showing all activity + reserve releases

**Tasks:**
1. Port `settlement-engine.ts` into `modules/settlements/`
2. Wire `PayoutRecorder` to fire on the right events (order_approved, down_payment_received, plan_completed)
3. Build the daily `SettlementWorker` as a BullMQ scheduled job
4. Implement the three reserve release policies (after_completion, after_delivery, rolling_monthly)
5. Implement default handling per model (BNPL absorbs, hybrid/RTO claws back from reserve)
6. Build merchant dashboard endpoints: pending payouts, settlement history, reserve balance
7. Build merchant monthly statement PDF generator
8. Reconciliation worker: nightly cross-check of `ledger_entries` totals against Paystack settlement reports

**Files to reference:**
- `settlement-engine.ts` (drop-in)
- `installment-settlement-flow.html` (all four sections)
- `0001_installment_engine_init.sql` (ledger_entries, payouts, held_reserves tables)

**Definition of done:**
- BNPL plan completes → merchant payable accrues correctly with MDR + reserve deducted
- Daily settlement batch transfers net payable to merchant via Paystack
- Reserve releases on schedule after the policy's buffer
- Default on hybrid plan claws back from reserve, then merchant_payable if needed
- `LedgerService.balanceOf` totals tie out to actual money movements
- A merchant can download a monthly statement showing every cedi

---

### Phase 9 — Collections Workflow

**Goal:** Overdue installments get systematic follow-up. Agents have a queue. Customers can restructure.

**Deliverables:**
- `collections` module with case management
- Automated stage escalation (soft reminder → firm reminder → restriction → agent → field visit)
- Agent assignment + workload balancing
- Restructure workflow (customer requests → admin approves → new plan generated)
- Write-off process
- Collections dashboard for ops staff

**Tasks:**
1. Build `collections` module with cases, actions, stage transitions
2. Implement `CollectionsWorker` that picks up `overdue` schedules and progresses cases
3. Build agent management (extension of users module)
4. Build restructure flow: customer-initiated request → admin review → plan-replacement event
5. Build the admin collections queue UI: cases by stage, assignment, action recording
6. Build write-off endpoint that handles the ledger correctly (debits default pool)
7. Integration with SMS/email templates for each escalation stage
8. Build "collections KPIs" dashboard for executive view

**Files to reference:**
- `installment-state-machine.html` (collections-related transitions)
- `installment-architecture.html` (Collections module placement)
- `0001_installment_engine_init.sql` (collections_cases, collections_actions tables)

**Definition of done:**
- Overdue schedule automatically opens a case
- SMS reminders fire at correct stage cadence
- Restructure approval replaces the old plan and generates a new schedule
- Write-off transitions schedule to `defaulted` and books default-pool entry correctly
- Ops staff can view, assign, and act on cases via UI

---

### Phase 10 — Frontends, Polish & Launch Prep

> **Superseded — see [`PLATFORM-ROADMAP.md`](./PLATFORM-ROADMAP.md) Phases 14–16.** The frontends are now **Expo mobile** apps for customer & merchant (admin stays React web), and they consume a new commerce layer, not just the engine. The observability / rate-limiting / pilot items below still apply and are folded into roadmap Phase 16.

**Goal:** Three React apps are usable. System is observable. Real merchants can onboard.

**Deliverables:**
- Customer web app (`apps/customer-web/`)
- Merchant dashboard (`apps/merchant-web/`)
- Admin / ops console (`apps/admin-web/`)
- OpenAPI spec auto-generated and published
- Observability stack (Sentry, structured logs, basic Grafana dashboards)
- Rate limiting on public endpoints
- Documentation: API docs for product integrators, runbooks for ops
- Soft launch with one pilot merchant

**Tasks:**
1. Build customer app with Vite + React + TanStack Query + Tailwind + shadcn/ui
   - Onboarding (phone + OTP + Ghana Card upload)
   - Checkout plan selector with live calculator
   - Plans dashboard (upcoming, history, pay-early, restructure-request)
2. Build merchant app
   - Order list with installment plan status per order
   - Settlement dashboard (pending, settled, reserved)
   - Plan template configuration
   - Statement downloads
3. Build admin/ops app
   - Application review queue
   - Collections cases queue
   - Scoring playground
   - Plan template editor
   - Merchant onboarding workflow
   - Manual payment recording
4. Wire up Sentry for error tracking across all apps
5. Set up centralized logging (ship Pino logs to a sink — start with self-hosted Loki or Better Stack)
6. Add API rate limiting (Redis-backed token bucket per IP and per API key)
7. Write the integration guide for product partners (Ejua, Meko, etc.)
8. Write the ops runbook (common issues, escalation paths)
9. Pilot merchant onboarding + first real transactions in test mode

**Files to reference:**
- `installment-architecture.html` (frontend → API → modules wiring)
- All other diagrams (use as the basis for in-app documentation and merchant-facing materials)

**Definition of done:**
- All three frontends deployed to staging
- A customer can complete a full BNPL purchase end-to-end with real Paystack test credentials
- A merchant can see the order, watch the schedule progress, and download a statement
- Ops can monitor the system via dashboards
- One pilot merchant has signed an MoU and made first test transactions

---

## 5. Cross-Cutting Workstreams

These run in parallel to the phases above. Don't defer them to "later."

### Security
- Secrets management via Vault or AWS Parameter Store (never `.env` in production)
- All Paystack credentials, JWT signing keys, DB passwords rotated quarterly
- Threat model document covering: stolen credentials, replay attacks, double-charge attempts, refund fraud, internal abuse
- Annual third-party security review before public launch

### Compliance
- Ghana Data Protection Act registration with the Data Protection Commission
- Customer consent flows for data processing, credit scoring, marketing (separate opt-ins)
- Bank of Ghana consultation about whether the platform requires a non-bank financial institution license (this is a real question; consult a Ghanaian financial-services lawyer before any public launch with real customer credit)
- Data retention policies documented and enforced

### Testing Strategy
- Unit tests: business logic (scoring, payout math, state machine) — target ≥90%
- Integration tests: module boundaries, especially state-machine + ledger
- E2E tests: critical user flows (apply → approved → first payment → completion)
- Load tests: simulate 1000 concurrent debit attempts to verify worker scaling
- Chaos tests: kill Paystack mid-call, kill workers mid-batch, verify recovery

### Observability
- Sentry for errors
- Structured logs with correlation IDs (every request gets one; propagated to workers)
- Metrics: per-endpoint latency, per-worker throughput, queue depth, error rates, settlement totals
- Alerts: settlement worker hasn't run in >25h, queue depth >1000, error rate >1%, Paystack 5xx rate >5% over 5 min

### Documentation
- ADRs (Architecture Decision Records) for every non-obvious decision
- API docs auto-generated from OpenAPI
- Runbooks: "Paystack is down," "Worker is backed up," "Ledger imbalance detected"
- Onboarding docs for new developers and ops staff

---

## 6. Estimated Timeline

Assuming Mr. Anlimah works on this with Claude Code as the primary tool, here's a realistic single-developer timeline. Add buffer for context switching with other Nesisoft work.

| Phase | Effort (focused weeks) | Cumulative |
|---|---|---|
| 1. Foundation & Repo Bootstrap | 1 | 1 |
| 2. Core Shared Infrastructure | 2 | 3 |
| 3. Domain Foundations | 2 | 5 |
| 4. Scoring Engine | 2 | 7 |
| 5. Schedules & State Machine | 2 | 9 |
| 6. Paystack Card Integration | 1.5 | 10.5 |
| 7. MoMo Charges with Retry & Fallback | 2 | 12.5 |
| 8. Settlement & Reserve Engine | 2 | 14.5 |
| 9. Collections Workflow | 1.5 | 16 |
| 10. Frontends, Polish & Launch Prep | 4 | 20 |

**Total: ~20 focused weeks** (about 5 months at full-time).

In practice, working alongside other Nesisoft commitments, plan for **6–8 months to a pilot launch**.

---

## 7. First Sprint — Immediate Next Steps

If starting today with Claude Code:

1. **Set up the repository** (Phase 1 tasks 1-3) — get pnpm workspaces + NestJS + Drizzle + docker-compose running in one session
2. **Run the SQL migration** — use `0001_installment_engine_init.sql` as the initial migration
3. **Generate Drizzle schema** from the migrated DB via `drizzle-kit introspect`
4. **Build the `Money` value object** — small, well-tested, the foundation for everything else
5. **Build `LedgerService`** — also small, with the double-entry invariant test as the first failing test

Five concrete tasks. Each shippable in one Claude Code session. By the end of week 1 you have a running API connected to a migrated DB with the core money primitives in place.

---

## 8. Risks & Open Questions

These deserve real conversations before too much code gets written.

**Bank of Ghana licensing.** Is the platform "providing credit" or "facilitating deferred merchant settlement"? The answer materially affects whether you need an NBFI license. Get a written opinion from a Ghanaian financial services lawyer before any public launch.

**Paystack contractual relationship.** Confirm Paystack permits the BNPL/installment use case under their merchant agreement. Some processors restrict aggregation/lending-adjacent flows.

**Reserve account custody.** Where does reserve money physically sit? Same bank account as your settlements (commingled), or a separate trust account? Commingled is operationally simpler but creates regulatory exposure if you scale.

**Default-pool capitalization.** How much capital do you commit to absorb BNPL defaults? Industry rule of thumb: 3-5% of total outstanding portfolio. Need a funding plan before BNPL scales.

**Merchant onboarding bottleneck.** KYC + risk review + Paystack recipient setup is a manual process per merchant. Will become the growth bottleneck. Plan ops staffing accordingly.

**Customer credit data sharing.** Ghana doesn't have a mature consumer credit bureau yet. You're building proprietary credit data with every customer interaction. Decide early: is this a moat to protect, or an asset to share with other lenders to improve industry-wide underwriting?

---

## 9. Success Metrics

How you'll know it's working.

**Technical health**
- 99.5% API uptime
- p95 checkout response time <800ms
- Daily settlement worker completes in <30 min for 1000 merchants
- Zero ledger imbalances detected by reconciliation
- Zero double-charges (verified by attempt log analysis)

**Business health**
- Default rate <8% on BNPL portfolio (industry norm 6-12%)
- 30-day on-time payment rate ≥85%
- Average net revenue per plan ≥4% of order value
- Merchant churn <5% per quarter post-onboarding
- Customer NPS ≥40

**Strategic health**
- ≥1 other Nesisoft product (Ejua, Meko, Pharmacy) consuming the engine within 6 months of launch
- ≥3 external pilot merchants in months 6-12
- A clean engineering hand-off doc that a new senior engineer can productively use within a week

---

## 10. Working with Claude Code

A few notes for the Claude Code workflow specifically.

**Use the diagrams as input.** Before starting a phase, open the relevant `.html` file in your browser and have Claude Code reference the corresponding TypeScript file. Example: "Read `momo-payment-orchestrator.ts` and `installment-momo-flow.html`. Now implement the MoMo charge endpoint in `apps/api/src/modules/payments/`."

**The TS reference files are not literal copy-paste.** They contain type stubs (`declare class PaystackClient`, etc.) and commented-out blocks showing the integration pattern. Adapt them to your actual NestJS module structure.

**Migrations are sacred.** Once `0001_installment_engine_init.sql` has been applied to a real database, **never edit it**. Add `0002_*.sql`, `0003_*.sql` for changes. Drizzle-kit can generate these from schema diffs, or write them by hand.

**Tests come with the code, not after.** When asking Claude Code to build a feature, ask for the tests too. The scoring engine and ledger service especially need exhaustive tests — they're pure functions, so testing is cheap.

**ADRs for non-obvious decisions.** When you make a call that contradicts the reference design or that future-you might second-guess (e.g., "we're using XState after all" or "we switched from Drizzle to Prisma"), write a short ADR in `docs/adr/`. Format: context, decision, consequences. Three paragraphs is plenty.

---

## Appendix A — File Manifest

For Claude Code context, the complete list of artifacts to include with this plan:

```
docs/
├── DEVELOPMENT-PLAN.md             ← this file
└── design/
    ├── installment-architecture.html
    ├── installment-state-machine.html
    ├── installment-scoring-engine.html
    ├── installment-momo-flow.html
    ├── installment-settlement-flow.html
    ├── installment-schedule.state-machine.ts
    ├── scoring-engine.ts
    ├── momo-payment-orchestrator.ts
    ├── settlement-engine.ts
    └── 0001_installment_engine_init.sql
```

When prompting Claude Code, prefix critical sessions with: *"Refer to `docs/DEVELOPMENT-PLAN.md` for the overall architecture. The relevant design artifacts for this task are: [list]."*

---

*End of plan. Ship something.*
