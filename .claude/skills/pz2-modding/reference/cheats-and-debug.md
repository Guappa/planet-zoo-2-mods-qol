# Cheats and developer debug features (vanilla)

Game 1.0.5 (build 1023906). All **offline** (decompiled Lua and unpacked UI, 2026-10-17) unless marked.

## Rename cheats (the only player cheats)

`Managers.CheatManager` (`managers.cheatmanager.lua`) listens to `MsgType_UserRenameMessage`.
A rename whose name matches (lower-cased, exact, so no leading/trailing spaces) runs the cheat and
plays `GUI_Cheat_Activated`. Each cheat is bound to a rename type from the native `cheats` world API
(`RenameMessage_Type_*`); only Animal and Guest have cheats.

| Name | Rename a... | Effect (from the native call's name) |
|---|---|---|
| `MeggieB` | habitat animal | `SetCheatPlushieness`: that animal turns into a plush toy (guess on visuals) |
| `EmmaK` | habitat animal | `SetCheatFluffiness`: that animal gets extra fluffy |
| `DaveyT` | habitat animal | `SetCheatRandomColourOverride`: random colour |
| `DaveyT#RRGGBB` | habitat animal | `SetCheatColourOverride`: that hex colour (pattern `^daveyt#%x%x%x%x%x%x$`) |
| `PhillyCam` | habitat animal | `SetEnableAllFirstPersonCameras(true)` for the scenario, then first-person follow-cam on that animal |
| `MontseC` | habitat animal | `animals:SetPerformMatingParticleEffect()` (park-wide) |
| `GemmaW` | habitat animal | `animals:SetPerformAlternateSpitEffect()` (park-wide) |
| `KilianS` | habitat animal | `animals:SetPerformAnimalEmotes()` (park-wide) |
| `DaveBamber` | habitat animal | `PlayerInteractionHandler:EnableEnrichmentInteraction()`: clicking an enrichment item calls `habitat:EnrichmentInteractionCheat(entity, hitPos, -normal)` (pushes it, guess) |
| `SelenaM` | guest | `guests:GiveBalloonsCheat()` |
| `JayC` | guest | `guests:ReleaseBalloonsCheat()` |

- Loaded in every park (`environments.darwinenvironment.lua:48`, no mode check), **Franchise
  included**. Franchise routes: habitat animal info panel (`components.ui.animalinfopopup.lua:3991`),
  Animals management list (`editors.park.animaldatabasetab.lua:1370`), non-VIP guest panel
  (`components.ui.guestinfopopup.lua:195`). Not: shoal panel in Franchise, exhibit animals (renamed
  via `SetExhibitAnimalNameUsingUID`, no message), hub Storage/Market renames.
- UI limits don't block any: info panel max 30 chars, management list 1024; only `|` is rejected
  (`InputFieldBase.js:225`).
- Effects are native; whether they change what Franchise sends to the server is unknown.
- Unused Planet Coaster 2 leftovers in the same file, no callers: `MaximiseXYBoundary`,
  `MaximiseZBoundary`, `SetSpawnRates`, `SetCoasterFriction`.

## Native cheat functions with no Lua caller

From exe strings (offline; whether they work in PZ2 is a guess). Reachable only from a mod:
- `cheats` API (`Game::LuaScript::API::Cheats`): `UnlockScenery`, `TriggerGuestNausea`,
  `SetPathClutterEnabled`, `SetSecurityChaseCollisionsEnabled`,
  `AddGuestForSpeedBoostRacingCheat`, `AddRideForUserControlledRacingCheat` (PC2 leftovers);
  `TrainStaffMember` is the only one Lua calls.
- `guests:ExplodeGuestsCheat`, `research:SetUnlockAll` (treat as server-relevant in Franchise).
- 16 `RenameMessage_Type_*` exist natively; Vendor, TemperatureModifier, TransportRide,
  TrackedRide, Entertainer, FlatRide are never sent by Lua.
- Plushie strength per species: `animals.fdb` table `Visual_CheatVariables(AnimalType,
  PlushieVariable)`, 85 species, 0.01-0.1 (`animals:GetCheatData`). `Cheat_Valentine_Hearts_SizeA-D`
  and `Cheat_Emote_*` are the MontseC / KilianS effect names.
- Config.ovl (38 xmlconfigs) and the English Loc.ovl hold nothing that toggles cheats; there is no
  "cheat activated" text, only the sound.

## Sandbox settings (not cheats)

Unlimited cash/CCs, research off, fully trained staff, power everything, guest infinite cash:
`helpers.parksettingsdata.lua:118-705`, menu shown only in Sandbox (`windows.sandboxoptionsmenu.lua:90`).
Franchise uses `parksettings.defaults.franchise_parksettings.lua`; no player route changes it.

## Developer features (not reachable in retail)

- **`api.debug.IsDebugAllowed()` is hard-wired `false` in retail.** The exe embeds Lua that
  replaces `IsDebugAllowed` and `IsMobiusAllowed` with `return false`, makes `Assert` a no-op and
  `CreateDebugTweakable` return its default ("Disabled in non-debug builds."; exe strings at file
  offset ~0x33468b8). The API table is locked ("Scripts may NOT modify the API, by design."). It
  gates: debug tabs in info popups (kill/infect/tranquillise/make adult; free animals at habitat
  gates and exhibits; staff energy/happiness/perk and `cheats:TrainStaffMember`; guest needs and
  cash), the build menu "Development" tab, terrain debug brushes, SceneryDebugManager,
  BlueprintDebugSaveManager, ScenarioEditManager, debug input contexts (DebugCamera_*,
  Animatronics_*). Dev modules it would load are missing from retail anyway.
- Only the debug tab's *creation* is gated; the handlers and the debug editor modes
  (`DebugSpawnAnimal` etc., `gameeditormodes.lua:121-164`) exist in retail. A mod could reach them,
  but repo rules forbid that in Franchise (it changes what is sent to the server).
- **Launch args** read by Lua: `-unlockScenarios` (all career scenarios), `-showavatarrewards`,
  `-usedebugcamera`, `-loadpark/-loadzoo`, `-gameMode`, `-nointro`, `-skipScenarioIntro`, ... Retail
  Lua did not see a Steam launch option (`-autosaveinterval`, proven 2026-10-16, debugging.md), so
  these probably do nothing. Native (engine-parsed) options in exe strings include
  `-disableComplexityLimit` (ComplexityManager) and `-logavailableargs` ("Lists the available
  Casino commandline args"); one launch with the latter would show what retail accepts (untested).
- **Console commands** (`api.debug.RegisterShellCommand`, 73 uses: `CompleteObjective`,
  `CompleteAllChallengeObjectives`, `ToggleLockedScenarios`, `ResetScenario`, ...). No retail UI to
  type them into.
- **ImGui windows** (`api.debugui`, ~32), incl. `helpers.franchisedebugwindow.lua:303`
  `franchise:Debug_SetCC` (server-side CCs). Nothing in Lua opens them.
- **Gameface dev tools** are bundled into HUD/Frontend/Bible (`common/debug/DebugToolImports.js`).
  Their `GamefaceDebug_*` engine inputs (Ctrl+Numpad 0-9, e.g. DebugActionsViewer Ctrl+Numpad9)
  have no visible binding. Most DOM key handlers need `Engine.isCoherentPlayer()` (false in game).
  `DS.setValue` throws in game, so the Currency debug tab can't change money anyway.
  Exception: **Alt+S** opens the read-only Debug Color Scraper with no gate (unchecked in game).
- Name mismatch: UI tab flag `['Debug'].debugDevTabEnabled` vs Lua `debugDevEnabled`
  (`windows.mainhud.lua:2278`).
