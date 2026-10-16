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
- **The only persistence the retail game gives Lua is the park save** (**offline**, no mod uses it
  yet): `api.world.GetWorldAPIs().worldserialisation:RegisterWorldSerialisationClient(sName,
  nVersion, fnSave(tSave), fnLoad(tLoad, nVersion) -> true, fnCanLoadOldVersion(n))` in a park
  manager's `Init`, then `UnregisterWorldSerialisationClient(sName)` in `Shutdown`
  (`managers.guestcounthistorymanager.lua`). fnSave fills the table when the game saves. Untested:
  what loading such a save does once the mod is removed (the exe has no message for unknown
  clients), and what it does to Franchise zoos. PZ2QoL does not use it (the developer decides).
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
| `api.ui2.GetDataStoreContext(name)` / `DeleteDataStoreContext` | Lua side of the DataStore. **offline** |
| `api.messaging.RegisterGlobalReceiver(api.messaging.MsgType_DatabaseErrorMessage, fn)` | Franchise server errors: messages `{nError, nRequestType}`. **proven** |
| `api.world.GetWorldAPIs().franchise` | Franchise API. Resolving the `DatabaseError_*` enum names from it **did not work in game** (logged as `code N`). From the open Animal Storage mode's `tWorldAPIs.franchise` the names **do resolve** (PZ2QoL 1.2.1: `Unknown`, `NotAllowed` seen). **proven** |
| `franchise:IsDatabaseOperationInProgress()` | `(bBusy, nRequestType)`: a franchise request is still running. The game's own screens poll it before sending more. **offline** |
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

