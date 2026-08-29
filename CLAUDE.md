# Working agreements

Standing instructions for Claude Code in this repository. `CONTRIBUTING.md` holds the conventions
that apply to everyone — branch names, commit format, migrations, money and time. This file holds
the ones that exist because of how _this_ collaboration has actually gone wrong.

## Finish every piece of work the same way: branch, PR, merge, pull

Work is not done when the code is written. It is done when it is on `main` and the local checkout is
back on that state. Run the whole cycle, every time, without being asked:

1. **Branch** off current `main`, named per `CONTRIBUTING.md` (`<type>/<scope>-<description>`).
2. **Verify** — the full CI sequence below, including the integration suites.
3. **Push and open a PR.** Every change goes through one, however small. A one-line documentation fix
   still gets a PR, because the PR body is what becomes the squash commit message on `main`.
4. **Merge it once CI is green** — squash, with a title and body written for someone reading
   `git log` in a year.
5. **Pull `main` back down immediately.**

```bash
git checkout main
git fetch origin main
git pull --ff-only origin main   # or: git reset --hard origin/main
```

Do not leave a merged PR unpulled, and do not start the next piece of work from a stale checkout.

Why step 5 matters: PRs here are **squash-merged**. The squash creates a new commit on `main` with no
parent link back to the branch, so a local `main` left behind is not merely stale — it is on a
lineage that will never fast-forward cleanly, and the next branch cut from it starts from the wrong
base. It also makes `git branch --no-merged main` report already-merged branches as unmerged, which
is genuinely confusing to read.

Delete the merged branch once its content is verified to be in `main`. Verify by content, not by
ancestry — `git diff origin/main origin/<branch>` should show only lines a later PR superseded.
Deleting a remote branch may be refused (HTTP 403) depending on the session's credentials; when that
happens, say so and hand over the exact command rather than leaving the branch unmentioned.

If several PRs are open at once, merge them oldest first, pulling `main` between each, so every merge
lands on the state the next one will sit against.

## Do not fan out large numbers of parallel agents

There is a real daily token budget on this account, and a wide parallel fan-out can consume it in a
single call — ending the session mid-task. This has happened.

Prefer reading the repository directly. Where a subagent genuinely helps, use one or two, not a
fleet, and say what it is for. This applies to the `Workflow` tool as well: do not reach for it
unless asked.

## Run the full CI sequence before pushing — including the integration suites

`CONTRIBUTING.md` lists the fast local checks. CI runs **more** than that, and the gap is where a
green local run has turned into a red PR:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test
pnpm --filter @installment/core --filter @installment/commerce test:integration
```

The integration suites are the ones that catch cross-module regressions — a Zod refinement that
looks harmless can break a flow in another app. Needs Postgres and Redis:
`./scripts/local-stack.sh up` (container/CI) or `pnpm db:up` (Docker).

## Report what is actually true

State what was verified and how. If a step was skipped, say so. If a claim in a PR description
turns out to be wrong, correct it in the PR rather than leaving it standing — a reviewer trusting
an inaccurate "verified" line is worse than no line at all.

## Domain traps that keep biting

These are written up properly elsewhere; the pointers matter more than the summaries.

- **Money is integer pesewas.** GHS 289.90 is `28990`, in `*_pesewas` columns. Never float.
- **Never `new Date(apiString)`.** `timestamptz` columns come back as `2026-08-28 11:51:27+00` —
  space separator, two-digit offset — which Hermes parses as `Invalid Date`. Use
  `lib/dates.parseApiDate`. See `apps/customer-mobile/README.md`.
- **`number_of_installments` excludes the deposit.** "Pay in 4" is `down_payment_bps: 4000` plus
  `number_of_installments: 3` — four schedule rows. Count `schedule.length`.
- **Idempotency keys are per logical attempt**, not per tap; the server hashes the body, so the
  same key with a different body is a 409. Hold the key in a ref and reuse it on retry.
- **`localhost` is not the same host for every client.** A handset resolves it to itself. Both
  `EXPO_PUBLIC_API_URL` (mobile `.env`) and `PUBLIC_API_URL` (root `.env`, which feeds image URLs
  through the storage driver) need the LAN address when testing on a device. See
  `docs/design/object-storage.md`.
