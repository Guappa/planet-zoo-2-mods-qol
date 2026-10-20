# Can PZ2QoL sideload its own native code (a DLL) for a multi-threaded solver?

Investigation + probe preparation only. Game 1.0.5, build 1023906. No exe patching, no Denuvo /
activation work, no proxy DLLs, nothing changed in what is sent to Frontier's servers.

Marks: **proven** (seen in game) · **offline** (files/tests/decompiled only) · **guess**.

## TL;DR

- A native worker **thread** started from an exported function is feasible and low-risk for a
  **local, offline, dev-only** tool. That part is sound.
- The real blocker is **data OUT of the DLL back into Lua/JS**. The exe exports **no Lua C API**
  (re-confirmed: 359 exports, all Wwise / AMD AGS / D3D12 / `NvOptimusEnablement` / three Frontier
  `fLog*`; no `lua_*`), so a DLL cannot push a result onto the Lua stack. The only candidate that
  would make a solver genuinely useful is the **standard Lua file loader** (`loadfile` / `dofile`)
  surviving in the live state so Lua can read an `answer.lua` the DLL writes. **Whether it survives
  is the single open question** — the game's own code never uses it. The prepared probe answers it
  in one offline boot.
- Even if it works, **shipping** a DLL would break repo rule 6 (plain zip, no executables), is
  **visible to Frontier on any crash** (the crash reporter uploads the full loaded-module list to
  Backtrace), and will likely be **quarantined on Nexus** / flagged by Defender.
- **Recommendation: NO-GO for shipping; conditional GO for a local dev-only experiment** gated
  behind the probe result and an explicit rule decision by the developer. Treat any "speed-up" as a
  guess until measured in game — this investigation measured none.

---

## Q1 — Return-channel candidates: do the standard Lua loaders survive?

**What the game uses (offline, from 2,212 decompiled Lua files).** The game has its **own** module
system built on custom C globals, not the stock Lua loader:

- Globals in use: `require`, `tryrequire`, `loadresource(name) -> fn,err`, `moduleexists(name)`.
  `require` resolves modules through `loadresource`, which reads the **OVL virtual filesystem**, not
  an OS path. `api.debug.API_ReloadModule` (`GameMain/api.debug.lua`) is the only `loadresource`
  caller of note.
- **Zero** uses anywhere of `loadfile`, `dofile`, `load`, `loadstring`, `package.searchpath`,
  `package.path`, `package.searchers`/`loaders`, or `io.*`. `package.searchers` is **not** replaced
  by the game (it simply isn't referenced). `io` is absent (already in the skill).
- Consequence: **calling the game's own `require` cannot read a file a DLL wrote to disk** — it goes
  to the OVL VFS. `api.debug.ReadStringFromFile`/`WriteStringToFile` are **retail stubs** returning
  `false` (already proven). So the obvious read-back paths are closed.

**The open question.** "Unused" ≠ "removed". Stock Lua 5.3 ships `loadfile`/`dofile`/`load` and
`package.searchpath` in the base library; Frontier may or may not have stripped them. If
`loadfile`/`dofile` still exist **and** use OS `fopen` (not re-routed to the VFS), then a DLL can
write `dbg\answer.lua` containing `return <data>` and Lua can `dofile` it — a real, general return
channel. This is **unknown offline** and is exactly what the probe tests
(`probe_has_loadfile` / `probe_no_loadfile`, `probe_readback_loadfile_ok`, etc.).

`package.loadlib` **is** present and works (proven: the trace DLLs load in Franchise on 1.0.5).

## Q2 — File-existence signalling via `package.loadlib` (1 bit per call)

Yes, in principle: `package.loadlib(path, "*")` returns non-nil once `path` exists and is a valid
DLL, and nil before. That is a **1-bit** "is it done yet / which branch" signal. Caveats:

- The payload must be a **valid loadable DLL**, not an arbitrary file (the probe worker writes
  `probe_answer.dll` by copying itself for this reason).
- `loadlib` **caches** by path and there is **no unload** in retail, so every *successful* load
  pins another module in the process for the session. Fine for a one-shot "done" flag; useless as a
  stream — encoding a solver's answer as a sequence of file-existence bits would be absurdly slow
  and would permanently load one DLL per bit.
- **The C function's return value is NOT data.** A `loadlib`'d function is a `lua_CFunction`; its
  returned `int` is the **number of results pushed**, not a value (the tracer returns 0 for exactly
  this reason; returning N with nothing pushed reads garbage/crashes). So no data leaks via return
  values. Cost/latency measured in game by the probe (`probe_loadlib_ms`).

## Q3 — Can the Gameface page read a DLL-written file? (coui:// / XHR / localhost)

- **XHR works in Gameface.** Proven offline in the unpacked UI: `LocalisationProviderJSImpl`
  (`loadLocFile`) and `DebugFileManagerJSImpl` (`LoadFileAsString`) both do
  `new XMLHttpRequest(); xr.open('GET', path)` to load resources. Paths resolve through the
  `coui://` resource system wired up by `api.ui2.LoadOverlay` + `MapResources`.
- **But coui:// is the OVL VFS, read-only and baked at build.** The mod's overlay files are mapped
  from its OVL; a DLL cannot inject a file into coui:// at runtime. So "DLL writes file → page
  XHRs it over coui://" **does not work**.
- **Arbitrary `file://` or `http://localhost` XHR** depends on Gameface's resource-handler
  allowlist, which isn't in the UI files and is normally locked down in shipped titles. `cohtml.js`
  (the JS↔native binding shim) exposes **no** networking surface. A DLL running a local HTTP/WS
  server would also need a **firewall exception** (user-facing, undesirable). **Unproven and not
  recommended.**
- **No** `fetch`, `WebSocket`, `Worker`, `WebAssembly`, `SharedArrayBuffer`, `importScripts`, or
  `navigator.hardwareConcurrency` anywhere in the game UI JS (`navigator` appears only for gamepads
  and a lottie feature-detect). See Q5.

## Q4 — Threads: start/stop safely, lifetime, cleanup, CPU priority

Settled design (implemented in the probe worker, `tools/trace/pz2_probe.c`):

- **Start the thread from an exported function Lua calls (`probe_start`), never from `DllMain`** —
  `DllMain` holds the loader lock; spawning or doing file work there can deadlock. `DllMain` only
  stashes the module handle and `DisableThreadLibraryCalls`.
- **Priority:** `SetThreadPriority(THREAD_PRIORITY_LOWEST)` so the game's frame time isn't hurt.
  (Optionally pin affinity away from the main/render threads; the probe doesn't, to stay simple.)
- **Lifetime:** a thread is process-global and survives park loads; it must be **explicitly
  stopped** (there is no DLL unload in retail). The probe uses an interlocked stop flag + a hard
  tick cap so it can never run away, and `probe_stop` signals and joins with a 2 s timeout.
- **Cleanup on exit:** the mod's only shutdown hook is Lua (`OnPrepareToShutdown`); there is no
  native exit hook that can join a thread. Safest is a low-priority worker that self-terminates on a
  flag; a stuck worker merely wastes one core until the process exits. **The thread must never
  touch game memory or the Lua state** (rejected: reading the string out of `lua_State` by layout —
  Frontier's Lua has a custom header and 32-bit floats, so the layout is unknown and a wrong guess
  reads wild memory).

## Q5 — Gameface multithreading (Workers / WASM / SharedArrayBuffer)

No evidence in the game's UI files that any of these are available: no `Worker`, `WebAssembly`,
`SharedArrayBuffer`, `importScripts`, or `navigator.hardwareConcurrency` usage, and `cohtml.js`
exposes no such API. Coherent Gameface can be built with or without these depending on the host's
configuration, which we cannot see from the files. **Guess:** not usable; do not plan a JS-side
multi-threaded solver. (The existing optimiser already runs acceptably in **time-sliced** JS —
`kinprogrammecore.js` `planProgrammeAsync` — which is the pragmatic alternative; see "Motivation".)

## Q6 — Distribution and online risk; which rules would need to change

**Online / Franchise visibility (new finding).** Crash minidumps embed the **full loaded-module
list** (name, base, size — `tools/crashsum.py` reads `m.modules.modules`) plus a "Mod Information"
block, and `crash_reporter.exe` uploads them to **Backtrace** (a Frontier service). So **a foreign
DLL loaded into the Franchise client is visible to Frontier on any crash**, by filename, and named
explicitly if it is on the faulting thread's stack. This already happens today with the trace DLLs —
it had simply not been examined. Denuvo is **exe** anti-tamper, not a loaded-module scanner, and
there is no evidence of an active integrity check over loaded modules; the crash reporter is the
real reporting channel. The DLL loads **do not** change anything sent to Frontier during normal play
(no network path), only what a crash dump contains. Whether that is acceptable under the ToS is a
**developer call** — the concrete fact is "our DLL's filename reaches Frontier in crash reports."

**`package.loadlib` in release builds (coordinator's question).** There is only one game Lua — the
retail exe's. "Debug build" here means the **mod** ships `dbg\*.dll`; it is not a different game.
`package.loadlib` is a property of the retail game Lua and is **proven** to work there (trace DLLs
load in Franchise, 1.0.5). A **release** mod build just ships no DLLs, so there is nothing to load —
same mechanism, different payload. Any DLL-based feature would therefore ship the DLL in an ordinary
(release) build. The spelling channel (data-IN) rides the same `package.loadlib` + `mark` and so
also works regardless of the `--debug-trace` flag; only whether the DLLs are *present* differs.

**Nexus / Defender.** A mod containing a DLL will very likely be **quarantined** or flagged
("some suspicious files" / "quarantined") by Nexus's automated scan, and an unsigned DLL can trip
Defender/SmartScreen on the user's machine. (The `ac8-nexus-mod` skill documents this pattern for
the sibling repo; the same applies here. No upload was performed — a distribution test would be:
zip the pack, upload as a **hidden** draft to the mod page, read the automated scan result, and only
publish if clean; a DLL is expected to fail that.)

**Rules that would need the developer's explicit change:**

- **Rule 6** ("a plain zip only. No installers or executables.") — a DLL *is* an executable, so
  shipping one breaks rule 6 outright. Must be changed to ship.
- **Rule 1** ("no proxy DLLs.") — a DLL the game's **own Lua** loads via `package.loadlib` is **not**
  a proxy/hijack DLL: it does not impersonate a system DLL, does not sit in the exe's import path,
  and touches neither the exe, Denuvo, nor activation. So rule 1's letter arguably does not forbid
  it, and its spirit (never touch the exe/Denuvo/activation) is preserved. But this is close enough
  that the developer should rule explicitly. Suggested carve-out if allowed: *"A DLL that the game's
  own Lua loads via `package.loadlib`, that never uses the Lua C API and never touches the exe,
  Denuvo or activation, is permitted in dev/debug builds only."*

## Go / No-Go

- **Ship a native solver in the public mod: NO-GO** as things stand. The data-out channel is
  unproven, shipping breaks rule 6, the DLL is reported to Frontier on crashes, and Nexus will
  likely quarantine it.
- **Local dev-only experiment: conditional GO**, gated on the probe:
  - If `loadfile`/`dofile` **survive and read** the DLL-written `answer.lua`
    (`probe_readback_loadfile_ok` or `_dofile_ok`), a dev-only native solver is technically viable
    for **offline parks**, with the worker-thread design in Q4. Shipping would still require the
    rule-1/rule-6 decisions above and acceptance of the crash-visibility and Nexus costs.
  - If they **do not** survive, there is **no usable general data-out channel** without touching
    forbidden surfaces (reading `lua_State`, networking, or the exe). Drop the native-helper idea;
    keep time-sliced JS.

### Motivation check

Before pursuing this at all, measure whether a native solver is even needed. The current optimiser
runs in JS time-slices (`planProgrammeAsync`, `tests/kinprogramme.test.mjs` ~7 s for the full
brute-force cross-checks; in-mod it runs in slices and never blocks a frame). If that is fast enough
in the developer's largest zoos, the native route's cost (rules, crash visibility, Nexus) is not
worth it.

---

## The probe (prepared; debug-only; fail-soft)

Files added in this worktree:

- `tools/trace/pz2_probe.c` — the worker DLL (built by `build_pz2qol.py --debug-trace` as
  `dbg\probe_worker.dll`). Exports `probe_start` / `probe_stop` (plain C symbols, verified with
  dumpbin). Never uses the Lua C API or reads game memory. `probe_start` spawns one
  `THREAD_PRIORITY_LOWEST` worker (from the export, not `DllMain`) that "solves" for ~1 s, logs its
  own `probe_thread_start/_tick/_exit` lines (with tid + timestamp) to `dbg\trace.log`, then writes
  two answer files next to itself: `probe_answer.lua` (`return 424242`) and `probe_answer.dll` (a
  copy of itself). `probe_stop` sets a flag and joins (2 s cap). Hard tick cap so it cannot run away.
- `mods/PZ2QoL/Main/pz2qol.probe.lua` — `PZ2QoL.Probe`, added to Core's feature list and run from
  `database.pz2qolluadatabase.lua` `AddContentToCall` (on the startup coroutine, so it may yield).
  Does **nothing** unless `Core.bTrace` (a `--debug-trace` build) **and** the worker DLL loads;
  everything is `pcall`-wrapped. It:
  1. records which loaders exist — `probe_has_<x>` / `probe_no_<x>` for `loadfile`, `dofile`,
     `load`, `loadstring`, `io`, `os`, `require`, `tryrequire`, `loadresource`, and every
     `package.*` loader (Q1);
  2. loads and calls `probe_start`, then yields up to ~3 s waiting for the answer files;
  3. reads the answer back via `loadfile`, `dofile`, and the `package.loadlib` 1-bit channel,
     marking `probe_readback_*_ok/_no` and spelling the round-trip latency
     (`probe_loadfile_ms`, `probe_loadlib_ms`) with `Core:MarkNumber` (Q3/Q2/Q4 latency);
  4. calls `probe_stop` and frames the run with `probe_begin_native` / `probe_end_native`.
- `tools/trace/checkpoints.txt` — the new `probe_*` checkpoint names (so each gets its DLL copy).
- `tests/lua/test_pz2qol.lua` — section 17 (release no-op, a mocked happy path proving
  start/stop/read-back, and a missing-DLL fail-soft path).

**Verification done without a game run:** `luac -p` on all three touched Lua files; the full Lua
suite (`test_pz2qol.lua` 309 passed, `test_storagesend.lua` 36, `test_lister.lua` 339); MSVC x64
compile of `pz2_probe.c` with exports confirmed; a full `build_pz2qol.py --debug-trace` with the OVL
round-trip verify passing (13 Lua files incl. the probe, 52 UI files, 461 checkpoint DLLs +
`probe_worker.dll`). The debug probe build is **installed to the D: dev environment** (sha1-verified,
465 files), game confirmed closed first.

### What NOT measured

**Frame-time impact is a guess** — no in-game run was done. The worker is `THREAD_PRIORITY_LOWEST`
and runs ~1 s, so hitching is unlikely, but the developer should watch for it. **No speed-up figure
is claimed.** Round-trip latency is only produced by the in-game probe run below.

### First run (2026-10-18 13:51–13:54, D:, hub → Franchise zoo → exit): no probe answers

The trace has **none** of the native probe's marks. The `cp_probe_begin/created/ready/shutdown`
lines in it are the hub's existing hidden probe **view** (`Hub._StartProbe`), a different feature.
No `probe_answer.*` file was written, so the worker never started: `Probe.Run` either was never
reached or returned before its first mark. The trace can't tell which, because the probe's own
`init_ok/init_fail_pz2qol.probe` names were missing from `checkpoints.txt` (so were
`init_*_pz2qol.marketpeek`; that is harmless). The likely cause is the known in-game pitfall: the
database looked the probe up with `package.loaded["pz2qol.probe"]`, which can be nil in game.
The missing `LOG` lines / `log_channel_ok` are expected: this branch is based on 2.1.0, before the
detailed-log channel, and the probe doesn't use it.

Fixes (second build, installed to D: 13:59): the probe registers itself as `Core.Probe` and callers
look it up there; `probe_init`, `probe_run_called` / `probe_not_found` / `probe_run_error`, and the
missing `init_*` names show the path taken. The probe is split into a non-yielding `Start` and a
`Poll`. A second trigger in the hub's JS breadcrumb listener starts it when the view registers
(`probe_via_view`) and polls it on every `js_*` event (the 10 s heartbeat), so the result can't
depend on one hook. The boot wait is capped at ~150 frames so startup isn't held up, and the run
ends at the latest 10 s after the start (`probe_timeout`). Every answer is a plain checkpoint; a
script checked that every mark name the probe can emit is in `checkpoints.txt`.

### Steps for the developer to run the probe (one boot)

1. **Close the game on the other PC (Y:) first** — only one PC may run the game at a time.
2. On the **D:** PC, launch Planet Zoo 2 normally. (Already activated on 1.0.5; this is a drop-in
   mod change, no re-activation needed. The one-time "modifications detected" notice may appear.)
3. The probe runs **automatically** — **no clicks needed**. Reach the **main hub / start screen**
   and **stay there at least 30 seconds** (if the boot path fails, the fallback needs a few 10 s
   heartbeats). No park, offline or Franchise, is needed.
4. Quit the game.
5. Copy out `D:\SteamLibrary\steamapps\common\Planet Zoo 2\Win64\ovldata\PZ2QoL\dbg\trace.log`
   (a reinstall overwrites it) and share it, or just the lines matching `probe_` and
   `cp_probe_`.

### Reading the result

- `probe_has_loadfile` / `probe_no_loadfile` (and `dofile`, `load`, `package_searchpath`,
  `package_searchers`, …) — **which standard loaders survive** (the Q1 answer).
- `probe_readback_loadfile_ok` or `probe_readback_dofile_ok` — **the file return channel works**
  (the decisive result). `probe_loadfile_ms` spells the round-trip ms. `*_no` means it does not.
- `probe_readback_loadlib_ok` + `probe_loadlib_ms` — the 1-bit existence channel works + latency.
- Worker lines `probe_thread_start` / repeated `probe_thread_tick` / `probe_thread_exit` (each with
  `tid=`) — the thread **started and stopped cleanly**; the tick cadence (~100 ms) shows it ran.
  `probe_wrote_answer_lua` / `probe_wrote_answer_dll` confirm the files were written from the thread.
- `probe_worker_missing` — the DLL failed to load (should not happen; it is installed).
- Path diagnostics: `init_ok_pz2qol.probe` and `probe_init` (the feature loaded), `probe_run_called`
  or `probe_not_found` (the boot hook found it), `probe_via_db` or `probe_via_view` (which trigger
  started it), `probe_poll_first`, `probe_timeout` (10 s passed without every channel answering),
  `probe_polls` / `probe_run_frames` (spelled counts). `probe_loadfile_call_ms` spells what one
  `loadfile` call costs (the per-round-trip cost if this becomes the channel).

If `probe_readback_loadfile_ok`/`_dofile_ok` appear, the native route is technically open for a
local dev tool and the developer's rule decision becomes the gate. If only `probe_readback_loadlib_ok`
appears (1 bit) and the loaders are absent, treat the native-helper idea as **not worth pursuing**.

## Result of the probe run (2026-10-18 14:09, D:, game 1.0.5, combined debug build)

**Proven in game.** The trace is backed up at `scratchpad\trace_backup\trace_run3_*.log`.

- **What the game's Lua has:**
  - `loadfile`, `dofile`, `load` and `loadstring` exist;
  - so do `require`, `tryrequire` and `loadresource`;
  - so does `package`, with `loadlib`, `searchpath`, `searchers`, `loaders`, `path`, `cpath` and `preload`;
  - there is **no `io`** and **no `os`**.
- **The return channel works.** The probe DLL's own thread wrote `answer.lua`. Game Lua read it back with both `loadfile` and `dofile` (`probe_readback_loadfile_ok`, `probe_readback_dofile_ok`); the read itself took ~0 ms (`probe_loadfile_call_ms` = 0.0). The answer was ready 3.4 s after start, which is the probe's own poll timing. The file-exists signal through `package.loadlib` works too (`probe_readback_loadlib_ok`).
- **The worker thread:**
  - it was started by an exported function, not `DllMain`;
  - it ticked every 100 ms on its own OS thread, separate from the game's threads;
  - `probe_stop` ended it within 100 ms and the wait returned (`probe_thread_exit`, `probe_stop_done`).
- **The game's UI** (Gameface, hub page) has **no WebAssembly and no Web Workers** (`kin ui_caps wasm=false worker=false cores=unknown`). Multi-core work can therefore only come from a native helper.

**Updated verdict: technically go.** A native solver can do the whole round trip:
1. The problem goes in through the spelling channel (~0.2 ms per 100 characters, so ~20–40 ms for a large species).
2. The DLL solves it on its own threads.
3. The answer comes back as a Lua file that `loadfile` reads.

Shipping it is still the developer's decision on rules 1 and 6. Nexus quarantine, Defender, and the module list in crash dumps still apply. The speed-up is still unmeasured.
