# Planet Zoo 2 Mods

Groundwork for a script-injection modding harness for Planet Zoo 2 (Frontier Cobra engine).

- `docs/FEASIBILITY.md`: findings, recommended approach, risks, next steps.
- `poc/`: proof-of-concept content pack `PZ2Harness`.
  - `PZ2Harness/Main/database.pz2harnessluadatabase.lua`: the game runs this through its own `Database.<Pack>LuaDatabase` hook.
  - `native/pz2h_native.c`: a probe DLL loaded via `package.loadlib`. It writes `pz2h_native.log` next to itself.
  - `build.ps1`: builds the DLL (MSVC) and `Main.ovl` (cobra-tools). `-Install` copies the pack into the game.

Uninstall: delete `<game>\Win64\ovldata\PZ2Harness`.
