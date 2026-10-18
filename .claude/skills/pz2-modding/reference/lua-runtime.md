# Lua runtime

## Entry point and boot

- `Database.Main.InitContentToCall` calls `tryrequire("Database." .. sPackName .. "LuaDatabase")`
  for **every content pack**. That is the mod entry point. `Game.BaseGame` also loads
  `Databases.<PackName>`. These are the same hooks ACSE uses on PZ1/PC2. **proven**
- Code at module load runs **inside `require`, so it can't yield**. **proven**
- `AddContentToCall` (in the database module) runs on the startup coroutine, which **can yield**.
  Do waits there, e.g. for the overlay and probe. **proven**
- Modules use `local X = module(...)`. Grab globals once at the top
  (`local global = _G; local api = global.api; local pcall = global.pcall` ...). **proven**

## Patching game modules

- Wrap `global.require` / `tryrequire` and patch modules when they first load: PZ2QoL's
  `Core:AddModulePatch("UI.Controllers.HUDUI", fn)`. Module names are case-insensitive;
  keep the patches keyed by lower-case name. **proven**
- Patch by replacing a table function and **calling the original**. Use `pcall` around anything
  of the mod's own.
- Patched so far, all **proven**:
  - `UI.Controllers.FrontEndUI.Init`/`Shutdown`
  - `UI.Controllers.HUDUI.Init`/`Shutdown`
  - `StartScreenHUD.Activate`
  - `Game.GameScript.OnPrepareToShutdown`
  - `StartScreen.Globe.AnimalStorageHubMode.TransitionIn`/`TransitionOut`/`Advance` (offline-tested;
    PZ2QoL MarketPeek). Hub modes are `Object.subclass` classes, so patching the module table
    reaches every instance. `Advance` runs every frame while the mode is active.
- **Modes can miss the require hook.** `GameHelpers.ModeHelper` (engine Lua, loaded before the
  mod) takes `local require = global.require` at load and requires every mode of a world in
  `SetModes(tModes = {sModeName = sModuleName}, sInitialMode)`. Edit modes such as
  `"AnimalMovementMode"` → `Editors.Animal.AnimalMovementEditMode` come through a second ModeHelper
  (`BaseEditMode.SetNewMode`). PZ2QoL Core wraps `ModeHelper.SetModes`: it requires the modes
  through the hooked require, then runs `Core:ApplyLoadedPatches()` (patches anything in
  `package.loaded` that has pending patches), then the original. **offline** (decompiled, Lua
  test 13); in-game trace `guard_move_patched` not yet seen.
- `Editors.Shared.BaseUIMode.SetNewMode(sMode, tParams)` is a plain module function every in-park
  mode change goes through (`RequestNewModeWithCallback` → `ModeHelperComponent:OnModeEvent`); callers
  look it up as `BaseUIMode.SetNewMode` each time, so wrapping the module field intercepts them.
  PZ2QoL StorageSend wraps it (`send_patched`). **offline**
- `PZ2QoL.Guards` holds fail-soft wraps of vanilla functions that crash: currently
  `AnimalMovementEditMode.SetupAnimalMovementContext` (see `debugging.md`).

## Threads

- Game Lua runs on **several threads**: `Main` and `fTask Wn` workers. Consecutive checkpoints in
  one boot show different thread ids. Keep this in mind for crash attribution. **proven**

## Available libraries

- **There is no `io` library.** **offline**
- **File access: `api.debug.ReadStringFromFile(path)` -> `bOk, sText` and
  `api.debug.WriteStringToFile(sText, path[, bAppend])` -> `bOk`.** **offline** (the game's own
  dev tools use them: scenario editor, camera paths, blueprint debug save). Both names are in the
  retail exe's strings (1.0.4), so they are registered there; not yet proven that they do
  anything in retail (a release stub is possible) or which folder relative paths start from. **Proven 2026-10-16: plain OS paths (`.\Win64\...`, `Win64/...`) do not work** (`store_unavailable`,
  no file written). The game's own calls use virtual paths: `/run/` = the install folder (retail
  reads `/run/Blueprints/WildArea/ReleaseBox.blueprint`), `/tmp/`, `/dbg/`; `CommandLineLib.ToVfsPath`
  converts. PZ2QoL's store tries `/run/Win64/ovldata/PZ2QoL/userdata.json` first, then the OS forms
  and `/tmp/PZ2QoL_userdata.json`, verifies by reading back, and marks `store_p<N>_found|created|err|false|diff`
  per try and `store_found` / `store_created` / `store_unavailable` in the debug trace. Only ASCII JSON objects
  are written (the UI escapes non-ASCII as `\uXXXX`).
  **Proven 2026-10-16 (Y, two loads): `WriteStringToFile` returns `false` for every form, `/run/`
  and `/tmp/` included (`store_p1..p4_false`), and no file appears in the install, the profile or
  Temp. Treat both calls as retail stubs: a mod cannot keep files.** Every game caller is a debug
  manager (camera debug, scenario editor, blueprint debug save). Writable VFS mounts named in the
  exe strings, untried and probably stubbed the same way: `/usr/save/<id>/` (Saved Games/Frontier
  Developments/Planet Zoo 2/<steamid>), `/usr/data/Config_Local/` (AppData/Local/...), `/usr/docs/`.
- **Park save** (**offline**): `api.world.GetWorldAPIs().worldserialisation:RegisterWorldSerialisationClient(sName,
  nVersion, fnSave(tSave), fnLoad(tLoad, nVersion) -> true, fnCanLoadOldVersion(n))` in a park
  manager's `Init`, then `UnregisterWorldSerialisationClient(sName)` in `Shutdown`
  (`managers.guestcounthistorymanager.lua`). fnSave fills the table when the game saves. Untested:
  what loading such a save does once the mod is removed (the exe has no message for unknown
  clients), and what it does to Franchise zoos. PZ2QoL wrote habitat assignments there for a few
  debug builds on 2026-10-16 (client `PZ2QoL` v1, `tSave.sData`, offline parks only). **Since the
  player store (below) it only reads:** the client is still registered in offline parks
  (`Kin._RegisterReader`, HeatMapManager.Init hook) so those saves load as before; its fnSave writes
  nothing, and fnLoad moves `sData` into the player store if that zoo has no entry yet (marks
  `store_park_on`, `store_world_loaded`, `assign_store_migrated`).
- **A device-local store that also works in Franchise: the player save** (**PROVEN** in game 2026-10-16, Franchise: run 1 written in one session was read back after a
  restart, and the `PZ2QoL` entry with a 12 KB string is in `Saves\player`). **PZ2QoL's habitat
  assignments live here in every zoo** (`pz2qol.playerstore.lua`, used by `Kin.StoreLoad/StoreSave`):
  - **Store:** `GameMain/database.mainplayer.lua:45-51` gives `tPlayer:GetData(key...)` and
    `tPlayer:SetData(value, key...)` on `tPlayer.tData`. The whole table is saved and loaded back
    as-is (`:77-88`), so unknown keys survive.
  - **Player:** `GameDatabase.GetPlayer(GameDatabase.GetPlayerKey(api.player.GetGameOwner()))`.
  - **Save and file:** saved with `api.save.RequestSaveMainPlayer()` (also on every park close) to
    `Saves\player`, a zip-like file with one `gamedata` entry.
  - **Franchise data already lives there:** the game keys it by planet hub GUID, e.g. online
    favourite listings and pending release groups.
  - **Not sent to Frontier:** strong evidence, not proven. No upload path in the exe, and server
    data uses separate pending-update calls. Steam Cloud syncs the file between the player's PCs.
  - **Limits for a mod:** ASCII strings only, small chunks, a total cap, `pcall` everywhere. It
    also holds the EULA flag and career data (developer-approved, rule 2).
  - **`GetData` path pitfall:** `FindData` indexes each level, so a path through a non-table value
    raises an error; `SetData` creates missing levels. `SetData(nil, ...)` removes a key. **offline**
  - **PZ2QoL layout:** `tData.PZ2QoL.Assign[<zoo key>] = { S = "<write seq>", N = "<parts>",
    P1..Pn = <= 4000-char strings }` holding the UI's ASCII JSON (keys: `kinAssign` habitat
    assignments, `kinRatio` the breeding programme's make-up per species). Total cap 64 KB over all zoos:
    the zoos written longest ago are dropped first; one zoo over the cap is refused (Kin also caps
    one zoo at 60 KB). `""`/`"{}"` removes the zoo's entry.
  - **Zoo key** (`Kin._ZooKey`): Franchise `f_<GetPlanetHubGuid>_<GetCurrentZooGUID>` (both on the
    park's `tWorldAPIs.franchise`; `GetCurrentZooGUID()` is nil outside Franchise, which the game's
    own `exhibitanimalinfopopup` uses as its Franchise test, **offline**); any other park
    `o_<hub GUID>_<name letters>_<djb2 hash of the name>`, so same-named parks share and a rename
    starts afresh. Only `[A-Za-z0-9_-]`.
  - **When:** the key is worked out on the park tick (not at manager Init: the save, and so the
    park name, is loaded by the first Advance), retried once a second. A Franchise zoo without its
    GUID yet, or an unknown mode (< 10 s), answers `wait`; no player profile for 20 s answers
    `noplayer` (mark `assign_store_unavailable`). Once known: `assign_store_franchise|offline`, then
    `assign_store_loaded|empty`, and `PZ2QoL_StoreReset` makes the views read again.
  - **Saving:** `SetData` at once (`assign_store_written`); `RequestSaveMainPlayer` 4 s after the
    last change (30 s at most; `assign_store_saved`), never per click. On park end nothing is
    requested: the game saves the player itself when a park closes.
  - **Cleanup:** the 2026-10-16 debug probe left `PZ2QoL.Probe` and a 12 KB `PZ2QoL.Big`;
    `PlayerStore:Cleanup()` removes both once per session (from the hub's view attach and before
    any read/write; `assign_store_cleaned`) and requests a save.
  - **Cross-module lookup pitfall (proven):** in game `package.loaded["pz2qol.playerprobe"]` was nil
    from Hub although the module had loaded (works in the tests). Register a module on Core in its
    `Init` (`Core.PlayerStore = self`) and look it up there; package.loaded only as a fallback.
  - **Not yet seen in game:** the key and load marks in a Franchise zoo and an offline park, the
    cleanup, and assignments surviving a restart through this store.
- `api.xmlconfig` has no general get/set (`ResetAll`/`SaveAll`/`ResetSaveConfigs` only). The VFS
  paths `/usr/save`, `/usr/data`, `/usr/docs` are reachable only through the stubbed debug file
  calls.
- **`package.loadlib` works from game Lua.** **proven**: the trace DLLs load.
  - With `"*"` it only loads the DLL, so `DllMain` runs.
  - With a function name it returns that export as a C function. That export must not use the Lua
    C API, because the exe exports no `lua_*` symbols.
- `api.debug.Trace` output isn't visible in the Final build. **guess**: nothing found yet.

## `api.*` namespaces in use

| API | Use |
|---|---|
| `api.ui2.LoadOverlay(name, path)` / `IsOverlayLoaded` / `MapResources(name)` | Load the mod's UI overlay. **proven** |
| `api.ui2.UnmapResources(name)` / `AreResourcesUnmapped` / `UnloadOverlay` | The game does these for its own overlays in `GameScript.OnPrepareToShutdown`; mods should mirror them. **offline** |
| `api.ui2.GetDataStoreContext(name, ...)` / `DeleteDataStoreContext` | Lua side of the DataStore. `GetDataStoreContext` takes a path of names or (parentCtx, name) and **creates missing contexts**; `GetNoCreateDataStoreContext` does not and returns nil for a missing one; it takes `(parentCtx, name)` (`genealogypopup.lua:929`) or a string path (`windows.mainhud.lua:1109`). **offline** |
| `api.ui2.GetDataStoreElement(ctx, sProp)` / `GetDataStoreContextAsTable(ctx)` | Read native-written DataStore values from Lua: one property, or a context as a table (children by key, each a table of its fields; game Lua iterates `conservationProjects` and research rewards this way). `GetDataStoreContextElementIDs` lists property names, not children. **offline** (used by game Lua; PZ2QoL's Market desk engine reads the storage list, selection and limits this way, not yet seen in game) |
| `api.messaging.RegisterGlobalReceiver(api.messaging.MsgType_DatabaseErrorMessage, fn)` | Franchise server errors: messages `{nError, nRequestType}`. **proven** |
| `api.world.GetWorldAPIs().franchise` | Franchise API. Resolving the `DatabaseError_*` enum names from it **did not work in game** (logged as `code N`). From the open Animal Storage mode's `tWorldAPIs.franchise` the names **do resolve** (PZ2QoL 1.2.1: `Unknown`, `NotAllowed` seen). **proven** |
| `franchise:IsDatabaseOperationInProgress()` | `(bBusy, nRequestType)`: a franchise request is still running. The game's own screens poll it before sending more. **offline** |
| `franchise:RequestsInProgress()` | Any franchise request in flight (a method call); the world waits on it before unloading (`worlds.darwinworld.lua:703`). **offline** |
| `api.planetHub.StorageUIStartAnimalAuction(key, nPrice, nHours)` / `StorageGetIDAndAIDType(key)` | List a storage animal; a row key → `(GUID, 2)`. See `game-data-and-events.md` "Listing a storage animal". **offline** |
| `api.planetHub.StorageUISelectItem(id)` / `StorageUISetItemMultiSelected(id, b)` / `StorageUISelectAllItems` / `StorageUIClearSelectedItems` | What the storage UI events call. **offline** |
| `api.planetHub.MarketUI*` | Market list filters, requests and display slot; see `game-data-and-events.md` "Market data". **offline** |
| `api.debug.Error` / `api.debug.Assert` | Can be wrapped to surface errors (PZ2QoL Errors module). **proven** |
| `api.time.GetPerformanceTimer` / `PerformanceTimeToMilliseconds` | Timing. **proven** |

## Views (UI controllers)

- `ViewWrapper.Init(oUI, tInitSettings)`:
  - `tInitSettings.sViewAddress` is the page URL, e.g. `coui://UIGameface/Frontend.html`;
  - `tInitSettings.fnOnReadyCallback` runs when the page is ready.
  - **Redirect a view by rewriting `sViewAddress` before calling the original Init.** **proven**
- `oUI:AddEventListener(sEvent, nArgCount, fnCallback, callbackArg)` registers a JS→Lua event.
  - The callback is called as **`fnCallback(callbackArg, eventArgs...)`**; game code always passes
    `self` as `callbackArg`.
  - **Register it from the view's ready callback** (`fnOnReadyCallback`, i.e. after the view is
    "ready for bindings"). Registering right after `Init` returned without error, but no event ever
    arrived. **proven** both ways: no `js_*` lines before, and `trace_listener_ok` plus `js_*`
    lines after the fix (second PC, 2026-10-15).
- `oUI:TriggerEventAtNextAdvance(sEvent, ...)` sends a Lua→JS event. **proven**
  - It arrives **a frame or more later**. In a request/answer protocol, a late answer to the
    previous request can reach the next request's waiter. The 2026-10-15 multi-species check broke
    this way: the next species started 70 ms after the last one released, took the stale `done` as
    its answer, failed, and left Lua holding the market (blocking two more species as `busy`).
    Wait for the release's own answer and ignore states a wait isn't for. **proven** (Y: trace;
    reproduced in the harness).
- **Never create or destroy views inside a ready callback.** That deadlocked the game (the probe
  view was destroyed there). Do it on the startup coroutine instead. **proven**

## UI overlay lifecycle (what works)

1. In `AddContentToCall`, load the overlay with `LoadOverlay`, yield until `IsOverlayLoaded`, then
   `MapResources`.
2. Create a hidden **probe** view (`<Pack>/probe.html`) and yield until it reports ready. Only then
   redirect real views. If anything fails, leave the vanilla views alone.
3. Shut the probe down on the startup coroutine (`WaitUntilReady`).
4. On exit, `UnmapResources`, wait for `AreResourcesUnmapped`, then `UnloadOverlay`, before the
   game's own `OnPrepareToShutdown`. Added because of crashes during world deactivation.
   **proven**: `overlay_unload_begin` and `overlay_unloaded` logged on exit, no crash (second PC,
   2026-10-15).

## A frame hook in the park (Kin)

- `Managers.HeatMapManager` is a park manager whose `Advance` runs every frame (it ray-casts for the
  heat map). Patching the module's `Advance` (and `Init` / `Shutdown`) gives the mod a per-frame tick
  in parks and the manager instance (`ClaimViewModeRequest`, `SetCategory`, `Hide`). PZ2QoL Kin runs
  its scan a few dozen animals per frame there, and falls back to one synchronous pass if no tick
  arrived in the last second. **offline** (Lua tests); not in the hub.
- `TriggerEventAtNextAdvance` also carries Lua tables (the game sends `Fanfare_SetData*(_tData)`).
  Kin still sends JSON **strings**, ASCII-only (non-ASCII as `\uXXXX`), in ~12 KB chunks
  (`PZ2QoL_KinChunk(seq, i, n, text)`), so no single event is large and a cut never splits a UTF-8
  character. **offline**
- Game Lua has `utf8` and the 5.3 bitwise operators. **guess** (standard 5.3; used with a `pcall`
  fallback).
- **Park managers bypass the require hook.** `Environment._LoadManagerModule` (GameMain
  `environment.environment.lua`) loads managers with a `require` copy it took before the mod booted,
  and `_ConstructPhaseFunctionList` caches each manager's phase methods (`Advance` ...) when the
  manager is created. A patch registered with `AddModulePatch` therefore never reached
  `Managers.HeatMapManager` in game. **proven** (2026-10-15: Kin said "no park" in a park). Core
  now patches `Environment._LoadManagerModule` and applies module patches as each manager loads,
  before its instance exists (trace `manager_patched_<name>`, `kin_first_tick`).

