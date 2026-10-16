# Game data contexts, events and enums (game 1.0.4)

The mod's JS copies are in `mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/game.js`. Check the game's
`js/project/data/Schemas/*Schema.js` for field names; each `Prop` has an id and a sample
`generator_value`.

## DataStore contexts

| Context | Contents |
|---|---|
| `['hubAnimalsData','animalMarketData','list']` | Market listings (paged by the game) |
| `['hubAnimalsData','animalStorageData','list']` | Animal Storage rows (not paged) |
| `['hubAnimalsData','animalStorageData']` → `selectedAnimalIDs` | Current storage selection |
| `['hubAnimalsData','animalStorageData','actions']` | `tradeAllowed`, `tradeDisallowedReason` for the selection |
| `['hubAnimalsData','animalHistoryData','list']` | Trade history |
| `['hubAnimalsData','species']` | Species ids for market filters |
| `['animalTradeListingData']` | Listing limits for the selected animal (below) |
| `['management','animals','animals','list']` | Zoo management Animals tab rows |

Storage list keys (`animal_12`) are **positions, not identities**. When an animal sells, or the
list is re-sorted or rebuilt, the same key can point at another animal. `selectedAnimalIDs` holds
these keys, and `AnimalStorage_AddToMarket` (→ `StorageUIStartAnimalAuction(key, price, hours)`)
lists whatever the key points at **when the game handles it**. Anything that runs over time must
remember animals by row `id` plus a content fingerprint, and look the key up again right before
each event. **proven**: 2026-10-15 Y: trace shows a run skipping "already on the market" rows it
never listed, right after sales. The harness swap test listed an unselected animal under the old
code. PZ2QoL: `findTarget()` in `lister.js`.

Zoo animal rows:
- Genes are at `geneticsTooltip.list.<Size|Longevity|Fertility|Immunity>.value` (0..1).
- `location` is a localisation literal, `[STRING_LITERAL:Value=|Savannah Habitat|]`; parse the
  text between the pipes. **proven** in harness, from game schema.
- Storage and market rows carry `auctionTimerSeconds`. The game's own test for "on the market" is
  **`auctionTimerSeconds > 0`** (`MarketAnimalListItem.isOnMarket`). The schema default is `-1`
  (never listed); `<= 0` with a price means an expired listing. PZ2QoL's `isOnMarket()` in
  `scores.js` uses the same test. **offline**

- **Market and Trade History row `id`s are screen slots**, not listing ids: the same ~12 ids are
  reused on every page. Never key anything persistent by them. PZ2QoL keys the price book by
  content (`listingKey()` in `pricing.js`: species, name, sex, maturity, shoal/exhibit, genes,
  price, currency). Anything that sends a market row id to the game must happen while that page is
  on screen. **reported** (Nexus bug #1151539, 3xz1), consistent with the schema (`id` is a
  generated string, no listing GUID). Market rows also carry `name`, `age`, `auctionSource`.
  Storage row ids are real animal ids (storage isn't paged).

## Listing limits (`animalTradeListingData`)

- `tradePriceDefault`, `tradePriceMin`, `tradePriceMax`.
- `tradeDurationDefault`, `tradeDurationMin`, `tradeDurationMax`: **integer hours**.
  - The game's slider uses step 1. In game the default is **6 h** and the maximum **12 h**.
  - PZ2QoL lists at the maximum. **offline** (UI code), in-game values reported by the user.

## UI → game events (`engine.trigger`)

| Event | Args | Effect |
|---|---|---|
| `AnimalStorage_ItemSelected` | id | `StorageUISelectItem`: **focuses one animal** (like clicking a row) |
| `AnimalStorage_ItemCheckboxToggled` | id, bool | multi-select tick |
| `AnimalStorage_SelectAllToggled` | bool | select all / clear |
| `AnimalStorage_AddToMarket` | key, price, hours | list the selected animal |
| `AnimalStorage_Compare` | id | opens Compare Mates |
| `SetAnimalMarketScreen` | 0 market / 1 storage | switch hub tab. **Debug player only:** `AnimalMarketModule` registers it only when `isCoherentPlayer()`, so in game it does nothing. **proven** (it broke PZ2QoL's old "Check market prices"; the harness runs detached, where it works) |
| `AnimalMarketAndStorage_Open_<gameEventID>` | – | what the tab bar sends to Lua to switch the hub mode (market ↔ storage). Sending it without changing the JS tab desyncs the screen. **offline** |
| `Management_SetManagementIndex` | ManagementSectionID | open a management screen (Animals = 7) |
| `Management_SelectAllCheckboxToggled` | `'selectAllAnimals'`, bool | zoo select all |
| `Management_ItemCheckboxToggled` | id, bool | zoo multi-select tick |
| `World_ShowHUD` / `World_ShowHUB` / `World_ShowFrontend` | – | the game's own debug actions; useful in the harness |

Storage-mode Lua handlers: `startscreen.globe.animalstoragehubmode.lua` (`OnItemSelected`,
`OnItemCheckboxToggled`, `OnSelectAllToggled`, ...). Animal Storage always creates a
`CompareMatesPopup`, so finding it on a Lua stack only means "in storage".

## Franchise server errors

- They arrive as `MsgType_DatabaseErrorMessage`, a list of `{nError, nRequestType}`. **proven**
- Request types seen in game (2026-10-15, no names resolve, see `lua-runtime.md`):
  - **42 = the storage listing request** (`AnimalStorage_AddToMarket` → `StorageUIStartAnimalAuction`).
    Errors arrive 0.25–0.6 s after the request, as fast as a success.
  - 28 fails with code 5 every few minutes on its own (background traffic, harmless).
  - 24 failed once with code 13.
- Codes seen for request 42:
  - **255**: refuses a listing now and then (about 1 in 10 during runs). The game survives it.
  - **5: the game crashes.** It hit its own fatal error (0xFDEAD, fTask thread, no mod code on the
    stack) 0.24 s and 0.5 s after the answer, both times (19:42 and 19:50). This is the game's
    own handling of the reply (vanilla), but the lister triggered it. Both times a 255 had come
    within the previous 5 s of the same run, and one request was sent 0.5 s after that 255.
    **proven** (2 of 2). The cause of code 5 is unknown (a rate limit or a refused state?).
- Since PZ2QoL looks the enum names up on the open storage mode's `tWorldAPIs.franchise`
  (2026-10-15 20:13), names resolve. Request 42 has since been refused with `Unknown` and with
  `NotAllowed`, and neither crashed. Which numbers these are is still unknown; the debug trace now
  spells out the raw code after the name (`srv_code`).
- Rule for automation: after any unnamed code on a listing, stop the run. Pause after every
  request, even a refused one, and wait until `franchise:IsDatabaseOperationInProgress()` is
  false before sending the next.
- `franchise:IsDatabaseOperationInProgress()` returns `(bBusy, nRequestType)`. The game's own
  franchise screens poll it before sending requests. Reach it from Animal Storage as
  `oStorageMode.tWorldAPIs.franchise`. **offline**: used by the game; PZ2QoL's use is not yet
  proven in game.
- `DatabaseError_*` codes: Ok, Unknown, DidNotGetResponse, CouldNotParseResponse,
  InternalServerError, MaintainanceMode (sic), NotAllowed, NotAuthorised, NotEnoughCC,
  NotImplemented, PlayerBanned, ProfanityFilter, UnprocessableContent. **offline**: order and
  numeric values unconfirmed.
- The game only reacts to DidNotGetResponse and NotAuthorised. Everything else is dropped unless the
  hub mode handles it, which leaves spinners running forever. **proven**
- The PZ2QoL lister (1.2.1):
  - Stops on: NotAuthorised, Maintenance, PlayerBanned, NotEnoughCC, CouldNotParseResponse,
    InternalServerError, and any unnamed `code N`.
  - On DidNotGetResponse or no answer, waits for a late confirmation, then skips.
  - Ignores errors for other request types.
  - Skips other named rejections; stops after 3 in a row.

## Market data (native `AnimalMarketUIDatastoreManager`)

- The hub's market list is filled by native `api.planetHub.MarketUI*` calls, not by the JS page.
  It has one display slot: `MarketUISetDisplayType(AnimalMarketDisplay_None | _Market | _TradeHistory)`.
  The Market hub mode sets `_Market` on TransitionIn and `_None` on TransitionOut. Storage leaves it
  at `_None`. **offline** (decompiled `startscreen.globe.animalmarkethubmode.lua`)
- Filter and request: `MarketUIResetFiltersToDefault`, `MarketUIClearFilterText`,
  `MarketUISetSpeciesFilter({speciesUID})`, `MarketUISetFilterValue(MarketFilterType_Currency, 0)`
  (0 = CC, 1 = cash, 2 = any), `MarketUIApplyFilters`, then `MarketUIRequestData`.
  `MarketUIHasPendingDataRequests()` exists (exe strings). Settings round-trip with
  `MarketUIGetSortFilterSettings` / `MarketUISetSortFilterSettings`. **offline**
- PZ2QoL's background "Check market prices" (`Main/pz2qol.marketpeek.lua`) does this from inside
  Animal Storage (driven by the storage mode's `Advance`), then restores the settings and `_None`.
  The native fills `animalMarketData.list` while the storage mode is active, and the screen
  doesn't change. **proven** (Y: trace 2026-10-15: `js_peek_start → peek_start → peek_ready →
  peek_end → js_peek_done`). Single-page version proven; paging and multi-species are below.
- Paging: `['hubAnimalsData','animalMarketData']` → `pageIndex` (0-based) and `pages`; the page's
  Paginator shows at most 20. `AnimalMarket_ChangePaginator(n)` → Lua `MarketUISetPage(n)` only, with
  no `RequestData` after it. "Next" on the last page sends `RefreshMarketListings` (`MarketUIRequestData`).
  **offline**
- PZ2QoL paging (since 1.2.1): after page 0 is read, the page sends `PZ2QoL_MarketPeekPage(n)` and
  Lua calls `MarketUISetPage(n)` only while the peek is "ready". Pages 1..19, one at a time, waiting
  on `MarketUIHasPendingDataRequests` again. The page then waits until `pageIndex == n` **and** the
  rows' content has changed (row ids are slots), records, and pauses 400 ms. If `pages` is
  unreadable, it continues until a page comes back unchanged. `_Finish` calls `SetPage(0)` before
  restoring the filters. Trace: `peek_page` / `js_peek_page`. **proven** (Y: 2026-10-15 17:04: a
  6-page check, each `SetPage` answered in about 0.55 s, and the DataStore `pageIndex` and rows
  update while storage stays on screen).
- Multi-species ("Refresh prices (N species)", under Sell in the multi-select view): one click checks the selected species in turn, most
  selected first, at least 3.2 s apart (the Lua cooldown is 3 s), with Stop after the current
  species. Listing is blocked while it runs. Trace: `js_peek_all_start` / `js_peek_all_end`.
  First in-game run failed on a stale Lua answer (see `lua-runtime.md`, TriggerEventAtNextAdvance);
  fixed, with the fix **offline**.

## Kin (relatedness) events

| Direction | Event | Args | Effect |
|---|---|---|---|
| JS to Lua | `PZ2QoL_KinScan` | reason | park scan; answered by chunks or `PZ2QoL_KinState` |
| JS to Lua | `PZ2QoL_KinStorage` | storage row ids, comma separated | lineage of stored animals (hub) |
| JS to Lua | `PZ2QoL_KinContracept` | id ('123' or 'x<uid>'), bool | `animals:SetUsingContraceptive` (the management list's own call) |
| JS to Lua | `PZ2QoL_KinLocate` | id | camera `RequestMode("Orbit", {targetEntityID, bLocate})` + info panel |
| JS to Lua | `PZ2QoL_KinHeatmap` | bool | heat map manager InbreedingRisk on / off (fallback; JS uses `ShowHeatmap`) |
| JS to Lua | `PZ2QoL_KinForget` | - | forget what was sent (page reloaded) |
| Lua to JS | `PZ2QoL_KinChunk` | seq, i, n, text | one piece of the JSON snapshot |
| Lua to JS | `PZ2QoL_KinState` | state, detail | `same`, `busy`, `nopark`, `nostorage`, `contracept`, `located`, `failed`, `error` |

Game events Kin listens to (rescan soon after): `ManagementAnimals_ContraceptionToggled(rowId, bool)`
(the Animals list's contraception button; rowId `animal_<entity>`), `InfoPanel_Animal_Contraceptive`,
`CompareMates_UI_ContraceptionToggled`, `Heatmaps_Select(id)` (which heat map is shown).

Species board events:

| Direction | Event | Args | Effect |
|---|---|---|---|
| JS to Lua | `PZ2QoL_KinDestinations` | reqId, animal ids (comma separated) | the habitats the game allows for those animals' species |
| Lua to JS | `PZ2QoL_KinDestinationsResult` | reqId, JSON `{bySpecies:{sp:{habId:{ok,reason}}}, habitats, tradeCentre}` | |
| JS to Lua | `PZ2QoL_KinMove` | reqId, animal id, habitat id or `trade:<id>` | ONE move, the game's own sequence |
| Lua to JS | `PZ2QoL_KinMoveResult` | reqId, ok, detail | |

Snapshot extras: `animals[].lt` (location kind), `animals[].moving` (`bHasTransportJob`), `mode`
(`franchise` / `offline` / `unknown`), `tradeCentre {id, name}`.
