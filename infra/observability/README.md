# Observability

Sentry tells you when something went wrong once. This directory is for the other questions: how
many are waiting, is it getting worse, did last night's job run at all. It has four parts:

| Part      | Where                                     | Answers                                                  |
| --------- | ----------------------------------------- | -------------------------------------------------------- |
| Metrics   | `GET /metrics` on the API                 | Backlogs, scheduled jobs, ledger health, HTTP traffic    |
| Alerts    | `prometheus/alerts.yml`                   | When a number needs a person, with a link to the runbook |
| Dashboard | `grafana/dashboards/installment-ops.json` | The same numbers over time, in one page                  |
| Logs      | The API's stdout                          | What happened to one request or one job run              |

`docker-compose.yml` runs Prometheus and Grafana against an API on the host. It is a starting point
and a way to look at the dashboard locally; it is not exercised in CI.

## Metrics

### Turning the endpoint on

`/metrics` is off unless `METRICS_TOKEN` is set (24+ characters). With no token it answers 404, so
an API deployed without one exposes nothing. With one, a scrape must send it as a bearer token:

```bash
openssl rand -hex 32                     # put this in the API's environment as METRICS_TOKEN
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics
```

A wrong token gets 401. The endpoint skips the rate limiter and is left out of the OpenAPI document.

### What it publishes

**Scheduled jobs**, recorded by every cron in `apps/api/src/workers`:

| Metric                                                | Meaning                                             |
| ----------------------------------------------------- | --------------------------------------------------- |
| `installment_job_runs_total{job,outcome}`             | Runs, `outcome` = `success` or `failure` (it threw) |
| `installment_job_last_run_timestamp_seconds{job}`     | When it last ran, either way                        |
| `installment_job_last_success_timestamp_seconds{job}` | When it last ran without throwing                   |

A run that finds problems — a payout refused, a refund unresolved — is a `success` here. Those
problems have their own gauges below. These series exist only once a job has run in this process,
so a fresh deploy shows nothing until each job's first run.

With `ENABLE_SCHEDULED_WORKERS=false` (a web-only replica) the jobs return before doing anything and
record nothing, so scrape the replica that runs the workers for these series. The exceptions are
`late-fee-accrual` and `return-window-close`, which don't check that flag today and run, and record,
on every replica.

**Ledger**, set by the hourly integrity check:

| Metric                                       | Meaning                                        |
| -------------------------------------------- | ---------------------------------------------- |
| `installment_ledger_healthy`                 | 1 when the last check passed, 0 when it failed |
| `installment_ledger_unbalanced_transactions` | Transactions whose legs don't sum to zero      |

Both are absent until the process has run the check once. A restart, or a replica that doesn't run
the jobs, publishes no ledger sample rather than a 0 that would read as "unbalanced".

**Operational backlog**, read from the database at scrape time (cached 15 seconds):

| Metric                                             | Meaning                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `installment_ops_metrics_up`                       | 1 when the gauges below were read, 0 when reading failed         |
| `installment_schedules_open{status}`               | Instalments still to collect: due, processing, retry, overdue…   |
| `installment_schedules_stuck_processing`           | In `processing` over 90 minutes: a charge with no outcome        |
| `installment_payouts_in_flight{status}`            | Payouts with no answer: initiated, pending_confirmation, unknown |
| `installment_payouts_latest_day{status}`           | The most recent settlement day's payouts, by status              |
| `installment_payouts_latest_day_timestamp_seconds` | That day's date (midnight UTC)                                   |
| `installment_refunds{queue}`, `…_pesewas{queue}`   | Refunds by console queue, count and amount                       |
| `installment_collections_cases_open{stage}`        | Open collections cases by dunning stage                          |
| `installment_sellers_owing`, `…_pesewas`           | Sellers whose payable balance is negative, and the total         |
| `installment_telco_success_ratio{telco}`           | Mobile Money success rate per network, over the health window    |
| `installment_telco_status{telco}`                  | 0 healthy, 1 degraded, 2 down, -1 unknown                        |

If the database read fails, `installment_ops_metrics_up` drops to 0 and the backlog gauges keep
their last values. A failed read never shows up as zero work.

Amounts are pesewas, like everywhere else. Divide by 100 for cedis.

**HTTP and process**:

- `http_request_duration_seconds{method,route,status}` is labelled by route _pattern_
  (`/admin/refunds/:id`), never the raw path, so IDs don't multiply series. A request that matched
  no route is `unmatched`.
- It counts requests that a guard refused (401, 403, 429) as well as handled ones. It misses a body
  the JSON parser rejects (malformed JSON, 400), because that fails before any middleware runs.
- Node's defaults: event-loop lag, heap, GC, CPU, `process_resident_memory_bytes`.

### Each replica has its own numbers

The counters and job timestamps live in the process that ran the job. Run more than one API
replica and you must scrape each one, or the job series will come from whichever replica answered.
The backlog gauges read the shared database, so every replica reports the same values for those.

## Alerts

`prometheus/alerts.yml` has three groups:

- **`installment-api`**
  - the API is down;
  - the ops gauges are unreadable;
  - 5xx rate above 5%;
  - p95 above 2 seconds.
- **`installment-jobs`**
  - a job threw;
  - a job hasn't succeeded within its expected interval. Every-few-minutes jobs get 20 minutes,
    the payout reconciler 90, hourly jobs 3 hours, daily jobs 26 hours.
- **`installment-money`**
  - ledger unbalanced;
  - instalments stuck in processing;
  - payouts unknown;
  - failures on the latest settlement day;
  - refunds waiting on a person;
  - sellers owing over GHS 5,000;
  - a Mobile Money network down.

Each money alert carries a `runbook` annotation pointing at the page in `docs/runbooks/` that says
what to do. The exception is sellers owing, which has no runbook yet; its alert points at the
console's Merchants page instead. The staleness thresholds are deliberately loose. They catch a job that has stopped, not one
that ran a few minutes late.

Routing (Slack, email, PagerDuty) belongs to Alertmanager, which this directory doesn't configure.
Point Prometheus's `alerting` block at yours.

Check the rules before loading them:

```bash
promtool check rules infra/observability/prometheus/alerts.yml
```

## Dashboard

`grafana/dashboards/installment-ops.json`, titled "Installment — operations", has these rows:

1. **Needs a person now**: ledger health, stuck instalments, unknown payouts, refunds needing a
   person, sellers owing, gauge health.
2. **Scheduled jobs**: seconds since each job's last success, and runs that threw.
3. **Collection**: open instalments, collections cases by stage, Mobile Money health.
4. **Money out**: payouts without an answer, the latest settlement day, refunds, seller debt.
5. **API**: request rate by status, p95 by route, event-loop lag, memory.

It takes a Prometheus data source as an input. Import it through Grafana's UI and pick yours.
Under the compose file it is provisioned automatically.

## Running it locally

```bash
# 1. Give the API a token and start it (it listens on :3000)
echo "METRICS_TOKEN=$(openssl rand -hex 32)" >> .env
pnpm --filter @installment/api dev

# 2. Give Prometheus the same token
grep ^METRICS_TOKEN= .env | cut -d= -f2- | tr -d '\n' > infra/observability/prometheus/metrics_token

# 3. Start Prometheus (:9090) and Grafana (:3001, admin / admin on first login)
docker compose -f infra/observability/docker-compose.yml up -d
```

`prometheus/metrics_token` is git-ignored. Prometheus reaches the host's API as
`host.docker.internal:3000`; on a server, change the target in `prometheus/prometheus.yml`.

## Logs

The API logs through `nestjs-pino`:

- **In production** (`NODE_ENV=production`), one JSON object per line on stdout. Every HTTP request
  logs method, URL, status, response time and a request id.
- **In development**, the same events, pretty-printed.
- **Level:** `LOG_LEVEL` sets it (default `info`).
- **Redacted:** `authorization` and `cookie` request headers are replaced before the line is
  written. Nothing else is, so don't log request bodies at `debug` in production.

Ship stdout. Don't write files from the app. Any of these works without code changes:

- **A platform log drain.** Render, Fly, Railway, Heroku and ECS all collect stdout and can forward
  it to Better Stack, Datadog, Axiom, or similar. This is the least work.
- **Loki with Promtail or Grafana Alloy**, if you run the Grafana above. Scrape the container's
  stdout, parse it with a `json` stage, and promote `level`, `req.method` and `res.statusCode` to
  labels. Keep `req.url` and the request id as fields, not labels: they are unbounded. Add Loki as
  a second Grafana data source.
- **`docker logs` / `journalctl`** on a single VM, which is enough until it isn't.

Each request's log line carries a `req.id`. Sentry events don't carry it, so match a Sentry event to
its log lines by time and route.

A failed scheduled job reaches Sentry with a `worker` tag. For most jobs the tag matches the `job`
label on the metrics. Six use an older, shorter name:

| `job` label             | Sentry `worker` tag |
| ----------------------- | ------------------- |
| `collections-sweep`     | `collections`       |
| `daily-settlement`      | `settlement`        |
| `payout-reconciliation` | `reconciliation`    |
| `pre-debit-reminders`   | `reminder`          |
| `refund-disbursement`   | `refunds`           |
| `reserve-release-sweep` | `reserve-release`   |

What to keep: 30 days of `info` is enough to answer most "what happened to this payment"
questions. Money questions past that go to the ledger, which is permanent, not to the logs.
