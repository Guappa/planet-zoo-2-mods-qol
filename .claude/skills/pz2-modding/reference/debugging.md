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

## Known crashes (open)

| When | What | Status |
|---|---|---|
| 2026-10-14, second PC, Animal Storage (21:29, 22:41, 22:48, 22:59) | 0xFDEAD on the Render or fTask thread. GPU memory fine (4 of 16 GB). No mod frames on the stack. | **Open.** 22:59 came **4 s after a Franchise server error** (and one 2 min earlier didn't crash). Suspects: the server error itself, or the mod's error toast. The server error code isn't known yet. |
| 2026-10-15, second PC, Animal Storage, lister run (19:42:58, 19:50:33) | 0xFDEAD on fTask W22 / W14, 0.5 s and 0.24 s after the server answered the listing request (type 42) with **code 5**. No mod frames. Trace numbers via `Core:MarkNumber`. | **Cause found:** the game's own handling of that reply (vanilla), triggered by lister requests. Mitigated in 1.2.1: stop at the first unnamed code, pause after every request, and wait for `IsDatabaseOperationInProgress` to be false. The Oct 14 22:59 crash (4 s after a server error) is probably the same. |
| 2026-10-14, local, while the hub world was deactivating (21:52, 22:00, 22:14) | 0xFDEAD | Probably the mod's overlay still mapped at shutdown. Fixed by unloading it in `OnPrepareToShutdown`. The unload runs cleanly on exit (2026-10-15); no crash since. |

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

