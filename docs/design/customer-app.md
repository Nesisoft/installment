# Ejua Customer App — design → engine reconciliation

> **Status:** Implementation record for `apps/customer-mobile`.
> **Design source:** `Ejua_Shop.dc.html` (customer app canvas, 14 screens + 2 sheets).
> **Companions:** [`mobile-apps.md`](./mobile-apps.md) · [`commerce-domain.md`](./commerce-domain.md) · [`../PLATFORM-ROADMAP.md`](../PLATFORM-ROADMAP.md)

The design was drawn against the *product vision*; the engine was built against
`DEVELOPMENT-PLAN.md`. This document is where the two are reconciled, screen by
screen: what the backend gained so the design could be told truthfully, what the
design gave up because the engine's rule is different (and better), and what is
deliberately deferred.

The governing rule throughout: **the app never invents a number.** Every cedi,
date and status on screen comes from the engine. Where the design showed a
figure the engine could not produce, we either built the backend to produce it
or changed the design — never faked it.

---

## 1. Screen → endpoint map

| # | Screen | Reads | Writes |
|---|---|---|---|
| 1 | Onboarding | — | `POST /auth/customer/signup/start` → `verify-code` → `complete`; `POST /auth/customer/otp/start` → `otp/verify` |
| 2 | Home | `GET /storefront/home` | — |
| 3 | Search | `GET /storefront/search`, `GET /storefront/trending` | (search terms are logged server-side) |
| 4 | Browse + filters | `GET /storefront/products` (`category_id`, `q`, `sort`, `min_price_pesewas`, `max_price_pesewas`, `installment_only`, `in_stock`) | — |
| 5 | Product | `GET /storefront/products/:id`, `POST /storefront/plan-quote`, `GET /storefront/delivery-quote` | `POST /me/wishlist` |
| 6 | Vendor | `GET /storefront/stores/:slug`, `GET /storefront/products?store_id=` | — |
| 7 | Cart | `GET /me/cart`, `POST /storefront/plan-quote` | `POST/PUT/DELETE /me/cart/items` |
| 8 | Checkout | `GET /me/addresses`, `GET /storefront/pickup-hubs`, `GET /storefront/delivery-quote`, `GET /storefront/plan-templates`, `POST /storefront/plan-quote` | `POST /me/checkout` |
| 9 | BNPL sheet | `GET /me/credit` | `POST /me/checkout` (auto-decision) → `POST /me/installments/:id/pay-momo` |
| 10 | Confirmation | `GET /me/orders/:id` (carries `plan` + `schedule`) | — |
| 11 | Orders | `GET /me/orders`, `GET /me/installments?status=due` | — |
| 12 | Tracking | `GET /me/orders/:id`, `GET /me/orders/:id/tracking` | — |
| 13 | Installments | `GET /me/installments`, `GET /me/plans/:id/schedule` | `POST /me/plans/:id/autopay`, `POST /me/installments/:id/pay-momo` |
| 14 | Wallet | `GET /me/credit`, `GET /me/activity`, `GET /me/profile` | `POST /me/momo` |
| 15 | Account | `GET /me/profile`, `GET /me/wishlist` | `PATCH /me/profile` |

---

## 2. What the backend gained

Each item existed only in the design before this change.

### 2.1 Catalogue reads a shopping app can render

`ProductsService.list` / `.search` returned bare `products` columns: no image, no
vendor, no price comparison, no counts. Six screens render a product card of
*image + vendor + title + price + "or GHS X/week"*, so the projection now carries
`primary_image_url`, `store_slug`, `store_display_name`, `compare_at_price_pesewas`,
`rating_avg`, `rating_count`, `sold_count` and `installment_eligible`.

`product_images.storage_key` is an object-storage key, not a URL. `MEDIA_BASE_URL`
now resolves every key to an absolute `url` server-side, so no client has to know
the storage layout — and a future move to signed URLs changes one function
instead of four apps.

Public reads also now exclude products whose **store** is not active. That was a
straight bug: a suspended store's products were still listed and still
purchasable.

### 2.2 Sorting, filtering and totals

The filter sheet offers sort (Popular / price ↑ / price ↓ / Top rated), a payment
filter and price bands, and the browse header shows "N items". None of it was
expressible. `GET /storefront/products` and `/storefront/search` now take
`q`, `sort`, `min_price_pesewas`, `max_price_pesewas`, `installment_only`,
`in_stock`, and both return `{ rows, total }` — the `Paginated<T>` shape
`@installment/api-types` already declared but nothing returned.

### 2.3 A plan quote that is the engine's own arithmetic

The design shows a full schedule on the product and checkout screens *before any
plan exists*. `apps/customer-web` approximated it in
`lib/installment-preview.ts` — and the approximation was wrong: it computed
`total = financed + interest + fees`, where the engine computes
`total = order + interest + fees`, and it divided evenly instead of spreading the
rounding remainder a pesewa at a time onto the earliest rows.

`POST /storefront/plan-quote` now runs **the engine's own `generateSchedule`** and
returns the exact rows that would be created. There is no second implementation
to drift. `apps/customer-web` was moved onto it and its local preview deleted.

### 2.4 Fulfilment: courier vs pickup, and a real delivery fee

`orders.shipping_pesewas` existed and was never written — `total = subtotal`, and
"Delivery to Osu · GHS 15" had nothing behind it. Checkout now accepts
`fulfilment_method` (`courier` | `pickup`) and `pickup_hub_id`, prices the
delivery from a `delivery_zones` table (region/city → fee + ETA window), and
writes `shipping_pesewas` into the order and the total. `pickup_hubs` backs the
hub picker.

### 2.5 BNPL approved in seconds

This was the largest gap. Installment checkout submitted an application and
stopped: scoring was `POST /admin/applications/:id/score` and activation was
`POST /admin/plans/from-application/:id`, both staff-only. A customer checking
out on their phone got an order stuck in `pending_approval` with no plan, no
schedule and no way to pay the deposit — the flow the whole app is built around
could not complete.

Checkout now runs an **auto-decision** immediately after the checkout
transaction commits: score → on `approved`, activate the plan and generate the
schedule → on `declined`, decline the order and release the stock → on
`review`, leave the order in `pending_approval` and tell the customer it is being
reviewed. The three outcomes are exactly the three states the BNPL sheet renders.

Scoring and activation each open their own transaction (they always did), so the
decision runs after the commit, not inside it. A crash between the two leaves an
approved application whose order is still `pending_approval` — recoverable by the
existing admin activation path, which is why that path stays.

### 2.6 A cross-plan installments feed

Home shows "GHS 260 due Friday", Orders shows a due strip per order, and the
Installments screen lists everything. All three needed *the customer's
installments across every plan*, which only existed per-plan behind
`GET /me/plans/:id/schedule`. `GET /me/installments` returns them in one call,
each row carrying the plan, the order and the product title it belongs to, with
`?status=due|upcoming|paid|overdue`.

### 2.7 Credit limit, on-time record, and the payment activity feed

`GET /me/credit` exposes the approved limit, how much of it is in use (the sum of
active plans' outstanding), what is available, and the on-time/late counters now
maintained on `credit_profiles`. `GET /me/activity` returns the customer's real
money movements — installment payments, order payments and refunds — which is
what the Wallet screen's "RECENT ACTIVITY" list shows.

### 2.8 A late-fee engine that matches the copy

The design and the business proposal both promise "3-day grace, then 2% per week,
capped at 15%". `plan_templates.late_fee_pesewas` was a flat amount, was never
copied onto a plan, and `installment_schedule.late_fee_pesewas` was read in five
places and written in none — no accrual existed. Templates and plans now carry
`late_fee_bps_per_week` and `late_fee_cap_bps`, and `LateFeeCron` accrues onto
overdue rows daily. Collection was already correct: a charge takes
`amount_due + late_fee`.

### 2.9 Auto-debit the customer can switch off

The debit sweep was unconditional, while the Installments screen offers a toggle.
`customer_plans.autopay_enabled` now gates `listDueForAutoDebit`, and
`POST /me/plans/:id/autopay` flips it. Switching it off does not waive anything —
the copy says so, and the late-fee accrual proves it.

### 2.10 Order tracking and fulfilment

The tracking screen draws an 8-step lifecycle. `order_events` records every
order transition with its timestamp and a customer-readable label, and
`shipments` carries the courier, the tracking code and the ETA.
`GET /me/orders/:id/tracking` returns both.

The write side is `FulfilmentService`: `startFulfilment`, `markShipped`,
`markOutForDelivery` and `markDelivered`, exposed merchant-scoped at
`POST /merchant/orders/:id/{fulfilling,ship,out-for-delivery,delivered}`.

Delivery is the event the rest of the system waits on. It stamps
`orders.delivered_at` and `return_window_ends_at` from the order's own term,
makes the line reviewable, and — on a financed order — calls the engine's
`CustomerPlansService.markDelivered`, which is what finally releases the layaway
reserve against a real signal rather than a staff member's estimate.

"Out for delivery" is deliberately a *shipment* status, not an order status: it
is a courier state, and inventing an order status for it would put a value in
the column that no other consumer of the order lifecycle understands.

`ReturnWindowCron` closes `delivered` orders once the window elapses. Hourly,
not daily: the window is a timestamp, so a daily sweep would hold a merchant's
money up to a day longer than the terms promise.

### 2.11 Reviews, wishlist, trending, devices

`product_reviews` (rating 1–5, gated on a delivered order line, unique per line)
backs the star ratings on four screens and the vendor stat row. `wishlist_items`
backs the product heart and "Saved items". `search_queries` backs "TRENDING IN
ACCRA" with real counts, scoped by city. `push_devices` registers the Expo push
token so the notification channel has somewhere to send.

---

## 3. What the design gave up

The design's numbers were drawn before the engine's rules were settled. Where
they disagree, **the engine wins** and the app renders the engine's figure.

### 3.1 "Pay in 4" is one deposit plus three installments

The engine's `number_of_installments` **excludes** the down-payment row, and
`generateSchedule` emits the deposit as sequence 1. So "pay in 4" is a template
with `down_payment_bps = 4000` and `number_of_installments = 3`, producing four
rows. Anything counting instalments for display ("installment 2 of 4") uses
`schedule.length`, never `plan.number_of_installments`. Getting this backwards
would tell a customer they owe a fifth payment.

### 3.2 The plan's terms come from the template, not from the design

The design hard-codes 40% down, weekly, 0% interest. Those are properties of
whichever `plan_templates` row is active, and a merchant can offer several. Every
screen reads the template and the quote; nothing hard-codes 40 or 4. The
onboarding copy keeps "40% today" only because the seeded default template says
so — it is generated from the template, not typed into the design.

### 3.3 "We retry twice" → the real retry policy

`RETRY_POLICY` is four attempts — +0h, +4h, +24h auto-debit, then a payment link
at +48h. The Installments screen says that, because a customer who is told two
and sees four is being misled about their own money.

### 3.4 Friday is not guaranteed

Due dates are `start + i × installment_frequency_days` in UTC. There is no
weekday anchoring, so a plan started on a Tuesday falls due on Tuesdays. The app
renders the actual due date; "each Friday" became "every {cadence}" and the
schedule shows real dates. Weekday anchoring is a genuine product option, but it
is a scheduling change in the engine, not a label in the app.

### 3.5 "0% interest on your first order" is not a rule that exists

There is no first-order concept and no per-customer interest override. The app
shows the template's actual interest, and the badge appears only when the quote's
interest is genuinely zero. A promotional first-order template is the honest way
to ship the offer, and that is a merchandising decision, not a client one.

### 3.6 The Wallet is a payments hub, not stored value

The design's Wallet leads with "AVAILABLE BALANCE GHS 148.50 / Top up / Withdraw".
**We did not build stored value.** Holding customer funds in Ghana is e-money
under Bank of Ghana's Payment Systems and Services Act — a licensing question,
not an engineering one — and the double-entry ledger has no customer liability
account to hold it.

The screen keeps everything that is real and drops the balance: the Ejua limit
with its in-use bar, the on-time record, the primary MoMo method, and the
activity feed of actual payments and refunds. It is renamed **Wallet & payments**.
The `customer_float` ledger account type already exists as the seam if stored
value is licensed later.

### 3.7 Escrow copy is accurate but the window is the merchant's

"The vendor is paid only after your 7-day return window closes" is true — that is
`held_reserves` + `ReserveReleaseService.markDelivered`. The window length is
`orders.return_window_days`, set per order from the store's policy, so the copy
renders the order's real number instead of a hard-coded 7.

---

## 4. Deliberately deferred

> **Audited and corrected.** Three rows of the original table had shipped and
> the table still called them deferred, which is how the list stopped being
> read. What follows is what is actually outstanding; §4.1 records what was
> already done, and §6 the holes the audit found.

| Deferred | Why | Seam left behind |
|---|---|---|
| Stored-value wallet balance, top-up, withdraw | e-money licensing (§3.6) | `customer_float` ledger account. **Note:** the original table named `GET /me/activity` as the seam. That route does not exist and never did. |
| Live courier position ("4 stops away") | needs a courier integration; `shipments` carries status and ETA only | `shipments.tracking_code`, `courier_phone` |
| Per-item returns | `order_items` has no status column, so returning one shirt of three would leave `orders.status = 'returned'` lying about the order | `order_returns` is whole-order by design |
| Disputes | separate from returns: a return is the seller's to decide, a dispute is Ejua's | — |

### 4.1 Done, and the table said otherwise

| Was listed deferred | Actually shipped |
|---|---|
| Ghana Card capture in-app | `apps/customer-mobile/app/ghana-card.tsx` (#75) — camera or library, presigned upload, `POST /me/ghana-card` |
| Push *delivery* (registration ships) | `PushNotifier` and the whole transport (#69, #74). **But see §7.2 — no handset registers, so nothing arrives.** |
| Returns/disputes flow | `ReturnsService`, `POST /me/orders/:id/return`, and the seller's queue and decision screens (#76, #82). **But see §7.3 — the buyer has no screen to start one.** |
| Merchant app | `apps/merchant-mobile`, Phases 15 complete — see [`merchant-app.md`](./merchant-app.md) |

---

## 5. Client architecture

```
apps/customer-mobile/
  app/                       Expo Router routes — one file per screen
  src/
    theme/                   tokens lifted from the canvas; no screen invents a colour
    components/              primitives (Button, Screen, Money, Pill, Sheet, …)
    features/<domain>/       one module per API domain: typed hooks + shapes
    lib/                     formatting, dates, session
packages/mobile-kit/         API client, SecureStore session, query defaults, idempotency
packages/api-types/          shared with web — the single source of wire types
```

**Why no NativeWind / Tamagui / gluestack.** `PLATFORM-ROADMAP.md` §6.6 left the
component kit open. The design is entirely bespoke — there is no off-the-shelf
kit whose defaults it wants — so a kit would be styling overhead with no
components used. NativeWind additionally needs a Babel transform and a Metro
wrapper, which is the fragile part of a pnpm workspace. We use a typed token
module plus `StyleSheet`: zero build risk, exhaustively typed, and the tokens are
the design's own values.

**Money and time.** Every amount is integer pesewas end to end; formatting
happens once, at the edge, in `lib/format.ts`. Timestamps need care — the API's
`timestamptz` columns are declared `mode: 'string'` but `node-postgres` re-serialises
them as `YYYY-MM-DD HH:mm:ss.SSS+00` (space separator, 2-digit offset), which
Hermes parses as `Invalid Date`. `lib/dates.ts` normalises before parsing, and
nothing else in the app calls `new Date()` on an API string.

**Idempotency.** Every money-moving call carries an `Idempotency-Key` minted per
*logical attempt* and reused verbatim on retry. Approving a MoMo prompt means
leaving the app, so a customer returning to a spinner and tapping again is the
normal case, not the edge case — a fresh key there would be a second debit.

---

## 6. What the audit found

Recorded here because each is the same shape as the bugs in §2 and §3 — a
field, route or rule that cannot do what the app implies it does — and because
the last five slices were spent building screens over the top of them.

Everything in §6.1–§6.8 was verified by reading the code. §7.9 was reported by
a single pass whose adversarial verification never ran, and is listed as
unconfirmed on purpose.

### 6.1 A shopper could not be approved for instalments — *fixed*

`gate.age_range` is a hard gate that declines an age it does not know ("Age out
of range or unknown"), `IdentityCollector` derives that age from
`customers.date_of_birth` alone, and `date_of_birth` was on the admin schemas
only. A self-signed-up customer carried a NULL birthday for good.

It did not bite at signup, which is what made it survive: `gate.age_range` is
the **last** of six gates, so a new account is turned away by
`gate.ghana_card_verified` long before its age is read. It bit the shopper who
did everything asked of them — signed up, sent their card, had it approved,
waited out the SIM-age rule — and was then declined on a birthday nobody asked
for.

Three things hid it: `dev-fixtures.sql` sets a birthday, so demo data always
passed; the orders integration specs approve by hand
(`recordDecision({outcome:'approved'})`) so no test put a real signup in front
of a real scoring run; and the gate ordering means the obvious manual check —
"can a new account borrow?" — answers no either way, for an expected reason.

Fixed by `adultDateOfBirth` (`core/src/shared/validators/date-of-birth.ts`) on
both signup schemas and on the shopper's own profile patch, with
`auth/signup-age.integration.spec.ts` closing the gap: a real signup on one
side, `ScoringEngine` on the other, nothing stubbed between.

### 6.2 Push notifications reach nobody, on either app

`expo-notifications` is a declared dependency of `customer-mobile` **and**
`merchant-mobile` and is imported in neither. `useRegisterDevice`
(`customer-mobile/src/features/account.ts:223`) has zero callers;
`merchant-mobile` has no device registration at all. `push_devices` is
therefore always empty, `listActive` always returns `[]`, and every send is a
no-op — including the merchant's new-order alert, which the app's own stack
comment calls a promise it could not otherwise keep.

Two merged slices (#69, #74) built the entire server-side transport. Nothing on
a handset ever asks for a token.

### 6.3 A buyer cannot start a return

`POST /me/orders/:id/return` and `GET /me/returns` have no caller in any
client. The Account menu row is labelled "Orders & returns" and pushes
`/orders`; the order screen prints "Free returns until &lt;date&gt;" as static
text. The seller's queue (#82) can only ever read empty in production.

### 6.4 Reviews are read on four surfaces and writable from nowhere

`POST /me/reviews` and `GET /me/reviews/pending` have no caller anywhere in the
monorepo, while `rating_avg` / `rating_count` render on the product screen,
every product card and the vendor header — and the product screen *fetches* the
review list (`storefront.ts:121`). So the list is permanently empty and every
rating permanently null.

### 6.5 Browse and Search show one page of a total they print

`useBrowse` sends `limit: 30`, `useSearch` sends `limit: 40`, and neither ever
sends `offset` — while the Browse header and its filter-sheet CTA print the
real `total` ("Show 218 items"). In any category with more than thirty
listings the shopper can reach thirty of them. The API has supported `offset`
since Phase 11. The store screen hits the same wall and is honest about it
("Showing the first 48 of N"), which shows the omission was known.

### 6.6 Deal prices exist only in the seed

`products.compare_at_price_pesewas` and `deal_ends_at` are read on four
surfaces and are absent from every write dto. The strikethrough "was" price and
the deal countdown can only ever come from `marketplace-demo.sql`.

### 6.7 `addresses.ghanapost_gps` is read by the seller and written by nobody

The checkout address sheet hard-codes it `null` and offers no input; the
seller's order screen renders it when present. GhanaPostGPS is how a Ghanaian
address is actually found, so every delivery routes off free text.

### 6.8 `order_returns.status = 'cancelled'` is set by nothing

The CHECK permits it, `RETURN_STATUSES` declares it, and no service writes it.
The seller's queue ships copy for it — "Nothing withdrawn. A buyer can withdraw
a request before you decide on it" — which is not true. Either give the buyer a
withdraw control or drop the status and the copy.

### 6.9 Reported once, not verified

An audit pass raised these and its verification stage never ran. Treat each as
a lead, not a finding: no address book (four address routes unreached); no
saved-items screen (`GET /me/wishlist` unconsumed, both "Saved" controls open
Browse); a notification bell opening a tab with no notifications; "LIMIT LEFT
GHS 0.00" shown to a customer with no limit; "Deliver to Accra" hard-coded in
three places and also pricing the delivery quote; no pay-early, receipt or
statement on Instalments; profile and consents read-only for the life of the
account; `pickup_hubs` with no write route; `search_queries.customer_id`
written NULL on every row; three of seven `shipments` statuses unreachable;
and six dead customer routes.

Four surfaces — the merchant apps, the engine and money paths, the web apps,
and tests/ops — were never audited at all.
