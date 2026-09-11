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
| Push *delivery* (registration ships) | `PushNotifier` and the whole transport (#69, #74), and — since this slice — the handset half that makes them arrive. See §6.2. |
| Returns/disputes flow | `ReturnsService`, `POST /me/orders/:id/return`, the seller's queue and decision screens (#76, #82), and — since this slice — the buyer's own journey: asking, listing, and withdrawing. See §6.3 and §6.8. Disputes remain deferred; a return is the seller's to decide, a dispute is Ejua's. |
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

### 6.2 Push notifications reach nobody, on either app — fixed

**The finding.** `expo-notifications` was a declared dependency of
`customer-mobile` **and** `merchant-mobile` and was imported in neither.
`useRegisterDevice` (`customer-mobile/src/features/account.ts`) had zero
callers; `merchant-mobile` had no device registration at all. `push_devices`
was therefore always empty, `listActive` always returned `[]`, and every send
was a no-op — including the merchant's new-order alert, which the app's own
stack comment calls a promise it could not otherwise keep.

Two merged slices (#69, #74) built the entire server-side transport. Nothing on
a handset ever asked for a token. The shape of it is the recurring one in this
codebase: `PushNotifier.send` takes a `noDevices` early return and reports
success, so a channel reaching nobody looked exactly like one that worked.

**The fix.** Both apps now register on launch and deregister on sign-out:

- `mobile-kit/src/push-registration.ts` — `registerForPush`, the decision as a
  pure function over injected ports. Split from the Expo binding for the same
  reason `api-url.ts` is split from `config.ts`: a node test cannot load a
  React Native module, and the part worth testing is the sequence of choices.
  Ten unit tests, including the four skips.
- `<app>/src/lib/push.ts` — the binding, per app: which Expo module supplies
  which fact, the Android channel, the foreground handler, and where a tapped
  notification goes (`data.orderId` → `/orders/:id`, set by `PushNotifier`).
- `api-types/src/devices.ts` — the contract had **no** mirror at all, so both
  apps typed the body by hand. It now carries `registerDeviceSchema`,
  `DEVICE_PLATFORMS` and `EXPO_PUSH_TOKEN_RE`, gated in
  `api-types-mirror.spec.ts` by running eleven inputs through the mirrored and
  the enforced schema and comparing verdicts.
- `useRegisterDevice` is deleted. Two ways to register would drift, and one of
  them had never been called.

**Four ways registration deliberately does nothing**, because each of them is a
throw in a root-layout effect otherwise — that is, a blank screen for a feature
the app works perfectly well without:

| Skip | Why |
|---|---|
| `simulator` | Expo will not mint a token for one, and `getExpoPushTokenAsync` throws rather than returning null |
| `no-project-id` | the same call throws without `extra.eas.projectId`, and **neither app has one yet** — see below |
| `permission-denied` | iOS shows the system prompt once per install; asking again is a round trip that cannot succeed |
| `not-an-expo-token` | a raw FCM/APNs token comes back when push credentials are wrong. Storing it means an address every send fails against, silently — the same class of bug as the one being fixed |

**Not verified end-to-end, and cannot be here.** No notification has been
delivered to a handset. `getExpoPushTokenAsync` needs an EAS project
(`eas init`, which writes `extra.eas.projectId` into `app.json`) and push
credentials for each platform; until someone runs it, both apps take the
`no-project-id` skip on every launch and `push_devices` stays empty. What is
verified is the decision logic (unit), the contract (drift gate, watched to
fail), and the server side (`PushNotifier`, already covered by integration
suites in core and commerce).

### 6.3 A buyer cannot start a return — fixed

**The finding.** `POST /me/orders/:id/return` and `GET /me/returns` had no
caller in any client. The Account menu row was labelled "Orders & returns" and
pushed `/orders`; the order screen printed "Free returns until &lt;date&gt;" as
static text. The seller's queue (#82) could only ever read empty in production
— a whole decision surface built for requests nothing could make.

**The fix.** Four screens, one new service method and one new route:

| | |
|---|---|
| `app/returns/new.tsx` | ask to send an order back, with the four eligibility rules checked before the button is offered |
| `app/returns/index.tsx` | the buyer's own list, with chips, counts and the withdraw control |
| `CustomerReturnsService` | the customer-side twin of `MerchantReturnsService` — `listForCustomer` returned bare rows carrying an order id and two amounts, which is nothing a buyer can recognise a purchase from |
| `ReturnsService.withdraw` | see §6.8 |
| the order screen | the static sentence now leads somewhere |

**Where this departs from the canvas**, and why:

- **No thumbnails.** The artboard draws a 52×52 product image on every returns
  card. `order_items` carries no image; one would need a join to
  `product_images` plus the media URL builder, in two services. The orders tab
  already renders a plain `tintFor(order.id)` block for exactly this, so the
  returns list matches the shipped app rather than the drawing.
- **"GHS 410.00 is on its way back to your MoMo" is not shown.** It has no
  backing field. Approving books `refund_payable` in the ledger and explicitly
  does *not* move cash; `order_returns` records neither a destination nor a
  date, and nothing distinguishes approved-and-unpaid from approved-and-paid.
  The card says the seller agreed and the amount is being refunded, which is
  what the record supports.
- **The quick-reason chips prefill rather than fill.** In the artboard, tapping
  a chip writes the label into the reason box as the entire answer — which
  defeats the free-text field's own stated justification ("wrong size" and
  "arrived with the screen cracked" are different decisions, *which is why
  there is no dropdown*). Here a chip opens the sentence and leaves the cursor
  after it.
- **The dates.** The design labels each card by verb — "Asked", "Agreed",
  "Refused". `decided_at` is null for `requested` **and** for `cancelled`
  (`order_returns_decided_together` requires it), so both of those fall back to
  `requestedAt`; a withdrawn return reads "Asked 5 Sep · withdrawn".

### 6.4 Reviews are read on four surfaces and writable from nowhere — fixed

**The finding.** `POST /me/reviews` and `GET /me/reviews/pending` had no caller
anywhere in the monorepo, while `rating_avg` / `rating_count` render on the
product screen, every product card and the vendor header — and the product
screen *fetches* the review list (`storefront.ts:121`). So the list was
permanently empty and every rating permanently null, on four surfaces, with
nothing that looked broken.

**The fix.** `app/reviews/index.tsx` (the pending queue) and
`app/reviews/new.tsx` (the form, presented as a modal), plus the app's first
interactive `StarRating` — the existing `Stars` in the product screen is a
private, read-only average display — and its first multiline `TextArea`.

**And a disagreement the two halves had with each other.** `reviewable()`
listed order lines whose `product_id` had gone NULL (a delisted product;
`order_items.product_id` is `ON DELETE SET NULL`) while `create()` refuses
exactly those with "This product is no longer listed". The pending queue could
hand a buyer a card whose only possible outcome was a 422 they could do nothing
about. `reviewable()` now filters them, and `reviews.integration.spec.ts` — the
first test coverage this module has ever had — pins the two halves together.

The same query also gained the shop name, the delivery date, a deterministic
order and a limit. It had none of those: a customer with a long history got
their entire unrated history in arbitrary order, to render cards reading as a
bare product name weeks after the fact.

### 6.5 Browse and Search show one page of a total they print — fixed

**The finding.** `useBrowse` sent `limit: 30`, `useSearch` sent `limit: 40`,
and neither ever sent `offset` — while the Browse header and its filter-sheet
CTA printed the real `total` ("Show 218 items"). In any category with more than
thirty listings the shopper could reach thirty of them. The API has supported
`offset` since Phase 11. The store screen hit the same wall and was honest
about it ("Showing the first 48 of N"), which showed the omission was known.

**And the reason it could not simply be switched on.** `LIMIT`/`OFFSET` is
only coherent over a TOTAL order. Every catalogue sort ended at
`desc(products.created_at)`, and that column is nowhere near unique: it
defaults to `NOW()`, which is transaction-start time held constant for the
whole transaction, so one seed run, one bulk import or one batch upload writes
an identical timestamp to every row it inserts. On the dev catalogue that was
**eight products of ten on a single value**.

Where rows tie, Postgres makes no promise about their order and is free to
answer differently per query — so page 2 can repeat a product from page 1 while
another appears on no page at all. Reproduced directly, in
`browse-paging.integration.spec.ts`: twenty thousand rows on one timestamp, the
same `LIMIT 5 OFFSET 10000` twice, and the only difference between the runs is
the plan the planner is allowed to pick. **Zero rows in common.** With the
tiebreak this slice adds, the same two plans agree exactly.

So every sort now ends at `desc(products.id)` — arbitrary, which is fine, and
stable, which is the whole requirement.

**The fix, client side.** `useBrowse` and `useSearch` are `useInfiniteQuery`,
with a `select` that flattens the pages back into the `{ rows, total }` the
screens already read — so Browse, Search and a store's shelf all page without
changing how any of them renders. `Screen` gained an `onEndReached`, and a
shared `ListFooter` carries a "Show more" button, the in-flight state and a
closing count. The button is the real control rather than a fallback: a
scroll trigger is invisible to a screen reader and unreliable on a slow
connection.

**On what the tests do and do not prove.** The four contract tests (pages walk
each product exactly once, the same page twice returns the same rows, the
total agrees with the walk, running off the end returns empty) are a
regression guard — but they pass against the old code too, because at twelve
rows Postgres sorts the same way every time. That is precisely what let this
survive: it is invisible until the table is big enough for the planner to have
a choice. The twenty-thousand-row test is the one that reproduces it, and it
is a statement about `ORDER BY` over ties rather than a gate on our own code.

### 6.6 Deal prices exist only in the seed — fixed

**The finding.** `products.compare_at_price_pesewas` and `deal_ends_at` were
read on four surfaces — the strikethrough on every card, the discount pill, the
product screen and the home feed's Deals rail with its countdown — and were on
neither write DTO. Every sale in the app came from `marketplace-demo.sql`; no
seller could put anything on sale.

**The rules were not new.** `products_compare_at_above_price` and
`products_deal_needs_compare_at` have been on the table since 0015, and that
migration already said why:

> A strikethrough that is not actually a discount is a lie the UI would tell on
> every card, so the database refuses it.

So this slice did not invent a policy; it made the write path agree with one
that was already enforced. That distinction matters, because a DTO looser than
the CHECK turns a seller's typo into a Postgres constraint violation — a 500
and a Sentry alert where a 422 was owed.

**Where the rule lives.** In three places, deliberately, and only one of them
could have done the job alone:

- the CHECK, which is the guarantee;
- `dealRuleIssue`, shared by the backend DTO and its api-types mirror;
- the service, which re-runs it against the row a PATCH would *produce*.

That last one is the case no schema can express. Raising `base_price_pesewas`
past a `compare_at_price_pesewas` the patch never mentions is a perfectly valid
patch and an invalid row; so is clearing a "was" price while the sale is still
running. `update` locks the row, merges, and checks — otherwise both reach
Postgres and come back as a 500.

**A past `deal_ends_at` is accepted**, and that is not an oversight. `deal_ends_at
> NOW()` on the read side is what decides whether a deal is live, and refusing a
past date would block a seller editing the title of something whose sale ended
last week.

**And one thing I had wrong.** I thought `ProductCard` needed fixing, because it
renders the strikethrough on the field's mere presence rather than on it being
higher than the price. It does not: the CHECK guarantees `compare_at >
base_price` for anything in the table, so the card cannot draw a fake discount.
The guarantee was already load-bearing; I had simply not read it before
assuming the client was wrong.

**A fourth drift, found on the way.** The published `Product` interface was
missing `compare_at_price_pesewas`, `deal_ends_at`, `updated_at` and
`deleted_at` — all four returned by every product read. That is why the
seller's own edit screen could not see the sale it was meant to edit. It is
also the one kind of drift `api-types-mirror.spec.ts` could not catch, since
vitest runs through esbuild and a type assertion between two interfaces passes
whatever either says. `PRODUCT_FIELDS` is now a runtime list compared against
the server's own `productCols`.

### 6.7a Saving a delivery address from the phone returned 400 — fixed

Found while scoping the address book, and it is the most serious thing this
audit has turned up: **no shopper could save a delivery address from the mobile
app, ever.**

`createAddressSchema` marked `area`, `landmark` and `ghanapost_gps`
`.optional()`. The columns are nullable, the `Address` type the clients hold
declares them `string | null`, and the app's address sheet accordingly sends
`null` for whatever the shopper left blank. Zod's `.optional()` refuses null
outright — "Expected string, received null" — so the create 400'd every time.
The web form escaped it only because it spreads its optional fields
conditionally.

The mobile hook's own type made the bug compulsory: `useCreateAddress` takes
`Omit<Address, 'id'>`, and `Address` declares those three as `string | null`,
so TypeScript forbade omitting them.

A shopper with no address on file could therefore not complete a courier
checkout at all. Nothing caught it because no test ever sent a null; the fields
are `.nullish()` now and `addresses.integration.spec.ts` sends the body the app
actually sends.

Two more on the same route, both reachable the moment an address book exists:
an empty `PATCH` parsed clean, reached Drizzle with nothing to set and threw a
bare `Error` the exception filter does not classify — a caller's mistake
surfacing as a 500 and a Sentry alert. And deleting the default address left
the customer with none: `addresses_one_default_idx` enforces *at most* one and
nothing enforced *at least* one, so the next checkout quietly fell through to
the national delivery price. `remove` now promotes the newest survivor.

### 6.7b An order's delivery address was a live read — fixed

`orders.shipping_address_id` is a foreign key and the seller's order screen
re-read that row at render time. Nothing was copied onto the order, so the
buyer owned the seller's copy of the address after the sale:

- **Editing** a saved address rewrote the delivery block of every order
  pointing at it. Correcting "Adenta" to "Adenta East" changed where a parcel
  delivered last month says it went.
- **Deleting** one blanked it. `ON DELETE SET NULL` plus no snapshot meant
  `deliveryFor` fell through to its all-null `empty` — for an order that might
  still be in `fulfilling`, waiting to go on a van.

Neither was reachable from a client, and only because five of the six address
routes had no caller. The address book screen is what makes them reachable, so
migration 0022 adds `orders.delivery_address` (JSONB, backfilled) and checkout
writes it from the row it already loads to prove the address is the caller's.
The same reasoning `order_items.title` and `unit_price_pesewas` were snapshotted
under at 0006: a product renamed or repriced must not rewrite what somebody
bought.

Both are pinned in `merchant-orders.integration.spec.ts` — edit one, delete the
other, and the seller still sees where the parcel is going. Watched to fail
against the live read.

### 6.7 `addresses.ghanapost_gps` is read by the seller and written by nobody

The checkout address sheet hard-codes it `null` and offers no input; the
seller's order screen renders it when present. GhanaPostGPS is how a Ghanaian
address is actually found, so every delivery routes off free text.

**Correction.** "Written by nobody" is not quite right, and the difference
matters. The write path is complete: `createAddressSchema` accepts
`ghanapost_gps`, `AddressesService.create` inserts it, and the partial update
DTO patches it. What is missing is a client that offers the field — the mobile
sheet hard-coded `null` and the web form has no such input. The accurate
statement is **accepted by the API, offered by no client**. The canvas flags
the field as a proposal rather than shipped behaviour
(`ejua-new-screens/README.md`), so the address book is where that decision
lands.

### 6.8 `order_returns.status = 'cancelled'` is set by nothing — fixed

**The finding.** The CHECK permitted it, `RETURN_STATUSES` declared it,
`listReturnsSchema` accepted it as a filter, the seller's queue shipped a
`WITHDRAWN` chip and an empty state reading "Nothing withdrawn. A buyer can
withdraw a request before you decide on it" — and no service wrote it. That
copy was not a promise the product was slow to keep; it was one nothing could.

**The fix.** `ReturnsService.withdraw(customerId, returnId)` and
`POST /me/returns/:id/withdraw`, with the control on the buyer's returns list.

Three things about it are worth recording, because each is a rule the schema
had already anticipated:

- **It is not a decision.** `decided_at` and `decided_by` stay null, and
  `order_returns_decided_together` — `(status IN ('requested','cancelled')) =
  (decided_at IS NULL)` — requires exactly that. A withdrawal is the request
  going away, not the seller answering it.
- **There is nothing to unwind.** `request` moves no money and touches no
  stock; only `approve` does. If that ever stops being true, `withdraw` has to
  grow the reversal, and `buyer-returns.integration.spec.ts` asserts the order
  and the trial balance are untouched so the omission cannot go quiet.
- **The order becomes askable again**, enforced by the schema rather than by
  the method: `order_returns_one_open_idx` is partial on `status = 'requested'`.
  A withdrawal that permanently barred the order would be worse than no control.

**And an ownership hole found on the way.** `lockOpenReturn` checked the return's
status *before* any ownership scope, so a buyer probing a stranger's return id
would have been told "already approved" — a 409 confirming the row exists. It
now takes an optional customer scope applied in the WHERE, so a return that is
not yours reads as 404 whatever its state. The decision paths are unaffected
(they scope through `lockOrder` on the merchant id); the test was watched to
fail against the old shape.

### 6.9 Reported once, not verified

An audit pass raised these and its verification stage never ran. Treat each as
a lead, not a finding: ~~no address book (four address routes unreached); no
saved-items screen (`GET /me/wishlist` unconsumed, both "Saved" controls open
Browse);~~ **both now verified and fixed — see §6.10**; a notification bell opening a tab with no notifications; "LIMIT LEFT
GHS 0.00" shown to a customer with no limit; "Deliver to Accra" hard-coded in
three places and also pricing the delivery quote; no pay-early, receipt or
statement on Instalments; profile and consents read-only for the life of the
account; `pickup_hubs` with no write route; `search_queries.customer_id`
written NULL on every row; three of seven `shipments` statuses unreachable;
and six dead customer routes.

Four surfaces — the merchant apps, the engine and money paths, the web apps,
and tests/ops — were never audited at all.

---

## 6.10 The address book and saved items

Two of the §6.9 leads, checked and closed. Both were true, and both were worse
than the lead said.

**Addresses.** Five of the six routes had no caller — only the list was read,
by checkout — and the Account row labelled "Delivery addresses" pushed
`/checkout`. Scoping the screen turned up the live 400 and the history-rewrite
described in §6.7a and §6.7b, which shipped first (#87) because the screen is
what would have made them reachable.

`app/addresses/index.tsx` and `app/addresses/edit.tsx` now cover list, add,
edit, set-default and remove.

**Saved items.** `useWishlist` had existed with zero callers since it was
written, `GET /me/wishlist` had no consumer anywhere in the monorepo, and both
controls labelled "Saved" — the menu row and the stat tile — opened Browse.

The read had to be fixed before a screen could call it. `list` hydrated its
cards from the catalogue's top-100 **popular** page and fell back to a full
per-id detail fetch — about seven queries each — for every saved item that page
did not happen to contain. Since "saved by this shopper" and "most sold in the
marketplace" are unrelated sets, in any catalogue over a hundred products
nearly every item took the slow path: thirty saved items was on the order of
two hundred round trips to open one screen. The response was two shapes as
well — the hits came back as thin `StorefrontProduct` cards, the misses as full
`StorefrontProductDetails`, in one array the contract documented as one type.

`StorefrontService.cardsByIds` is the batched read it needed and did not have.

And `count` disagreed with `list`: a bare `COUNT(*)` with no product join
against a list filtered through `liveListingWhere()`, so the account screen
printed "7 saved" over a list of five — both on screen at once, because the
client invalidates `['wishlist']` and `['profile']` together. `count` now
counts through the same predicate. `liveListingWhere` is finally **exported**,
which its own docstring has claimed since it was written ("one exported
expression rather than a predicate repeated at each call site, because that is
how the seller check went missing from four places at once"). The wishlist was
the fifth call site that docstring warns about.

`ids` deliberately still does *not* filter. It answers "did I save this?" on a
product page the shopper already has open, and that page can be open for a
listing since archived; emptying the heart there would deny a save that is real
and a DELETE that still works.

### Where these depart from the canvas

- **No "BACK IN STOCK" banner, and no "1 back in stock" in the header.** Both
  need a stock *transition*. `wishlist_items` stores `(customer_id, product_id,
  created_at)` and a card carries a point-in-time `in_stock` boolean; nothing
  anywhere records what the stock was yesterday. Not deferred for effort —
  underivable from any current endpoint.
- **"SOLD OUT", not "No sizes left".** Per-variant stock lives on
  `StorefrontProductDetails`, which the list does not return. One boolean per
  product is what there is.
- **No "Used on 6 orders" on an address card.** There is no usage count on the
  row and no endpoint returns one. It could be a `COUNT` over
  `orders.shipping_address_id` — but that FK is `ON DELETE SET NULL`, so the
  number silently drops when an address is removed, which makes it a figure
  that quietly lies rather than one that is merely missing.
- **Four address lines, not five.** The artboard draws phone, a street line, a
  neighbourhood-and-city line and a landmark. The table has four usable text
  columns and no street column; `area` carries whichever the shopper wrote.
- **A Remove control, which the artboard does not draw.** `DELETE
  /me/addresses/:id` has always existed and been unreachable, which is the
  class of thing this whole audit is about. Safe as of #87, which promotes a
  replacement default and stops the delete blanking past orders.
- **The saved grid reuses `QuotedProductCard`.** The artboard draws a
  lowercase shop name, a light SOLD OUT pill and a permanently filled heart;
  the shipped card uppercases, uses a dark pill and toggles the heart. A saved
  grid that looked unlike every other grid in the app would be the drawing
  winning over the product.
- **GhanaPostGPS is on the form**, which the canvas flags as a proposal rather
  than present behaviour. The column exists, the seller's order screen already
  renders it, and until now nothing wrote it — §6.7.
