# Runbook — the stand-in email domain

**When:** before production takes its first payment from a customer who signed up with only a
phone number, and whenever the API logs `StandInEmailDomain` at boot.
**Who:** whoever controls Ejua's DNS. Nothing here is a code change.
**Severity:** customers' payment receipts going to a stranger.

---

## What it is

A customer who signs up with a phone number has no email. Signup stores
`<phone>@customer.installment.local` to satisfy the column, and Paystack refuses that address, so
`chargeableEmail` (`packages/paystack-client/src/client.ts`) gives Paystack
`<phone>@$PAYSTACK_STANDIN_EMAIL_DOMAIN` instead — `customers.ejua.gh` by default.

Paystack emails a receipt to that address for every charge. So the domain must be:

1. **One Ejua controls.** Whoever owns the domain can read every one of those receipts: the
   customer's phone number, the amount and the merchant.
2. **Refusing mail.** A null MX record (RFC 7505) makes sending servers reject the message at
   once, instead of queueing it or delivering it anywhere.

## State when this was written (2026-10-27)

| Domain              | DNS                                                 |
| ------------------- | --------------------------------------------------- |
| `ejua.gh`           | **Does not exist** (NXDOMAIN at the `.gh` registry) |
| `customers.ejua.gh` | Does not exist                                      |
| `ejua.shop`         | Does not exist                                      |
| `ejua.com`          | Registered to someone else, parked for sale         |

So the default stand-in domain sits under a name **anyone can still register**. The same is true
of `api.ejua.gh` and `cdn.ejua.gh`, which appear in configuration and docs.

## What to do

1. Register `ejua.gh` (or set `PAYSTACK_STANDIN_EMAIL_DOMAIN` to a subdomain of a domain Ejua
   already owns).
2. Publish a null MX on the stand-in subdomain, and nothing else that would accept mail:

   ```
   customers.ejua.gh.  3600  IN  MX  0  .
   ```

3. Check it:

   ```bash
   dig +short MX customers.ejua.gh     # expect: 0 .
   ```

4. Restart the API. In production, `StandInDomainCheck`
   (`apps/api/src/config/standin-domain.check.ts`) resolves the domain's MX after boot. It logs
   `StandInEmailDomain` and sends a Sentry warning when the domain does not exist, has no MX
   record, or accepts mail. Silence means the null MX is in place.

The check warns and never refuses to start: DNS is not the deployment's to vouch for, and a
resolver outage must not take payments down.

## Later

Storing no email at all for phone-only accounts — instead of a placeholder — is the proper fix.
It is a schema change (the `users` and `customers` email columns are `NOT NULL UNIQUE`) and is not
done yet. Until then this domain is how those customers are charged.
