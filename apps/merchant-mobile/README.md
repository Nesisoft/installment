# Ejua Sell — merchant app

The seller side: what sold today, what is waiting on you, and what Ejua owes you. Expo (SDK 57) /
React Native 0.86, Android-first, Ghana, GHS.

Roadmap [Phase 15](../../docs/PLATFORM-ROADMAP.md#phase-15--merchant-mobile-app-expo). Built to
the seller design canvas, kept in the repo at
`docs/design/Design Prototypes/Ejua Sell (merchant).html` — open it in a browser; the left rail
lists its eleven screens.

Like the shopper app, this is a **client only**. Every cedi on screen comes from `@installment/api`.
There is no fee arithmetic here — a merchant reading "you receive GHS 291.20" is reading the
ledger, not a number this app worked out.

---

## What is built

| #   | Design screen         | State                                                                                    |
| --- | --------------------- | ---------------------------------------------------------------------------------------- |
| 02  | Today (dashboard)     | **built**                                                                                |
| —   | Sign in               | **built** (not in the canvas: the canvas starts at onboarding, which happens on the web) |
| 01  | Onboarding + KYC      | not built — registration is `apps/merchant-web/src/pages/signup.tsx`                     |
| 03  | Order queue           | not built                                                                                |
| 04  | Order + settlement    | not built                                                                                |
| 05  | Instalment plans      | not built                                                                                |
| 06  | Plan + schedule       | not built                                                                                |
| 07  | Catalog by variant    | not built                                                                                |
| 08  | List a product        | not built                                                                                |
| 09  | Payouts + reserve     | not built                                                                                |
| 10  | Performance           | not built                                                                                |
| 11  | Storefront + settings | not built (sign-out lives on the stub)                                                   |

The four unbuilt tabs are in the bar and each says so in as many words. That is deliberate: an
unbuilt Products tab rendering "No products" would tell a seller with forty listings that their
catalogue had vanished, which is the worst lie this particular app could tell.

`apps/merchant-web` still does everything. It is marked superseded in the roadmap, but nothing
should be removed from it until the tab that replaces it ships.

---

## Running it

```bash
pnpm install
pnpm build                  # the API imports core/commerce from dist/, not source
pnpm db:up                  # Docker; or ./scripts/local-stack.sh up in a container
pnpm migrate
pnpm db:seed:dev            # gives you merchant@demo.local / password123
pnpm --filter @installment/api dev

cd apps/merchant-mobile
npx expo start -c
```

The app derives the API host from Metro's own address, so an emulator, a simulator, a physical
handset on the same Wi-Fi and the web preview all work with no `.env`. Set `EXPO_PUBLIC_API_URL`
only to override that — see `.env.example`, and `src/lib/api-url.ts` for the precedence.

> `PUBLIC_API_URL` in the **repo-root** `.env` is a separate setting, read by the API, that builds
> image URLs. Leave it at `localhost` and every product photograph renders blank with nothing in
> either log. See [`docs/design/object-storage.md`](../../docs/design/object-storage.md).

---

## Traps

Most of these are the shopper app's traps too; they are repeated because they bite per-app.

- **Money is integer pesewas.** Format with `ghs()` / `cedis()` from
  `src/lib/format`. Never divide by 100 in a screen. Note the default differs from the shopper
  app: `ghs()` here shows pesewas, because a seller reconciles against a MoMo statement and
  `GHS 906` where the payout was `GHS 905.60` is a figure they cannot match.
- **Never `new Date(apiString)`.** `timestamptz` comes back as `2026-08-28 11:51:27+00` — space
  separator, two-digit offset — which Hermes reads as `Invalid Date`. Use `src/lib/dates`.
- **Never hard-code a colour, radius or font.** `src/theme/tokens` holds the canvas's own values.
  The palette is the shopper app's warm-neutral family; what differs is that **green leads** here.
  The tokens are duplicated rather than shared with `apps/customer-mobile` on purpose — see the
  docstring at the top of the file.
- **`<Text>` from `src/components`, never React Native's.** RN does not inherit a custom font
  across component boundaries, so a bare `RNText` silently drops Outfit for Roboto.
- **A bar chart's height must be pixels, not a percentage.** A percentage against a parent whose
  own height is content-derived resolves to zero and every bar disappears. `Sparkline` computes
  pixels; this exact bug shipped on the merchant web chart before it was caught.
- **`number_of_installments` excludes the deposit.** "Pay in 4" is a deposit plus three
  instalments. Count `schedule.length`.
- **Money-moving calls take an idempotency key minted once per attempt**, held in a ref and reused
  on retry (`newIdempotencyKey` from `@installment/mobile-kit`). A fresh key per tap is a second
  debit. Nothing on the Today screen moves money; Orders will.
- **The session key is not the shopper app's.** A handset with both installed often has two
  different people's sessions on it.

---

## Where the data comes from

Everything is under `/merchant`, which `MerchantScopeGuard` narrows to the signed-in account. The
app never sends a merchant id, and could not widen its own scope by doing so.

| Screen element                            | Endpoint                                                        |
| ----------------------------------------- | --------------------------------------------------------------- |
| Shop name, verified state                 | `GET /merchant/me`                                              |
| Sold today, the 14-day bars, best sellers | `GET /merchant/stats?days=30`                                   |
| Payable, reserve, lifetime, active plans  | `GET /merchant/balances`                                        |
| Variants out of stock                     | `GET /merchant/catalog/summary`                                 |
| Orders to confirm                         | `GET /merchant/orders?status=paid` + `?status=financing_active` |

The Today screen asks for a **30**-day stats window even though it draws 14 bars: comparing today
against the same weekday last week needs the eighth day back, and a 7-day window does not contain
it. Slicing one response is free; a second round trip on a Ghanaian mobile connection is not.
