# Nesisoft Platform — Revised Roadmap

> **Project:** Installment engine **+** e-commerce marketplace for Ghana / West Africa
> **Owner:** Mr. Francis Anlimah · Nesisoft
> **Supersedes the _direction_ of** [`DEVELOPMENT-PLAN.md`](./DEVELOPMENT-PLAN.md) (which remains the canonical record for the **engine**, Phases 1–10 — now merged to `main`).
> **Design docs:** [`design/commerce-domain.md`](./design/commerce-domain.md) · [`design/mobile-apps.md`](./design/mobile-apps.md)
> **Status, 2026-10-28:** Phases 11–15 are built and on `main`. Phase 16 (admin console, ops and
> pilot launch) is in progress. §4 marks what each phase delivered; §6 holds the decisions still
> open; §7 is what stands between here and the pilot.

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

As built, each mobile app is also its side's website, exported for the web: the shopper app is
the shop's (it replaced `apps/customer-web`) and the seller app is the seller's (it replaced
`apps/merchant-web`). The scheduled jobs run from the API process behind
`ENABLE_SCHEDULED_WORKERS`.

---

## 3. Product surfaces

| Surface           | Form           | Who       | Highlights                                                                                                                                                                                                                             |
| ----------------- | -------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Customer app**  | Expo mobile 🛒 | Buyers    | Browse/search, product + **installment calculator**, cart, checkout (**pay-now or installment**), order tracking, "my plans" (pay-early/history), phone+OTP + Ghana-Card KYC                                                           |
| **Merchant app**  | Expo mobile 🏪 | Sellers   | Store + KYC/bank setup, **product upload** (photos, variants, inventory, plan offers), incoming orders, **mark shipped/delivered**, settlements/statements                                                                             |
| **Customer web**  | React web      | Buyers    | Shop, product, cart, checkout (pay-now or instalment, per-shop plans and deposits), orders, plans                                                                                                                                      |
| **Merchant web**  | React web      | Sellers   | Signup and KYC, shopfront, products, orders and fulfilment, plans, payout account, settlements and statements, analytics                                                                                                               |
| **Admin console** | React web      | Ops/staff | Engine ops (applications, plans, collections, plan templates, manual payments, refunds, ledger check) **+** marketplace ops (merchants and KYC, shops, listings, categories, orders, employers and employment checks, staff and roles) |
| **Open API**      | HTTP           | Partners  | Unchanged — BNPL-as-a-service via `order_reference`                                                                                                                                                                                    |

---

## 4. Revised phases (continuing after engine Phase 10)

Same format as `DEVELOPMENT-PLAN.md`: Goal · Deliverables · Definition of done. All money in pesewas; all state changes through state machines with audit rows; idempotency everywhere (the engine's Guiding Principles carry forward unchanged).

### Phase 11 — Commerce Foundation (catalog + storefront + shared client) — **built**

**Goal:** A merchant can create a store and list products with variants, images, stock, and installment offers. One typed API client serves every app.
**Deliverables:**

- New tables: `stores`, `categories`, `products`, `product_variants`, `product_images`, `inventory`, `product_plan_offers` (see `commerce-domain.md` §3.1)
- `catalog` + `stores` + `inventory` core modules; merchant product CRUD APIs; public catalog read/search (Postgres FTS)
- ~~`StorageService` (object storage + signed URLs) for images / Ghana Card~~ **built** —
  `packages/storage-client` (S3 / R2 / Spaces / MinIO, plus a local dev driver) behind
  `POST /merchant/uploads`, `/admin/uploads` and `/me/uploads`. See
  [`design/object-storage.md`](./design/object-storage.md).
- ~~`packages/api-types` generated from the OpenAPI spec; `packages/api-client`~~ **built
  differently** — `packages/api-types` is written by hand and held to the backend by
  `apps/api/src/common/api-types-mirror.spec.ts`; the clients are `packages/web-kit` (web) and
  `packages/mobile-kit` (Expo). `docs/api/openapi.json` is emitted from the API
  (`pnpm openapi:emit`) and was last regenerated on 2026-08-28.
  **Definition of done:** a merchant creates a store, uploads a product with images/variants/stock and a plan offer via API; catalog is queryable and searchable; every app can import the generated client.

### Phase 12 — Cart, Checkout & Orders — **built**

**Goal:** A buyer checks out a cart — paying now _or_ in installments — and the order flows through the engine unchanged.
**Deliverables:**

- New tables: `carts`, `cart_items`, `orders`, `order_items`, `addresses`
- Cart APIs; checkout that **splits a multi-vendor cart into one order per merchant**; inventory reservation (reserve → commit → release)
- **Pay-now path** via `PaymentService.chargeMobileMoney/chargeCard`; full-order settlement accrual (commission split, `commerce-domain.md` §6)
- **Installment path** via `ApplicationsService.submit(order_reference=order.id)` → decision → `CustomerPlansService.activateFromApplication`
- Order state machine + audit
  **Definition of done:** end-to-end checkout works both ways; internal order is indistinguishable to the engine from a partner order; ledger stays balanced; a declined application releases inventory and cancels the order.

**Status:** built. Checkout makes one order per shop, each with its own delivery fee and, on
instalments, its own plan and deposit. Pay-now takes Mobile Money or card (#51), and an order can
be paid again after a declined charge (#124). Commission is taken on the goods, not the delivery
(#128). One payment type covers the whole checkout — a basket cannot pay one shop now and finance
another.

### Phase 13 — Fulfilment & Post-Purchase — **built**

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
order when the window elapses.

Returns are now built too: a buyer requests one and can withdraw it, the seller decides it, and
an approved return refunds through the engine (#76, #85). Returning instalment goods either
forgives the instalments the refund covers or re-collects them (#133). A refund Paystack cannot
send can be paid by hand from the console, with the operator attesting they checked Paystack
first (#136; [`runbooks/refunds.md`](./runbooks/refunds.md)). Buyers can review what arrived (#85).
Disputes, beyond a return, are not built.

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

**Deferred at the time, since built:** Ghana Card capture (#75), push delivery to customers and
sellers (#69, #74), and returns (#76, #85).

**Still deferred:** live courier position; disputes beyond a return; KYC tier 2, which since #104
means a Ghana Card confirmed by the NIA — the NIA integration does not exist yet, so production
runs `ManualReviewGhanaCardVerifier` and a reviewed card is tier 1; and a stored-value wallet
balance, because holding customer funds in Ghana is e-money under the Bank of Ghana's Payment
Systems and Services Act — a licensing question rather than an engineering one.

**Settled: how a first-time customer gets approved.** The shipped ruleset could not approve a
customer with no repayment history — the signals that lift a score all need an existing plan. A
starter limit now approves them instead (#57, #66; `DEFAULT_STARTER_POLICY` in
`packages/core/src/modules/scoring/scoring-engine.ts`). It applies only to a thin file — no plan
ever completed, no default ever, nothing outstanding — with a verified Ghana Card, and caps what
the plan finances (the order less its deposit):

| Who vouches for them                        | Most financed |
| ------------------------------------------- | ------------- |
| A verified Ghana Card                       | GHS 250       |
| + a verified job at a live partner employer | GHS 750       |
| + payroll-deduction consent on that job     | GHS 2,000     |

Anyone who has borrowed before is scored on that record instead. See §6 item 9: the payroll tier
assumes a collection channel that is not built yet.

### Phase 15 — Merchant Mobile App (Expo) — **built**

**Goal:** A merchant runs their store from their phone.
**Deliverables:** `apps/merchant-mobile` (Expo): store/KYC/bank setup, product upload (photos/variants/inventory/plan offers), incoming orders, mark shipped/delivered, settlements/statements (`mobile-apps.md` §5)
**Definition of done:** a merchant onboards, lists a product, receives an order, marks it delivered (reserve releases), and views settlement — from the app.

**Status:** built as **Ejua Sell** (#77–#82): home and order queue, payouts, reserve and
performance, catalogue and sizes, instalment plans, shop setup, listing and editing, returns and
restock. The app also opens a shop from scratch (signup, then KYC) and exports monthly and
per-plan statements, and it is the seller website too, with a desktop layout; that retired the
separate `apps/merchant-web` portal. A seller who forgets their password resets it with a code
to the shop's phone, and can change it from the Shop tab. A payout account change needs a code sent to the seller's
phone and waits 24 hours, with a notice (#127, #130).

### Phase 16 — Admin Console (Web) + Marketplace Ops & Launch — **in progress**

**Goal:** Ops can run the marketplace; system is observable; pilot goes live. (Absorbs original Phase 10's polish items.)
**Deliverables:**

- `apps/admin-web` (React web): engine ops (applications, collections, scoring playground, plan-template editor, manual payments) **+** marketplace moderation (categories, product/store approval, disputes/returns)
- Rate limiting on public endpoints; observability dashboards (Sentry already wired; add Grafana/logs sink)
- Integration guide for partners; ops runbook; pilot merchant + first real test transactions
  **Definition of done:** all three apps usable; a pilot merchant lists products and sells to a pilot buyer (pay-now and installment); ops monitor via dashboards; partner integration documented.

**Done:**

- Console screens: applications, plan operations, orders (including confirming a payment made
  outside Paystack), refunds, collections, merchants (KYC review, opening the shop, who owes
  money), shops, listings with takedown, categories, customers (Ghana Card review, employment),
  employers and employment checks, plan templates, telco health, the ledger check, and staff and
  roles (#136, #138, #139 and earlier). Scoring has no standalone page; each application's page
  scores it.
- Rate limiting: a Redis-backed limit on every route (`RATE_LIMIT_*`), tighter on sign-in, the
  storefront and payout-account changes. Paystack webhooks are exempt.
- Runbooks: refunds, payouts, collections, reserve release, ledger imbalance, money repairs, the
  stand-in email domain ([`runbooks/`](./runbooks/)).
- `docs/api/openapi.json` regenerated (#141).
- [`partner-integration.md`](./partner-integration.md): the partner flow as it runs today, and
  why it cannot be opened to partners yet.
- Metrics, alert rules, a Grafana dashboard and a log-shipping guide
  ([`infra/observability`](../infra/observability/README.md), #145).
- A Render Blueprint for the API and the three web apps, against Supabase, Upstash and Cloudflare
  R2, with the setup for testing locally and on devices
  ([`deployment/render.md`](./deployment/render.md)).
- Staff passwords: anyone can change their own, and an administrator can reset a member of
  staff's. A password an administrator chose — at creation or a reset — is temporary and grants
  nothing until its owner replaces it. A password change or reset signs the account out everywhere
  else (`users.token_version`).

**Remaining:**

- A partner API: partner credentials, routes scoped to the partner, decisions made by scoring
  rather than the caller, and outbound webhooks — see
  [`partner-integration.md`](./partner-integration.md) §3. Not needed for a marketplace pilot.
- The pilot itself: a pilot merchant, a pilot buyer, and the first real transactions.

---

## 5. Rough estimates

| Phase | Focus                                         | Est. (wks) | Status      |
| ----- | --------------------------------------------- | ---------- | ----------- |
| 11    | Commerce foundation + shared client + storage | 2.5        | Built       |
| 12    | Cart, checkout, orders (both payment paths)   | 2.5        | Built       |
| 13    | Fulfilment, delivery→reserve, returns         | 1.5        | Built       |
| 14    | Customer auth + Expo customer app             | 3.5        | Built       |
| 15    | Expo merchant app                             | 3          | Built       |
| 16    | Admin web + ops + pilot launch                | 3          | In progress |
|       | **Total (additive to the engine)**            | **~16**    |             |

Sequencing: 11 → 12 → 13 are backend and unblock everything; 14/15 (mobile) can overlap once 12 is stable; 16 closes out.

---

## 6. Key decisions still open (owner input needed)

Items 1–8 were carried from `commerce-domain.md` §9 + `mobile-apps.md` §6. Items 9 onward came
out of the build. Struck-through items are settled; the text after each says how.

1. ~~**Multi-vendor cart**~~ **Built as one order per merchant.** Mixing pay-now and instalment
   across a basket's shops is not supported: one payment type covers the checkout.
2. ~~**Commission model**~~ **Settled per merchant.** Each merchant has a commission rate,
   negotiable, with a separate negotiable rate for paid-in-full orders (#100, #102); it is taken on
   the goods, not the delivery (#128). Instalment plans carry a credit reserve per plan model.
   There are no per-category rates.
3. **Guest checkout** — not built: both payment paths need a signed-in customer. Still open
   whether pay-now should allow it.
4. ~~**Fulfilment**~~ **Merchant self-fulfils**, by courier (priced by `delivery_zones`) or
   pickup from a hub. No integrated couriers.
5. ~~**Object storage provider** — S3 / GCS / Cloudflare R2?~~ **Deferred by design.** The
   signer is hand-rolled SigV4, so S3, Cloudflare R2, DigitalOcean Spaces and MinIO all work
   against the same driver — picking one stays a config change, and R2's zero egress is the
   obvious default for Ghana-facing bandwidth.
6. ~~**Mobile component kit**~~ **Decided: neither.** The design is entirely bespoke, so a kit
   would be styling overhead with no components used, and NativeWind's Babel transform plus Metro
   wrapper is the fragile part of a pnpm workspace. `apps/customer-mobile` uses a typed token
   module plus `StyleSheet` — zero build risk, exhaustively typed, and the tokens are the design's
   own values.
7. ~~**Where are the existing UI/UX designs?**~~ **Resolved** — the customer app canvas
   (`Ejua_Shop.dc.html`) is now the built design; its tokens live in
   `apps/customer-mobile/src/theme/tokens.ts` and the reconciliation in
   [`design/customer-app.md`](./design/customer-app.md).
8. ~~**First-order credit appetite**~~ **Settled by the starter limit** — see Phase 14.
9. **The payroll tier has no payroll collection.** Payroll-deduction consent lifts a first-time
   customer to GHS 2,000 and doubles a scored customer's limit, on the premise that the employer
   remits from salary. Nothing collects through an employer yet — repayments still come from the
   customer's MoMo or card. Either build employer remittance (payroll files and reconciliation)
   or lower that tier until it exists.
10. **Consent without verification.** The doubling in item 9 applies even when the job behind
    the consent has not been verified; the starter tiers already require verification. Whether
    the doubling should too is a scoring-policy call (raised in #139).
11. **NIA integration** for KYC tier 2 — see Phase 14. Until it lands, every verified Ghana Card
    is a person's review of a scan.
12. **Past rent-to-own defaults.** Since #134 Ejua carries a rent-to-own default beyond the
    reserve, as for BNPL. Defaults booked before that kept their claw-back from the seller.
    Whether to compensate those sellers is open.
13. **`ejua.gh` is not registered.** Customers who signed up by phone are charged with a stand-in
    address at `customers.ejua.gh`, and Paystack emails a receipt there for every charge. Until
    the domain is registered with a null MX, anyone could register it and receive them
    ([`runbooks/standin-email-domain.md`](./runbooks/standin-email-domain.md)).
14. ~~**Escrow for seller refunds**~~ **Decided against.** Sellers are paid daily; a seller whose
    balance goes negative after returns is watched and alerted on instead (#135).

---

## 7. Immediate next step

Close out Phase 16 and run the pilot:

1. A test deployment on Render ([`deployment/render.md`](./deployment/render.md)), every app tried
   end to end on Paystack's test keys.
2. Settle §6 items 9 and 13 before real money moves: the payroll tier lends against a
   collection channel that does not exist, and the receipt domain is unregistered.
3. Paystack transfers enabled on the live account — in test mode every payout was refused with
   "You cannot initiate third party payouts as a starter business"
   ([`runbooks/payouts.md`](./runbooks/payouts.md)).
4. Pilot: one merchant, one buyer, pay-now and instalment, end to end on live Paystack.
5. Before any outside partner: the partner API in
   [`partner-integration.md`](./partner-integration.md) §3.
