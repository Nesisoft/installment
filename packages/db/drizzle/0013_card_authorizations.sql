-- ============================================================================
-- 0013_card_authorizations.sql  (unattended collection on a saved card)
-- ============================================================================
-- `PaymentService.chargeCard` — the one mechanism that debits a customer
-- without them approving anything — was implemented and unreachable. Nothing
-- ever stored an authorization code: there was no column for one, no capture
-- after a successful card charge, and `POST /me/installments/:id/pay` required
-- the caller to supply one that no frontend ever sent. `debit-runner` did not
-- even try a card; it called Mobile Money and skipped with
-- `no_momo_instrument` when there was no saved number.
--
-- So every instalment depended on a customer noticing and approving a Mobile
-- Money prompt. This table is what makes the card path usable.
--
-- A table rather than columns on `customers`, because a card authorization is
-- not a static attribute: cards expire, get replaced, and get permanently
-- declined. Recording that an authorization is dead is more useful than
-- nulling a column, and a customer replacing a card should not destroy the
-- history of the one before it.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_card_authorizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,

  -- What we actually charge against.
  authorization_code text NOT NULL,
  -- Paystack's fingerprint for the underlying card. The same card tokenised
  -- again returns the same signature, which is how a re-save is recognised as
  -- the card already on file rather than a second one.
  signature          text,

  -- Enough to show the customer which card this is, and nothing more. No PAN,
  -- no CVV: the authorization code IS the credential, and last4/brand exist
  -- only so a person can tell one saved card from another.
  last4              text,
  brand              text,
  card_type          text,
  bank               text,
  exp_month          smallint,
  exp_year           smallint,

  -- Paystack marks some authorizations single-use. Charging one of those just
  -- fails, so the column is stored and the collector filters on it rather than
  -- discovering it a debit at a time.
  reusable           boolean NOT NULL DEFAULT false,

  -- `revoked` once a charge proves the authorization is dead, so the collector
  -- stops retrying an instrument that can never work again.
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'revoked')),

  last_used_at       timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One row per authorization code: re-saving the same card updates it rather
-- than accumulating duplicates that the collector would have to choose between.
CREATE UNIQUE INDEX IF NOT EXISTS customer_card_authorizations_code_key
  ON customer_card_authorizations (authorization_code);

-- The collector's lookup: the usable cards for one customer, newest first.
CREATE INDEX IF NOT EXISTS customer_card_authorizations_usable_idx
  ON customer_card_authorizations (customer_id, created_at DESC)
  WHERE status = 'active' AND reusable;

COMMENT ON TABLE customer_card_authorizations IS
  'Reusable Paystack card authorizations, so instalments can be collected without the customer approving each one.';
