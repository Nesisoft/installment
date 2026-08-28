# Nesisoft Platform — Revised Roadmap

> **Project:** Installment engine **+** e-commerce marketplace for Ghana / West Africa
> **Owner:** Mr. Francis Anlimah · Nesisoft
> **Supersedes the _direction_ of** [`DEVELOPMENT-PLAN.md`](./DEVELOPMENT-PLAN.md) (which remains the canonical record for the **engine**, Phases 1–10 — now merged to `main`).
> **Design docs:** [`design/commerce-domain.md`](./design/commerce-domain.md) · [`design/mobile-apps.md`](./design/mobile-apps.md)

---

## 1. Context — why this roadmap exists

The build so far delivered a high-quality **installment payment engine** exactly as `DEVELOPMENT-PLAN.md` specced it: a standalone API microservice (scoring, schedules, ledger, settlement, reserves, collections), consumable by external partners via an opaque `order_reference`. Phases 1–10 are done and merged.

But the **intended product** is larger: a **marketplace** where buyers browse and purchase products (pay now _or_ in installments) from mobile, and sellers upload products and fulfil orders from mobile — _while_ the installment engine remains an open API other platforms can use. The original plan captured only the engine half; it never included a product catalog, cart, internal orders, fulfilment, or mobile apps. This roadmap adds that half.

**Decision taken:** _Marketplace **on** the engine._ Keep the engine as the reusable open-API core; build the commerce layer and Expo apps on top. The marketplace becomes the engine's first **first-party** consumer, alongside third-party partners (Ejua, Meko, Pharmacy POS).

**Nothing built is wasted** — a marketplace with integrated BNPL needs precisely this engine underneath. The remaining work is _additive_.

---

## 2. Target architecture

```
  ┌─────────────────┐   ┌─────────────────┐   ┌────────────────┐      External partners
  │ customer-mobile │   │ merchant-mobile │   │   admin-web    │      (Ejua, Meko, POS)
  │   (Expo) 🛒     │   │   (Expo) 🏪     │   │  (React web)   │             │
  └────────┬────────┘   └────────┬────────┘   └───────┬────────┘             │ open API +
           └─────────────┬───────┴────────────────────┘                      │ their order_reference
                         ▼                                                    │
              ┌──────────────────────┐                                        │
              │   COMMERCE LAYER      │  (new — Phases 11–13)                  │
              │  catalog · cart ·     │                                        │
              │  orders · fulfilment  │                                        │
              └──────────┬───────────┘                                        │
                         │  order.id AS order_reference                       │
                         ▼                                                     ▼
        ┌────────────────────────────────────────────────────────────────────────┐
        │  INSTALLMENT ENGINE  (Phases 1–10, built ✓ — UNCHANGED)                 │
        │  applications · scoring · schedules · payments · settlement ·           │
        │  reserves · collections · double-entry ledger · workers                 │
        └────────────────────────────────────────────────────────────────────────┘
```

The engine is never modified by the commerce layer — the commerce layer creates an internal order and hands the engine `order_reference = order.id`. Full detail: [`design/commerce-domain.md`](./design/commerce-domain.md) §2.

---

## 3. Product surfaces

| Surface           | Form           | Who       | Highlights                                                                                                                                                                   |
| ----------------- | -------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Customer app**  | Expo mobile 🛒 | Buyers    | Browse/search, product + **installment calculator**, cart, checkout (**pay-now or installment**), order tracking, "my plans" (pay-early/history), phone+OTP + Ghana-Card KYC |
| **Merchant app**  | Expo mobile 🏪 | Sellers   | Store + KYC/bank setup, **product upload** (photos, variants, inventory, plan offers), incoming orders, **mark shipped/delivered**, settlements/statements                   |
| **Admin console** | React web      | Ops/staff | Existing engine ops (applications, collections, scoring, plan templates, manual payments) **+** marketplace moderation (categories, product/store approval, disputes)        |
| **Open API**      | HTTP           | Partners  | Unchanged — BNPL-as-a-service via `order_reference`                                                                                                                          |

---

## 4. Revised phases (continuing after engine Phase 10)

Same format as `DEVELOPMENT-PLAN.md`: Goal · Deliverables · Definition of done. All money in pesewas; all state changes through state machines with audit rows; idempotency everywhere (the engine's Guiding Principles carry forward unchanged).

### Phase 11 — Commerce Foundation (catalog + storefront + shared client)

**Goal:** A merchant can create a store and list products with variants, images, stock, and installment offers. One typed API client serves every app.
**Deliverables:**

- New tables: `stores`, `categories`, `products`, `product_variants`, `product_images`, `inventory`, `product_plan_offers` (see `commerce-domain.md` §3.1)
- `catalog` + `stores` + `inventory` core modules; merchant product CRUD APIs; public catalog read/search (Postgres FTS)
- `StorageService` (object storage + signed URLs) for images / Ghana Card
- `packages/api-types` generated from the OpenAPI spec; `packages/api-client` (typed + TanStack Query hooks)
  **Definition of done:** a merchant creates a store, uploads a product with images/variants/stock and a plan offer via API; catalog is queryable and searchable; every app can import the generated client.

### Phase 12 — Cart, Checkout & Orders

**Goal:** A buyer checks out a cart — paying now _or_ in installments — and the order flows through the engine unchanged.
**Deliverables:**

- New tables: `carts`, `cart_items`, `orders`, `order_items`, `addresses`
- Cart APIs; checkout that **splits a multi-vendor cart into one order per merchant**; inventory reservation (reserve → commit → release)
- **Pay-now path** via `PaymentService.chargeMobileMoney/chargeCard`; full-order settlement accrual (commission split, `commerce-domain.md` §6)
- **Installment path** via `ApplicationsService.submit(order_reference=order.id)` → decision → `CustomerPlansService.activateFromApplication`
- Order state machine + audit
  **Definition of done:** end-to-end checkout works both ways; internal order is indistinguishable to the engine from a partner order; ledger stays balanced; a declined application releases inventory and cancels the order.

### Phase 13 — Fulfilment & Post-Purchase

**Goal:** Sellers fulfil orders; delivery drives reserve release; returns issue refunds.
**Deliverables:**

- `shipments` (+ `returns`, `reviews` optional); fulfilment APIs (mark shipped/delivered)
- Delivery → `ReserveReleaseService.markDelivered` wiring (closes the layaway reserve loop with a real signal)
- Returns → existing refund flow; order lifecycle completion (full vs installment convergence)
  **Definition of done:** marking delivered releases the layaway reserve on the real event; a return issues a correct proportional refund; order reaches `COMPLETED` on both paths.

**Status:** the fulfilment half is **built** — `FulfilmentService` walks an order
`paid|financing_active → fulfilling → shipped → delivered → completed`, records a
customer-readable event at each step, carries the courier on `shipments`, stamps the return window,
and fires `ReserveReleaseService.markDelivered` on a real delivery. `ReturnWindowCron` closes the
order when the window elapses. **Returns are still outstanding** — the customer-initiated return
journey does not exist, though the engine's refund path does.

### Phase 14 — Customer Auth + Customer Mobile App (Expo) — **built**

**Goal:** A buyer completes a full purchase from their phone in test mode.
**Delivered** (see [`design/customer-app.md`](./design/customer-app.md) for the full
design→engine reconciliation):

- **Customer auth** (phone + OTP) — already existed; the app hides the sign-in/sign-up split
  behind one phone field, because a shopper does not know which they are
- **Storefront reads a shopping app can render** — image URLs, vendor names, ratings, sold
  counts, sort/filter/price bands, totals, a home feed, trending searches
- **`POST /storefront/plan-quote`** — the engine's own `ScheduleGenerator`, so the preview on the
  product and checkout screens is the schedule the plan will actually have
- **Auto-decision at checkout** — instalment checkout now scores, activates and returns the plan
  and deposit. Before this the order parked in `pending_approval` waiting for staff, and the
  "approved in seconds" flow could not complete at all
- **Fulfilment** — courier vs pickup, `delivery_zones` pricing, `pickup_hubs`, and
  `orders.shipping_pesewas` finally written
- **Late-fee engine** — rate and cap on templates and plans, accrued daily
- **Auto-debit switch**, cross-plan instalments feed, credit standing, order tracking, reviews,
  wishlist, push-token registration
- **`apps/customer-mobile`** (Expo SDK 57 / RN 0.86): onboarding, home, search, browse+filters,
  product, vendor, cart, checkout + BNPL approval sheet, confirmation, orders, tracking,
  instalments, wallet & payments, account
- **`packages/mobile-kit`** — API client, SecureStore session, query defaults, idempotency

**Deferred, with the seam left in place:** Ghana Card capture (KYC tier 2), push _delivery_
(registration ships), live courier position, returns/disputes, and a stored-value wallet balance —
that last one because holding customer funds in Ghana is e-money under the Bank of Ghana's
Payment Systems and Services Act, a licensing question rather than an engineering one.

**⚠ Open business decision surfaced by the build.** With the shipped ruleset a **first-time
customer cannot be auto-approved**. The reachable score for someone with no repayment history
tops out around 325 (no prior defaults 50 + low failure rate 50 + payment diversity 25 + KYC
tier 2 100 + account age 100), and 350 is the floor for `subprime` → manual review, 500 for
`near_prime` → approval. The signals that would lift them — `score.on_time_rate`,
`score.consecutive_on_time`, `score.paystack_history` — all require an existing plan, so the
first order is always declined or sent to review. The design's "Approved in seconds against your
MoMo history" is therefore only reachable for a _returning_ customer. This is a risk-appetite
call, not a bug: the options are a first-order ruleset variant, a starter limit for
Ghana-Card-verified customers, or accepting manual review on the first purchase. The app already
renders all three outcomes honestly.

### Phase 15 — Merchant Mobile App (Expo)

**Goal:** A merchant runs their store from their phone.
**Deliverables:** `apps/merchant-mobile` (Expo): store/KYC/bank setup, product upload (photos/variants/inventory/plan offers), incoming orders, mark shipped/delivered, settlements/statements (`mobile-apps.md` §5)
**Definition of done:** a merchant onboards, lists a product, receives an order, marks it delivered (reserve releases), and views settlement — from the app.

### Phase 16 — Admin Console (Web) + Marketplace Ops & Launch

**Goal:** Ops can run the marketplace; system is observable; pilot goes live. (Absorbs original Phase 10's polish items.)
**Deliverables:**

- `apps/admin-web` (React web): engine ops (applications, collections, scoring playground, plan-template editor, manual payments) **+** marketplace moderation (categories, product/store approval, disputes/returns)
- Rate limiting on public endpoints; observability dashboards (Sentry already wired; add Grafana/logs sink)
- Integration guide for partners; ops runbook; pilot merchant + first real test transactions
  **Definition of done:** all three apps usable; a pilot merchant lists products and sells to a pilot buyer (pay-now and installment); ops monitor via dashboards; partner integration documented.

---

## 5. Rough estimates

| Phase | Focus                                         | Est. (wks) |
| ----- | --------------------------------------------- | ---------- |
| 11    | Commerce foundation + shared client + storage | 2.5        |
| 12    | Cart, checkout, orders (both payment paths)   | 2.5        |
| 13    | Fulfilment, delivery→reserve, returns         | 1.5        |
| 14    | Customer auth + Expo customer app             | 3.5        |
| 15    | Expo merchant app                             | 3          |
| 16    | Admin web + ops + pilot launch                | 3          |
|       | **Total (additive to the engine)**            | **~16**    |

Sequencing: 11 → 12 → 13 are backend and unblock everything; 14/15 (mobile) can overlap once 12 is stable; 16 closes out.

---

## 6. Key decisions still open (owner input needed)

Carried from `commerce-domain.md` §9 + `mobile-apps.md` §6 — these shape Phases 11–12 and should be settled first:

1. **Multi-vendor cart** → one order per merchant (recommended); allow mixed pay-now/installment per merchant-order?
2. **Commission model** — flat marketplace take-rate (bps) on all orders + credit reserve on installment only? Per-category rates?
3. **Guest checkout** — allowed for pay-now, blocked for installment (BNPL requires Ghana-Card-verified KYC)?
4. **Fulfilment** — v1 merchant self-fulfils with manual status; integrated couriers later?
5. **Object storage provider** — S3 / GCS / Cloudflare R2?
6. ~~**Mobile component kit**~~ **Decided: neither.** The design is entirely bespoke, so a kit
   would be styling overhead with no components used, and NativeWind's Babel transform plus Metro
   wrapper is the fragile part of a pnpm workspace. `apps/customer-mobile` uses a typed token
   module plus `StyleSheet` — zero build risk, exhaustively typed, and the tokens are the design's
   own values.
7. ~~**Where are the existing UI/UX designs?**~~ **Resolved** — the customer app canvas
   (`Ejua_Shop.dc.html`) is now the built design; its tokens live in
   `apps/customer-mobile/src/theme/tokens.ts` and the reconciliation in
   [`design/customer-app.md`](./design/customer-app.md).
8. **First-order credit appetite** — see the ⚠ under Phase 14. Nothing else in the build is
   blocked on it, but the shopper experience of a first purchase depends entirely on the answer.

---

## 7. Immediate next step

No code yet — this roadmap + the two design docs are the re-anchoring deliverable. Once you confirm the direction and settle the decisions in §6 (especially the commission model, KYC/guest rules, and where your designs live), the natural first build is **Phase 11** on a fresh branch off `main` (the engine is already merged there).
