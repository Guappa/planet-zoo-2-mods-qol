# Plan: Breeding programme "Deep" optimiser (2026-10-18, revision 4)

Status: plan, before implementation. Based on `docs/RESEARCH-breeding-optimisation.md` (main
tree). This plan lives in the worktree `.claude/worktrees/deep-optimiser`. The code is written
**directly in the main tree**, on top of planet-zoo-2-mods-15's final programme files (that agent
has finished; see §6).

Reviews: 6.8 → 8.4 → 8.7 → **9.2** (approved; its nits are folded in below). Revision 4 adds:
- the Stop/Continue state (`shownBest` plus `resume`, verified mid-round in the prototype);
- a problem signature for "stale" and Continue;
- starts and rounds defined, with the regression cases re-run under the start-0 scheme;
- a long-run light/strong check;
- the Move now rule.

## 1. Goal

The developer asked for the research's maximum to be implemented end to end:

1. a choice between the **old system** (Classic, today's search) and the **new system** (Deep);
2. the choice **saved as the player's default** (all zoos, Franchise included);
3. **performance options** for slower PCs or players in a hurry: number of starts (seeds), and
   other knobs;
4. **no ceiling for players who want it**: far more starts, longer limits, heavier repairs.

Out of scope (research §7, needs facts first): HiGHS/WebAssembly (Gameface support unknown; the
WASM build crashed in Node), branch-and-price, multi-generation objective terms, the upper bound
(13–37 % loose on test zoos: it would mislead). A WebAssembly probe mark is added (§2.6).

## 2. Design

### 2.1 Engine (`kinprogramme.js`, pure, Node-tested)

`PROGRAMME_DEFAULTS` gains (Classic unchanged when `engine` is `'classic'`):

| Option | Default | Meaning |
|---|---|---|
| `engine` | `'classic'` | `'classic'` or `'deep'` |
| `starts` | 12 | deep: **searched** starts, numbered 1…K, after start 0 (the Classic plan, which is not counted); rounds of 4 begin at start 1 |
| `effort` | 1 | deep: rounds per start = classic rounds `min(6000, 300+40n)` × effort |
| `patience` | 0 | deep: stop after N **rounds** (of 4 starts) in a row without a better plan (0 = never) |
| `repair` | `'light'` | deep: exact repair strength `off` / `light` (2 habitats, 2 000 layouts) / `strong` (3, 20 000); light from the multi-seed ablation (§4) |
| `warm` | null | deep: a placement to start from, `[{id, to}]` (the Classic plan's moves) |
| `wallLimitMs` | Infinity | deep: wall-clock limit (the panel's "Time limit") |
| `stop` | null | `() => bool`: true ends the search at once, the best so far is returned |

`solveDeep(ctx)`:

- Below `exactLimit` layouts: the exhaustive answer (as Classic).
- **Warm-start contract: Deep never returns less than Classic.**
  - The panel passes `warm` only when its Classic result has the **same `programmeKey` and sig**
    as the Deep job.
  - Deep maps the warm moves by animal id onto its own breeder indices. A move is dropped if its
    animal is not a breeder of this run, or if `canGo` refuses the place.
  - Without a usable `warm`, Deep runs `solveLayout` itself, with **the board's Classic budget**
    (`PROG_SEARCH`: 3 M evaluations / 6 s, own `makeBudget`), so it gets the same layout Classic
    would.
  - `best` is set to that layout **before start 0**. A Stop at any moment returns at least
    Classic's plan.
  - The final layout is the best of everything seen, then `prune`, which only accepts changes
    that keep the score.
- Starts 1…K−1, each with its own seeded source (`seedKey|start s`), **in rounds of 4**: within a
  round every start depends only on the best layout of the rounds before it, so a later
  multi-core version (Web Workers or the native helper, §7) can run a round in parallel and give
  the same plan. Odd starts rebuild 25–50 % of that best layout, even starts rebuild every breeder
  (greedy put-back). Then local
  search, `intensify`, and `rounds` rounds of kick (70 %) / ruin-and-recreate (20 %) / exact
  repair (10 %, unless `repair: 'off'`), annealing cooled over the start's rounds; the start's
  best is polished. Last, a polish of exact repairs on the overall best.
- `repairExact`: the breeders of the chosen habitats (half the time plus one empty habitat, plus
  up to 2 trade-centre breeders) placed in every possible way among those places, the trade centre
  and their homes, up to the strength's layout limit (the breeders with most choices are left in
  place until it fits). More habitats only pays with a higher limit, which is why the two are one
  setting.
- **Yielding**: `placeBack` (shared with `ruinRecreate`, which drains it) and `rebuild` become
  generators that yield every 8 placements; `exactPlace` yields every 1 024 leaves; every start
  round yields. No step runs longer than one slice by more than one group evaluation pass
  (Hungarian on ≤ 150 breeders: well under 10 ms).
- **Determinism**: same zoo + settings → same plan, unless the wall-clock limit or Stop cuts the
  run short (the result says `stopped: 'time' | 'stop' | null`).
- Budget: `maxEvaluations` is ignored by Deep; it ends on starts, `patience`, `wallLimitMs`
  (wall clock, `Date.now`/`performance.now`, not the async runner's search-only clock) or `stop`
  (polled every 200 evaluations in `makeBudget`).
- Result adds `engine`, `starts`, `startsPlanned`, `bestStart`, `stopped`, `msPerStart` (wall).
- Prototype: `scratchpad\deep\deepblock.js` + `patch.mjs` (anchored edits, re-appliable to the
  other agent's final file; the dropped bound is removed from it).

**Pinning audit** (after the merge, against the other agent's `ctx.pinned`): every move path is
checked: `localSearch` (single moves via `targetsOf`, swaps via `canGo`, pair moves via `canGo`),
`kick` (swap via `canGo`, single via `targetsOf`), `ruinRecreate` and `rebuild` (their list goes
to the trade centre in one `evaluate`: pinned breeders are filtered out of the list first),
`placeBack` (`targetsOf` and `canGo`), `reassign`/`reassignScarce` (movers exclude pinned),
`repairExact` (options from `targetsOf`, which for a pinned breeder is only home), and the
`evaluate` guard that rejects any change moving a pinned breeder. Tested with pinned breeders under
both engines and every repair strength.

### 2.2 Jobs and results (`kinboard.js`)

- **One Deep job at a time, owned by the module, not the panel** (`deepJob`: species, key, sig,
  start time, progress, starts done, best so far). Closing the panel does **not** cancel it: it
  keeps running in slices. The board's Breeding programme button shows the job,
  `Breeding programme · deep 34 %`, or `· Lions deep 34 %` when the job is for a species other than
  the selected one.
- **No takeover without a click.** An automatic start (§ below) never replaces a running job. If
  another species' job is running, the panel shows **Run deep search (stops the Lions search)**.
  Only a click on it, or **Stop**, ends the running job.
- **Stopped runs can continue.** Two things are kept:
  - **`shownBest`**: the best layout seen so far, including starts cut short partway through a
    round. It is what the panel shows and what **Use this plan** uses.
  - **`resume = { round, base }`**: the round that was running and the best layout at that
    round's start, as moves by id.

  **Continue** reruns that round from `base`. Every start in it depends only on `base` and its
  seed, so the run ends with the same plan as an uninterrupted one. The result is the better of
  the continued run and `shownBest`. This only works while key and **problem sig** still match.
  Prototype check (`scratchpad\deep`, 40-breeder 1:1, 8 starts): stopped after 300, 3 000 and
  8 000 polls (in round 1 and partway through it), Continue gave **identical moves** to the
  uninterrupted run. Every stopped result was at least the Classic plan (Stop is not polled
  during the inner Classic run, which takes at most 6 s).
- **When a job ends by itself** (its best so far is kept as a stopped result, except where noted):
  - **Park end or zoo change** (`PZ2QoL_StoreReset`, a new park scope in the kin model):
    cancelled, and its results are dropped. Entity ids don't survive a load, so a plan from the
    old load is meaningless.
  - **Plan run starts** (Execute) for the job's species: stopped (the zoo is about to change).
  - **Board closes** (the Species board page goes away): the job keeps running as long as the
    HUD page lives, and is shown again when the board reopens. When the HUD page itself unloads,
    everything goes with it.
  - **Recompute**: stops the job, drops the species' cached results, and runs Classic afresh.
- **Two signatures.** The full `programmeSig` (every animal of the species) keeps keying the
  Classic cache, as today. Deep uses a **problem sig** built from exactly what `prepare()` reads:
  - the breeders: id, place, `preg`/pinned, mates, fertility state, `moving`, and the trade-centre
    flag;
  - per habitat, the count of non-breeding adults (`fixedAdults`);
  - the habitat assignments and the destinations allowed for the species;
  - the species facts **as the search uses them**: each habitat's capacity (the integer from
    `habitatCapacity`), the group rule (`groupRule` output), the fertility ages and the conception
    table. Raw game data such as `available` or `calculating` is never included, so a habitat
    that finishes measuring with the same capacity changes nothing.

  A birth, or a keeper carrying a juvenile, does not change it. A pregnancy, a breeder's move or
  a breeder coming of age does.
- **Session result cache outside `S.prog`**: `deepResults`, LRU of 8, keyed by
  `species | programmeKey | deepKey | problemSig`. A finished or stopped result is stored under
  the problem sig it ran with, even if the zoo changed meanwhile.
- **Nothing restarts Deep by itself.** When the problem sig changes after a Deep result, the panel
  keeps showing it, with "The breeders changed since this deep search (N moves may no longer
  apply). Recompute to search again." Continue is then disabled. `useProgramme` already skips
  animals that can't move.
- **Move now** (one move outside a plan run, from the board): **does not stop the job**. If the
  moved animal is a breeder of the job's species, the problem sig changes and the result is marked
  stale as above. A job keeps running on its own snapshot; only Execute of a whole plan for that
  species stops it.
- **What runs when** (Classic keeps today's behaviour):
  - Opening the panel: Classic runs at once, as today (seconds), and is shown.
  - Deep starts **automatically** only if the player's saved engine is Deep **and** the preset is
    Quick or Standard **and** no cached result matches; otherwise the panel shows **Run deep
    search (est. ~4 min)**.
  - Changing the slider, make-up or trade toggle reruns Classic (as today); a Deep result for the
    new key is reused from the cache if present, else the Run button (or, for Quick/Standard, an
    automatic start after a 1 s debounce).
  - Changing an optimiser option never starts anything by itself until 1 s after the last change
    (Quick/Standard) or until Run (others), so stepping Starts 1 → 4 096 starts nothing.
- **The panel nearly always passes `warm`**: Deep is only started once the Classic result for the
  same key and sig is on screen. Without it (a rare race), Stop during the inner Classic run shows
  "Finishing the quick plan…" and stops as soon as that ends (≤ 6 s of search time).
- **As built (2026-10-18)**: while Deep runs, the panel keeps showing **Classic's plan** (Use this
  plan applies it) plus the live "+x % over Classic so far". The best deep plan appears when the run
  ends or on **Stop**, which lands within a step. Its stats come from the full result only.
- **While Deep runs**: the Classic plan (or the best deep plan so far, once a start beats it) is
  shown and **Use this plan is enabled** for what is shown; the bar reads
  `Deep · start 5 of 32 · best at start 3 · ~2 min left` (estimate = wall time per finished start ×
  starts left, capped by the time limit); **Stop** ends it and shows the best so far.
- Stats row note: `Deep · 32 starts · best at 7 · +1.4 % over Classic` (title explains;
  `stopped by the time limit after N starts` when cut short).

### 2.3 Options row (`kinboard.js`)

An **Optimiser** chip in the programme head (`Optimiser: Classic` / `Optimiser: Deep · Standard`)
toggles an options row under the head (inside the panel, no popup):

- Engine: **Classic** (a few seconds) / **Deep** (many starts; minutes).
- Deep presets, starts from the timing benchmark (§4) at 100 breeders in Node; the panel shows
  the live estimate, so a slower PC sees its real time:

  | Preset | Starts | Effort | Repair | Time limit (wall) | Auto-start |
  |---|---|---|---|---|---|
  | Quick | 4 | 1 | light | 2 min | yes |
  | Standard | 12 | 1 | light | 10 min | yes |
  | Thorough | 32 | 1 | light | 20 min | no (Run) |
  | Extreme | 128 | 2 | light | 2 h | no |
  | Marathon | 1 024 | 2 | light | none | no |
  | Custom | Starts 1 … 4 096 (×2), Effort ½/1/2/4/8, Repair off/light/strong, Time limit 1, 2, 5, 10, 30 min, 1, 3, 8 h, none, Stop early off/4/8/16/32 quiet starts | | | | no |

  Numbers are revised from §4 before shipping; Marathon/Extreme are honest about being hours.
- **CPU use**: Gentle (8 ms work / 24 ms rest), Light (12/12), Normal (24/4), Full (30/0). Applies
  to Classic too (the panel's slice/rest), default Normal (today's 24 ms). Classic's label says
  "a few seconds (up to ~25 s on Gentle)", since its 6 s budget counts search time only.
- Every change is saved at once as the player's default (§2.4).

### 2.4 Player-wide default: `prefs.js` (new) + Lua

`userstore.js` is per zoo; the default must hold across zoos:

- `pz2qol.playerstore.lua`: `ReadPrefs()` / `WritePrefs(sText)` under `tData.PZ2QoL.Prefs`
  (`{ S, N, P1.. }`, printable-ASCII JSON, cap 4 000 characters, a separate area from `Assign`, so
  the zoo cap/trim never removes it), `_Changed` → the existing delayed `RequestSaveMainPlayer`.
- `pz2qol.kin.lua`: `PZ2QoL_PrefsLoad(req)` → `PZ2QoL_PrefsData(req, ok, text)`;
  `PZ2QoL_PrefsSave(req, text)` → `PZ2QoL_PrefsSaved(req, ok)`; `pcall` everywhere; marks
  `prefs_loaded|empty|unavailable|written|refused`. Needs only the player, not a zoo key.
- `prefs.js`: `getPref`, `setPref`, `onPrefs`, `prefsStatus`; load once per page with a 6 s
  timeout → memory-only fallback; debounced save (400 ms); changes made before the load are
  replayed on top (same rule as `userstore.js`; the shared ~30 lines are factored into a helper
  rather than copied).
- Stored: `progOpt = { engine, preset, cpu }`, plus `custom = { starts, effort, repair, limit,
  patience }` **only when preset is Custom**, so later preset tuning reaches existing players.
  Loaded values are **clamped to the allowed steps**; anything unknown falls back to Classic /
  Standard / Normal.
- **Before prefs arrive**: the panel runs Classic (as always); when prefs arrive and say Deep +
  an auto preset, Deep starts then (once).
- First run with no prefs: Classic (the developer: the player's selection becomes the default).
- SKILL.md ground rule 2 (what the PZ2QoL entry holds) and `lua-runtime.md` updated; `prefs.js` is
  noted as the home for other session-only settings later (Pace, Kin options), not moved now.

### 2.5 `planProgrammeAsync`

`restMs` (pause between slices) beside `sliceMs`; `stop` and `wallLimitMs` passed through. A trace
mark per finished Deep run: `js_prog_deep_done` plus the starts done, the longest slice and the
share of wall time spent searching (`Core:Log`, debug builds).

### 2.6 WebAssembly probe

On HUD page load, once: `js_wasm_yes` / `js_wasm_no` from `typeof WebAssembly === 'object' &&
typeof WebAssembly.instantiate === 'function'`. Decides whether a solver like HiGHS is a next step.
Beside it, `js_worker_yes|no` (`typeof Worker === 'function'`, and whether a tiny worker from the
overlay's own resources answers a message) and `js_cores_<n>` (`navigator.hardwareConcurrency`):
if Gameface runs Web Workers, the starts (independent once grouped in rounds) can later run one
per core off the UI thread.

## 3. Tests

- `tests/kinprogramme.test.mjs`:
  - Classic unchanged: existing tests untouched.
  - **Deep ≥ its warm start** on 40 random zoos (20–40 breeders, all make-ups, `exactLimit: 0`,
    `starts: 2, effort: 0.5` to keep it ~20 s in total), and ≥ Classic on the same seeds (follows
    from the warm start; asserted), both with `warm` passed and without (inner Classic).
  - A stale `warm` (moves of animals not in the run, a pinned breeder moved) is dropped and doesn't
    break the run.
  - **Stop + Continue = uninterrupted**: stop at a round boundary **and partway through a round**
    (a `stop` that fires after N polls), continue, and get the same moves as one run. `shownBest`
    is never below the Classic plan.
  - **Problem sig**: a juvenile born, a juvenile moving, or a habitat that stops `calculating` with
    the same capacity leaves it unchanged. A pregnancy, a breeder moving, a breeder coming of age,
    or a capacity change changes it. These tests are written **first**, before the cache and
    Continue use the sig.
  - **Deep beats Classic where Classic is short**: two regression zoos from the MILP benchmark
    (generator copied into the test). Re-run under the start-0 scheme, Node:
    - 20-breeder 1:1: Classic 2.9819; Deep with 4 starts 3.0335 (1.3 s); Deep with 12 starts
      **3.0802 = proven optimum** (3.3 s).
    - 40-breeder 1:3: Classic 6.3936; 4 starts 6.4699 (4.0 s); 12 starts **6.4905 = proven
      optimum** (10.5 s).

    The test uses Standard (12 starts) on both, about 14 s in total. Quick does **not** reach the
    optimum there, and the UI says so ("Quick: fast, usually most of the gain").
  - Determinism: same zoo + settings → same moves (`wallLimitMs: Infinity`, injected clock).
  - `stop()` after the first start returns a valid plan with `stopped: 'stop'`; `patience` stops
    early; `wallLimitMs` with a fake clock stops with `stopped: 'time'`.
  - Pinned breeders never move under Deep, every repair strength (once merged).
  - 0 breeders, unisex species, all breeders at the trade centre, one habitat: no crash, valid plan.
- `tests/prefs.test.mjs` (new): load, save, replay, timeout → memory, clamp of bad values, Custom
  kept only for Custom.
- Lua (`tests/lua/test_pz2qol.lua`): `ReadPrefs`/`WritePrefs` (cap, bad text, untouched by `Assign`
  trimming), the Kin prefs events.
- UI harness (`tests/uiharness/kin_programme_deep.mjs`, new): options row, presets, Run, progress
  text, Stop, Continue; **no restart on a sig change** (fake scan); the result **survives close and
  reopen**; the button's `deep N %` (with the species name when another is selected); opening a
  second species with Deep Standard **doesn't stop** the first job (shows "stops the … search");
  park end / `PZ2QoL_StoreReset` cancels; Execute of that species stops it; Recompute stops and
  reruns; prefs arriving after the panel opened. Screenshots looked at.

## 4. Benchmarks (before shipping)

On the MILP benchmark zoos (`scratchpad\milp\results.jsonl`):

- **Ablation at equal time** (30 s, unlimited starts): repair off / light / strong. Decides the
  default strength and whether repair stays on.
- **Per-start wall time** at 20 / 40 / 70 / 100 breeders, to set the presets' limits.
- **Gap to the best known** for Quick and Standard at 40–100 breeders. Target: Standard closes at
  least half of Classic's mean gap.
- After `patch.mjs` is re-pointed at the final `kinprogramme.js` (done 2026-10-18: `base.js` is a
  fresh copy of the main tree's file, including the pinning edits), the Stop/Continue check and
  both regression cases were re-run on the patched file (results above). They are re-run once more
  on the real file after implementation.
- Preset times are not announced in the README until the first in-game `js_prog_deep_done` line
  (time per start at a known breeder count) is quoted in the skill.
- Results into the research doc and the skill. Gameface speed is unknown: the live estimate and the
  `js_prog_deep_done` mark cover it; presets are re-tuned from the first in-game log.

**Measured already** (Node 24, prototype, 30 s wall per run, unlimited starts, effort 1;
`scratchpad\deep\ablate.mjs`; "best" = best of MILP 300 s, Classic and every Deep run):

| Zoo | Classic gap | Deep, repair off | Deep, light (2 k) | Deep, strong (20 k) | Wall time per start (light) |
|---|---|---|---|---|---|
| 40 1:3 | 1.4 % | 0 | 0 | 0 | 0.8 s |
| 40 mixed | 1.0 % | 0 | 0 | 0.1 % | 0.7 s |
| 70 1:3 | 1.9 % | 0.5 % | 0.5 % | 0.9 % | 3.3 s |
| 70 mixed | 0.9 % | 0.3 % | 0.2 % | 0.7 % | 2.7 s |
| 70 1:1 | 0.9 % | 0.2 % | 0 | 0.3 % | 3.8 s |
| 100 1:3 | 3.8 % | 1.5 % | 1.8 % | 0.6 % | 10 s |
| 100 1:1 | 13.7 % | 4.5 % | 2.4 % | 4.7 % | 6 s |
| 100 mixed | 1.9 % | 0.1 % | 0 | 0.3 % | 6 s |
| 100 harem | 2.7 % | 0.1 % | 0 | 1.7 % | 7.5 s |

- (Single runs, superseded by the multi-seed table below: 30 s of Deep took the mean gap from
  3.1 % to 0.5 %; at 100 breeders Deep beat the MILP's 300 s layout in 3 of 4 zoos.)
- **Repair, multi-seed** (24 zoos: 70 and 100 breeders × 4 make-ups × 3 zoo seeds, 30 s each,
  `ablate2.mjs`; gap to the best known):

  | | Mean | Median | Max | Best or tied |
  |---|---|---|---|---|
  | Classic (board) | 2.56 % | 2.22 % | 13.72 % | – |
  | Deep, repair off | 0.75 % | 0.59 % | 4.53 % | 2 / 24 |
  | **Deep, light** | **0.63 %** | **0.37 %** | **2.40 %** | 5 / 24 |
  | Deep, strong | 1.34 % | 1.11 % | 7.00 % | 1 / 24 |

  Light beats or ties off in 14 of 24, with the biggest wins on 1:1 (the hardest case: max 2.4 %
  against 4.5 %); off is better on most 1:3 zoos, by 0.03–0.4 %. Strong is worse at equal time
  in 21 of 24 (fewer starts). So **light is the default for every preset**; off and strong stay
  in Custom ("strong: slower per start; at equal time it did worse on test zoos"); heavy is
  dropped (no evidence, and days for big runs). The single-run table above is superseded where
  they disagree (e.g. 100 1:3: light 1.8 % vs off 1.6 %, which the multi-seed run confirms).
- **Long runs, light vs strong** (the 4 hardest zoos: 100 breeders, 1:1 and 1:3; 10 min wall
  each, effort 2, `long.mjs`):

  | Zoo | Classic | Light (starts) | Strong (starts) | MILP best in 300 s |
  |---|---|---|---|---|
  | 100 1:1 #1 | 20.043 | 20.775 (19) | **20.785** (8) | 20.797 |
  | 100 1:1 #2 | 5.766 | **6.632** (23) | 6.552 (10) | 6.683 |
  | 100 1:3 #1 | 21.987 | **22.645** (18) | 22.575 (8) | 22.846 |
  | 100 1:3 #3 | 26.643 | **26.983** (18) | 26.881 (8) | 27.022 |

  Even with time to spare, light wins 3 of 4, and strong's one win is by 0.05 %. So **every preset
  uses light**. Marathon's extra strength is its **number of starts and effort, not the repair**,
  and its description says so. Strong stays in Custom for players who want to try it. On these
  hardest zoos, 10 minutes of Deep gets within 0.1–0.9 % of the MILP's best, not beyond it. The
  research doc's ranking (MILP proves optimality only up to ~70 breeders) still holds.
- **Presets from these times** (100 breeders, Node, light: 6–10 s per start; Gameface assumed up to
  ~2× slower, the live estimate shows the truth): Quick 4 starts ≈ 25–40 s; Standard 12 ≈ 1.2–2 min;
  Thorough 32 ≈ 3–5 min; Extreme 128 × effort 2 ≈ 25–45 min; Marathon 1 024 × effort 2 ≈ 3.5–6 h.
  Limits in §2.3 leave about 2–5× headroom (Marathon has none: it runs until done or Stop).

## 5. Docs and skill

README (Optimiser options: Classic vs Deep, presets, CPU use, Stop, runs in the background);
skill `animals-and-breeding.md` (optimiser), `lua-runtime.md` (`Prefs` area), SKILL.md ground
rule 2; changelog line.

## 6. Delivery

1. planet-zoo-2-mods-15 has finished its programme edits (pinning, contraception advice, stored
   cards); its build 6 is queued for Y: (prebuilt, copied when the game closes). Once it reports
   the copy done, implement **directly in the main tree on top of its final files** (no merge
   needed; the worktree then only holds this plan). Its remaining work (lister id fix:
   `pz2qol.lister.lua`, `listercore.js`, `lister.js`, `marketdesk.js`) doesn't overlap; I don't
   touch those files, and I don't run a Y: installer while its install waits.
2. `kinprogramme.js` via `patch.mjs` re-pointed at the final file (anchors checked), then by hand;
   `kinboard.js` by hand. All tests (unit, Lua, UI harness) in the main tree.
3. Build fresh, install on Y: only while the game is closed; tell the developer what to look at
   (`js_wasm_*`, `prefs_*`, `js_prog_deep_done`, a Deep run on a big species).
4. Nothing is committed on main without the developer asking (shared tree; explicit paths only).

## 7. Investigation (not in this implementation): a native multi-core helper

The developer wants sideloading our own native code looked into, for real multi-threading.
Investigation only; nothing ships without the developer changing the ground rules (below).

**What is already known.**

- Native code can be loaded **without touching the exe**: the game's Lua keeps
  `package.loadlib`, and PZ2QoL's debug builds load `dbg\cp_*.dll` / `lg_*.dll` that way (proven
  on 1.0.5, Franchise, `reference/debugging.md`). A loaded DLL can start its own threads and use
  every core: a C++ solver (the Deep engine ported, or HiGHS natively) could run 10–50× faster
  than the UI-thread JavaScript.
- **The obstacle is passing data.** The exe exports no Lua C API (proven, export table), so a
  DLL function can't read its arguments or return values to Lua.
  - **In** is solved, slowly: the debug log's "spelling" channel (one `mark` per byte through 98
    DLL copies, ~0.2 ms per 100 characters). A 150-breeder problem (ids, genes, parents, places,
    options) is ~10–20 KB, so ~20–40 ms.
  - **Out** is the open question.

**Probes (one debug build, read-only, in an offline park first):**

1. **Is there a file searcher?** Check whether `package.searchers`, `package.searchpath`,
   `loadfile` and `dofile` exist in retail. If Lua's standard file searcher works, the helper
   writes its answer as `answer_<n>.lua` and Lua `require`s it, which gives a full return channel.
2. **Existence as a signal**: `package.loadlib(path)` succeeds or fails depending on whether a file
   exists. That gives 1 bit per call (slow, but a fallback for small answers such as "done" or a
   move list index).
3. **Gameface file reads**: can the page `fetch` / XHR / `<script src>` a file the helper writes
   (`coui://` mapping, `file://`)? That would give a direct channel to the JavaScript side.
4. **Threads**: start a worker thread from an exported function (never from `DllMain`: loader
   lock). Check that it survives park load/unload, stops cleanly on exit, and doesn't disturb the
   game's frame time (`js_prog_*` timing marks before and after).
5. **Release builds**: does `package.loadlib` behave the same outside debug builds and in every
   game mode?
6. **Online side**: whether a foreign DLL in the Franchise client is visible to Frontier, through
   anti-tamper checks, a crash reporter that lists loaded modules, or the terms of service. The
   debug trace DLLs already load in Franchise, but nobody has checked what that reports.
7. **Speed**: "10–50× faster" is a **guess** until a native port of one Deep start is timed against
   the JS one on the same zoo.
8. **Distribution**: upload a test zip with a DLL to Nexus privately and see whether it is flagged
   or quarantined (the ac8 Nexus skill documents how Nexus scans react); check Windows Defender /
   SmartScreen on a fresh PC.

**Rules that would have to change (the developer's decision, not assumed).**

- Ground rule 6 ("a plain zip only, no installers or executables") would need an exception for a
  DLL inside the mod folder.
- Ground rule 1 ("no proxy DLLs") doesn't cover this, since the game loads it itself through its
  own Lua with no exe change. That reading should be confirmed with the developer.
- **Franchise**: the helper only computes locally on data the mod already reads, and nothing sent
  to Frontier changes. It would still be off by default until proven safe.
- **Fail soft**: no DLL, a failed probe or a timeout falls back to the JavaScript engine.

**Output**: a short findings note (which channels work, round-trip time, frame impact, scan
result) and a go/no-go recommendation for a native Deep engine.

## 8. Risks

- **UI thread**: Full CPU leaves little frame time; Normal is the default, Gentle/Light for slower
  PCs. Longest slice is logged.
- **Long runs in the background** could surprise a player: the button shows the progress, and
  Stop is one click; nothing long starts without a click except Quick/Standard for players who
  chose Deep.
- **Merge conflicts** in `kinboard.js`: expected, handled by hand (§6).
- **Determinism** only without a time limit or Stop (stated in the note).
