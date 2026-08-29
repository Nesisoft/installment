# Ejua — customer app

The shopping app: browse, buy now or pay in instalments, track the order, and keep on top of what
you owe. Expo (SDK 57) / React Native 0.86, Android-first, Ghana, GHS.

It is a **client only**. Every figure on screen comes from `@installment/api` — the app does no
instalment arithmetic of its own, because a preview that is a pesewa out is a preview that argues
with the contract.

---

## Running it

```bash
# 1. Install, and BUILD the workspace packages.
#    The API imports @installment/core and @installment/commerce from their
#    built dist/, not from source — apps/api/tsconfig.json has no paths
#    redirect. Skip this and `nest start` opens with ~50 "has no exported
#    member" errors that look like missing code and are only a missing build.
pnpm install
pnpm build

# 2. Bring up Postgres + Redis, and migrate
pnpm db:up                  # Docker; or ./scripts/local-stack.sh up in a container
pnpm migrate

# 3. Seed a shoppable catalogue, pickup hubs and a Pay-in-4 plan
pnpm db:seed:dev

# 4. Run the API. It already binds 0.0.0.0 — there is no flag to pass.
pnpm --filter @installment/api dev

# 5. Point the app at it and start Metro
cd apps/customer-mobile
printf 'EXPO_PUBLIC_API_URL=http://<LAN-IP>:3000\n' > .env   # see below
npx expo start -c
```

> **When `pnpm build` fails in an app you are not working on.** One broken web app
> aborts the whole run before `core` and `commerce` are built, which leaves the API
> exactly as broken as if you had not built at all. Build only what the API needs:
>
> ```bash
> pnpm build --filter=@installment/api...
> ```

### Which API URL

**Two** variables carry it, in two different files, read by two different tools. Expo reads
`apps/customer-mobile/.env`; Nest reads the repo-root `.env`. Neither walks into the other.

| Variable              | File                        | What it does                         | If left at `localhost` on a device            |
| --------------------- | --------------------------- | ------------------------------------ | --------------------------------------------- |
| `EXPO_PUBLIC_API_URL` | `apps/customer-mobile/.env` | Every API call the app makes         | Nothing loads                                 |
| `PUBLIC_API_URL`      | repo-root `.env`            | The origin baked into **image URLs** | **Silent:** app works, every picture is blank |

`localhost` on a handset means the handset. Set `EXPO_PUBLIC_API_URL` to match how you run it:

| Target                    | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| Android emulator          | `http://10.0.2.2:3000` (the host loopback as the emulator sees it)         |
| iOS simulator             | `http://localhost:3000`                                                    |
| Physical device (Expo Go) | `http://<your-LAN-ip>:3000`                                                |
| `expo start --web`        | `http://localhost:3000`, and add `http://localhost:8081` to `CORS_ORIGINS` |

Four things that cost real time here:

- **Do not `cp .env.example .env` for a handset.** The example ships `10.0.2.2`, which exists only
  inside the Android emulator's NAT. On a real phone those packets are dropped rather than refused,
  so you get a 20-second hang and then "We couldn't reach Ejua" on every screen — which reads as a
  flaky network, not a wrong address. Write the file with your LAN IP directly.
- **`PUBLIC_API_URL` is the silent one.** It feeds the storage driver's public prefix, which becomes
  `MEDIA_BASE_URL`, which is what every `primary_image_url`, store logo and cart thumbnail is built
  from. Leave it at `localhost` and the app works perfectly except that every image is a flat
  coloured tile — byte-identical to the legitimate "no image" placeholder, with nothing in either
  log. It is read once at boot, so restart the API after changing it. Do **not** "fix" images by
  setting `MEDIA_BASE_URL` instead: the driver appends `/media` itself but `MEDIA_BASE_URL` is used
  verbatim, so you would trade a connection refusal for a 404.
- **Restart Metro with `-c` after editing `.env`.** `EXPO_PUBLIC_*` is inlined into the bundle at
  transform time, not read at runtime, so a running dev server keeps serving the old value.
- **Open TCP 3000 and 8081** on the host firewall, and check the app's fallback if nothing seems to
  apply: with no `.env`, `config.ts` falls through to `app.json`'s `extra.apiBaseUrl`, which is
  `http://localhost:3000` — the `10.0.2.2` default further down that expression is unreachable.

Verify both hops before touching the phone. Every URL printed must contain your LAN IP:

```bash
curl -s http://<LAN-IP>:3000/health
curl -s http://<LAN-IP>:3000/storefront/home | grep -o 'http://[^"]*jpg'
```

### Expo Go

Expo Go supports only the current SDK, so it must be an SDK 57 build (57.x). Phone and laptop on the
same subnet, with AP/client isolation off. `--tunnel` gets Metro through a hostile network but does
nothing for the API, which the phone still reaches directly — so the app will load and then fail
every request.

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
