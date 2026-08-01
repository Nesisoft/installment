<!-- Generated from a two-pass adversarial audit. See §1 for method and confidence. -->

# Installment Engine — Definitive Completion Plan

**Inputs:** 51 findings (permissive pass) + 37 findings (adversarial pass, 0 refuted). ~70 unique after dedupe. I independently re-verified the highest-leverage claims in this session by reading and **executing** code; corrections noted inline.

---

## 1. The true story

**The hard parts are done and done well. The easy parts are missing. That inversion is why the finding count looks worse than the engine is — and why the engine is still further from a pilot than the owner probably thinks.**

What is genuinely strong, and I checked all of it:

- **The schema is excellent and is ahead of the code.** Repeatedly, the DDL specifies machinery that was never written. `schedule_stuck_idx` (`0000_installment_engine_init.sql:420-422`) carries the literal comment _"Reconciliation worker — find stuck processing schedules"_ — there is no such worker. `payment_attempts_in_flight_idx` is built `WHERE status IN ('in_flight','unknown')` (`:477-478`) — the only consumer filters `in_flight` alone. `schedule_due_pickup_idx` includes `retry_scheduled` (`:417-418`) — no query ever selects it. `applications_pending_expiry_idx`, `customer_plans.restructured_from_plan_id`, the `refund_payable` ledger account, the `reversed` payout status: all declared, none reachable. **The migration file is a more complete specification of this engine than the TypeScript is.** That is unusual and it is good news — the remaining work is unusually well-defined.
- Double-entry ledger with `BEFORE UPDATE OR DELETE` immutability triggers, validate-before-insert, and writes that join the caller's transaction.
- State machine as data with optimistic `version` guards, `SELECT ... FOR UPDATE` in the right places (`collections.service.ts:131-133`, `recordManualPayment`), a tested `RedisLock` primitive.
- Ports/adapters discipline in `packages/core` (`SmsSender`, `RetryScheduler`, `TelcoHealthStore`, `ChargeReceiptNotifier`).
- Audit rows written inside the caller's transaction on every state change.
- Integer pesewas with explicit ROUND_HALF_UP.
- CI runs format → lint → typecheck → build → unit → integration against real Postgres and Redis.

What is actually broken, and the pattern is remarkably consistent:

> **The synchronous happy path works. Almost every asynchronous and exception path has a hole.**

Ghanaian MoMo is asynchronous by nature — `payment.service.ts:203-210` returns `pay_offline`, so the outcome of virtually every real charge arrives by **webhook**, not synchronously. And `WebhookService` is a second-class reimplementation of the sync path: it never runs the retry ladder (`webhook.service.ts:126-146` stops at `charge_failed`), and it silently swallows every success it cannot apply (`:148-165`). Meanwhile the state machine defines exactly one path to `paid` — `'processing:charge_succeeded'` (`state-machine.ts:52`) — so **every payment-link payment is thrown away**: `PaymentLinkDispatcher` leaves the schedule in `retry_scheduled` by design (`payment-link-dispatcher.ts:89-99`), and a success from that state is an illegal transition that gets swallowed. Customer pays, money moves, installment stays unpaid, dunning continues.

**My honest completion estimate:**

| Layer                                                                                   | Complete |
| --------------------------------------------------------------------------------------- | -------- |
| Engine core — ledger, state machine, money math, schema, scoring framework, RBAC, audit | ~85%     |
| Async / exception / recovery paths                                                      | ~40%     |
| Operational skin — deploy, observability, admin + merchant API, user lifecycle          | ~25%     |
| Regulatory posture — affordability, decision-of-record, PII, backup, SoD                | ~20%     |
| **As a launchable real-money pilot**                                                    | **~55%** |

Two more honest notes:

1. **A useful lens the finding count destroys: DEFECT vs GAP.** Roughly 22 findings are _defects_ (code actively does the wrong thing with money or state — urgent). Roughly 25 are _gaps_ (planned features never built — schedulable). Roughly 6 are _test/process_. Roughly 8 are _cosmetic_. Only the 22 are emergencies.
2. **0 refuted out of 88 across two passes is a flag on the review process, not a compliment to the codebase.** A healthy adversarial pass refutes 10-25%. Treat the corpus as **high confidence on existence**, **moderate confidence on severity calibration**. In this session I found exactly one finding whose arithmetic was wrong — and it was wrong in the optimistic direction (see §6, cold start).

---

## 2. Cross-corroboration — the strongest evidence available

Where two audits that never spoke to each other landed on the same underlying defect from different angles. These are the ones to trust without re-verification.

**A. The idempotency layer was designed, written, and never plugged in — six independent findings.**
Pass A found the double-debit (`ensureProcessing` no-op) and the ledger's read-then-write dedupe. Pass B found the advertised-but-absent `Idempotency-Key` header, the zero-consumer `IdempotencyService`, the never-enforced TTL, **and** the missing `UNIQUE` on `customer_plans.application_id`. All six are the same root: `grep -rn 'dempotenc' apps/api/src` returns exactly one line — `main.ts:47`, a CORS string. `IdempotencyService.wrap` is fully implemented at `idempotency.service.ts:66-105` and instantiated nowhere. `ledger_entries.transaction_id` is `CREATE INDEX`, not unique (`0000:525`). Every dedupe in the money path is a TOCTOU window.

**B. `retry_scheduled` is a black hole — five findings, plus the schema agrees.**
Pass A found it twice (as a payments defect and as a collections defect); pass B found it a third time. The corroborating detail neither pass emphasised enough: `schedule_due_pickup_idx` is partial on `status IN ('pending','due','retry_scheduled')`. **The index exists for a sweep that was never written.** `RetryWorker`'s own docstring (`retry.worker.ts:25`) says "the schedule stays in `retry_scheduled` for the grace-expiry worker to escalate" — and `escalateGraceExpired` filters `['due','failed']` (`collections.service.ts:116`). The code documents a contract it does not honour.

**C. The webhook is the real MoMo path and is treated as an afterthought — five findings across four audit areas.**
Payments found "failures never enter the retry ladder" and "success discarded when not `processing`." Observability found "untracked references dropped with no log." Payouts found "`transfer.*` unhandled." Testing found "no test for out-of-order webhooks." Four different reviewers, one defect: `webhook.service.ts` `dispatch` handles two event types and `idempotent()` swallows everything it cannot apply.

**D. The ledger has no cash-in leg and no uniqueness — six findings.**
Pass A: cash-in never booked; ledger idempotency advisory. Pass B: collections never recorded (verified exhaustively — `CustomerPlansService`'s constructor at `customer-plans.service.ts:56-75` does not even _take_ a `LedgerService`, so it structurally cannot book one); idempotency advisory again; no property test that the ledger balances globally. Observability: no drift detection. The clincher pass B found: `customer-plans.integration.spec.ts:478` **asserts** receivable is still `-100_000` after a plan is fully paid — the test pins the gap in place.

**E. Reserves are a one-way valve — four findings.**
Layaway never releases (both passes, independently). Defaults strand reserve. Refund clawback drives `reserve_held` negative. Three of four exit paths from `held_reserves` do not exist. `ReserveReleaseService.markDelivered` (`reserve-release.service.ts:114`) has exactly one caller repo-wide, and it is a spec file.

**F. SMS is a console stub — both passes, both graded blocker.**
`core.module.ts:94` is literally `{ provide: SMS_SENDER, useClass: ConsoleSmsSender }` with no factory and no branch. `@installment/sms-client` is a dependency of nothing. Customer auth is phone+OTP only, so **zero customers can log in**, and every issued OTP sits in plaintext in the log sink next to its phone number.

**G. Workers: single process, no election, no heartbeat, silently off — five findings.**
`ENABLE_SCHEDULED_WORKERS` defaults to `false` (`env.validation.ts:30-33`) and — I confirmed — **is absent from `.env.example` entirely**. Every cron is `if (!this.enabled) return;` with no log. `/health` probes only Postgres and Redis. An operator copying `.env.example` ships a lender that never debits, never settles, and shows green.

**H. Identity and credentials are a one-way door — four findings.**
No deactivate, no soft-delete, no role revoke, no password change (`UsersService` is create + read + `assignRole`). No logout, no refresh-token store. Production boots with `dev-access-secret-change-me!!`. And after a clean production migration there is no loginable staff user at all.

**I. The gates cannot verify the fixes — five findings, and this is the meta-finding.**
Integration specs run with Vitest file-parallelism against one shared DB with no `TRUNCATE`/`DELETE`/`beforeEach` anywhere; the sweeps under test are globally unscoped; **all three specs that construct a `RedisLock` pass a permanently-open stub**; `apps/api` has zero HTTP-layer tests despite `supertest` being installed. Two smoking guns that the pollution is already real: `settlement.service.ts:99-101` carries a **production** try/catch commented _"a stale non-UUID account_ref left by an earlier test"_, and `settlement.integration.spec.ts:242` weakens its own assertion with _"other merchants from prior tests already cleared."_

---

## 3. Work slices

Each is one reviewable PR that can land with green gates. Confidence: **Proven** = I verified it in this session; **High** = adversarially upheld with citations; **Moderate** = permissive pass only.

### TIER 0 — Money correctness (can lose or double-take money)

---

**S1 · One installment, one charge** — Effort **M** · Deps none · **Proven**

_Prevents:_ a customer is debited twice for the same installment — and today that is **unrecoverable**, because the refund path (S7) books entries but never returns money.

Build:

- **Pre-flight (do this first, ~1 hour):** round-trip a reference through the Paystack sandbox. `payment.service.ts:296-297` builds `INSTL-{scheduleId}-{scheduleId}:{n}` — it contains a `:` (outside Paystack's documented reference charset) and repeats the UUID, which is plainly unintentional. The payment-link path already uses a colon-free `LINK-{scheduleId}-{attempt}` (`payment-link-dispatcher.ts:70`). If Paystack rejects it, **no charge in this system has ever worked** and everything else is moot.
- Change to `INSTL-{scheduleId}-{attemptNumber}`; keep `{scheduleId}:{n}` as the internal `idempotency_key` only. Add a boundary guard in `PaystackClient` rejecting `!/^[A-Za-z0-9.=-]{1,100}$/`.
- `ensureProcessing` (`payment.service.ts:482-484`): replace `case 'processing': return;` with a throw. Today a retried POST against an installment already in `processing` reads a stale `attempt_count`, derives a _different_ key and reference, and issues a second live charge.
- Wrap `beginAttempt` → provider call in `RedisLock.withLock('schedule:{id}')` — the key `ScheduleStateService` already uses (`schedule-state.service.ts:52`).
- Reject a new attempt when any `in_flight`/`unknown` attempt exists for the schedule.
- `CREATE UNIQUE INDEX` on `customer_plans(application_id)` (`0000:322` has no constraint; `activateFromApplication` at `customer-plans.service.ts:154-160` is a bare check-then-insert at READ COMMITTED — a textbook phantom write that pays the merchant twice via `accrue:{planId}:order_approved`). Catch with the existing `isUniqueViolation` (`shared/db/pg-errors.ts:24-28`).
- **New integration spec using the real CI Redis lock**, not `new RedisLock(ALWAYS_OPEN)`.

_Files:_ `packages/core/src/modules/payments/{payment.service,attempt-repository}.ts`, `packages/paystack-client/src/client.ts`, `packages/core/src/modules/schedules/customer-plans.service.ts`, new `packages/db/drizzle/0007_*.sql`, new concurrency spec.

---

**S2 · Idempotency-Key at the HTTP boundary** — Effort **M** · Deps S1 · **Proven**

_Prevents:_ a customer on a flaky Ghanaian mobile connection taps "Pay" twice, or a client auto-retries a timed-out POST, and is charged twice.

Build: an `APP_INTERCEPTOR` keyed on `Idempotency-Key` + route + body hash over every money-mutating POST (`/me/installments/*/pay*`, `/admin/installments/*/record-payment`, `/admin/installments/*/refund`, `/admin/plans/from-application/*`, `/admin/settlements/*`). Register `IdempotencyService` + `DrizzleIdempotencyStore` in `core.module.ts` (`app.module.ts:82-89` has no `APP_INTERCEPTOR` at all). Enforce `expires_at` in `find()` (`drizzle-store.ts:24-35` filters on key alone). Reaper cron using the existing `idempotency_keys_expiry_idx` (`0000:710-713`). Reclaim rows abandoned with `response_status IS NULL`.

---

**S3 · Async completion parity — make the webhook first-class** — Effort **M** · Deps S1 · **Proven**

_Prevents:_ a customer pays a payment link (or their MoMo approval lands late) and the engine throws the outcome away — never credited, plan never completes, dunning continues against someone who has paid. This fires on **100% of payment-link payments**, not on a race.

Build:

- Extract a shared `ChargeOutcomeApplier` so `WebhookService.handleFailure` runs the full `afterFailure` pipeline — retry scheduling, failure SMS, telco recording — instead of stopping at `charge_failed` (`webhook.service.ts:126-146`).
- Add late-settlement transitions: `retry_scheduled | failed | overdue | in_collections : late_payment_received → paid`.
- Narrow `idempotent()` (`:148-165`) to swallow **only** "already `paid` with the same `provider_reference`." Everything else: log, `captureAlert`, and land in a manual-reconciliation queue.
- Guard against stale attempts: `findByProviderReference` (`attempt-repository.ts:87-91`) returns any attempt regardless of whether it is the schedule's current one, and `handleFailure`'s `if (attempt.status !== 'failed')` does not exclude `succeeded` — a late failure downgrades a settled attempt and can fail a live retry.
- Alert on the untracked-reference branch (`:100 if (!attempt) return;`) — Paystack is telling you a customer was debited.
- Tests: out-of-order webhook for a superseded attempt; payment-link success; late MoMo approval after verify timeout.

---

**S4 · Nothing gets stuck — sweepers for every non-terminal state** — Effort **M** · Deps S3 · **Proven/High**

_Prevents:_ debt goes invisible. An installment lands in `processing`, `unknown`, `retry_scheduled` or `pending` and no worker looks at it again — no retry, no escalation, no case, no default. Delinquency reporting systematically under-reports bad debt.

Build:

- `findStaleInFlight` → `inArray(status, ['in_flight','unknown'])`, matching the partial index already built for it.
- Stuck-schedule sweep over `status='processing' AND status_changed_at < now() - interval`, using `schedule_stuck_idx`.
- Add `retry_scheduled` and `pending` to `escalateGraceExpired` (`collections.service.ts:116`) with the matching transitions.
- Reaper for `retry_scheduled` past its policy delay — covers Redis eviction, workers-off windows, and BullMQ `attempts: 1` job loss (`bullmq-retry-scheduler.ts:33`).
- **Verify-poll budget:** `STALE_AFTER_MS` is 2 min (`verify-poll.cron.ts:11-12`) and `MAX_VERIFY_POLLS` is 2 (`retry-policy.ts:39`) → the engine gives up at ~10 min against a ~45 min design, classifies `timeout_no_resolution` as _retryable_, and issues a **fresh charge while the customer's original MoMo prompt is still live on their handset**. Raise the budget; on exhaustion park in `unknown` and alert — do not retry.
- Persist `payment_link_url` on the attempt row.
- Wire `ApplicationsService.expireOverdue` (`applications.service.ts:193`, zero callers) to a cron.

---

**S5 · The ledger tells the truth** — Effort **L** · Deps none · **Proven** · 🚩 **regulator**

_Prevents:_ you cannot produce a balance sheet, cannot reconcile against Paystack, and cannot detect a duplicate posting. An auditor asks for the trial balance and there isn't one. `DEVELOPMENT-PLAN.md:466` plans a nightly ledger-vs-Paystack cross-check that is **impossible** without this.

Build:

- Inject `LedgerService` into `CustomerPlansService` and book the cash-in leg in `finalisePaidInstallment`: DEBIT `paystack_settlement['main']`, CREDIT `receivable[plan]`. **Handle the layaway wrinkle:** no receivable exists at collection time (accrual only fires at completion, `customer-plans.service.ts:559-560`), so per-installment credits would drive receivable positive — use a `customer_float[plan]` holding account that closes out at completion.
- Real uniqueness on ledger transactions (`0000:525` is a plain index), so `payout-recorder.ts:80-85`, `default.service.ts:69-75`, `reverseAndFail` (`settlement.service.ts:380-425`, no check at all) and `releaseOne` (`reserve-release.service.ts:231-293`, no check at all) stop being TOCTOU windows.
- `LedgerIntegrityService.findUnbalancedTransactions()` + `trialBalance()`, hourly cron with `captureAlert`, `GET /admin/ledger/integrity`, and `docs/runbooks/ledger-imbalance.md` (`DEVELOPMENT-PLAN.md:604` requires it; `docs/` has no runbooks at all).
- Add `fast-check` and a property test that a randomised operation sequence leaves every `transaction_id` balanced. Today no spec performs any cross-transaction aggregate.
- Fix `confirmPayout` (`settlement.service.ts:292-299`): reads with no transaction and no `FOR UPDATE` before its terminal early-return despite an "Idempotent" docstring — and races the 30-min `ReconciliationCron` against `POST /admin/settlements/reconcile`.

---

**S6 · Reserves come back out** — Effort **M** · Deps S5 · **High**

_Prevents:_ merchants permanently lose 2-5% of every order with no recovery path; and a refund after a release drives `reserve_held` negative **in an append-only ledger** — permanently.

Build: a delivery-recording endpoint calling `markDelivered` (without it `computeReleaseDate` returns the NEVER sentinel — year 275760 — for every layaway row forever). Stamp a release trigger on default so surviving reserve matures. Make BNPL default consume the 5% reserve withheld for exactly that purpose (`default.service.ts:94-105` sets `fromReserve = 0`). Cap the refund clawback at the live reserve balance — the symmetric guard already exists on the release side (`reserve-release.service.ts:233-236`). Row-lock + idempotency on `releaseOne`.

---

**S7 · Refunds return money** — Effort **L** · Deps S5 · **High** · 🚩 **regulator**

_Prevents:_ you refund a customer in the admin console — the button is shipped (`apps/admin-web/src/pages/plans/detail.tsx:84-92`) — the books say the merchant owes it back, and **the customer never receives a cedi**. `PaystackClient` has no refund method. The `refund_payable` account the schema defines for exactly this (`0000:512-513`) has zero writers, so the platform's obligation to the customer exists nowhere.

Build: `PaystackClient.refund()`; a `RefundService` crediting `refund_payable` against `paystack_settlement` in the same transaction as the state flip; a durable refund record with `pending`/`unknown`/`succeeded`/`failed` modelled like payouts; `ReconciliationService` sweeps in-flight refunds. Zero `amount_paid_pesewas` on the refunded row so the statement stops double-counting (`statement.ts:51` sums across all statuses; the refund leaves the column intact — a refunded customer currently sees the money credited as paid **and** added back to their balance).

---

**S8 · Settlement pays the right merchant the right amount** — Effort **M** · Deps S5 · **High**

_Prevents:_ a merchant onboarded at a negotiated 2.5% MDR is silently charged the global 4%. I confirmed: `customer_plans.mdr_bps`/`reserve_bps` are written at `customer-plans.service.ts:173-174` and **read by nothing** — `PayoutCalculator` uses the hard-coded `MODEL_CONFIG` (`payout-calculator.ts:42-43`). Contract breach discoverable on the first merchant statement.

Build: read the per-plan rates in both `calculate()` and the refund clawback. `MIN_PAYOUT_PESEWAS` floor with roll-forward (design says GHS 100; today any positive balance fires a real transfer whose fee can exceed the payout). Handle `transfer.success`/`failed`/`reversed` driving `confirmPayout`, including reversal of an already-`settled` payout — Paystack routinely reverses GHS transfers days later, and today the payout stays `settled` forever with the merchant recorded as paid but unpaid. Allow a same-day retry after a failed transfer (`settleMerchant` returns "already settled today" for a payout row in **any** status including `failed`). Add a settlement permission — all three settlement routes currently carry `PERMISSIONS.PLANS_WRITE`, seeded as _"Create / update plan templates"_ (`0002:139`).

> ⚠️ Accruals booked before this lands are wrong in an append-only ledger and can only be compensated, never edited. **Ship before the first real merchant.**

---

### TIER 1 — Pilot enablement (cannot launch without)

---

**S9 · SMS actually sends** — Effort **S** · Deps none · **Proven** · 🚩 **regulator** ⚡ _quick win_

_Prevents:_ **no customer can log in.** Customer auth is phone+OTP only and the OTP terminates at a `console.log`. Every reminder, dunning notice, payment link and receipt dies in the same place — and `NotificationService` stamps `status='sent'` on the stub's return, so the notifications table asserts delivery that never happened.

Build: add `@installment/sms-client` to `apps/api` deps (currently a dependency of nothing); add `SMS_PROVIDER`/`HUBTEL_*`/`ARKESEL_*` to `env.validation.ts` (documented in `.env.example:65-71`, absent from the schema); make `SMS_SENDER` a `useFactory` that **refuses to resolve `console` when NODE_ENV==='production'**. Change `ConsoleSmsSender` to log only the last 3 digits and a length — never the body. `HubtelSmsClient.send({to, sender, message})` already satisfies the port.

---

**S10 · It can be deployed, and the first admin can log in** — Effort **L** · Deps none · **Proven**

_Prevents:_ no reproducible way to ship, and **no way to undo a bad release touching customer money**. I verified by exhaustive search: the only YAML/infra files in the tree are `ci.yml`, `docker-compose.yml` (postgres/redis/pgadmin, no api service) and the two pnpm files. No Dockerfile, no CD, no runbooks. And after a clean production migration there is no loginable staff user — the only seeded users are nine `user_type='system'` actors with no `password_hash`.

Build: multi-stage Dockerfile with an API/worker process split (`apps/workers/` is `src/.gitkeep` + a package.json saying _"Populated from Phase 7 onward"_). Fix the migration runner — `packages/db/package.json:22` runs `tsx src/migrate.ts` while `tsx` and `dotenv` are both devDependencies, so `pnpm install --prod && pnpm migrate` fails. CD workflow. A self-disabling `bootstrap-admin` script — productionise `scripts/smoke.sh:32-41`, which today only `UPDATE`s a dev seed row and would affect zero rows in production (and whose tempting shortcut, `seed:dev`, installs the repo-published password `password123` with full admin permissions). The three runbooks `DEVELOPMENT-PLAN.md:604` names.

**Fix graceful shutdown here:** `db.module.ts` calls `createDb()` twice (`:15` and `:25`) producing two pg Pools and ends only `PG_POOL` — the pool every service actually uses is never closed. BullMQ's `shared` connection is never quit (verified against bullmq 5.78.0 `redis-connection.js:410`). With live sockets the event loop never drains, so **SIGTERM never completes and the pod is SIGKILLed mid-charge on every rolling deploy.**

---

**S11 · Underwriting that works on day one** — Effort **L** · Deps none · **Proven, and worse than filed** · 🚩 **regulator**

_Prevents:_ a Ghana pilot is 100% first-time customers and **the engine cannot approve any of them.** I executed the compiled engine (`packages/core/dist/modules/scoring/scoring-engine.js`):

| Applicant                                                         | Score   | Band       | Outcome           |
| ----------------------------------------------------------------- | ------- | ---------- | ----------------- |
| True day-1 walk-in (fresh customer row, no employer)              | **225** | unscorable | **auto-DECLINED** |
| Day-1 + employer linked, no payroll consent                       | 325     | unscorable | **auto-DECLINED** |
| Day-1 + employer + payroll consent + 120mo tenure (best possible) | **375** | subprime   | manual_review     |
| Same, but customer row ≥1 year old                                | 475     | subprime   | manual_review     |
| Above + device fingerprinting                                     | 525     | near_prime | approved_tier_2   |

`near_prime` starts at 500. `score.account_age` (100 pts) requires a **365-day-old customer row** — nobody has one at pilot launch. `score.device_stability` (50 pts) is **structurally unreachable**: `TenureCollector` hard-codes `deviceFingerprintKnown: false` (`tenure.collector.ts:27`). The original audit's "max 475" quietly assumed both. **The real day-one ceiling is 375, and the typical walk-in is auto-declined at 225.**

Build: a cold-start ruleset (thin-file baseline, alternative data, or a first-plan micro-limit ladder); make `device_stability` reachable or delete it; **an affordability rule that actually reads `f.employment.salaryBand`** — it is collected, snapshotted into the decision record, and read by no rule, so the record _looks_ as if income was considered when it was not; re-check exposure at activation, not only at scoring; reach `accept_counter` over HTTP and honour the accepted amount (`customer-plans.service.ts:137-138` says counter-offer amounts are "honoured in a later refinement" — meanwhile `counter_offer` fires whenever the limit is ≥50% of the order, a common mid-ticket case, and the application is then a permanent dead end); make exposure/repayment collector defaults **fail closed** on the blocklist and prior-default gates (`exposure.collector.ts:59-67` returns `isOnBlocklist:false` on a DB hiccup); write a `credit_profiles` row for every human override and require a reason (today an override writes only the application row + audit, so the decision-of-record permanently disagrees with the decision actually made); inject `RulesetLoader` so `rule_definitions` is live.

---

**S12 · Config, credentials and abuse resistance** — Effort **M** · Deps none · **Proven** · 🚩 **regulator**

_Prevents:_ production boots with `dev-access-secret-change-me!!` (`env.validation.ts:18-19`, no NODE*ENV refinement anywhere) and anyone who has read this repo mints `{sub, type:'access'}` for any admin. An attacker burns the SMS budget with unlimited `/auth/customer/otp/start` (which overwrites the key on every call — the 5-attempt cap limits \_guesses*, not _issuance_). A departed ops agent's credentials work forever.

Build: `.superRefine` requiring real JWT secrets, `PAYSTACK_SECRET_KEY` and `CORS_ORIGINS` in production and rejecting the dev literals; drop the `'sk_test_unset'` fallback. `@nestjs/throttler` on the existing Redis provider as an `APP_GUARD` ordered before `JwtAuthGuard`, with named throttles on login / otp-start / otp-verify / the `/me` pay routes; failed-login counter + lockout. `UsersService.deactivate / softDelete / revokeRole / changePassword` — the read side is fully built (`is_active` and `deleted_at` are checked on password login, OTP start, OTP verify **and** refresh) so this is a one-way door, not an unbuilt feature. `POST /auth/logout`. Helmet; auth-gate the OpenAPI doc outside dev.

---

### TIER 2 — Operability and compliance

---

**S13 · Financial separation of duties + PII** — Effort **L** · Deps none · **High** · 🚩 **regulator**

_Prevents:_ a single collections agent — highest turnover, lowest trust, most customer contact — can mark **any** installment on **any** plan paid (wiping a real debt) or refund **any** paid installment, unlimited times. Both routes carry `COLLECTIONS_ACT` (`installments.controller.ts:17,31`), which the `ops` role holds, alongside benign case-note logging. This is verbatim the "refund fraud, internal abuse" scenario `DEVELOPMENT-PLAN.md:579` requires the threat model to cover.

Build: a financial permission tier separate from `collections:act`; maker-checker above a configurable amount; per-actor daily caps and alerts on high-value manual adjustments. Mask Ghana Card to last-4 for non-privileged readers and stop writing the raw number into audit metadata (`customers.service.ts:178`) — those rows sit behind a `BEFORE UPDATE OR DELETE` trigger and are **permanently un-erasable**. Add statement-level `BEFORE TRUNCATE` triggers (the row-level ones do not cover TRUNCATE) and a least-privilege DB role — no `GRANT`/`REVOKE`/`CREATE ROLE` appears in any of the six migrations, so the app connects as table owner and can `ALTER TABLE ... DISABLE TRIGGER`. Backup/PITR with a documented restore drill and RPO/RTO. A retention + erasure routine (`DEVELOPMENT-PLAN.md:586` requires one; none exists).

---

**S14 · Workers you can trust and see** — Effort **M** · Deps S10 · **Proven**

_Prevents:_ an operator copying `.env.example` ships a lender that never debits and never settles with `/health` green — discovered when a merchant phones about a missing payout, after days of missed debits have pushed live installments into collections through no fault of the customer. And with the flag on across two replicas, two reserve-release sweeps credit the same merchant twice — a doubled posting is 2 debits + 2 credits and **still balances**, so the debit=credit check cannot detect it.

Build: a `worker_runs` heartbeat upserted in a `finally`; a staleness cron with per-worker budgets calling `captureAlert`; `schedulerEnabled` + per-worker staleness on `/health`; split `/health/live` and `/health/ready` and probe the BullMQ ioredis client (a separate connection the health check never touches); report build/commit. Wrap every money-touching cron in `RedisLock.withLock` — its only caller repo-wide today is `schedule-state.service.ts:52`. Move `Sentry.init` into `instrument.ts` imported first (today it runs after `AppModule` is in `require.cache`, so v8's require-in-the-middle hooks never apply and every captured exception arrives context-free), set a `release`, add a PII-scrubbing `beforeSend`, flush on shutdown. Map the eight unmapped domain errors in `DomainExceptionFilter` so they stop firing Sentry as 500s.

---

**S15 · Gates that mean something** — Effort **M** · Deps none · **Proven** · _enabler for S1, S3, S4, S5, S6_

_Prevents:_ every slice above claims "green gates," and today that claim is hollow. A concurrency fix can pass CI **without being tested at all**, because all three integration specs that construct a lock pass `new RedisLock(ALWAYS_OPEN)`.

Build: per-worker schema or transaction-rollback isolation (no `TRUNCATE`/`DELETE FROM`/`beforeEach` exists in any integration spec — only `afterAll(() => pool.end())`). Scope the global sweeps in tests. Use the real CI Redis in the lock specs. Add supertest HTTP-layer tests for both global guards, the exception filter and the webhook raw-body path — `supertest` is at `apps/api/package.json:45-46` and imported by nothing. Randomise the hardcoded `'0244111222'` at `applications.integration.spec.ts:43` (unique-constrained; the suite fails on any local re-run).

---

### TIER 3 — Completeness

---

**S16 · Plan lifecycle: cancel, pay off, restructure, charge late fees** — Effort **L** · Deps S5, S7 · **High**

_Prevents:_ goods are returned and **the engine keeps auto-debiting the customer every cycle forever** — nothing writes `customer_plans.status='cancelled'`, `refundInstallment` cannot touch unpaid rows, and the only exit is `markPlanDefaulted`, which brands the customer a defaulter, claws back merchant reserve, and books a fictitious loss. In a pilot with physical goods, returns are routine.

Build: cancellation/unwind. Early payoff with a quote and an unearned-interest rebate (the generator front-loads all interest at `schedule-generator.ts:94`, so paying early today costs full interest). Restructure — the state machine has `in_collections:restructure_approved → restructured` and `customer_plans.restructured_from_plan_id` exists and nothing fires either, so ops closing a case with `resolution='restructured'` records an outcome the engine cannot produce and the debt is abandoned mid-state. Late-fee accrual on grace expiry (`installment_schedule.late_fee_pesewas` is read by five call sites and written by none — a merchant configures GHS 20 and it silently does nothing). Close a collections case when its installment is paid, and re-check delinquency before `resolveWriteOff` calls `markPlanDefaulted` (`collections.service.ts:337-354` defaults the plan **before** it ever looks at the schedule — an agent-collected cash payment plus a forgotten case-close defaults a paying customer 90 days later, irreversibly).

---

**S17 · An API surface you can operate** — Effort **L** · Deps none · **Proven**

_Prevents:_ a plan is unreachable unless you already know its UUID. The admin console has literally shipped a paste-the-UUID form — I read `apps/admin-web/src/pages/plans/lookup.tsx`, a single "Plan UUID" input that navigates to `/plans/{uuid}` — because `plans.controller.ts` has no `@Get()` collection handler. A MoMo debit dispute, the most common Ghanaian support ticket, requires direct DB access because `payment_attempts` has **no read API at all**.

Build: `GET /admin/plans` with filters. `GET /admin/schedules/:id/attempts` plus a force-verify route (`verifyAttempt` is reachable only via cron). An audit reader + `GET /admin/audit` (`audit:read` is seeded, referenced by no controller, and `AuditLoggerService` has only `append` and a private `validate`; the index it needs already exists at `0000:663`). A `Page<T>` envelope and consistent limit/offset/sort — only `listPayouts` returns a total, and `GET /admin/applications` 400s on any string `limit` because its Zod schema alone among the admin lists does not coerce. Customer self-service: payoff quote, MoMo number update (admin-only today, and `DebitRunner` reads the stored number, so a stale one silently fails auto-debit forever). A `/merchant` namespace with a `merchants.owner_user_id` link and real `merchant_owner` grants — that role holds **zero** permissions in every migration, and the tempting workaround (granting `MERCHANTS_READ`) is genuinely cross-tenant because `merchants.controller.ts:123-181` never compares `:id` to the caller. Routes reaching `acceptCounterOffer` and `cancel`.

---

## 4. Ordering

**Day 0, before writing any code (~1 hour):** round-trip a Paystack sandbox charge with the current reference format. Everything below assumes charges work at all.

**Week 1 — parallel, disjoint files:** **S1** (double-charge) and **S9** (SMS, effort S). S9 is a dependency line, three env keys and a factory, and it unblocks every piece of customer-facing testing for the rest of the programme.

**Wave 1 — stop the bleeding (money correctness):** S1 → S3 → S4 → S2, with **S15** threaded in immediately after S1 so the later slices have gates that mean something.

**Wave 2 — books you can audit:** S5 → S6 → S8 → S7. S8 before your first real merchant; pre-fix accruals can only be compensated, never edited.

**Wave 3 — launch enablement:** S9 (done) → S12 (the `superRefine` alone is an hour) → S10 → S11.

**Wave 4 — run it:** S14 → S13.

**Wave 5 — operate it comfortably:** S17 → S16.

### 🚩 Would fail a regulator or auditor

| Slice       | Failure                                                                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S11**     | No affordability assessment anywhere, while `salary_band` is collected and snapshotted into the decision record — the record _looks_ as if income was considered. Plus adverse-action declines with no recorded reason and human overrides with no decision-of-record. Fails a BoG responsible-lending review outright. |
| **S5**      | No cash-in leg → no trial balance, no balance sheet, no ledger-vs-Paystack reconciliation. A pilot can operate for weeks with this; it cannot be **audited**.                                                                                                                                                           |
| **S7 + S1** | Double-debit with a refund path that books entries but moves no money. Consumer protection.                                                                                                                                                                                                                             |
| **S13**     | Ghana Card in plaintext in an un-erasable audit row with no retention or erasure routine (Ghana DPA 2012). Plus a single ops agent able to wipe or refund any debt with no maker-checker.                                                                                                                               |
| **S9**      | OTPs written in plaintext to the log sink next to the phone number — anyone with log access authenticates as any customer and initiates MoMo charges.                                                                                                                                                                   |
| **S10**     | No backup/PITR and no rollback procedure for a system holding a lending book.                                                                                                                                                                                                                                           |

---

## 5. The single next slice

### ▶ **S1 — "One installment, one charge"**

**Reasoning:**

1. **It is the only defect class whose harm is currently irreversible.** Everything else is recoverable by SQL, by a compensating entry, or by an operator. A double-debit is not — because the refund path (S7) books ledger entries and never calls Paystack. Debiting a Ghanaian customer twice for one installment and being structurally unable to give the money back is the single worst outcome available to this system, and today it is one double-tap away.

2. **It carries the pre-flight that gates everything else.** `INSTL-{uuid}-{uuid}:{n}` contains a colon and repeats the UUID — a format that could not have survived one real sandbox round-trip. Whether Paystack accepts it changes the entire plan: if it does not, nothing in this engine has ever charged anyone, and every other slice is theory. That check belongs in the same PR and takes an hour.

3. **It is coherent, contained, and honestly one review.** Five files, one migration, one new spec, all answering one question a reviewer can hold in their head: _can any sequence of requests produce two charges for one installment?_ It is not a refactor and it has no dependencies.

4. **It forces the test-infrastructure fix at exactly the right scope.** You cannot prove S1 with `new RedisLock(ALWAYS_OPEN)`. Writing one properly-isolated concurrency spec against the real CI Redis inside this PR establishes the pattern S15 then backfills — rather than spending your first PR on test plumbing while a live double-debit sits in production.

5. **It is the parent of the largest cross-corroboration cluster.** Six independent findings from two audits point at the same missing idempotency layer. Fixing the state-machine and locking half here makes S2 (the HTTP-boundary half) a mechanical follow-up.

Ship **S9 (SMS)** the same week. Effort S, disjoint files, and until it lands you cannot test a single customer-facing path end to end.

---

## 6. What the finding count overstates

Rank these **down**. They are real — I am not refuting them — but they consume review attention out of proportion to pilot risk.

**Genuinely low value at pilot scale:**

| Finding                                            | Why it ranks lower than it reads                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No API versioning / global prefix                  | All three consumers are first-party in this monorepo. Zero external integrators. Cheap (S) and should land before the first partner — but it is not a pilot item.          |
| Idempotency keys never expire / never purged       | The table **cannot grow**: nothing writes a row because nothing consumes the service. A pure duplicate of the wiring finding, inert until S2 lands. Fold in; do not track. |
| Sequential scans on three hot query paths          | Correctness-neutral. Milliseconds at thousands of rows. Three `CREATE INDEX` statements, whenever.                                                                         |
| No load / soak test                                | A missing **measurement**, not a defect. Batch entry points already carry sane caps (limit 200, limit 1000). Effort L for zero pilot-day value.                            |
| Hardcoded `'0244111222'` in the applications spec  | A loud, immediately-reproducible local `beforeAll` failure. Zero production exposure, cannot corrupt another suite. One-line fix; do it inside S15.                        |
| `GET /admin/applications` rejects `limit`/`offset` | The default 50 works. The screen degrades; it does not die.                                                                                                                |
| No consistent pagination contract                  | Cosmetic at pilot row counts. Real API-design debt, but it is S17 filler, not a slice.                                                                                     |
| No HTTP security headers; unauthenticated OpenAPI  | Real hardening, near-zero pilot exposure. Ride along in S12.                                                                                                               |
| Domain errors unmapped → 500                       | Diagnostic and alert-budget noise. The underlying operations all re-check state under `FOR UPDATE`, so a confused operator retry is safe.                                  |

**Overweighted relative to effort — defer past pilot:**

- **No metrics / `/metrics` endpoint (effort L).** The raw material is all queryable: `payment_attempts` persists `failure_reason` and `raw_response` per attempt, `payouts`/`ledger_entries` hold settlement totals, and pino-http already emits per-request `responseTime`. This slows analysis; it does not hide a money-losing failure. **S14's heartbeat + staleness alerting delivers ~80% of the operational value for ~20% of the effort.** Build the heartbeat, skip Prometheus until after the pilot.
- **Correlation IDs (effort M).** The actual forensic path for "was she debited twice on 14 Aug" is `payment_attempts` → `webhook_events` → `audit_events`, all keyed by `schedule_id` and `provider_reference`. The log-side gap is real and worth the `genReqId` one-liner; the full AsyncLocalStorage + audit-column + BullMQ-payload propagation is not pilot work.
- **No logger port in `packages/core` (effort M).** A genuine reusability defect for a framework-free engine — but `payment_attempts.raw_response` already answers "what did Paystack say." Matters when a second host app appears, not before.
- **No dispute / chargeback handling (effort L).** Important, and MoMo disputes in Ghana are rare compared to card. Ship a manual runbook, defer the machinery.
- **Rules-as-data is inert (effort M).** `DEFAULT_RULESET` is correct-by-construction and version-stamped. The real cost is tuning velocity, and S11 has to touch this code anyway — fold it in rather than tracking it separately.
- **Restructure unimplemented (effort L).** Matters enormously for a mature book; a 3-month pilot plan rarely needs restructuring inside the pilot window, and a manual write-off + re-application workaround exists. It is S16, correctly last.

**And one that must be ranked UP, against both audits:**

> **Cold start (S11) was filed as `high` and its arithmetic was optimistic.** The original finding said the ceiling for a thin-file applicant is 475 → subprime → manual*review. I executed the engine: that number requires a customer row **≥365 days old** \_and* device fingerprinting that `TenureCollector` hard-codes to unavailable. The true day-one ceiling is **375**, and a normal walk-in scores **225 → unscorable → auto-DECLINED**. Combined with the counter-offer dead end and a manual-review queue that has no assignment, claim, aging or SLA mechanics — and human overrides that write no `credit_profiles` row — **the pilot's day-one approval throughput is effectively zero, and every approval it does produce is unauditable.** Treat S11 as a launch blocker, not a Tier-2 nicety.

---

**Bottom line:** the ~70 findings collapse to **9 root causes**, and 7 of them live in code that runs only when something goes wrong or arrives late. The schema already tells you what to build — in several places it is commented with the name of the worker that was never written. That is a good position to be in. Fix the async paths, wire the idempotency layer that is already written, turn on SMS, and make the ledger record cash, and this becomes a pilot-ready lending engine in roughly four focused waves.

---

## Appendix — provenance

**Pass A (permissive).** Ten independent audits of `packages/core`, `apps/api`, `packages/db`, each followed by a refutation agent. Six of ten refutation agents completed; four died on an account spend limit. 52 findings adjudicated, 1 refuted.

**Pass B (strict).** The 37 findings orphaned by Pass A were re-adjudicated by fresh adversarial reviewers required to cite `file:line` for every verdict. 37 adjudicated, 0 refuted, 37/37 citations present.

**Synthesis.** Merged both passes (~70 unique findings after dedupe) and independently re-verified the highest-leverage claims by reading and executing code — which corrected the cold-start arithmetic (S11) in the pessimistic direction.

**Caveat carried forward:** 0 refuted across 88 findings in two passes is a flag on review rigour, not a compliment to the codebase. Confidence is high on _existence_, moderate on _severity calibration_. Findings tagged **Proven** were confirmed by direct code reading in-session.
