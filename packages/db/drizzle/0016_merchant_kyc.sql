-- ============================================================================
-- 0016_merchant_kyc.sql  (Merchant KYC documents)
-- ============================================================================
-- Merchants have sat in `pending_kyc` since 0000 with nothing able to move them
-- out of it except an admin pressing Activate. There was no document to look
-- at: the Ghana Card columns live on `customers`, and the `kyc_document` upload
-- purpose is owned by a customer, so a merchant had no way to send evidence and
-- a reviewer had no way to ask for it. Since merchants could sign themselves up
-- (#62) that gap is the whole of onboarding.
--
-- Conventions carried forward unchanged: uuid PKs via gen_random_uuid(); TEXT +
-- CHECK instead of enums; timestamptz; updated_at maintained by the shared
-- set_updated_at() trigger from 0000.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. The documents
-- ============================================================================

-- Rejected rows are kept, not overwritten: the reviewer who refused a card, the
-- reason they gave, and what the merchant sent instead are all part of the same
-- trail. A merchant correcting a submission before anyone has looked at it
-- updates that row in place; once a document is APPROVED the merchant cannot
-- replace it, which is what stops a real card being swapped for something else
-- after it has earned an activation. The partial unique index below is what
-- makes "the current one" unambiguous.
CREATE TABLE merchant_kyc_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  -- ghana_card_front / _back identify the person who owns the business; the
  -- shop photo is what tells a reviewer the business is real and trading.
  -- business_registration is optional evidence for a registered entity.
  doc_type      TEXT NOT NULL CHECK (doc_type IN (
                  'ghana_card_front',
                  'ghana_card_back',
                  'shop_photo',
                  'business_registration'
                )),
  -- Object-storage key under private/merchant-kyc/<merchant_id>/. Derived
  -- server-side by deriveUploadKey and checked against the caller's own prefix
  -- before it is stored, the same rule product images follow.
  storage_key   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted', 'approved', 'rejected')),
  -- Who decided, and why they said no. `reviewed_by` is a users.id and is left
  -- SET NULL if that staff account is ever removed: the decision happened, and
  -- the audit row keeps the actor even when the login is gone.
  reviewed_by   UUID REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A decision is a status, a reviewer, a time and — when it is a refusal — a
  -- reason. Half a decision is not reviewable, so the row refuses to hold one.
  CONSTRAINT merchant_kyc_reviewed_together CHECK (
    (status = 'submitted' AND reviewed_at IS NULL AND rejection_reason IS NULL)
    OR (status = 'approved' AND reviewed_at IS NOT NULL AND rejection_reason IS NULL)
    OR (status = 'rejected' AND reviewed_at IS NOT NULL AND rejection_reason IS NOT NULL)
  )
);

-- Only one live submission per type, which is what the two rules above rest on:
-- a merchant re-sending a rejected card gets a new row beside the rejected one,
-- and a reviewer's queue never shows two cards of the same type and has to
-- guess which is current.
CREATE UNIQUE INDEX merchant_kyc_current_idx
  ON merchant_kyc_documents (merchant_id, doc_type)
  WHERE status <> 'rejected';

CREATE INDEX merchant_kyc_merchant_idx
  ON merchant_kyc_documents (merchant_id, created_at DESC);

-- The reviewer's queue: every merchant with something waiting, oldest first.
CREATE INDEX merchant_kyc_pending_idx
  ON merchant_kyc_documents (created_at)
  WHERE status = 'submitted';

CREATE TRIGGER merchant_kyc_documents_updated_at BEFORE UPDATE ON merchant_kyc_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 2. The merchants already trading
-- ============================================================================

-- Activation is about to require approved documents, and there are merchants
-- already `active` — the demo seed among them — who have none. Backfilling an
-- approved row per requirement would be a lie in the audit trail: nobody looked
-- at anything. Instead the gate exempts a merchant who is already past
-- `pending_kyc`, which is recorded here rather than inferred, so it can be
-- audited later and so a re-verification campaign has a list to work from.
ALTER TABLE merchants
  ADD COLUMN kyc_exempt_before TIMESTAMPTZ;

COMMENT ON COLUMN merchants.kyc_exempt_before IS
  'Set for merchants activated before document review existed (0016). Their '
  'activation was not evidenced; the gate lets them keep trading and a '
  're-verification campaign can select on this column.';

UPDATE merchants
   SET kyc_exempt_before = NOW()
 WHERE status <> 'pending_kyc'
   AND deleted_at IS NULL;

COMMIT;
