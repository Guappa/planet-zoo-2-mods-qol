# Design: My listings (staleness and reprice)

Status: built 2026-10-19, offline only (unit, Lua and harness tests). Not yet tried in game.

The Market desk's second view. It shows the player's own live listings: which are stale and need a
new price, why, and a workflow that changes the prices. The game has no "change price" call, so a
reprice takes each listing off the market and lists it again.

## What the game gives (1.0.5, offline unless marked)

- **The player's listings** are the Animal Storage rows with `auctionTimerSeconds > 0` (time
  **left**, seconds, rewritten about once a second) and `auctionPrice` (CC asked). No row field
  holds when it was listed or for how long (schema `AnimalMarketAndStorageSchema.js`).
- **Taking one off:** the info panel's Cancel button (shown when the selected row is on the
  market) sends `AnimalStorage_Cancel("Trade")`; the hub mode's `OnCancel` calls
  `api.planetHub.StorageUICancelAnimalAuction()` with **no arguments**: it acts on the
  **selection** (`animalstoragehubmode.lua` OnCancel, `AnimalStorageInfoPanel.js`
  `onSelectCancelMoveOrTrade`). Its server request type, its answer, its delay and any fee or
  cooldown are **unknown**.
- **Market comparison:** the price book (`pricebook.js`) holds every market row the mod has seen
  (the desk's background market check reads all pages of a species), and the player's trade
  history. The player's own listings are among the market rows.

## Staleness (`repricecore.js`, tested in `tests/reprice.test.mjs`)

Per listing, with every one of the player's own listings removed from the price book first
(`marketPools`: both CC forms of each listing's `listingKey`), so an animal is never compared with
itself or its stable-mates:

- **Fair price** `F`: the desk's own price advice for this animal (`recommendPrice`, no player
  offset): comparables of the same medal, sex and age group (scaled when few), the colour-morph
  rules, the gene-score fit, market and trade history.
- **Live comparables**: the same choice of comparables (`comparables`), market rows only, scaled
  to this animal's medal / morph. `n` of them; `cheaper` strictly cheaper, ties within 0.5 %.
- **Premium** `r = P / F − 1`; premium score `clamp((r + 0.05) / 0.35, 0, 1)`: 0 at 5 % under
  fair, 1 at 30 % over.
- **Place in line** `q = (cheaper + ties / 2) / n`: 0 = the cheapest a buyer sees, 1 = the dearest.
- **Price pressure** = `0.5 · premium score + 0.5 · q` (premium alone when nothing is listed).
- **Time on market** `f = elapsed / duration`. The duration is the desk's own (a session ledger of
  every listing its engine confirmed: `{ at, hours }` per GUID); else more than 6 h left means a
  12 h listing; else 12 h is assumed (flagged).
- **Score** = `round(100 · pressure · (0.5 + 0.5 f))`. A brand-new listing at most 50; an
  overpriced one at the end of its time 100.
- **Verdict**: no fair price → *No data*; `r ≤ −15 %` and cheaper than every comparable →
  *Underpriced*; score ≥ 50 → *Stale*; ≥ 25 → *Watch*; else *Healthy*. Flags: *expiring* (< 1 h
  left: it returns to storage unsold), *market data old* (species not checked in 30 min; the price
  book's newest market row counts too), low confidence (few comparables).
- **Suggestion**: Healthy → keep. Underpriced → the fair price. Else 2 % under the cheapest
  comparable (first in line), never above `F`, never under 85 % of `F`; Watch keeps its price
  when that is already lower.

Every number shows in the row's working drawer (`reasonsOf`), with a price ladder of the
comparables, the fair line, the current and the new price.

## The workflow (`marketreprice.js`)

1. **Sort and filter**: most stale first; chips per verdict (several at once), Expiring < 1 h;
   species rail with stale / watch counts and a bar; sort by staleness, over fair, time left, price.
2. **Decide**: tick (Tick stale, Tick all shown, single ticks). One rule for the ticked listings:
   Suggested, Fair, Match cheapest, Undercut cheapest by X %, Cut my price by X %, with a floor
   (never under N % of fair; not for Suggested, which has its own). A per-listing price (the
   drawer: a box, ±5 %, Suggestion / Fair / Cheapest) overrides the rule.
3. **Preview** (live): old → new total, how many lower / higher / same, how many stay above the
   cheapest, held at the floor, without a price; the biggest changes.
4. **Reprice N** opens a sheet with the plan (three steps, every listing old → new and why, an
   estimate of the time, what happens if it stops). Enter confirms, Esc cancels; a stray click in
   the first 300 ms does nothing. Market prices must be checked in the last 30 minutes for the
   ticked species (as for listing).

## The run (`repricerun.js`; Lua `pz2qol.lister.lua` mode `unlist`)

1. **Take off**: one engine job `v1 <pace> unlist` with `<guid> <key> - max` lines. Per listing
   the engine waits for the server, finds the row by GUID (must still be listed, else
   `notlisted`), clears and selects it natively, requires a **fresh page report** that exactly
   that row is selected (Lua's own selection reads never worked in game), settles, then in one tick:
   not busy, a report newer than the step, the key still the animal (`_Holds`), the row still
   listed; then `StorageUICancelAnimalAuction()`. Confirmed when the row (found again by GUID)
   reads not listed twice in a row (first look after 1 s). Gone from storage → `gone` (sold just
   then). 30 s → `timeout`. A database error only shortens the wait to 5 s (request type unknown).
   The player's pause after every one that was sent. Failures skip; Stop ends it.
2. **Settle**: 5 s (the developer: "there will be a little delay"), and until no other run or check.
3. **List again**: the normal listing job (`v1 <pace>`, `<guid> <key> <new price> max|default`)
   for the ones that came off; the engine selects each, reads the game's limits (the price is
   clamped to them), checks again and lists, confirmed by its row.

A Stop (or Animal Storage closing, or a refusal to start) **never lists anything by itself**: the
listings already taken off stay in storage, shown in the run card with their new prices (±5 %
each) and **List the N again** (a click). The run is kept in `localStorage`
(`PZ2QoL.reprice.v1`) so a reopened desk opens on My listings when something is waiting. A
listing listed again some other way (the Sell view) drops out of the waiting list (only a new listing counts: more time left than the old one had, read at least 3 s after it came off, so a storage read from before the take-off never counts). A new reprice
waits until nothing is left off the market.

Page ↔ Lua: Hello caps add `unlist: true` when `api.planetHub.StorageUICancelAnimalAuction` exists.
State results carry status `unlisted` (price = the asked price taken off). Steps add `unconfirm`.
Skip kind `notlisted`. Trace marks `lister_unlist_*`, `lister_unlisted`, `lister_skip_notlisted`;
page breadcrumbs `js_reprice_*`, `js_desk_listings`; debug log area `reprice` (start, tick,
sheet, off_end, relist_start, relist_end, stop) and the engine's `send_unlist`, `unlisted`,
`unlist_server_error`.

## Quick trade / Quick release of listings (2026-10-19)

The right panel's action switch: **Reprice | Quick trade | Quick release**. A quick action is never
remembered (back to Reprice when the desk closes or the view changes).

- **A listed animal is never quick-traded directly.** The storage info panel shows only Cancel for
  a selected row on the market; the Quick trade / Quick release buttons exist only in its "not on
  the market" branch (`AnimalStorageInfoPanel.js` `onGetActionsContent`, 1.0.5, offline). And the
  engine's quick job stops at a listed animal (resolve skip `listed`, unexpected in a quick run:
  nothing sent; Lua test 23 K). So: take off first.
- **Run:** phase 1 the same take-off job (`unlist`), 5 s settle, phase 2 the desk's own quick job
  (`encodeQuickJob`, `v1 <pace> quicktrade|release`): per animal a fresh page report, the game's
  flag for the action allowed right then, `_Holds`, exactly `{ [1] = key }`, confirmed by the row
  leaving storage; **it stops at anything unexpected** (permanent actions, the desk's rule). Each
  item keeps its asking price as its "list again" price.
- **Panel:** the red quick header, how many go, the money: asking now (CC) against what the
  action pays (`quickPreview` = the desk's `quickSheet` on the rows as if off the market: prices
  from each animal's verdict, i.e. the game's `quickTradePrice` / `quickReleasePrice` when a
  listing run last selected it; otherwise "priced when it comes off"), a line per animal, who is
  left out and why (`quickEligible`: no id, Rehome only, the game said no when last checked), the
  first-run limit (`quickAccepted`: Quick release one animal until one was confirmed gone), the
  pace, then the red sheet (three steps, each animal asks → fetches, the left-outs,
  `QUICK_WARNING`). The table's New price column shows what each ticked listing would fetch.
- **Leftovers:** what came off but was not sold (the quick run stopped, the game refused, not
  found) waits in storage: **Quick trade the N again** (the quick job again) or **List the N
  again** (at their old asking prices, ±5 % each). A quick send that was not confirmed counts as
  "check storage", never as waiting.
- Lua (2026-10-19): the engine remembers its last selected animal for 60 s (`tLastSel`), so the
  quick run's first animal right after its own take-off (same animal, data unchanged) is not
  refused as "data did not change" (`nLastSelFresh`).

## Unproven in game

- That `StorageUICancelAnimalAuction()` with the engine's native selection takes the listing off,
  how fast, through which request type, and what the row shows meanwhile (`auctionTimerSeconds`
  −1, 0, or a "connecting" value; the UI's debug path sets −1).
- Whether a listing taken off can be listed again at once (a cooldown would show as `untradeable`
  skips in step 3; the animals then wait under List the N again).
- Whether taking a listing off costs anything.
- The listing ledger is session-only (Gameface `localStorage`): after a restart the time on market
  is inferred (> 6 h left) or assumed (12 h).
