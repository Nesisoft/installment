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

The app **works this out itself**. Metro already knows your machine's address — it is how the phone
fetched the bundle in the first place — and Expo hands it to the client as `hostUri`, so
`src/lib/api-url.ts` derives `http://<that host>:3000`. Emulator, simulator, physical device and web
preview are all covered with no configuration and no `.env`.

`EXPO_PUBLIC_API_URL` remains as an **override** for what a derivation cannot know: a staging API, a
colleague's machine, a different port (or `EXPO_PUBLIC_API_PORT` for just the port). Set it and it
wins outright.

One case is deliberately _not_ derived: `expo start --tunnel` proxies **Metro**, not the API, so an
ngrok-style host is refused rather than guessed at. Set `EXPO_PUBLIC_API_URL` explicitly there — and
remember the phone still has to reach your API directly, which a tunnel does nothing for.

**The other half is not the app's to derive.** Two variables carry the API address, in two files,
read by two tools that do not see each other:

| Variable              | File                        | What it does                          | Left at `localhost` on a device               |
| --------------------- | --------------------------- | ------------------------------------- | --------------------------------------------- |
| `EXPO_PUBLIC_API_URL` | `apps/customer-mobile/.env` | Optional override for the app's calls | Derived from Metro — fine                     |
| `PUBLIC_API_URL`      | repo-root `.env`            | The origin baked into **image URLs**  | **Silent:** app works, every picture is blank |

- **`PUBLIC_API_URL` is the silent one.** It feeds the storage driver's public prefix, which becomes
  `MEDIA_BASE_URL`, which is what every `primary_image_url`, store logo and cart thumbnail is built
  from. Leave it at `localhost` and the app works perfectly except that every image is a flat
  coloured tile — byte-identical to the legitimate "no image" placeholder, with nothing in either
  log. It is read once at boot, so restart the API after changing it. Do **not** "fix" images by
  setting `MEDIA_BASE_URL` instead: the driver appends `/media` itself but `MEDIA_BASE_URL` is used
  verbatim, so you would trade a connection refusal for a 404.
- **If you do set the override, restart Metro with `-c`.** `EXPO_PUBLIC_*` is inlined into the bundle
  at transform time, not read at runtime, so a running dev server keeps serving the old value.
- **Open TCP 3000 and 8081** on the host firewall. A release build has no Metro and therefore no
  `hostUri`; there the fallback is `app.json`'s `extra.apiBaseUrl`.

Verify both hops before touching the phone. Every URL printed must contain your LAN IP:

```bash
curl -s http://<LAN-IP>:3000/health
curl -s http://<LAN-IP>:3000/storefront/home | grep -o 'http://[^"]*jpg'
```

### A development build, when Expo Go is not enough

Expo Go runs the app inside a prebuilt host whose native libraries are Expo's, not ours. A
development build compiles the native side from _this app's_ dependency versions, which makes it both
the fix for anything Expo Go cannot host and the way to tell whether a native crash follows the app
or stays with Expo Go.

Needs JDK 17 and the Android SDK (Android Studio is the simplest route), and `adb devices` showing
the handset:

```bash
cd apps/customer-mobile
npx expo run:android      # prebuild -> gradle -> install -> Metro
```

After the first build, `npx expo start` and opening the installed app is enough.

The networking is identical to Expo Go — Metro over the LAN, `hostUri` derivation, the same
`PUBLIC_API_URL` for images. Plain `http://` to your machine works because the generated **debug**
manifest carries `usesCleartextTraffic="true"`; the release manifest does not, so a standalone build
pointed at an `http://` API would fail every request on Android 9+ with nothing in the diff to blame.
Give production an `https://` origin, or add `expo-build-properties`.

Two side effects of `prebuild`, which `run:android` calls for you: it generates `android/`
(gitignored — the native projects are generated, never authored) and it rewrites the `android` and
`ios` scripts in `package.json` to `expo run:*`. That second one is a tracked file, so check it before
committing.

### Push notifications need an EAS project first

Both apps register the handset with `POST /me/devices` on launch and take the token off
the list on sign-out. Neither can do it yet on a clean checkout, and the reason is worth knowing
before you go looking for a bug:

`Notifications.getExpoPushTokenAsync()` mints a token against an **EAS project**, and it throws
rather than returning null when there is no project id to mint against. `app.json` carries no
`extra.eas.projectId`, so `registerForPush` takes a `no-project-id` skip on every launch and
`push_devices` stays empty. Nothing is logged as an error, because nothing has gone wrong: the app
has no push credentials, so there is no address to store.

To turn it on:

```bash
cd apps/customer-mobile
npx eas init            # writes extra.eas.projectId into app.json
npx eas credentials     # FCM (Android) / APNs (iOS) keys, per platform
npx expo run:android    # a development build — Expo Go cannot hold your push credentials
```

Then sign in and watch the row appear:

```bash
psql "$DATABASE_URL" -c \
  "select platform, device_name, is_active from push_devices order by created_at desc limit 5;"
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

### Expo Go crashing on launch: check its version first

Expo Go is a **prebuilt host**. Its native libraries are compiled into the APK from the Play Store,
and your JS bundle drives them across JSI — a native ABI contract. The JS half of a native module has
to match the version its native half was built from, and Expo Go's native half is whatever shipped in
the build you installed, not whatever your SDK patch resolves to.

When they disagree, Expo Go does not report an error. It dies with a native `SIGSEGV` inside
`__memcpy_aarch64_simd`, called from the offending library — and the tombstone contains **no
JavaScript frames at all**, so nothing in it points at a version.

Worked example, from the real thing:

```
Expo Go 57.0.2   ->  worklets 0.10.0, reanimated 4.5.0
Expo Go 57.0.9   ->  worklets 0.10.1, reanimated 4.5.1
this app (SDK 57.0.17) -> worklets 0.10.1, reanimated 4.5.1
```

Expo Go 57.0.2 crashed on every launch; **installing Expo Go 57.0.9 fixed it with no code change.**

**Keep the JS at the SDK's own versions and keep Expo Go current** — that is the direction to resolve
it from. Pinning the JS _down_ to an old Expo Go works too, but it strands the app on stale native
modules and breaks again the moment anyone updates the Play Store app.

To confirm a mismatch, read the Expo Go version from the crash dialog and compare its manifest to what
you have installed:

```bash
npm pack expo@57.0.9 && tar -xzOf expo-57.0.9.tgz package/bundledNativeModules.json
```

`npx expo install --check` will **not** catch this. It compares against the `expo` package in your
`node_modules`, not against the Expo Go on the handset — so it reports everything correct while the
app crashes on launch.

Note that nothing in this app imports `react-native-reanimated` or `react-native-worklets`. They
arrive as an optional peer of `expo-router`, and `auto-install-peers=true` in `.npmrc` reinstalls them
whatever `package.json` says — so removing them is not available as a workaround, and a bundle that
looks unchanged after removing them is that setting at work, not evidence they were absent.

### Running it in Expo Go

```bash
pnpm --filter @installment/customer-mobile start -- -c    # -c clears the transform cache
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

## On the web

The same app is the shop's website. `npx expo export --platform web` bundles it into `dist/`, a
static single-page site: any static host serves it, given a rewrite of every path to `/index.html`
so a deep link such as `/product/<id>` loads the app rather than a 404. Set `EXPO_PUBLIC_API_URL`
when exporting, because a browser has no Metro address to derive the API from.

What changes in a browser:

- **Layout.** At 900 px and wider (`src/lib/layout.ts`) the tab bar gives way to a navigation bar
  along the top (`WideNav`). Pages sit in a centred column: 1200 px for product grids, the home
  feed and shops, 720 px for everything else. Product grids go from two columns to three, four
  and five, the deals carousel becomes a row of tiles, and a product's page puts the photos beside
  the details. Below 900 px it is the phone design, unchanged.
- **Session.** It is kept in `localStorage`, since SecureStore has no web implementation; without
  it every reload, including the return from Paystack, would sign the shopper out.
- **Card payments.** Paystack's page opens in a popup, which comes back through
  `app/payment-complete.tsx`. If the browser blocks the popup, the whole tab goes to Paystack and
  comes back to the same route, which sends the shopper on to the order. The `next` it carries is
  only ever followed to a path inside the app.
- **Push** is skipped: there is no Expo push token in a browser.
- **Inactive screens** are hidden, not just painted over: `react-native-screens` is switched on for
  the web in `app/_layout.tsx`, as it is on a phone.

To try it locally against a running API:

```bash
EXPO_PUBLIC_API_URL=http://localhost:3000 npx expo export --platform web
npx serve dist --single          # or any static server with an index.html fallback
```

The API's `CORS_ORIGINS` must include the site's origin (`.env.example` lists `:8081` and `:8082`).

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
