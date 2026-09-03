#!/bin/bash
# Remove the test rows that accumulate in a local dev database, keeping the seed.
#
# Manual API testing leaves a trail: after a few weeks of it this database held
# 125 merchants, 131 logins, 45 customers and 43 plan templates, of which seven
# merchants, fourteen logins, one customer and three templates were the seeded
# demo. `pnpm db:reset && pnpm db:seed:dev` is the blunt alternative and it also
# throws away anything you have built by hand since; this keeps the demo — its
# shops, products, orders, applications and credit profiles — and drops the
# fixtures around it.
#
#   ./scripts/clean-dev-fixtures.sh          report what would go, change nothing
#   ./scripts/clean-dev-fixtures.sh --yes    actually delete it
#
# DATABASE_URL comes from the environment, or from .env if it is not set.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

COMMIT=false
case "${1:-}" in
  --yes) COMMIT=true ;;
  '') ;;
  *) echo "usage: $0 [--yes]" >&2; exit 1 ;;
esac

if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT/.env" ]; then
  DATABASE_URL=$(grep -m1 '^DATABASE_URL=' "$ROOT/.env" | cut -d= -f2-)
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set and .env does not define it" >&2
  exit 1
fi

# A destructive script in a repository is a footgun, so it refuses anywhere it
# cannot prove it is looking at a seeded development database. NODE_ENV is the
# cheap check; the seed markers below are the real one.
if [ "${NODE_ENV:-development}" = production ]; then
  echo "refusing: NODE_ENV=production" >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v "commit=$COMMIT" <<'SQL'
BEGIN;

-- ---------------------------------------------------------------------------
-- The first guard, before anything is even selected: the patterns below were
-- written against the seeded dev database. Somewhere without that seed is
-- somewhere they have never been read against, and `M <uuid>` could mean
-- anything there.
-- ---------------------------------------------------------------------------

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customers WHERE email = 'ama.shopper@demo.local')
     OR NOT EXISTS (SELECT 1 FROM users WHERE email = 'seed-admin@installment.local') THEN
    RAISE EXCEPTION 'refusing: this does not look like a seeded dev database '
                    '(no ama.shopper@demo.local / seed-admin@installment.local). '
                    'Run pnpm db:seed:dev first, or check DATABASE_URL.';
  END IF;
END $guard$;

-- ---------------------------------------------------------------------------
-- What counts as a fixture.
--
-- Everything not matched here survives, and the survivors are printed at the
-- end rather than assumed: the demo merchants with their stores and products,
-- ama.shopper@demo.local with her orders, applications and credit profiles, the
-- three real plan templates, Ghana Revenue Authority, the *@installment.local
-- system actors, seed-admin and the demo logins.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE t_customers AS
  SELECT id FROM customers
   WHERE email ~ '@x\.gh$' OR email LIKE '%@example.com';

CREATE TEMP TABLE t_merchants AS
  SELECT id FROM merchants
   WHERE business_name ~ '^M [0-9a-f]{8}-'
      OR business_name IN ('Payout Test Shop', 'No Payout Shop', 'Scoring Shop');

CREATE TEMP TABLE t_users AS
  SELECT id FROM users
   WHERE email ~ '^(staff|owner|agent|nolink)\+[0-9a-f]{8}-'
      -- Named individually rather than by a @fixture.local pattern, which also
      -- matches ama.customer@fixture.local — the demo shopper's login.
      -- customers.user_id is SET NULL, so deleting it would not fail; it would
      -- quietly leave the demo customer, her orders and her credit profiles
      -- with no way to sign in.
      OR email IN (
        'claude.review@fixture.local',
        'payout.owner@fixture.local',
        'nopayout.owner@fixture.local'
      );

CREATE TEMP TABLE t_templates AS
  SELECT id FROM plan_templates
   WHERE name LIKE 'BNPL-scope %'
      OR name LIKE 'Weekly 4 %'
      OR name ~ '^Pay in 4 [0-9a-f]{8}$';

CREATE TEMP TABLE t_employers AS
  SELECT id FROM employers WHERE name LIKE 'Ghana Water e2e%';

CREATE TEMP TABLE t_plans AS
  SELECT id FROM customer_plans WHERE customer_id IN (SELECT id FROM t_customers);

CREATE TEMP TABLE t_apps AS
  SELECT id FROM applications
   WHERE customer_id IN (SELECT id FROM t_customers)
      OR merchant_id IN (SELECT id FROM t_merchants)
      OR plan_template_id IN (SELECT id FROM t_templates);

-- ---------------------------------------------------------------------------
-- The second guard. Like the first, it rolls the whole transaction back.
-- ---------------------------------------------------------------------------

-- Nothing surviving may be left pointing at a row that is about to go.
-- orders.application_id and orders.customer_plan_id are both SET NULL, so this
-- would silently blank a link on demo data rather than failing.
DO $guard$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM orders
   WHERE application_id IN (SELECT id FROM t_apps)
      OR customer_plan_id IN (SELECT id FROM t_plans);
  IF n > 0 THEN
    RAISE EXCEPTION 'refusing: % surviving order(s) reference a row being deleted', n;
  END IF;
END $guard$;

\echo ''
\echo 'Deleting:'
SELECT 'merchants' AS entity, count(*) AS rows FROM t_merchants
UNION ALL SELECT 'users', count(*) FROM t_users
UNION ALL SELECT 'customers', count(*) FROM t_customers
UNION ALL SELECT 'applications', count(*) FROM t_apps
UNION ALL SELECT 'customer_plans', count(*) FROM t_plans
UNION ALL SELECT 'plan_templates', count(*) FROM t_templates
UNION ALL SELECT 'employers', count(*) FROM t_employers
ORDER BY 1;

-- ---------------------------------------------------------------------------
-- Children first: installment_schedule is RESTRICT, the rest NO ACTION. The
-- CASCADE relationships are noted where they do the work for us.
-- ---------------------------------------------------------------------------

DELETE FROM collections_actions WHERE case_id IN
  (SELECT id FROM collections_cases WHERE customer_plan_id IN (SELECT id FROM t_plans));
DELETE FROM collections_cases WHERE customer_plan_id IN (SELECT id FROM t_plans);
DELETE FROM installment_schedule WHERE customer_plan_id IN (SELECT id FROM t_plans);
DELETE FROM payment_attempts WHERE customer_plan_id IN (SELECT id FROM t_plans);
DELETE FROM refunds WHERE customer_plan_id IN (SELECT id FROM t_plans);
DELETE FROM held_reserves
 WHERE customer_plan_id IN (SELECT id FROM t_plans)
    OR merchant_id IN (SELECT id FROM t_merchants);
DELETE FROM customer_plans WHERE id IN (SELECT id FROM t_plans);

DELETE FROM credit_profiles
 WHERE customer_id IN (SELECT id FROM t_customers)
    OR application_id IN (SELECT id FROM t_apps);
DELETE FROM applications WHERE id IN (SELECT id FROM t_apps);

-- customer_employment cascades from customers, but its employer FK does not.
DELETE FROM customer_employment
 WHERE customer_id IN (SELECT id FROM t_customers)
    OR employer_id IN (SELECT id FROM t_employers);
DELETE FROM employers WHERE id IN (SELECT id FROM t_employers);

-- Cascades addresses, carts, card authorisations, credit standing, reviews,
-- push devices and wishlist items.
DELETE FROM customers WHERE id IN (SELECT id FROM t_customers);

DELETE FROM payouts WHERE merchant_id IN (SELECT id FROM t_merchants);
-- Cascades stores and products. Fixture merchants have neither today, but a
-- future one might, and the cascade is the reason this is safe either way.
DELETE FROM merchants WHERE id IN (SELECT id FROM t_merchants);

-- Cascades user_roles, and sets customers.user_id null on any survivor — which
-- is what the t_users comment above is protecting against.
DELETE FROM users WHERE id IN (SELECT id FROM t_users);

DELETE FROM product_plan_offers WHERE plan_template_id IN (SELECT id FROM t_templates);
DELETE FROM plan_templates WHERE id IN (SELECT id FROM t_templates);

-- audit_events is deliberately untouched: an `audit_events_immutable` trigger
-- blocks UPDATE and DELETE on it, so the log keeps its record of these rows
-- having existed. That is the point of an append-only log, and defeating the
-- trigger to tidy a dev database would be the wrong trade. Expect audit rows
-- whose entity_id no longer resolves.

-- ledger_entries is untouched for a different reason: the entries here belong
-- to the demo merchants, and a ledger is not a fixture. Balances survive.

-- Transient by design — a 24-hour TTL cache of API responses, and no dev
-- database has traffic worth replaying.
DELETE FROM idempotency_keys;

-- ---------------------------------------------------------------------------
-- What is left. Printed rather than asserted, because the point is to be able
-- to read it and disagree before the COMMIT below.
-- ---------------------------------------------------------------------------

\echo ''
\echo 'Keeping:'
SELECT 'merchants' AS entity, string_agg(business_name, ', ' ORDER BY business_name) AS rows
  FROM merchants
UNION ALL SELECT 'customers', string_agg(email, ', ' ORDER BY email) FROM customers
UNION ALL SELECT 'plan_templates', string_agg(name, ', ' ORDER BY name) FROM plan_templates
UNION ALL SELECT 'employers', string_agg(name, ', ' ORDER BY name) FROM employers
UNION ALL SELECT 'logins', string_agg(email, ', ' ORDER BY email) FROM users
ORDER BY 1;

\if :commit
  COMMIT;
  \echo ''
  \echo 'Committed.'
\else
  ROLLBACK;
  \echo ''
  \echo 'Dry run — nothing changed. Re-run with --yes to apply.'
\endif
SQL
