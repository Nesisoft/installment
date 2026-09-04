-- ============================================================================
-- 0020_order_returns.sql  (Sending something back, and getting the money)
-- ============================================================================
-- `orders.status` has permitted 'returned' since 0006 and the transition table
-- allows `paid -> returned`, `shipped -> returned` and `delivered -> returned`.
-- Nothing has ever written it. There is no route a buyer can use, no queue a
-- seller reviews, and — the part that makes this more than a status column —
-- **no way to refund an outright purchase at all**:
--
--   `refunds.customer_plan_id` and `refunds.schedule_id` are both NOT NULL, so
--   every row in that table is a refund of one instalment on one credit plan.
--   A pay-in-full order has neither. The refund engine, the disbursement sweep
--   and the reconciliation path are all real and all unreachable for the
--   majority of orders.
--
-- So this migration does two things: gives a return a durable record with a
-- decision on it, and lets `refunds` belong to a return as an alternative to a
-- schedule — the same two-nullable-owners-plus-CHECK shape 0017 used for
-- `push_devices`.
--
-- Scope: a whole order at a time. `order_items` has no status column, so an
-- item-level return would leave `orders.status = 'returned'` while one shirt of
-- three went back — the order would be lying about itself. Per-item returns
-- need per-item state first, and that is its own slice.
--
-- Conventions carried forward unchanged: uuid PKs via gen_random_uuid(); TEXT +
-- CHECK instead of enums; timestamptz; updated_at maintained by the shared
-- set_updated_at() trigger from 0000.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. The return itself
-- ============================================================================
CREATE TABLE order_returns (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  -- Denormalised from the order so the customer's own list is one index away,
  -- and so a return survives being read without its order.
  customer_id          UUID NOT NULL REFERENCES customers (id) ON DELETE CASCADE,

  status               TEXT NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  -- The buyer's words. Required: a return with no reason is not reviewable, and
  -- the reason is what the seller decides on.
  reason               TEXT NOT NULL CHECK (length(btrim(reason)) > 0),

  -- What the buyer gets back if this is approved, fixed at request time from
  -- the order total. Stored rather than recomputed because the order's own
  -- total is not immutable and a decision has to be about a known amount.
  refund_amount_pesewas BIGINT NOT NULL CHECK (refund_amount_pesewas > 0),

  requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by           UUID REFERENCES users (id) ON DELETE SET NULL,
  decided_at           TIMESTAMPTZ,
  -- Why it was refused, in the reviewer's words. The buyer is shown this, for
  -- the same reason a rejected Ghana Card carries one: "no" with no reason is
  -- not something anybody can act on.
  decision_note        TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A decision is a timestamp and an outcome together, or neither. Half a
  -- decision is the shape that lets a queue show an item as both waiting and
  -- resolved, the same trap `merchant_kyc_reviewed_together` closes in 0016.
  CONSTRAINT order_returns_decided_together CHECK (
    (status IN ('requested', 'cancelled')) = (decided_at IS NULL)
  ),
  -- A refusal has to say why. An approval does not need to.
  CONSTRAINT order_returns_rejection_needs_note CHECK (
    status <> 'rejected' OR (decision_note IS NOT NULL AND length(btrim(decision_note)) > 0)
  )
);

CREATE TRIGGER order_returns_set_updated_at
  BEFORE UPDATE ON order_returns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One open return per order. A buyer who asks twice while nobody has looked is
-- asking once; a rejected return can be re-requested, which is why the index is
-- partial rather than a plain UNIQUE on order_id.
CREATE UNIQUE INDEX order_returns_one_open_idx
  ON order_returns (order_id)
  WHERE status = 'requested';

CREATE INDEX order_returns_customer_idx ON order_returns (customer_id, requested_at DESC);
CREATE INDEX order_returns_queue_idx ON order_returns (requested_at) WHERE status = 'requested';

COMMENT ON TABLE order_returns IS
  'A buyer asking to send a whole order back, and the decision on it. Approval raises an order-scoped row in `refunds`.';

-- ============================================================================
-- 2. A refund can belong to a return instead of a schedule
-- ============================================================================
-- Two nullable owners and a CHECK, rather than a polymorphic pair, so both
-- foreign keys survive — the same reasoning as `push_devices_one_owner`.
ALTER TABLE refunds
  ALTER COLUMN customer_plan_id DROP NOT NULL,
  ALTER COLUMN schedule_id DROP NOT NULL;

ALTER TABLE refunds
  ADD COLUMN order_return_id UUID REFERENCES order_returns (id) ON DELETE RESTRICT;

-- Exactly one owner. A refund of an instalment names the plan and the schedule
-- together — they were never independent — and a refund of a return names the
-- return.
ALTER TABLE refunds
  ADD CONSTRAINT refunds_one_owner CHECK (
    (customer_plan_id IS NOT NULL AND schedule_id IS NOT NULL AND order_return_id IS NULL)
    OR (customer_plan_id IS NULL AND schedule_id IS NULL AND order_return_id IS NOT NULL)
  );

-- One refund per return, the same way `refunds_schedule_id_key` gives one per
-- instalment. Postgres allows many NULLs in a unique index, so the instalment
-- rows are unaffected.
CREATE UNIQUE INDEX refunds_order_return_id_key ON refunds (order_return_id);

COMMIT;
