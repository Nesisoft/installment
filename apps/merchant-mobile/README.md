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

| #   | Design screen         | State                                                                          |
| --- | --------------------- | ------------------------------------------------------------------------------ |
| 02  | Today (dashboard)     | **built**                                                                      |
| —   | Sign in               | **built** (not in the canvas)                                                  |
| —   | Open a shop           | **built**: phone code, then the account (`app/sign-up.tsx`); not in the canvas |
| 01  | Onboarding + KYC      | **built**: where a new shop lands after signing up                             |
| 03  | Order queue           | **built**                                                                      |
| 04  | Order + settlement    | **built**                                                                      |
| 05  | Instalment plans      | **built** (pushed from Today, not a tab)                                       |
| 06  | Plan + schedule       | **built**                                                                      |
| 07  | Catalog by variant    | **built**                                                                      |
| 08  | List a product        | **built**                                                                      |
| 09  | Payouts + reserve     | **built**                                                                      |
| 10  | Performance           | **built** (pushed from the Today hero, not a tab)                              |
| 11  | Storefront + settings | **built**                                                                      |

This app is also the seller website, as the shopper app is the shop's; it replaced a separate
React portal, `apps/merchant-web`. Opening a shop and the monthly and per-plan statements (with
their CSV and printable versions) moved here from that portal; a plan's schedule and settlement
always were here.

Statements export through `src/lib/statement-export.ts`: on the web the CSV downloads and the
printable page opens in a new tab; on a phone the CSV goes to the share sheet and the printable
page to the system print dialog, which can also save a PDF.

## On the web

The same app is the seller website. `pnpm export:web` (`expo export --platform web`) bundles it
into `dist/`, a static single-page site that needs every path rewritten to `/index.html`; Render
builds the `ejua-sell` site this way (`render.yaml`). Set `EXPO_PUBLIC_API_URL` when exporting,
because a browser has no Metro address to derive the API from. Locally, `pnpm dev:merchant` from
the repository root runs it in a browser on :8082, beside the shop on :8081.

What changes in a browser:

- **Layout.** At 900 px and wider (`src/lib/layout.ts`) the tab bar gives way to a navigation bar
  along the top (`WideNav`): the five tabs, the count of orders to confirm, and "List a product".
  Pages sit in a centred 720 px column, and sign-in and sign-up in a 480 px one. Sticky footers and
  sheets stop at a sensible width. Below 900 px it is the phone design, unchanged.
- **Session** is kept in `localStorage`, since SecureStore has no web implementation.
- **Push** is skipped: there is no Expo push token in a browser.
- **Inactive screens** are hidden rather than painted over: `react-native-screens` is switched on
  for the web in `app/_layout.tsx`.
- **Statements** download as files and open their printable page in a new tab.

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

### Push notifications need an EAS project first

Both apps register the handset with `POST /merchant/devices` on launch and take the token off
the list on sign-out. Neither can do it yet on a clean checkout, and the reason is worth knowing
before you go looking for a bug:

`Notifications.getExpoPushTokenAsync()` mints a token against an **EAS project**, and it throws
rather than returning null when there is no project id to mint against. `app.json` carries no
`extra.eas.projectId`, so `registerForPush` takes a `no-project-id` skip on every launch and
`push_devices` stays empty. Nothing is logged as an error, because nothing has gone wrong: the app
has no push credentials, so there is no address to store.

To turn it on:

```bash
cd apps/merchant-mobile
npx eas init            # writes extra.eas.projectId into app.json
npx eas credentials     # FCM (Android) / APNs (iOS) keys, per platform
npx expo run:android    # a development build — Expo Go cannot hold your push credentials
```

Then sign in and watch the row appear:

```bash
psql "$DATABASE_URL" -c \
  "select platform, device_name, is_active from push_devices where merchant_id is not null;"
```

Expo Go is the trap here. It can display a notification, but the token it hands you belongs to the
Expo Go app, not to yours — so a send that looks fine in Expo Go proves nothing about a real build.

Two more things that make a send silently reach nobody, both of which the client refuses to
participate in:

- **A raw FCM/APNs token instead of an Expo one.** That is what `getExpoPushTokenAsync` returns when
  the project's credentials are wrong. The server's regex would 400 it; `registerForPush` checks the
  same regex (mirrored in `@installment/api-types`) and skips rather than posting, because a stored
  bad token is an address every send fails against with nobody watching.
- **A simulator.** No token is ever issued for one. `registerForPush` skips before it asks.

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
- **One handset is one push token, whichever app registered it.** `push_devices.expo_token` is
  unique across the whole table, so a shopkeeper signing in here on the phone they shop with _moves_
  the row from their customer id to their merchant id. That is deliberate — two rows for one handset
  would deliver somebody else's notifications to it — and it is why `deregisterThisHandset` runs
  before `signOut`, while the session can still authenticate the call.

---

## Where the data comes from

Everything is under `/merchant`, which `MerchantScopeGuard` narrows to the signed-in account. The
app never sends a merchant id, and could not widen its own scope by doing so.

| Screen element                                       | Endpoint                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Shop name, verified state                            | `GET /merchant/me`                                                        |
| Sold today, the 14-day bars, best sellers            | `GET /merchant/stats?days=30`                                             |
| Payable, reserve, lifetime, active plans             | `GET /merchant/balances`                                                  |
| Variants out of stock                                | `GET /merchant/catalog/summary`                                           |
| Orders to confirm                                    | `GET /merchant/orders?status=paid` + `?status=financing_active`           |
| The order queue and its filter counts                | `GET /merchant/queue`, `GET /merchant/queue/counts`                       |
| One order: buyer, address, settlement, plan, history | `GET /merchant/orders/:id/sheet`                                          |
| Confirm / ship / deliver                             | `POST /merchant/orders/:id/{fulfilling,ship,delivered}`                   |
| Payouts, the reserve list, the destination           | `GET /merchant/payouts`, `/merchant/reserves`, `/merchant/payout-account` |
| Performance over 7 / 30 / 90 days                    | `GET /merchant/stats?days=…`                                              |

The Today screen asks for a **30**-day stats window even though it draws 14 bars: comparing today
against the same weekday last week needs the eighth day back, and a 7-day window does not contain
it. Slicing one response is free; a second round trip on a Ghanaian mobile connection is not.

### Where the canvas and the system disagree

An API-mapping pass over all eleven screens turned up 49 places where the design shows
something this system cannot supply. Where they conflict the data wins and the screen says
something true instead. The ones already handled:

| Canvas                                              | What is actually true                                                                                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order number `EJ-24902-GH`                          | They are `ORD-YYYYMMDD-XXXXXXXX`. The real one is rendered.                                                                                                                              |
| A "Message" button on an order                      | There is no messaging in this system — no threads, no send route. Omitted.                                                                                                               |
| "Print slip"                                        | No packing-slip endpoint exists. Omitted.                                                                                                                                                |
| "In tonight's payout run"                           | The settlement batch runs at 06:00 UTC, and no endpoint publishes a next-run time.                                                                                                       |
| "Releases 8 Oct — 14 days after the plan completes" | `reserveReleasesAt` is null while a plan is running, deliberately: the clock starts at completion or default. No date is invented, and the buffer is per business model and not exposed. |
| "Customer arrears never reduce it"                  | False — a default consumes reserve. The sentence is not used.                                                                                                                            |
| `NEW` as an unread marker                           | There is no seen/read column. It can only mean "awaiting confirmation".                                                                                                                  |
| Per-line variant options ("Size L · Indigo")        | `order_items` snapshots title, sku, quantity and price, not option values.                                                                                                               |
| A "Confirmed" order status                          | There is none. "Confirm order" writes `fulfilling`; the bucket mapping lives in `MERCHANT_ORDER_BUCKETS`, once.                                                                          |

Still to reconcile when their screens are built: no per-merchant delivery zones or return
policy, no shop accent colour, no returns rate, no reply time, and `stores.city`/`region` have
no writer anywhere — so the canvas's MARKET/LOCATION step cannot be saved until one is added.
