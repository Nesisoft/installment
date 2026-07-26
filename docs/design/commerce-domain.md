# Commerce Domain — Design

> **Status:** Design (pre-implementation). Companion to [`../PLATFORM-ROADMAP.md`](../PLATFORM-ROADMAP.md).
> **Concern:** The e-commerce layer (catalog, cart, orders, fulfillment) that sits **on top of** the existing installment engine and turns the platform into a marketplace for buyers and sellers — while keeping the engine a reusable open API for external partners.

---

## 1. Why this exists

Today the repo is a standalone **installment payment engine**. It has no concept of a product, a cart, or an order it owns — an installment `application` simply references an **external** order via an opaque `order_reference` string (`packages/core/src/modules/applications/dto.ts:9`). That is exactly right for partners like Ejua/Meko who run their own storefronts and call us as a BNPL API.

The marketplace vision adds a **first-party storefront**: Nesisoft's own buyers browse products, add to cart, and check out — paying **now** or **in installments** — while sellers upload products and fulfil orders. This document designs that commerce layer.

**Core principle: the engine does not change.** The commerce layer creates an **internal order**, then hands the engine `order_reference = order.id`. Everything the engine already does (scoring, schedule generation, ledger, settlement, collections) works unmodified. The marketplace becomes the engine's first *first-party* consumer, sitting beside the third-party partners.

```
  Buyers / Sellers (Expo apps)         External partners (Ejua, Meko, POS)
            │                                        │
            ▼                                        │ HTTP API + their own order_reference
   ┌───────────────────┐                             │
   │  COMMERCE LAYER    │  (new — this doc)           │
   │  catalog · cart ·  │                             │
   │  orders · fulfil   │                             │
   └─────────┬─────────┘                             │
             │ order.id AS order_reference           │
             ▼                                        ▼
   ┌─────────────────────────────────────────────────────────┐
   │  INSTALLMENT ENGINE  (built ✓, unchanged)                │
   │  applications · scoring · schedules · payments ·         │
   │  settlement · reserve · collections · ledger             │
   └─────────────────────────────────────────────────────────┘
```

---

## 2. Integration seams (already present in the engine)

The commerce layer is glue, not surgery. Every hand-off point already exists:

| Commerce action | Existing engine entry point | Location |
|---|---|---|
| Start an installment purchase | `ApplicationsService.submit({ …, order_reference, order_amount_pesewas })` | `applications/applications.service.ts:49` |
| Approve / score it | `recordDecision` / `applyDecision` | `applications/applications.service.ts:106,121` |
| Activate the plan + schedule | `CustomerPlansService.activateFromApplication(...)` | `schedules/customer-plans.service.ts:103` |
| Charge a **pay-now** order | `PaymentService.chargeMobileMoney` / `chargeCard` | `payments/payment.service.ts:176,149` |
| **Delivery** → release layaway reserve | `ReserveReleaseService.markDelivered(planId, at)` | `settlements/reserve-release.service.ts:114` |
| Refund / return | existing refund flow (`admin/installments/:id/refund`) | settlements |

Note the engine already carries `customer_plans.product_delivered_at` and a `held_reserves.delivered_at` release trigger — **nothing calls `markDelivered` with a real delivery event today.** The fulfilment sub-domain finally supplies that signal.

---

## 3. New data model

All money in integer **pesewas** (`BIGINT`), currency GHS — same rule as the engine (Guiding Principle #1). New tables group into four sub-domains. Append-only/audit conventions follow the engine where financial.

### 3.1 Catalog & storefront

| Table | Key columns | Notes |
|---|---|---|
| `stores` | `merchant_id` (FK → merchants), `slug` (unique), `display_name`, `logo_key`, `banner_key`, `about`, `status` (draft/active/suspended), `policies` jsonb | 1 merchant : 1 store for v1, modelled 1:N-ready. Reuses `merchants` for KYC/banking/payout — a store is the merchant's *public* face. |
| `categories` | `parent_id` (self-FK), `name`, `slug`, `position`, `is_active` | Marketplace-wide taxonomy, admin-curated (moderation). |
| `products` | `store_id`, `merchant_id`, `category_id`, `title`, `description`, `status` (draft/active/archived), `base_price_pesewas`, `attributes` jsonb, `search_tsv` (Postgres FTS) | `merchant_id` denormalised for engine hand-off + settlement. |
| `product_variants` | `product_id`, `sku` (unique per store), `option_values` jsonb (size/color…), `price_pesewas` (nullable override), `barcode` | Every product has ≥1 default variant; the variant is what a cart line references. |
| `product_images` | `product_id`, `storage_key`, `position`, `alt_text` | Object storage (see §7). |
| `inventory` | `variant_id` (unique), `quantity_available`, `quantity_reserved`, `restock_threshold` | Reserve-on-checkout, decrement-on-commit, release-on-cancel/expiry (§5). |
| `product_plan_offers` | (`product_id` \| `store_id`) → `plan_template_id` | Which installment plans a product/store offers — powers the checkout "plan selector + live calculator" from the vision. Absence ⇒ pay-now only. |

### 3.2 Cart & checkout

| Table | Key columns | Notes |
|---|---|---|
| `carts` | `customer_id` (nullable for guest), `status` (active/converted/abandoned) | One active cart per customer. |
| `cart_items` | `cart_id`, `variant_id`, `merchant_id`, `quantity`, `unit_price_pesewas` (snapshot) | Price snapshotted at add-time; re-validated at checkout. |

A cart may hold items from **multiple merchants**. At checkout it **splits into one `order` per merchant** (see Open Question #1).

### 3.3 Orders

| Table | Key columns | Notes |
|---|---|---|
| `orders` | `order_number` (human), `customer_id`, `merchant_id`, `store_id`, `source` (`internal`\|`partner`), `payment_type` (`full`\|`installment`), `subtotal_pesewas`, `shipping_pesewas`, `discount_pesewas`, `total_pesewas`, `commission_bps`, `status`, `shipping_address_id`, `application_id` (nullable FK), `customer_plan_id` (nullable FK), `placed_at` | The heart of the layer. For installment orders, `application_id`/`customer_plan_id` link into the engine; for full orders they stay null and a `payment_attempt` carries the charge. |
| `order_items` | `order_id`, `variant_id`, `title`/`sku` snapshot, `quantity`, `unit_price_pesewas`, `line_total_pesewas` | Immutable snapshot of what was bought. |
| `addresses` | `customer_id`, `recipient`, `phone`, `region`, `city`, `area`, `landmark`, `ghanapost_gps`, `is_default` | Ghana addressing (GhanaPostGPS digital address). |

**Invariant:** `total_pesewas = subtotal + shipping − discount`, and `subtotal = Σ order_items.line_total`. For an installment order, `orders.total_pesewas == applications.order_amount_pesewas == customer_plans.order_amount_pesewas`.

### 3.4 Fulfilment & post-purchase

| Table | Key columns | Notes |
|---|---|---|
| `shipments` | `order_id`, `carrier`, `tracking_number`, `status` (pending/shipped/in_transit/delivered), `shipped_at`, `delivered_at` | On `delivered` → call `ReserveReleaseService.markDelivered` for installment orders and transition the order. |
| `returns` (v2) | `order_id`, `reason`, `status`, `refund_amount_pesewas` | Drives the existing refund flow. |
| `reviews` (v2) | `product_id`, `customer_id`, `rating`, `body` | Post-delivery only. |

---

## 4. Order lifecycle (state machine)

Modelled with the same rigor as the engine's schedule state machine (`docs/design/installment-schedule.state-machine.ts`): explicit states, guarded transitions, an audit row per transition.

```
                    ┌──── payment_failed ◄─┐
   (checkout)       │                      │ charge declines
 cart ─► PENDING_PAYMENT ──charge ok──► PAID ─┐            (full/pay-now path)
        (payment_type=full)                   │
                                              ▼
 cart ─► PENDING_APPROVAL ──approved+activated──► FINANCING_ACTIVE ─┐
        (payment_type=installment)  │                               │
                                     └── declined ─► CANCELLED       │
                                                                     ▼
              both paths converge ►  FULFILLING ─► SHIPPED ─► DELIVERED ─► COMPLETED
                                          │                        │
                                          └── cancelled ◄──────────┘ (pre-delivery)
                                  return_requested ─► RETURNED ─► (refund)
   plan defaults (installment) ─────────────────────────────────► DEFAULTED
```

- **Full order** `DELIVERED → COMPLETED` immediately (payment already settled).
- **Installment order** `COMPLETED` when the linked `customer_plan` completes (all installments paid) **and** delivered. `DELIVERED` stamps `markDelivered` so layaway reserve releases on the real event.
- `DEFAULTED` is driven by the engine's existing plan-default path (collections write-off → plan default bridge already built).

---

## 5. The checkout flow (concrete)

```ts
// Pseudocode — commerce layer orchestration; engine calls are UNCHANGED.
async function checkout(cart, buyer, paymentChoice, address) {
  const groups = groupByMerchant(cart.items);           // multi-vendor → N orders
  const orders = [];
  for (const g of groups) {
    reserveInventory(g.items);                            // quantity_reserved += qty
    const order = createOrder({ merchant: g.merchant, items: g.items,
                                total: g.total, address, source: 'internal',
                                payment_type: paymentChoice.type });

    if (paymentChoice.type === 'full') {
      // PAY-NOW: reuse the engine's charge entry point. No plan, no application.
      const res = await paymentService.chargeMobileMoney({ /* buyer momo, order.total */ });
      order.status = res.ok ? 'PAID' : 'PAYMENT_FAILED';
      // → accrue merchant payable via a full-order settlement accrual (see §6)
    } else {
      // INSTALLMENT: hand the engine an INTERNAL order id as order_reference.
      const app = await applicationsService.submit({
        customer_id: buyer.id, merchant_id: g.merchant.id,
        plan_template_id: paymentChoice.plan_template_id,   // chosen from product_plan_offers
        order_reference: order.id,                          // ← the seam
        order_amount_pesewas: order.total_pesewas,
        merchant_category: g.merchant.category,
      });
      const decided = await applicationsService.recordDecision(app.id, /* scoring */);
      if (decided.status === 'approved') {
        const plan = await customerPlansService.activateFromApplication(app.id, /*…*/);
        order.application_id = app.id; order.customer_plan_id = plan.id;
        order.status = 'FINANCING_ACTIVE';                  // engine now owns the money flow
      } else { releaseInventory(g.items); order.status = 'CANCELLED'; }
    }
    orders.push(order);
  }
  return orders;
}
```

Fulfilment later: merchant marks shipped → delivered; on delivered the commerce layer calls `reserveReleaseService.markDelivered(order.customer_plan_id, deliveredAt)` (installment) and moves the order to `DELIVERED`.

---

## 6. Money: marketplace commission vs installment MDR/reserve

The engine's `mdr_bps` and `reserve_bps` (`merchants.default_mdr_bps=400`, `default_reserve_bps=500`) are **credit-risk** constructs for *installment* orders. A marketplace also needs a **platform commission / take-rate** on *every* sale, including pay-now.

Proposed split (see Open Question #3):
- **Commission (take-rate):** applies to all orders (full + installment); platform revenue. Store as `orders.commission_bps`.
- **Credit-risk reserve:** installment orders only (unchanged engine behaviour).
- **MDR:** the installment financing margin (unchanged) — for pay-now orders it collapses into the commission.

Full-order payout accrual is a **new, simple ledger transaction** (`DEBIT customer_receipts / CREDIT merchant_payable + platform_revenue`) that plugs into the existing `SettlementService` daily sweep — merchants get one settlement stream for both order types.

---

## 7. Cross-cutting needs the commerce layer introduces

| Need | Why | Direction |
|---|---|---|
| **Object storage** | product images, store logos, Ghana Card (`customers.ghana_card_image_key` already implies one) | S3 / GCS / Cloudflare R2 + a signed-URL `StorageService`. |
| **Customer auth (phone + OTP)** | today auth is staff RBAC (`users`); buyers self-register. `customers.user_id` is already nullable. | New customer identity + OTP; distinct from staff JWT/RBAC. |
| **Search** | browse/search products | Start Postgres full-text (`search_tsv`); scale to a search service later. |
| **Push notifications** | order/plan updates to phones | Extend `NotificationService` (SMS-only today) with a push channel + device-token registration. |
| **Public/customer-scoped API** | mobile apps call as a customer, not staff | Customer-scoped tokens + rate limiting. |

---

## 8. Partner compatibility (the open API stays open)

- Partners **keep** integrating exactly as today: `POST` an application with **their** `order_reference`. No internal `orders` row is created. Their storefront/fulfilment is theirs.
- Internal marketplace orders set `source='internal'` and pass `order.id`. The engine cannot tell the difference — `order_reference` is opaque to it.
- Optional future: expose catalog/order APIs to partners who *want* us to host their storefront too.

---

## 9. Open questions (decide before Phase 12)

1. **Multi-vendor cart** → one order per merchant (recommended). Can one checkout mix pay-now and installment across merchants? (Recommended: yes — each merchant-order picks its own payment type.)
2. **Installment eligibility** — merchant selects which `plan_templates` their store offers; product may narrow. Confirm granularity (store-level vs product-level).
3. **Commission model** — flat take-rate bps for all orders + credit reserve for installment only? Per-category rates?
4. **Guest checkout** — allowed for pay-now (light identity), blocked for installment (BNPL needs KYC'd, Ghana-Card-verified customer)?
5. **Fulfilment** — v1 merchant self-fulfils with manual status; integrated couriers later?
6. **Inventory oversell** — hard reserve at checkout with a TTL, or soft?

---

## 10. What this unlocks

Once Phases 11–13 (this domain) land, the same engine powers: (a) the Nesisoft marketplace's buyers and sellers, and (b) external BNPL partners — from **one** codebase, one ledger, one settlement stream. The mobile apps in [`mobile-apps.md`](./mobile-apps.md) are the buyer/seller faces of this layer.
