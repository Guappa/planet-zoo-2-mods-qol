# Archives, packs, build and install

## Game install (game 1.0.4, build 1018486)

- Steam app **3219030**. Exe `PlanetZoo2.exe` (Denuvo Anti-Tamper, no anti-cheat). **proven**
- Game data lives in `<game>\Win64\ovldata\`. Base content is in `GameMain` and `Content0`. **proven**
- Machines used here:
  - local: `D:\SteamLibrary\steamapps\common\Planet Zoo 2`;
  - second PC: game at `Y:\SteamLibrary\...` from here (it sees it as `D:\`), its system drive
    is `X:` (user `micha`).

## OVL archives

- Header `FRES` v20, user_version 8724 (Oodle). **offline**
- cobra-tools (https://github.com/OpenNaja/cobra-tools) opens them with the **Planet Coaster 2**
  profile. **proven**
- After building with cobra-tools, set **header byte 4 (`version_flag`) to `0x01`**, or the game
  won't treat the OVL as PZ2. **proven**
- A few PZ2-only types fail to parse in cobra-tools (`wildterritorysettings`, `HelpNode` arrays).
  They don't matter for mods. **offline**
- Game Lua is 5.3 bytecode with a Frontier header (format byte 0x02, 32-bit float `lua_Number`),
  not obfuscated. cobra-tools' bundled `luadec` decompiles it. About 40% of files have partial
  `DECOMPILER ERROR` blocks, but they are readable. Line numbers in decompiled files don't match
  the line numbers in crash reports. **offline**
- Game UI ships as a **`.ppuipkg`** inside an OVL. cobra-tools dumps it as XML;
  `tools/ppuipkg_unpack.py <file.ppuipkg> <out>` turns that into real HTML/JS/CSS. **proven**

## Content pack layout

```
Win64\ovldata\<Pack>\
  Manifest.xml        <ContentPack version="1"><Name>..</Name><ID>guid</ID><Version>1</Version><Type>Game</Type></ContentPack>
  Main.ovl            plain-text Lua modules (the game compiles them at load)
  UI\<Pack>UI.ovl     optional UI overlay (.ppuipkg of HTML/JS/CSS)
  dbg\                debug builds only: trace DLLs + trace.log (see debugging.md)
```

- Lua module file names are dotted and lower case, e.g. `pz2qol.hub.lua` → `require("PZ2QoL.Hub")`,
  and `database.pz2qolluadatabase.lua` is the entry point. **proven**
- The game shows a one-time "modifications detected" notice. Crash reports list the pack under
  "Game is modded / Mods added". **proven**

## Getting game sources to read

- Use cobra-tools to extract `GameMain`/`Content0` `Main.ovl`, then decompile the Lua with luadec.
  Extract the UI OVL and unpack its `.ppuipkg` with `tools/ppuipkg_unpack.py`.
- Keep extracted game code **out of the repo** (scratchpad only). Never commit or ship it.
- Useful files:
  - `game.gamescript.lua`: overlay load and unload, shutdown.
  - `ui2.viewwrapper.lua`: views and events.
  - `ui.controllers.*`: per-view controllers and their `AddListener_*` events.
  - `startscreen.globe.*hubmode.lua`: hub screens.
  - UI side: `js/project/modules/*`, `js/project/data/Schemas/*`.

## Build and install (PZ2QoL)

```
python tools/build_pz2qol.py --cobra-tools <cobra-tools dir> --python <venv python> \
    [--out <dir>] [--install "<game dir>"] [--debug-trace]
```

- Builds `Main.ovl` and the UI overlay. **It extracts every OVL again and compares it with the
  sources**, so a mismatch aborts the build.
- `--debug-trace` compiles `tools/trace/pz2_trace.c` with MSVC (`vcvars64.bat`) and adds
  `dbg\cp_<name>.dll`, one per line of `tools/trace/checkpoints.txt`.
- Release zip: `Win64/ovldata/PZ2QoL/...` with forward-slash paths, plus `README.txt`, in `dist/`
  (gitignored).

## Pitfalls

- **Build fresh right before installing.** Copying an old `build/` once installed a stale mod.
- **Install only while the game is closed.** `PlanetZoo2.exe` can't be opened for writing while the
  game runs, which is a reliable "is it running" check, including over a network drive:
  `python -c "open(r'<game>/PlanetZoo2.exe','r+b').close()"`. To install later, run a background
  loop that waits for that check to pass.
- **Stray `%SystemDrive%` folders.** Tools run from Git Bash on this machine create a
  `%SystemDrive%\ProgramData\Microsoft\Windows\Caches` folder in the current directory, including
  inside `mods/`. It caused a "round trip mismatch" build failure. Delete them
  (`find . -name "%SystemDrive%" -prune -exec rm -rf {} +`); `.gitignore` already lists them.
- Some repo files have CRLF line endings, so exact-text edits from scripts can miss. Normalise or
  rewrite the file.
- **Copying to the second PC's `Y:` drive can silently come up short.** A plain `rm -rf` + `cp -r`
  over the network share once left `UI\PZ2QoLUI.ovl` and most `dbg` DLLs missing while reporting
  success. After any install there, compare every file by hash (sha1) against the build and
  recopy the ones that differ (2026-10-15). `tools/install_pz2qol.py <build>/PZ2QoL <game> --wait`
  does exactly that (and saves the old `dbg/trace.log`). Both install paths keep the player's
  `userdata.json` in the pack folder; never delete it when updating.

