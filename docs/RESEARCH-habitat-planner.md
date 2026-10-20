# RESEARCH: Habitat and aquarium planner

Status: feasibility study, 2026-10-19. The planner was then built as a standalone **web app**
(`apps/habitat-planner/`, a local web app) from the game's data files instead
of inside the mod; sections 5-8 describe the in-game route, still open.
Game: 1.0.5 (build 1023906). Facts are marked **proven** (seen in game), **offline** (decompiled
Lua, unpacked UI, the game's `.fdb` SQLite data) or **guess**, as the `pz2-modding` skill requires.
Nothing in this study has been seen in game yet.

## 1. What the developer asked

> "It's really hard to know not only how many animals will fit in an aquarium, but also what type
> of animals can go together. [...] I'll usually start with one species, let's say a big turtle.
> Then I want to understand all the different species I can add to that without too many space
> issues, conflict issues, predator issues, all those things."

The workflow:
1. Pick a starting species from the ones the player has unlocked.
2. See every species that can join it.
3. Add species one at a time. The list narrows to what still fits with everything chosen.
4. See how many of each fit, and the space and barrier the whole mix needs.

## 2. Verdict

**Feasible, read-only, and Franchise-safe.** The game has every rule the planner needs as client
data. It also works most of the answers out itself:
- the Zoopedia lists which species can share with a species;
- the Zoopedia gives the space needed for N planned adults;
- `DoAllSpeciesCohabit` checks a whole mix without needing a habitat.

The planner only reads. It never moves, buys or pins anything, so nothing it does reaches
Frontier's servers. It needs no click-to-act rules, because it doesn't act.

The main design choice is **where the planner gets the data** (section 5). The recommended source
is the game's own runtime answers: the Zoopedia data store plus a few species-level Lua calls. It
should not use a copy of the `.fdb` tables, because ground rule 5 says we ship nothing of
Frontier's.

## 3. What the game data says (offline, `animals.fdb`, `shoalfish.fdb`, `c0zoopedia.fdb`)

There are 85 habitat and aquarium species plus 21 shoal fish. The `.fdb` files are plain SQLite
inside `Content0\Main.ovl`.

### 3.1 Who can live together

- **Cohabitation is group based.** `Animal_Tags` gives each species zero or more `COHABITATION_<Group>`
  tags. There are 21 groups, for example:

  | Group | Habitat species | Shoal fish |
  |---|---|---|
  | AfricanSavannahGroup | 14 | – |
  | SoutheastAsiaRainforestGroup | 9 | – |
  | IndoPacificReefGroup | 12 | 13 |
  | IndoPacificReefGroupNoSharks | 8 | 12 |
  | FreshwaterGroupWarm | – | 4 |

  Two species are compatible when they share any tag. Each pair is checked separately; a species
  does not have to share one group with everyone. A species can be in several groups (wild boar
  and red deer are in 4 each).
- **Override rows.** `Social_TrophicOverrides(AnimalType, AnimalEncountered, Relationship)` has 335
  rows, all of them `Cohabitation`. They are one-way, predator → prey, and have no reverse rows.
  111 pairs are allowed only by an override. The planner should treat a row as covering both
  directions (**guess**).
- **The numbers.** 623 pairs are compatible out of 5,565, of which 252 are between two habitat
  species.
- **Solitary species.** 30 habitat species have no cohabitation tag at all: Galapagos tortoise,
  hippo, every big cat, the bears, the crocodilians and others. They can't share.
- **There is no deny list.** A pair that isn't allowed is incompatible.
- **Predators and prey.** `Social_TrophicMatrix` gives each species a type and levels: 30 Predator
  (adult and juvenile levels), 53 Prey, and 2 Invulnerable (Galapagos tortoise, puffer).
  `shoalfish.fdb` `Interaction_TrophicLevels` does the same for shoals. How the levels and the
  allow list combine is native code, so the planner should not rebuild that rule. The game's own
  check is `animals:DoAllSpeciesCohabit({[sp] = n})`.
- **Fights.** `Social_FightingRules` covers fights within a species. `Social_FightData` and
  `BehaviourParameters_Offsets.SizeClass` (A–D) are context only. The game's predation and
  interspecies fight alerts fire after the event; nothing forecasts them.
- **A flourishing bonus.** `Requirements_Flourishing` has 19 `Interspecies` rows: a species
  flourishes next to a group (Hawksbill turtle → `IndoPacificReefShoalsGroup`, zebra →
  `AfricanSavannahGroup`). The planner can show it as a "good companion" bonus.

### 3.2 How much space

`Requirements_HabitatSpace` has a minimum and a per-extra-animal figure for each space type:

| Space type | Columns | Species with a value > 0 |
|---|---|---|
| Land | `MinimumSpace`, `SpacePerAdditionalAnimal` | 69 |
| Water | `MinimumAquaticSpace`, `AquaticSpacePerAdditionalAnimal` | 19 |
| Deep swim | `MinimumDeepSwimmingSpace`, `DeepSwimmingSpacePerAdditionalAnimal` | 21 |
| Climb | `MinimumClimbableSpace`, `ClimbableSpacePerAdditionalAnimal` | 14 |
| Flight | `MinimumFlightSpace`, `FlightSpacePerAdditionalAnimal` | 12 |
| Shelter | `MinimumShelterAreaPerAnimal` | 65 |

- **The formula** (**guess**, read from the column names): need = `Min + Per × (n − 1)`;
  shelter = `PerAnimal × n`.
- **Examples:**
  - Hawksbill turtle: deep swim 100 + 25 each, so 4 turtles need 175 m².
  - Zebra: land 460 + 140 each.
  - Galapagos tortoise: land 230 + 5 each, plus shelter 10 per animal.
- **Group size.** `Requirements_GroupComposition` (min and max population, max per sex). Turtle is
  1–4, elephant 2–16.
- **Shoals.** `shoalfish.fdb` `Requirements_Space(MinDeepWater, AdditionalDeepWater)` and
  `Requirements_ShoalSize`. That a population counts shoals rather than fish is a **guess**.
- **Not in the data:**
  - whether different species' areas add up in a shared habitat. The game checks each species
    against its own navigable area (`GetHabitatSpeciesOverallNavAreaData(h, sp)`), so they may
    not add up (**guess**);
  - a factor for juveniles.

### 3.3 Hard filters and environment

- **Enclosure type** (`Requirements_ValidEnclosureTypes(Habitat, ClimbProof, Roofed, Aquarium)`).
  16 species are aquarium only, the Hawksbill turtle among them. No species allows both a habitat
  and an aquarium, so land and aquarium species never mix. Roofed (12 species) and climb-proof
  (18) are requirements on the enclosure, not a separate kind of habitat.
- **Salinity** (`Requirements_Salinity`, fresh / brackish / salt). It has to be checked on its own,
  because the overrides pair saltwater species with freshwater fish. The game's check is
  `animals:IsSalinitySuitable(sp, park:GetSalinity(h))`.
- **Temperature** (`Requirements_Environment`, min and max plus a tolerance). The species call is
  `animals:GetTemperatureRequirements(sp)` → `{nMin, nMax}`. The habitat call is
  `habitat:GetTemperatureRange(h)`. A mix needs the ranges to overlap.
- **Plant cover, terrain and biome.**
  - Plant cover: `Requirements_Environment`.
  - Terrain shares: `Requirements_Terrain`, 394 rows; Hawksbill needs 50–100 % fine sand, hippo
    20–60 % waterlogged.
  - Biome: `Requirements_Biomes`, 12 biomes; the call is `animals:GetBiomesForSpecies(sp)`.
  - A mix needs the plant and terrain ranges to fit together: the minimum shares must add up to
    at most 100 %.
- **Barriers** (`c0zoopedia.fdb` `BarrierRequirements`: grade 1–4, height, climb-proof, water
  barrier). No Lua call returns them; only the Zoopedia's text does.
- **Enrichment and food** (`Requirements_EnrichmentValue`, `Requirements_FoodTypes`). These matter
  for welfare, not for whether animals can share. Out of scope for version 1.

### 3.4 Unlocked species

- **The data.**
  - Content pack: `Animal_Definition.ContentPack`, with BaseGame, Deluxe and PreOrder species.
  - Tiers: `Requirements_Accreditation(CareerTier 0–3, OnlineFranchiseTier 0–4)`. For example the
    Hawksbill turtle is Franchise tier 3, the Galapagos tortoise tier 0.
- **Runtime calls.**
  - Lock flags: Zoopedia `isLocked`, `isDlcLocked` and `accreditationUnlock`.
  - DLC ownership: `animals:OwnRequiredDLCForSpecies(sp)`, or `GetRequiredDLCForSpecies` with
    `api.content.IsDLCOwned`.
  - The player's tier: `park:GetCurrentAccreditationTier()`.
- **Open:** what Zoopedia `isLocked` means in Franchise.

## 4. What the game already computes (offline, decompiled 1.0.5)

| Need | Game source | Needs a habitat? |
|---|---|---|
| Compatible species of X | Zoopedia `['Zoopedia','Animals','Animal_<X>','CompatibleSpecies','species_<Y>']` → `{id, label, isFloursihingRelationship (sic), isLocked, thumbnail}`, drawn by `ZoopediaHabitatPanel.js` as "flourishing" and "neutral" lists | no |
| Space for N planned adults | `zoopediaui2:SetAnimalNumbers(n)` + `UpdateDataStore_RequirementUnits()` refill `...'Habitat'.Requirements[]` (`targetValue`, `unitType`); JS event `UI_Zoopedia_ChangePlannedPopulation_Adults` | no |
| Whole mix allowed? | `animals:DoAllSpeciesCohabit({[sp] = n})` → bool (`managers.achievementmanager.lua`) | no |
| Species environment | `GetTemperatureRequirements`, `IsSalinitySuitable`, `GetBiomesForSpecies`, `GetSocialRequirements`, `GetSpeciesFertilityBounds` | no |
| Habitat's real areas | `habitat:GetHabitatSpeciesTerrainData(h)` → `bCalculating, {nLandArea, nClimbArea, nFlyArea, nWaterArea, nWaterDepth, nPerimeterArea}`; per species `GetHabitatSpeciesOverallNavAreaData(h, sp)` | yes |
| Habitat's temperature, salinity, climb-proof | `GetTemperatureRange(h)`, `park:GetSalinity(h)`, `IsAquarium(h)`, `IsEntireHabitatClimbProof(h)` | yes |
| One species planned against a real habitat | **Pinning modal**: `['pinnedAnimals']` `species[].isCompatible`, `viewedSpecies.plannedPopulation` / `recommendedPopulation` / `requirements[]` (`habitatgateinfopopup.lua` ~3624, `AnimalPinningSpeciesModal.js`) | yes, one species at a time |
| Species list, names, icons | Zoopedia per species (`name`, `smallIcon`, `image`); `getZoopediaSpecies('Animal_<id>')` in `/js/project/utils/SpeciesDataUtil.js`; `[Animal_<id>]` text (already used by `speciesnames.js`) | no |

The pinning modal is the game's own planner, but it shows one species at a time against one
existing habitat. It doesn't answer "what goes with my turtle", and it doesn't plan a habitat that
hasn't been built. That gap is the feature.

## 5. Where the data comes from

| Option | How | For | Against |
|---|---|---|---|
| **A. Runtime game answers** (recommended) | JS reads the Zoopedia data store (filled at park load, `worlds.darwinworld.lua` 645). One Lua event answers the species-level calls. | The game's own rules and lock state; it follows game patches; ships nothing of Frontier's | Each species' Zoopedia may be filled lazily; per-N space means calling `SetAnimalNumbers`, which may disturb an open Zoopedia; whether the compatible list is symmetric is open |
| B. Mod-added database queries | `Databases.PZ2QoL` with extra prepared statements on the Animals database (`MergeChildDatabase`, `tCollections`), reading `Requirements_HabitatSpace`, `Animal_Tags` and the overrides directly | Exact formula inputs | Untested in PZ2; needs a prepared-statement resource in the OVL; still depends on our reading of the rule |
| C. Tables baked in at build time | Python reads the `.fdb` files into a JSON file | Simplest to code; easy to test | **Breaks ground rule 5** (it ships Frontier data); goes stale after a patch. Use it only as a local dev check, never in the zip. |

**Recommendation: A, with B as the fallback for space.**
- **Compatibility:** the Zoopedia `CompatibleSpecies` lists, plus `DoAllSpeciesCohabit` for the
  final mix.
- **Space:** read the Zoopedia requirement for n = 1 and n = 2 per species, giving `Min` and
  `Per`. Then check the formula once at n = 4 in the probe. That gives a per-species formula
  without calling anything per keystroke.
- **Environment:** the species-level Lua calls.
- **Dev check:** a scratchpad-only script compares the runtime answers with the `.fdb` tables.

## 6. Proposed feature

### 6.1 Player view

A **Habitat planner** panel, the same kind as the Species board (its own DOM under `<body>`, no
CSS grid, `kinpanel.js` scrolling). It opens from a third launcher button
(`hudlauncher.js`), from the Species board header, and later from a habitat panel button,
"Plan this habitat".

```
Habitat planner                                    [Aquarium ▾] [Real habitat: none ▾]  [×]
┌ Start / mix ─────────────┐┌ Can join ─────────────────────────────────────────────┐
│ Hawksbill turtle  ×4  ⊖⊕ ││ ★ Clown triggerfish (shoal)   +60 m² deep · 22–28 °C   │
│ Blacktip reef shark ×2   ││ ★ Sailfin snapper             +65 m² deep              │
│                          ││   Spotted eagle ray           +240 m² deep · tier 3 🔒 │
│ Needs (whole mix)        ││   ... 21 more                                          │
│  Deep swim  ≥ 1,135 m²   ││ Ruled out (why)                                        │
│  Temp       24–28 °C     ││   Manatee            not compatible with Blacktip      │
│  Salinity   salt         ││   Great hammerhead   not compatible with Hawksbill     │
│  Barrier    —            ││   Koi                freshwater only                   │
│  Game check ✓ cohabit    ││                                                        │
└──────────────────────────┘└────────────────────────────────────────────────────────┘
 ★ = helps a species here flourish.   Space: per species (the game checks each one on its own).
```

The figures in this mock-up are made up for the layout; only the species and the reasons they are
ruled out come from the data.

**Example: the developer's "big turtle".**
- **Hawksbill turtle** (aquarium, salt or brackish): 25 partners. They are the reef sharks, rays,
  grouper, wrasse, lionfish and the saltwater shoals; the Manatee and the Great hammerhead are
  ruled out.
- **Galapagos tortoise** (land): solitary, 0 partners. The planner says so, so the player stops
  looking.

### 6.2 Logic (`habplancore.js`, pure, Node-tested)

- **Candidates for a mix M.** A species can join when:
  1. it is compatible with every species in M (pairwise, symmetric);
  2. it needs the same enclosure kind (aquarium or habitat);
  3. salinity, temperature and plant-cover ranges still overlap;
  4. the minimum terrain shares still add up to at most 100 %.
- **"Ruled out" reasons.** Each excluded species gets its first failing test as the reason: names
  the species it clashes with, "freshwater only", "needs 30 °C+", "locked (tier 3)".
- **The final check.** The full mix goes once to Lua's `DoAllSpeciesCohabit`. If the game
  disagrees with the pairwise result, the game wins and the panel shows the disagreement.
- **Counts.**
  - Each species' count stays within its group composition (min, max, max per sex).
  - With a real habitat, "how many fit" is `n = 1 + floor((Area − Min) / Per)` for each space type,
    and the smallest of those wins.
- **Mix needs.** For each space type, the largest single requirement, with the sum shown as a
  cautious figure until the add-up question (section 7, P2) is answered. Also the shared
  temperature and salinity, the highest barrier grade and height, climb-proof if any species
  needs it, and roofed if any needs it.
- **Suggest a full mix (optional).** The best set of species that all get along, scored by
  flourishing links, guest appeal and extra space. Candidate lists are 25 species or fewer, so an
  exhaustive search is instant.
- **Unlocked filter.**
  - Default "Unlocked": not `isLocked`, DLC owned, tier ≤ the player's tier.
  - Toggles: "Show locked" (greyed, with the tier); "I have them" (in the zoo or in storage, from
    the Kin scan and `Kin.StoredAdults`).

### 6.3 Code layout (matches the mod's conventions)

| Piece | File | Notes |
|---|---|---|
| Pure logic | `UI/UIGameface/js/mods/pz2qol/habplancore.js` | no DOM, no game imports; `tests/habplan.test.mjs` |
| Panel | `.../habplan.js` | own DOM, `kinpanel.js` scroll areas, `speciesName()`, `reportError` |
| Zoopedia reader | `.../habplandata.js` | reads the `Zoopedia` data store; caches per species per park load; dropped on `PZ2QoL_StoreReset` |
| Lua | `Main/pz2qol.habplan.lua`, or `Kin.SpeciesInfo` extended | event `PZ2QoL_PlanSpecies(reqId, species list)` → `PZ2QoL_PlanSpeciesResult(reqId, JSON)` with temperature, salinity, biomes, social, enclosure, locks, DLC; `PZ2QoL_PlanCheck(reqId, "sp=n,...")` → `DoAllSpeciesCohabit`; `PZ2QoL_PlanHabitat(reqId, h)` → areas, temperature, salinity, climb-proof, residents. All `pcall`, read only, debug marks `plan_*` |
| Launcher | `hudlauncher.js` | third button; HUD page in a park only (the Lua calls need the park world) |
| Harness | `tests/uiharness/habplan.mjs` | screenshot with a **synthetic** fixture (made-up species and numbers, not the real tables) |

Facts reach the page as Lua → JS JSON, the same way `Kin.SpeciesInfo` sends them now
(`TriggerEventAtNextAdvance` + `Kin.Encode`), chunked if the species list is long.

## 7. Unknowns and risks (in-game probe first)

| # | Question | Why it matters | How to find out |
|---|---|---|---|
| P1 | Is space `Min + Per × (n − 1)`? | The count and space figures | Zoopedia `targetValue` at n = 1, 2 and 4, compared with `.fdb` values (debug log) |
| P2 | Do species' space needs add up in a shared habitat? | Max vs sum in "mix needs" | Two species in a test habitat: does `GetSpaceRequirementsInHabitatForSpecies` change when the second arrives? |
| P3 | Is `DoAllSpeciesCohabit` symmetric and count-independent? Is prey with prey fine? | The final check | Call it on pairs from the override list and on prey-only pairs |
| P4 | Is every species' Zoopedia `CompatibleSpecies` filled at park load, or only when opened? Is it symmetric? | Option A's main input | Read the data store for all species after load (debug log counts) |
| P5 | Does `SetAnimalNumbers` disturb an open Zoopedia or the pinning modal? | Space via the Zoopedia | Call it with the Zoopedia closed, then open the Zoopedia and look |
| P6 | What does `isLocked` mean in Franchise (accreditation tier?) | The "Unlocked" filter | Compare it with `GetCurrentAccreditationTier` and `OnlineFranchiseTier` |
| P7 | Can a mod add prepared statements (option B)? | The fallback | A small test pack |

Risks:
- **The rule copy drifts from the game.** Keep the game's answer (`DoAllSpeciesCohabit`, the
  Zoopedia lists) as the authority and the pairwise logic as a fast preview only.
- **Shoals are different.** They count as shoals and use another database, and their population
  meaning is a guess. Version 1 can list shoals as companions with their own space line, marked
  "estimate" until P1 covers them.
- **Hub page.** The Zoopedia is filled in the hub too, but the Lua calls need a park world.
  Version 1 runs only in a park.
- **Pinning writes habitat state** (`SetHabitatSpeciesPinnedStatus`). The planner never calls it.
  A later "Pin in game" button would be one click, one action, like the game's own button.

## 8. Scope and next steps

1. **Probe** (one debug build, about one session). Lua marks and detailed-log lines for P1–P6:
   read the Zoopedia for every species at park load, call `DoAllSpeciesCohabit` on known pairs,
   read the requirement figures at 1, 2 and 4 animals. The developer runs it once in a Franchise
   zoo and once in Sandbox.
2. **Version 1: plan from scratch.**
   - start species → candidates with reasons → add species → mix needs and the game's check;
   - an aquarium or habitat switch;
   - the unlocked filter;
   - tests, harness screenshots, and a skill update with the probe results.
3. **Version 2: a real habitat.** Pick an existing habitat (or "Plan this habitat" from its panel).
   The planner uses its real areas, temperature, salinity and climb-proof flag, starts from its
   residents, and shows "how many fit" with the limiting space type.
4. **Version 3, optional.**
   - Suggest a full mix.
   - "I have them" (zoo and storage).
   - A Species-board link that opens the board on a chosen species to move animals into the
     planned habitat (moves stay one click each, as now).

### Questions for the developer

1. "Unlocked": the game's lock (research tier and DLC), or species the player can actually get
   (in the zoo, in storage, on the market)? The proposal defaults to the game's lock with an
   "I have them" toggle.
2. Should shoal fish count in version 1, or only the large animals?
3. Version 1 from scratch first (recommended), or a real habitat first?
