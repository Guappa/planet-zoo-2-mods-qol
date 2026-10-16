# v1 plan: "Zoo Market Tools" (filters, computed figures, error surfacing)

Goal: quality of life on the Franchise hub's Animal Market (trading) and Animal Storage screens,
plus visible errors instead of endless spinners. **No changes to anything the server sees.**
Everything is client-side display, or the game's own filter calls (the same ones the filter menu
sends).

## What the game gives us (from the decompiled Lua and UI)

- Hub screens are Lua modes (`StartScreen.Globe.AnimalMarketHubMode`, `...AnimalStorageHubMode`, ...)
  that relay UI events to native `api.planetHub.MarketUI*` / `StorageUI*`.
- The UI is Coherent Gameface (Preact, ES modules) in `GameMain/Content/UserInterfaceEssentials.ovl`
  (`.ppuipkg`). Data reaches it through DataStore contexts:
  - market list `hubAnimalsData.animalMarketData.list`: **paged by native code, 20 rows per page**.
  - storage list `hubAnimalsData.animalStorageData.list`: **the whole storage** (no paging).
  - each row: `species, name, age, maturity, gender, isAlpha, isPregnant, ratings, appeal,
    auctionPrice, auctionIsConservationCredits, auctionTimerSeconds, storageTag, isShoal, isExhibit`
    and `genetics.{size,longevity,fertility,immunity,geneticDiversity}.value` (0..1).
- Native filters (run over **all** listings, server or client side): gender, age, appeal, the four
  genes min/max, cash or CC price min/max, time remaining, colourmorph, releasable, researched,
  habitat or exhibit, species, biomes, continents, IUCN status, salinity, text. The JS sends them as
  events `AnimalMarket_Filter<Name>` / `AnimalStorage_Filter<Name>`, then `..._FilterMenuConfirm`.
- Server errors arrive as `api.messaging.MsgType_DatabaseErrorMessage` (`{nError, nRequestType}`).
  `StartScreenHUD.ProcessServerErrors` only reacts to DidNotGetResponse/NotAuthorised; **every other
  error is dropped unless the current mode implements `HandleServerError`, and the market and storage
  modes don't.** That is the "spins forever" bug.

## v1 features

### 1. Computed figures (market and storage rows, plus the info panel)
- **Gene score**: the mean of the genes the species has (exhibit and shoal animals skip
  size/immunity, as the game does), 0–100, shown as a coloured pill on each row.
- **Breeder score**: fertility 40% + longevity 30% + immunity 30%.
- **Market value**: gene score per 1,000 cash or per 100 CC. The best value on the page gets a badge.
- **Storage summary bar**: animals per sex, average gene score, number of adult breeding pairs.

### 2. Market quick presets (use the native filters, so they cover all pages)
Chips above the list:
- "Top genes": all four ≥ 80
- "Breeders": fertility ≥ 75, longevity ≥ 60, immunity ≥ 60
- "Ending soon": ≤ 1 h
- "Cash only" and "CC only"
- "Clear"

Presets are applied by sending the same events the filter menu sends.

### 3. Storage power filters (client side; complete because storage isn't paged)
- minimum gene score slider
- toggles: pregnant, alpha, adults only, juveniles only
- **surplus**: species where you hold more than N animals of one sex; shows trade or cull candidates, weakest first
- **breeding pairs**: species that have both an adult male and an adult female
- sort by gene score or breeder score

### 4. Error surfacing
- Lua: a global receiver for `MsgType_DatabaseErrorMessage` that maps `nError`/`nRequestType` to
  names and shows a non-blocking banner, e.g. "Server error: NotEnoughCC (request 12)".
- Lua: wrap `coroutine.resume` so Lua errors inside hub modes are caught and shown with a traceback
  instead of disappearing.
- Watchdog: if a hub list stays loading (`MarketUIHasPendingDataRequests()` or a loading flag) for
  more than 20 s, show "Still waiting for the server (20 s)…" with the last errors seen.
- Everything also goes to an in-memory log, viewable from the banner.

## Architecture (as built)
- Content pack `PZ2QoL`: `Manifest.xml`, `Main.ovl` (plaintext Lua), and `UI/PZ2QoLUI.ovl` (a
  `.ppuipkg` UI overlay that adds new files only).
- Lua entry: `Database.PZ2QoLLuaDatabase`.
  - At load (inside `require`, so it cannot yield) it installs the `require` hook, the error
    capture and `LoadOverlay`.
  - In `AddContentToCall`, which runs on the game's startup coroutine, it waits a bounded time for
    the overlay to map and the hidden probe page to report ready.
- UI injection: `FrontEndUI.Init` is patched so the hub's view loads `PZ2QoLFrontend.html` (the
  game's `Frontend.js` plus our `main.js`), but only after the probe proves the overlay serves
  files. Otherwise the vanilla page loads.
- The JS shares the game's module instances:
  - `DataStoreCollection.prototype.source` is patched for the storage list context, which gives
    the filters and sort.
  - `engine.trigger` is wrapped to make "select all" safe while filtering.
  - `preact.options.afterUpdate` and an interval add badges to row DOM.
  - Toolbars and the banner are plain DOM under `<body>`, outside the game's preact tree.
- Lua → JS: `ViewWrapper:TriggerEventAtNextAdvance("PZ2QoL_Error", source, title, detail)`.
  JS → game: the game's own `AnimalMarket_*` / `AnimalStorage_*` events.
- Fail safe: every hook is wrapped in `pcall` / `try`. If something is missing, the feature turns
  itself off and logs; the game screen keeps working.

## Test plan
1. Unit-test the score math and filters in Node against captured row data.
2. In game (Sandbox hub, then Franchise online): presets, scores, storage filters, banner.
3. Force an error (e.g. buy a CC listing without enough CC) and check the banner shows `NotEnoughCC`.
4. Remove the pack and check the game, saves and player profile still work.
