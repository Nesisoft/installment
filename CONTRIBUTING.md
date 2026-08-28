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

## Before you push

```bash
pnpm format        # writes
pnpm lint
pnpm typecheck
pnpm test
```

CI runs all of these plus `pnpm build` and the integration suite against real Postgres and Redis.
`./scripts/local-stack.sh up` gives you both without Docker.

## Migrations are immutable

A migration that has been applied is never edited — add `000N_*.sql` instead. See
[`docs/adr/0001-sql-first-migrations.md`](docs/adr/0001-sql-first-migrations.md). After adding one,
run `pnpm migrate && pnpm db:introspect` so the typed Drizzle schema keeps up.

## Money and time

Money is **always integer pesewas** (GHS × 100) in a `*_pesewas` field, and formatting happens once
at the edge. Timestamps cross the wire as ISO-8601 strings — see the parsing trap documented in
`apps/customer-mobile/src/lib/dates.ts` before you call `new Date()` on one.
