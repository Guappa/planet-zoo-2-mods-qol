# Planet Zoo 2 Modding Kit: guide

Planet Zoo 2 (PZ2) runs on Frontier's Cobra engine, like Planet Zoo, Planet Coaster 2 and Jurassic
World Evolution 3. Its game logic is Lua and its interface is HTML/JS, both shipped in the game's
data archives. With the tools in this kit you can read both as source and write mods that hook
them. We worked this out while building our own PZ2 mod (Mike's QoL Toolbox, formerly Genes & Gold and PZ2QoL).

Checked on game version **1.0.5 (build 1023906)**. A patch can change any of this. Each fact is
marked:

- **proven**: seen working in the game;
- **offline**: read in the game's files only, not yet tried in the game.

## What this kit does and doesn't do

- It reads the game's **data archives** (OVL files in `Win64\ovldata`). Those are plain archives
  with no encryption.
- It never touches `PlanetZoo2.exe`. The exe is protected by Denuvo. Nothing here patches,
  unpacks, decompiles or bypasses it, and you don't need to.
- Mods are drop-in folders that the game loads by itself. No game file is changed, and you
  uninstall by deleting the folder.
- What you extract is Frontier's code and art. Read it and learn from it, but **don't upload it**.
  Ship only your own files.

## 1. Setup

1. **Python 3.11** (what cobra-tools asks for; 3.12 also worked for us).
2. **cobra-tools**: `git clone https://github.com/OpenNaja/cobra-tools`. It's the community's
   Cobra archive toolkit, and all credit for the archive format goes to its authors. Install its
   requirements into a virtual environment:
   ```
   py -3.11 -m venv venv
   venv\Scripts\pip install "imageio>=2.26.0" "numpy>=1.26.4,<2.0.0" "pillow>=10.0.1" "bitarray~=2.9.2"
   ```
   cobra-tools includes **luadec** (Lua 5.3 decompiler, viruscamp/luadec) under
   `modules\formats\utils\luadec\`.
3. Optional:
   - Visual Studio with C++, for the trace DLL (section 6);
   - `pip install minidump`, for `crashsum.py`.

cobra-tools has no "Planet Zoo 2" entry yet. **PZ2 archives use the Planet Coaster 2 format**
(`FRES` v20, Oodle), so pick that profile. **proven**

## 2. Read the game: scripts and UI as source

```
venv\Scripts\python tools\pz2_unpack.py --cobra-tools <cobra-tools> --python venv\Scripts\python.exe ^
    --game "C:\...\steamapps\common\Planet Zoo 2" --out C:\pz2-source
```

It takes about two minutes and only reads from the game folder. You get:

| Output | What it is |
|---|---|
| `lua\GameMain\*.lua` (~245) | Engine-side scripts: game script, environments, managers, saving, UI controllers |
| `lua\Content0\*.lua` (~870) | Game content scripts: hub modes, editors, challenges, animals, Franchise |
| `lua\...\*.lua.bin` | The original bytecode, kept for `lua_funcmap.py` |
| `ui\` | The full game UI: `Frontend.html` (hub), `HUD.html` (in park), `js\`, `css\` |
| `unpack_report.txt` | Counts and the list of partly decompiled files |

How it works:

- Game Lua is **Lua 5.3 bytecode with a small Frontier header** (format byte `0x02`, 32-bit float
  numbers). It is not obfuscated, and cobra-tools' luadec decompiles it as is. **proven**
- On 1.0.5, 461 of 1,117 scripts decompile cleanly. 631 contain a `DECOMPILER ERROR` block
  somewhere, but the rest of each of those files still reads fine. 25 small scripts don't
  decompile at all (luadec runs out of memory); their `.bin` stays.
- Debug line info is stripped, so the decompiled file's line numbers don't match crash reports.
  Each function's start line survives, though: `tools\lua_funcmap.py <file>.lua.bin <line>`
  tells you which function a crash line falls in.
- The UI ships as a `.ppuipkg` inside `GameMain\Content\UserInterfaceEssentials.ovl`. cobra-tools
  dumps it as XML (each byte written as a number), and `tools\ppuipkg_unpack.py` turns that back
  into files. The icons live in other OVLs (`Content0\UI\UserInterfaceImages*.ovl`).

Good places to start reading:

- **Boot and shutdown:**
  - `game.gamescript.lua`: overlay loading and shutdown;
  - `database.main.lua`: the content pack and mod entry point;
  - `environment.environment.lua`: how park managers are loaded and ticked.
- **UI controllers:**
  - `ui2.viewwrapper.lua`: views and events;
  - `ui.controllers.*`: one controller per view, with their `AddListener_*` events.
- **Hub and park:**
  - `startscreen.globe.*hubmode.lua`: hub screens (Market, Animal Storage, Franchise);
  - `managers.*`: park systems, e.g. `managers.parkloadsavemanager.lua` for saving and autosave;
  - `editors.*`: in-park tools and modes.
- **UI side:**
  - `js/project/modules/*`: screens;
  - `js/project/data/Schemas/*`: every UI data field, with sample values;
  - `js/common/core/DataStore.js` and `Engine.js`: data access and the JS-to-game bridge.

Search across both trees. A function name you see in Lua usually turns up in the UI's events too.

## 3. How the game loads a mod

```
Planet Zoo 2\Win64\ovldata\MyMod\
  Manifest.xml      <ContentPack version="1"><Name>MyMod</Name><ID>guid</ID><Version>1</Version><Type>Game</Type></ContentPack>
  Main.ovl          your Lua, as plain text: the game compiles it when it loads
  UI\MyModUI.ovl    optional UI overlay (your HTML/JS/CSS)
```

- **Entry point.** For every content pack, `Database.Main` calls
  `tryrequire("Database.<Pack>LuaDatabase")`, and that is your mod's start. This is the hook ACSE
  uses on the earlier Cobra games. **proven**
- **Ship plain-text Lua.** The game compiles it at load, so you don't need Frontier's compiler.
  **proven**
- **File names are dotted and lower case.** `mymod.core.lua` is `require("MyMod.Core")`, and the
  entry file is `database.mymodluadatabase.lua`. **proven**
- **Module pattern.** Start with `local X = module(...)`, and grab globals once at the top
  (`local global = _G; local api = global.api`). **proven**
- **When your code runs:**
  - code at module load runs inside `require`, so it **can't yield**;
  - `<Pack>LuaDatabase.AddContentToCall` runs on the startup coroutine, which **can yield**
    (wait for things there). **proven**
- **Notices.** The game shows a one-time "modifications detected" notice, and crash reports list
  the pack under "Mods added". **proven**

### Patching game code

- **Hook `require` and patch modules as they load.** The template's `Core:AddModulePatch(name, fn)`
  wraps `require` and `tryrequire`. **proven**
- **Patch by replacing a table function and calling the original.** Put your own code inside
  `pcall`. **proven**
- **Park managers bypass a plain require hook.** `Environment._LoadManagerModule` uses a copy of
  `require` taken before any mod runs, and it caches each manager's `Advance` etc. when it creates
  the manager. So patch `_LoadManagerModule` and apply your patches as each manager loads. The
  template does this. **proven**
- **World modes bypass it too.** `GameHelpers.ModeHelper.SetModes` requires every mode with its
  own `require`, so the template wraps `SetModes` and sweeps the loaded modules first. **offline**
- **A per-frame tick in a park.** `Managers.HeatMapManager.Advance` runs every frame in a park
  (see `template\MyMod\Main\mymod.example.lua`). **proven**
- **Hub modes are classes.** They are `Object.subclass` classes, so patching the module table
  reaches every instance.
- **Several threads.** Game Lua runs on more than one thread (`Main` and `fTask Wn` workers).
  **proven**

### What Lua can and can't do

- **No `io` library.**
- **`api.debug.ReadStringFromFile` / `WriteStringToFile` are stubs in the retail game.** They
  return false for every path we tried, including the game's virtual `/run/` and `/tmp/` paths, so
  a mod can't keep files. **proven**
- **The park save is the one place Lua can keep data.** **offline** The game's own managers use
  it:
  ```lua
  api.world.GetWorldAPIs().worldserialisation:RegisterWorldSerialisationClient(
      sName, nVersion, fnSave(tSave), fnLoad(tLoad, nVersion), fnCanLoadOldVersion(n))
  ```
  Call it from a park manager's `Init`, and call `UnregisterWorldSerialisationClient(sName)` in
  `Shutdown` (see `managers.guestcounthistorymanager.lua`).
  - Keep to your own client name.
  - Never write into Franchise saves: they go to Frontier's servers.
  - Make sure a save still loads without your mod.
- **`package.loadlib` works**, so mod Lua can load a DLL. The exe exports no `lua_*` functions,
  though, so a DLL can't use the Lua C API directly. **proven**
- **Only call park APIs while a park is running.** On the start screen
  `api.world.GetWorldAPIs()` still hands back park APIs, but some of them crash the game natively,
  and `pcall` can't catch that (`exhibits:GetAllAnimalIDs` did). Use a park manager's own
  `tWorldAPIs` from inside its `Advance`. **proven**

## 4. UI mods (Coherent Gameface)

The game UI is **Preact** (Frontier's own fork of Preact 8) running in Coherent Gameface. The
main views are `Frontend.html` (hub) and `HUD.html` (in park, and also active in the hub).
**proven**

### Getting your UI into the game

All **proven**:

1. Your pack ships a UI overlay (`UI\<Pack>UI.ovl`; `pz2_build_pack.py` builds it from `UI\`).
2. In `AddContentToCall`, load it:
   - `api.ui2.LoadOverlay(name, path)`;
   - yield until `IsOverlayLoaded`;
   - then `MapResources(name)`.
3. Ship your own copy of the entry page (e.g. `MyModHUD.html`) that loads the game's bundle and
   then your script.
4. Redirect the view by wrapping its controller's `Init` (e.g. `UI.Controllers.HUDUI.Init`):
   rewrite `tInitSettings.sViewAddress` before calling the original.
5. On exit, undo it before the game's own `Game.GameScript.OnPrepareToShutdown`:
   - `UnmapResources`;
   - wait for `AreResourcesUnmapped`;
   - then `UnloadOverlay`.

   A mapped mod overlay at shutdown crashed the game for us.

### The JS-to-Lua bridge

- **The `engine` global.**
  - `engine.trigger(name, ...)` sends an event to Lua.
  - `engine.on(name, fn)` listens.
  - Lua sends with `oUI:TriggerEventAtNextAdvance(name, ...)`, which arrives a frame or more
    later.
- **Register Lua listeners from the view's ready callback** with
  `oUI:AddEventListener(sEvent, nArgs, fn, arg)`. Listeners added any earlier never fire. The
  callback gets `(arg, eventArgs...)`. **proven**
- **Never create or destroy a view inside a ready callback.** It froze the game. **proven**

### Gameface quirks

- **Set `display:flex` explicitly.** Gameface's default differs from a browser.
- **Avoid** CSS grid, `backdrop-filter` and `conic-gradient`.
- **Size with `rem`.**
- **No native scrolling.** The game draws its own scrollbars.
- **`localStorage` is not kept across restarts.**
- **`DataStore.setValue` throws in the retail game.** Data has to come from Lua.
- **Game lists are DataStore collections** (context paths like
  `['hubAnimalsData','animalStorageData','list']`). Their rows are **recycled**, so never attach
  state to a row element.

## 5. Build and install

```
venv\Scripts\python tools\pz2_build_pack.py --cobra-tools <cobra-tools> --python venv\Scripts\python.exe ^
    --src template\MyMod --out build --install "C:\...\steamapps\common\Planet Zoo 2"
```

- **Manifest.** On the first build it writes `Manifest.xml` with a new random ID. Keep that file.
- **The PZ2 header flag.** cobra-tools' Planet Coaster 2 profile writes header byte 4
  (`version_flag`) as `0x00`. **PZ2 only accepts the OVL with `0x01`**, so the script sets it.
  **proven**
- **Round-trip check.** It extracts every OVL it built again and compares it byte for byte with
  your sources.
- **Install only while the game is closed.** The script refuses while `PlanetZoo2.exe` is
  running. **Build fresh before every install.**
- **Uninstall:** delete `Win64\ovldata\<Pack>`.
- **Your own mod:** copy `template\MyMod`, then rename the folder, the file names
  (`database.<pack>luadatabase.lua`, `<pack>.*.lua`), the module names inside them, and
  `Core.sTraceDir`.

## 6. Debugging

- **Breadcrumbs.** Retail PZ2 shows no Lua output, so use the checkpoint tracer (`trace\`):
  - tiny DLLs that `package.loadlib` loads;
  - each one appends a line to `dbg\trace.log`;
  - in Lua, it's just `Core:Mark("name")`.
- **Crash dumps** are in `%TEMP%\Frontier Developments\Planet Zoo 2\CrashDumps\`.
  - Ignore 0-byte files: the crash reporter creates one at every launch.
  - `tools\crashsum.py <dump>` prints:
    - the exception and faulting thread;
    - the faulting module;
    - running time and world;
    - the mod list;
    - every Lua coroutine's stack, which tells you what screen the game was on.
- **Lua panics** (`crash_reason: lua_panic`) are uploaded and their dump is deleted. The full
  report (the error with file:line, the Lua stack, the park) stays in
  `%TEMP%\crash_reporter.exe.log`. Copy it before the next crash overwrites it. **proven**
- **Crash line numbers.** `tools\lua_funcmap.py <file>.lua.bin <line>` maps them to a function
  (section 2).
- **`0xFDEAD` is Frontier's own deliberate fatal error.** The thread it lands on (Render, fTask)
  doesn't tell you the cause. To find it, line up the dump time with your last trace lines.

## 7. Ground rules we follow (recommended)

1. **Never touch the exe or Denuvo:** no patching, unpacking, proxy DLLs or activation bypasses.
2. **Don't redistribute Frontier's files** or decompiled code. Point people at this kit so they
   can extract their own copy instead.
3. **Online (Franchise):** never change what is sent to Frontier's servers.
   - Any automation should be off by default.
   - It should be started by a click, never a timer.
   - It should do one action at a time and stop on errors.
4. **Fail soft:**
   - wrap every hook in `pcall`;
   - check a function exists before wrapping it;
   - hook by name, never by memory offset.
5. **Expect game updates to break things.** Note the game version your mod was tested on.

Frontier doesn't officially support PZ2 mods yet, and the EULA restricts reverse engineering. Mod
at your own risk, keep mods free, and don't use them to cheat in Franchise.

## Credits

- **cobra-tools** (OpenNaja and contributors): the OVL toolkit everything here rests on.
- **luadec** (viruscamp): Lua 5.3 decompiler, bundled with cobra-tools.
- **ACSE** (OpenNaja): the content-pack entry point and require-hook pattern from the earlier
  Cobra games.
- Kit by Mike's Studios, built while making the Mike's QoL Toolbox mod
  (https://github.com/Mikes-Studios/planet-zoo-2-mods).
