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

- **`maturity` on storage, market and history rows is `EAnimalMaturity`** (`ManagementDataTypes.js`):
  0 Infant, 1 Young_Adult, 2 Adult, 3 Elderly, 4 Young_Adult_Infertile (sic `Yound_`), 5 Adult_Infertile,
  6 Elderly_Infertile. So a row tells age stage and fertility in one value; there is no separate
  `isInfertile`/`age` number (market/history rows have an `age` loc string only). The storage info
  panel draws all seven (`MarketUtil.js` -> `getMaturityIconFromEnum`, `Icon_AgeDial_*Infertile`).
  The park's Animals list (Lua) maps "infertile **or** contracepted" to 4/5/6
  (`editors.park.animaldatabasetab.lua` `AgeCategory`); storage rows are filled natively, so whether
  4/5/6 really reach storage rows is **offline** (schema type + UI code), not yet seen in game.
- The Franchise market refuses elderly animals that are no longer fertile (developer report,
  2026-10-16; the server's reason text is unknown). In park, the game's own sell flow lists
  `bInfertileSell` (= `bInfertile`) as a sell preventer (`editors.animal.relocateanimalspopup.lua`
  `g_tSellPreventers`). PZ2QoL: storage "Adults" chip cycles to **Fertile adults** (maturity 1-3,
  `isFertileAdult`, `fertileAdults` filter in `scores.js`); the lister skips maturity 6
  (`isInfertileElderly`, skip kind `elderly`) and never sends it.
- **What blocks a sale** (1.0.5, **offline**). Park sell flow (`editors.animal.relocateanimalspopup.lua`
  `g_tSellPreventers`, read from `animals:GetRelocatePreventers(id)`, final word
  `animals:CanSellAnimal(id)`): `bDead`, `bInVetSurgery`, `bBoxed`, `bJuvenileSell`, `bInfertileSell`,
  `bInjured`, `bInfected`, `bPregnant`, `bEscaped`, `bCantBeSold`, `bPendingTransport`. Tooltips:
  `AnimalDatabaseTab.tButtonProblemTooltips` (`[AnimalList_Problem_<X>]`, `_Juvenile_Sell`,
  `_Infertile_Sell`). `bCashSeeded` (bought for cash) blocks **release to wild**, not selling.
  Storage (hub) has no Lua check: Trade (`AnimalStorageInfoPanel`, Franchise only) is enabled by
  native `actions.tradeAllowed` / `tradeDisallowedReason` for the **selection**; the exe holds the
  same `[AnimalList_Problem_*]` keys plus `[AnimalList_SelectionCannotTrade]`. Storage rows carry
  no reason field; what a row shows: `maturity` 0 (juvenile) and 4-6 (infertile), `isPregnant`,
  `auctionTimerSeconds > 0` (listed), `isMoving` (pending transport). Park-only states (dead,
  boxed, vet, injured, sick, escaped) don't apply in storage; `bCantBeSold` has no row field
  (**guess**: conservation/rescue animals, its icon is `Icon_Conservation`). Whether contracepted
  storage animals show as 4/5 is unknown (the park list maps contraception there; the park sell
  check only names `bInfertileSell`). PZ2QoL: `sellBlockers()`/`isSellable()` in `scores.js`,
  storage chip **Sellable / Not sellable** (filter `sellable: 'any'|'yes'|'no'`, `bars.js`).
- **Market and Trade History row `id`s are screen slots**, not listing ids: the same ~12 ids are
  reused on every page. Never key anything persistent by them. PZ2QoL keys the price book by
  content (`listingKey()` in `pricing.js`: species, name, sex, maturity, shoal/exhibit, genes,
  price, currency). Anything that sends a market row id to the game must happen while that page is
  on screen. **reported** (Nexus bug #1151539, 3xz1), consistent with the schema (`id` is a
  generated string, no listing GUID). Market rows also carry `name`, `age`, `auctionSource`.
  Storage rows are not paged, but their `id` is the same `animal_<n>` string as the list key (the
  retail UI uses `selectedAnimalIDs` entries as list keys), so it is a position too, not an animal
  identity. The stable identity is the GUID from `api.planetHub.StorageGetIDAndAIDType(key)` →
  `(GUID, 2)`. **offline** (corrected 2026-10-17; the old "row ids are real animal ids" was wrong).
  **Doubt, in game 2026-10-17 (Y:):** with the engine selecting by the row key
  (`StorageUISelectItem(key)`), the page saw *another* key selected (`lister_page_sel_other`), while
  the old page lister, which selected by the row's `id` field (`AnimalStorage_ItemSelected`, row
  `id`) and listed by the key, worked. So the row `id` probably differs from the key in game, and
  the per-animal natives (`StorageUISelectItem`, `StorageGetIDAndAIDType`, as Kin uses it) take the
  id while `selectedAnimalIDs` and the listing call take the key.
  **Proven 2026-10-17 19:50 (Y:):** `lister_id_differs` fired: the row `id` field is not the list key.
  `StorageGetIDAndAIDType` takes the **key** (by id it found nothing: every animal unidentified,
  "Nothing to list"; by key the earlier runs got GUIDs). So: select with `StorageUISelectItem(row id)`,
  resolve GUIDs and list with the key (`nativeId()` in `pz2qol.lister.lua` is used for the select only).
  Whether Kin's `StorageGetIDAndAIDType(row id)` lookups find anything is open.
- `StorageGetIDAndAIDType(key)` returns `(id, type)` with the `CompareMatesUIUtils` types: 0 entity id,
  1 listing id, **2 GUID** (most storage animals), 3 exhibit animal entity id, **4 exhibit animal GUID**,
  5 exhibit listing UID, 6 exchange id, 7 markets GUID. Requiring type 2 left some animals
  unidentified in game ("Nothing to list", 3 of 8 runs, Y: 2026-10-17 20:20). The engine now keys
  other types as `t<type>_<id>` (trace `lister_idtype_<n>`). Skips are traced by kind
  (`lister_skip_<kind>`). Same run: 36 listed with select-by-row-id; Lua's own selection reads worked
  (`lister_diag_flag_true`, `lister_diag_arr_key`).

### Genetics medal (the market's Rating column)

- Market, Trade History, Rewards and Storage rows all carry **`ratings`**, a `GeneticsRank` string
  (`js/project/data/GameTypes.js`): `'none' | 'bronze' | 'silver' | 'gold'`. Zoo management rows
  carry the same field. **offline** (schema `AnimalMarketAndStorageSchema.js`, `MarketUtil.js`).
- What the game draws from it: the list's **Rating** column (`MarketAnimalListItem`, an
  `AppealIndicator`; **shoals show a dash**), and the info panel's "Rating" block
  (`HabitatAndExhibitInfo`: `Icon_Genetics_<Medal>.svg`, label
  `[InfoPanel_Animal_GeneticsRank_<Medal|Unranked>]`, tooltip `[AnimalExchange_GeneticRating]`).
  The separate `appeal` field (a formatted number) is the Appeal column. The native sort has both
  `ExchangeSortFilterType_GeneticRating` and `ExchangeSortFilterType_Appeal`. **offline**
- Who fills it: the native market/storage datastore managers (no Lua writes `ratings`). Natively it
  is the animal's "appeal state": exe has `animals:GetAppealStateForTradingUI` next to
  `GetAppealStateForInfoPopUpUI` (the park info panel's `geneticsRank`/`medal`). The game presents
  it as a **genetics** rating; how it is derived is native and unknown. **guess**: thresholds on
  the animal's appeal relative to its species (the name "appeal state"), so within a species a
  higher medal means higher appeal.
- **`appeal` is a loc string, not a number.** Schema generator: `separatedInt(n)` =
  `"[SEPERATED_INT_VALUE:Value={n}]"` (500..20000, sic "SEPERATED"); the list draws it with
  `translate()`. The exe also has `"[AnimalList_AppealValue:Value=("`, so the native may send that
  token instead. Storage, market and history rows all carry it; shoals too (`ShoalInfo` shows it).
  Appeal is per species (exe: `GetSpeciesAppealForUI`, `nSpeciesAverageAppeal`), so only compare
  it within a species. **offline** (schema, `MarketAnimalListItem`, exe strings); real in-game
  string format **unverified**.
- PZ2QoL: `readAnimal().medal` / `.appeal` (raw, `game.js`); `medalOf()` (pricing.js, undefined
  for shoals and unknown values) and `appealOf()`/`parseAppeal()` (reads `Value={n}`,
  `Value=(n)` or a plain "12,345"). Both are recorded on price-book listings but **not** in
  `listingKey()` (v2 keys kept; `mergeListings` keeps a known medal/appeal if a later read has
  none). Pricing (`comparables`, `recommendPrice`):
  1. 3+ listings of the same medal: same sex+age group → same age group any sex → species.
  2. Else the narrowest group with 3+ medal listings: same medal plus the nearest other medals,
     prices scaled by `medalRatio()`: observed directly (2+ of each medal, sex+age group →
     species), else chained step by step (each step: groups → median over all species →
     `DEFAULT_MEDAL_VALUE` **guess**: Unranked 0.8, Bronze 1, Silver 1.6, Gold 3). Confidence
     at most medium, at most low when a ratio was guessed; the reason says "No Gold listed among
     adult males; 4 Silver at median 400 CC ×1.88 (guessed ratio)".
  3. Appeal within the medal (`appealAdjustment`, unscaled comparables only): Theil-Sen fit with
     4+, else half the relative difference to their median appeal, factor 0.75..1.33. It replaces
     the gene-score adjustment when the animal's appeal is known.
  4. The game's min/max always win; the reason says when they capped the price.
  Old gene-score tiers only when no listing of the species has a medal. In the harness the
  schema generator gives random medals and appeals.

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
| `AnimalStorage_SendToZoo` | array of selected row keys | `StorageUISetAnimalsToBeSentToZoo(ids, false)`, then `ShowWorldTransition(true)`: the zoo loads at once. **One event for the whole selection** (the info panel's Send to Zoo, enabled by `actions.sendToZooAllowed`). Whether it is a Franchise server request is **unknown** (native). **offline** |
| `AnimalStorage_ReturnToZoo` | array of keys | same call with `true` (the round "return to habitat" button, `actions.returnToAllowed` / `returnToTooltip`): in the park each animal gets `RequestTransportToAssignedHabitat`. **offline** |
| `AnimalStorage_QuickTrade_Cash` / `AnimalStorage_QuickTrade_Credits` / `AnimalStorage_Rehome` (not `_QuickTrade_Rehome`) | array of keys | `StorageUIQuickTradeAnimals` / `StorageUIReleaseAnimalsToWild` / `StorageUIRehomeAnimals`. **offline** |
| `AnimalStorage_Cancel` | `"Trade"` | `StorageUICancelAnimalAuction()`: **no arguments, acts on the selection**. `"Move"` does nothing in Lua. **offline** |
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
- **Code ↔ name, proven from `srv_code` (second PC, 2026-10-15 23:12–23:26):** `Unknown` = **255**
  (6 of 6, request 42), `NotAllowed` = **5** (3 of 3, request 28). So the "code 5" before the two
  19:42/19:50 crashes was `NotAllowed`. `NotAllowed` on request 42 has since come back 20+ times
  with pauses between requests, and none of them crashed. The crash therefore needs more than
  code 5. Both crashes followed a 255 by seconds, and one came after a request sent 0.5 s after
  that 255. Rapid requests after a refusal are the likely trigger.
- Other unnamed pairs seen in the same session, while no mod request was running (vanilla
  background or player actions): 255 on request 49 (16×), 255 on 44 (6×), 5 on 47 (7×), 4 on 32
  and 28. None crashed at the time.
- 2026-10-16 (second PC, a Franchise park): request **31** is refused with code 5 (`NotAllowed`)
  in bursts of 2–4, with or without Kin moves (13 times, once 3 s before a crash). Request **28**
  is refused with `NotAllowed` 0.6–2 s after Kin moves (7 in one minute of a Kin plan, 1.0.5), so
  28 may be the server-side record of an animal move. **guess**: neither name is known.
- Rule for automation (changed 2026-10-16 by the developer): any server error, unnamed codes and
  "fatal" ones like NotEnoughCC included, **skips that animal and the run carries on**. Only the
  player's Stop ends a run. Still pause after every request, even a refused one: the player's
  pace, 1–10 s (default 3 s), the same after an error (the market lister's fixed 8 s after an
  error was removed by the developer on 2026-10-16; "Find a habitat" still pauses 8 s). And still wait until
  `franchise:IsDatabaseOperationInProgress()` is false before sending the next
  (`lister.js`, `pace.js`).
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

## Listing a storage animal: the API under the UI (1.0.5, **offline**, 2026-10-17)

- The storage screen's Trade → Confirm sends `AnimalStorage_AddToMarket(selectedAnimalIDs[0], price,
  hours)` (single selection only, `AnimalStorageInfoPanel.js:393-406`); the hub mode registers it only
  between its TransitionIn and TransitionOut, and the handler is a one-line pass-through
  (`animalstoragehubmode.lua:240-243`): `api.planetHub.StorageUIStartAnimalAuction(key, nPrice,
  nDurationInHours)`. Integer CC price (no currency argument), integer hours. **No Lua check before
  or after** (no busy check, no validation, no refresh).
- Can-trade (`animalStorageData.actions.tradeAllowed` / `tradeDisallowedReason`) and the limits
  (`animalTradeListingData.tradePrice*` / `tradeDuration*`) are written by the native **for the
  selected animal only**; no Lua computes them. Select natively with
  `StorageUIClearSelectedItems()` + `StorageUISelectItem(key)` (local, no server call). Whether the
  native lists the key it is given or the selection is unknown: keep them the same.
- **No success message.** On success the native gives the row `auctionTimerSeconds > 0` and
  `auctionPrice` and clears the selection (the UI's "posted" state waits for that);
  `['hubAnimalsData','network'].connectingAction` goes true then false. Failures: request type 42 in
  `MsgType_DatabaseErrorMessage` (above).
- Busy signals: `franchise:IsDatabaseOperationInProgress()`, `franchise:RequestsInProgress()`, DataStore
  `network.connectingAction` / `network.loadingItems` (while true the list is replaced by a spinner).
- The storage list keeps changing: the native rewrites every listed row's `auctionTimerSeconds`
  about once a second and rebuilds the list (reassigning `animal_<n>` keys) on sales, expiries and
  polls; no Lua drives it. The keys only mean something while Animal Storage is the active hub mode
  (the Rewards mode drives the same native list with `StorageCategory_Rewards`).
- Other storage-wide reads: `GetAdultsOfSpeciesInStorageSplitByGender(sSpecies)` (adult GUIDs, works
  from a park), `animals:GetMarketAnimal{Species,Gender,IsJuvenile,Genes,GeneticGrades}(guid, 2)`.
  Exe-only server endpoints: `/game/market/animal/`, `/game/animal/quick-trade`, `/animal/valuations`.
- **Reading the selection from Lua** (1.0.5, **proven** Y: 2026-10-17): `GetDataStoreElement(
  animalStorageData, "selectedAnimalIDs")` (and the context-as-table fallback) never gave the
  selected key back to Lua while `StorageUISelectItem(key)` visibly selected the row: 5 of 5 animals
  timed out waiting for it. Read the row's own **`selected`** bool instead (`list.<key>.selected`,
  schema prop on every storage row, written by the native to draw the highlight); the array only
  as a fallback. What the array actually holds is still unknown (trace `lister_sel_array_empty` /
  `_ok`). JS reads `selectedAnimalIDs` fine.
- **The row flag failed too** (1.0.5, **proven** Y: 2026-10-17, second run): every animal still
  `lister_unsel_selection`, and no `lister_sel_array_*` mark ever fired, so `list.<key>.selected`
  never read `true` from Lua either, while the screen flickered (the native selection very likely
  happened). Lua's DataStore reads of the selection can't be trusted; whether Lua sees
  `tradeAllowed` / `animalTradeListingData` is unknown. Proven from Lua: `GetDataStoreContextAsTable`
  on the list, `StorageGetIDAndAIDType`, the busy checks. Proven from the page (old `lister.js`):
  `selectedAnimalIDs`, `actions.tradeAllowed`, the `animalTradeListingData` limits.
- **So the page reads for Lua** (PZ2QoL since 2026-10-17, **offline**): while the engine clears,
  selects and sends, it sends the page `PZ2QoL_ListerWatch(req, key)` (a new `req` after the clear
  and again after the select; `("", "")` stops). The page (`listerlua.js`) reads its DataStore every
  100 ms and answers `PZ2QoL_ListerSeen(req, text)`, plain text because the mod's Lua has no JSON
  decoder: `v1|<key>|<selected keys, comma-separated, or ?>|<allowed 1/0/->|<priceMin,priceMax,
  priceDefault,hoursMin,hoursMax,hoursDefault, - for none>|<reason, the rest>` (`listercore.js`
  `readSeen` / `encodeSeen`, Lua `parseSeen`). A report counts only for the current `req` and key
  and while ≤ 0.6 s old; then it is the authority for the selection, tradeAllowed and the limits.
  Lua's own reads are only the fallback when no fresh report exists. Read-only: nothing new goes to
  the game or the server. Trace marks to settle it: `lister_page_seen`, `lister_diag_flag_*`,
  `lister_diag_arr_*`, `lister_diag_allowed_*`, `lister_diag_limits_*` (Lua's own reads at the moment
  the page first shows everything, once per run), `lister_page_sel_key/_other/_empty/_unread`,
  `lister_page_none` (the page's view when an animal times out), `js_lister_watch` / `js_lister_seen`.
- No call returns the trade limits without selecting (exe strings: no storage limit getter), so a
  listing without a selection would send an unchecked price, which the game's UI never does.
- Storage rows carry `storageTag`, the player's tag (`EAnimalStorageTag`: 0 none, 1 Sell, 2 Release,
  3 Move, 4 Keep; `StorageUISetUserStorageTagOnSelectedItems(n)`). **offline** (GameTypes.js)
- PZ2QoL uses this in the **Market desk** engine (`Main/pz2qol.lister.lua`, `docs/DESIGN-market-desk.md`):
  per animal by GUID, it resolves the current key, selects natively, waits for the limits (from the
  page's reports, above), and re-checks key → GUID in the same Lua tick as
  `StorageUIStartAnimalAuction`. In-game check pending (trace `lister_*`).

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
| JS to Lua | `PZ2QoL_KinSpecies` | reqId, species, habitat ids (comma separated) | breeding-programme facts: social range, fertility ages, mating system, conception table, habitat space |
| Lua to JS | `PZ2QoL_KinSpeciesResult` | reqId, JSON | |
| JS to Lua | `PZ2QoL_StoreLoad` | reqId | read this zoo's data (kept in the player save, every zoo) |
| Lua to JS | `PZ2QoL_StoreData` | reqId, ok, part, parts, text | the data in ~12 KB chunks; ok=false: no store yet, text = reason (wait, noplayer, nopark) |
| JS to Lua | `PZ2QoL_StoreSave` | reqId, ASCII JSON object | replaces this zoo's data (max 60 KB; 64 KB over all zoos); the player save is written ~4 s later |
| Lua to JS | `PZ2QoL_StoreSaved` | reqId, ok | |
| Lua to JS | `PZ2QoL_StoreReset` | | a park started or ended, or the zoo's store became known (or unavailable): read the store again |

"Find a habitat" events (`pz2qol.storagesend.lua`, `storagesend.js`; see `animals-and-breeding.md`
"From storage to a habitat"):

| Direction | Event | Args | Effect |
|---|---|---|---|
| JS to Lua (hub) | `PZ2QoL_SendArm` | count, onlineOk | the next Move screen request (≤ count animals, within 10 min) is the mod's |
| JS to Lua (hub) | `PZ2QoL_SendDisarm` | – | sent when the game's own Send to Zoo / Return is pressed |
| Lua to JS (park) | `PZ2QoL_SendArrived` | seq, ids (comma separated), onlineOk | re-sent on `PZ2QoL_SendHello` until `PZ2QoL_SendAck(seq)` |
| JS to Lua | `PZ2QoL_SendFacts` → `PZ2QoL_SendFactsResult` | reqId, id → reqId, JSON | one animal: species, lt, moving, assigned, busy, mode, parentHabs, habitats `[{id,name,ok,reason,reach,crowded,total,same}]` |
| JS to Lua | `PZ2QoL_SendMove` → `PZ2QoL_SendMoveResult` | reqId, id, habitat → reqId, ok, detail | ONE move through `Kin.Move` |

Snapshot extras: `animals[].lt` (location kind), `animals[].moving` (`bHasTransportJob`), `mode`
(`franchise` / `offline` / `unknown`), `tradeCentre {id, name}`.
