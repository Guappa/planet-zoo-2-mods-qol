# Design: Autopilot (optional full-auto breeding management)

Status: **design only, nothing built** (2026-10-16). Written for the developer to decide the open
questions in section 14 before any code. "Autopilot" is a working name.

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
| Executor (`kinmoves.js` `runPlan`, `moveAnimal`) | Not changed. Autopilot is a caller of `runPlan` like the board (it adds its ordering and muting outside it). |
| Lua (`Kin.Move`, `Kin.Contracept`, `Kin.Scan`) | Manual calls take today's path. Autopilot's extra guards (e.g. `IsPlayerAnimalMovementEnabled`) run only when the call is flagged as Autopilot's (an extra argument the board never sends). The snapshot gets no new fields; Autopilot asks for its gate facts with its own event, only while on. |
| Scans | Today's cadence (20 s, 6 s with a kin surface open). The faster rate is only while on. |
| Kin alerts | No muting. Muting only covers Autopilot's own plan in flight. |
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

- **Cooldown:** an animal Autopilot moved is not moved again by P1/P2 for 30 min of park time (and
  never twice within one cycle). P0 may override, once.
- **No reversals:** a plan that sends an animal back to a habitat it left in the last 2 hours is
  rejected unless P0 needs it.
- **Oscillation breaker:** two reversals for one species within a day mark it **unstable**:
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
