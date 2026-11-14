# Mobile Apps (Expo) — Design

> **Status:** Design (pre-implementation). Companion to [`../PLATFORM-ROADMAP.md`](../PLATFORM-ROADMAP.md) and [`commerce-domain.md`](./commerce-domain.md).
> **Concern:** The **customer** and **merchant** experiences are **Expo (React Native) mobile apps** — a shopping app for buyers and a seller app for merchants. **Admin stays a React web console.**

---

## 1. What changes from the original plan

The original `DEVELOPMENT-PLAN.md` Phase 10 specced three **React web** apps (Vite + shadcn/ui). Reconciled with the actual intent:

| App | Original plan | Now |
|---|---|---|
| Customer | `apps/customer-web` (React web dashboard) | **`apps/customer-mobile`** — Expo shopping app |
| Merchant | `apps/merchant-web` (React web dashboard) | **`apps/merchant-mobile`** — Expo seller app |
| Admin | `apps/admin-web` (React web console) | **unchanged** — React web (Vite + shadcn/ui) |

`apps/customer-web` and `apps/merchant-web` (empty placeholders) are **superseded** and will be removed when the Expo apps land. An optional merchant *web* dashboard can come later; mobile-first per the vision.

> **Update.** `apps/customer-web` is removed: the shop's website is now `apps/customer-mobile` itself, exported for the web with a desktop layout above 900 px (see that app's README, "On the web"). `apps/merchant-web` remains for now, as the seller's signup, KYC and statements portal, until those flows are in the seller app.

> **Important correction:** `packages/ui` is **shadcn/ui — web-only (DOM)**. It **cannot** back the Expo apps. Mobile needs its own styling/component stack (§3). `packages/api-types` (generated types) **is** shareable across web and mobile.

---

## 2. Monorepo placement

```
apps/
  api/                NestJS (built ✓)
  admin-web/          React web — Vite + shadcn/ui           (Phase 16)
  customer-mobile/    Expo app — buyers/shoppers             (Phase 14)   ← new
  merchant-mobile/    Expo app — sellers                     (Phase 15)   ← new
  customer-web/       ⌫ superseded by customer-mobile
  merchant-web/       ⌫ superseded by merchant-mobile
packages/
  api-types/          OpenAPI-generated types (web + mobile) — shareable
  api-client/         typed fetch + TanStack Query hooks     — shareable  ← new
  ui/                 shadcn/ui — WEB ONLY (admin-web)
  ui-mobile/          shared RN components for both Expo apps — shareable  ← new (optional)
```

Expo + a pnpm/Turborepo monorepo works, but needs Metro configured to resolve workspace packages (`transpilePackages` / `metro.config.js` with `watchFolders` + symlink resolution). Note this in Phase 14 setup.

---

## 3. Stack (both Expo apps)

| Concern | Choice | Rationale |
|---|---|---|
| Framework | **Expo (SDK latest)** + **Expo Router** | File-based navigation, OTA updates, managed native modules. Chromium/EAS build later. |
| Data fetching | **TanStack Query** + persistence | Same lib the web plan uses; offline cache via `persistQueryClient`. |
| Types/validation | **`packages/api-types`** (from OpenAPI) + **Zod** | Reuse the API's Swagger doc (already served at `/docs`) to generate types via `openapi-typescript`/`orval`. |
| Styling/components | **NativeWind** (Tailwind for RN) + a RN kit (gluestack-ui / Tamagui) | shadcn is DOM-only; NativeWind keeps a Tailwind mental model across web+mobile. |
| Auth storage | **Expo SecureStore** | JWT / customer token at rest. |
| Media capture | **Expo Camera / ImagePicker** | Ghana Card capture (KYC), product photos. |
| Push | **Expo Notifications** | Device-token registration → engine push channel (§6). |
| Payments | **Paystack** — MoMo via existing charge API; card via Paystack RN SDK or WebView/hosted link | Reuses `PaymentService` endpoints; MoMo is the primary rail (GH). |
| Local state | Zustand or React Context | Cart, session, UI. |

---

## 4. Customer app (`apps/customer-mobile`) — screens

Derived from the vision (browse → cart → checkout → pay → track) + engine capabilities.

| Area | Screens | Backend |
|---|---|---|
| Onboarding | Phone + OTP, profile, **Ghana Card capture** (for BNPL KYC), consents | Customer auth (new, §6); `customers` (`ghana_card_image_key`, `kyc_tier`, consent columns) |
| Discover | Home, categories, search, product list | Catalog APIs (Phase 11) |
| Product | Detail, variant picker, **installment plan selector + live calculator** | `products`, `product_plan_offers`; calculator mirrors `schedule-generator` |
| Buy | Cart, address, **checkout (pay-now vs installment)**, payment (MoMo/card) | Cart/orders (Phase 12) + `PaymentService` |
| Post-purchase | Order tracking, delivery status, ratings | `shipments` (Phase 13) |
| My plans | Upcoming installments, **pay-early**, history, receipts | engine: `customer_plans`, installments, receipts |
| Account | KYC status, saved MoMo, addresses, notifications | `customers`, `addresses` |

The **live installment calculator** must match the engine's `schedule-generator` exactly (down payment, frequency, count) so the preview equals the activated schedule.

---

## 5. Merchant app (`apps/merchant-mobile`) — screens

| Area | Screens | Backend |
|---|---|---|
| Onboarding | Business KYC, bank/payout setup, store profile | `merchants` (`paystack_recipient_code`, `status=pending_kyc`), `stores` |
| Catalog | Product list, **create/edit product (photos via camera/gallery)**, variants, inventory/stock, set plan offers | `products`, `product_variants`, `product_images`, `inventory`, `product_plan_offers` |
| Orders | Incoming orders, order detail, **mark shipped / delivered** | `orders`, `shipments` → `markDelivered` seam |
| Money | Sales dashboard, **settlements (pending/paid/reserved)**, statement download | engine: `MerchantDashboardService`, settlements/reserves |
| Account | Store settings, notifications | `stores`, notifications |

Marking an order **delivered** here is what finally fires `ReserveReleaseService.markDelivered` — closing the layaway reserve loop with a real event.

---

## 6. Backend gaps the mobile apps require

These are **new backend work** (folded into Phases 11–14), not just UI:

1. **Customer auth (phone + OTP)** — buyers self-register; distinct from staff JWT/RBAC. `customers.user_id` is already nullable to allow this.
2. **Commerce APIs** — catalog, cart, orders, fulfilment (the whole `commerce-domain.md` surface).
3. **Push channel** — extend `NotificationService` (SMS-only today) with push + a device-token registration endpoint.
4. **Object storage + signed URLs** — product images, store logos, Ghana Card.
5. **Customer-scoped API tokens + rate limiting** — public traffic from apps.
6. **In-app payments** — confirm Paystack RN approach for card; MoMo reuses existing charge endpoints.

---

## 7. Build sequence

Mobile apps depend on the commerce APIs, so they come **after** the domain lands:

- **Phase 11–13** — commerce backend (catalog, cart/checkout/orders, fulfilment) + customer auth + storage + push.
- **Phase 14** — `customer-mobile` (Expo) once catalog+checkout APIs exist; ship an end-to-end test purchase from a phone.
- **Phase 15** — `merchant-mobile` (Expo).
- **Phase 16** — `admin-web` (unchanged React web) + marketplace ops.

A thin **API-types + api-client** package should land first (early Phase 11) so every app — mobile and web — shares one generated, typed client off the OpenAPI spec.
