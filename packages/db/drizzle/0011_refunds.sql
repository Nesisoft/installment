-- ============================================================================
-- 0011_refunds.sql  (Slice S7 — refunds return money)
-- ============================================================================
-- Refunding an installment flipped the schedule to `refunded`, bumped the
-- plan's outstanding balance back up, reversed the merchant accrual and (since
-- 0008) credited `refund_payable` with what we owe the customer.
--
-- No money ever left. `PaystackClient` had no refund method, nothing consumed
-- `refund_payable`, and nothing recorded that a refund was owed outside the
-- ledger. The admin console's refund button produced a complete set of books
-- describing a payment the customer never received, with no record to chase.
--
-- This table is the durable obligation, modelled on `payouts`: one row per
-- refunded installment, driven to a terminal state by the disbursement worker
-- and the reconciliation sweep.
--
-- `method` matters because not every payment can be sent back the way it came.
-- A payment recorded manually by an admin (field-agent cash, a bank transfer)
-- has no Paystack transaction to refund against, so it must be returned out of
-- band and confirmed by a human. Marking that at intent time keeps the sweep
-- from retrying something the provider can never settle.
-- ============================================================================

BEGIN;

CREATE TABLE refunds (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_plan_id            UUID NOT NULL REFERENCES customer_plans(id),
  schedule_id                 UUID NOT NULL REFERENCES installment_schedule(id),

  amount_pesewas              BIGINT NOT NULL CHECK (amount_pesewas > 0),
  -- Our own identifier. Paystack's refund API takes no client reference, so
  -- this keys the ledger discharge and our idempotency, not theirs.
  reference                   TEXT NOT NULL UNIQUE,

  method                      TEXT NOT NULL
    CHECK (method IN ('paystack', 'manual')),
  -- The original transaction being refunded. NULL for `manual`.
  provider_transaction_reference TEXT,
  -- Paystack's id for the refund itself, returned by POST /refund.
  paystack_refund_id          TEXT,

  status                      TEXT NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'pending_confirmation', 'succeeded', 'failed', 'unknown')),
  last_error                  TEXT,

  requested_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at                TIMESTAMPTZ,
  succeeded_at                TIMESTAMPTZ,
  failed_at                   TIMESTAMPTZ,

  -- One refund per installment. `refunded` is terminal in the schedule state
  -- machine, so a second refund of the same installment is always a bug.
  UNIQUE (schedule_id),

  -- A paystack refund needs something to refund against; a manual one must not
  -- claim to have one.
  CHECK (
    (method = 'paystack' AND provider_transaction_reference IS NOT NULL)
    OR (method = 'manual' AND provider_transaction_reference IS NULL)
  )
);

-- The disbursement worker's queue: not yet sent to the provider.
CREATE INDEX refunds_unsent_idx ON refunds (requested_at)
  WHERE status = 'initiated' AND method = 'paystack';

-- The reconciliation sweep's queue: sent, outcome not yet known.
CREATE INDEX refunds_inflight_idx ON refunds (submitted_at)
  WHERE status IN ('pending_confirmation', 'unknown');

CREATE INDEX refunds_plan_idx ON refunds (customer_plan_id, requested_at DESC);

-- Refunds move customer money out of the platform account, which is a distinct
-- capability from `collections:act` ("Take action on collections cases") that
-- the refund route rides on today. Seeded to `admin` only.
INSERT INTO permissions (name, description) VALUES
  ('refunds:act', 'Issue refunds and settle out-of-band refund returns')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.name = 'admin' AND p.name = 'refunds:act'
ON CONFLICT DO NOTHING;

COMMIT;
