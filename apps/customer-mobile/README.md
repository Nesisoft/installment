# Ejua — customer app

The shopping app: browse, buy now or pay in instalments, track the order, and keep on top of what
you owe. Expo (SDK 57) / React Native 0.86, Android-first, Ghana, GHS.

It is a **client only**. Every figure on screen comes from `@installment/api` — the app does no
instalment arithmetic of its own, because a preview that is a pesewa out is a preview that argues
with the contract.

---

## Running it

```bash
# 1. Bring up Postgres + Redis and migrate (no Docker needed)
./scripts/local-stack.sh up

# 2. Seed a shoppable catalogue, pickup hubs and a Pay-in-4 plan
pnpm db:seed:dev

# 3. Run the API on 0.0.0.0:3000 — a handset cannot reach 127.0.0.1
DATABASE_URL=postgresql://installment:installment@localhost:5432/installment \
REDIS_URL=redis://localhost:6379 \
pnpm --filter @installment/api dev

# 4. Point the app at it and start Metro
cd apps/customer-mobile
cp .env.example .env      # then edit EXPO_PUBLIC_API_URL — see below
pnpm dev
```

### Which API URL

`localhost` means the handset, not your machine. Set `EXPO_PUBLIC_API_URL` to match how you run it:

| Target                    | Value                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| Android emulator          | `http://10.0.2.2:3000` (the host loopback as the emulator sees it)  |
| iOS simulator             | `http://localhost:3000`                                             |
| Physical device (Expo Go) | `http://<your-LAN-ip>:3000`, and bind the API to `0.0.0.0`          |
| `expo start --web`        | `http://localhost:3000`, and add the Metro origin to `CORS_ORIGINS` |

### Signing in locally

Customer auth is phone + OTP, and the code is hashed at rest — you cannot read it out of Redis. In
development the console SMS sender can print it:

```bash
SMS_PROVIDER=console SMS_LOG_BODY=true pnpm --filter @installment/api dev
```

`env.validation` refuses to start production with `SMS_LOG_BODY` on, for the obvious reason.

The seeded customer is `+233 24 000 0002` (Ama Boateng).

---

## Layout

```
app/                        Expo Router — one file per screen
  _layout.tsx               providers, fonts, splash, the one auth redirect rule
  onboarding.tsx            phone → OTP → (profile, when registering)
  (tabs)/                   Home · Browse · Cart · Orders · Account
  product/[id].tsx          gallery, live plan quote, variants, escrow, reviews
  store/[slug].tsx          a vendor's shelf and their real stats
  checkout.tsx              fulfilment, payment choice, and the BNPL approval sheet
  confirmation/[orderId]    polls until the MoMo charge settles
  orders/[id].tsx           lifecycle timeline and courier detail
  plans/index.tsx           every instalment, auto-debit switch, the real late-fee terms
  wallet.tsx                limit, repayment record, MoMo method, payment history
src/
  theme/                    tokens lifted from the design canvas
  components/               shared primitives; nothing else styles from scratch
  features/                 typed hooks, one module per API domain
  lib/                      money, dates, config, session
```

## Things worth knowing before you change it

**Money is integer pesewas, everywhere.** GHS 289.90 is `28990`. Format with `lib/format`;
nothing divides by 100 inline.

**Never `new Date(apiString)`.** The API's `timestamptz` columns are declared `mode: 'string'`,
but `node-postgres` re-serialises them as `2026-08-28 11:51:27+00` — space separator, two-digit
offset — and Hermes parses that as `Invalid Date`. Everything goes through
`lib/dates.parseApiDate`. Bare `YYYY-MM-DD` due dates are read as _local noon_ so a device west of
UTC does not render the previous day.

**"Pay in 4" is a deposit plus three instalments.** `plan.number_of_installments` **excludes** the
deposit — that is the engine's definition. Count `schedule.length`, or use the feed's `position` /
`total_installments`. Getting it backwards tells someone they owe a fifth payment.

**Idempotency keys are minted per _attempt_, not per tap.** Approving a MoMo prompt means leaving
the app, so coming back to a spinner and tapping Pay again is the normal case. A fresh key there
is a second debit. Mint into a `useRef`, reuse on retry, and mint a new one only when the payload
changes (the server hashes the body — same key, different body is a 409).

**A 409 on a payment is not an error.** It means a charge is already in flight for that
instalment. Render it as progress.

**The app browses signed out.** Only the customer's own data needs a session. Asking for a phone
number before showing anything is how a marketplace loses first-time visitors.

## Where the app departs from the design

Recorded in full, with reasoning, in
[`docs/design/customer-app.md`](../../docs/design/customer-app.md) §3. The short version: the
Wallet has no stored balance (that is an e-money licence, not a feature), the retry copy states
the real four-attempt policy, due dates are not Friday-anchored because the engine does not anchor
them, and the late-fee terms are rendered from each plan's own rate and cap rather than hard-coded.

## Previewing it without a handset

`npx expo export --platform web` bundles the app, and serving the output is enough to check that
screens render against a live API. One caveat: in the web build the tab navigator leaves inactive
screens stacked in the document instead of detaching them, so a screenshot after switching tabs can
show the previous screen above the new one — scroll down and the new screen is there. That is
`react-native-screens` having no native detach on web; on Android and iOS it behaves normally.

Deep links (`/browse`) also 404 on a plain static file server because the export is a single-page
bundle — navigate from `/` instead.

## Checks

```bash
pnpm --filter @installment/customer-mobile typecheck
pnpm --filter @installment/customer-mobile lint
pnpm --filter @installment/customer-mobile test
```

Tests cover the pure logic — formatting, date parsing, derivations. Component rendering is not
covered: it needs the React Native preset (`jest-expo`), which is a heavier setup than the
workspace's vitest runner and is worth adding when the first component regression bites.

## Not built yet

Ghana Card capture (KYC tier 2), push _delivery_ (registration ships), live courier position, and
the returns/disputes journey. Each has a seam left for it — see `docs/design/customer-app.md` §4.
