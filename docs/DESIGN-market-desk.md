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
   Not found → skip `gone`; listed / moving / pregnant (`isPregnant`) / maturity 6 / maturity 0 →
   skip `listed` / `moving` / `pregnant` / `elderly` / `juvenile`. The page never puts a blocked
   animal (listed, moving, pregnant, juvenile, elderly) in a job; the engine checks again.
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
| `PZ2QoL_DeskFilters` | sReq, `clear`/`restore` | the game's storage filters off while the desk is open, back on close (2026-10-18, below) |

Job (plain text; the mod's Lua has no JSON decoder): the first line `v1 <paceMs>`, then one line per
animal, `<guid> <key> <price> <hours>`, space-separated: `guid` the animal's token from Resolve
(a decimal string, exact, never a JS number; `t<type>_<id>` / `tx_<id>` for other id types; a
GUID-like string; or `fp<n>`, a fingerprint token, 2026-10-18 below), `key` the row key the page last saw (a hint), `price` an integer or `-` (none: the game's
default), `hours` `max`, `default` or an integer. Labels stay on the page (results carry the GUID).
A third word on the first line picks the job's mode (2026-10-18, `docs/PLAN-desk-quick-release.md`):
`v1 <paceMs> check` is Check storage (each animal selected and its verdict recorded, nothing sent,
150 ms between selects at least, the selection cleared at the end); none is a listing. Each result
carries `verdict` (trade, quickTrade, quickRelease, rehome, reasons, values, prices, src) once the
animal was selected, and the state carries `mode`.
`v1 <paceMs> quicktrade` / `release` (2026-10-18, Phase 2) quick-trade / release exactly the listed animals,
one `{ [1] = key }` call each, confirmed by the storage list; such a run stops at anything unexpected
(see the plan, section 4, and the skill's game-data-and-events.md).

Lua → page:

| Event | Args |
|---|---|
| `PZ2QoL_ListerCaps` | sReq, sJson `{ ok, missing: [..], storage, online, rows, running, version }` |
| `PZ2QoL_ListerIds` | sReq, sJson `{ ids: { key: guid }, rows: { key: { name, species, gender } }, via: { key: "id" \| "lossy" \| "fp" }, failed }` |
| `PZ2QoL_ListerState` | sJson (below), on every change and about once a second while waiting |
| `PZ2QoL_DeskFiltersState` | sReq, sJson `{ ok, cleared, detail }` (detail `again`, `later`, `none`, `nostorage`, `nosettings`, `missing <fn>`) |

**The desk sees all of storage (2026-10-18).** The game's storage filters are native: with one on,
the storage list holds only the rows that pass, and the engine can only select rows in it. So on
open, when the list is filtered (`filters` context or `animalsInStorage` > rows), the desk first
turns the storage screen's ticks into GUIDs, then asks `clear`: Lua keeps
`StorageUIGetSortFilterSettings()` and runs the game's Reset all filters
(`ResetFiltersToDefault`, `ClearFilterText`, `RequestData`). `restore` on close puts the settings
back (`SetSortFilterSettings`, `RequestData`); during a run it waits for the run's end; leaving
Animal Storage restores before the game saves them. The desk starts on the species the screen was
scoped to (or the mod's own `species` storage filter). No answer: the narrowed list and a note.

State: `{ run, req, phase: "running"|"done"|"stopped"|"closed", total, index, step:
"server"|"resolve"|"select"|"selected"|"send"|"confirm"|"pause"|"", waited (s), paceMs, message,
results: [{ guid, label, status: "pending"|"working"|"listed"|"skipped"|"refused"|"timeout"|"stopped",
kind, price, hours, capped: "min"|"max"|null, usedDefault, detail }] }`.

Skip kinds: `gone, listed, moving, pregnant, elderly, juvenile, untradeable, unselectable, changed, busy,
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
- A pregnant animal is never sellable (2026-10-18): "Pregnant: not until she gives birth", under
  Not sellable, never ticked or listed (the market won't take her until she gives birth).
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
  Since 2026-10-18 the page sends **v2** (Lua reads both): `v2|<key>|<sel>|<allowed>|<limits>|
  <reason%>|<quickTrade>|<reason%>|<value%>|<quickRelease>|<reason%>|<value%>|<rehome>|
  <quickTradePrice,quickReleasePrice>|<connecting,loading>|<isReleaseable>|<source%>`, every text
  field percent-encoded (`encodeURIComponent`), so no field holds a raw `|`.
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

## Debug log (2026-10-18)

Debug builds write every step of the desk, the engine (Lua and page), the market check and each
price decision as `LOG` lines with values to `dbg/trace.log` (one animal followable by `run` + `guid`).
Format, events and how to read a run: `.claude/skills/pz2-modding/reference/debugging.md` "Detailed log".

## Animals without a usable id (2026-10-18)

In game (Y:, Franchise) `StorageGetIDAndAIDType(key)` gave an accepted id for only 4 of 63 rows, so
36 of 39 ticked animals were silently left out of a job. Now (`pz2qol.lister.lua` `idToken`,
`identify`, `_Holds`):

- **Id shapes.** Integer ≠ 0 and whole floats below 2^24 → decimal; larger whole floats →
  `%.0f`, **lossy** (game floats may be 32-bit): it counts only while no other row of the list gives
  the same token; strings of `[%w-_:]` (≤ 64) as they are; nil, 0, "", fractions, userdata, tables →
  no id. Any token two rows give is no id for either (collision, or an id that is not per animal).
- **Fingerprint.** A row without an id gets `fp<n>` (one per distinct fingerprint, this session)
  when exactly one row of the whole list has its fingerprint: species, name, gender, maturity,
  `ratings`, `appeal`, `colormorphLabel`, the four `genetics.<gene>.value`. Never the row id, key,
  timer, tag or selection. No species or name: no fingerprint.
- **The engine checks by the same rules** (`_Holds`) at resolve, after the clear and in the same
  tick as `StorageUIStartAnimalAuction`: an id token must still come from the key, the row must
  still show the species/name/sex Resolve saw with it (an id that follows the position would
  otherwise follow it), a lossy one must be unique; a fingerprint token must match exactly one row
  and that row must be the key. Two look-alikes: skip kind **`ambiguous`**; anything else: `changed`
  / `gone`. Uncertain means skipped, never another animal listed.
- **The page.** `resolveGuids` returns `.failed` (keys Lua answered for without an id); `deskRows`
  blocks them **`noid`** ("No id from the game", title `NOID_TEXT`): not tickable, not in List N,
  under Not sellable. Failed keys are backed off (asked again when the row changes, after 5 s
  doubling to 2 min, or on desk open / list change / Read storage again / a List click, which ask
  about every row). `listAnimals` re-resolves at the click; a smaller job says "Listing X of Y: Z
  couldn't be identified by the game" (`partialJobText`) and the run summary repeats it
  (`summaryText(state, fmt, jobNote(state))`).
- **Log.** `lister resolve_keys` only when the answer changes (`types` = id types of the found,
  `via` = id/lossy/fp/none counts, `same` = identical answers since), one `lister resolve_fail` per
  failure shape (`ok`, `idType`, `numType`, `id` cut to 40, `nType`, `row`, `why`, `n`, a sample
  `key`); page `lister resolve` with `via`, `backedOff`, `retry`; `desk list_click` with `noId`,
  `noIdBlocked`, `noIdTotal`; `lister job_left_out why=noid`.

## My listings (2026-10-19)

The desk's second view (tabs under the title: Sell from storage | My listings): the player's own
listings, how stale each is, and a reprice (take off, then list again at a new price). Job mode
`unlist`, caps `unlist`, result status `unlisted`, step `unconfirm`, skip kind `notlisted`:
`docs/DESIGN-reprice.md`.
