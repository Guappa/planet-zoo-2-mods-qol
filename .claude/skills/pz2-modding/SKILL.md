---
name: pz2-modding
description: Definitions, proven techniques, game API facts and rules for modding Planet Zoo 2 (Cobra engine, OVL archives, Lua 5.3, Coherent Gameface UI). Use for any Planet Zoo 2 / PZ2 modding work in this repo - building or installing mods, hooking game Lua, injecting or testing UI, reading game data stores and events, debugging crashes - and keep it updated with anything new learned.
---

# Planet Zoo 2 modding

The repo's knowledge base for modding Planet Zoo 2 (PZ2). It holds what has been **proven** in the
game, what is still **open**, and the rules every mod here follows. Details live in `reference/`;
read the file for the area you are working in.

## This skill updates itself

This file and `reference/` are the source of truth. Keep them current as part of the work, not as
an afterthought:

- **When you learn something about PZ2 or its modding** (a format detail, an API, an event name, a
  data path, a pitfall, a crash cause, a tool trick), add it to the matching `reference/` file
  **in the same change** that used it. Create a new reference file if no topic fits, and list it in
  the index below.
- **When something here turns out wrong or outdated** (e.g. after a game patch), fix or delete it.
  Don't leave contradictions.
- Mark how sure a fact is: **proven** (seen in game), **offline** (seen in files, tests or
  decompiled code only), or **guess**. Upgrade the mark once it is confirmed.
- Note the game version for anything a patch could change. Current: **1.0.4, build 1018486**.
- Add one dated line to `reference/changelog.md` per update.
- Keep entries short: the fact, why it matters, where it's used (file path). No session narration.

## Ground rules (always)

1. **Never touch the exe or Denuvo.** No patching, unpacking, proxy DLLs, or bypassing online or
   offline activation. Each new game build needs one online launch with Steam online.
2. **Mods are drop-in folders.** `Win64\ovldata\<Pack>\`, with `Manifest.xml` and OVLs. No game
   files are changed, and nothing is written to saves or the profile. Uninstalling means deleting
   the folder. Data a mod must keep (e.g. PZ2QoL's habitat assignments) goes in ONE file inside its
   own pack folder (`userdata.json`), never elsewhere; updates must keep it.
3. **Online (Franchise) safety.** Never change what is sent to Frontier's servers. Any automation
   that acts online:
   - is off by default, Franchise only, and only ever started by a user click (never a timer or
     the background);
   - does one action at a time, each confirmed by the game;
   - stops on fatal errors.
4. **Fail soft.** Wrap every hook in `pcall`. If anything is missing, fall back to the vanilla
   view or behaviour. Hook by module or function name, not by offset.
5. **Ship nothing of Frontier's** (no decompiled code, no assets) except unavoidable copies of the
   game's own UI entry pages that redirect to the mod (see `reference/ui-gameface.md`).
6. **Packaging:** a plain zip only. No installers or executables.

## Core definitions

| Term | Meaning |
|---|---|
| **Cobra** | Frontier's engine (PZ1, PC2, JWE3, PZ2). |
| **OVL / OVS** | Frontier archive format. PZ2 uses cobra-tools' **Planet Coaster 2** profile, with header byte 4 (`version_flag`) set to `0x01`. |
| **Content pack** | A folder in `Win64\ovldata\`. Every pack gets `tryrequire("Database.<Pack>LuaDatabase")`, which is the mod entry point. |
| **Main.ovl** | The pack's Lua. Mods ship **plain-text** Lua; the game compiles it at load. |
| **UI overlay** | A pack's extra UI files (HTML/JS/CSS) in an OVL, loaded with `api.ui2.LoadOverlay` and `MapResources`. |
| **Gameface** | Coherent Gameface (cohtml): the HTML/JS UI runtime. The game UI is Preact. |
| **View** | A Gameface page owned by a Lua controller, e.g. `FrontEndUI` (hub, `Frontend.html`) and `HUDUI` (`HUD.html`). |
| **DataStore** | The game's UI data model: values at context paths such as `['hubAnimalsData','animalStorageData','list']`. |
| **Hub** | The start-screen globe world (`startscreenglobe`): Market, Animal Storage, Franchise. |
| **0xFDEAD** | Frontier's own fatal-error exception, raised deliberately with `RaiseException`. |

## Reference index

| File | Covers |
|---|---|
| `reference/archives-and-build.md` | OVL format, cobra-tools, pack layout, build and install tools, pitfalls |
| `reference/lua-runtime.md` | Entry point, require hooks, coroutines and threads, `api.*` namespaces, view and overlay lifecycle |
| `reference/ui-gameface.md` | Gameface quirks, view redirects, DataStore and collections, row recycling, CSS rules |
| `reference/game-data-and-events.md` | Data contexts, UI events, enums, trade and listing limits, server errors |
| `reference/debugging.md` | Trace DLL breadcrumbs, crash dumps and how to read them, known crashes |
| `reference/animals-and-breeding.md` | Lineage and parent APIs, the game's inbreeding rule, habitat membership, kin-related UI surfaces |
| `reference/testing.md` | Unit, Lua and browser-harness tests and when to run each |
| `reference/changelog.md` | Dated log of updates to this skill |

## Workflow for a mod change

1. Read the relevant reference files. Find the game code you are hooking in the decompiled Lua or
   the unpacked UI (`reference/archives-and-build.md` explains how to get them).
2. Change the mod in `mods/<Pack>/`.
3. Run the tests (`reference/testing.md`). For UI changes, run the browser harness and **look at the
   screenshots**.
4. Build fresh, then install only while the game is closed (`reference/archives-and-build.md`).
5. In game: check `dbg/trace.log` (debug builds) and the crash dumps if anything goes wrong.
6. **Update this skill** with whatever you learned.
