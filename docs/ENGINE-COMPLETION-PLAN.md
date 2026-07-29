# Installment Engine — Completion Plan

**Status:** audit complete, no implementation started.
**Scope:** the installment payment engine only (`packages/core`, its wiring in `apps/api`, `packages/db`). Commerce/marketplace gaps are explicitly out of scope and are tracked in `PLATFORM-ROADMAP.md`.

---

## 1. How this was produced

Ten independent audits swept the engine, each with a distinct lens (payments, settlement, ledger, scoring, schedules/collections, security, observability, API surface, data integrity, testing, ops readiness). Each auditor's findings then went to a second agent whose only job was to **refute** them.

**88 findings total — 51 adversarially verified, 37 unverified.**

Two honest caveats about confidence:

1. **Four areas were never verified.** The refutation agents for _api-surface_, _data-integrity_, _testing_ and _ops-readiness_ died when the org hit its monthly spend limit. Those 37 findings are recovered from the run journal and marked `[U]` below. Treat them as strong leads, not established fact — each needs a confirming read before you build against it.
2. **The verification pass was permissive.** It refuted only 1 of 52 findings. A refutation rate that low means the pass is weak evidence on its own.

The strongest signal in this document is therefore **cross-corroboration**: findings that two or three auditors hit independently, without seeing each other's work. Those are flagged **⊕** and should be treated as the highest-confidence items regardless of `[V]`/`[U]` status.

Severity distribution: 15 blocker · 35 high · 37 medium · 1 low.

---

## 2. The headline

**The domain logic is strong.** Schedule generation, the state machine, the scoring rule engine, the payout calculator and double-entry validation are all genuinely well built, well tested and faithful to the design docs. This is not a codebase in trouble.

**What is missing is the unhappy edge of the money path.** The engine handles the synchronous success case correctly and loses track of money whenever the provider does something asynchronous, late, duplicated or ambiguous — which, on Ghanaian MoMo, is the _normal_ case rather than the exception. MoMo's standard flow is `pay_offline` → webhook, and that is precisely the path with the least coverage.

That is the characteristic shape of a payments system that has not yet met production. It is fixable, and the fixes are concentrated in a small number of files.

A structural observation worth stating plainly: **`WebhookService` is a second, impoverished copy of the charge-outcome pipeline in `PaymentService`.** Three separate blockers trace back to that one duplication. Collapsing the two into a shared outcome applier is the single highest-leverage refactor in this document.

---

## 3. Tiering

| Tier  | Question it answers                        | Slices |
| ----- | ------------------------------------------ | ------ |
| **0** | Can the engine lose or double-take money?  | 1–5    |
| **1** | Can a pilot physically run?                | 6–8    |
| **2** | Will credit decisions survive a regulator? | 9–10   |
| **3** | Can the plan lifecycle be operated?        | 11     |
| **4** | Can humans use and observe it?             | 12–15  |

Within a tier, slices are ordered by dependency. Each slice is sized to be one reviewable PR with green gates (build · typecheck · lint · format · unit + integration).

---

# TIER 0 — Money correctness

Nothing else matters until these are done. Every item here can lose a customer's money, take it twice, or leave the books wrong.

---

## Slice 1 — Charge-path integrity ⭐ **RECOMMENDED FIRST**

**Effort: L** · no dependencies

The engine can debit a customer twice, and can take money without crediting the installment. Both are live today.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                 | Sev     | Conf  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| 1.1 | **Installment in `processing` accepts a second concurrent charge — real double-debit.** `ensureProcessing` treats already-`processing` as a no-op. Because `debit_initiated` bumps `attempt_count`, the second caller computes a _different_ idempotency key and Paystack reference, so the UNIQUE constraint never fires. Two live MoMo prompts; approving both takes the money twice. | blocker | [V]   |
| 1.2 | **`charge.success` arriving when the schedule is not `processing` is silently discarded.** The transition table only contains `processing:charge_succeeded`, and the success handler blanket-swallows `IllegalScheduleTransitionError`. Money taken, installment never marked paid.                                                                                                     | blocker | [V] ⊕ |
| 1.3 | **Payment-link settlement is silently discarded** — same root cause as 1.2. `PaymentLinkDispatcher` leaves the schedule in `retry_scheduled`, so _every_ payment-link payment is lost. The engine's designed final fallback never works.                                                                                                                                                | blocker | [V] ⊕ |
| 1.4 | **Verify-poll gives up after ~7–10 min instead of the specified ~45.** MoMo USSD approvals routinely take longer. Turns "we don't know" into "failed", schedules a retry, and opens a double-charge window when the customer then approves.                                                                                                                                             | high    | [V]   |
| 1.5 | **Paystack references contain a colon**, which Paystack's reference charset disallows. If rejected, every charge lands in `unknown`.                                                                                                                                                                                                                                                    | high    | [V]   |
| 1.6 | No test for out-of-order webhooks — the untested path silently drops a successful payment.                                                                                                                                                                                                                                                                                              | high    | [U] ⊕ |
| 1.7 | Zero concurrency tests; `RedisLock` is stubbed permanently open in every integration spec and `ScheduleConcurrencyError` is asserted nowhere.                                                                                                                                                                                                                                           | high    | [U]   |

**Build:** reject `processing` in `ensureProcessing` and hold the `schedule:<id>` Redis lock across `beginAttempt`→provider-call; refuse a new attempt while an `in_flight`/`unknown` one exists. Widen the state machine so a confirmed success settles from any non-terminal state (`retry_scheduled`, `failed`, `overdue`, `in_collections`) instead of only `processing`, and narrow the swallow to "already paid with the same provider reference". Raise `STALE_AFTER_MS` and `MAX_VERIFY_POLLS` to the ~45-minute envelope. Strip the colon from references. Add the concurrency and out-of-order webhook suites against a real Redis.

**Touches:** `payments/payment.service.ts`, `schedules/state-machine.ts`, `schedules/customer-plans.service.ts`, `payments/retry-policy.ts`, `payments/payment-link-dispatcher.ts`

---

## Slice 2 — Retry ladder + stuck-state recovery

**Effort: M–L** · depends on Slice 1 (shares the state machine changes)

Money that isn't lost outright gets frozen instead. Nothing in the system ever rescues it.

| #   | Finding                                                                                                                                                                                                                                                                                             | Sev     | Conf  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| 2.1 | **Webhook-delivered failures never enter the retry ladder.** `WebhookService.handleFailure` never calls `afterFailure` — no retry job, no payment link, no failure SMS, no telco record. Since MoMo's normal path is `pay_offline`→webhook, **the entire 4-attempt retry policy is dead for MoMo.** | blocker | [V]   |
| 2.2 | **`unknown` attempts and installments stuck in `processing` are never reconciled.** `findStaleInFlight` selects only `in_flight`; `markAttemptUnknown` applies no schedule event. Any Paystack timeout freezes that installment permanently — no retry, no escalation, no worklist.                 | blocker | [V] ⊕ |
| 2.3 | **Grace-expiry sweep ignores `pending` and `retry_scheduled`** — installments strand in a non-terminal state forever and never enter collections.                                                                                                                                                   | blocker | [V] ⊕ |
| 2.4 | `retry_scheduled` is a black hole: after the payment-link step (or a lost queue job) the installment never escalates and never completes. No DB-side safety net behind the Redis queue.                                                                                                             | high    | [V] ⊕ |

**Build:** extract the post-outcome pipeline into a shared `ChargeOutcomeApplier` used by both `PaymentService` and `WebhookService` — this single refactor kills 2.1 and hardens 1.2. Widen `findStaleInFlight` to include `unknown`. Add a stuck-schedule reconciler over `processing` rows older than a threshold (the `schedule_stuck_idx` already exists). Add `retry_scheduled`/`pending` to `escalateGraceExpired` with the matching transitions.

**Touches:** `webhooks/webhook.service.ts`, `payments/payment.service.ts`, `payments/attempt-repository.ts`, `collections/collections.service.ts`, `schedules/state-machine.ts`

---

## Slice 3 — Ledger truth: cash-in + uniqueness

**Effort: M** · independent of 1–2

The double-entry ledger is rigorous, and the **inbound leg was never wired**. Two auditors found this independently.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                    | Sev          | Conf      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------- |
| 3.1 | **Customer cash-in is never booked.** `finalisePaidInstallment` only decrements `outstanding_pesewas`. No `DEBIT paystack_settlement / CREDIT receivable` pair exists, so `paystack_settlement` and `receivable` are fiction and ledger-vs-Paystack reconciliation is impossible. Nobody can answer "does our balance cover this morning's payout batch?" before it fires. | blocker/high | [V]+[U] ⊕ |
| 3.2 | **`customer_plans.application_id` has no UNIQUE constraint** — under READ COMMITTED two concurrent activations both insert. One order → two plans → two schedules → the customer is charged twice. No index on the column either.                                                                                                                                          | blocker      | [U]       |
| 3.3 | Ledger idempotency is read-then-write with no `UNIQUE(transaction_id, …)` backstop; `reverseAndFail` and reserve-release have no guard at all.                                                                                                                                                                                                                             | high/med     | [V]+[U] ⊕ |
| 3.4 | The balance invariant is enforced only per-call in application code — no runtime drift detection or alert.                                                                                                                                                                                                                                                                 | medium       | [V]       |

**Build:** book the cash-in leg inside `finalisePaidInstallment`'s existing transaction with a deterministic `collect:{scheduleId}` id (credit `revenue` for any late fee). Add `CREATE UNIQUE INDEX customer_plans_application_uq` and translate 23505 to `PlanAlreadyActiveError`. Add `ledger_entry_identity_uq` so every dedupe has a DB backstop. Add a daily invariant check that alerts on global imbalance.

**Touches:** `schedules/customer-plans.service.ts`, `shared/ledger/ledger.service.ts`, new migration

---

## Slice 4 — Settlement correctness

**Effort: M–L** · depends on Slice 3

Merchants are being paid the wrong amounts, and some money can never be released.

| #   | Finding                                                                                                                                                                                                                                                             | Sev         | Conf      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------- |
| 4.1 | **Per-merchant MDR and reserve rates are collected, stored, displayed — and never used.** `PayoutCalculator` reads only the global `MODEL_CONFIG`. A merchant negotiated to 2.5% is silently charged 4%. The admin console shows a rate the engine does not honour. | high        | [V]       |
| 4.2 | **Layaway reserve is withheld forever** — `markDelivered` has zero callers and no endpoint, so `delivered_at` is never stamped and the maturity function returns NEVER. No manual override exists.                                                                  | blocker/med | [V]+[U] ⊕ |
| 4.3 | **Refund clawback ignores whether the reserve still exists** — under-collects from the merchant and drives `reserve_held` negative.                                                                                                                                 | high        | [V]       |
| 4.4 | **Paystack transfer webhooks are not handled at all.** `transfer.failed`/`transfer.reversed` are ingested, marked processed and discarded. A reversed payout stays `settled` forever and `merchant_payable` stays cleared — the merchant is never re-credited.      | high        | [V]       |
| 4.5 | Defaulted plans strand their reserve permanently; a BNPL default never touches the reserve withheld to cover it.                                                                                                                                                    | medium      | [V]       |
| 4.6 | No minimum payout threshold — the daily batch fires a Paystack transfer for any balance above zero.                                                                                                                                                                 | medium      | [V]       |

**Build:** thread `plan.mdr_bps`/`reserve_bps` into `PayoutCalculator`, defaulting to `MODEL_CONFIG` only when absent. Add a delivery-confirmation endpoint calling `markDelivered`. Clamp refund reserve reversal to the actual `reserve_held` balance. Add a transfer branch to `WebhookService.dispatch` wired to `confirmPayout`. Consume reserve on default. Add a configurable payout floor.

**Touches:** `settlements/payout-calculator.ts`, `payout-recorder.ts`, `reserve-release.service.ts`, `default.service.ts`, `settlement.service.ts`, `webhooks/webhook.service.ts`

---

## Slice 5 — Refunds actually return money

**Effort: L** · depends on Slice 3

| #   | Finding                                                                                                                                                                                                                                                                                            | Sev    | Conf |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| 5.1 | **The refund path reverses the books but never returns the customer's money.** `PaystackClient` has no refund method; there is no outbound record, no status, no failure handling. The UI, schedule, plan and merchant statement all say "refunded" while the customer's wallet is never credited. | high   | [V]  |
| 5.2 | No dispute or chargeback handling anywhere; the `refund_payable` ledger account is dead.                                                                                                                                                                                                           | medium | [V]  |

**Build:** add `PaystackClient.refund()` and a `RefundService` that credits `refund_payable` in the same transaction as the state flip, with a durable outbound record mirroring `payment_attempts` (status, reference, failure handling, verify sweep).

---

# TIER 1 — Pilot enablement

The engine cannot be put in front of a real merchant until these exist.

---

## Slice 6 — SMS delivery

**Effort: M** · no dependencies · **can be done in parallel with Tier 0**

| #   | Finding                                                                                                                                                                                                                                                                                                                | Sev     | Conf      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------- |
| 6.1 | **SMS is hard-wired to a console stub, and OTP codes are written to logs in plaintext next to the phone number.** Customer auth is phone+OTP only, so **no customer can ever log in**. Reminders, payment links and dunning all terminate at a `console.log`. Anyone with log access can authenticate as any customer. | blocker | [V]+[U] ⊕ |
| 6.2 | Charges settled by webhook send no receipt — the normal MoMo customer never gets confirmation.                                                                                                                                                                                                                         | medium  | [V]       |

**Build:** add `SMS_PROVIDER` + credentials to `env.validation.ts`, refuse `console` when `NODE_ENV=production`, swap `SMS_SENDER` to a `useFactory`. Independently, reduce `ConsoleSmsSender` to logging masked phone + message length only. Fire the receipt from the shared outcome applier built in Slice 2.

---

## Slice 7 — Deployment & operations

**Effort: L** · no dependencies

| #   | Finding                                                                                                                                                                                                                                                         | Sev     | Conf      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------- |
| 7.1 | **No deployment artifacts of any kind** — no Dockerfile, no CD, no migrate-on-deploy. `pnpm install --prod` cannot even run `pnpm migrate` (tsx/dotenv are dev-only).                                                                                           | blocker | [U]       |
| 7.2 | **No worker process and no leader election.** All crons are providers of a module imported into the HTTP app. Scaling to 2 instances runs every sweep twice concurrently; reserve-release has no row-lock protection, so it double-releases.                    | blocker | [U]       |
| 7.3 | **Workers have no heartbeat, staleness alert or health visibility.** `ENABLE_SCHEDULED_WORKERS` defaults to **false** and logs nothing when off; `/health` still returns green. A deploy that omits the flag charges nobody, settles nobody, and looks healthy. | high    | [V]+[U] ⊕ |
| 7.4 | No production-safe way to create the first admin user — the pilot is blocked at the first login.                                                                                                                                                                | high    | [U]       |
| 7.5 | Graceful shutdown never completes — a second Postgres pool and the BullMQ Redis connection leak on SIGTERM.                                                                                                                                                     | medium  | [U]       |
| 7.6 | Application expiry is implemented and indexed but **never scheduled** — `expireOverdue` has zero callers.                                                                                                                                                       | medium  | [V]+[U] ⊕ |
| 7.7 | Idempotency keys never expire and are never purged; a crashed request bricks the key forever.                                                                                                                                                                   | medium  | [U]       |
| 7.8 | No backup / PITR / retention for the financial source of truth; append-only triggers do not cover TRUNCATE.                                                                                                                                                     | medium  | [U]       |

**Build:** multi-stage Dockerfile with an API/worker process split; wrap every cron in `RedisLock.withLock` (the primitive exists and is tested); add a `worker_runs` heartbeat table + staleness alerting + `/health` worker block; add a self-disabling `bootstrap-admin` script; fix shutdown hooks; schedule the expiry sweep.

---

## Slice 8 — Security hardening

**Effort: L** · no dependencies

| #   | Finding                                                                                                                                                         | Sev    | Conf |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| 8.1 | **No rate limiting, throttling or brute-force protection on any endpoint** — unlimited credential stuffing and unlimited SMS pumping via OTP re-issue.          | high   | [V]  |
| 8.2 | **Production can boot with the repo's published dev JWT secrets.** Anyone who has read the repo can forge an admin token.                                       | high   | [V]  |
| 8.3 | **No way to deactivate, offboard or rotate credentials for any user.** A departing ops agent's credentials work indefinitely.                                   | high   | [V]  |
| 8.4 | **Refunds and manual write-offs are gated behind `collections:act`** — the highest-turnover, lowest-trust role. No financial permission tier, no maker-checker. | high   | [V]  |
| 8.5 | No server-side session revocation: no logout, no refresh-token store, no reuse detection.                                                                       | medium | [V]  |
| 8.6 | Raw Ghana Card numbers are written into the immutable audit log and returned unmasked to every `customers:read` holder.                                         | medium | [V]  |
| 8.7 | No HTTP security headers; the full OpenAPI spec is served unauthenticated in every environment.                                                                 | low    | [V]  |

**Build:** `@nestjs/throttler` on the existing Redis as an `APP_GUARD` ahead of `JwtAuthGuard`; a production `superRefine` on the env schema requiring real secrets ≥32 chars; user deactivate/offboard/role-revoke with audit; new `payments:refund` / `payments:manual_credit` / `settlements:run` permissions seeded to admin only; refresh-token store with reuse detection; mask Ghana Card at the audit and serialization boundary; helmet + guarded docs.

---

# TIER 2 — Credit correctness

Where a regulator or an auditor will look first.

---

## Slice 9 — Counter-offers and activation-time exposure

**Effort: M** · depends on Slice 3 (uniqueness)

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                         | Sev          | Conf      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------- |
| 9.1 | **The counter-offer path is a dead end.** Three independent breaks: no HTTP route reaches `acceptCounterOffer`/`cancel`; the accepted counter amounts are ignored when generating the schedule (`customer-plans.service.ts:139`); and the computed amounts can violate the `customer_plans` CHECK. Counter-offer fires whenever limit ≥ 50% of order — a common mid-ticket case — and **every one of those deals is stranded**. | blocker/high | [V]+[U] ⊕ |
| 9.2 | **Exposure and limit rules are evaluated at scoring time and never re-checked at activation.** No per-customer lock, no re-validation. One customer — or a fraud ring on one identity — can stack N plans past the limit. The engine's most important credit control is advisory.                                                                                                                                               | high         | [V]       |

**Build:** compute counter amounts in integer pesewas inside the engine so down-payment + financed reconcile by construction; honour them in `activateFromApplication`; add accept/cancel routes (admin + customer-scoped) plus `GET /me/applications`. Re-evaluate exposure inside the activation transaction under a per-customer lock.

---

## Slice 10 — Underwriting reality

**Effort: L** · depends on Slice 9

| #    | Finding                                                                                                                                                                                                                                                                                                            | Sev    | Conf |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---- |
| 10.1 | **Cold start: no first-time customer can be auto-approved.** The maximum achievable score for a thin-file applicant is **475**, below the `near_prime` cutoff of 500 — verified by executing the compiled scoring engine. A pilot is 100% first-time customers, so **every application funnels to manual review**. | high   | [V]  |
| 10.2 | **No affordability assessment anywhere.** Salary band is collected into the decision snapshot and no rule reads it; limits ignore income entirely. The engine can approve an installment exceeding the customer's income — the classic BNPL harm, and exactly what a Ghana pilot will be judged on.                | high   | [V]  |
| 10.3 | **Human override decisions produce no credit-decision record and need no reason.** For the applications that matter most (today, all of them), there is nothing to show a regulator.                                                                                                                               | high   | [V]  |
| 10.4 | Rules-as-data is inert: `RulesetLoader` is provided but never injected, so `rule_definitions` has zero effect on live decisions.                                                                                                                                                                                   | medium | [V]  |
| 10.5 | Fail-soft collectors fail **open** on the blocklist and prior-default hard gates, and a degraded decision is indistinguishable from a clean one.                                                                                                                                                                   | medium | [V]  |

**Build:** a calibrated thin-file/cold-start ruleset (or bootstrap band cutoffs) so a clean first-timer can clear `near_prime`; an affordability rule in the exposure stage reading the derived per-installment amount against income; `credit_profiles` written for human decisions too, with a mandatory reason; inject `RulesetLoader`; make hard-gate collectors fail closed and stamp decision degradation.

---

# TIER 3 — Plan lifecycle

## Slice 11 — Operable plans

**Effort: XL — split into 11a/11b/11c** · depends on Tier 0

| #    | Finding                                                                                                                                                                                                                              | Sev    | Conf |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---- |
| 11.1 | **No plan cancellation or unwind.** Nothing writes `cancelled` to `customer_plans`. Goods returned → the engine keeps debiting the customer's MoMo every cycle, and the only exit books a loss.                                      | high   | [V]  |
| 11.2 | **Restructuring is entirely unimplemented** despite DB, state-machine and DTO support. The only outcomes for a struggling customer are keep dunning or write off. Closing a case as `restructured` produces a lie.                   | high   | [V]  |
| 11.3 | **Collections write-off defaults a plan without re-checking delinquency, and nothing closes a case when its installment is paid.** Ops records a field-agent cash payment, and 90 days later the sweep defaults the customer anyway. | high   | [V]  |
| 11.4 | **No early settlement / payoff** — a customer cannot pay off the remaining balance. No quote, no interest rebate.                                                                                                                    | medium | [V]  |
| 11.5 | **Late fees are configurable, priced into every charge and constrained in SQL — but never accrued on any installment.**                                                                                                              | medium | [V]  |
| 11.6 | Statement double-counts refunded installments; `amountPaid` and `outstanding` are mutually inconsistent.                                                                                                                             | medium | [V]  |

**Suggested split:** 11a = cancellation + case-close-on-payment (safety); 11b = restructure; 11c = early payoff + late-fee accrual + statement fix.

---

# TIER 4 — Usability & observability

## Slice 12 — API completeness

**Effort: L**

| #     | Finding                                                                                                                                                                                                                         | Sev     | Conf  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| 12.1  | **`Idempotency-Key` is advertised in CORS but never implemented** — every money-mutating POST is replay-unsafe. `IdempotencyService` is fully written and registered nowhere. On Ghanaian networks, client retries are routine. | blocker | [U] ⊕ |
| 12.2  | Domain errors on live paths are unmapped and leak as 500s (≥7 classes, incl. `PlanDefaultError`, `ScheduleConcurrencyError`).                                                                                                   | high    | [U]   |
| 12.3  | No plan list/search endpoint — a plan is unreachable unless you already know its UUID. Support cannot find a caller's plan.                                                                                                     | high    | [U]   |
| 12.4  | `payment_attempts` — the durable charge log — has no read API. Support cannot answer "MTN debited me but the app says unpaid".                                                                                                  | high    | [U]   |
| 12.5  | Customer self-service incomplete: no early payoff, no payment-method/profile management (stale MoMo numbers silently fail debits).                                                                                              | high    | [U]   |
| 12.6  | `audit_events` has no read API — the compliance record is write-only and `audit:read` is a dead permission.                                                                                                                     | medium  | [U]   |
| 12.7  | `GET /admin/applications` rejects any limit/offset — string query params hit a non-coercing Zod schema.                                                                                                                         | medium  | [U]   |
| 12.8  | No consistent pagination contract — only one of nine list endpoints returns a total.                                                                                                                                            | medium  | [U]   |
| 12.9  | No API versioning or global prefix — the public contract cannot evolve without breaking integrators.                                                                                                                            | medium  | [U]   |
| 12.10 | Settlement/payout endpoints gated by `plans:write`, whose seeded meaning is "create/update plan templates".                                                                                                                     | medium  | [U]   |

## Slice 13 — Merchant-facing API

**Effort: L**

| #    | Finding                                                                                                                                                                                                                                  | Sev  | Conf |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| 13.1 | **No merchant API surface at all.** `merchant_owner` holds zero permissions and no user↔merchant link exists, so a merchant logs in and sees nothing. The tempting workaround (granting `merchants:read`) is a cross-tenant data breach. | high | [U]  |

## Slice 14 — Observability

**Effort: L**

| #    | Finding                                                                                                                                                                                      | Sev    | Conf |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| 14.1 | **Webhooks for untracked references, non-charge events and failed processing are dropped with no log, alert or sweeper** — Paystack telling us a customer was debited, discarded in silence. | high   | [V]  |
| 14.2 | No metrics of any kind — no counters, histograms or `/metrics`. `infra/observability/` is an empty stub. The `EventBus` is constructed with zero subscribers.                                | medium | [V]  |
| 14.3 | `packages/core` — the engine itself — has no logger port and emits zero diagnostic logs.                                                                                                     | medium | [V]  |
| 14.4 | Request/correlation IDs are a per-process counter — not unique, not ingested, not returned, not propagated.                                                                                  | medium | [V]  |
| 14.5 | Single `/health`: no liveness/readiness split, doesn't probe the BullMQ connection or report build version.                                                                                  | medium | [V]  |
| 14.6 | `Sentry.init` runs after the app graph is imported, defeating auto-instrumentation; tracing off by default; events never flushed on shutdown.                                                | medium | [V]  |

## Slice 15 — Test infrastructure

**Effort: M** · **do this early — it protects every other slice**

| #    | Finding                                                                                                                                                                                                                                                                                               | Sev    | Conf  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- |
| 15.1 | **The integration suite runs unscoped global sweeps against a shared DB with Vitest file-parallelism on.** The suite guarding every money path is order- and race-dependent.                                                                                                                          | high   | [U]   |
| 15.2 | `apps/api` has **no HTTP-layer tests at all** — 24 controllers, both guards, the exception filter and the webhook raw-body path. `PermissionsGuard` returns `true` when the decorator is absent, so a future money route that forgets it is open to any authenticated user, with no test to catch it. | high   | [U]   |
| 15.3 | No invariant/property test that the ledger balances globally.                                                                                                                                                                                                                                         | medium | [U]   |
| 15.4 | Hardcoded UNIQUE customer phone makes the applications suite fail on any re-run against a persistent DB. _(Independently observed during this session.)_                                                                                                                                              | medium | [U] ⊕ |
| 15.5 | No load, performance or soak test anywhere.                                                                                                                                                                                                                                                           | medium | [U]   |

---

## 4. Recommended order

1. **Slice 1 — Charge-path integrity** ⭐ (the only place money is actively double-taken)
2. **Slice 2 — Retry ladder + stuck-state recovery** (shares Slice 1's refactor)
3. **Slice 15 — Test infrastructure** (pull forward; it protects everything after)
4. **Slice 3 — Ledger cash-in**
5. **Slice 6 — SMS** (parallelisable at any point)
6. **Slice 4 — Settlement correctness**
7. **Slices 7 + 8 — Deployment + security**
8. **Slice 9 — Counter-offers + exposure**
9. **Slice 10 — Underwriting reality**
10. **Slices 5, 11–14** — refunds, lifecycle, API, observability

Slices 6, 7, 8 and 15 have no dependency on Tier 0 and can be interleaved by a second worker.

## 5. Before building against an `[U]` finding

Confirm it first with a direct read — those 37 never faced a refutation pass. The `⊕` items are lower risk because a second auditor reached the same conclusion independently.
