# Archives, packs, build and install

## Game install (game 1.0.4, build 1018486)

- Steam app **3219030**. Exe `PlanetZoo2.exe` (Denuvo Anti-Tamper, no anti-cheat). **proven**
- Game data lives in `<game>\Win64\ovldata\`. Base content is in `GameMain` and `Content0`. **proven**
- Machines used here:
  - local: `D:\SteamLibrary\steamapps\common\Planet Zoo 2`;
  - second PC: game at `Y:\SteamLibrary\...` from here (it sees it as `D:\`), its system drive
    is `X:` (profiles under `X:\Users\`).

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
- One command does all of it: `kit/PZ2ModdingKit/tools/pz2_unpack.py` (the public Modding Kit,
  see below). Facts it relies on, all **proven** on 1.0.5 (2026-10-16):
  - `ovl_tool_cmd.py extract` does **not** decompile: it writes `*.lua.bin` (the config's
    `lua_decompile` isn't set in the CLI). Run `luadec.exe <file>.lua.bin` yourself (with `-s` as a
    fallback). `--type .lua` / `--type .ppuipkg` limits an extract to one type (seconds instead of
    a full extract).
  - 1.0.5 counts: 1,117 scripts (GameMain 245, Content0 872). 461 are clean, 631 have
    `DECOMPILER ERROR` blocks, and 25 fail outright ("memory allocation error: block too big",
    e.g. the `peep*.lua` files).
  - The game UI package is in **`GameMain\Content\UserInterfaceEssentials.ovl`** (a 252 MB
    `.ppuipkg` XML, 1,852 files). The `Content0\UI\UserInterfaceImages*.ovl` hold the icons.
  - Pass `-o <dir>` to `ovl_tool_cmd.py extract`, or it writes next to the OVL (inside the game
    folder). A copy of cobra-tools sits in an old scratchpad:
    `...\Temp\claude\C--Github-Planet-Zoo-2-Mods\a5756abe-49da-4666-a235-008cb1e4b99f\scratchpad\ext\cobra-tools\`.
  - `kit/PZ2ModdingKit/tools/lua_funcmap.py <file>.lua.bin <line>` automates the
    crash-line-to-function mapping (see debugging.md).

## Public Modding Kit (`kit/PZ2ModdingKit`)

- A Nexus resource for other modders: guide, unpack/build tools, the `MyMod` template (PZ2QoL's
  Core require/manager/mode hooks, trimmed), crashsum, lua_funcmap, and the tracer as C source
  only. It holds no Frontier files.
- Zip it with `python tools/build_modkit.py <version>`, which writes
  `dist/PZ2ModdingKit-<version>.zip` and refuses any file type other than md/txt/py/c/lua. The
  Nexus page text and images are in `dist/modkit/`.
- The template is checked by a build round trip and a Lua mock, not yet in game.
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
  **Pitfall (2026-10-19):** Windows Python run with its working directory inside the repo can leave
  an empty `%SystemDrive%\ProgramData\Microsoft\Windows\Caches` folder there (the variable is not
  expanded). One under `mods/PZ2QoL/Main` fails the check with "Main.ovl round trip mismatch:
  %SystemDrive%". Delete such empty folders under `mods/` before building, and run Python scripts
  from the scratchpad.
- `--debug-trace` compiles `tools/trace/pz2_trace.c` with MSVC (`vcvars64.bat`) and adds
  `dbg\cp_<name>.dll`, one per line of `tools/trace/checkpoints.txt`.
  It also adds the 98 `dbg\lg_*.dll` copies of the detailed log (`lg_20`…`lg_7e`, `lg_clr`,
  `lg_end`, `lg_core`; `debugging.md` "Detailed log"). Each copy is ~140 KB (`/MT`).
- Release zip: `Win64/ovldata/PZ2QoL/...` with forward-slash paths, plus `README.txt`, in `dist/`
  (gitignored), named `PZ2QoL-<version>.zip`. The build script does **not** zip: build without
  `--debug-trace` (to `--out <dir>`), write a `README.txt` (staged in `dist/stage-<version>/`), and
  zip with Python's `zipfile` (arcnames `Win64/ovldata/PZ2QoL/<rel>`). Bump the version in
  `js/mods/pz2qol/main.js` (`VERSION`) and `pz2qol.core.lua` (`Core.sVersion`); the Manifest's
  `<Version>1</Version>` is the pack format, not the mod version. Nexus page text lives in `dist/`.
- Release tags: every Nexus release gets an annotated `vX.Y.Z` tag on the commit whose
  `mods/PZ2QoL` source is what the zip ships (rule in `CLAUDE.md`). Tagged so far: v3.0.0,
  v3.0.1, v3.0.2. Releases 1.1.0–2.1.0 have no matching commit (their source was never committed
  as shipped). To check a zip against a commit, extract `Main.ovl` (Lua) and the UI overlay
  (`ppuipkg_unpack.py`) and compare file contents with CRLF folded to LF; release zips are not
  byte-reproducible by rebuilding (OVL sizes differ between builds of the same source).
- Nexus page images (audited 2026-10-19, `artifacts/nexus-imagery-20261019/before/FINDINGS.md`):
  the **thumbnail is the first gallery image** (no separate slot; gallery recommends 1920×1080,
  .jpg/.png/.gif, 8 MB). Browse/search/profile cards are ~280×158 **contain**, so a square
  thumbnail wastes 44% of the card. The landing Trending tile is 16:9 **cover** with a caption
  gradient over its bottom ~30%. The tracking centre stretches it to 100×60; phone search shows
  56×56. The **header** is its own slot, recommended **1300×372**, `object-fit: cover`. Nexus
  draws breadcrumbs, title and stats over its lower left and the action buttons along the bottom
  right; phones keep only the centred ~646 px. So no lettering in the header and the emblem
  upper right. `og:image` is a 385 px derivative of the thumbnail. Sources: `art/nexus/`
  (`compose.py`, `preview/mock.html` placement mock).

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
- **Two waiting installers race (2026-10-17).** Two sessions each had `install_pz2qol.py --wait`
  queued for `Y:`. When the game closed, both copied at once and the older build won: every file
  differed from the other build afterwards, and its hash check failed after 3 passes. Before
  queuing an install, ask the conductor who owns `Y:` installs. If an install fails with every file
  differing, find whose build is there by comparing `Main.ovl`'s sha1 with the other sessions'
  build folders.
- **The game can start in the middle of an install (2026-10-17).** `--wait` saw the game closed and
  began copying; the developer relaunched 40 s later. `Main.ovl` and the UI OVL (copied first, in
  sorted order) were in place before boot, but the game then held the `dbg` DLLs and the install
  stopped with `PermissionError` on one of them. Check what landed (`cmp` each file against the
  build, and the OVLs' mtimes against `cp_boot` in the trace); only the trace DLLs were stale, which
  are rebuilt copies of the same marks. Tell the developer before an install starts, and reinstall
  with `--wait` after the next close.
- **Copying to the second PC's `Y:` drive can silently come up short.** A plain `rm -rf` + `cp -r`
  over the network share once left `UI\PZ2QoLUI.ovl` and most `dbg` DLLs missing while reporting
  success. After any install there, compare every file by hash (sha1) against the build and
  recopy the ones that differ (2026-10-15). `tools/install_pz2qol.py <build>/PZ2QoL <game> --wait`
  does exactly that (and saves the old `dbg/trace.log`). Both install paths still keep a
  `userdata.json` in the pack folder (from the old file store; PZ2QoL keeps its data in park saves
  now, so the mod never writes one).

