#!/bin/bash
# End-to-end smoke test against a locally running API.
#
# Usage:
#   # one-time, after `pnpm db:seed:dev`:
#   ./scripts/smoke.sh bootstrap-admin              # sets a password on seed-admin
#
#   # then any time the API is running (`pnpm --filter @installment/api dev`):
#   ./scripts/smoke.sh                              # full happy-path smoke
#
# Environment overrides:
#   API           default http://localhost:3000
#   ADMIN_EMAIL   default seed-admin@installment.local
#   ADMIN_PASS    default Smoke!12345

set -euo pipefail

API=${API:-http://localhost:3000}
ADMIN_EMAIL=${ADMIN_EMAIL:-seed-admin@installment.local}
ADMIN_PASS=${ADMIN_PASS:-Smoke!12345}

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1"; exit 1; }; }
require curl
require jq
require psql
require node

section() { printf "\n\033[36m=== %s ===\033[0m\n" "$*"; }
ok()      { printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail()    { printf "  \033[31m✗\033[0m %s\n" "$*"; exit 1; }

if [[ "${1:-}" == "bootstrap-admin" ]]; then
  section "Bootstrapping admin password ($ADMIN_EMAIL)"
  HASH=$(node -e "require('bcryptjs').hash(process.argv[1], 10).then(h => console.log(h))" "$ADMIN_PASS" 2>/dev/null \
        || node -e "console.log(require('bcrypt').hashSync(process.argv[1], 10))" "$ADMIN_PASS")
  psql "${DATABASE_URL:-postgresql://installment:installment@localhost:5432/installment}" \
       -c "UPDATE users SET password_hash = '${HASH}' WHERE email = '${ADMIN_EMAIL}';" >/dev/null
  ok "admin password set"
  echo "  next: ./scripts/smoke.sh"
  exit 0
fi

# 1. Login
section "Login"
TOKEN=$(curl -sf -X POST "$API/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jq -r '.tokens.accessToken')
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || fail "login failed — run \`./scripts/smoke.sh bootstrap-admin\` first?"
AUTH="authorization: Bearer $TOKEN"
ok "logged in as $ADMIN_EMAIL"

# 2. Merchant
section "Merchant"
SUFFIX=$(date +%s)
MERCHANT=$(curl -sf -X POST "$API/admin/merchants" -H "$AUTH" -H 'content-type: application/json' -d "{
  \"business_name\":\"Smoke Co ${SUFFIX}\",
  \"legal_name\":\"Smoke Co Ltd ${SUFFIX}\",
  \"email\":\"smoke+${SUFFIX}@x.gh\",
  \"phone\":\"+233244${SUFFIX:0:7}\"
}")
MERCHANT_ID=$(echo "$MERCHANT" | jq -r '.id')
ok "merchant $MERCHANT_ID"

# Activate merchant + attach a recipient code so the settlement run has something to send to.
curl -sf -X POST "$API/admin/merchants/$MERCHANT_ID/transition" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"event":"approve_kyc"}' >/dev/null
curl -sf -X POST "$API/admin/merchants/$MERCHANT_ID/paystack-recipient" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"paystack_recipient_code\":\"RCP_smoke_${SUFFIX}\"}" >/dev/null
ok "merchant activated + recipient attached"

# 3. Customer
section "Customer"
CUSTOMER=$(curl -sf -X POST "$API/admin/customers" -H "$AUTH" -H 'content-type: application/json' -d "{
  \"first_name\":\"Smoke\",
  \"last_name\":\"Test\",
  \"email\":\"smoke-c+${SUFFIX}@x.gh\",
  \"phone\":\"024${SUFFIX:0:7}\"
}")
CUSTOMER_ID=$(echo "$CUSTOMER" | jq -r '.id')
ok "customer $CUSTOMER_ID"

# 4. Plan template (BNPL, 4× weekly)
section "Plan template"
TPL=$(curl -sf -X POST "$API/admin/plan-templates" -H "$AUTH" -H 'content-type: application/json' -d "{
  \"name\":\"Smoke BNPL ${SUFFIX}\",
  \"business_model\":\"bnpl\",
  \"number_of_installments\":4,
  \"installment_frequency_days\":7,
  \"min_amount_pesewas\":1000,
  \"max_amount_pesewas\":10000000
}")
TPL_ID=$(echo "$TPL" | jq -r '.id')
ok "template $TPL_ID"

# 5. Application → approve → plan
section "Application + plan activation"
APP=$(curl -sf -X POST "$API/admin/applications" -H "$AUTH" -H 'content-type: application/json' -d "{
  \"customer_id\":\"$CUSTOMER_ID\",
  \"merchant_id\":\"$MERCHANT_ID\",
  \"plan_template_id\":\"$TPL_ID\",
  \"order_reference\":\"ORD-SMOKE-${SUFFIX}\",
  \"order_amount_pesewas\":100000,
  \"merchant_category\":\"electronics\"
}")
APP_ID=$(echo "$APP" | jq -r '.id')
curl -sf -X POST "$API/admin/applications/$APP_ID/decision" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"outcome":"approved"}' >/dev/null
PLAN=$(curl -sf -X POST "$API/admin/plans/from-application/$APP_ID" -H "$AUTH")
PLAN_ID=$(echo "$PLAN" | jq -r '.plan.id')
SCHED1=$(echo "$PLAN" | jq -r '.schedule[0].id')
ok "plan $PLAN_ID, first installment $SCHED1"

# 6. Manual payment on installment 1
section "Manual payment"
curl -sf -X POST "$API/admin/installments/$SCHED1/record-payment" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"provider_reference":"smoke-001"}' >/dev/null
PAID_STATUS=$(curl -sf "$API/admin/plans/$PLAN_ID/schedule" -H "$AUTH" | jq -r '.[0].status')
[[ "$PAID_STATUS" == "paid" ]] || fail "installment 1 not paid: $PAID_STATUS"
ok "installment 1 paid"

# 7. Merchant dashboard — settlement booked
section "Settlement dashboard"
BAL=$(curl -sf "$API/admin/merchants/$MERCHANT_ID/balances" -H "$AUTH")
PAYABLE=$(echo "$BAL" | jq -r '.payablePesewas')
RESERVE=$(echo "$BAL" | jq -r '.reserveHeldPesewas')
[[ "$PAYABLE" == "91000" ]] || fail "expected merchant_payable=91000, got $PAYABLE"
[[ "$RESERVE" == "5000" ]]  || fail "expected reserve_held=5000, got $RESERVE"
ok "payable GHS 910.00 / reserve GHS 50.00 booked"

# 8. Per-plan settlement view
PLAN_VIEW=$(curl -sf "$API/admin/plans/$PLAN_ID/settlement" -H "$AUTH")
GROSS=$(echo "$PLAN_VIEW" | jq -r '.grossAccruedPesewas')
[[ "$GROSS" == "100000" ]] || fail "expected gross accrued=100000, got $GROSS"
ok "plan footprint: gross accrued GHS 1,000.00"

section "Smoke OK"
echo "  merchant=$MERCHANT_ID  customer=$CUSTOMER_ID  plan=$PLAN_ID"
