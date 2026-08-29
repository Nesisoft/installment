# Contributing

## Branch names

`<type>/<scope>-<short-description>` — the same `type` and `scope` vocabulary the commit
messages already use, so a branch, its commits and its PR all say the same thing.

```
feat/mobile-customer-app
feat/api-fulfilment-events
fix/web-storefront-shapes
refactor/commerce-storefront-reads
chore/deps-expo-57
docs/design-customer-app
```

**Types** — pick the one that describes the _outcome_, not the effort:

| Type       | For                                                          |
| ---------- | ------------------------------------------------------------ |
| `feat`     | new behaviour a user or an integrator can observe            |
| `fix`      | behaviour that was wrong and now is not                      |
| `refactor` | the same behaviour, better arranged — no user-visible change |
| `perf`     | measurably faster or lighter, behaviour unchanged            |
| `test`     | tests only                                                   |
| `docs`     | documentation only                                           |
| `chore`    | dependencies, tooling, CI, release plumbing                  |

**Scopes** — the workspace the change lands in: `api`, `core`, `commerce`, `db`, `mobile`,
`web`, `admin`, `infra`, `design`. Use the one that owns the change; a change that genuinely
spans several takes the one a reviewer would look at first.

Keep the description short, lowercase and hyphenated — three or four words. The branch names the
change; the PR explains it.

> Automated branches (`claude/*`, `dependabot/*`, `renovate/*`) are exempt: their names are set by
> the tool that opens them, not chosen. Where the tool allows a name, use the convention.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, matching the
table above. The summary says what changed and, where it is not obvious, why — the body is the
place for reasoning, trade-offs and anything a reviewer would otherwise have to reconstruct.

## Pull requests

Open one per coherent change. The body should let a reviewer answer three questions without
reading the diff: what changed, why it had to change, and what you did to convince yourself it
works. Call out anything that changes a wire shape, a database column or a business rule —
those are the things that break other people.

PRs are **squash-merged**, so the PR body becomes the commit message on `main` — write it for
someone reading `git log` in a year, not just for today's reviewer.

Once it is merged, resync your checkout and drop the branch:

```bash
git checkout main && git fetch origin main && git pull --ff-only origin main
git push origin --delete <branch> && git remote prune origin
```

Squashing means the branch tip is never an ancestor of `main`, so a local `main` left behind will
not fast-forward and `git branch --no-merged main` will list already-merged branches as unmerged.
Turning on **Settings → General → Automatically delete head branches** handles the second command
for you.

## Before you push

Run what CI runs, in the order CI runs it — not a subset:

```bash
pnpm format        # writes; CI runs format:check and fails on a diff
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm --filter @installment/core --filter @installment/commerce test:integration
```

That last line is the one people skip, and it is the one that catches cross-module regressions: a
validation rule tightened for one caller can break a flow in another app that no unit test touches.
It needs Postgres and Redis — `./scripts/local-stack.sh up` gives you both without Docker, or
`pnpm db:up` if you have Docker.

## Build the workspace before running an app

`apps/api/tsconfig.json` has no `paths` redirect, so `@installment/core` and `@installment/commerce`
resolve to their built `dist/*.d.ts`, not to source. A checkout that has never been built — or one
pulled across a change that added a package — fails `nest start` with dozens of "has no exported
member" errors that look like missing code and are only a missing build:

```bash
pnpm install && pnpm build
```

When an app you are not working on breaks the build, `turbo` aborts the whole run — potentially
before your dependencies are built, leaving you exactly as stuck as before. Build only what you
need:

```bash
pnpm build --filter=@installment/api...     # the API and everything it depends on
```

`apps/customer-mobile` needs none of this: Metro reads `@installment/mobile-kit` and
`@installment/api-types` straight from TypeScript source.

## Migrations are immutable

A migration that has been applied is never edited — add `000N_*.sql` instead. See
[`docs/adr/0001-sql-first-migrations.md`](docs/adr/0001-sql-first-migrations.md). After adding one,
run `pnpm migrate && pnpm db:introspect` so the typed Drizzle schema keeps up.

## Money and time

Money is **always integer pesewas** (GHS × 100) in a `*_pesewas` field, and formatting happens once
at the edge. Timestamps cross the wire as ISO-8601 strings — see the parsing trap documented in
`apps/customer-mobile/src/lib/dates.ts` before you call `new Date()` on one.
