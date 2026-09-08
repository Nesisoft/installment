# Ejua — the missing screens

Design source for the eleven Ejua screens that had no design of record.

Unlike `../Ejua Shop.dc.html` and `../Ejua Sell (merchant).html` — which arrived
from the design tool as finished bundles with no separate source — this canvas
was authored here, so what is committed is the **source**: one `.dc.html` per
artboard plus `canvas.json` for the layout. The seeded 2.5 MB page is
gitignored, because almost all of it is the editor's own bundled code and it is
reproducible from these files in one command.

## The screens

**Page 1 — shopper.** Six screens with no design at all. Every one is backed by
a route that already exists and has no client, which is why they are here:

| Artboard | Screen | Route with no client |
| --- | --- | --- |
| `Main.dc.html` | Request a return | `POST /me/orders/:id/return` |
| `MyReturns.dc.html` | My returns | `GET /me/returns` |
| `WriteReview.dc.html` | Write a review | `POST /me/reviews` |
| `ReviewPrompts.dc.html` | Rate what you bought | `GET /me/reviews/pending` |
| `AddressBook.dc.html` | Delivery addresses | `/me/addresses`, `POST /me/addresses/:id/default` |
| `SavedItems.dc.html` | Saved | `GET /me/wishlist` |

**Page 2 — seller.** Five screens that are already built and shipped without a
design. These are the design of record *after the fact*, drawn from what the
code does so the canvas and the app agree rather than drifting: the returns
queue and decision (#82), the restock sheet, editing a listing, and shop setup
(#81).

## Two decisions that are proposals, not documentation

- **Request-a-return has no per-item choice.** `order_returns` is whole-order by
  design (`0020_order_returns.sql` — `order_items` has no status column), so the
  screen says so rather than implying a choice that does not exist.
- **The address book carries a GhanaPostGPS field.** The column exists, the
  seller's order screen already renders it, and nothing writes it. Adding it
  here proposes the fix; it is not the present behaviour.

## One thing to settle

The seller's returns queue ships copy for a withdrawn return — "A buyer can
withdraw a request before you decide on it" — and nothing in this system sets
`order_returns.status = 'cancelled'`. Either My returns gains a withdraw control
or that copy goes. Recorded in `merchant-app.md` §6 as well.

## Rebuilding the canvas

The helper ships with the `design` skill, so its path varies by version. From
this directory:

```sh
SKILL=/path/to/bundled-skills/<version>/<hash>/design
node "$SKILL/seed-canvas.mjs" \
  --template "$SKILL/payload.template.html" \
  --out ejua-missing-screens.html \
  --title "Ejua — The Missing Screens" \
  --artboard Main.dc.html --artboard MyReturns.dc.html --artboard WriteReview.dc.html \
  --artboard ReviewPrompts.dc.html --artboard AddressBook.dc.html --artboard SavedItems.dc.html \
  --artboard ReturnsQueue.dc.html --artboard ReturnDecision.dc.html --artboard RestockSheet.dc.html \
  --artboard EditListing.dc.html --artboard ShopSetup.dc.html \
  --canvas canvas.json
node "$SKILL/seed-canvas.mjs" --check ejua-missing-screens.html
```

Edited the canvas in the browser instead? The saved version is the newer one —
extract it back over these files with `seed-canvas.mjs --extract <saved page>
--to <empty dir>` before changing anything here, or the next reseed overwrites
the edits.

## Tokens

Lifted verbatim, not approximated: `apps/customer-mobile/src/theme/tokens.ts`
for the shopper artboards (crimson `#D6165A`) and
`apps/merchant-mobile/src/theme/tokens.ts` for the seller ones (green
`#0F8B5E`). Outfit throughout, via Google Fonts — the one font host the canvas
CSP admits. The two apps' type ramps genuinely differ (shopper `h1` 30/−1.1,
seller 28/−1) and the artboards keep that difference.
