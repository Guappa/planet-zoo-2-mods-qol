# Proposal: inbreeding quality of life ("Kin" features)

Goal: make the game's **existing** inbreeding system easy to read and manage in a large zoo. Above
all, show clearly and in several places when a male and a female in the same habitat are related
and will inbreed. This adds no new genetics and changes nothing the game decides. It shows what
the game already knows, in the places where you need it.

Status: **implemented in PZ2QoL 1.3.0 (2026-10-15)**, tested offline (unit, Lua mock and browser
harness), **not yet tried in the game**. Facts are marked **[code]** (seen in decompiled Lua or
the game UI), **[inferred]**, or **[open]** (needs an in-game check). The details are in
`.claude/skills/pz2-modding/reference/animals-and-breeding.md`.

## Implementation status

| Idea | Status | Where |
|---|---|---|
| Foundation (kinship service) | done; game tier + kinship %, grandparents up to 4 generations above absent parents, exhibits included | `Main/pz2qol.kin.lua`, `js/mods/pz2qol/kincore.js`, `kin.js` |
| A. Animals list badge, filter, sort, summary | done | `kinzoo.js`, `zoo.js`, `scores.js` |
| B. Habitat panel line + row badges | done | `kinhabitat.js` |
| C. Heat map shortcut | done (`ShowHeatmap`, Lua fallback) | `kin.js`, zoo toolbar, planner |
| D. New-risk alerts | done (+ one summary per park) | `kinalerts.js` |
| E. Info panel line + Studbook/Social badges | done | `kinhabitat.js` |
| F. Remedies | done: one contraception toggle and one Locate per click; select via the Kin filter + the game's select-all | `kin.js`, `kinui.js`, planner |
| G. Compare Mates badges, offspring line, "Unrelated first" | done (park and hub) | `kinmates.js` |
| H. Habitats list badge | done | `kinzoo.js` |
| I. Relatedness matrix with expected young | done (Kin planner) | `kinplanner.js`, `kinplannercore.js` |
| J. Extended kinship and % | done (threshold 1/8, 1/16, 1/32 in settings) | `kincore.js` |
| K. Family grouping | done as **Sort: Kin** (relatives together, worst first) | `scores.js` |
| L. Genealogy locations | done | `kinmates.js` |
| M. Storage kin + Send to Zoo warning | done (badge, filter chip, warning) | `kinstorage.js`, `bars.js`, `listfilter.js` |
| N. Pre-move warning | done differently: the Species board shows a plan's effect before any move; D alerts after the game's own moves | `kinboard.js` |
| P. Species board (developer's idea): habitats of a species side by side, stage moves into a plan, see its effect, suggest fixes, execute one move at a time | done | `kinboard.js`, `kinboardcore.js`, `kinmoves.js`, `pz2qol.kin.lua` |
| O. Maturity forecast | not done (no maturity-age data found) | – |

The in-game check from section 5, step 0, is still the first thing to do (GUID types, absent
ancestors, event sizes, row ids); everything fails soft if an assumption is wrong.

---

## 1. What the game has today, and why it is hard to use

**How the game decides "inbred"** [code]. The only check is a Lua function in Compare Mates,
`CompareMatesPopup.CompareParentsForInbreeding` (`editors.animal.comparematespopup.lua`). It flags
a pair when:
- one is a parent of the other, or
- they share a parent (full or half siblings).

It reads parent IDs from `animals:GetParents(guid)`. There is no threshold or coefficient, and
grandparents, aunts/uncles and cousins are never flagged. **No native "are related" call or
relatedness coefficient exists** in Lua or in the exe's API names.

**The real cost is genetic** [code for the UI prediction]. Fertility and immunity grades count the
loci where an animal's two allele strands differ (`CompareMatesUIUtils.GetMinMaxGeneGrades`).
Related parents share alleles, so their young lose fertility and immunity. This also happens with
cousins, which the game does not flag. Players report the same thing: the game warns about
"hard" inbreeding but not "soft".

**Where the game shows it**, and why that does not scale:

| Surface | What it shows | Limitation |
|---|---|---|
| Compare Mates popup | `[AnimalExchange_Inbred]` for **one chosen pair** | One pair at a time; candidates in the list are not marked |
| Info panel, Studbook tab | Parents, siblings, children of **one animal** | No "lives in the same habitat" mark; no grandparents |
| Genealogy popup | One generation each way around one animal | No location, alive or in-zoo flag |
| `InbreedingRisk` heatmap (Animals category) | Engine-drawn world overlay | Hard to find; can't be read from Lua or UI; no list or names |
| A notification that opens that heatmap | DB-defined, raised natively | Players report it arrives **after** the mating |
| Zoo Animals list, habitat panel, Habitats tab, storage, market | Nothing about kinship | No relatedness field on any row [code] |

So to answer "are any related animals breeding in Savannah Habitat?" today, you open each
animal's Studbook and compare names by hand.

**What the mod can read** [code], all locally, synchronously, with no server traffic:
- habitats and their animals: `habitat:GetHabitats()`, `GetAnimalsInHabitat(h)`,
  `GetSortedAnimalsPerSpeciesInHabitat(h, true)`;
- identity: `animals:EntityIDToAnimalGUID(e)` and back;
- parents: `animals:GetParents(guid)` returns two GUIDs, `""` when unknown. Lineage never
  changes, so cache it forever;
- state: `GetGender`, `GetAgeStatus` (juvenile), `IsUsingContraceptive`, `IsInfertile`,
  `IsPregnant`, `GetName`, `GetSpecies`, `IsAlive`;
- current mates: `GetMateData(e)`; genes (12 alleles per stat): `GetGenes(e)`;
- the same `GetParents(guid)` works in the hub for Animal Storage animals (ID type 2 = GUID).
- Market listings have **no** parents: the game itself returns `{}` for them.

**UI rows the mod can match by entity ID** [code]:
- zoo Animals list row `id` = `"animal_<entityID>"` (exhibit: `"exhibit_animal_<uid>"`);
- habitat panel animal row `id` = `tostring(entityID)`;
- info panel context `['infopanel','animalInfoPanel',<entityID>]`.

---

## 2. The foundation every idea needs: a kinship service

None of the ideas below works without this. It is one module that every surface reads from.

**Lua side (in park):** new `Main/pz2qol.kin.lua`, wired into the HUD view the mod already
patches (`Hub._PatchHUDUI`, with listeners registered in the ready callback, the proven pattern).
1. For each habitat, group the animals by species (`GetSortedAnimalsPerSpeciesInHabitat`).
2. For each animal, get its GUID and parents, **cached by GUID**. To reach grandparents, call
   `GetParents` on the parents' GUIDs as well. Whether that still works for dead or traded
   parents is [open]; if it doesn't, the extended tier only covers animals whose parents are
   still known.
3. Check pairs only within one habitat and one species, and only male × female. That is a few
   hundred checks even in a big zoo.
4. Send the result to the page: per animal, a list of `{partnerEntityID, relation, severity}`;
   per habitat and species, the number of at-risk pairs.

**The relation classes** (a short label is shown; the kinship % goes in the tooltip):

| Relation | Kinship | Game flags it? |
|---|---|---|
| Parent / child | 25% | yes |
| Full siblings | 25% | yes |
| Half siblings | 12.5% | yes |
| Grandparent / grandchild | 12.5% | **no** |
| Aunt/uncle – niece/nephew | 12.5% (full) / 6.25% | **no** |
| First cousins | 6.25% | **no** |

**Severity** (one colour scheme everywhere):
- **Red, "Inbreeding risk"**: the game would flag this pair. Both are adults, opposite sex, same
  habitat and species, and neither is on contraception or infertile. If `GetMateData` says they
  are currently mates, the tooltip says so first.
- **Amber, "Close kin"**: an extended relation the game does not flag, or a red relation where
  one animal is still juvenile (a future risk).
- **Grey, "Covered"**: related, but contraception or infertility prevents breeding. This is shown
  so you can see why a pair is safe, and what breaks if you lift contraception.

**Lua → page channel.** `oUI:TriggerEventAtNextAdvance("PZ2QoL_Kin", payload)`, with the payload
encoded as one compact string. This channel is proven (the mod's error banner and MarketPeek use
it). Writing a mod-owned DataStore root from Lua (`api.ui2.GetDataStoreContext` /
`SetDataStoreElement`, as the game does) would be neater but is [open]. The page asks for a
rescan (`PZ2QoL_KinScan`) when a relevant screen opens, plus once every ~30 s while the HUD is up
(for alerts). The scan only reads, so a timer is fine: nothing here acts online.

**Effort: M. Risk: low to medium.** It only reads data, but it is the mod's first Lua that runs
in the park world rather than the hub. Wrap everything in `pcall`; if it fails, the badges simply
don't appear.

---

## 3. Ideas, scored

Value is 1–5 (5 = solves the main pain). Effort is the work **after** the foundation:
S = about a day, M = a few days, L = a week or more. Risk covers crashes, breakage after a game
patch, and online safety.

### A. Zoo management Animals list: kin badge, tooltip, filter, summary
- A small red, amber or grey **DNA badge** in each row's inner element, the same proven pattern
  as the score badges.
- Tooltip: "Half-sister of **Kito** ♂ (Savannah Habitat) – the game flags this pair". Lists every
  partner.
- Toolbar chip **"Inbreeding risk (N)"** shows only animals in red or amber pairs. With the
  existing **habitat picker**, this answers the main question in two clicks.
- Summary stat **"risk pairs"** next to the existing "pairs".
- Sort option "Kin risk" that groups each risk pair next to each other.
- Data: rows map by `"animal_<entityID>"` [code]. Uses `zoo.js`, `listfilter.js` and `badges.js`
  as they are.
- **Value 5, effort S, risk low.**

### B. Habitat info panel, Animals tab: markers and per-species summary
- In `tab_habitatAnimals`, mark each animal row (keyed by entity ID [code]) with the same badge.
- Next to each species' ♂/♀ counts, add a line: "⚠ 2 related pairs" or "✓ no related pairs".
  This is exactly where you look when managing one habitat.
- A new DOM target: info panels can be open several at a time and their rows are recycled, so
  apply the inner-element rule from `ui-gameface.md`.
- **Value 5, effort M, risk low to medium.**

### C. Shortcut to the game's own inbreeding heatmap
- A "Breeding heatmap" button on the Animals toolbar and in the habitat panel, sending the game's
  own `Heatmaps_Select('InbreedingRisk')`.
- This makes an existing, little-known feature one click away. Its rule is the engine's, so it
  might differ from the mod's, and the button tooltip says so.
- **Value 3, effort S, risk low.**

### D. "New risk" alerts (fixes "the warning comes too late")
- When a rescan finds a red pair that wasn't there before, show a banner or toast, e.g. "Savannah
  Habitat: **Kito** ♂ is now adult and is the half-brother of **Zuri** ♀". The banner has a
  **Show** button that opens the Animals list filtered to that habitat with the risk filter on.
- The triggers are a juvenile maturing, an animal moved or bought in, or contraception being
  lifted. All of them are caught by diffing scans.
- Reuses the error banner's component. The alerts have an on/off setting, on by default (it is
  display only).
- **Value 5, effort M, risk low.** In practice, this is how players catch problems *before* the
  game's own alert.

### E. Animal info panel: kin line and Studbook marks
- Overview tab: one line, "Related to 2 breeding-age animals in this habitat: Zuri (sister),
  Ama (mother)", with the same severity colours.
- Studbook tab: mark the relatives who **live in the same habitat**, and add "Grandparents"
  where the mod knows them.
- **Value 4, effort M, risk low to medium** (the info panel DOM is the most complex target).

### F. One-click remedies (they only use the game's own controls)
- **"Select at-risk animals"** in the Animals list ticks the red-pair animals with the game's
  own selection event. The player then uses the game's own Move, Sell, Release or Rehome footer.
- A **contraception toggle in the kin tooltip or row** sends the game's own
  `ManagementAnimals_ContraceptionToggled` for **one animal per click**.
- There is no batch contracept button. In Franchise, the parks are online state, and the repo
  rules allow only click-started, one-at-a-time actions. A batch would have to be off by default
  and confirmed for each action, which isn't worth it here.
- **Value 4, effort S–M, risk low** (selection only shows) **to medium** (contraception changes
  game state).

### G. Compare Mates: mark every candidate
- In the mothers and fathers lists, put a kin badge on each candidate *relative to the currently
  selected animal*. Add a "Unrelated first" sort.
- In the offspring box, add an amber line for the relations the game misses ("first cousins").
- Candidate keys are `animal_<id>_<idType>`; the mod needs Lua to turn the ID into a GUID for
  types 0 and 2 (entity and GUID) [code].
- The popup is shared with hub storage, so the same work covers both.
- **Value 4, effort M, risk medium** (hooks a popup the game rebuilds on every selection).

### H. Habitats management tab: risk count per habitat
- Add a "risk pairs" column or badge to each habitat row, and a sort, so a 40-habitat zoo shows
  its problem habitats at a glance.
- Rows have `id` and `name`, not animals; the mod maps them through habitat entity IDs from the
  scan.
- **Value 3, effort S–M, risk low.**

### I. Relatedness matrix for each habitat and species
- A mod popup that opens from B or A. Males in rows, females in columns; each cell shows the
  relation (or "—") and the **expected offspring fertility and immunity**. The expected values
  come from the game's own allele model (`GetGenes` plus the same heterozygosity count as
  `GetMinMaxGeneGrades`), so they show what inbreeding actually costs, cousins included.
- It answers "who can breed with whom here" in one screen.
- **Value 4, effort L, risk low** (the mod's own panel, which only reads data).

### J. Extended kinship and kinship %
- Grandparent, aunt/uncle and cousin tiers, plus a kinship % (coefficient of kinship from path
  counting over the cached pedigree).
- This sits in the foundation as the amber tier; the work is the depth and making it reliable when
  parents have left the zoo.
- Labelled clearly as the mod's estimate, not the game's.
- **Value 3, effort M, risk low** (uncertain only in how deep it can go, [open]).

### K. Family grouping in the Animals list
- A sort that groups animals by mother, so litters and siblings sit together.
- Cheap once parents are cached.
- **Value 3, effort S, risk low.**

### L. Genealogy popup: where is each relative now?
- Tag each relative "in zoo · Savannah Habitat", "in storage" or "not in zoo". The popup has IDs
  (GUIDs) but no location [code].
- **Value 3, effort M, risk medium** (the popup re-centres on every click).

### M. Hub Animal Storage: kin among stored animals, and a Send to Zoo check
- Storage rows get a kin badge and a "Related to selection" filter. When several animals are sent
  to the zoo together (`AnimalStorage_SendToZoo(ids)`), say so if the group contains a related
  pair.
- In the hub the park world isn't loaded, so this can only compare storage animals with each
  other, not with a target habitat [inferred].
- Uses `StorageGetIDAndAIDType` and then `GetParents`, which is local [code].
- **Value 3, effort M–L, risk medium.** The hub is the Franchise surface, but this only reads, and
  the warning never blocks or changes the send.

### N. Warning before a move is confirmed
- Warn while the player is placing an animal into a habitat (`AnimalMovementMode` →
  `AttemptRequestToTransportAnimalToTarget`).
- That means patching a world interaction mode: fragile and hard to test. D already gives a
  post-move alert within seconds, which covers most of the value.
- **Value 4, effort L, risk high. Defer.**

### O. Maturity forecast
- "Kito becomes breeding-age in ~0.4 years and shares a habitat with his mother".
- Needs each species' maturity age, which hasn't been found in the extracted data yet [open].
- **Value 3, effort M, risk low. Later.**

### Not feasible / dropped
- **Warning before buying on the Market.** Market listings carry no parents (the game passes `{}`).
- **Hooking the game's own inbreeding notification.** It is defined in the unextracted
  Notifications database and raised natively. D replaces it.
- **Exhibit animals.** They use UIDs and `GetAnimalFamilyMemberUID`. They can be added to the
  foundation later. Value 2.

---

## 4. Ranking (value ÷ effort)

| Rank | Idea | Value | Effort | Risk |
|---|---|---|---|---|
| 1 | A. Animals list badge, tooltip, filter, summary | 5 | S | low |
| 2 | C. Heatmap shortcut | 3 | S | low |
| 3 | D. "New risk" alerts | 5 | M | low |
| 4 | B. Habitat panel markers and summary | 5 | M | low–med |
| 5 | F. Select at-risk / per-animal contraception | 4 | S–M | low–med |
| 6 | H. Habitats tab risk count | 3 | S–M | low |
| 7 | K. Family grouping sort | 3 | S | low |
| 8 | E. Info panel kin line and Studbook marks | 4 | M | low–med |
| 9 | G. Compare Mates candidate badges | 4 | M | med |
| 10 | J. Extended kinship and % | 3 | M | low |
| 11 | I. Relatedness matrix with offspring genetics | 4 | L | low |
| 12 | L. Genealogy locations | 3 | M | med |
| 13 | M. Hub storage kin and Send to Zoo check | 3 | M–L | med |
| 14 | O. Maturity forecast | 3 | M | low |
| 15 | N. Pre-move warning | 4 | L | high |

The foundation (section 2) comes before all of them: **effort M**.

---

## 5. Recommended first milestone: "Kin v1"

**Scope:** foundation (game tier and grandparent tier) + **A** + **B** + **C**.
This covers the developer's example in the two places where habitats are managed (the Animals
list, filtered by habitat, and the habitat's own panel), and adds a one-click route to the game's
own overlay. It is all display, so it carries no online risk.

**Step 0: an in-game spike (half a day, debug trace build), before any UI work:**
1. From the HUD Lua, in Sandbox, Career and Franchise: call `GetHabitats`, `GetAnimalsInHabitat`,
   `EntityIDToAnimalGUID` and `GetParents`. Log the types (are GUIDs strings or numbers? is an
   unknown parent `""`?) and the time a full-zoo scan takes.
2. Call `GetParents` on the GUID of a dead or traded parent. Does it still answer? This decides
   how far the grandparent and cousin tiers can reach.
3. Send a ~10 KB string with `TriggerEventAtNextAdvance` to the HUD page and time it. In
   parallel, try a mod-owned DataStore root.
4. Confirm the zoo list row `id` is `"animal_<entityID>"` in game.

**Then build:**
- `Main/pz2qol.kin.lua` (scan, cache, payload), with Lua tests in `tests/lua/` using a fake
  `animals` and `habitat` API, including the relation table above.
- `js/mods/pz2qol/kin.js`: receives the payload and gives every surface `kinOf(entityID)` and
  `habitatRisk(...)`. Unit tests in `tests/kin.test.mjs`.
- A: changes to `zoo.js` and `badges.js`. B: a new `habitatpanel.js`. C: two buttons.
- A browser harness scenario with a fake kin payload; look at the screenshots.

**Done when:** in a test zoo with a planted sibling pair, a parent and child pair and a cousin
pair, the Animals list shows the badges and filter, the habitat panel shows "2 related pairs"
with marked rows, the cousins are amber, contracepted pairs are grey, and the game's behaviour is
unchanged when the mod is removed.

**Milestone 2:** D (alerts), F (remedies), H, K.
**Milestone 3:** E, G, J, I. **Later:** L, M, O, N.

---

## 6. Risks and how to handle them

- **Mod and game disagree.** The game flags only parent, child and sibling pairs. The mod keeps
  that tier visually distinct (red) from its own extended tier (amber, labelled "not flagged by
  the game"). The native heatmap's rule is unknown, so idea C's tooltip says it may differ.
- **Performance.** Parents are cached for good, and pairs are checked only within one habitat and
  species. If the spike shows a full scan takes more than ~5 ms, the scan is split across frames.
  The scan never runs per frame.
- **Game patches.** Every call goes by name and is `pcall`-wrapped. If anything is missing, the
  badges are hidden and one silent entry is logged in the error log.
- **Online safety.** All reads are local; `franchise:*` async requests are avoided entirely. The
  only state change (F's contraception toggle) is one game event per user click, the same thing
  the game's own button sends.
- **UI churn.** Every badge goes in an inner element and is refreshed after updates, the proven
  row-recycling rule.
