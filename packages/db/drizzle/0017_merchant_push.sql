-- ============================================================================
-- 0017_merchant_push.sql  (Push notifications: merchants, and a transport)
-- ============================================================================
-- `push_devices` arrived in 0015 with its own docstring admitting the gap:
-- "Registration only — NotificationService is still SMS-only, and adding a push
-- transport is its own slice." That slice was never built, so the table has
-- been write-only ever since: the customer app posts a token to /me/devices,
-- `DevicesService.listActive` has no callers anywhere in the repo, and
-- `NotificationService` hardcodes `channel: 'sms'`. The `notifications.channel`
-- CHECK has permitted 'push' since 0000, waiting for it.
--
-- This migration does the schema half of two things: a device can belong to a
-- merchant as well as a customer, and the merchant's phone is therefore
-- reachable at all.
--
-- Conventions carried forward unchanged: uuid PKs via gen_random_uuid(); TEXT +
-- CHECK instead of enums; timestamptz; updated_at maintained by the shared
-- set_updated_at() trigger from 0000.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. A device belongs to a customer OR a merchant
-- ============================================================================

-- Two nullable owners with a CHECK rather than a polymorphic
-- (owner_type, owner_id) pair, because the pair would cost both foreign keys.
-- These rows are live state, not a log: when a customer is deleted their
-- handsets should go with them, and `notifications` can afford an unconstrained
-- recipient_id precisely because it is a record of something that already
-- happened.
ALTER TABLE push_devices
  ALTER COLUMN customer_id DROP NOT NULL;

ALTER TABLE push_devices
  ADD COLUMN merchant_id UUID REFERENCES merchants (id) ON DELETE CASCADE;

-- Exactly one. A device with neither owner could never be sent to and a device
-- with both would be sent to twice, so the row refuses to hold either.
ALTER TABLE push_devices
  ADD CONSTRAINT push_devices_one_owner CHECK (
    (customer_id IS NOT NULL AND merchant_id IS NULL)
    OR (customer_id IS NULL AND merchant_id IS NOT NULL)
  );

-- The send-side lookup, mirroring push_devices_customer_idx from 0015.
CREATE INDEX push_devices_merchant_idx
  ON push_devices (merchant_id) WHERE is_active;

-- `expo_token` stays globally UNIQUE, and that is deliberate rather than
-- incidental: Expo reissues the same token to whoever holds a handset, so one
-- token is one phone. A shopkeeper who signs into the merchant app on the
-- phone they used to shop with moves the token to their merchant account, and
-- the customer registration that was there is replaced rather than duplicated.
-- Without the global constraint the same handset would end up on both lists
-- and receive somebody else's notifications.

COMMENT ON COLUMN push_devices.merchant_id IS
  'Set for a merchant handset; mutually exclusive with customer_id.';

COMMIT;
