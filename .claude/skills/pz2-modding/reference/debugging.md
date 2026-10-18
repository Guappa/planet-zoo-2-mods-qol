# Debugging and crashes

## Trace DLL breadcrumbs (debug builds)

There is no `io` library and no visible log, so the mod logs by **loading tiny DLLs**. **proven**

- `tools/trace/pz2_trace.c` is built once and copied as `dbg\cp_<name>.dll`, one copy for each name
  in `tools/trace/checkpoints.txt`.
- Two ways to log:
  - `package.loadlib(dir.."cp_<name>.dll", "*")` runs `DllMain`, which appends
    `HH:MM:SS.mmm tid=<thread> cp_<name>.dll` to `dbg\trace.log`. It logs **once per name**
    (`Core:Checkpoint`).
  - **Repeating breadcrumbs** (`Core:Mark`): `package.loadlib(path, "mark")` returns the DLL's
    exported `int mark(void *L)`, and each call appends a line. It never touches the Lua API.
- From JS, `breadcrumb(name)` (errors.js) sends `engine.trigger('PZ2QoL_Trace', name)`, and Lua
  marks `js_<name>`. A heartbeat goes every 10 s, plus filter, select-all and lister steps.
- **A name missing from `checkpoints.txt` is silently not logged.** Add new names there.
- `trace_listener_ok` / `trace_listener_failed` show whether the JS→Lua trace listener registered.
- Server errors are marked as `srv_<Name>`, or as `srv_code_<N>` when the enum name can't be
  resolved.
- The crash reporter creates a 0-byte `.dmp` at game launch and fills it in on a crash, so ignore
  0-byte dumps.

## Lister stalls

- Every lister wait has a timeout: select 5 s, trade allowed 3 s, confirm 30 s. While waiting, the
  status shows `(waiting Ns of Ms)` and marks `js_lister_waiting`.
- Per-animal marks: `js_lister_select` → `selected` → `add` → `confirmed`, or `skip` / `stop`.
- 2026-10-14, second PC: a 33-animal run "never got past the 6th". **Cause found 2026-10-15**:
  Lua delivered server errors to only one mod view (`Hub:GetModUI()`, which prefers the HUD), but
  the lister runs on the hub page. It never saw the error, waited the 30 s confirm timeout, then
  stopped the run. Fix: every ready mod view gets the error; the non-showing ones get a silent
  copy (4th event arg `true`). **proven** by trace (`report_server` 0.3 s after `lister_add`,
  then `lister_waiting`, then `lister_stop` 30 s later); fix **offline**.
- Server timeouts (`DidNotGetResponse`) are a known game issue, and the listing can still go
  through. The lister waits another 8 s, then skips the animal as "unconfirmed" and carries on.
  A missing confirmation also skips instead of stopping (the user asked for this).
- `Core:MarkNumber(prefix, n)` spells a number into the trace (`chr_0..9`, `chr_minus`, `chr_dot`,
  `chr_end`). Unresolved server error codes log `srv_unknown_code` and `srv_request` this way.
- Release builds have no `dbg\`, so every trace is a no-op.
- Reinstalling replaces `dbg\trace.log`, so copy it out before installing.

## Crash dumps

- Location: `%TEMP%\Frontier Developments\Planet Zoo 2\CrashDumps\*.dmp` (about 250–500 KB).
  `crash_reporter.exe` uploads them to Backtrace; its log is `%TEMP%\crash_reporter.exe.log`.
- Summarise with `tools/crashsum.py`, using a Python that has `pip install minidump`. It prints:
  - exception code, faulting thread **name** and module;
  - modules referenced on that thread's stack;
  - `game_running_time` and `world_current_name`/`state`;
  - the mod list and Lua coroutine stacks.
- Each dump embeds:
  - a JSON block (game version, GPU, world, running time);
  - fHeap and GPU memory summaries;
  - "Mod Information";
  - **every Lua coroutine's stack**, which tells you which hub mode or screen was active;
  - F3D adapter status.
  There is **no fatal message text and no heap**.
- **0xFDEAD** is Frontier's deliberate fatal (`RaiseException` in KernelBase). It shows up on
  whichever thread hit the fatal (`Render`, `fTask Wn`, `Main`), so the thread alone doesn't
  identify the cause.
- To work out the cause, line up the dump time (game start + `game_running_time`) with the last
  `trace.log` lines.
- **Lua panics** (`crash_reason: lua_panic`) are uploaded as a JSON report and the `.dmp` is then
  **deleted**. `%TEMP%\crash_reporter.exe.log` keeps the whole report: `lua_error` (file:line and
  message), the Lua stack and the park info. Copy it before the next crash overwrites it.
  **proven** (2026-10-16)
- The crash time is the reporter's `Initialised` line, not the upload time. The reporter shows a
  dialog first and uploads when the player closes it (minutes later). **proven**
- `.\PZ2QoL\Errors.lua(207): field resume` appears in every dump's Lua stacks. That is PZ2QoL's
  `coroutine.resume` wrapper, which every game coroutine goes through, so it does not mean mod
  code crashed. `cp_report_lua` just before a Lua panic is the same wrapper seeing the game's error.
- Game Lua bytecode has its line info stripped, but `luadec -dis` prints each function's
  `Defined at line`. Map a crash line to the function whose start is the last one before it.
  **offline**

## Known crashes (open)

| When | What | Status |
|---|---|---|
| 2026-10-14, second PC, Animal Storage (21:29, 22:41, 22:48, 22:59) | 0xFDEAD on the Render or fTask thread. GPU memory fine (4 of 16 GB). No mod frames on the stack. | **Open.** 22:59 came **4 s after a Franchise server error** (and one 2 min earlier didn't crash). Suspects: the server error itself, or the mod's error toast. The server error code isn't known yet. |
| 2026-10-15, second PC, Animal Storage, lister run (19:42:58, 19:50:33) | 0xFDEAD on fTask W22 / W14, 0.5 s and 0.24 s after the server answered the listing request (type 42) with **code 5**. No mod frames. Trace numbers via `Core:MarkNumber`. | **Cause found:** the game's own handling of that reply (vanilla), triggered by lister requests. Mitigated in 1.2.1: stop at the first unnamed code, pause after every request, and wait for `IsDatabaseOperationInProgress` to be false. The Oct 14 22:59 crash (4 s after a server error) is probably the same. |
| 2026-10-16, second PC, Animal Storage (between 00:14:52.7 and 00:15:01) | Game gone without a Frontier dump (none written after 2026-10-15 21:26). Trace stops mid-heartbeat. The only mod activity in the last 48 min: JS Kin scans every 5–20 s (900+ fine before). Last lister run 23:13, last Kin move 23:26. Vanilla refusals 255 on request 49 at 00:12:50–00:14:04. | **Probably vanilla**, but not proven without a dump. If it repeats, check whether request-49 refusals came just before. |
| 2026-10-16 03:07:54, second PC, Franchise park, 1.0.4 (dump `3af65885…`) | Access violation (0xc0000005) in PlanetZoo2.exe on fTask W8, 37 min in. No mod frames. 3 s after the server refused request 31 with code 5 (`NotAllowed`), the third refusal in 18 s. The last Kin move was 24 s earlier. Request 31 is also refused with no Kin moves at all (02:43, 02:51, 10:10). | **Probably vanilla** (the game's handling of the refusal, like the 10-15 crashes), not proven. |
| 2026-10-16 10:40:59, second PC, Franchise park "Save the Euro", **1.0.5** | Lua panic: `ModeHelper.lua:77: Error running mode Select: AnimalMovementEditMode.lua:1158: table index is nil`. In 1.0.4 bytecode, line 1158 falls in `SetupAnimalMovementContext`, where `tSpeciesCounts[GetSpeciesFromGUID(guid)]` gets a nil species for a selected animal. PZ2QoL never opens that mode: the player did, with the game's own Move. 81 Kin moves in that session, the last 45 s before. | **Vanilla code**, no nil check. The likely trigger is a stale selection: an animal the game's UI still had selected, moved or sent away just before. The Kin moves may make that likelier. The 1.0.5 bytecode of this file is byte-identical to 1.0.4, so the mapping holds. **Guarded** by PZ2QoL.Guards: if a selected GUID has no species, it sets `bFailedToVerify` (the game's own path: "Move failed", leave the mode) and reports "Move cancelled to prevent a crash". Every species use in the mode is gated by that flag. Trace `guard_move_patched` / `guard_move_stale`. **offline** (Lua test 13). |
| 2026-10-17 04:34:33 and 04:45:04, second PC, Franchise, **1.0.5** (dumps `d09a7218…`, `f854f941…`) | 0xFDEAD on fTask W15 / W12 while `startscreenglobe` is `activating`, Lua stack in `SaveAgent._ReturnToStartScreenNow` (**exit to main menu**, which in Franchise first saves the zoo: `SaveFranchiseZooNowWithoutMessage`). Both times the same sequence: park opened, the mod's autosave **Save now** about 10 s later, exit with save about 10 s after that, crash 1.5–2 s after the save (0.1 s after the post-`UnsetAutosave` `RequestSave`). No `report_*` marks (no Lua error or assert) before it. Park→hub trips without a save (60+ in the 4 h trace, many seconds after a mod autosave) never crashed; Save and quit to desktop after Save now did not crash either (10-16 14:20, 15:06). | **Open.** Exit-with-save to the menu crashed 2 of 2; no exit-with-save without a recent mod autosave has been traced yet, so mod autosave vs. save-API wrappers vs. vanilla is not settled. Repeating `x_*` marks (SaveAgent save/return, FrontEnd/HUD init/ready/shutdown, StartScreenHUD activate, ModeHelper.SetModes, park end) added to find the step. |
| 2026-10-15 21:26:41 and 21:26:57, second PC (dumps `c225fb0e…`, `c8e76e3a…`) | Access violation in `exhibits:GetAllAnimalIDs` from Kin.lua at 6 s, `introsequence`. | **Mod**, fixed (see "per-world API called outside a park" below). |
| 2026-10-14, local, while the hub world was deactivating (21:52, 22:00, 22:14) | 0xFDEAD | Probably the mod's overlay still mapped at shutdown. Fixed by unloading it in `OnPrepareToShutdown`. The unload runs cleanly on exit (2026-10-15); no crash since. |

## PZ2QoL Autosave (2026-10-16, `pz2qol.autosave.lua`, `autosavecore.js`)

- The game's own "autosave now": `api.save.RequestAutosave(api.player.GetGameOwner(), "zooauto")`.
  Retail callers: `editors.animal.releasetowilduimode.lua` and the scenario event
  `EventActionRequestAutosave`. It writes the game's usual rotating slot, and the game's callback
  (`OnAutosaveComplete`) re-arms the next one. **Proven 2026-10-16** (Franchise park, 2.0 debug
  build): 8 requests, each written and answered by the callback about 2 s later, every 2 min
  after the player picked 2 min. Retail Lua does **not** see `-autosaveinterval`
  (`save_arg_none`).
- The mod's clock counts park time only (it ticks from `HeatMapManager.Advance`; a long frame counts
  1 s at most) and **keeps counting across hub trips**. It resets on any zoo save: the game's
  autosave callback, the mod's own request, or a manual save (`api.save.RequestSave` with
  `tInfo.type == GetIdentForSaveID(ID_Zoo)`; profile saves use `ID_Player` and are ignored).
- It only requests while the game has an autosave armed: `SetAutosave`/`SetNewAutosave` mean armed,
  `UnsetAutosave` and the callback mean not armed. It waits 30 s after arming. On a refusal or no
  answer within 90 s it retries after 60 s, and shows each failure reason once per session.
- After its own save it calls `ResetAutosaveTimer`, so the game's 10-minute timer doesn't add an
  extra save right after.
- Setting: off (the game's own behaviour) or 2–60 min, **minimum 2** (clamped in Lua). Default
  5 min. It is kept in Lua for the game session, since the UI can't keep files. Events:
  `PZ2QoL_AutosaveSet(min)`, `PZ2QoL_AutosaveNow()`, `PZ2QoL_AutosaveGet()` →
  `PZ2QoL_AutosaveState(json)`, also pushed every 10 s in the park. Trace: `autosave_*`.

## Saving before a crash (assessed 2026-10-16, not built)

- Native fatals (0xFDEAD, access violations) run no Lua. Only native code (an exception handler)
  could react, and that would mean hooking the game's fatal path. Rule 1 rules that out.
- Game saves are asynchronous: `ParkLoadSaveManager:SaveParkToSaveToken` calls
  `api.save.RequestSave` and then yields until its `oncomplete` fires. It then asks
  `franchise:RequestPlanetHubSave()`. A save started as the game dies can't finish, and a half-made
  save is worse than none. **offline** (decompiled `managers.parkloadsavemanager.lua`, 1.0.4)
- Lua panics pass through PZ2QoL's `coroutine.resume` wrapper first, but `ModeHelper` raises the
  error in the same frame, so there's no time to save. What works instead is to make the failing
  game function fail soft (wrap it by name, as rule 4 says).
- Autosaving more often is the safe option. **offline** (decompiled GameMain
  `managers.parkloadsavemanager.lua`, 1.0.4), untested in game:
  - The launch option `-autosaveinterval <n>` is in **seconds** (the console command
    `SetAutoSaveInterval` prints "Autosave reset to N second intervals"). It goes to
    `api.save.SetAutosave{interval}` and is sent again at every park activation and autosave, so
    nothing overrides it during a session. Without it the engine's default applies (value unknown).
  - There is no autosave frequency setting in the game's menus.
  - All parks share one rotating pool of `zooauto` slots (`GetNumAutosaveSlotsForType`, count
    unknown; oldest overwritten). A very short interval fills every slot with near-identical recent
    states and pushes out other parks' autosaves. Each autosave also writes the config files.
  - Autosave doesn't call `franchise:RequestPlanetHubSave()`; only a manual save does.
  - Recommended: **300** (5 min). Don't go below 120; use 600 for several parks or a very large zoo.
  - **Seen on the second PC, no launch option (2026-10-16):** the first autosave came about 10 min
    after the park loaded, both times (park 02:31:31 → 02:42:06; 10:03:27 → 10:13:47). So the
    default is probably **600 s**. **But no second autosave followed** in the next 25 and 27 min
    (until the 03:07 and 10:40 crashes), so a plain 10-minute timer doesn't fit. The game Lua has
    nothing that would suspend it then; the cause is in the engine and unknown. Only 3 `zooauto`
    files exist, so the pool probably has 3 slots. Saves are in `Saved Games\Frontier
    Developments\Planet Zoo 2\<steamid>\Saves`; `Save_remote.config.xml` has an empty `<Autosave />`.
  - **The autosave chain** (GameMain `Managers.ParkLoadSaveManager`, **offline**):
    `SelectAppropriateAutosaveSlot` registers `api.save.RegisterAutosaveCallback` →
    `OnAutosaveComplete`, which starts `self.autosaveCoroutine` (resumed in `Advance`) **only if
    none is alive**. That coroutine's `_SelectAppropriateAutosaveSlot` enumerates the autosaves and
    arms the *next* one with `api.save.SetAutosave(oldest token, {interval})` or `SetNewAutosave`.
    It gives up silently on `"Failed to enumerate autosaves!"`, and it can yield while deleting
    surplus slots. If any link fails, no further autosave is armed, which would explain "only the
    first one".
  - **Why autosaves are rare (proven 2026-10-16 11:17–11:35, SaveTrace):** the default timer is
    **600 s** (armed 11:17:03, written 11:27:13, then re-armed straight away, so the chain works).
    But `DarwinWorld.OnDeactivate` calls `ClearAutosaveSlot` (UnsetAutosave) whenever the park
    world deactivates, e.g. on a trip to the hub (Animal Storage, Market). `OnActivate` then calls
    `ResetAutosaveTimer` + `SelectAppropriateAutosaveSlot` on return, so **every hub trip restarts
    the 10 minutes**. Players who go back and forth more often than every 10 minutes get no
    autosaves. The earlier "only the first autosave" sessions had Animal Storage use after the first
    one (02:44, 10:16). A deactivation also writes the `player` save (`RequestSave`), not the zoo.
  - Launch option syntax: `-autosaveinterval 120` (the value follows the flag, like `-loadpark`).
    **Not picked up in game (2026-10-16 11:16, 1.0.5):** set in Steam (`localconfig.vdf`, app
    3219030), yet `save_arm` traced `save_interval -1` (nil). Either retail drops the command line
    or `GetCommandLineArgument` is a dev-only stub. `save_arg_has|none` + `save_arg<n>` (SaveTrace
    Init) show which. Same session, **proven**: `save_slots 3`; on park load the game runs
    `save_clear`, `UnsetAutosave`, then `ResetAutosaveTimer`, `save_arm`, `SetAutosave`; the guard
    patch reached the Move mode (`guard_move_patched`, via the ModeHelper sweep).
  - Debug builds trace the chain (`PZ2QoL.SaveTrace`, does nothing in release): `save_arm` +
    `save_interval<n>`, `save_cb` / `save_cb_error` / `save_cb_busy` (callback while the old
    coroutine is alive), `save_select_begin` / `save_select_end`, `save_api_set` / `_setnew` /
    `_unset` / `_reset` / `_request` (manual save), `save_slots<n>`, `save_enum_failed`,
    `save_clear`. Healthy cycle: `save_cb`, `save_select_begin`, `save_slots`, `save_api_set`,
    `save_select_end`, then `save_cb` again one interval later.

## Earlier lessons

- A freeze at boot came from destroying the probe view inside a UI ready callback. Do view work on
  the startup coroutine.
- If the browser harness passes but the game shows unstyled UI, check for missing `display:flex`.

## Crash: per-world API called outside a park (2026-10-15, 1.3.0 test build)

- Access violation (0xc0000005, Main thread, 6 s in, world `introsequence`) in
  `exhibits:GetAllAnimalIDs` called from Kin's scan on the start screen. `api.world.GetWorldAPIs()`
  hands back APIs there, `habitat:GetHabitats()` even answers, but other per-world calls crash
  **natively**, which `pcall` cannot catch. **proven** (crash dump `c8e76e3a…`, trace ended at
  `kin_attached`).
- Rule: only call park APIs while a park is really running. PZ2QoL Kin uses the world APIs of the
  park-only `HeatMapManager` instance (its `tWorldAPIs`) and only if its `Advance` ticked within
  the last second; otherwise it answers `nopark` and touches nothing.

