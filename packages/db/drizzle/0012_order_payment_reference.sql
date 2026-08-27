-- ============================================================================
-- 0012_order_payment_reference.sql  (customer-initiated payment for orders)
-- ============================================================================
-- A pay-in-full order could only be settled by an operator reconciling the
-- money by hand: `POST /admin/orders/:id/confirm-payment`. Customers had no way
-- to pay online at all, because nothing tied a payment-provider reference to an
-- order, so a `charge.success` webhook had nothing to resolve against.
--
-- The obvious home was `payment_attempts`, but that table is shaped for
-- installment schedules: `schedule_id` and `customer_plan_id` are NOT NULL, and
-- seven modules read it assuming a schedule — including the credit-scoring
-- behaviour collector, where an order payment would pollute a customer's credit
-- signals with ordinary shopping. Loosening it would put every one of those on
-- the money path for a change none of them asked for.
--
-- So the reference lives on the order instead. `orders` is owned by
-- @installment/commerce alone, the column is only ever read by the webhook
-- resolving a charge, and nothing about installment charging changes.
--
-- Trade-off worth recording: orders get no attempt history, retry scheduling or
-- verify-polling. That machinery exists for recurring debits against a schedule
-- that must eventually collect; a one-off checkout payment either clears or the
-- customer tries again. If orders later need it, this column is what a fuller
-- `order_payment_attempts` table would be built around.
-- ----------------------------------------------------------------------------

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference text;

-- Partial unique: one order per provider reference, but the column stays NULL
-- for the many orders that are never paid online (instalments, cash on
-- delivery, bank transfer), and NULLs must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_reference_key
  ON orders (payment_reference)
  WHERE payment_reference IS NOT NULL;

COMMENT ON COLUMN orders.payment_reference IS
  'Payment-provider reference for a customer-initiated charge on this order. Set when the charge is initiated; the webhook resolves charge.success back to the order through it.';
