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

## Lineage APIs (`api.world.GetWorldAPIs()`)

- `animals:EntityIDToAnimalGUID(e)` / `AnimalGUIDToEntityID(guid)`: return 0 if absent.
- `animals:GetParents(guid)`: a table of parent GUIDs, with `""` for an unknown parent.
  Synchronous and local. Works in park and in the hub for storage animals (ID type 2).
  Whether it still answers for dead or traded animals is **open**.
- `exhibits:GetAnimalFamilyMemberUID(uid, 0|1)`: parent 1 or parent 2 of an exhibit animal.
- `franchise:RequestAnimalData` / `GetAnimalData`, `RequestFamilyTreeData` /
  `GetAnimalFamilyTreeData`, `GetAnimalChildren`: **asynchronous** (the reply arrives via
  `MsgType_LocalAnimalDatastoreUpdatedMessage`) and may need the server in Franchise. Don't use
  them for bulk scans.
- `animals:GetMateData(e)` returns `{bIsBeta, bIsMonogamous, tMateData={{nID,sName,nGender}}}`.
  `GetRelationship(a,b)` is the social bond, not kinship.
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
- **Busy animals:** `animals:GetAnimalTransportData(e).bHasTransportJob`, `IsBoxAnimating`,
  `IsBoxingClaimed` (the info panel disables Move on these); `api.planetHub.IsPlayerAnimalMovementEnabled()`.
- `animals:GetUIAnimalListDataForIDs` location types: `animals.CurrentLocationType_Habitat`,
  `_TradeCentre`, `_VetSurgery`, `_Quarantine`, `_FreeRoaming` (escaped), `_BeingCarried`.
- Game mode in a park: `franchise:GetPlanetHubType() == franchise.PlanetHubType_FranchiseOnline`.
- `api.ui2.GetEntityName(entity)` gives a habitat's or facility's name.
- PZ2QoL Kin runs **one** move per `PZ2QoL_KinMove` exactly this way; a staged plan is sent one move
  at a time, each confirmed by the next scan (`bHasTransportJob`) before the next, and in a
  Franchise (or unknown-mode) zoo only with the player's opt-in (`allowPlansOnline`, off by default).
- Park name: `park:GetParkName()` (world API `park`). PZ2QoL keys the player's habitat assignments by it.

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

