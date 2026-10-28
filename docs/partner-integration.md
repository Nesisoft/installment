# Partner integration — what exists, and what a partner needs first

> **Status, 2026-10-28: not open to partners.** The engine can run a partner's instalment plan
> end to end, but only through the console's own routes, with staff credentials. Those
> credentials see every customer and can approve any application, so they cannot be handed to a
> partner. §3 lists what has to be built first. Nothing here is a commitment to a partner yet.

The engine was built to be used two ways: by Ejua's own marketplace, and by other platforms
(Ejua, Meko, Pharmacy POS were the named examples) that sell the goods themselves and want an
instalment plan behind the sale. A partner's order reaches the engine as an `order_reference` —
the partner's own id for the order — and the engine treats it exactly as it treats a marketplace
order.

---

## 1. The flow, as it runs today

Every route is under `/admin` and needs a Bearer token for a staff login holding the permission
shown. The full contract is [`api/openapi.json`](./api/openapi.json).

| Step                                                       | Route                                                                                  | Permission            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------- |
| 1. The partner exists as a merchant, with a payout account | `POST /admin/merchants`, `POST /admin/merchants/:id/paystack-recipient`                | `merchants:write`     |
| 2. The customer exists, with a verified Ghana Card         | `POST /admin/customers`, `POST /admin/customers/:id/ghana-card`, `…/ghana-card/verify` | `customers:write`     |
| 3. Submit the application for the order                    | `POST /admin/applications` with `order_reference`                                      | `applications:review` |
| 4. Score it — this decides                                 | `POST /admin/applications/:id/score`                                                   | `applications:review` |
| 5. Turn an approval into a plan and schedule               | `POST /admin/plans/from-application/:applicationId`                                    | `applications:review` |
| 6. The goods are delivered                                 | `POST /admin/plans/:id/delivery`                                                       | `plans:deliver`       |
| 7. Read the plan, schedule and statement                   | `GET /admin/plans/:id`, `/schedule`, `/statement`                                      | `plans:read`          |

From step 5 the engine runs the plan: it debits the customer's saved card or Mobile Money on each
due date, retries, reminds, opens collections cases, and pays the merchant daily, less commission
and reserve. Nothing more is needed from the partner unless the goods come back:

- a refund of a paid instalment — `POST /admin/installments/:scheduleId/refund`, forgiving it or
  re-collecting it;
- a default — reached by the collections process, or `POST /admin/plans/:id/default`.

### Conventions a partner would rely on

- **Money is integer pesewas.** GHS 289.90 is `28990`, in fields ending `_pesewas`.
- **`order_reference` is unique per merchant.** Submitting the same one twice for the same merchant
  is refused, which makes step 3 safe to retry.
- **`Idempotency-Key` header.** Required on the routes that move money (activation, delivery,
  default, manual payments, refunds); the server hashes the body, so the same key with a different
  body is a 409. Use one key per logical attempt and reuse it on retry.
- **Timestamps** are Postgres `timestamptz` text, like `2026-08-28 11:51:27.239902+00`: a space
  instead of `T`, and a two-digit offset. Parse them as such; JavaScript's `new Date()` is not
  reliable on them across platforms.
- **Errors** come back as `{ "error": "<Name>", "message": "…" }` with a 4xx status; validation
  errors add `issues`.

---

## 2. Why it cannot be opened as it is

1. **No partner identity.** There are no API keys and no partner accounts. The only credentials are
   staff logins (email and password, 15-minute access tokens with refresh).
2. **No scoping.** The routes above read and write every merchant's and customer's data. A partner
   holding them would see every other partner's customers, applications and plans.
3. **The decision is the caller's to make.** `POST /admin/applications/:id/decision` records any
   outcome, approval included — it is the human override for a reviewer. Anyone holding
   `applications:review`, which step 3 needs, can approve their own application.
4. **The permissions are broader than the flow.** `customers:write` also verifies Ghana Cards and
   blocklists customers; `applications:review` also overrides decisions.
5. **No outbound events.** The engine receives Paystack's webhooks and sends none of its own. A
   partner would have to poll to learn that an application was decided, a plan activated, an
   instalment paid or missed, or a plan completed or defaulted.

---

## 3. What a partner needs first

- **Partner accounts and credentials.** A partner bound to its merchant record, with API keys it
  can rotate (or OAuth client credentials), separate from staff logins.
- **Partner routes, scoped.** A `/partner/...` surface where every read and write is limited to
  the partner's own merchant, customers it introduced, and their applications and plans — the way
  `/merchant/...` already scopes the merchant portal.
- **Scoring decides, not the caller.** Submitting an application scores it, as checkout already
  does for the marketplace; the partner gets the decision and cannot set it.
- **KYC the partner can do.** A route to submit a customer's Ghana Card for review that does not
  also grant the reviewer's verify and blocklist powers.
- **Outbound webhooks**, signed, retried, and recorded: application decided, plan activated,
  instalment paid, instalment failed, plan completed, plan defaulted, refund paid.
- **A sandbox**: a separate environment on Paystack test keys, with seeded data, where a partner
  can run the whole flow.
- **A versioned contract.** `api/openapi.json` documents the partner routes with full request and
  response schemas, and changes to them are announced.
