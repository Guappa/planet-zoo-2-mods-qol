# Design: Autopilot (optional full-auto breeding management)

Status: **superseded by section 16 (2026-10-18): Auto mode per species, on the Species
board.** The developer narrowed the scope: an auto mode chosen per species that runs the
Breeding programme on a schedule and moves the animals, with no human maintenance. Sections 0-15
describe the zoo-wide Autopilot that was built first (2026-10-16, never released); the parts
still in use (store binding, offline evidence, the gate, one action at a time, the log and Undo,
the player's moves respected) are carried over in section 16. Not yet run in the game.

Goal: an **opt-in** mode that does in the background what the player now does by hand on the
Species board: **Suggest fixes** when a breeding problem appears, the **Breeding programme**, and
**Thin out**, then **Execute**. It is one system with one objective, not three buttons on a timer.
It is **off by default** and stays off until the player turns it on for a zoo, because managing
breeding is the game for many players.

Grounded in the code as it is today:

| Area | Pure engine (Node-tested) | Runtime / UI | Lua |
|---|---|---|---|
| Suggest fixes | `kinboardcore.js` `suggestPlan` | `kinboard.js` `suggest()` | – |
| Breeding programme | `kinprogramme.js` `planProgramme` | `kinboard.js` `openProgramme()` / `useProgramme()` | `Kin.SpeciesInfo` (`PZ2QoL_KinSpecies`) |
| Thin out | `kincull.js` `cullPlan` | `kinboard.js` `openCull()` / `useCull()` | – |
| Plan simulate / check | `kinboardcore.js` `simulatePlan`, `planImpact`, `planProblems`, `prunePlan` | – | – |
| Execute | – | `kinmoves.js` `runPlan` (one move at a time, confirmed, skip on failure, Stop) | `Kin.Move` (`PZ2QoL_KinMove`), `Kin.Destinations` |
| Observation | `kincore.js` `buildKinModel`, `newRisks` | `kin.js` (scan every 20 s, 6 s while a kin surface is open), `kinalerts.js` | `Kin.Scan` / `Kin._StartPark` |
| Assignments, persistence | `kinboardcore.js` `resolveAssignments` | `kinassign.js`, `userstore.js` (player save, 60 KB per zoo) | `pz2qol.playerstore.lua` |

---

## 0. The rule this collides with (read first)

`CLAUDE.md` and the skill's ground rule 3 say Franchise automation **only ever starts from the
player's click, never a timer or the background**, and that there are **no "allow in Franchise"
switches** (developer decision, 2026-10-16). A background autopilot in a Franchise zoo is exactly
a timer-started action, and its on switch is exactly such a switch. The developer only plays
Franchise, so this decides how much of the request phase one can deliver.

This design works either way; only the **trigger policy** (section 6.4) changes:

- **Offline parks (Sandbox, Career, Challenge): true background.** Allowed by the rules today.
- **Franchise, rules unchanged: "one-click autopilot".** Everything runs in the background
  (watching, deciding, planning, validating, reporting), and the plan is kept ready at all times.
  The only thing the player does is one click on the autopilot's chip or toast ("4 moves ready:
  2 risks fixed, 2 to the trade centre — **Run**"). That click starts one cycle, which runs one
  action at a time as `runPlan` does now. This replaces today's loop of opening the board, picking
  each species, Suggest fixes / Programme / Thin out, Use this plan and Execute, with one click per
  cycle across the whole zoo.
- **Franchise, rule amended by the developer: true background there too**, with the stricter
  Franchise safety in section 9.3.

**Recommendation:** amend the rule narrowly. Autopilot's per-zoo opt-in becomes the one standing
opt-in that may start actions in Franchise. It only runs its own validated plans, one action at a
time with the same pacing and server-error handling, and never touches the market, money or the
hub. Until the developer says so, the code ships the one-click policy for Franchise (one
constant). Autopilot never changes **what** is sent to Frontier: every action is the game's own
call (`AttemptRequestToTransportAnimalToTarget`, `AttemptToSendToTradeCentre`,
`RequestTransportToAssignedHabitat`, `SetUsingContraceptive`), the same as a player's click.

---

## 0a. Rule: off changes nothing

**With Autopilot off (the default, and in every zoo where it was never turned on), the mod works
exactly as it does today.** The Species board, Suggest fixes, the Breeding programme, Thin out,
Execute, Move now, Kin alerts, scans, Find a habitat, assignments and the player save behave and
answer exactly as before. The only visible difference allowed is Autopilot's own **greyed-out
launcher button** (it opens the setup). This is a requirement for every phase, not a goal:

| Item | While Autopilot is off |
|---|---|
| Engines (`suggestPlan`, `planProgramme`, `cullPlan`) | New options only; their defaults are today's behaviour. Return shapes unchanged (anything extra comes from a new function or an opt-in option). Status-quo bias and the stable tie-break apply **only when Autopilot passes them**; the panels never do. `maxEvaluations` stays 60 000 for the panels. |
| Executor (`kinmoves.js` `runPlan`, `moveAnimal`) | Opt-in options only (`minPaceMs`, `failPauseMs`, `beforeEach`, `owner`); unset, the board's run is unchanged. Autopilot is a caller of `runPlan` like the board (it adds its ordering and muting outside it). |
| Lua (`Kin.Move`, `Kin.Contracept`, `Kin.Scan`) | Not changed. Autopilot asks the game's state (movement allowed, Move screen, server busy, trade-centre room) with its own event `PZ2QoL_AutoGate`, only while on, before each action. The snapshot gets no new fields. |
| Kinship (`kincore.js`) | A simulated model reuses its source's ancestor / kinship / relation caches (lineage never changes in a simulation); a pure cache, same answers (equivalence test). It also speeds up the board's own Suggest fixes. |
| Scans | Today's cadence (20 s, 6 s with a kin surface open). The faster rate is only while on. |
| Kin alerts | No muting: the filter (`kin.js` `setKinAlertFilter`) is null. Muting only covers Autopilot's own plan in flight. |
| Species board UI | No new menu items, tabs, tags or pins. The board's Autopilot tab, pins and "Autopilot" card tags appear only while on. |
| Thin out choices | Forgotten when the game closes, as today. Persistent only while on. |
| Player save | Nothing written. The `kinAuto` key is created the first time Autopilot is turned on; assignments' room in the 60 KB per zoo is untouched until then. |
| Settings | Autopilot's settings in their own key, not in `DEFAULT_KIN_SETTINGS`, so Kin settings read and save as today. |
| CPU | No fingerprints, no planning, no timers. The runtime installs its listeners only once Autopilot is on in the current zoo. |

**Turning it off after it was on** returns the mod to the table above at once: the queue, veto
toasts and muting are dropped; a transport the game already started finishes (as with Stop today).
What Autopilot changed in the zoo stays as it is. The off dialog lists any contraception it still
owns ("Lift the 2 contraceptions Autopilot set?", default: keep), so nothing is left on without
the player knowing. Its pins and log are kept (unused) for when it is turned on again.

**Proof, before release** (section 12): the existing Node, Lua and harness tests pass **without
edits**; an off-mode equivalence test runs the panels' engines on the test fixtures with and
without the new code paths and must give identical plans; harness screenshots of the board, the
panels and the toasts with Autopilot off must match today's apart from the launcher button.

---

## 1. What the player gets

- A third round button on the park launcher (bottom left, next to Species board and Autosave)
  with a status ring: **off** (greyed out; a click opens the setup, nothing else), **watching** (green), **acting** (animated), **ready, waiting
  for your click** (Franchise one-click; pulsing), **needs you** (amber), **paused** (blue).
- Turning it on for a zoo opens a short setup: the preset (section 3.3), the three areas each at
  **Off / Tell me / Do it**, and a **dry run** of the whole zoo ("Autopilot would make 23 moves,
  put 2 animals on contraception and send 9 to the trade centre"). Nothing happens until **Start**.
- After that it keeps every species in shape:
  - inbreeding risks fixed within about a minute of appearing (a youngster grows up next to its
    father, a bond ends, the player drops in a sibling),
  - breeding groups laid out for genetics, re-planned only when it's clearly worth it,
  - over-full habitats and poor genes thinned out to the trade centre,
  - problems it can't solve listed under **Needs you** ("Lions: no unrelated male anywhere; buy
    one"), not acted on blindly.
- An **activity log** with a reason on every action, **Undo** per action or per cycle, and pins
  (**Hands off** this animal / habitat / species).
- One click turns it off. A plan, Thin out or Move now on the Species board pauses it.

---

## 2. Architecture

```
            ┌───────────── Lua (park) ─────────────┐
 scan  ───▶ │ Kin.Scan / _StartPark  (snapshot)     │
 facts ───▶ │ Kin.SpeciesInfo, Kin.Destinations     │
 act   ───▶ │ Kin.Move, Kin.Contracept  (+ guards)  │
            └───────────────────┬───────────────────┘
                                │ events
 HUD page (JS) ─────────────────▼────────────────────────────────────────────
   kin.js  ──model──▶  kinauto.js (runtime)                                 
                        ├ Observer: per-species fingerprints, triggers       
                        ├ Scheduler: urgency queues, time budget, gates      
                        ├ Planner ──calls──▶ kinautocore.js (pure)           
                        │                     ├ disposition (who may move)   
                        │                     ├ layout   (planProgramme)     
                        │                     ├ fixes    (suggestPlan, contraception)
                        │                     ├ thin out (cullPlan)          
                        │                     ├ fixed point + validation     
                        │                     └ commit gate (hysteresis, ledger)
                        ├ Executor ──▶ kinmoves.js runPlan-style queue        
                        ├ Ledger + journal ──▶ userstore.js (player save)    
                        └ UI: kinautoui.js (chip, panel, log, needs-you)     
```

- **Everything new and clever goes in one pure module, `kinautocore.js`**, tested in Node like
  `kinprogramme.js`. It takes `(model, speciesInfo, destinations, assignments, ledger, settings,
  now)` and returns `{ plan, contraception, needsYou, reasons, objectiveBefore, objectiveAfter }`.
  It reuses `suggestPlan`, `planProgramme`, `cullPlan`, `simulatePlan` and `planImpact`; it does
  not fork them.
- `kinauto.js` is the runtime on the **HUD page** (the park's view, where the Species board and the
  scans already live). It needs no new Lua for phase one apart from small guards (section 9.1).
- The Species board and Autopilot share **one executor**: `runPlan` is a global singleton today,
  so only one runner can ever be sending moves. Autopilot calls it as it is; it is not changed
  (section 0a).
- `kinauto.js` installs nothing (no listeners, timers or scans) until Autopilot is on in the
  current zoo.

---

## 3. What it is allowed to change

### 3.1 Actions (phase one)

| Action | Game call (unchanged) | Used for |
|---|---|---|
| Move to a habitat | `Kin.Move` → `AttemptRequestToTransportAnimalToTarget` | fixes, breeding layout |
| Send to the trade centre | `Kin.Move` `trade:` → `AttemptToSendToTradeCentre` | thin out, no place in a group |
| Bring back from the trade centre | `Kin.Move` → `RequestTransportToAssignedHabitat` or a move | layout (breeders waiting there), undo |
| Contraception on / off | `Kin.Contracept` → `SetUsingContraceptive` | fix fallback, "owned" and lifted again (section 5.4) |

### 3.2 Never (any phase, unless the developer says otherwise)

- Sell, release, list on the market, buy, or anything in the hub or with money / CC.
- Exhibit animals, shoals and colonies (Kin already leaves them out).
- Anything pinned by the player, an animal the player moved or contracepted by hand (section 7),
  pregnant females (no move, no thin out), an animal on the move, boxed or at the vet.
- Found a new group in an empty habitat that is not assigned to that species (section 8.1).
- Split a bonded monogamous pair, except to fix an inbreeding risk or for a large genetics gain
  (section 8.2; never in Guardian).
- More than the trade centre's capacity minus a reserve (default 2 slots, for the player's
  purchases, which arrive there).

### 3.3 Presets (map onto the knobs that exist today)

| Preset | Fixes | Breeding programme | Thin out |
|---|---|---|---|
| **Guardian** | risks (game rule) + close kin | off (Tell me) | 0% fertility genes; habitats over their **full** room (fill 100%) |
| **Steward** (default) | risks + close kin | on, `moveCost` 0.08 ("Fewer moves") | Balanced (85%), 0% fertility, too old from full habitats |
| **Breeder** | risks + close kin | on, `moveCost` 0.04 ("Balanced") | Lean (70%), 0% fertility, poor genes **Weakest** |

Every knob stays reachable in an Advanced section; presets just set them.

---

## 4. Observation: knowing what changed

- **Source:** the kin snapshot `kin.js` already gets (every 20 s in the background). Only while
  Autopilot is on does it ask every 10 s, and every 3 s while one of its moves is in flight. The scan
  is chunked and incremental in Lua (`Kin._Step` with a budget), so this is affordable; measure in
  game (section 13).
- **Per-species fingerprint** (cheap, computed from the model each scan): for each animal of the
  species, `guid | hab | lt | moving | juv | contra | infertile | preg | fert.state | bond.mate |
  alive`, plus the species' assignments and the Autopilot settings. A species is re-planned only
  when its fingerprint changes or its periodic review comes due. Nothing else triggers planning.
- **Triggers and their urgency:**

| Urgency | Trigger (detected by diffing the previous model) | Acts within |
|---|---|---|
| **P0** | a new `risk` pair (`newRisks`, incl. `bondEnded`); a `kin` pair when close kin is on | the next cycle (≈ 30–60 s) |
| **P1** | a `future` pair whose youngster reaches maturity within the horizon (section 8.3); a habitat over its **full** room; a newborn or an arrival in a full habitat; an animal turns `old` / `sterile`; a 0% fertility animal | a few minutes, batched per species |
| **P2** | periodic breeding-programme review (each species every 15 min of park time, staggered); a breeder arrives at the trade centre | at most once per species per review period, only past the gain threshold |

- **Settle rules (no planning on half-known data):**
  - Not in the first 60 s (or 3 full scans) after a park loads or after a hub trip. Habitat space
    is often still `bCalculating` then.
  - Not while any animal of the species is `moving`, boxed, in transit, or within 2 scans of
    arriving. The species is "in flight"; its plan is finished first.
  - Not on a snapshot that reported `busy`, `error` or a partial bond pass (`bondsOk` false) for a
    monogamous species.
- **Data per species** (`requestSpeciesInfo`, `requestDestinations`) is asked when a species is
  about to be planned, with the existing caches (30 s destinations, 60 s species facts), and
  forced fresh just before a commit.

---

## 5. Deciding: one pipeline, one objective

The three tools answer different questions with different scores. Run back to back they disagree
(section 5.7). Autopilot runs them as **stages of one pipeline per species** and accepts the result
only if it improves **one lexicographic objective**.

### 5.1 The objective (lower is better, compared left to right)

```
O(layout) = ( R  related fertile pairs living together now (risk; + kin when close kin is on),
              F  future pairs whose youngster matures within the horizon,
              C  adults over each habitat's FULL room (social max and space),
              G  animals the gene rules send away (0% fertility, poor genes level),
             -V  breeding value (planProgramme's score: young quality x conception x fertile years),
              M  action cost (moves, bond breaks, outsider joins, contraceptions) )
```

A plan is committed only if `O(after) < O(before)` and, when R, F, C and G are equal, the V gain
passes the **gain threshold** for its cost (section 6.1). Because every committed plan strictly
lowers the same ordered tuple on the same data, Autopilot cannot cycle between its own plans while
the zoo stands still. Only real change (births, ageing, deaths, the player) makes new work.

### 5.2 Stage 1: disposition (who is what)

Each animal of the species gets one role:

- **locked**: player pin, player's recent manual move or contraception (section 7), pregnant,
  moving, boxed, vet, quarantine, escaped, at the trade centre **because Autopilot or the player
  sent it away**.
- **leaving**: the thin-out gene rules pick it (`cullPlan` with the room part switched off): 0%
  fertility, poor genes level, too old / sterile when `oldAlways`. Leaving is **sticky**: once
  decided, the animal stays leaving until it is gone, or the player pins it.
- **breeder**: `isBreeder()` (`kinprogramme.js`), not locked, not leaving.
- **staying**: juveniles and non-breeding adults (they count towards room).

### 5.3 Stage 2: layout (the breeding programme)

`planProgramme` over the breeders only, with:

- `relatedPenalty` raised to "never" (e.g. 50) so the layout itself removes risks;
- habitats = the species' assigned habitats if it has any, else the habitats it lives in now plus
  suitable empty habitats **only if the preset allows founding** (default: assigned only);
- trade-centre breeders: only those that **arrived** there (bought, or from storage), never those
  marked leaving (this fixes a ping-pong the current code would have: Thin out sends an animal to
  the trade centre, then the programme, with `useTradeCentre` on, brings it straight back);
- the preset's `moveCost`; and `bondBreakCost` raised so bonds are only split for a real gain.

If the breeding programme area is **Off**, this stage is skipped and the layout is "everyone stays".

### 5.4 Stage 3: residual fixes (Suggest fixes, then contraception)

On the simulated layout, any related pair that is left (the programme only moves breeders, so pairs
with a juvenile about to mature, a non-breeding adult that will breed again, or an animal the
programme could not place) goes to `suggestPlan` (no trade centre first, then with it). It already
moves as few animals as possible, keeps breeding pairs and never creates new risks.

If no move fixes a risk (`suggestPlan` returns nothing for it), **contraception** is the fallback:
on the member of the pair who is worth least to the layout (not in the programme's best pair,
lower keep value from `keepValue`). Autopilot records it as **owned** and **lifts it again** when
the reason is gone (the relative left, died or became infertile), unless the player touched it.
It never lifts contraception it didn't set.

If neither works (e.g. the habitat's only male is every female's father and no other habitat
fits), the pair goes on **Needs you** with a reason and a suggestion ("Assign another habitat to
lions", "Buy an unrelated male").

### 5.5 Stage 4: thin out by room

`cullPlan` on the simulated model **after** stages 2 and 3, with the preset's fill level, so it
thins the layout that will exist, not the one before. Animals already leaving count as gone. Rules
added for Autopilot:

- No room-based culls when the species facts are **estimated** (`cullPlan(...).estimated`, or no
  space data for that habitat): without the game's room it would be guessing. The gene rules still
  apply; they don't depend on room.
- Never more than the trade centre's free slots minus the reserve. Lowest keep value goes first.
- Juveniles are only sent away by the gene rules with `young` on (as today).

### 5.6 Stage 5: fixed point, order and validation

1. **Fixed point.** Re-run stages 1–4 on the simulated result, at most 3 rounds, until a round adds
   nothing. Thin out can change who is a breeder, and the layout can change what is over room, so a
   single pass can leave work that the next cycle would do as a second, avoidable, round of moves.
   The committed plan is the union of all rounds; a move superseded by a later one is merged (A→B,
   B→C becomes A→C; A→B, B→A drops both).
2. **Whole-plan validation** with what exists: `planProblems` (destinations, assignments),
   `planImpact` (must have `risksCreated == 0` and no new `kin`), capacity per habitat after the
   plan, every habitat that had a breeding pair still has one unless the plan sends a better one
   in, no single-sex group of two or more adults created.
3. **Safe order.** Moves run in an order whose every prefix is safe: outs (to the trade centre,
   out of a habitat with a relative) before ins; contraception before the move it covers for. Found
   by simulating prefixes (plans are small). A swap that has no safe order runs anyway (transit
   takes seconds; no mating happens) but its pairs are **muted** in `kinalerts.js` while the plan is
   in flight, so the player doesn't get a "new risk" toast for Autopilot's own half-done plan.
4. **Objective check** (section 5.1). If the result does not improve, nothing is committed and the
   species is marked "checked, nothing to do" until its fingerprint changes.

### 5.7 Why not just call the three buttons in a row

What the current tools would do if chained blindly, and how the pipeline avoids it:

| Problem | Cause in today's code | Pipeline answer |
|---|---|---|
| Thin out → programme ping-pong | `planProgramme` pulls every trade-centre breeder when `useTradeCentre` is on | sticky **leaving**; only arrivals are pulled |
| Fix undone by the programme | `suggestPlan` and `planProgramme` score differently; the programme ignores `future` pairs and non-breeders | layout first, fixes on its result, one objective |
| Thin out on the wrong layout | `cullPlan` reads the current model | runs on the simulated layout |
| Founding groups by accident | `planProgramme` considers every suitable empty habitat | assigned habitats only, unless the preset allows |
| Ties flip between cycles | equal-score moves picked by iteration order | status-quo bias (ε) and stable tie-break by GUID |
| Estimated room acted on | panels fall back to 8 adults per habitat | no room-based culls or capacity moves on estimates |

---

## 6. When to act: gates, hysteresis, budgets

### 6.1 Commit gate

- **P0** (risk now): commit as soon as a valid plan exists. No gain threshold.
- **P1**: commit after the plan has been the **same twice in a row** (two scans), so transient
  states (an animal at the vet, a scan mid-update) don't cause moves.
- **P2** (breeding layout): commit only if the plan is stable over two evaluations **and**
  `V gain ≥ max(0.10, 8% of V before)` **and** `V gain / moves ≥ 0.03` (pair-value units, same
  scale as `PROGRAMME_DEFAULTS`). Starting values; tune with the soak test (section 12).

### 6.2 Anti-churn ledger (per animal, keyed by GUID)

- **Cooldown:** an animal Autopilot moved is not moved again by the layout or Thin out for a
  quarter of a park year (and at least 10 real minutes). Fixes may move it.
- **No reversals:** a plan that sends an animal back to a habitat it left in the last park year is
  rejected unless a fix needs it.
- **Oscillation breaker:** two reversals for one species within a park year mark it **unstable**:
  Autopilot stops acting on it and adds a Needs you entry with both plans. The player decides.
- **Failure backoff:** a move the game refused or didn't confirm is not retried for 10 min; after
  3 failures for the same animal and destination it is parked as Needs you ("No keeper can reach
  Savannah Habitat").

### 6.3 Budgets

- Actions per cycle: P0 unlimited for the risks it fixes (normally 1–3), otherwise 6.
- Actions per park hour: 30 (offline), 12 (Franchise). Over budget, P2 waits.
- **First cycle after enabling** (the "big clean-up" on a messy zoo): all P0 everywhere, then P1/P2
  one species at a time, worst first, so the player can follow what happens.
- **CPU:** one species planned per second at most, and `maxEvaluations` 20 000 per species in
  background runs (the panel uses 60 000). Skip a planning slot while the frame is busy (a game
  popup open, the Species board dragging). Never plan more than one species per animation frame.

### 6.4 Trigger policy (the only Franchise / offline difference)

| | Offline park | Franchise (rule as today) | Franchise (rule amended) |
|---|---|---|---|
| Observe, plan, validate | background | background | background |
| P0 | runs at once | chip + toast "**Fix now**" (one click runs the cycle) | runs at once |
| P1 / P2 | after a **veto window** (default 20 s: toast "Autopilot will move 3 animals: Review · Skip") | chip shows "N ready"; one click runs all ready species | after the veto window |
| Pace | `moves` pace (default 1.5 s) | `moves` pace, ≥ 3 s, 8 s after a server error, wait while `IsDatabaseOperationInProgress` | same as left |

"Do it" areas run; "Tell me" areas only show their plan on the chip and in the log (a dry run that
keeps running). The veto window can be set to 0 (silent) by the player.

---

## 7. The player stays in charge

- **Off switch:** the chip's click menu has **Turn off** (per zoo, persisted) and **Pause for this
  session**. Off stops after the action in flight (a transport the game has started is not undone).
  Escape on the chip's panel does not turn it off (too easy by accident).
- **Pins** (stored by GUID / habitat fingerprint, survive restarts):
  - animal: **Hands off** (Autopilot never moves it, culls it or changes its contraception);
  - habitat: **Hands off** (nothing in or out);
  - species: **Manual** (the whole species is skipped).
  Pins are set from the animal card's menu, the column header and the species rail on the Species
  board, and from any log entry. These pin controls exist only while Autopilot is on in that zoo;
  with it off the board has no new items (section 0a).
- **Implicit respect.** Autopilot remembers the state it left each animal in. If an animal's
  habitat or contraception changes and Autopilot didn't do it, the player (or the game) did:
  - moved by the player → that animal is locked for 2 in-game years (or until unpinned), and its
    new home is treated as intended (no "fix" that sends it straight back unless it's a P0 risk,
    and then it asks instead of acting: Needs you "You moved Kito in with his sister");
  - contraception changed by the player → Autopilot never touches that animal's contraception
    again (until unpinned).
- **The Species board wins.** While the board has a staged plan, a Thin out or programme panel
  open, a Move now in flight or a plan running, Autopilot does not commit or run anything. A plan
  the player runs goes through the same executor; Autopilot waits for it and then re-plans.
- **Assignments are law.** A species with assigned habitats only goes there; no species ever goes
  into another species' habitat (as `suggestPlan` and `planProgramme` do now).
- **Thin out choices.** The panel's keep / send clicks (`keepIds`, `cullIds`) become persistent
  pins while Autopilot is on. With it off they last until the game closes, as today.

---

## 8. Edge cases

### 8.1 New species and arrivals
- First animals of a species, no habitat with it yet: Autopilot does nothing (founding a group is
  the player's), unless the species has an assigned habitat; then arrivals go there. The species is
  listed under Needs you ("3 okapi waiting at the trade centre: assign a habitat").
- Bought animals arriving at the trade centre for an existing species: P2 considers them at once
  (programme stage). If no group wants them, they stay; Autopilot never sends an arrival back out.
- Animals sent to the zoo from storage through **Find a habitat**: that is the player's click; they
  are locked for the cooldown like a manual move.

### 8.2 Bonds (monogamous species)
- Never split a ring bond for a P2 gain below a high bar (`bondBreakCost` 0.5). Never cull one
  partner of a bonded pair without the other, unless the other is dead or leaving too.
- A bond that ends (mate dead, `mourn` > 0) changes `held` pairs to `risk`: P0, as `newRisks`
  already detects with `bondEnded`. While an animal is mourning, it is not moved into a new group
  (the bond may still lock it; whether `IconLock` holds during mourning is open, section 13).
- If the bond pass failed (`bondsOk` false), monogamous species are not planned that cycle.

### 8.3 Juveniles
- Never moved by the programme (as today). Fixes move a juvenile only when its `future` pair is
  about to become a risk: maturity within the horizon (default: half a year of game time, from
  `age` and the species' `maturity`; one scan before maturity at the latest).
- Never thinned by room; only by the gene rules with `young` on.
- Whether separating a young animal from its mother hurts its welfare in PZ2 is open. Until known,
  a juvenile younger than 75% of maturity is never moved.

### 8.4 Pregnancy, birth, death, ageing
- Pregnant females: never moved or culled. A habitat expecting births keeps room: the fill level
  already leaves room for the young, and P1 waits for births before thinning a habitat with a
  pregnant female unless it is over its **full** room.
- Births and deaths change fingerprints; nothing else is needed.
- `fert.state` turning `ending` / `old` re-plans the species (P2 / P1), so old breeders are replaced
  gradually rather than the moment they age out.

### 8.5 DLC, patch and modded species
- Any species in the snapshot is owned (DLC included). If the game gives no species facts, no
  mating system or no conception table (`programmeWarnings` cases), that species gets **Guardian**
  behaviour only (fixes, 0% fertility) and a note in the log. Nothing is acted on with estimates.
- Collective species and exhibit animals are already excluded.

### 8.6 Restarts, hub trips and IDs
- Entity ids change on every load (proven); all Autopilot memory is keyed by **GUID** (animals)
  and by the assignment **fingerprint** (habitats, `habitatPrints` / `resolveAssignments`).
- Never persisted: the queue, the plan in flight, the veto timers. After a load, Autopilot settles
  (section 4) and plans from scratch. A move that was in flight is either done (the scan shows it)
  or not; nothing is replayed.
- A hub trip ends the park world: the runtime stops; the plan is dropped.
- Steam Cloud carries the player save between PCs; the ledger rides along. Two PCs never play the
  same zoo at once, so last-writer-wins is fine.

### 8.7 The game's own moments
- Not while the game is in a mode that moves animals (`AnimalMovementMode`) or a popup is open
  (`.PopupActionsModule_root.show`), nor while `api.planetHub.IsPlayerAnimalMovementEnabled()` is
  false (tutorials, scenarios).
- Paused game: transports don't progress, so confirms time out. Two confirm timeouts in a row with
  no animal ages changing ⇒ assume paused, hold until ages move again (section 8.8).

### 8.8 Time
- Cooldowns, horizons and reviews use **park time**, measured from the snapshot itself: the
  largest increase of any living animal's `age` between scans (years → days). This needs no new
  API, stops when the game is paused, and runs faster at 3× speed. Fallback: real time.

---

## 9. Safety

### 9.1 Fail soft, everywhere
- Every Autopilot entry point in `try` / `reportError`, every Lua call in `pcall` (as now). Any
  exception in planning a species marks that species skipped for 10 min; it never stops other
  species or the game.
- Missing data never becomes an action. No destinations ⇒ no moves for that species. No species
  facts ⇒ Guardian only. No genes ⇒ the gene rules don't apply to that animal. No GUID ⇒ that animal
  is never moved by P2 (its relatives can't be known).
- **Lua guards before each auto action** (cheap, the game's own checks): alive, not boxed /
  claimed / with a transport job, `CanStaffDeliverAnimalToFacility`, trade centre capacity (all
  already in `Kin.Move`), plus `IsPlayerAnimalMovementEnabled`. The new guard runs only on calls
  flagged as Autopilot's; the board's manual moves keep today's checks exactly.
- A **version** in the ledger. An unknown version is ignored (fresh start), never misread.

### 9.2 Circuit breakers
- Within a cycle, a failed step is skipped and the cycle carries on (the developer's rule).
- Between cycles: 3 skipped steps in one cycle, or 5 in 10 min ⇒ Autopilot pauses 10 min and shows
  it on the chip. A Lua `failed` state or a crash marker from a previous session (`errors.js`
  breadcrumbs) ⇒ starts paused, the player resumes.

### 9.3 Franchise
- Same calls as the player; nothing new sent. Pace ≥ 3 s between actions, 8 s after any
  `MsgType_DatabaseErrorMessage`, and wait while `franchise:IsDatabaseOperationInProgress()` is
  true (the lister's rules, `lister.js` / `pace.js`).
- Request 28 / 31 `NotAllowed` bursts follow moves (section "Franchise server errors" in the skill);
  harmless so far, but the background budget for Franchise is lower (section 6.3) to keep the
  request rate near a busy human's.

---

## 10. Reporting, review and undo

### 10.1 The log
- One entry per action: `{ t (park day), species, guid, name, action (move / trade / back /
  contra+ / contra-), from, to, reason, stage (fix / layout / thin / undo), cycle, outcome (ok /
  skipped: why) }`. Reasons reuse what the tools already write ("2 related pairs fewer; gives Jungle
  Habitat its first breeding pair", "Thin out: too old to breed", "breeds with Zuri ♀ (expected
  young 78)").
- Shown in the Autopilot panel (newest first, filter by species), and on the Species board: cards
  get an "Autopilot" tag with the last reason; the plan area gets an **Autopilot** tab with the
  current plan, Needs you and the log for that species.
- A per-cycle summary toast when a cycle ends ("Autopilot: 3 moves, 1 to the trade centre; fixed 2
  inbreeding risks"), one at a time, honouring the toast style in `kinalerts.js`.
- **Kept:** the last 150 entries per zoo in the player save (compact, about 15 KB), the rest in
  memory for the session. Pins, owned contraception, cooldowns and leaving marks are kept too
  (≈ 5 KB). Budget: 20 KB of the zoo's 60 KB, so assignments always fit.

### 10.2 Preview
- The chip's panel always shows the **next plan** for every species that has one: moves with
  reasons, the objective before → after (risks, over room, expected young, breeding pairs) using
  the Species board's stat tiles, and its trigger time (or "waiting for your click").
- **Review** opens the Species board on that species with the plan staged, exactly as if the player
  had pressed Suggest fixes / Use this plan: the player can change it and run it by hand. That plan
  then counts as the player's.

### 10.3 Undo
- **Undo an action:** the reverse action if it is still possible: back to the old habitat (if it is
  still a valid destination), **Return to habitat** for an animal waiting at the trade centre (it
  keeps its assigned habitat until it is sold or released), contraception toggled back. The reverse
  is simulated first; if it would create a risk now, the player is told and can still do it.
- **Undo a cycle:** the reverse of every action in it that is still possible, as one plan through
  the executor.
- Undo is a player click (so it is click-started in Franchise too) and **pins** what it restores,
  so Autopilot does not redo what the player just undid.

---

## 11. Phase one (the full scope; nothing essential left for a "v2")

1. **`kinautocore.js`** (pure): disposition, the 5-stage pipeline with the fixed-point loop, merged
   plan, safe order, whole-plan validation, the lexicographic objective, the commit gate, and the
   ledger rules (cooldown, reversal, oscillation, backoff). Changes to the existing engines are
   **opt-in options only**: unset, each engine returns exactly what it returns today (section 0a):
   - `planProgramme`: options `excludeIds` (leaving), `tradeIds` (pullable arrivals),
     `allowFounding`, `relatedPenalty`, `maxEvaluations` per call, `stableTieBreak` (all unset by
     the panels).
   - `suggestPlan`: options `lockedIds`, `statusQuoBias`; the problems it couldn't fix come from a
     new option `{ report: true }` (then it returns `{ plan, unfixed }`); without it, the same array
     as today.
   - `cullPlan`: options `goneIds`, `roomRules: false` (gene rules only), `maxSends`.
   - `kincore.js`: a new park-time helper from ages (nothing existing changes).
2. **`kinauto.js`** (runtime): observer (fingerprints, triggers), scheduler (urgency queues, settle,
   gates, CPU budget), executor on top of `kinmoves.js` (shared singleton, safe order, alert
   muting), Franchise / offline trigger policy, circuit breakers, park-time clock, persistence
   through `userstore.js` (key `kinAuto`).
3. **`kinautoui.js` + CSS:** launcher button and status ring, setup with dry run, panel (next
   plans, Needs you, log, Undo), pins on the Species board (card menu, column header, rail), the
   Autopilot tab in the board's plan area, cycle toasts, veto toast.
4. **Contraception lever** with ownership and automatic lifting.
5. **Lua:** a new event `PZ2QoL_AutoGate` (asked only while Autopilot is on) answers
   `IsPlayerAnimalMovementEnabled` and the current UI mode; the snapshot is unchanged. `Kin.Move` /
   `Kin.Contracept` take an optional Autopilot flag that adds that guard; without it they run as
   today. No new action events.
6. **Docs:** README section, skill updates (`animals-and-breeding.md`, `game-data-and-events.md`
   for new events, `testing.md` for the soak test), changelog.

### Deliberately later

| Later | Why not phase one |
|---|---|
| Market: shopping list ("buy an unrelated male, fertility ≥ 50%") linked to the market filters | needs the hub; phase one lists it as Needs you text |
| Selling / releasing what Thin out sends away | money and server actions; the lister stays click-started |
| Breeding-season timing (`GetSpeciesBreedingSeasons`: move before the season, not during) | needs the season data in the snapshot and a game-calendar probe |
| Multi-generation planning (keeping family lines apart for the next generation; `lineBonus` exists but is tiny) | needs a forward simulation; value only shows after years of park time |
| Value in money (expected young × medal × pricebook) as the programme's score | ties into `pricing.js`; worth doing once the core is trusted |
| Exhibits, shoals, colonies | different breeding rules; excluded today |
| Mixed-species habitats as a goal (`DoAllSpeciesCohabit`) | today only respected, not optimised |
| Keeper workload (moves only when keepers are free) | no API found for keeper load |
| Learning from the player's overrides (tuning thresholds from what they undo) | needs data from phase one |

---

## 12. Plan of work (in order)

1. **In-game probes (read-only, before code):** section 13. One session in an offline park and one
   in Franchise, trace only.
2. **Engine changes** in `kinprogramme.js`, `kinboardcore.js`, `kincull.js` (options above), with
   Node tests: no behaviour change for the panels. Existing tests pass **without edits**, plus an
   **off-mode equivalence test**: every engine on every test fixture, with no new option set, gives
   the same plan as the code before the change (recorded from today's code first).
3. **`kinautocore.js`** with Node tests:
   - unit tests per stage and for the gate and ledger;
   - **fixed-point property:** for random zoos, after applying the committed plan, the pipeline on
     the result commits nothing;
   - **soak test:** a simulated zoo over 50 park years (births from fertile unrelated pairs with the
     game's gene rule, ageing, deaths, random player moves and pins). Pass = no risk older than one
     cycle, no reversal outside P0, moves per year within budget, no animal moved more than twice a
     year by P2, every action logged. This is where the thresholds in section 6 get tuned.
4. **`kinauto.js`** with a mocked `engine` in Node (scheduler, settle, gates, Franchise one-click,
   breakers, persistence round trip, restart with new entity ids).
5. **UI** (`kinautoui.js`) in the browser harness, screenshots looked at: chip states, setup and
   dry run, panel, Needs you, log, undo, board tab, pins. **Off-mode screenshots** of the Species
   board, Suggest fixes, the Programme and Thin out panels, a plan run and the Kin toasts must
   match today's apart from the greyed-out launcher button.
6. **Lua** additions and Lua mock tests (`tests/lua/test_pz2qol.lua`), including: `Kin.Move` and
   `Kin.Contracept` without the Autopilot flag give the same answers as today in every existing
   case, and the snapshot has the same fields.
7. **In game, offline park:** Guardian, then Steward, for an hour each; read `dbg/trace.log`
   (`auto_*` marks per stage and action).
8. **In game, Franchise:** one-click policy (or background, if the rule is amended); watch server
   errors per action against the manual baseline.
9. README, skill, changelog; release as off by default.

---

## 13. Facts to confirm in game (probes)

| Question | Why it matters | How |
|---|---|---|
| During a transport, is `hab` (assigned habitat) already the destination? | settle rules and simulation | trace one move: `GetAssignedHabitatEntityID` each scan |
| Does a transport job start while the game is paused? | pause detection | pause, move, watch `bHasTransportJob` |
| Is `SetUsingContraceptive` a Franchise server request (request types after the call)? | contraception lever in Franchise | trace `MsgType_DatabaseErrorMessage` and `IsDatabaseOperationInProgress` around one toggle |
| Does separating a juvenile from its mother cost welfare? | juvenile rules | move one young animal, watch its welfare for a game month |
| Does `IconLock` hold while mourning, and end with the timer? | bonds (already open in the skill) | the pair-bond probe in `PLAN-pair-bonds.md` |
| Scan cost at 10 s in a zoo of 300+ animals | observation rate | frame time in the trace while scanning |
| Does a full trade centre block purchases arriving? | reserve slots | fill it, buy one |
| Where the current UI mode can be read cheaply (`AnimalMovementMode` active) | gate | Lua: `BaseUIMode` current mode (the storage-send wrap already sees `SetNewMode`) |

---

## 14. Open questions for the developer

1. **Franchise background (section 0).** Amend the click-started rule so the per-zoo Autopilot
   opt-in may start actions in Franchise, or keep one-click cycles there? Recommendation: amend,
   narrowly as written in section 0; ship one-click until then.
2. **Contraception as a lever.** May Autopilot set (and lift) contraception it owns? Recommendation:
   yes, only as the fallback when no move fixes a risk.
3. **Close kin.** Fix `kin` pairs the game doesn't flag with the same urgency as `risk` (P0), or as
   P1? Recommendation: P1 (they matter for genetics, the game doesn't punish them now).
4. **Founding groups.** May Autopilot start a breeding group in an empty suitable habitat that isn't
   assigned to the species? Recommendation: no (assigned only).
5. **Bonds.** Never split a bonded pair for genetics, or only for a large gain? Recommendation:
   large gain only (`bondBreakCost` 0.5), never in Guardian.
6. **Default preset and veto window.** Steward with a 20 s veto toast? Or silent?
7. **Budgets.** 30 actions per park hour offline, 12 in Franchise: right ballpark?
8. **Manual moves.** Lock a hand-moved animal for 2 in-game years, or until unpinned?
9. **Trade centre reserve.** 2 slots kept free for purchases?
10. **Log size.** 150 entries per zoo (≈ 15 KB of the 60 KB per-zoo store)?
11. **Name.** "Autopilot", "Head keeper", "Curator"? (The mod is now Genes & Gold.)
12. **Per-zoo or global on switch?** Recommendation: per zoo (one zoo managed, another played by
    hand).
13. **Turning it off:** keep the contraception Autopilot set (default, the off dialog lists it with
    a "Lift" button), or lift it automatically?

---

## 15. Implementation (phase one, 2026-10-16)

Branch `autopilot`, worktree `.claude/worktrees/autopilot`. **Not yet run in the game**: everything
below is tested offline (Node, Lua mock, browser harness).

### Files

| File | What |
|---|---|
| `js/mods/pz2qol/kinautocore.js` | Pure: presets and settings, the pipeline (`planSpecies`), objective, commit gate, safe order, fingerprints, park clock, change detection |
| `js/mods/pz2qol/kinautoledger.js` | Pure: the zoo's Autopilot data (GUID / habitat-fingerprint keyed), the view for this load, log, pins, undo, pruning, size budget |
| `js/mods/pz2qol/kinauto.js` | Runtime on the HUD page: watching, scheduling, Franchise / offline trigger policy, executor, circuit breaker, persistence (`userstore.js` key `kinAuto`), dry run |
| `js/mods/pz2qol/kinautoui.js`, `css/mods/pz2qol_autopilot.css` | Launcher button state, panel (Set up / Next / Needs you / Log / Settings), toasts, the Species board extension |
| `hudlauncher.js`, `kinboard.js`, `main.js` | Third launcher button (greyed while off); the board's extension slot (null while off), `isBoardBusy`, `stagePlan` |
| `kinprogramme.js`, `kinboardcore.js`, `kincull.js`, `kinmoves.js`, `kin.js`, `kinalerts.js`, `kincore.js` | Opt-in options and hooks only (section 0a) |
| `Main/pz2qol.kin.lua`, `Main/pz2qol.storagesend.lua` | `PZ2QoL_AutoGate` → `PZ2QoL_AutoGateResult(reqId, {park, move, uiMode, dbBusy, tcMax, tcCount, gameMode, t})`; the Move-screen wrapper records the last mode name |

### Decisions taken (until the developer says otherwise)

- **Franchise: one-click cycles** (section 0, rule unchanged). Offline parks: background with a
  20 s veto toast; inbreeding risks at once.
- Contraception lever on, owned and lifted again; never touches contraception it did not set.
- Close kin fixed too, urgency P1. No founding of groups in unassigned habitats. Bonds split only
  for a large gain (`bondBreakCost` 0.5). Steward preset by default. 30 / 12 actions per hour.
  Hand-moved animals locked for 2 park years. Trade-centre reserve 2. Log 120 entries, 20 KB cap.
  Per-zoo on switch. Turning off keeps owned contraception unless the player clicks Lift.

### Where the build differs from sections 4–10

- **Time is park years** (from the animals' ages, `advanceClock`): cooldown 0.25 y (and 10 real
  minutes), reversal window 1 y, manual lock 2 y, maturity horizon 0.5 y.
- **Planning budget** (it runs on the game's UI thread): 400 ms per species (`planBudgetMs`, a
  deadline passed to the engines), the layout search sized to the species (`evalBudget /
  adults²`, 1 000–20 000 evaluations), and **triage**: more than 8 related pairs → a fixes-only
  plan first; layout and thinning by room follow in later plans. Plans with more than 16 moves are
  ordered without simulating each prefix (all affected pairs muted). Measured: a typical species
  2–20 ms; a pathological, heavily inbred 300-animal species about 0.8 s (was 72 s before the
  kinship cache and triage).
- **Full habitats and a full trade centre** (found by the 50-year soak: births outpaced what the
  trade centre could take, and one zoo grew to 1 120 animals): stage 4b puts the fertile females
  of a habitat still over its target on contraception (`contraKind: 'room'`), and the lift stage
  takes it off once the habitat is below its target again (a hold band between, so no churn). The
  objective gained **B** (fertile females free to breed in a habitat over its target) after C:
  `(R, F, C, B, G, -V, M)`. Under the Contraception switch.
- **Arrivals** are trade-centre animals first seen there while Autopilot is on; animals already
  waiting when it is turned on, or after a reload, count as sent away (never pulled back).
- The trade-centre room comes from `PZ2QoL_AutoGate` (`tcMax`, `tcCount`); without it, 8 places.
- `uiMode` from the gate is a hint (it is not reset when a park ends): Autopilot waits at most
  6 s for the Move screen, then carries on.

### After the independent review (13 findings, all fixed)

- **Bound to the zoo's data:** Autopilot reads and writes `kinAuto` only while the store holds
  this zoo's data (`userDataStatus() === 'file'`, the same `userDataEpoch()` it was read under).
  Before that (a park loading, the hub, no player profile) it is off; nothing is ever queued for a
  later zoo (the store replays queued writes into whatever zoo it reads next). It can only be
  turned on with the store ready.
- **Plans are never stale:** a ready plan is dropped the moment its species' fingerprint changes
  (also assignments and pins), and a cycle re-checks it, risks included.
- **Offline needs evidence:** Autopilot acts without a click only when the scan says offline AND
  the gate says `gameMode` offline, `hubTypeKnown` (the Franchise hub-type constant exists) and
  `franchiseZoo === false` (no Franchise zoo GUID). Anything else is click-started.
- **Risk fixes go alone:** a plan that fixes a risk takes only its fixes (at once, no veto); the
  layout and thinning are planned again and wait their turn (`partial`). Other rounds take whole
  plans up to 6 actions (`maxActionsPerCycle`). Over the hourly budget, plans wait but planning
  goes on.
- **One action at a time everywhere:** Undo and Lift go through the game's gate, are confirmed
  and paced (3 s, 8 s after a failure in Franchise); Undo waits for a running round.
- **Outcomes:** a run that never started (the board's run came first) puts the plan back; only the
  game's own refusals count against a move (not a busy gate); a move refused three times is listed
  under Needs you.
- **Expected moves** stay expected while the animal travels (60 min, longer while `moving`) and
  are cleared on arrival, so a slow transport is never taken for the player's move; a
  contraception and a move of the same animal no longer overwrite each other's expectation.
- **Size:** 12 KB per zoo measured as the store writes it (non-ASCII as `\uXXXX`; the player
  store holds 64 KB for all zoos together); cooldowns, histories and refusals expire; maps are
  capped at 150 animals.
- Contraception is not lifted in a hands-off habitat; the alert mute is cleared by the runtime
  (not a timer that could clear the next round's); the panel's 1 s timer runs only while it is
  open.

### Tests

| Test | Covers |
|---|---|
| `tests/engines_equivalence.test.mjs` + `fixtures/engines_golden.json` | Section 0a: Suggest fixes, Breeding programme and Thin out give exactly the pre-Autopilot answers on 40 seeded zoos (golden recorded before any engine change, commit `571ca55`) |
| `tests/kinauto.test.mjs` | Pipeline, locks, contraception and lifting, arrivals, founding, estimates, areas, gate, order, objective, juveniles, **fixed point over 200 seeded zoos**, fingerprints, clock, change detection, ledger across a reload with new ids, pins, undo, pruning, budget |
| `tests/kinauto_soak.test.mjs` | 50 park years × 4 zoos × 3 presets with births, ageing, deaths, sales and player moves: no lasting risk, no reversal, no layout churn, the player's animals and babies untouched, every action logged |
| `tests/kinauto_runtime.test.mjs` | Fake game: off sends and writes nothing; offline fixes a risk by itself; the player's move is noticed; another zoo loads (off there, nothing carried over); Franchise waits for the click and drops a plan whose species changed; off removes every hook |
| `tests/lua/test_pz2qol.lua` section 17 | `PZ2QoL_AutoGate` answers (incl. `hubTypeKnown`, `franchiseZoo`), fallbacks, the mode recorder |
| `tests/uiharness/kin_autopilot.mjs` | Panel, preview, start, board extension on and off; off-mode screenshots against the base UI |

### Still to do (in game)

Section 13's probes, then section 12 steps 7–8: Guardian and Steward in an offline park for an
hour each, then Franchise one-click rounds while watching server errors per action.

## 16. Auto mode per species (2026-10-18, replaces the zoo-wide Autopilot)

The developer's request: an auto mode per species, selectable on the Species board, that runs the
Breeding programme, uses the plan and starts the moves; the player picks how often and the
programme's settings; on Auto it needs no human maintenance.

### What the player sees

- The board's action row has an **Auto mode** button next to Thin out (it reads "Auto · next 12
  min", "Auto · 4 ready", "Auto · running" while on). It opens the **Auto panel** in the board's
  middle, where the Breeding programme and Thin out panels go (one of the three at a time; Esc
  closes it).
- Per species: **Turn on / Turn off**, **Run now**, **How often** in game time (1 month, 1
  season, 2 seasons, 1 year of the park's calendar; 2026-10-19, was real minutes), the programme's **Make-up** (the same per-zoo choice as the programme's arrows), **Fewest
  moves ... Best genetics** (starts at the player's slider position), **Bring breeders from the
  trade centre**, **Thin out** with its fill level (on, Balanced, by default), the animals left
  alone, the plan waiting for the click (Franchise) and the last runs with Undo.
- Cards: "hands off" (the card menu's **Auto mode: hands off**), "moved by you", "auto" (moved by
  Auto mode in the last 2 hours). The species rail says "auto" for species on Auto.
- Notices: **Auto mode is ready** (Franchise: Run now / Show / Skip), a short "N moved" after a
  run, and "stopped" if it would move animals back and forth.
- Nothing else changes while no species is on Auto: no listeners, timers, scans or saves (the
  runtime only reads the zoo's data to see whether a species is on). The board gains the button.

### A run (kinautocore.js prepareAutoRun / finishAutoRun)

1. **Thin out first** (if on): Thin out's own engine on the zoo as it is, with the chosen fill
   level and make-up. It comes first because the programme counts adults that don't breed (the
   old, the infertile) as fixed room: with them still there it sends breeders away instead.
2. **The Breeding programme** (Classic, the board's search budget, sliced so the game never
   stalls) on the zoo as Thin out leaves it, with the young that grow up within half a park year
   counted as breeders, so a daughter is placed away from her father before she can breed.
3. The moves: Thin out's first, then the programme's, one at a time through the board's own
   `runPlan` (each confirmed by the game, a refusal skipped), the game's gate before each.

Never moved: pregnant females, animals on the move, animals marked hands off, animals the player
moved by hand (2 park years), animals Auto mode moved itself in the last park year, young (by
Thin out). An animal Auto mode sent to the trade centre is never brought back (pinned in the
programme). The last breeding male or female of the species is never sent to the trade centre:
in a species where everyone is related the programme would otherwise empty it, one leftover at a
time (the soak showed a closed zoo dying out in 35 park years). Moves the game refused lately are
held back; after three refusals a move is no longer tried and is listed. With the trade centre
full the sends wait.

### Why it settles

On a zoo that does not change, every move the programme keeps raises its own score and Thin out
only removes animals, so runs stop finding work. A changing zoo (births, ageing) shifts the
programme's best layout: without a cooldown Best genetics moved some animals back and forth (80
moves back within a park year in one soak seed). So an animal Auto mode moved stays put for a
park year (`AUTO_LIMITS.cooldownYears`, the same window as a reversal). If a plan still moves an
animal back where it came from, two such runs stop Auto mode for the species with a notice and
"Hand it back" in the panel.

### When it acts

- Each species has its next run as a month of the park's calendar (`park:GetTimeOfMonth()`,
  read through `PZ2QoL_AutoGate` every 5 s: `year`, `month`, `monthProp`). Game time: it stands
  still while the game is paused and runs faster at 2x and 5x; animal ages are not used (the
  in-game animal-time option scales them). The holds (a year after Auto mode moves an animal, 2
  after the player does) count calendar years too. The panel shows the real time left at the
  current speed (measured from the calendar, or the game's `GetMonthDurationInSeconds()` until
  then). When it is due and nothing blocks it (the zoo just loaded: a minute's watch first; a plan
  running; a game window open; its animals on the move; the player working on that species on
  the board; a deep search of it), the species is planned.
- **Every park, Franchise included, runs by itself** (developer, 2026-10-19): turning Auto mode
  on for a species is the opt-in (CLAUDE.md and SKILL.md rule 3 name it as the one exception to
  click-started Franchise automation). No notice waits for a click; the Run now notice, the
  "ready" plan and `clickStarted()` are gone. (2026-10-18 to -19 Franchise runs waited for one
  click, the conductor's decision before the developer's.)
- **The queue** (`A.queue`): species whose run is due join it in the order they came due and run
  one after another, one run at a time. While a run (Auto mode's or the board's) goes on the
  queue waits; nothing is skipped or asked for again. A species that can't run just now (its
  animals on the move, the player planning it on the board) lets the next one go first and keeps
  its place. A run the board's own run got ahead of goes back to the front. **Run now** puts a
  species first in line (at once if nothing runs). Turning a species off takes it out.
- **Notices** are off unless the player turns them on (panel: Show a notice when Auto mode moves
  animals; player-wide pref `autoNotices`).

### What it still needs from the player

- **New blood.** The programme never pairs close kin (the game's rule or kinship of at least the
  close-kin threshold). Auto mode never buys, so a closed population ends up all related and
  stops breeding. The panel says so ("N breeders have no unrelated partner"). The soak's player
  buys one unrelated adult per species every two park years.
- **Selling.** Auto mode sends animals to the trade centre and never sells, releases or lists
  them. In Franchise the trade centre is the account's storage (250 places across zoos); in a
  small offline trade centre the sends wait once it is full, and births go on. Contraception for
  full habitats (the zoo-wide design's stage 4b) is not part of Auto mode yet: an open question.

### After the independent review (2026-10-19)

- **Another zoo mid-plan or mid-run:** a plan or run belongs to its session (`A.session`, bumped
  by `stop()`, plus the store epoch and the ledger). One from an older session is dropped, a run
  stops sending (its `beforeEach` stops the plan) and nothing is written into the new zoo. `stop()`
  also forgets the old zoo's model and gate answer, so the new zoo is never taken for offline on
  the old one's evidence.
- **Stop or Turn off mid-run:** only a move the run reached and the game refused counts against
  it. The rest are logged "not run (stopped)" and pause nothing.
- **The notice's Run now when it can't run** says why, and the notice comes back 20 s later.
- **Undo** marks an entry undone, and holds the animal, only once the game moved it.
- **Settings or make-up changed while planning:** that plan is dropped and made again.
- **Run now** on a species Auto mode stopped, or on a shoal or colony, says so.
- Young about to grow up with no place in a group may go to the trade centre (the programme's
  "no place"): keeping them raised the soak's inbred births from 0 to 5 %. Thin out never sends
  young.

### Files

| File | Role |
|---|---|
| `kinautocore.js` | Pure: settings (`SPECIES_DEFAULTS`, `EVERY_CHOICES`), `prepareAutoRun` / `finishAutoRun` / `planAutoRun`, `projectGrownUp`, the locks, fingerprints, park clock, `observeChanges` |
| `kinautoledger.js` | Pure: the per-zoo memory `kinAuto` v2 (per-species settings and countdown, pins, the player's moves, history and cooldown, refusals, the log, Undo), budget 12 KB |
| `kinauto.js` | Runtime: store binding, schedule, gate, Franchise click, runs through `runPlan`, Undo, pins |
| `kinautoui.js` | The board extension (button, panel, tags, menu item) and the notices |
| `kinboard.js` | Hooks: the Auto button, the panel slot (`S.auto`), `isBoardBusy(species)`, `openAutoPanel`, `refreshAutoPanel`; `PROG_STEPS` now from `kinprogramme.js` `PROGRAMME_STEPS` |
| `kinprogramme.js` | `PROGRAMME_STEPS` (shared), opt-in `pinIds` (unset: the same plan, `tests/engines_equivalence.test.mjs`) |
| `kinmoves.js` | `runPlan` opt-in `beforeEach` (the gate) and `owner` |
| `pz2qol.kin.lua` | `Kin.AutoGate` unchanged from section 15 |

The zoo-wide pieces are gone: the launcher button (hudlauncher.js is main's again), presets,
the veto window, contraception, the commit gate, the zoo-wide objective.

### Tests

| Test | What |
|---|---|
| `tests/kinauto.test.mjs` | Settings, the board's programme options per step, `pinIds`, a run equals the programme's plan, locks, trade-centre memory, Thin out first, refusals and reversals, cooldown, growing up, the last breeder, runs settle on 50 seeded zoos, the ledger |
| `tests/kinauto_runtime.test.mjs` | Fake game: nothing on Auto sends or writes nothing; an offline run by itself, logged and kept; the schedule; the player's move held; another zoo gets nothing; Franchise waits for the click and makes a stale plan again; Run now; off removes every hook |
| `tests/kinauto_soak.test.mjs` | 50 park years, 3 settings, 3 seeds: no reversal, no churn, no move of a held or pinned animal, every move logged, inbred births at most 2 %, no species dies out, the population in hand with Thin out |
| `tests/engines_equivalence.test.mjs` | The board's engines answer as before (golden recorded from main's code) |
| `tests/uiharness/kin_autopilot.mjs` | The board with the button, the panel off and on, every setting saved, hands off, Esc and the other panels, a 1280x720 window |

### Still to do (in game)

Section 13's probes that still apply (the gate's answers, the trade centre numbers in Franchise),
then a species on Auto in an offline park for an hour, then Franchise click-started runs while
watching server errors per move.
