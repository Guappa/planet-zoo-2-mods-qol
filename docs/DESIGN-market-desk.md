# Design: Market desk (direct listing engine)

Status: being built (2026-10-17). Replaces the click-driven market lister as the way PZ2QoL lists
animals in Franchise.

## Why

The old lister (`lister.js` `sellAtRecommendedPrice`) works the Animal Storage screen like a player:
it fires `AnimalStorage_SelectAllToggled` / `AnimalStorage_ItemSelected`, waits for the info panel's
DataStore to follow, and fires `AnimalStorage_AddToMarket(key, price, hours)`. The storage list is
rewritten by the game all the time while animals are on the market (every listed row's countdown,
rebuilds after sales and expiries), and its row keys (`animal_<n>`) are positions, so the JS run kept
losing its animal ("the list changed", "could not be selected") and every step depended on the
screen's timing.

## What the game really does (decompiled 1.0.5, offline; full notes in the skill)

- The storage screen's Confirm is a one-line pass-through:
  `AnimalStorage_AddToMarket(key, price, hours)` → `api.planetHub.StorageUIStartAnimalAuction(key,
  price, hours)` (`animalstoragehubmode.lua:240-243`). No Lua check before or after. CC only,
  integer price, integer hours.
- `key` is the storage DataStore row key (`animal_<n>`), not a GUID. `api.planetHub.
  StorageGetIDAndAIDType(key)` gives the animal's stable `(GUID, 2)`.
- Can-trade (`actions.tradeAllowed` / `tradeDisallowedReason`) and the price and duration limits
  (`animalTradeListingData`) are native and exist only for the **selected** animal; selecting is a
  local call, `StorageUIClearSelectedItems()` + `StorageUISelectItem(key)`.
- No success message: the row's `auctionTimerSeconds` becomes > 0 (and the native clears the
  selection). Failures arrive as `MsgType_DatabaseErrorMessage` with request type 42.
- Busy signals: `franchise:IsDatabaseOperationInProgress()`, `franchise:RequestsInProgress()`,
  DataStore `['hubAnimalsData','network'].connectingAction` / `loadingItems`.
- The row keys only mean something while the Animal Storage hub mode is active.

## Design

### The engine lives in Lua (`Main/pz2qol.lister.lua`, `PZ2QoL.Lister`)

A per-frame state machine in the patched `AnimalStorageHubMode.Advance`, so it is frame-accurate,
independent of the page's timers and re-renders, and sends exactly what the game's own Confirm sends.
It works on **GUIDs**: each step resolves the animal's current row key, and the send re-checks
`StorageGetIDAndAIDType(key) == guid` in the same Lua tick as `StorageUIStartAnimalAuction`, so a
rebuilt list can never make it list another animal.

Per animal (one at a time; the player's click is the opt-in; only the player's Stop ends a run):

1. **Wait for the server**: none of the busy signals, up to 10 s (else skip `busy`).
2. **Resolve**: the key whose GUID is the animal's (the page's key hint first, then the whole list).
   Not found → skip `gone`; listed / moving / maturity 6 / maturity 0 → skip `listed` / `moving` /
   `elderly` / `juvenile`.
3. **Select** it natively (local, no server call): clear first and see the selection empty, note
   what the game's data shows then, then select. Data still equal to that note is trusted only
   after 1.5 s (the native may not reset it on clear).
4. **Wait for the game's data** for that selection (selection = {key}, `tradeAllowed` and limits
   written, then a short settle), up to 5 s (else `unselectable`), as the page reports it
   (Page-assisted reads, below; Lua's own reads only when the page does not report). `tradeAllowed == false` → skip
   `untradeable` with the game's reason.
5. **Send**: busy check again, key → GUID, the selection and the game's data (unchanged since the
   price was worked out; else settle again, at most 3 times) checked again in the same tick.
   The price and both duration limits must be there. Price = the
   page's recommendation (or the game's default when there is none), clamped to the game's min..max
   and rounded; hours = the game's longest (or its default, as chosen). Then the game's own call.
6. **Confirm**: the animal's row shows `auctionTimerSeconds > 0` → `listed`. A request-42 server
   error: `DidNotGetResponse` waits 8 s more for a late confirmation (else `timeout`); `Unknown` /
   unnamed codes get a 3 s grace (else `refused`); any other name → `refused`. 30 s without either →
   `timeout`. After a timed-out listing the next one waits for the server to stay idle 3 s
   (a late answer must not be charged to it).
7. **Pause** the player's pace (1–10 s, default 3 s) after every animal that reached the server,
   accepted or not (developer rule 2026-10-16), then the next.

Leaving Animal Storage ends the run (`closed`); the desk offers to resume the rest with a click.
No market check runs during a listing run (page and Lua both refuse it). Resolve answers each
key's GUID with the row's name, species and sex read in the same tick; the page keeps a GUID only
if that is still the animal it read.

### Page ↔ Lua protocol (hub page view; Lua answers with `TriggerEventAtNextAdvance`)

Page → Lua:

| Event | Args | |
|---|---|---|
| `PZ2QoL_ListerHello` | sReq | capabilities |
| `PZ2QoL_ListerResolve` | sReq, sKeysCsv | row keys → GUIDs |
| `PZ2QoL_ListerStart` | sReq, sJob | start a run (refused while one runs) |
| `PZ2QoL_ListerStop` | – | stop (after the current wait) |
| `PZ2QoL_ListerPace` | nMs | change the pause during a run |

Job (plain text; the mod's Lua has no JSON decoder): the first line `v1 <paceMs>`, then one line per
animal, `<guid> <key> <price> <hours>`, space-separated: `guid` a decimal string (exact; never a JS
number), `key` the row key the page last saw (a hint), `price` an integer or `-` (none: the game's
default), `hours` `max`, `default` or an integer. Labels stay on the page (results carry the GUID).

Lua → page:

| Event | Args |
|---|---|
| `PZ2QoL_ListerCaps` | sReq, sJson `{ ok, missing: [..], storage, online, rows, running, version }` |
| `PZ2QoL_ListerIds` | sReq, sJson `{ ids: { key: guid }, failed }` |
| `PZ2QoL_ListerState` | sJson (below), on every change and about once a second while waiting |

State: `{ run, req, phase: "running"|"done"|"stopped"|"closed", total, index, step:
"server"|"resolve"|"select"|"selected"|"send"|"confirm"|"pause"|"", waited (s), paceMs, message,
results: [{ guid, label, status: "pending"|"working"|"listed"|"skipped"|"refused"|"timeout"|"stopped",
kind, price, hours, capped: "min"|"max"|null, usedDefault, detail }] }`.

Skip kinds: `gone, listed, moving, elderly, juvenile, untradeable, unselectable, changed, busy,
noprice, refused, timeout, stopped, error`.

### The desk (`js/mods/pz2qol/marketdesk.js`): its own menu

A big panel over Animal Storage (the Species board's kit), opened from the price panel's header
(**Market desk**, next to the pause and offset); it opens with the storage screen's ticks. The storage list's churn cannot disturb it: rows are the
desk's own, keyed by GUID, re-read at most once a second and re-drawn only when something the desk
shows changes (a countdown only redraws its coarse "Nh left").

- **Left**: species in storage with sellable / on-market counts.
- **Middle**: the species' animals with filters (below), each row with its
  recommended price and confidence and its state (sellable, on the market with time left, or why it
  can't be sold; during and after a run: listing…, listed at N CC, skipped / refused and why).
  The desk's own selection (opens with the storage screen's ticks); Tick all shown / Untick shown.
  Column headers sort (Animal, Genes best/worst first, Price).

#### Filters (`filterRows` in `listercore.js`, tested)

The point is choosing a population to sell, e.g. genes 0-50: Tick all shown, List, keep the rest.
- Main bar: Sex; Age (juvenile / young / adult / elderly, several at once); Fertility (fertile /
  infertile, as the game marks it); Rating (medals, several at once); **Genes**: a two-knob range
  slider (0-100) with presets ≤ 40, ≤ 50, ≥ 70, All; Show (sellable / on the market / not sellable).
- **More filters** (a pop-out, its count on the button): what "genes" means (overall average,
  breeding score, or one gene; the range, Keep the best and the gene sort follow it); a range per
  gene; **Keep the best N ♂ + N ♀** of each species (shows only the rest: the cull candidates;
  listed animals are neither kept nor counted); pregnant (hide / only); the game's storage tag
  (No tag, Sell, Release, Move, Keep); Kin (a close relative in storage, once Kin has read
  storage); the recommended price range; name contains.
- Tick all never takes an animal tagged **Keep** in storage, unless the Keep tag is filtered for.
- Filters are kept for the session (`localStorage`, `PZ2QoL.deskFilters`; the desk works without
  it). Reset puts them back (keeping the species, sort and gene choice).
- While the desk is open a dim layer covers Animal Storage: the engine selects each animal there
  before listing it, and the player does not need to watch or touch that screen.
- **Right**: the run: N selected, total, duration (longest / game default), price offset, pace;
  **List N animals**; a progress bar, the current animal and step, Stop; afterwards the summary and
  **Retry skipped**.

The price panel under the storage toolbar keeps its advice; its **Sell** now starts the same engine.

### Fallback

If the Lua side does not answer `PZ2QoL_ListerHello`, or lacks a call it needs, or cannot read the
storage list, the old click-driven path runs (fail soft, ground rule 4), and the desk says so.

## Tests

- `tests/lua/test_lister.lua`: the engine against a mocked `api.planetHub`, DataStore and franchise
  (every step, skips, clamps, errors, pace, stop, close, the same-tick GUID check).
- `tests/listercore.test.mjs`: the desk's pure helpers.
- Harness `kin`-style scenario `tests/uiharness/market_desk.mjs` with a fake Lua engine in the page.

## Why the engine still selects (2026-10-17)

The developer asked whether the listing can go without the storage selection. Not safely:
- the game writes `tradeAllowed` and the price and duration limits **only for the selected
  animal**, and no other call returns them (exe strings: no storage limit getter);
- a price outside the limits is something the game's own UI can never send; refusals of request
  42 have preceded crashes (game-data-and-events.md);
- whether the native lists the key it is given or the selection is unknown: sending a key with
  another animal selected could list the wrong one.
Selecting is a local call (no server request). The desk dims the storage screen meanwhile.

## In game, 2026-10-17 (Y:, Franchise)

Every animal was skipped "the game didn't select it" (`lister_unsel_selection`) although the
selection showed on screen: `selectedAnimalIDs` read from Lua never matched the key. The engine
then read the row's own `selected` flag first (`Lister:_SelState`), the array only as a fallback
and to see a second selected animal. Marks (once per run, when the flag first says selected): `lister_sel_array_empty` /
`lister_sel_array_ok` (whether the array agreed), `lister_sel_other` (a multi-selection).

A second run the same day failed the same way, and no `lister_sel_array_*` mark fired: the flag
never read true from Lua either. The page reads all three fine (the old `lister.js` listed end to
end with them), so the page now reads them for the engine.

### Page-assisted reads (2026-10-17)

| Direction | Event | Args |
|---|---|---|
| Lua → page | `PZ2QoL_ListerWatch` | sReq, sKey: report what you see for this key; `("", "")` stops |
| page → Lua | `PZ2QoL_ListerSeen` | sReq, sText (below), every 100 ms while watching |

- Lua starts a watch (new `req` = `w<run>_<n>`) right after the Clear and again right after the
  Select, so only what the page read after that call counts. It stops the watch on leaving the
  clear / select / selected / send steps and when the run ends; if no report came for 1 s it sends
  the same watch again (a reloaded page). The page stops by itself when the engine's state is no
  longer `running`, or 60 s after the last watch.
- Text (`listercore.js` `readSeen` + `encodeSeen`; Lua `parseSeen`): `v1|<key>|<selected keys,
  comma-separated, or ? when unreadable>|<tradeAllowed 1/0/->|<tradePriceMin,tradePriceMax,
  tradePriceDefault,tradeDurationMin,tradeDurationMax,tradeDurationDefault, - for none>|<reason>`.
  Plain text: the mod's Lua has no JSON decoder; the reason (it may hold `|`) is the rest.
- **The decision**: the freshest report for the current `req` and key, at most 0.6 s old, is the
  authority: selection exactly `{key}`, `tradeAllowed` a bool, and (when allowed) price min, max
  and a duration limit present, else the engine keeps waiting until the 5 s timeout
  (`unselectable`). With no fresh report, Lua's own reads decide as before (the fallback).
- The clear step waits (≤ 1 s) for the page to show the selection empty once the page has
  reported in this run. The "unchanged since before selecting" note and every later print come from
  the same source; a note from Lua compared with page data counts as unchanged (the longer settle).
- At the send: selection still exactly `{key}` by the freshest report, the data print and its
  source unchanged (else settle again, at most 3 times), then key → GUID in the same tick as
  `StorageUIStartAnimalAuction`. Never sent without limits.
- Marks: `lister_page_seen` (first report of a run), `lister_page_bad` (unparsable),
  once per run when the page first shows everything: Lua's own reads then, `lister_diag_flag_true/
  _false/_nil`, `lister_diag_arr_nil/_empty/_key/_other`, `lister_diag_allowed_bool/_nil`,
  `lister_diag_limits_ok/_none`; on a timeout, the page's last view: `lister_page_sel_key/_other/
  _empty/_unread` or `lister_page_none`. Page breadcrumbs: `js_lister_watch`, `js_lister_seen`
  (first report of each watch), `js_lister_watch_end`.

## To prove in game (trace marks `lister_*`)

Whether the native lists the key or the selection; the DataStore table shapes Lua reads
(`GetDataStoreContextAsTable` on the list, `selectedAnimalIDs`: empty or another shape); whether
`IsDatabaseOperationInProgress()` is `(true, 42)` during a listing; whether selection and limits
update in the same frame.
