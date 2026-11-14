# Deploying to Render, with Supabase, Upstash and Cloudflare R2

This is the setup for a **test deployment**: the whole platform online, running on Paystack's test
keys, for trying every app end to end. The same steps make a production deployment later; what
changes for production is listed at the end.

| Piece                                             | Runs on                              | Defined in                         |
| ------------------------------------------------- | ------------------------------------ | ---------------------------------- |
| API (`apps/api`)                                  | Render web service `ejua-api`        | [`render.yaml`](../../render.yaml) |
| Admin console (`apps/admin-web`)                  | Render static site `ejua-admin`      | `render.yaml`                      |
| Seller site (`apps/merchant-mobile`, for the web) | Render static site `ejua-sell`       | `render.yaml`                      |
| Shop (`apps/customer-mobile`, built for the web)  | Render static site `ejua-shop`       | `render.yaml`                      |
| Postgres                                          | Supabase                             | this guide, §1.1                   |
| Redis (rate limits, one-time codes, retry queue)  | Upstash                              | this guide, §1.2                   |
| Uploads (product photos, Ghana Card scans)        | Cloudflare R2                        | this guide, §1.3                   |
| Shopper and seller mobile apps                    | Your phone (Expo Go or an EAS build) | this guide, §4                     |

The order that works:

1. Prepare the services: §1.
2. Run the apps on your machine against them: §2. Anything wrong with a connection string shows up
   here, where it is quick to fix.
3. Deploy to Render: §3.
4. Point the mobile apps at it: §4.

---

## 1. Prepare the services

### 1.1 Supabase (Postgres)

**Use the session pooler connection string.** Supabase gives three:

- **Direct** (`db.<ref>.supabase.co`). It is IPv6-only unless you buy the IPv4 add-on, so it may not
  be reachable from Render.
- **Transaction pooler** (port 6543). It drops session state between transactions.
- **Session pooler** (port 5432). It works over IPv4 and behaves like a normal connection.

In the Supabase dashboard, open **Connect**, choose **Session pooler**, and copy the string. It looks
like this:

```
postgresql://postgres.<project-ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres
```

Notes on that string:

- **Username.** It is `postgres.<project-ref>`, not `postgres`. With the wrong one the pooler
  answers `Tenant or user not found`.
- **Password.** Percent-encode any `@ # ? & /` or space in it.
- **Host.** Copy it from the dashboard; it can't be worked out from the region name.

**Download the CA certificate and verify the connection.** Under **Database Settings → SSL
Configuration**, choose **Download certificate**. Then add two parameters to the connection string:

```
...supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/path/to/supabase-ca.crt
```

Do **not** use `sslmode=require`. The `pg` driver this repo uses (8.21) treats `require` as "verify
against the system's certificate authorities". Supabase's certificate is signed by Supabase's own
CA, so the connection fails with `unable to verify the first certificate`, or `self-signed
certificate in certificate chain`. `sslmode=no-verify` connects, encrypted but unverified; keep it
as a stopgap only. All three behaviours were reproduced against a Postgres signed by a private CA
while writing this guide.

Optional: **Enforce SSL on incoming connections** in the same settings refuses unencrypted
connections. Turning it on reboots the database.

**Mind the connection budget.**

- Supabase's default pool is **15** connections.
- Every process that connects counts against it: the API on Render, an API on your laptop, the
  migration runner, a SQL client.
- The API holds at most `DATABASE_POOL_MAX` connections; `render.yaml` sets 5. Use 5 locally too,
  or raise the pool size in **Database Settings**.

**Schema.** The migrations need no superuser. They were run, all 26, as a non-superuser owner with
`pgcrypto` pre-installed in an `extensions` schema, as Supabase sets it up. They live in the `public`
schema next to Supabase's own `auth` and `storage` schemas, which the platform does not touch.

### 1.2 Upstash (Redis)

1. Create a database in the region nearest Render's Frankfurt, such as `eu-central-1`.
2. **Leave eviction off.** It is off by default. The retry queue and one-time codes must not be
   evicted to make room.
3. Build the URL from the endpoint and password the console shows. Note the `rediss` (two s's):
   Upstash only accepts TLS.

   ```
   rediss://default:<password>@<endpoint>.upstash.io:6379
   ```

**Commands are what you pay for.** The free tier allows 500,000 a month, and the retry queue
(BullMQ) polls Redis even when nothing is queued. Measured with the scheduled jobs on:

| Settings                                                              | Idle API, per minute | Per month  |
| --------------------------------------------------------------------- | -------------------- | ---------- |
| BullMQ's defaults                                                     | ~100 commands        | ~4,400,000 |
| `QUEUE_DRAIN_DELAY_SECONDS=300`, `QUEUE_STALLED_INTERVAL_SECONDS=300` | ~2 commands          | ~90,000    |

`render.yaml` sets the second row. The health check also asks Redis at most once a minute, however
often Render polls it. Traffic adds a few commands per request (rate limiting), which is small
during testing.

**For production**, Upstash recommends a Fixed plan for BullMQ; those plans aren't billed per
command.

### 1.3 Cloudflare R2 (uploads)

Uploads go from the app straight to R2 on a short-lived signed URL; the API never handles the file.

1. **Create a bucket**, for example `ejua-media`, and leave it **private**.
2. **Create an API token.** Go to **R2 → Manage API tokens → Create API token**, choose **Object
   Read & Write**, and scope it to that one bucket. Copy the **Access Key ID** and **Secret Access
   Key**; the secret is shown only once.
3. **Note your account ID.** The S3 endpoint is `https://<account-id>.r2.cloudflarestorage.com`.
4. **Add a CORS policy** so browsers may upload. Go to the bucket's **Settings → CORS Policy**, open
   the JSON tab, and list every origin a web app runs on:

   ```json
   [
     {
       "AllowedOrigins": [
         "https://ejua-admin.onrender.com",
         "https://ejua-sell.onrender.com",
         "https://ejua-shop.onrender.com",
         "http://localhost:8081",
         "http://localhost:8082",
         "http://localhost:5175"
       ],
       "AllowedMethods": ["PUT", "GET"],
       "AllowedHeaders": ["Content-Type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Replace the `onrender.com` names with the ones Render actually gives you (§3.2). The mobile apps
   don't need CORS.

5. **Make product images readable.** Objects are stored under two prefixes. `public/` holds product
   photos and shop artwork. `private/` holds Ghana Card scans and seller KYC documents, which the
   API only ever serves through a signed link. R2's public access, however, applies to the **whole
   bucket**:
   - **For testing:** enable the bucket's **r2.dev** URL. Cloudflare rate-limits it and says it is
     for development only. Private keys are random UUIDs, so they can't be guessed, but anyone
     holding one could read the file. **Do not upload real people's ID documents while r2.dev is
     on.**
   - **Before real data:**
     - Connect a **custom domain** to the bucket, for example `media.yourdomain.com`.
     - Add a WAF custom rule on it that blocks requests whose path doesn't start with `/public/`.
     - Disable the r2.dev URL.

     Cloudflare documents WAF rules on R2 custom domains, but not this particular rule. Confirm it
     blocks `/private/...` before relying on it.

   The public address, r2.dev or custom domain, is your `STORAGE_PUBLIC_URL`. Image URLs come out as
   `STORAGE_PUBLIC_URL/public/products/<id>.jpg`.

R2 has no per-object size limit to set. The API refuses to issue an upload URL for anything over
`STORAGE_MAX_UPLOAD_BYTES` (10 MB). It can't stop a client that lies about the size on the PUT
itself.

### 1.4 Paystack, Hubtel, Expo

- **Paystack (test mode).**
  - The secret key `sk_test_...` goes to the API, and the public key `pk_test_...` to the shop.
  - The webhook URL is set after deploying (§3.5).
  - Payouts to sellers will be refused in test mode with "You cannot initiate third party payouts as
    a starter business" until transfers are enabled on the account
    ([`runbooks/payouts.md`](../runbooks/payouts.md)).
- **Hubtel.**
  - You need the Client ID and Client Secret, and a **sender ID approved on your account**
    (`HUBTEL_SENDER_ID`, 11 characters at most).
  - The API refuses to start in production without a real SMS provider: shoppers and sellers sign in
    with a one-time code by text, so without one nobody could log in.
  - Arkesel works instead: `SMS_PROVIDER=arkesel` and `ARKESEL_API_KEY`.
- **Expo.** An account is needed only for installable builds and push notifications (§4.2). Expo Go
  needs none.

---

## 2. Run locally against these services

This checks every connection string before Render is involved. For day-to-day development, the
all-local stack in [`LOCAL-SETUP.md`](../LOCAL-SETUP.md) is still faster and costs no Upstash
commands.

### 2.1 Root `.env`

Copy `.env.example` to `.env` and change these values. Quote values containing `&` if you ever
`source` the file in a shell.

```bash
NODE_ENV=development

DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/absolute/path/to/supabase-ca.crt
DATABASE_POOL_MAX=5

REDIS_URL=rediss://default:<password>@<endpoint>.upstash.io:6379
QUEUE_DRAIN_DELAY_SECONDS=300
QUEUE_STALLED_INTERVAL_SECONDS=300
# Off here: the Render API runs the scheduled jobs against the same database.
ENABLE_SCHEDULED_WORKERS=false

STORAGE_DRIVER=s3
STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_FORCE_PATH_STYLE=true
STORAGE_BUCKET=ejua-media
STORAGE_ACCESS_KEY_ID=<r2 access key id>
STORAGE_SECRET_ACCESS_KEY=<r2 secret>
STORAGE_PUBLIC_URL=https://pub-<id>.r2.dev

PAYSTACK_SECRET_KEY=sk_test_...

# Locally the one-time codes can go to your terminal instead of a phone:
SMS_PROVIDER=console
SMS_LOG_BODY=true
```

Two rules for running locally and on Render together:

- **`ENABLE_SCHEDULED_WORKERS` must be on for exactly one API pointed at a database.** Two would both
  charge the same instalments and both pay the same sellers. Locks and idempotency make most of that
  safe, but not all of it, so keep the local one off.
- **Use your own sign-in secrets locally.** `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` can keep the
  development defaults: a local API never shares them with Render. The production API refuses to
  start with the published defaults.

### 2.2 Create the schema and the first admin

```bash
pnpm install
pnpm migrate                                  # applies every migration to Supabase
pnpm --filter @installment/api build
ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='a long passphrase' ADMIN_NAME='Your Name' \
  pnpm --filter @installment/api create:admin
```

The admin is created in Supabase, so the same login works on the Render console later.

**Optional demo catalogue.** It gives you shops and products to browse:

```bash
pnpm db:seed:dev
```

The seed also creates logins whose passwords are published in the repository (`password123`). On a
database the internet can reach through Render, switch those logins off straight after seeding. In
the Supabase SQL editor, run:

```sql
UPDATE users SET password_hash = NULL
 WHERE email LIKE '%@fixture.local'
    OR email IN ('seed-admin@installment.local', 'merchant@demo.local');
```

The demo shops and products stay; nobody can sign in as them.

### 2.3 Start the apps

```bash
pnpm dev:api          # API on http://localhost:3000; check http://localhost:3000/health
pnpm dev:web          # admin console :5175
pnpm dev:customer     # the shop, in a browser on :8081 (Expo's web preview)
pnpm dev:merchant     # the seller site, in a browser on :8082
```

The admin console reads `VITE_API_BASE_URL` from `apps/admin-web/.env`. It defaults to
`http://localhost:3000`, so it needs no `.env` for this. The shop and the seller site work out the
API's address from where they were loaded, so they need none either.

`/health` should answer `{"status":"ok","info":{"db":"up","redis":"up"}}`. If either is `down`, see
§5 before going further.

The mobile apps against your local API are covered in each app's README
([`customer-mobile`](../../apps/customer-mobile/README.md),
[`merchant-mobile`](../../apps/merchant-mobile/README.md)). With `STORAGE_DRIVER=s3`, image URLs no
longer depend on `PUBLIC_API_URL`, because they point at R2.

---

## 3. Deploy to Render

### 3.1 Create the services from the Blueprint

1. Push the branch you want deployed (normally `main`).
2. In Render, choose **New → Blueprint** and connect the GitHub repository. Render reads
   `render.yaml` and proposes four services.
3. Render asks for every value marked `sync: false`. Use the same values as §2.1, except:

| Service                  | Variable                                    | Value                                                                                              |
| ------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ejua-api`               | `DATABASE_URL`                              | Your session pooler string, ending `?sslmode=verify-full&sslrootcert=/etc/secrets/supabase-ca.crt` |
| `ejua-api`               | `CORS_ORIGINS`                              | `https://ejua-admin.onrender.com,https://ejua-sell.onrender.com,https://ejua-shop.onrender.com`    |
| `ejua-api`               | `HUBTEL_CLIENT_ID`, `_SECRET`, `_SENDER_ID` | From Hubtel                                                                                        |
| `ejua-admin`             | `VITE_API_BASE_URL`                         | `https://ejua-api.onrender.com`                                                                    |
| `ejua-sell`, `ejua-shop` | `EXPO_PUBLIC_API_URL`                       | `https://ejua-api.onrender.com`                                                                    |

The JWT secrets are generated by Render. Every other setting is already in `render.yaml`.

### 3.2 Check the real hostnames

Render builds each hostname from the service name. If a name is already taken, the hostname can
differ. Once the services exist, read the real URLs off each service's page. If any differs from
the table above:

- correct `CORS_ORIGINS` on the API;
- correct `VITE_API_BASE_URL` on `ejua-admin` and `EXPO_PUBLIC_API_URL` on `ejua-sell` and
  `ejua-shop`;
- correct the R2 CORS policy (§1.3).

Then **redeploy the static sites**. Their API address is compiled into the bundle, so changing the
variable does nothing until they rebuild.

### 3.2a An `ejua-shop` created before the shop became the app

The shop site used to be a separate React app (`apps/customer-web`, now removed). If your
`ejua-shop` service was created from that version of `render.yaml`, or by hand, a Blueprint sync
does not ask for the new variable. In the service's settings:

1. **Build Command:**
   `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @installment/customer-mobile export:web`
2. **Publish Directory:** `apps/customer-mobile/dist`
3. **Environment:** add `EXPO_PUBLIC_API_URL` = your API's URL. `VITE_API_BASE_URL` and
   `VITE_PAYSTACK_PUBLIC_KEY` are no longer read; you can delete them.
4. Keep the `/*` → `/index.html` rewrite, then **Manual Deploy**.

The site's address does not change, so `CORS_ORIGINS` and the R2 CORS policy stay as they are.
Locally, the shop's dev origin is now `http://localhost:8081`: add it to the R2 policy if you
upload from a local shop.

### 3.2b An `ejua-sell` created before the seller site became the app

The seller site used to be a separate React app too (`apps/merchant-web`, now removed). An
`ejua-sell` service created before this change needs the same treatment, in its settings:

1. **Build Command:**
   `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @installment/merchant-mobile export:web`
2. **Publish Directory:** `apps/merchant-mobile/dist`
3. **Environment:** add `EXPO_PUBLIC_API_URL` = your API's URL. `VITE_API_BASE_URL` is no longer
   read; you can delete it.
4. Keep the `/*` → `/index.html` rewrite, then **Manual Deploy**.

The address does not change here either. Sellers who were signed in to the old portal sign in once
more: the app keeps its session under its own key. Locally, the seller site's dev origin is now
`http://localhost:8082` instead of `:5174`: swap it in the R2 policy if you upload from a local
seller site.

### 3.3 Give the API Supabase's certificate

On `ejua-api`, open **Environment → Secret Files** and add a file named `supabase-ca.crt` with the
contents of the certificate from §1.1. Render mounts it at `/etc/secrets/supabase-ca.crt`, the path
`DATABASE_URL` names. Then choose **Manual Deploy → Deploy latest commit** if the first deploy ran
before the file existed.

### 3.4 Watch the first deploy

Each deploy goes through three stages:

1. **Build:** `pnpm install`, then the turbo build. Expect several minutes the first time.
2. **Pre-deploy:** `pnpm migrate`. After §2.2 it says
   `nothing to apply — database is up to date`. It applies new migrations on later deploys.
3. **Start**, then Render's health check on `/health`.

If the API refuses to start, the log names the setting. For example:

```
JWT_ACCESS_SECRET: refusing to start: ... the published development value
SMS_PROVIDER: refusing to start: SMS_PROVIDER=console delivers nothing ...
```

A warning that `customers.ejua.gh has no MX record` is expected until that domain is registered
([`runbooks/standin-email-domain.md`](../runbooks/standin-email-domain.md)). It does not stop the
API.

### 3.5 Point Paystack at the API

In the Paystack dashboard, in **test mode**, set **Settings → API Keys & Webhooks → Test Webhook
URL** to:

```
https://ejua-api.onrender.com/webhooks/paystack
```

Paystack signs each webhook with the secret key, so there is no separate webhook secret to set.

### 3.6 Rate limiting behind Render

The API rate-limits by client address, which it reads from `X-Forwarded-For` behind Render's load
balancer. `TRUST_PROXY=1` trusts one proxy hop. Render does not document how many hops there are,
so check once:

1. Make any request to the API from your browser.
2. Find its `request completed` line in the API's logs.
3. Look at `req.headers.x-forwarded-for`:
   - one address, your own: `1` is right;
   - two addresses, `your-ip, <another>`: set `TRUST_PROXY=2`.

Too low, and every user shares one bucket, so they lock each other out. Too high, and a client can
pick its own address, which defeats the limit on one-time-code guesses.

### 3.7 Try everything

| Check              | How                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| API up             | `https://ejua-api.onrender.com/health` returns `"status":"ok"`                                                                                  |
| Admin console      | Sign in at `ejua-admin` with the account from §2.2                                                                                              |
| Seller signup      | Sign up at `ejua-sell` or in the seller app. The code arrives by SMS. Upload a product photo: this proves R2's upload URL and CORS work         |
| Approve the seller | In the console, review KYC and open the shop                                                                                                    |
| Shop               | Browse at `ejua-shop`. The product photo loads from `STORAGE_PUBLIC_URL`                                                                        |
| Pay now            | Check out with a Paystack test card or test Mobile Money number. The order turns paid once the webhook arrives (API logs: `/webhooks/paystack`) |
| Pay in instalments | Check out on a plan. The deposit is charged and the schedule appears in the console under the customer                                          |
| Scheduled jobs     | The API logs show jobs running, such as the debit scheduler on the hour                                                                         |

### 3.8 The free instance

`render.yaml` deploys the API on Render's smallest paid instance. The free instance works for
clicking around, with three limits:

- **It sleeps after 15 minutes without traffic** and takes about a minute to wake. The mobile apps
  give up sooner than that on their first request after a quiet spell.
- **Nothing scheduled runs while it sleeps.** That stops instalment debits, retries, settlement and
  reminders.
- **It has no pre-deploy step.** Remove `preDeployCommand` from `render.yaml`, and run
  `pnpm migrate` from your machine (§2.2) before deploying a change that adds a migration.

The three static sites are free either way.

---

## 4. Mobile apps

### 4.1 Expo Go: quickest, no account needed

Point each app at the Render API. Create `apps/customer-mobile/.env` and `apps/merchant-mobile/.env`
with:

```
EXPO_PUBLIC_API_URL=https://ejua-api.onrender.com
```

Then start the app, with `-c` so the new value is picked up:

```bash
pnpm --filter @installment/customer-mobile start -c      # shopper app (Metro on 8081)
pnpm --filter @installment/merchant-mobile start -c      # seller app (Metro offers 8082)
```

Then:

1. Scan the QR code with Expo Go (Android) or the Camera app (iOS).
2. Your phone loads the app from your computer and talks to Render over HTTPS. Phone and computer
   need to be on the same network only for loading the app; with `--tunnel` they need not be.
3. Everything except push notifications works this way.

### 4.2 Installable builds and push notifications

Push notifications need an Expo project id, which `eas init` writes into `app.json`. Until then
both apps skip registering for push. On Android they also need a development or standalone build:
Expo Go no longer receives push there. Each app's README covers the details. In short, for an
Android build you can share with testers:

```bash
cd apps/customer-mobile
npx eas init                      # once: links the app to your Expo account, writes the project id
npx eas build -p android --profile preview
```

The `preview` profile, in `eas.json`, needs the API address baked in, because a standalone build has
no Metro to read it from:

```json
{
  "build": {
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "env": { "EXPO_PUBLIC_API_URL": "https://ejua-api.onrender.com" }
    }
  }
}
```

Repeat in `apps/merchant-mobile`. The API side of push is already configured: `PUSH_PROVIDER=expo`.

---

## 5. Troubleshooting

| Symptom                                                                                     | Cause and fix                                                                                                              |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `unable to verify the first certificate`, or `self-signed certificate in certificate chain` | `sslmode=require` in `DATABASE_URL`. Use `sslmode=verify-full&sslrootcert=<path to Supabase's CA>` (§1.1)                  |
| `ENOENT ... supabase-ca.crt`                                                                | `sslrootcert` points at a file that isn't there. On Render, add the secret file (§3.3). Locally, use an absolute path      |
| `Tenant or user not found`                                                                  | On the pooler the username is `postgres.<project-ref>`                                                                     |
| `ENETUNREACH`, or a timeout to `db.<ref>.supabase.co`                                       | The direct, IPv6-only host. Use the session pooler string                                                                  |
| Connections refused under load, "max clients"                                               | Too many connections for Supabase's pool of 15. Lower `DATABASE_POOL_MAX` everywhere, or raise the pool size               |
| `/health` says `"redis":"down"`                                                             | `REDIS_URL` must start `rediss://` (TLS) for Upstash, with user `default`                                                  |
| Upstash command count climbing while idle                                                   | `QUEUE_DRAIN_DELAY_SECONDS` and `QUEUE_STALLED_INTERVAL_SECONDS` aren't set, or a second API is running the workers (§2.1) |
| Web app calls `localhost:3000`                                                              | `EXPO_PUBLIC_API_URL` (`VITE_API_BASE_URL` for the admin console) wasn't set when the site was built. Set it and redeploy  |
| Browser console: CORS error calling the API                                                 | `CORS_ORIGINS` must list the site's exact origin: `https://`, no trailing slash                                            |
| Browser console: CORS error on `r2.cloudflarestorage.com`                                   | The bucket's CORS policy (§1.3) is missing that origin                                                                     |
| Upload fails with `403 SignatureDoesNotMatch`                                               | Wrong R2 keys or endpoint, or `STORAGE_REGION` isn't `auto`                                                                |
| Product photos blank                                                                        | `STORAGE_PUBLIC_URL` unset, or the bucket has no public access (§1.3)                                                      |
| One-time code never arrives                                                                 | Check the API logs for the Hubtel response. The sender ID must be one approved on your Hubtel account                      |
| First request after a quiet spell takes a minute                                            | The free instance waking up (§3.8)                                                                                         |

---

## 6. From test to production

- **Separate database and Redis.** Use a new Supabase project and Upstash database for real
  customers, never the test ones the demo seed and test payments went into.
- **Paystack live keys,** with transfers enabled.
- **A Fixed-plan Upstash database** (§1.2).
- **R2 behind a custom domain** with the `/public/` rule, and r2.dev off (§1.3).
- **`ejua.gh` registered** with a null MX, or `PAYSTACK_STANDIN_EMAIL_DOMAIN` set to a domain you
  control that has one ([runbook](../runbooks/standin-email-domain.md)).
- **Sentry** (`SENTRY_DSN`) and, if wanted, metrics (`METRICS_TOKEN`; see
  [`infra/observability`](../../infra/observability/README.md)).
- **Real admin accounts,** one per person, made with `create:admin`. Never seed the demo data.

---

## What was verified, and what was not

Verified while writing this guide, against stand-ins for the hosted services:

- **Database.** A Postgres 16 signed by a private CA, with a non-superuser owner and `pgcrypto` in an
  `extensions` schema. The `sslmode` behaviours in §1.1 were reproduced there, and all 26 migrations
  and the demo seed applied.
- **Redis.** A password-protected, TLS-only Redis reached through `rediss://`.
- **The API, built and started as Render would with `NODE_ENV=production`:**
  - healthy, with one pool of at most 5 connections;
  - refused the published JWT secrets;
  - created the first admin with `create:admin`, which could sign in;
  - issued an R2-style upload URL (path-style, region `auto`);
  - resolved image URLs to `STORAGE_PUBLIC_URL`.
- **Redis command counts.** The figures in §1.2 were measured against that Redis.
- **Web apps.** All three, served with the `/* → /index.html` rewrite, loaded in Chromium with no
  CORS errors. The admin console, built with `VITE_API_BASE_URL`, signed in against the API above.
  The shop and the seller site were later built the way Render builds them (a clean checkout, a
  frozen install, then `export:web`) and signed in against a local API; the shop also checked out.

Not verified, because it needs your accounts:

- Render itself: the Blueprint sync, corepack on Render's build image, secret files during
  pre-deploy, the proxy hop count.
- Supabase's real pooler and certificate.
- Upstash's real TLS endpoint.
- R2's CORS and public access.
- Hubtel delivery.
- Expo Go on a phone against the Render URL.
