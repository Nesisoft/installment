-- ============================================================================
-- 0014_card_removal.sql  (a customer can take their card off file)
-- ============================================================================
-- 0013 stored card authorizations and 0037's flow started filling them, but a
-- customer had no way to see what was on file or take it off. Storing someone's
-- payment credential and giving them no way to remove it is not a gap to fix
-- after launch.
--
-- Two changes are needed for removal to actually mean removal.
--
-- `authorization_code` becomes nullable, so removing a card can DROP the
-- credential while keeping the row. What is left — last4, brand, when it was
-- added and when it went — is the record a person needs to recognise what they
-- removed. What we stop holding is the part that can charge them.
--
-- `removed` joins the status set, and it is deliberately distinct from
-- `revoked`. CardAuthorizationService.record() brings a *revoked* card back
-- when the provider proves it working again, which is right for a card the
-- provider declined and the customer then fixed. Applying that to a card the
-- customer deleted would resurrect it behind their back — so removal needs a
-- state that reactivation can never touch.
-- ----------------------------------------------------------------------------

ALTER TABLE customer_card_authorizations
  ALTER COLUMN authorization_code DROP NOT NULL;

ALTER TABLE customer_card_authorizations
  DROP CONSTRAINT IF EXISTS customer_card_authorizations_status_check;

ALTER TABLE customer_card_authorizations
  ADD CONSTRAINT customer_card_authorizations_status_check
  CHECK (status IN ('active', 'revoked', 'removed'));

COMMENT ON COLUMN customer_card_authorizations.authorization_code IS
  'The chargeable credential. NULL once the customer has removed the card — the row survives as a record of what was removed, the credential does not.';

COMMENT ON COLUMN customer_card_authorizations.status IS
  'active = chargeable. revoked = the provider refused it; may return if it works again. removed = the customer took it off file; never reactivated.';
