-- ============================================================================
-- 0008_ledger_cash_in.sql  (Slice S5 — the ledger records cash)
-- ============================================================================
-- Two changes, both prerequisites for booking the customer's inbound payment.
--
-- 1) A new account type: customer_float.
--
--    The merchant accrual (DEBIT receivable / CREDIT merchant_payable + revenue
--    + reserve_held) does not fire at the same time for every business model:
--
--      bnpl, rent_to_own : 100% at activation, BEFORE any cash arrives
--      layaway           : 100% at completion, AFTER all cash has arrived
--      hybrid            : 40% at the down payment, 60% at completion
--
--    So a collection cannot simply credit `receivable`. For layaway there is
--    nothing debited yet to retire, and crediting anyway would leave that
--    account — a debit-normal asset — carrying a credit balance, asserting the
--    platform owes money it does not owe. Worse, balances are summed per
--    account_type across every plan, so one layaway plan's positive balance
--    would net against a BNPL plan's negative one and understate real
--    portfolio exposure.
--
--    customer_float holds cash we have collected but not yet attributed to a
--    merchant obligation. It is credit-normal (a liability: we are holding the
--    customer's money). Cash is applied in a waterfall — retire receivable
--    first, float the remainder — and swept back into receivable as each
--    accrual fires. For bnpl and rent_to_own the float is therefore provably
--    zero at every commit boundary; for layaway it correctly carries the
--    collected balance until completion.
--
-- 2) Uniqueness on a logical ledger posting.
--
--    ledger_transaction_idx (0000:525) is a plain index. Every dedupe in the
--    ledger is a check-then-insert — PayoutRecorder, DefaultService,
--    ReserveReleaseService, SettlementService.reverseAndFail — which is a
--    TOCTOU window under READ COMMITTED: two concurrent workers can both find
--    nothing and both post. A double posting is 2 debits + 2 credits, so it
--    still balances, and the debits==credits check cannot detect it.
--
--    The constraint is NOT on transaction_id alone: one logical transaction is
--    several rows sharing that id. It is on the full identity of a posting —
--    (transaction_id, account_type, account_ref, direction) — which is unique
--    within a well-formed transaction while still permitting the multi-row
--    shape every write site uses.
-- ============================================================================

BEGIN;

-- 1) customer_float ----------------------------------------------------------
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_type_check;

ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_type_check
  CHECK (account_type IN (
    'paystack_settlement', 'merchant_payable', 'reserve_held',
    'default_pool', 'revenue', 'receivable', 'refund_payable',
    'customer_float'
  ));

-- 2) Posting identity --------------------------------------------------------
-- Fails loudly if duplicates already exist; a duplicate posting is a real
-- accounting error that must be compensated by hand before this can be trusted.
-- To find them:
--   SELECT transaction_id, account_type, account_ref, direction, count(*)
--   FROM ledger_entries
--   GROUP BY 1,2,3,4 HAVING count(*) > 1;
CREATE UNIQUE INDEX ledger_posting_identity_uq
  ON ledger_entries (transaction_id, account_type, account_ref, direction);

COMMIT;
