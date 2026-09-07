# Ejua Sell — design → engine reconciliation

> **Status:** Implementation record for `apps/merchant-mobile`.
> **Design source:** `Design Prototypes/Ejua Sell (merchant).html` (merchant canvas, 11 screens + 1 sheet).
> **Companions:** [`customer-app.md`](./customer-app.md) · [`mobile-apps.md`](./mobile-apps.md) · [`commerce-domain.md`](./commerce-domain.md) · [`../PLATFORM-ROADMAP.md`](../PLATFORM-ROADMAP.md)

The sibling of [`customer-app.md`](./customer-app.md), and written for the same
reason: the canvas was drawn against the product vision, the engine was built
against `DEVELOPMENT-PLAN.md`, and the two have to be reconciled somewhere other
than in code comments and merged PR bodies.

The governing rule is the shopper app's, restated for the side of the
marketplace that gets paid: **the app never invents a number, and never offers a
control that changes nothing.** A seller reading a figure on this app is
reading the ledger. A seller pressing a button on this app is changing
something. Where the canvas drew a number the engine could not produce or a
switch nothing stored, we either built the backend or removed the element —
never faked either.

Delivered across [#77](https://github.com/Nesisoft/installment/pull/77),
[#78](https://github.com/Nesisoft/installment/pull/78),
[#79](https://github.com/Nesisoft/installment/pull/79),
[#80](https://github.com/Nesisoft/installment/pull/80) and
[#81](https://github.com/Nesisoft/installment/pull/81).

---

## 1. Screen → endpoint map

Everything is under `/merchant`, which `MerchantScopeGuard` narrows to the
signed-in account. The app never sends a merchant id and could not widen its own
scope by doing so. The single exception is `GET /storefront/categories`, which is
public because the taxonomy is.

| #   | Canvas screen             | Route                     | Reads                                                                                                                            | Writes                                                                                                              |
| --- | ------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 01  | Onboarding + KYC          | `/onboarding`             | `GET /merchant/store`, `/merchant/kyc`, `/merchant/payout-account`, `/merchant/payout-account/destinations`, `/storefront/categories`, `/merchant/me` | `PATCH /merchant/store`; `POST /merchant/uploads` → `POST /merchant/kyc/documents`; `POST /merchant/payout-account/resolve` → `POST /merchant/payout-account` |
| 02  | Today (dashboard)         | `/(tabs)/index`           | `GET /merchant/me`, `/merchant/balances`, `/merchant/stats`, `/merchant/catalog/summary`, `/merchant/orders?status=paid` + `?status=financing_active` | —                                                                                                                     |
| 03  | Order queue               | `/(tabs)/orders`          | `GET /merchant/queue`, `/merchant/queue/counts`                                                                                    | —                                                                                                                     |
| 04  | Order + settlement        | `/orders/[id]`            | `GET /merchant/orders/:id/sheet`                                                                                                   | `POST /merchant/orders/:id/fulfilling` · `/ship` · `/delivered`                                                       |
| 05  | Instalment plans          | `/plans`                  | `GET /merchant/plan-list`, `/merchant/plan-list/counts`, `/merchant/balances`                                                      | —                                                                                                                     |
| 06  | Plan + schedule           | `/plans/[id]`             | `GET /merchant/plan-list/:id`                                                                                                      | —                                                                                                                     |
| 07  | Catalog by variant        | `/(tabs)/products`        | `GET /merchant/products`, `/merchant/catalog/summary`                                                                              | — *(restock sheet: §5.1)*                                                                                             |
| 08  | List a product            | `/products/new`           | `GET /storefront/categories`, `/merchant/plan-templates`, `/merchant/me`                                                           | `POST /merchant/uploads` → `POST /merchant/products`                                                                  |
| 09  | Payouts + reserve         | `/(tabs)/payouts`         | `GET /merchant/balances`, `/merchant/payouts`, `/merchant/reserves`, `/merchant/payout-account`, `/merchant/me`                    | —                                                                                                                     |
| 10  | Performance               | `/performance`            | `GET /merchant/stats`                                                                                                              | —                                                                                                                     |
| 11  | Storefront + settings     | `/(tabs)/shop`            | `GET /merchant/store`, `/merchant/kyc`, `/merchant/payout-account`, `/merchant/catalog/summary`, `/merchant/stats`, `/merchant/plan-list/counts`, `/merchant/me` | `PATCH /merchant/store`                                                                                               |
| —   | Sign in                   | `/sign-in`                | —                                                                                                                                  | `POST /auth/login`                                                                                                    |

Two surfaces the engine serves that no screen reaches yet — see §5:
`GET/POST /merchant/returns/*` and `PATCH /merchant/products/:id` +
`PUT /merchant/variants/:id/inventory`.

---

## 2. What the backend gained

Each of these existed only in the design before the slice that built it.

### 2.1 A queue whose buckets are the seller's words

`GET /merchant/orders` returned bare `orders` rows. The canvas's queue is five
tabs a seller thinks in — New, Confirmed, Shipped, Delivered, All — none of which
is an `orders.status` value. `MerchantOrdersService` maps them
(`MERCHANT_ORDER_BUCKETS`: `new` is `paid` + `financing_active`, `confirmed` is
`fulfilling`, and so on) and projects the buyer, the item summary and what the
order settled for, so a card is one query rather than four.

The seller's word for the first transition is "confirm". The state machine's is
`fulfilling`. There is no `confirmed` status, and inventing one would have meant
a status column with two names for one state.

### 2.2 Settlement read from the ledger, not recomputed

The order sheet's money block is `MerchantOrderSettlement`, summed out of
`ledger_entries` under the order's own transaction id. Nothing on the client
multiplies a rate: a figure that disagreed with the ledger by a pesewa would be
a figure a seller cannot reconcile against their MoMo statement — which is also
why `ghs()` in this app shows two decimals where the shopper app shows none.

`feeLabel` is `'commission' | 'mdr'` because an outright sale and an instalment
sale are charged under different names, and the design's single "Ejua MDR" row
would have been wrong on half of all orders.

### 2.3 The reserve, and when it actually comes back

`GET /merchant/reserves` carries `reserveReleasesAt` from `reserveReleaseDate()`
— the per-model buffer (bnpl and hybrid 14 days after completion, layaway 7
after delivery, rent-to-own rolling) — rather than the date the reserve was
taken. The first implementation showed the trigger date, which is the one date
the seller definitely does not want.

`MerchantHeldReserveRow` gained `orderNumber` and `itemSummary` so a held amount
is attributable to a sale rather than to a uuid.

### 2.4 A plan list with the sale behind it

`/merchant/plans` returns bare `customer_plans` rows — no customer, no product,
no schedule, because a plan knows none of them. `/merchant/plan-list` was added
for the app: the sale, the buyer, the schedule summary and the lateness, per
card.

`detail()` queries the plan directly (`WHERE id = ? AND merchant_id = ?`) rather
than filtering a capped list page. The first version filtered the page, so the
26th plan could not be opened — the same bug class as the order queue's own
capped page, and now covered by a test that opens a plan off the first page.

### 2.5 `product_variants` had no ordering at all

Found because a determinism test returned `[{size:'M'},{size:'S'}]`. Every
variant of a product is inserted in one transaction, so `created_at` is
identical across them and the random uuid PK was the only stable sort. Nobody
had noticed because the admin console and the web portal render one variant per
row — but **the shopper's size picker was scrambled too**. Migration
`0021_product_variant_position.sql` adds `position`, backfills by
`(created_at, id)`, and all three readers now order by it.

### 2.6 Where the shop trades

`stores.city` and `stores.region` have been columns since the storefront
shipped, and `StorefrontService.store()` has been reading them the whole time.
No schema accepted either, so **every shop on the marketplace showed no location
and no seller had any way to give one**.

`GHANA_REGIONS` now lives in `packages/core/src/shared/validators/ghana.ts`,
beside `ghPhoneNumber` and `momoProviderCode`. In core rather than commerce
because merchant signup asks for the same field and lives in core, and commerce
may import core but never the reverse. A closed list of the sixteen, because
`delivery_zones.region` is matched against the same vocabulary when a shipping
quote is priced — a shop saving "Gt. Accra" or the pre-2019 "Brong Ahafo" would
read as a region no zone rule mentions and silently fall through to the national
rate. Cities stay free text: a seller trades at Makola, Kejetia or Asafo, and
there is no enumeration of those worth maintaining.

Both are `.nullable().optional()`, and the distinction carries weight:
`undefined` leaves the column alone, `null` clears it. Without the nullable a
city could be set once and never removed.

### 2.7 Smaller things the app needed and the contract did not declare

- `Merchant.min_payout_pesewas` was served by `/merchant/me` since the column
  existed and was simply never declared in `api-types`, so no client could read
  the number that explains a missing payout.
- `PlanNotFoundError` had no entry in `domain-exception.filter.ts`, so a plan
  that did not exist answered 500 instead of 404. The integration tests did not
  catch it — they assert on the thrown error, which was right all along.
- `ProductsService.variantsForProducts` and a `needs_restock` filter, so a
  catalogue of thirty cards is one request rather than thirty-one.

---

## 3. What the design gave up

Each of these is a canvas element that is **not** in the app, because building
it would have meant showing a number nothing computes or offering a switch
nothing stores.

### 3.1 There is no messaging in this system

The canvas has a "Message" button on the order sheet and a "6h reply time" tile
on the storefront screen. There is no thread table, no message table, no send
route — nothing anywhere in the engine a seller could reply on. Both are gone.
The order sheet shows the buyer's phone instead, which is what a Ghanaian seller
would use anyway.

### 3.2 "Customer arrears never reduce your reserve" is false

The canvas says it twice. A default allocates the loss against the reserve —
that is what the reserve is for — and both the aggregate figure and the per-plan
one net it off. The copy now says so: *"a default can eat into it, which is what
it is for."*

### 3.3 The shop accent picker stores nothing

Four swatches, and no column behind them. `stores.metadata` would take a hex,
but `StorefrontStore` never returns metadata, so a seller could pick a colour
and no buyer would ever see it. Replaced on screen 11 by the market editor,
which is a control over something real.

### 3.4 On-time percentage is public-only

`StorefrontStore.on_time_percent` exists, but `GET /storefront/stores/:slug`
refuses a store that is not `active` — so the shops that most want the number,
the ones still being set up, are exactly the ones that cannot read it. The
merchant surface has no equivalent. Screen 11's three tiles are live products,
30-day orders and running plans instead, each from a route the seller can
actually call.

### 3.5 Delivery is one national rate card

The canvas's "Delivery zones & fees · Accra, Tema" implies a per-shop table.
`delivery_zones` has no `merchant_id`: every shop on the marketplace is quoted
from the same rows. The settings row says "Set by Ejua" and does not open an
editor over a table that does not exist.

### 3.6 A return policy is not a policy

"Return policy · 7 days" implies a setting. `stores.policies` is a jsonb column
that is written by nobody and read by nobody. Returns are decided one at a time
by the seller, per request — so the row says that, and §5.2 builds the screen
where the deciding happens.

### 3.7 There is no `PL-…` plan reference, and no late plan status

A plan's only identifier is a uuid, so the plan card is titled by the sale's own
order number. And a plan in arrears stays `active`: lateness lives on
`installment_schedule`, so `late` is derived from the schedule
(`LATE_INSTALLMENT_STATUSES`) rather than read off the plan.

### 3.8 The settlement batch does not run at 11pm

The canvas's payout hero says "TONIGHT 11:00 PM". The run is
`CronExpression.EVERY_DAY_AT_6AM` — the following morning, not that night. A
below-floor run is worse than merely mistimed: it writes **no row at all**, so the
seller sees no payout rather than a payout of zero — which is why
`min_payout_pesewas` had to be declared (§2.7) and why the payouts screen
explains it.

### 3.9 "Open my shop" is not the seller's to press

The canvas ends onboarding with it. Going live is `merchants.activate` then
`stores.activate`, both admin-only and deliberately so: the second requires the
first, and the first requires a person to have looked at a Ghana Card
(`REQUIRED_MERCHANT_KYC_DOCS`). Screen 01 says what happens next instead of
offering a button that would do nothing.

---

## 4. Client architecture

Deliberately parallel to `apps/customer-mobile` rather than shared with it.

- **Tokens are duplicated, not hoisted.** `src/theme/tokens.ts` is this canvas's
  own palette — green-led, where the shopper app is crimson-led. Hoisting one
  token module into a package would make every shopper screen depend on a file
  the seller app also edits, and the two canvases are allowed to diverge. The
  cost is one colour table in two places; the benefit is that each app's tokens
  are exactly its own design.
- **`ghs()` shows two decimals**, the opposite of the shopper app. A shopper
  reads a price; a seller reconciles against a MoMo statement, and `GHS 906`
  where the payout was `GHS 905.60` is a number they cannot match.
- **`parseGhsToPesewas` parses digits**, never multiplies a float.
  `ghsToPesewas` in `api-types` takes a `number`, and `320.15 * 100` is
  `32014.999…`.
- **Dates never go through `new Date(apiString)` or `toLocaleDateString`.**
  `timestamptz` comes back as `2026-08-28 11:51:27+00` — space separator,
  two-digit offset — which Hermes reads as `Invalid Date`; and Node's ICU
  renders September as "Sept" where Hermes's cut-down ICU does not. Both go
  through `src/lib/dates.ts`.
- **`Stack.Protected`, not a redirect in an effect.** A redirect runs after the
  route it is redirecting away from has mounted, and the app cold-starts on
  `(tabs)` — so every launch fired six unauthenticated `/merchant` calls and took
  six 401s before showing sign-in.
- **Signing out clears the query cache.** Every screen here is one shop's money.

---

## 5. Screens the canvas never drew

The canvas has eleven screens and one sheet. Three capabilities the engine
already serves have no design behind them at all. Specified here, in the
canvas's own vocabulary, so they can be built without inventing a visual
language.

### 5.1 Restock (sheet) — *on the canvas, not yet built*

The one canvas element still unbuilt. Drawn at the foot of screen 07: variant
tabs carrying each size and its count, a large centred stepper, `+5 / +10 / +25
/ +50` quick-add chips, a note that changes at zero ("At zero this size is
hidden from customers — the rest of the listing stays live"), and a CTA that
names the variant it is saving.

**Writes** `PUT /merchant/variants/:variantId/inventory` (`setStock`), which is
absolute rather than a delta — the sheet shows a count and saves that count, and
`adjust` exists for callers that genuinely have a delta. Both are scoped by
merchant in the WHERE clause.

The catalogue tab already has a "Sizes to restock" filter, so today it surfaces
a problem the app gives no way to fix.

### 5.2 Returns — *no design*

Structurally the order queue and order sheet again: a filtered list of things
needing a decision, then a detail with a sticky action footer. Follow those two
screens rather than inventing a third shape.

**Queue.** Chips over `RETURN_STATUSES` — Waiting on you (`requested`),
Approved, Refused, All — with counts. Each card: the order number, the buyer,
the item summary, what the buyer gets back, how long it has been waiting, and
the buyer's reason truncated to two lines. `requested` sorts first and newest
first within that; `order_returns.requested_at` is the existing sort.

**Detail.** The buyer's reason in full, the order it belongs to (linking to
`/orders/[id]`), and a money block that says plainly what approving costs,
because this is the part a seller gets wrong:

> Approving reverses the sale. `refund_amount_pesewas` goes back to the buyer,
> your `total − commission` is taken off your payable balance, Ejua's commission
> is reversed too, and the goods go back on the shelf.

Those three numbers are `refund_amount_pesewas`, `total_pesewas − commission`
and the commission — all derivable, none currently projected (§5.4).

Two actions in the footer: **Approve** (confirm first; it is irreversible —
`ReturnAlreadyDecidedError` — and it moves money) and **Refuse**, which requires
a note because `order_returns_rejection_needs_note` is a CHECK constraint and
because a refusal with no reason is not something a buyer can act on. The note
is shown to the buyer; the field's copy should say so.

A decided return is read-only, with the decision and its note.

### 5.3 Edit a listing — *no design*

Screen 08 in reverse, and it is the mirror image that makes it specifiable: the
same fields, pre-filled, over `PATCH /merchant/products/:id` (`title`,
`description`, `category_id`, `base_price_pesewas`, `status`). Plus the pieces
create does inline and update does not:

- `POST /merchant/products/:id/variants` for a size added later
- `POST /merchant/products/:id/images` for another photo
- `PUT /merchant/products/:id/plan-offers` to change which plans it is sold on
- the restock sheet from §5.1, per variant

Status is the load-bearing control: `active` ↔ `draft` is how a seller takes
something off sale without deleting it, and `archived` is how they retire it.
There is no delete, and the screen should not imply one.

Note what `updateProductSchema` does **not** accept: `store_id`. A product
cannot be moved between shops, which is correct — the settlement history is
attached to the merchant.

### 5.4 What these need from the backend

`GET /merchant/returns` returns bare `order_returns` rows: no order number, no
buyer, no item summary, and no commission figure. That is the same gap
`MerchantOrdersService` was written to close for the order queue (§2.1), and it
wants the same answer — a merchant-facing projection (`MerchantReturnRow` /
`MerchantReturnDetail`) plus a counts endpoint for the chips, declared in
`api-types`, which today carries **no return types at all**.

---

## 6. Deliberately deferred

- **Per-item returns.** `order_returns` is whole-order by design: `order_items`
  has no status column, so an item-level return would leave
  `orders.status = 'returned'` while one shirt of three went back. Per-item
  state first, then the feature.
- **Messaging.** §3.1. A real slice, not a screen.
- **Per-shop delivery zones.** §3.5. Needs `delivery_zones.merchant_id` and a
  resolution order against the national card.
- **Editing the slug.** It is the public URL. An admin can change one during
  review, which is the right place for the judgement call.
- **Deleting a product.** `archived` covers the need without orphaning order
  history.
- **Push for anything but new orders.** `push_devices` carries merchant handsets
  since 0017; only the order notification is wired.

---

## 7. Verified, and not

Every backend change above is covered by the integration suites — real Postgres,
real services, per-worker databases cloned from the migrations. As of #81 that
is **391 core and 261 commerce** integration tests.

The screens themselves are covered by `typecheck` and `lint` only. **No screen in
this app has been run on a handset.** The Expo app has been started against a
local API during development, but there is no device or simulator test in CI and
no snapshot coverage of any screen.

Also unverified: **nothing in the payment path has been exercised against
Paystack.** Signup's MoMo payout resolution, the payout account screen and the
settlement disbursement all stop at a stub returning the shapes the live API
documents. That needs a test key and a reachable webhook.
