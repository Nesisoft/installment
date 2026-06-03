-- ============================================================================
-- 0004_customer_user_link.sql
-- ============================================================================
-- Links the auth identity (users) to the customer domain record (customers)
-- with an explicit, immutable foreign key, replacing the implicit "match by
-- phone" coupling. customers.user_id is nullable (a customer can be registered
-- by a merchant before they ever have a login) and unique (one login per
-- customer). The one-time backfill binds existing rows by phone; from here on
-- the link is set when a customer login is created and never derived from the
-- (mutable, recyclable) phone again.
-- ============================================================================

BEGIN;

ALTER TABLE customers ADD COLUMN user_id uuid;

ALTER TABLE customers ADD CONSTRAINT customers_user_id_key UNIQUE (user_id);

ALTER TABLE customers
  ADD CONSTRAINT customers_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES users (id) ON DELETE SET NULL;

-- One-time bootstrap: bind each existing customer to its customer-type login by
-- phone. After this, the link is authoritative and phone is never used again.
UPDATE customers c
SET user_id = u.id
FROM users u
WHERE u.phone = c.phone
  AND u.user_type = 'customer'
  AND u.deleted_at IS NULL
  AND c.user_id IS NULL;

COMMIT;
