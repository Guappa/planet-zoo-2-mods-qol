# Planet Zoo 2 modding: feasibility report

Investigated 2026-10-14 against Steam build 25834091 (PlanetZoo2.exe link time 2026-10-09).

## Verdict

**Feasible, without decrypting or patching the exe.** PZ2 is a Cobra-engine game with the same
content-pack + Lua 5.3 architecture as Planet Zoo 1, Planet Coaster 2 and JWE3, all of which
already have script-injection mods (ACSE). A mod is a folder dropped in `Win64\ovldata\`; the
game itself runs the mod's Lua, and that Lua can load a native DLL through `package.loadlib`.

## What was verified locally

| Question | Result |
|---|---|
| Archive format | OVL/OVS, header `FRES` v20, user_version 8724 (Oodle), version_flag 1. Identical to cobra-tools' **Planet Coaster 2** profile. |
| Archive encryption | None. cobra-tools (master, 2026-10-13) opens PZ2 OVLs as PC2; only a few new PZ2-only types (`wildterritorysettings`, `HelpNode` arrays) fail. |
| Script format | Lua 5.3 bytecode with a Frontier header (format byte 0x02, 32-bit float `lua_Number`). Not obfuscated. |
| Decompiling | cobra-tools' bundled luadec decompiles it: 245 GameMain + 872 Content0 modules extracted. About 40% have partial `DECOMPILER ERROR` blocks, but the code is readable. |
| Mod entry point | `Database.Main.InitContentToCall` calls `tryrequire("Database." .. sPackName .. "LuaDatabase")` for **every loaded content pack**. `Game.BaseGame` also loads `Databases.<PackName>`. Same hooks ACSE uses on PZ1/PC2. |
| Native code | The exe contains the full Lua `package` library (`loadlib`, C searcher, `LUA_CPATH`). There is no `io` library. Not yet confirmed at runtime that `package.loadlib` is reachable from game Lua. |
| Exe protection | **Denuvo Anti-Tamper**: entry point in a 395 MB RWX section, section names shuffled. Steam page confirms it. No anti-cheat (no EAC/BattlEye). |
| Online | Single-player. Franchise mode and Frontier Workshop are online. The game will not start offline until this build has activated online once (seen 2026-10-14, also without any mod installed). |

## Recommended approach: a Lua-first harness modeled on ACSE

1. **Loader pack** (`PZ2Harness`): a content pack whose `Database.PZ2HarnessLuaDatabase` wraps
   `global.require` / `global.tryrequire` (as ACSE's `acse.global.lua` does). It then gives mods:
   - module hooks: patch any game module when it is first required;
   - manager injection into game environments (`environment.environment.lua` builds the manager lists);
   - extra databases and settings through `AddContentToCall` / `CallOnContent`.
2. **Mod packs**: each mod is its own content pack folder with a `Manifest.xml` and a `Main.ovl` of
   **plaintext** Lua. The game compiles source at load time, as ACSE does, so mod authors do not need
   Frontier's custom bytecode compiler.
3. **Optional native layer**: a DLL loaded with `package.loadlib` for logging, file I/O and a dev
   console (as ACSEDebug does), and later for function hooks. The exe exports no `lua_*` symbols, so
   the DLL needs signature-scanned Lua C API addresses or must read `lua_State` directly.
   Keep this layer optional.
4. **Tooling**: upstream a "Planet Zoo 2" profile to cobra-tools (version_flag 1, PZ2 hash dump,
   new loaders). Ship a pack builder (see `poc/build.ps1`).

Do **not** pursue: exe unpacking or decompilation (Denuvo; unnecessary), proxy DLLs (`dinput8`
etc.), or anything that touches Franchise / online data.

## Risks

- **Legal / EULA**: the PZ2 EULA §3.1(b)/(c) forbids reverse engineering and "mods or other
  unauthorised software", and Frontier's mod policy says mods are not permitted until Frontier
  ships official tools. In practice Frontier has never taken down ACSE or Nexus mods for PZ1, JWE or
  PC2. Keep it free and non-commercial, ship no Frontier assets or decompiled game code, and do not
  redistribute the exe.
- **Denuvo**: content packs and `package.loadlib` don't touch the protected code. Inline hooks on
  exe code are riskier, because Denuvo checks code integrity in some places. Never try to bypass the
  online activation.
- **Engine updates**: every patch can rename Lua internals or change OVL formats. The ACSE README
  warns about this, and cobra-tools needed fixes after PC2 update 11. Hook by module or function
  name, fail soft with `pcall`, and version-gate.
- **Online features**: modded games connecting to Franchise and the Workshop risk account action
  (unverified). The harness should detect online modes and stay passive there.
- **Saves**: mods that add content can make saves depend on them. The loader must not write to saves.

## Next steps

1. Launch PZ2 **once with Steam online** so Denuvo activates the current build. Then launch with
   `PZ2Harness` installed and check `Win64\ovldata\PZ2Harness\pz2h_native.log`.
   - If the log has `pz2h_hello called`, then Lua injection and native loading both work.
   - If the log is missing, check whether the Lua ran: find where `api.debug.Trace` goes, or add a visible UI side effect.
2. Port ACSE's `acse.global.lua` require hook and manager injection to PZ2 and test one manager in a zoo.
3. Build the dev DLL: a log file and a Lua console, with Lua API resolved by signature scan.
4. Contribute PZ2 support to cobra-tools (profile, hashes, new formats).
5. Write the mod-author template and docs, then publish on Nexus once Nexus opens a PZ2 section.
6. Check with the Frontier Modding Club Discord (https://discord.gg/Su4jXKk) whether an ACSE port for PZ2 is already in progress.

## References

- cobra-tools: https://github.com/OpenNaja/cobra-tools
- ACSE: https://github.com/OpenNaja/ACSE (source covers PZ1/PC1/JWE/JWE2; PC2/JWE3 builds are on Nexus)
- PZ2 EULA: https://store.steampowered.com/eula/3219030_eula_0
- PZ2 Steam page (Denuvo notice): https://store.steampowered.com/app/3219030/Planet_Zoo_2/
