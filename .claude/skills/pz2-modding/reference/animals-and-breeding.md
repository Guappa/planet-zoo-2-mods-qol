# Animals, lineage and inbreeding (game 1.0.4)

All **offline** (decompiled Lua under `src/Content0/`, unpacked UI) unless marked otherwise.
Used by the proposal `docs/PROPOSAL-inbreeding-qol.md`.

## How the game decides "inbred"

- The only check is Lua: `CompareMatesPopup.CompareParentsForInbreeding`
  (`editors.animal.comparematespopup.lua`). It flags a pair when one is a parent of the other or
  when they share a parent (full or half siblings). It does **not** flag grandparents,
  aunts/uncles or cousins.
- No native "are related" or kinship-coefficient call exists, in Lua or in the exe's API names.
  The only inbreeding strings in the exe are `InbreedingRisk`, `InbreedingImminent`,
  `PregnancyInbreeding` and `VM_InbreedingRisk`.
- The result is written only for the selected pair, to `['compareMates','offspring']` →
  `inbred`. The UI then shows `[AnimalExchange_Inbred]` (`OffspringDisplay.js`).
- Market listings return `{}` for parents, so they are never flagged.
- The genetic cost: fertility and immunity grades count the loci where an animal's two allele
  strands differ (`CompareMatesUIUtils.GetMinMaxGeneGrades`). Related parents share alleles,
  which lowers their offspring's fertility and immunity. The UI prediction is in code; that the
  native breeding uses the same rule is **inferred**.
- A **0% fertility** (or immunity) grade means both strands are identical at all 6 loci, which is
  what deep inbreeding produces. Such animals pass identical strands on, so their young score low
  too. The developer saw them survive Thin out (2026-10-16) because it only used the average gene
  score; `kincull.js` now sends them away from every habitat by default (`zeroFertility`,
  `fertilityGene()`). **offline** (grade rule from `ownGrades()` in `kincore.js`)

## Lineage APIs (`api.world.GetWorldAPIs()`)

- `animals:EntityIDToAnimalGUID(e)` / `AnimalGUIDToEntityID(guid)`: return 0 if absent.
- `animals:GetParents(guid)`: a table of parent GUIDs, with `""` for an unknown parent.
  Synchronous and local. Works in park and in the hub for storage animals (ID type 2).
  Whether it still answers for dead or traded animals is **open**.
- `exhibits:GetAnimalFamilyMemberUID(uid, 0|1)`: parent 1 or parent 2 of an exhibit animal.
- Collective species (shoals, colonies such as butterflies) breed as one group, so Kin leaves them
  out. The game's own checks take the species symbol (`sSpecies` of `GetUIAnimalListDataForIDs`):
  `animals:IsSpeciesABoid(sp)` (shoals) and `exhibits:IsColonySpecies(sp)` (returns colony,
  aquatic boid, air boid), as `ParkRatingManager` and `ExhibitAnimalInfoPopup` use them. In
  storage and market rows the flag is `isShoal`, which the exhibit popup also sets for colony
  animals. Kin sends `speciesFacts[sp].collective` (`pz2qol.kin.lua` `_SpeciesFacts`) and skips
  those species in `buildKinModel` and the Species board list; storage skips `isShoal` rows
  (`kinstorage.js`). **offline** (1.0.5 decompiled Lua; not yet seen in game).
- `franchise:RequestAnimalData` / `GetAnimalData`, `RequestFamilyTreeData` /
  `GetAnimalFamilyTreeData`, `GetAnimalChildren`: **asynchronous** (the reply arrives via
  `MsgType_LocalAnimalDatastoreUpdatedMessage`) and may need the server in Franchise. Don't use
  them for bulk scans.
- `animals:GetMateData(e)` returns `{bIsBeta, bIsMonogamous, tMateData={{nID,sName,nGender}}}`.
  `GetRelationship(a,b)` is the social bond, not kinship.
- **Compare Mates' "can't conceive" verdict** (`CompareMatesPopup._SetOffspringData`, **offline**, 1.0.5):
  `state = NEGATIVE` when either animal's `GetMatingWarnings(id, type).bMatingBlocked`, or the
  best-case conception chance is 0, or either `animals:GetMatingMonogamyIcon(self, other,
  otherIdType)` is `"IconLock"` (checked both ways; `"ring"` = they are mates). `inbred` is worked
  out separately, so the game itself keeps "related" and "can breed" apart. A contraception-only
  warning is `tWarningsArray[1] == "IconFailedConception"`.
- **A monogamous bond outlives the mate's presence** (`AnimalInfoPopUp._UpdateBondedMateData`,
  **offline**): `tMateData[1]` is still listed when the mate is dead (`IsInDeathState`), has left the
  zoo (no assigned habitat) or was moved (`not IsInHabitat` or another assigned habitat). The panel
  then shows a broken-bond timer, `GetCurrentMournTimeForUI(e)` → `sText, nMournTime`. So PZ2QoL's
  `mateIds` (`pz2qol.kin.lua`) can include absent or dead mates. Whether `IconLock` still applies
  while mourning, and whether it ends with the timer, is **open** (needs an in-game probe).
- **PZ2QoL uses this as "Bonded elsewhere"** (severity `held`, 2026-10-16; `docs/PLAN-pair-bonds.md`).
  - Lua's bond pass (`Kin._BondStep`, after every animal is read, `Kin.nBondPerFrame` calls per
    frame) runs for monogamous adults with a mate. Each one gets `GetMatingMonogamyIcon(e, mate, 0)`
    (the `ring` check) and `GetMatingMonogamyIcon(e, o, 0)` against every other adult of its species
    in its habitat with a compatible sex. It records `bond = { mate, ring, lock: [ids], mourn }` and
    the snapshot gets `bondsOk`. If the call is missing or every call fails, `bondsOk = false` and no
    bonds are recorded. Debug builds log the outcome as marks (`kin_bonds_ok|none|some_failed|unavailable`,
    `kin_bonds_locks|no_locks`) when it changes; `trace()` text never reaches `dbg/trace.log`.
  - The JS rule is `kincore.js` `bondHold`/`bondIntact`. A risk or close-kin pair is held only on
    a lock from either side **and** while the bonded mate is alive, in the model and in the same
    habitat. A mate at the vet or in transport is in no habitat list, so Lua also sends
    `bond.here`: `GetAssignedHabitatEntityID` is the same for both and `IsInDeathState(mate)` is
    false. That keeps the hold (but not when the mate is in the trade centre). Otherwise the pair
    stays a risk (fail-safe: a mourning animal is warned about).
  - `newRisks` gives "Bond ended" only when the bond really broke. A missing lock with the bond
    still whole gives no alert.
  - Plans clear the bond of moved animals and of their mates (`plannedSnapshot`), and a rebuilt
    model keeps `model.opts` (the switch `bondHolds`).
  - **Proven 2026-10-17 (Y:, Franchise zoo, build 1023906):** `GetMatingMonogamyIcon(e, other, 0)` exists
    in retail and returns `IconLock` for real pairs. Trace `kin_bonds_ok` + `kin_bonds_locks` on every
    scan, no failed calls.
  - The lock semantics (I1: only an animal with a mate locks; I2: a lock really means no
    conception) are **guess** until the in-game probe in the plan has been run.
- Decompiled 1.0.5 Lua and unpacked UI from an earlier session were left in a scratchpad
  (`%ProgramData%\ao-home\AppData\Local\Temp\claude\C--Github-Planet-Zoo-2-Mods\96a3309f-…\scratchpad\unpack\lua\Content0`);
  that is temporary, so unpack again if it's gone.
- `animals:GetGenes(e)` returns 12 alleles per stat (strand A = 1..6, B = 7..12).
  `GetGeneticGrades(e)` returns grades from 0 to 1.
- `animals:GetMatingWarnings(id, idType)` is for one animal only; it is not a pairwise
  inbreeding check.
- Compare Mates ID types: 0 entity, 1 listing, 2 GUID, 3 exhibit entity, 4 exhibit UID,
  5 exhibit listing, 6 exchange, 7 markets GUID.
- GUID type (string or number) is **open**; Compare Mates calls `tonumber` on some of them.

## Habitats and per-animal state

- `habitat:GetHabitats()`, `GetAnimalsInHabitat(h)` (entity IDs), and
  `GetSortedAnimalsPerSpeciesInHabitat(h, true)` → `{{sName, tIndividuals}}`
  (`helpers.notificationtasks.lua`, `components.ui.habitatgateinfopopup.lua`).
- `animals:GetAssignedHabitatEntityID(e)`, `IsInHabitat`, `GetGender`, `GetAgeStatus`,
  `IsUsingContraceptive` / `SetUsingContraceptive`, `IsInfertile`, `IsPregnant`, `GetName`,
  `GetSpecies`, `IsAlive`.
- `animals:GetUIAnimalListDataForIDs(tIDs)`: the management list's bulk read (50 per frame). It has
  no lineage or habitat-ID fields.
- Moving an animal goes through `AnimalMovementMode` →
  `animals:AttemptRequestToTransportAnimalToTarget`.

## Bulk animal data

- `animals:GetUIAnimalListDataForIDs(tIDs)` returns `{[entity] = {sName, sSpecies, nGender (0 m, 1 f,
  2 unisex), nAgeGroup (== animals.Juvenile for young), bIsUsingContraceptive, bIsInfertile,
  bPregnant, bAlive, bAlpha, nLocationType, sLocation (habitat or exhibit name, same text as the
  Animals list's location), nLocateEntity, bBoxed, ...}}`. Exhibits have the same call on
  `exhibits` with UIDs from `exhibits:GetAllAnimalIDs()`. **offline** (field names from
  `editors.park.animaldatabasetab.lua`).
- Contraception: the Animals list and info panel both just call
  `animals:SetUsingContraceptive(entity, b)` (exhibits: `SetExhibitAnimalUsingContraceptiveUsingUID`).
- Locate: `CameraModeManager:RequestMode("Orbit", {targetEntityID = nLocateEntity, bLocate = true})`
  then `InfoPopUpComponent:CreateAndOpenInfoPopUpForEntity` (the Animals list's own locate).
- The game's offspring gene prediction (`GetMinMaxGeneGrades`): genes are letters, strand A = 1..6,
  B = 7..12; the young get one strand from each parent (4 equal combinations). Fertility and
  immunity = loci where the two strands differ (0..6); size and longevity = count of 'A'/'B'
  alleles in both strands (0..12). Kin's `predictOffspring` mirrors it.

## UI surfaces and keys

- No row in any list (zoo Animals, Habitats tab, habitat panel, storage, market) has a parent,
  lineage or relatedness field.
- Zoo Animals list row `id` = `"animal_<entityID>"`, or `"exhibit_animal_<uid>"`
  (`AnimalID` in `editors.park.animaldatabasetab.lua`).
- Habitat panel: `...tab_habitatAnimals.speciesList[<species>]` has the male/female counts plus
  `animalsList`. Each row's `id` = `tostring(entityID)`, and it has `warningIcon` /
  `warningsContext` slots (`AnimalStatusItem`).
- Info panel Studbook tab: `tab_animalStudbook` → `familyTreeParentsInfo` /
  `familyTreeSiblingsInfo` / `familyTreeChildrenInfo`, with items `{id, name, gender, inZoo,
  absentLabel, isMate, ...}`.
- Genealogy popup `['genealogy']`: `parents|siblings|mates|offsprings/dataProvider` (GUIDs) give
  one generation each way. It has no location or alive flags. Events: `Genealogy_UI_Select(id)`,
  `_Back`, `_Close`, `_ToggleOffspring`, `_ResetOffspring`. Lua opens it with
  `PopupAction_ShowGeneaologyPopup(bool)` (the game's spelling).
- Compare Mates `['compareMates']`: the `mothers|fathers/<animal_<id>_<idType>>` candidate rows
  carry a `warningIcon` but none of their icons is about kinship. Events:
  `CompareMates_UI_SelectMother/SelectFather(id)` and `_ContraceptionToggled`.
- Heatmap: `InbreedingRisk` (`[HeatMap_Breeding]`, Animals category, sub-index 1) is drawn by the
  engine (`VM_InbreedingRisk`). Select it with `Heatmaps_Select('InbreedingRisk')`. Per-animal
  values can't be read. A Notifications-database entry opens it; that entry's name is **open**.
- `geneticsTooltip` on zoo rows is defined in the schema but no game component renders it.
- Contraception from the UI: `ManagementAnimals_ContraceptionToggled(id, bool)` and
  `InfoPanel_Animal_Contraceptive(bool)`.

## Popups and storage (found while building Kin)

- Genealogy opens via `InfoPanel_UI_Select('genealogy')` (the info panel's animal) or the
  management footer id `'genealogy'`, which only works with exactly one non-exhibit animal
  selected. Its row DS `id` is the GUID (a **number** in JS) or `'unknown'`; the row's DOM root `id`
  is the GUID. GUIDs above 2^53 lose digits as JS numbers: Lua sends them as strings, and the page
  matches numbers as a fallback. **offline**
- Compare Mates lists adults only, sorted by `sortField` (written by Lua `_SortMates`); a row's key
  equals its `id`, `animal_<id>_<type>`. `ParentListItem_leftChildren` is 200 px with overflow
  hidden; `AnimalListButton_root` is `position: relative`; `OffspringDisplay_root` has a fixed
  height of 26.8rem. **offline**
- Storage row roots are `position: absolute` (set inline by the Repeater). The storage info panel
  shows Cancel instead of Send to Zoo when a selected row has `isMoving`. **offline**
- Game popups add `.PopupActionsModule_root.show`; fixed mod overlays (toolbars, toasts) should
  hide while it is there. **proven** in the harness.

## Moving animals (Species board)

- **Trade-centre animals are not in `animalsDataHelpers:GetAllAnimalEntities(AnimalListType_Habitat)`**
  (offline, 2026-10-16). The game reads them separately with
  `AnimalListType_HabitatInTradeCenterWithEntities` (`helpers.notificationtasks.lua`
  CheckNoStaffForDelivery). Kin's scan read only the Habitat list, so newly bought animals never
  reached the Species board or the breeding programme. `Kin._StartPark` now adds the second list
  too (Lua test: animal 7, `lt == "trade"`). In-game check pending.

- **There is no batch move in the game (offline, 2026-10-16).** Every multi-select move is a Lua
  loop of single-animal calls:
  - The Management Animals Move button (`editors.park.animaldatabasetab.lua:701`) opens
    `AnimalMovementMode` with `tSelectedAnimals`.
  - `HabitatAnimalDestinationSelected` (:736) then runs `CanTransportToEntity(false, dest)` once.
    It claims boxing for every animal that doesn't need staff; if any is already claimed it moves
    none. Then it loops `AttemptRequestToTransportAnimalToTarget(e, dest, nType)`, stops at the
    first failure, and keeps the claims on success.
  - Bulk trade-centre send, Sell and Release (`RelocateAnimalsPopup`) are loops too.
  - The exe's animals API has no list-taking transport.
  - The only list hand-over is the hub's `planetHub.StorageUISetAnimalsToBeSentToZoo(tIDs, bReturn)`
    (`AnimalStorage_SendToZoo`), a queue that `SelectMode` reads in the park via
    `park:GetAndClearPendingSendToZooEntityIDs()`.
  - So a mod's "group move" is the same loop in Lua (one event from JS, one destination). Opening
    the game's movement mode remotely is not recommended: it is mouse-driven, yields, and is where
    the 1158 crash happens. Batching doesn't reduce server traffic (**guess**).

All **offline** (decompiled `editors.animal.animalmovementeditmode.lua`,
`editors.animal.relocateanimalspopup.lua`, `components.ui.animalinfopopup.lua`); Lua mock tested.
- **Valid destinations** (`AnimalMovementEditMode.UpdateValidDestinations`): every
  `habitat:GetAllCompleteHabitats()` entry where `editors:IsValidTutorialPlacement(h, false)` and
  `animals:IsValidHabitatForAnimalsGUID(h, {guids})` hold, except an aquarium whose gate is above the
  water (`habitat:IsAquarium`, `IsAquariumGateBelowWaterLevel`). Quarantines
  (`facilities:GetQuarantines()`) and exhibits (`exhibits:IsExhibitValidDestination`) are separate.
  On hover the mode also checks `staff:CanStaffDeliverAnimalToFacility(entity, h)` (reachability).
- **The move** (`HabitatAnimalDestinationSelected`): `bCan, nType = animals:CanTransportToEntity(false, h)`;
  for animals with `DoesTransportRequireStaff(e, h) == false` claim the box (`IsBoxingClaimed` /
  `ClaimBoxing`); then `AttemptRequestToTransportAnimalToTarget(e, h, nType)` (returns a bool) for
  each animal; release the claims (`ReleaseBoxing`) when the transport is refused.
- **Trade centre: use `animals:AttemptToSendToTradeCentre(e)`** (proven 1.0.4): what the info
  panel, radial menu, habitat gate and facility panel call, after `animals:CanSendAnimalToTradeCentre(e)`
  and capacity `park:GetNumberOfAnimalsInTradeCentre() < park:GetTradeCentreMaxCapacity()`. The game
  picks the centre and books the keeper. **Pitfall (proven):** `AttemptRequestToTransportAnimalToTarget(e,
  tc, nType)` (as in `RelocateAnimalsPopup._AttemptSendToTradeCentre`) returns true for a habitat animal
  but nothing happens: no transport job, the animal stays. Used in `pz2qol.kin.lua` `Kin.Move`.
- **Out of the trade centre** (`FacilityInfoPopUp` trade centre tab, **offline**): Move opens the
  same `AnimalMovementMode` as for habitat animals (so `AttemptRequestToTransportAnimalToTarget`
  works from there); **Return to habitat** is `animals:RequestTransportToAssignedHabitat(e)` (the
  animal keeps its assigned habitat while it waits). Location: `animals:GetCurrentLocationType(e)`
  vs `animals.CurrentLocationType_TradeCentre`. `Kin.Move` uses Return when the target is the
  animal's own habitat, else the usual Move. The breeding programme counts trade-centre breeders
  (`lt == 'trade'`) as breeders without a group (`useTradeCentre`, default on).
- **Busy animals:** `animals:GetAnimalTransportData(e).bHasTransportJob`, `IsBoxAnimating`,
  `IsBoxingClaimed` (the info panel disables Move on these); `api.planetHub.IsPlayerAnimalMovementEnabled()`.
- `animals:GetUIAnimalListDataForIDs` location types: `animals.CurrentLocationType_Habitat`,
  `_TradeCentre`, `_VetSurgery`, `_Quarantine`, `_FreeRoaming` (escaped), `_BeingCarried`.
- Game mode in a park: `franchise:GetPlanetHubType() == franchise.PlanetHubType_FranchiseOnline`.
- `api.ui2.GetEntityName(entity)` gives a habitat's or facility's name.
- PZ2QoL Kin runs **one** move per `PZ2QoL_KinMove` exactly this way; a staged plan is sent one move
  at a time, each confirmed by the next scan (`bHasTransportJob`) before the next, and in a
  Franchise (or unknown-mode) zoo only with the player's opt-in (`allowPlansOnline`, off by default).
- Park name: `park:GetParkName()` (world API `park`). PZ2QoL keys habitat assignments by it inside
  each zoo's data, and the player store keys offline parks by it (Franchise zoos by their GUIDs;
  see lua-runtime.md "the player save").
- **Habitat entity ids are not kept across loads** (**proven** by the developer, 2026-10-16, game
  1.0.5: saved assignments landed on the wrong habitat or on ids that no longer exist, shown as
  ghost columns on the Species board). Never save an entity id (habitat or animal) for use after a
  reload. Stable across loads: animal GUIDs (lineage keys), habitat names (until renamed).
- A habitat also has a separate **habitat id**: `habitat:GetHabitatIDFromEntityID(e)` /
  `GetEntityIDFromHabitatID(n)` (**offline**; boundary panels keep it as `nLeftHabitatID`, used by
  `HabitatGateInfoPopUp` and the boundary edit mode). Whether it survives a load is a **guess**.
  PZ2QoL sends it as `hid` (snapshot `habs`: every habitat, empty ones too; destinations) and uses
  it only as a tie-break. Trace: `js_assign_hid_same` / `js_assign_hid_diff` after a reload tell.
- PZ2QoL saved assignments: `{ species, name, hid, guids (≤ 8 residents), seen }`, matched to
  today's habitats by `kinboardcore.js resolveAssignments` (residents, then name, hid as tie-break;
  the entity id counts only within the load the player clicked in) and re-keyed to today's ids
  once the zoo's data is read; unmatched entries are hidden and dropped after 3 loads.
- **Visiting a Franchise wildlife reserve reloads the zoo** (**proven**, trace on Y 2026-10-16
  21:12–21:29, game 1.0.5): zoo → reserve → zoo is a park end + park start each way. The reserve
  gets its own player-store key (`assign_store_franchise` + `assign_store_empty`), and the zoo
  comes back with new habitat entity ids, so with a build that keys by entity id alone every
  round trip leaves ghost habitats. The JS kin park model is dropped on `PZ2QoL_StoreReset`
  (`kin.js`, trace `js_kin_park_reset`) so a page that outlives the park never matches saved
  assignments against the previous load's ids.

## From storage to a habitat ("Find a habitat", 2026-10-16, **offline**)

- Storage's Send to Zoo does not place animals. `StorageUISetAnimalsToBeSentToZoo(ids, false)` plus a
  world transition; back in the park `SelectMode`'s Advance takes them with
  `park:GetAndClearPendingSendToZooEntityIDs()` → `(tEntityIDs, bReturnToHabitat)` and calls
  `BaseUIMode.SetNewMode("AnimalMovementMode", {tSelectedAnimals = tEntityIDs})` (exhibit animals:
  `GetAndClearPendingSendToZooExhibitAnimalGUIDs`, `bIsExhibit = true`). With `bReturnToHabitat` it
  calls `RequestTransportToAssignedHabitat` for each instead (after `CanStaffDeliverAnimalToFacility`).
  The market's Send to Zoo is `MarketUISetAnimalToBeSentToZoo(id)`, the same path.
  (`editors.select.selectmode.lua`, `startscreen.globe.animalstoragehubmode.lua`)
- The Move screen gives **one destination to the whole selection**: valid habitats need
  `IsValidHabitatForAnimalsGUID(h, allGuids)`, so a mixed-species selection usually has no habitat
  at all. Right-click (`EndPlacement`) leaves the animals where the game put them.
- `VerifyHabitatAnimal(e)`: alive and not escaped, or escaped **and boxed** (arrivals may be boxed).
- Where arrivals wait before a destination is picked (trade centre? boxed at the entrance?) is
  **open**; Kin.Move accepts boxed escaped animals as the Move screen does.
- PZ2QoL `PZ2QoL.StorageSend` wraps `Editors.Shared.BaseUIMode.SetNewMode` (SelectMode calls it as a
  module field, so the wrap is seen): only when armed by the mod's button, the first
  `AnimalMovementMode` request with ≤ N entity ids (not exhibits, no return screen) is not opened and
  the ids go to the HUD page, which moves them one at a time with `Kin.Move` (best habitat: own,
  a parent's, its species' biggest group, then any allowed and reachable; least crowded first).
  In a Franchise (or unknown) zoo only with the player's switch (off by default); otherwise the
  vanilla Move screen opens. Not yet seen in game: trace `send_taken`, `send_move_ok`.

## Breeding-programme facts (2026-10-15, all **offline**: decompiled Lua, UI, exe strings)

- **The medal (none/bronze/silver/gold) is the appeal state, not a genetics score.** The info panel's
  `geneticsRank` = `animals:GetAppealStateForInfoPopUpUI(e)` (variants: `GetAppealStateForTradingUI`,
  `GetAppealStateFromGUID`, `exhibits:GetAnimalUIDAppealStateForInfoPopUp`). Thresholds are native;
  it can't be predicted for offspring from Lua. The UI presents the same value as the **genetics
  rating** (market/storage `ratings`, see `game-data-and-events.md`, Genetics medal).
- Gene grades: `GetGeneticGrades(e)` -> `{nSize, nLongevity, nFertility, nImmunity}` 0..1;
  fertility and immunity are out of 6 loci, size and longevity out of 12 (Compare Mates divides
  by these). `geneticDiversity` is a Release-to-Wild group metric only.
- Conception chance: `animals:CalculateProbabilityOfBreedingEvent(welfareMother, welfareFather,
  fertMother*6, fertFather*6, GetAnimalSpeciesFertility(sp), GetMatingResearchBonus(sp))` -> 0..1,
  a pure function (best case welfare 1).
- Social: `GetSocialRequirements(sp)` -> `{nMin, nMax}` adults; `GetSocialityData(e)` -> members
  `{nID, nGender, nAlpha, nType}` + `nMaturationType` (`MaturationType_RejectMales|RejectFemales|
  RejectAll|RejectNone`); outsiders: `GetIntegrationProgress(e)`, `GetRejectionReason(e)`
  (`RejectionReason_Overpopulation|Maturation|GenderRatio`). `GetMateData(e).bIsBeta` (betas
  don't mate), `.bIsMonogamous`; `GetMatingMonogamyIcon(a, b, 0)` -> "ring" (mates), "IconLock"
  (bonded elsewhere). Exe-only, signatures unknown: `GetMonogamyRule`, `GetAlphaRule`,
  `DoesSpeciesFormPacks`; enums `Monogamy|Polygyny|Polyandre|Polygyandry`,
  `AlphaMale|AlphaFemale|AlphaPair|AlphaNone`. Zoopedia datastore (JS, after it is populated):
  `['Zoopedia','Animals','Animal_<id>','Social'|'Habitat']` with group counts, matingSystem and
  `maxMale` / `maxFemale`.
- Space: required `animals:GetSpaceRequirementsInHabitatForSpecies(h, sp)` -> `{nLandArea,
  nWaterArea, nClimbArea, nDeepSwimArea, nFlyArea}` (for the current population); available
  `habitat:GetHabitatSpeciesOverallNavAreaData(h, sp)` -> `bCalculating, {...}` (wait while
  calculating). No per-animal figure. `habitat:GetHabitatSpeciesSuitability(h, sp)` has `Space`,
  `SocialGroup`...; `habitat:IsHabitatTooCrowded(h)`.
- **Moving has no stress stat.** Costs of a move are outsider integration (or rejection) when
  joining a group, and mourning when a bonded mate is left (`GetCurrentMournTimeForUI(e)`).
  Pregnancy does not block a move.
- Breeding timing: `GetSpeciesBreedingSeasons(sp)` (array by season), `GetSpeciesFertilityBounds(sp)`
  -> `nMaturityAge, nInfertilityAge` years (>900 = never), `GetMatingWarnings(e, 0)` ->
  `{tLabelsArray, bMatingBlocked, bInfertile}` (Interbirth is a per-animal flag only).
  `IsInfertile` is probably also true under contraception: sterile = infertile and not contracepted.
- **Fertility over a life** (2026-10-16, **offline**): `IsInfertile(e)` (and `bIsInfertile` in the
  list data) is true for juveniles and for adults not yet at the maturity age as well as for old
  animals, so "infertile" alone does not mean "too old". `GetAgeStatus(e)` only has `Juvenile` /
  `Adult`; the **elderly** stage is `GetAgeQuarterForUI(e)` = 3 (0 child, 1 youngAdult, 2 adult,
  3 elderly: `AnimalUtils.GetHabitatAnimalAgeCategoryForUI`, `tAgeCategories`). Lifespan:
  `GetSpeciesLongevity(sp)` -> `min, max` years. The game's own release screen rates fertile time
  left as `1 - (age - maturity) / (infertility - maturity)` (infertility > 900 -> longevity max;
  `RelocateAnimalsPopup._GetHabitatAnimalReleaseRatings`). PZ2QoL: `fertilityOf()` in `kincore.js`
  (states juvenile / young / fertile / ending / old / sterile, years left), snapshot fields `ageQ`
  and `speciesFacts` (`pz2qol.kin.lua` `_SpeciesFacts`, cached per species).
- Mixing: `animals:DoAllSpeciesCohabit({[sp]=n})`; skip exhibit species (`exhibits:IsExhibitSpecies`)
  and boids (`animals:IsSpeciesABoid`).

## Group make-up: males per female (2026-10-17)

- **The game's own composition data** (**offline**, decompiled 1.0.5 Lua): the world API
  `wildterritory` (in zoo parks too: `AnimalMovementEditMode` holds it) has
  `GetTerritorySocialGroupsForSpecies(sSpecies)` → array of `{ nSocialGroupType, sNameSymbol, nMale,
  nFemale }` (`editors.wildterritory.releasegroupstoragemode.lua`, `events.eventactioncreatereleasegroup.lua`).
  Type values are fields on that API: `SocialGroupType_MixedGroup|MixedGroupLarge|BreedingPartners|
  MaleBachelor|FemaleBachelor|MaleSolitary|FemaleSolitary`; `sNameSymbol` is the same name. These are
  the wild release groups; that they match zoo habitat groups is a **guess**. **Proven (Y:,
  Franchise zoo, 2026-10-17 15:48):** the call answers in a zoo park (`kin_groups_found`), but for
  the species the developer opened no group had both sexes (a solitary species: male alone /
  female alone is the likely shape). The board then said the mating rule was unknown, **but that
  was not shown**: until 2026-10-17 evening the note appeared for every make-up of source `none`,
  which included a rule read as Polygyandry (`mixed`), and `matingRaw` was sent even for a rule
  that matched. No log on the PC holds the value (trace marks are fixed names; the game writes no
  log; the mod stores no species facts). The raw value is still unseen.
- **The mating rule's values** (**offline**): `GetMonogamyRule` is exe-only (no game Lua calls it);
  enum fields on the animals API, bare names (exe strings, beside `AlphaMale|AlphaFemale|AlphaPair|
  AlphaNone`): `Monogamy`, `Polygyny`, `Polyandre` (sic), `Polygyandry`. Numbers unknown.
  `animals.fdb` holds the source data (Python `sqlite3` reads it):
  - `Social_MatingRules (AnimalType, MaleHasSingleMate, FemaleHasSingleMate, OnlyLeaderMaleCanMate,
    OnlyLeaderFemaleCanMate, MourningSeasons)`. That the rule is built from the two SingleMate flags
    (1/1 Monogamy, 0/1 Polygyny, 1/0 Polyandre, 0/0 Polygyandry) is a **guess** that fits the names
    and the Meerkat (1/0, the only polyandrous species).
  - `Lifecycle_FertilityData.MatingType` (the Zoopedia's `[Zoopedia_MatingType_%s]`): Monogamous 21,
    Polygynous 32, Polyandrous 1, **Promiscuous 31** of 85 habitat species. Promiscuous species are
    all 0/0 (Polygyandry), e.g. tigers, bears, snow leopard, red/giant panda, lynx, sharks, rays,
    komodo; 12 of them are `Solitary`. Many Polygynous species are 0/0 too (giraffes, elephants,
    deer, rhino): their harem comes from `OnlyLeaderMaleCanMate` (23+ species), not the rule.
  - `Social_Sociality.MaturationType`: Gregarious 0, Matrilineal 1, Patrilineal 2, Solitary 3
    (`Social_Sociality_DEF`). `ENUM_Gender`: Male 0, Female 1, Flock 2.
  - `Requirements_GroupComposition (MinPopulation, MaxPopulation, MaxBachelorMale/Female,
    MaxMixedMale/Female)`: the game's per-sex limits (likely the Zoopedia's max per sex), e.g. tiger
    1/1 (max 2), lynx 1/2, lion 1/29, meerkat 20/20. No Lua call returns them (`kin_sexmax_none`).
  - `GetAlphaRule` (`AlphaMale|AlphaFemale|AlphaPair|AlphaNone`) may be the OnlyLeader flags or
    `Social_LeadershipRules` (who leads, by gender); the two disagree (elephants: both lead, only
    the male leader mates), so it is not used.
- **Right make-up** (PZ2QoL, 2026-10-17): Polygyandry (`mixed`) is a known rule, source `mating`,
  mixed groups (each female her best unrelated male); room per habitat from `GetSocialRequirements`
  `nMax` (tiger 2, so in effect one pair). A solitary species (all groups one sex: `rule.solitary`)
  keeps its mating rule's make-up (monogamy 1:1, polygyny 1:*). Only no readable rule and no
  two-sex group gives source `none` and the note (`kinprogramme.js unknownMakeupText`, which
  names the raw rule and the groups). Unisex species: make-up does not matter (both sides).
- **Trace** (`Kin._MatingSystem`): `kin_mating_monogamy|polygyny|polyandry|mixed`, `kin_mating_bonds`
  (read from a bonded mate), `kin_mating_none` (no rule), or `kin_mating_unknown` then
  `kin_mating_raw` + `chr_*` digits (`Core:MarkNumber`; `kin_mating_raw_<type>` for a non-number),
  then for each of Monogamy, Polygyny, Polyandre, Polyandry, Polygyandry `kin_mating_enum` + digits
  or `kin_mating_enum_missing`. `matingRaw` is sent only for a rule not understood; text rules
  match `polygyandr|polygynandr|promiscu` (mixed), `polyandr`, `polygyn`, `monogam`.
- **"Max per sex" exists but no Lua call is known**: the Zoopedia habitat panel and the habitat
  pinning modal show `maxMale` / `maxFemale` (`[AnimalPinning_MaxPerSex]`; Zoopedia `Habitat` context,
  pinning `recommendedPopulation` with `countMale|countFemale|countMixed`), filled by the exe (no game
  Lua sets them). The exe also has `GetSpeciesSocialityData`, `GetMatingRules`, `GetAnimalMatingData`,
  `GetSocialBehaviourData` (signatures unknown), and the strings `InfoPanel_Animal_Tooltip_SocialGroup_
  TooManyMales|TooManyFemales` and `Zoopedia_MaleFemaleRatio_`, so the game has its own per-sex limit.
  PZ2QoL probes `GetSocialRequirements(sp)` and `GetSpeciesSocialityData(sp)` (**guess** signature) for
  number fields named max+male/female (one level deep): trace `kin_sexmax_found` / `kin_sexmax_none`.
  **Proven 2026-10-17 (Y:): `kin_sexmax_none`** — neither table carries such a field.
- PZ2QoL (`pz2qol.kin.lua` `Kin.SpeciesInfo` → `info.groups = [{kind, m, f}]`, `info.sexMax = {male,
  female}`; `kinprogramme.js` `groupRule`): the make-up is the player's choice per species (`kinRatio`
  in the player store, per zoo; `RATIO_CHOICES` 1:1…1:5, 1:*, 2:1, 3:1, *:1, mixed), else the game's
  max per sex (also kept as caps), else the game's social groups (mixed, mixedLarge, pair first; only
  if it agrees with the mating system), else the mating system (monogamy 1:1, polygyny 1:*, polyandry
  *:1, Polygyandry mixed), else mixed (source `none`). Thin out (`kincull.js` `maleRoom`) keeps the same number of breeding males.

## Breeding programme optimiser (2026-10-17, `kinprogramme.js`)

- Objective per habitat: the best pairs under the make-up (exact b-matching, `maxWeightPairs`:
  Hungarian method on copies of the animals with several partners; "any" partners = each animal of
  the other sex takes its best), minus related pairs (2 each), adults over the room (1 each),
  breeders over the make-up (1 each: 1:k allows `max(1, ceil(females / k))` males), plus 0.01 per
  family line; minus move costs, outsider and bond-break costs. Scores are cached per (place,
  members) with xor-hash keys; a step re-scores only the habitats it changes.
- Search: every layout when there are ≤ `exactLimit` (20 000); else local search (move, swap, a
  male and a female together), **reassign** (one sex placed at once given the other: an assignment
  of the plentiful sex to the habitats' room and partner slots, and of the scarce sex to group-head
  slots), then rounds of 80 % kicks (move 1–2 scarce-sex animals, often a group head, then reassign
  both sexes) and 20 % ruin-and-recreate, settled by local search, accepted by simulated annealing
  (T 0.03 → 0.001); last a polish and the removal of every unneeded move. Deterministic (seeded by
  species and breeder ids). `planProgrammeAsync` runs it in ~24 ms slices with progress (the board
  uses 3 M evaluations / 6 s of search time; plain `planProgramme` 600 k / 1.5 s). The board caches
  results per setting and per `programmeSig` (the species' animals and assignments), not per kin
  model: a scan every 6 s would otherwise restart a long search forever. Unisex animals sit on both
  sides of the matching; two of them make one couple (`groupPairs`).
- Benchmarks (Node, random zoos, scratchpad): old greedy hill climb vs new, both scored with the
  new objective: the new one wins or ties in all but 4 of 160 zoos at the old budget, and with the
  final settings is within 0.00 / 0.09 / 0.13 % (mean) of 3 M-evaluation reference runs at 40 / 70 /
  100 breeders (~0.2 / 0.6 / 0.9 s); the whole-sex reassign was the step that mattered (polyandry
  and harem species, where choosing group heads is the hard part). Small zoos: the search alone hits
  the exhaustive optimum in 160 of 160 random cases (`tests/kinprogramme.test.mjs`).


## Colourmorphs (game 1.0.5, 2026-10-17)

- **Mutation chances are client data** (**offline**): `Content0\Main.ovl` → `animals.fdb` (SQLite) tables
  `Visual_ColourmorphData (AnimalType, MorphIndex, ColourMorphProbability DEFAULT 0.025)` and
  `Visual_ColourVariationData (AnimalType, Colourmorph, Male/FemaleVariationCount, MorphType)` (label).
  Exhibits: `c0exhibits.fdb` `ExhibitAnimalColourMorphData`; shoals: `shoalfish.fdb` `Visual_ColourmorphData`.
  E.g. `Aardvark|0|0.025|Albino`, `Wolf_Grey` 0.3 / 0.0714 / 0.4615. 54 of 85 habitat species have morphs.
- Values look like sequential conditional rolls (target ÷ (1 − earlier targets)): **guess**.
- `MorphIndex` is a fixed shader slot: 0 Albino, 1 Erythristic, 2 Leucistic, 3 Melanistic, 4 Xanthic,
  5 Piebald; `MorphType` is only the label. Each slot needs its own `p<Slot>BaseColourAndMaskTexture`
  (piebald: `pAnimal_PiebaldMasksTexture`) in the species' `.fgm`; Aardvark fills only albino. **offline**
- Loc keys `<species>_variation_colourmorph<N>` in `Content0\Localised\English\UnitedStates\Loc.ovl`.
- Zoopedia/UI only get label, description, image, isLocked; no chance reaches Lua or JS. Exe has
  Franchise server fields `chanceOfAlbino`.. `chanceOfAxanthic` (meaning unknown, maybe server-side odds).
- Every pack's `Databases.<Pack>` config is merged (`game.basegame.lua` `MergeContentPacks`,
  `api.database.MergeChildDatabase`, extra `tCollections` of prepared statements), so a mod could add
  morph rows or its own queries, as PZ1 DLCs did. Untested in game.
