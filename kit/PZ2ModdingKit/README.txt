Planet Zoo 2 Modding Kit 1.0.0
==============================

Read Planet Zoo 2's game scripts and UI as source, and build your own mods.
A resource for mod authors: it does not change the game by itself.

Contents
  GUIDE.md                    the full guide: setup, reading the game, how mods load,
                              hooking game code, UI mods, building, debugging
  tools\pz2_unpack.py         extract and decompile the game's Lua (~1,100 scripts)
                              and unpack the full game UI (HTML/JS/CSS)
  tools\pz2_build_pack.py     build a mod folder (Main.ovl + UI overlay) from plain
                              files, verify it, and install it
  tools\ppuipkg_unpack.py     turn a cobra-tools .ppuipkg dump into real files
  tools\lua_funcmap.py        map a crash report's Lua line number to a function
  tools\crashsum.py           summarise the game's crash dumps (Lua stacks included)
  trace\                      checkpoint tracer (C source) for logging from mod Lua
  template\MyMod\             a minimal working mod: entry point, require hook,
                              park-manager and mode hooks, an example patch

Quick start (details in GUIDE.md)
  1. Python 3.11 and a clone of cobra-tools: https://github.com/OpenNaja/cobra-tools
       py -3.11 -m venv venv
       venv\Scripts\pip install "imageio>=2.26.0" "numpy>=1.26.4,<2.0.0" "pillow>=10.0.1" "bitarray~=2.9.2"
  2. Read the game (about two minutes):
       venv\Scripts\python tools\pz2_unpack.py --cobra-tools <cobra-tools> --game "<Planet Zoo 2 folder>" --out C:\pz2-source
  3. Build and install the template mod (game closed):
       venv\Scripts\python tools\pz2_build_pack.py --cobra-tools <cobra-tools> --src template\MyMod --install "<Planet Zoo 2 folder>"
     Uninstall: delete <Planet Zoo 2 folder>\Win64\ovldata\MyMod

Rules
  - Nothing here touches PlanetZoo2.exe or its DRM; it only reads the game's data archives.
  - What you extract is Frontier's: read it, don't upload it.
  - Leave Franchise (online) play alone; see GUIDE.md section 7.

Tested on Planet Zoo 2 1.0.5 (build 1023906). Unofficial; not affiliated with Frontier
Developments. Credits: cobra-tools (OpenNaja and contributors), luadec (viruscamp), ACSE.
License: MIT (LICENSE.txt), for the kit's own files.
