# Plan: pair bonds in the Kin warnings ("Bonded elsewhere")

Status: **implemented 2026-10-16** (sections 4–7). Unit, Lua and harness tests pass. The in-game probe
(section 9) has not been run yet. Written 2026-10-16 for game 1.0.5 (build 1023906).
Started by a player's suggestion: a Greater Flamingo mother and her adult son share a habitat. Kin
calls the pair an Inbreeding risk, but the son is bonded to another female and the game's Compare
Mates screen says the two cannot conceive (monogamy).

## 1. Goal

Kin should separate "these two are related" from "these two can breed now". It should use the
game's own monogamy rule, work for every monogamous species (DLC included) with no species list,
and never warn less than today unless the game itself reports the block.

Non-goals: Thin out (`kincull.js`) and the breeding programme (`kinprogramme.js`) stay as they are.
They judge relatedness for the long term, and a bond does not change that. Hub storage screens
(`kinstorage.js`) are not changed either: the hub has no park world to ask.

## 2. Facts this relies on

Read from the decompiled 1.0.5 Lua (`reference/animals-and-breeding.md`, 2026-10-16). Nothing
here has been seen in game yet; see section 9.

| # | Fact | Source |
|---|---|---|
| F1 | Compare Mates says "can't conceive" when either animal's `GetMatingWarnings(id, type).bMatingBlocked` is set, the best-case chance is 0, or `animals:GetMatingMonogamyIcon(self, other, otherIdType)` is `"IconLock"` in either direction. | `CompareMatesPopup._SetOffspringData` |
| F2 | `"ring"` means the two are mates. `"IconLock"` means self has an existing mate (`[InfoPanel_Animals_MonogamyExistingMate]`). | `CompareMatesPopup.CreateMonogamyToolTip` |
| F3 | The game works out `inbred` separately from F1. | same function |
| F4 | `GetMateData(e)` gives `bIsMonogamous` and `tMateData`. A bonded mate stays listed when it is dead, has left the zoo or was moved, and the animal mourns on a timer (`GetCurrentMournTimeForUI`). | `AnimalInfoPopUp._UpdateBondedMateData` |
| F5 | The mod's `mateIds` (`pz2qol.kin.lua` ~350) already collects `tMateData` for adults in habitats, so dead and absent mates can be in it. | mod code |

Inferences, which the probe in section 9 must confirm:
- **I1:** `IconLock` comes only from self's own bond, so an animal without a mate never locks.
- **I2:** While `IconLock` holds, the game really never conceives that pair: the lock is enforced,
  not just shown.

How the design copes if one of them is wrong:
- If I1 is wrong, the design still uses only the game's per-pair answer, so nothing breaks. A few
  icon calls are skipped, which means a few pairs stay at today's level.
- I2 is what the whole feature rests on. The player's switch (section 5.6) is the fallback.

## 3. The rule

A pair is **held** (shown as "Bonded elsewhere") only when **all** of these hold:

1. Its base level is `risk` or `kin`. The base level comes from today's `pairSeverity`, which is
   unchanged, so Covered and Future still win first.
2. The setting "Pair bonds count as protection" is on (the default).
3. For at least one side `s` (with `o` the other animal):
   - the game returned `IconLock` for `(s, o)` in this scan;
   - `s.bond.mate` is in the model, alive, and in the same assigned habitat as `s`;
   - that mate is not `o`.
4. The bond data of this scan is valid (`bondsOk`).

Otherwise the pair keeps its base level, exactly as today.

Why this is sound:
- **(1) and (3)** together mean the result can only be lower than today when the game itself says
  this pairing is blocked.
- **The mate check in (3)** handles three cases:
  - Mourning: the mate is dead or absent but the lock may still be on. We warn, which is the safe
    side, and the player has the mourning time to act.
  - Simulated moves on the Species board (section 5.3).
  - Stale lock data.

  It uses the assigned habitat, not `IsInHabitat`, so a vet or transport trip does not flip the
  pair back and forth.
- **"Mate is not `o`":** if the two are each other's mates they get `ring`, not `IconLock`. That
  stays a Risk with the "mates now" heart, which is the worst case.
- **No species list.** Every input is read per animal or per pair at runtime, so new species work.

Results the tests must cover:

| Case | Result |
|---|---|
| Son bonded to an unrelated female in the habitat; mother there too | son and mother **held** (base risk) |
| Same, grandmother instead of mother | **held** (base kin) |
| Son's bonded mate dead, moved, left, or in the trade centre | **risk** |
| Son and his sister are each other's mates | **risk**, "mates now" |
| Polygynous species with `tMateData` | unchanged (no icon pass) |
| Juvenile involved | **future** (unchanged; juveniles have no mate data) |
| Contraception plus a bond | **covered** (unchanged; covered is checked first) |
| Switch off, or old Lua without bond data | identical to today |

## 4. Lua: the bond pass (`mods/PZ2QoL/Main/pz2qol.kin.lua`)

1. **`mateIds` → `mateInfo`.** Also return `bIsMonogamous` (still `pcall`ed). `tRec.mates` stays
   exactly as it is, because the programme, Thin out and the "mates now" heart read it.
2. **A new budgeted phase in `_Step`,** after the animal and exhibit phases and before
   `_FinishPark`:
   - Group the park records by `hab` and species. Only adults, no exhibit animals.
   - Each record with `mono == true`, a non-empty `mates` list and a `hab` is a bonded animal.
   - For each bonded animal `s`, call `animals:GetMatingMonogamyIcon(s, mate, 0)` once and store
     `ring = (icon == "ring")`.
   - Then, for each other adult `o` of its group with a compatible sex (different sexes, or either
     unisex) that is not its mate, call `GetMatingMonogamyIcon(s, o, 0)`. Collect the `o`s where
     the answer is `"IconLock"`.
   - Wrap every call in `pcall`. Allow at most `Kin.nBondPerFrame = 200` calls per frame, which a
     40-bird flamingo flock needs only about 2 frames for. The job timeout stays.
3. **Record field:** `bond = { mate = "<id>", ring = bool, lock = array(ids), mourn = n | nil }`,
   only on bonded animals. `mourn` comes from `GetCurrentMournTimeForUI` and is used only for
   wording. The bond's `mate` is `tMateData[1].nID`, the same mate the info panel shows.
4. **Snapshot:** add `bondsOk = true`. If the phase raised an error, or `GetMatingMonogamyIcon` is
   missing, set `bondsOk = false` and drop every `bond`. The snapshot keeps `v = 1`, because new
   fields are optional and an older page ignores them.
5. **Trace:** add a `kin_bonds` mark and a summary line in the debug trace (bonded count, locks,
   calls, ms).
6. All calls are reads. Nothing is sent to Frontier's servers, so this is safe in Franchise.

## 5. JS changes

### 5.1 Model (`kincore.js`)
- `normalizeSnapshot`: `bond: { mate: String, ring: !!, lock: [String], mourn?: number } | null`,
  validated. Keep `snap.bondsOk`.
- New level `held`:
  - `SEVERITY_ORDER = ['risk','kin','future','held','covered','distant']`;
  - `SEVERITY_RANK` renumbered `{risk:6, kin:5, future:4, held:3, covered:2, distant:1}`;
  - `SEVERITY_INFO.held = { label: 'Bonded elsewhere', short: 'Bonded', tip: 'Related, but the game will not let them breed: one of them has a mate (monogamy). If that bond ends, this becomes a risk again.' }`.
  - Why it sits below Future: Future is certain to become a risk when the young one grows up. Held
    only becomes one if a bond ends, which may never happen.
- `buildKinModel`:
  - Work out `base = pairSeverity(...)` once (today it is computed twice, at :638 and :639).
  - Then apply `bondHold(animals, m, f)` (rule 3), but only if `base` is risk or kin,
    `opts.bondHolds !== false` and `snap.bondsOk`.
  - The pair gains `held: { by, mate, fragile }` and `unheld: base`.
  - `fragile` is a note only: it is set when the bonded mate is elderly (`ageQ === 3`) or its
    `fert.state === 'old'`.
- Add `held` to every counts literal: `counts` (:662) and the two in `summarizeHabitats`
  (:776, :783).
- **Keep the options with the model:** store `model.opts = { closeKinship, bondHolds }`.
  `simulatePlan` (`kinboardcore.js:88`) and `speciesModel` (:509) must pass `model.opts`. Today
  they rebuild with `{ closeKinship }` only, so without this change simulated models would silently
  ignore the switch.
- `habitatsAtRisk` stays as it is (risk, kin, future), so held-only habitats are not "at risk".
- Sorting within held: by `unheld` rank, then kinship.

### 5.2 Text and cards
- **`coverReason`'s counterpart `holdReason(p)`:** "Leo is bonded to Pip (monogamy); the game won't
  pair him with Mara while Pip is here." With `fragile`, it adds: "Pip is elderly: when the bond
  ends, this becomes an inbreeding risk."
- These places use it:
  - `kinui.js` pair rows (:119) and the species summary (:318);
  - `kinplanner.js` pair card (:828) and cell titles (:623);
  - `kinhabitat.js` lines (:137);
  - the Genealogy badge in `kinmates.js` (:405).
- **Compare Mates** (`kinmates.js` `matePair` :204) builds its level from the tier only. When both
  animals are in the park model and share a habitat, use the model pair's `severity`, so the mod's
  card agrees with the game's lock icon. Otherwise keep the tier mapping.
- **Mate finder** (`kincore.js` `mateCandidates`, planner "best mate" card): for a bonded animal of
  a monogamous species, add a line: "bonded to Pip: the game pairs Leo with no one else while Pip
  is here". The ranking is unchanged.
- No move suggestion for held pairs: `kinplanner.js:843` already limits suggestions to risk and kin.

### 5.3 Species board (`kinboardcore.js`, `kinboard.js`)
- **`plannedSnapshot`:** clear `bond` on every moved animal, and on every animal whose `bond.mate`
  is moved. Without this, moving a mourning animal's mate back would look like a restored bond,
  which isn't confirmed.
  - New pairs a plan creates have no lock data (the lock list was built from current habitats), so
    they come out as risk or kin, exactly as today.
- **`COUNTED`** (risk, kin, future) is unchanged, so a plan that breaks a bond reports that pair as
  **created**:
  - `planImpact` sees a held pair turn into a risk;
  - `suggestPlan` rejects moves where `createdBad > 0`, so automatic fixes never break a bond in a
    way that exposes a relative;
  - held pairs are not targets for fixes, because `watched` stays risk/kin.
- **`emptyCounts`** gains `held`. Otherwise `speciesList` (:48) drops it silently through
  `p.severity in s.counts`.
- **`boardColumns`** (:348) includes held next to covered for display.
- **`kinboard.js`:**
  - the worst-level logic (:362, :516) adds held between future and covered;
  - the change tags (:636-639) treat held like covered, so a bond-breaking plan shows "new risk";
  - the class list (:740) adds `held`, and the `rel_held` tone (:775) gets CSS.

### 5.4 Counts, filters, toolbar
- `kinplannercore.js`:
  - add `held` to `COUNTED` (:12) and `COUNT_WORDS`;
  - `visibleCounts` (:27) passes `held` through always. It is **not** hidden by the "Covered pairs"
    switch, because the player asked to keep this information visible.
  - `worstOf` follows `COUNTED`.
- `kinpanel.js` `countPills` follows `COUNTED`.
- `kinui.js`:
  - `riskSummaryText` adds "N bonded elsewhere";
  - `worstOfCounts` adds held after future.
- `kinzoo.js`:
  - `out.any` (:41) leaves held out, like covered;
  - the total (:91) includes held.
- **`scores.js` `KIN_RANK`** becomes `{ risk: 5, kin: 4, future: 3, held: 2, covered: 1 }`, and the
  'any' filter test (:313) becomes `>= 3`. This is a renumbering trap: the meaning of 'any' (risk,
  close kin, later) must not change.
- `kinplanner.js`:
  - the "habitats need care" count (:733) is unchanged (risk and kin only);
  - add held to the legend (:176) and the help rows (:739).

### 5.5 Alerts (`kinalerts.js`, `kincore.js` `newRisks`)
- Held is not watched, so no alert fires while a bond holds.
- When a bond ends (held → risk), `newRisks` already reports the pair. Pass along
  `wasHeld = before.get(key) === 'held'` and word the toast "Bond ended: Leo ♂ and his mother Mara
  ♀ can now breed".
- The existing `SEEN_MS` de-duplication covers back-and-forth flips.
- If `next.snapshot.bondsOk === false`, skip pairs that were held in the previous model. A failed
  bond pass must not raise false alerts. The model shows them at their base level for that one scan.

### 5.6 Setting (`kin.js`)
- `DEFAULT_KIN_SETTINGS.bondHolds = true`, with a planner settings switch "Pair bonds count as
  protection" next to "Covered pairs" (`kinplanner.js` ~276).
- Changing it rebuilds the models (`kin.js:123`, `:134` pass `bondHolds`). It is a per-viewer
  setting in `localStorage`, like the other Kin settings.
- Default on: it shows what the game enforces, in the same way contraception already counts as
  cover.

### 5.7 CSS and icon
- `sev_held` in `pz2qol_kin.css`, `pz2qol_kinplanner.css` and `pz2qol_kinboard.css` (`rel_held`),
  next to every `sev_covered` rule (11 today).
- Colour: a distinct cool tone between Future and Covered.
- Icon: the game's lock icon, the one Compare Mates shows, if the `icon()` helper resolves it.
  Otherwise a text tag.

## 6. Regression guards

1. **Golden test** (`tests/kin.test.mjs`): for every existing fixture, the pair severities, counts
   and orders must be deep-equal to today's in three cases: (a) no `bond` fields, (b) bonds present
   with `bondHolds: false`, (c) `bondsOk: false`.
2. **One unit test per row** of the table in section 3.
3. **Board** (`tests/kinboard.test.mjs`):
   - a plan that moves the bonded mate reports one created risk;
   - `suggestPlan` never picks that move as a fix;
   - `speciesList` counts held;
   - simulations respect `bondHolds: false`.
4. **Filters** (`tests/zoo.test.mjs` / `scores.test.mjs`): 'risk' and 'any' give the same results
   for every existing level; held is excluded from both.
5. **Alerts:** held → risk alerts once with the "bond ended" text; `bondsOk: false` gives no alert.
6. **Lua** (`tests/lua/test_pz2qol.lua`):
   - mock `GetMatingMonogamyIcon` and `bIsMonogamous`;
   - the pass budget spreads over frames;
   - an error gives `bondsOk = false`;
   - `tRec.mates` is unchanged;
   - non-monogamous species and exhibits get no icon calls.
7. **UI harness:** add a bonded flamingo family to `kin_fixture.mjs`, then check screenshots of the
   planner, board, habitat panel and Compare Mates. Look at them.
8. Run the full test set from `reference/testing.md`.

## 7. Docs
- README Kin section: the new level, the switch, and that it follows the game's monogamy lock.
- The skill (`animals-and-breeding.md`): the bond pass, the probe results, and pass `I1`/`I2`
  once confirmed; plus a changelog line.

## 8. Order of work
1. Probe (section 9). This decides go or no-go for I2.
2. Lua bond pass and Lua tests.
3. Model plus the golden and rule tests.
4. Board and simulation, then counts, filters and settings, each with its tests.
5. Text, cards, CSS, then the harness screenshots.
6. Alerts.
7. Docs, then an in-game check of the build.

## 9. In-game probe (read-only, before any of the above ships)

A debug build with a temporary trace dump runs once per scan. It logs, for each monogamous-species
habitat group: each adult's `GetMateData`, `GetMatingMonogamyIcon` against every compatible adult
in the group, `GetMatingWarnings(e, 0)` and the mourning time.

Check in the player's flamingo case, or any bonded family:
1. Son vs mother gives `IconLock`; son vs his mate gives `ring`.
2. Adults with no mate never return `IconLock` (I1).
3. Compare Mates shows "can't conceive" exactly for the locked pairs.
4. Polygynous species never return `IconLock`.

In an **offline sandbox zoo** (it needs moves, so not Franchise):
- Move the son's mate away and log over time. Does `IconLock` hold while he mourns, and does it end
  with the timer? This only changes wording, because the rule already warns whenever the mate is
  absent.

For I2, over several in-game years:
- Keep a bonded son, his mate and his mother together and record any pregnancy of the mother.
- None should happen. If one does, I2 is false: ship with the switch default off, or not at all.

## 10. Remaining risks
- **I2 is inferred from Compare Mates.** The probe is the check, and the switch is the fallback.
- **A game patch could change `GetMatingMonogamyIcon`.** Every call is `pcall`ed, and a failure
  gives `bondsOk = false`, which is today's behaviour.
- **Breeding-pair counts** (`breedingPairs`, `kinboardcore.js:473`) still count a bonded
  monogamous animal as free to pair with others. That was already true and isn't changed here; it
  could be a follow-up.
- **Other game blocks are out of scope.** Beta status and interbirth (`bMatingBlocked`) are often
  short-lived, and turning them into cover would make warnings flicker.
