# PLAN: Bring a species from Animal Storage to this zoo's trade centre

Status: implemented 2026-10-18 (review 9.0/10, revision 3). First in-game run worked (10 animals); fixes after it: the hub card closes itself, a curtain hides Storage while the mod works, a finished job no longer blocks the next request, the species chip is removed afterwards.
Game: 1.0.5 (build 1023906). Facts are marked **proven** (seen in game), **offline** (decompiled
Lua / unpacked UI / exe strings) or **guess**, as the `pz2-modding` skill requires.

## 1. What the developer asked

On the Species board's pinned trade column (which already lists stored adults read-only via
`storedCards` / `storedGroup`), a button like "Bring 8 Okapi from storage to this zoo's trade
centre": every animal of the board's species in hub Animal Storage goes to this zoo's trade centre.
Background automation was acceptable to them, but CLAUDE.md requires Franchise automation to start
from the player's click and do one action at a time, so it is a button.

## 2. Feasibility (offline findings)

| # | Question | Answer | Mark |
|---|---|---|---|
| F1 | Any park-side call that moves a stored animal (GUID record, id type 2) into the zoo? | **No.** Every `api.planetHub.*` call used in the decompiled Lua and every exe Lua-name string with Storage/SendToZoo/TradeCentre was checked. The park can only *read* storage (`GetAdultsOfSpeciesInStorageSplitByGender`). `facilities:CreateAnimalInTradeCentreFromGUID(guid, token)` exists, but the game uses it only for exhibit animals moved to a habitat (`AnimalMovementEditMode` ~939). Using it on storage records is not a normal game request, so it is ruled out (CLAUDE.md). | offline |
| F2 | Is there an in-park storage or trading screen? | **No.** The park's `AnimalTrading` UI mode is dead code (the 1.0.5 skill entry already says so). The trade centre's own "Open storage" button runs a world transition to the hub (`FacilityInfoPopUp._OpenAnimalStorage`). | offline |
| F3 | How does the game's Send to Zoo work? | Hub: `AnimalStorage_SendToZoo(selectedAnimalIDs)` → `StorageUISetAnimalsToBeSentToZoo(ids, false)` + `ShowWorldTransition(true)`, **one event for the whole selection**. Park: `SelectMode` Advance → `park:GetAndClearPendingSendToZooEntityIDs()` → `BaseUIMode.SetNewMode("AnimalMovementMode", {tSelectedAnimals = entity ids})`. So the stored animals **have entities** once the park loads. Return to Zoo (`bReturn = true`) instead calls `RequestTransportToAssignedHabitat` per animal, which only fits animals with a habitat in this zoo. | offline (already in skill) |
| F4 | Does the game's Move screen offer the trade centre for arrivals? | **Yes.** `AnimalMovementEditMode.UpdateValidDestinations` adds every `facilities:GetTradeCentres()` entry when `GetTradeCentreMaxCapacity() >= GetNumberOfAnimalsInTradeCentre() + #selection` (all at once). Picking it calls `animals:AttemptToSendToTradeCentre(e)` **per animal** (`HabitatAnimalDestinationSelected` ~917-933) after only `VerifyAnimals` (alive; not escaped unless boxed) and **without** `CanSendAnimalToTradeCentre`. The info panel's / management list's Send to Trade Centre is stricter: its preventers are dead, already in trade centre, escaped, in vet, **boxed** (`relocateanimalspopup.lua` :34). `Kin.Move("trade:…")` follows the strict one (`CanSendAnimalToTradeCentre`), so it may refuse a boxed arrival. The call itself is proven 1.0.4 for habitat animals. | offline (call proven) |
| F5 | Where do arrivals wait before a destination is picked? | **In the trade centre.** First in-game run (D:, Franchise, 10 Eurasian beavers): every arrival read `lt == trade` at once; the run made no move requests. | **proven** 2026-10-18 |
| F6 | Capacity | **Franchise: the trade centre's count is the whole account's storage** (developer, 2026-10-18: 90/250 across all zoos). `park:GetTradeCentreMaxCapacity()` / `GetNumberOfAnimalsInTradeCentre()` feed that panel, so stored animals already count; the cap at the click and the per-animal room check only matter near the pool's limit. The Move screen hides the trade centre when the whole selection does not fit; `Kin.Move` refuses when full. Whether a stored animal sent to the zoo changes the count: open. | proven (count) / open |
| F7 | Server traffic (Franchise) | The hub Send to Zoo is **one** game action for the selection, the same as the player's click (whether it is a server request: unknown, native). In the park: nothing for an arrival already in the trade centre; otherwise one `AttemptToSendToTradeCentre` per animal, paced like the mod's other moves. World transitions save the zoo as the game always does. | offline / guess |
| F8 | Do storage rows include animals already in this zoo's trade centre? | **Unknown.** Every storage row is labelled "In trade centre" (`getAnimalLocationString`), and the developer saw ~8 of a species in Storage vs 3 trade-centre animals on the board. The design excludes rows it can match to a park animal, and treats an arrival that is already in the trade centre as done. Matching is best effort: `StorageGetIDAndAIDType(key)` identified only 4 of 63 rows on Y (changelog 2026-10-18), so it falls back to species + name + sex. | guess |
| F9 | Ticking storage rows | `AnimalStorage_ItemCheckboxToggled(rowId, bool)` → `StorageUISetItemMultiSelected` and `AnimalStorage_SelectAllToggled(false)` → `StorageUIClearSelectedItems` are native; that they stay local (no server) is a **guess** shared with the Market desk and select-all, which already use them. The row id differs from the list key (proven on Y): tick by row `id`, send the list keys from `selectedAnimalIDs`. | offline / guess |

**Conclusion:** possible only through the hub, using the game's own Send to Zoo once, then (in the
park) taking the Move-screen request the way "Find a habitat" already does and running the Move
screen's own trade-centre sequence for each arrival that is not already there. The building blocks
already exist in the mod: TradeJump (park → Animal Storage with a species), StorageSend (hub arm →
park takes the Move-screen request), `Kin.Move` (one Send to Trade Centre). Anything that does not
reach the trade centre goes back to the game's own Move screen with one click.

## 3. Design

### 3.1 Player view (UI text)

**Park, Species board, pinned trade column**, at the top of the column's stored block (every game
mode; the stored adults list itself stays Franchise-only):

```
[ ⇩ Bring Okapi to the trade centre ]          (button, full column width)
  8 adults in storage (+ any young) · trade centre 3/12
```

- Tooltip: "Opens Animal Storage, ticks every stored Okapi and sends them with the game's own Send
  to Zoo. Back in the zoo each one goes to the trade centre, one at a time. Adults first; young
  too if there is room."
- Note line when the count is unknown (Sandbox, or no answer): "Okapi in storage: count unknown
  here · trade centre 3/12".
- Disabled, with the reason as the note line:
  - "Build a trade centre first" (no trade centre / `hasBuildingForAnimalStorage` false);
  - "The trade centre is full (12/12)";
  - the existing `canOpenTrade()` reasons (a plan or a Find-a-habitat run is going, hub disabled);
  - "No adult Okapi in storage" only when the Franchise count is known and 0 (stored young may
    still exist, so the button stays enabled when the count is unknown).
- After the click the board closes and the hub opens (as the Storage shortcut does).

**Hub, Animal Storage** (the mod's card, top-centre, like the Find-a-habitat card):

```
Bring Okapi to Zoo Name's trade centre
7 animals: 5 adults, 2 young · room for 9
Sending in 3…            [Send now]  [Cancel]
```

- First delivery after the click: a 3-second countdown, then the send happens by itself (the board
  click was the opt-in; the countdown is a last chance to cancel). "Send now" skips the wait.
- Any later delivery of the same request (hub page reloaded, Storage left and opened again): the
  same card with **[Send] [Cancel]** and no countdown, so nothing is sent without a fresh click.
- Before the countdown the list is narrowed to the species (the mod's `species` chip) and the rows
  are ticked, so the player sees exactly what goes.
- More animals than room: "Room for 9 of 12: adults first. Staying in storage: Asha, Bo, Cleo
  (check none of them is a mother leaving her young)."
- Stops (card shows Close only, ticks cleared):
  - "No Okapi in storage";
  - "The game won't send this selection" (`sendToZooAllowed` false after ticking);
  - "The game did not tick the animals" (selection not as asked within 3 s);
  - "The selection changed; nothing was sent" (re-check right before sending).
- Native filters on and the clear failed: "Your storage filters hide some animals; only the 4 shown
  will be sent."
- Cancel → ticks cleared, filter chip stays (one click clears it).

**Park, after the zoo loads** (the Find-a-habitat card, retitled):

```
Bring to trade centre
[██████████░░░░] 7 / 7      In trade centre 7 · Skipped 0
Done: 7 Okapi are in or on their way to the trade centre.   [Species board] [Close]
```

- Per animal: "already in the trade centre" (no request), "sent to the trade centre", or a skip
  reason ("trade centre full", "the game refused: …", "not confirmed in time", "no longer here").
- Skipped animals: an extra button **[Open the game's Move screen for 2]** opens the game's own
  Move screen for exactly those animals (vanilla, the player picks the destination).
- Stop ends the run after the current animal; the rest go to that same Move-screen button.

### 3.2 Flow and events

```
Park page (HUD)                      Lua                                   Hub page (Frontend)
board button ──PZ2QoL_FetchStart(req, species, excludeCsv)──▶ Fetch.Start:
                                      park, trade centre, room, zoo key
                                      tPending = {seq, species, room, exclude, zoo, delivered=false}
                                      TradeJump:_OpenHub("storage")  (game's own opening)
◀─PZ2QoL_FetchStartResult(req, ok, detail)
(board closes)                        … world transition …
                                                                ◀── PZ2QoL_FetchHello (load / Storage shown)
                                      ──PZ2QoL_FetchPending(seq, species, room, excludeCsv, fresh)──▶
                                      (fresh = first delivery; then delivered = true)
                                                                  card; species chip; deskFilters('clear')
                                                                  if native filters on; wait rows;
                                                                  pick rows; tick them; countdown 3 s
                                                                  (fresh) or wait for [Send]
                                                                  re-check selectedAnimalIDs == picked
                                                                ◀── PZ2QoL_FetchAck(seq)  (pending dropped;
                                                                     Cancel sends it too)
                                                                ◀── PZ2QoL_SendArm(n, true, "trade")
                                      StorageSend.tArm = {n, t, online, sTarget="trade", sZoo=Fetch zoo}
                                                                ◀── AnimalStorage_SendToZoo(keys)  (game's own, once)
                                      … game: StorageUISetAnimalsToBeSentToZoo + transition …
                                      SelectMode → SetNewMode("AnimalMovementMode", ids)
                                      StorageSend._TryTake: armed for "trade", same zoo → take
                                      tArrived = {seq, ids, online, sTarget}
◀─PZ2QoL_SendArrived(seq, ids, true, "trade")   (re-sent on PZ2QoL_SendHello until Ack, with target)
runTradeArrivals: one animal at a time
  ─PZ2QoL_SendFacts(req, id)──▶ (+ tc, tcNow, tcMax, boxed, claimed)   trace fetch_arrival_lt_<lt>
  lt == trade → done, no request, no pause
  else ─PZ2QoL_SendMove(req, id, "trade:arrival")──▶ StorageSend._ArrivalToTrade (Move screen's sequence)
       confirm: facts until lt == trade or moving (≤ 12 s); pause getPaceMs('moves')
leftovers ─PZ2QoL_SendOpenMove(csv)──▶ original SetNewMode("AnimalMovementMode", {tSelectedAnimals})
```

### 3.3 Row choice in the hub (`storagefetchcore.js pickRows`)

From the storage list (after the species chip and any native-filter clear):
- same species (`speciesKey(row.species)` == wanted);
- not `isShoal` (shoals/colonies: Kin leaves them out; listed as "N shoals stay");
- not `isMoving` (already on its way: the panel would show Cancel);
- not on the market (`auctionTimerSeconds > 0`);
- not one the park already has: its GUID (storage kin model, when resolved) is in the exclude list,
  or else species + name + sex match a park animal of the species (exclude list carries both);
- order: adults before young, fertile adults (maturity 1-3) before old ones, then name; cap at
  `room` (unknown room: no cap). The card names those left behind.

Ticking (F9): `AnimalStorage_SelectAllToggled(false)` then `AnimalStorage_ItemCheckboxToggled(rowId,
true)` per row; wait (≤ 3 s) until `selectedAnimalIDs` has the wanted count. Right before sending,
the current `selectedAnimalIDs` must equal the picked keys as a set; the arm count is that length.
The keys sent are the DataStore's own `selectedAnimalIDs`, so the game's handler gets what a player's
selection would give.

### 3.4 Park side after arrival

- Lua `StorageSend.tArm` gains `sTarget` ("habitat" default, "trade") and `sZoo` (the zoo key Fetch
  saw at the click; nil for Find a habitat). `_TryTake` keeps every existing check (count ≤ armed,
  entity ids, not exhibit, no return screen, park page ready) and, for "trade", compares the
  receiving park's `Kin._ZooKey` with `sZoo`: different → not taken (`send_zoo_mismatch`); in a
  Franchise (or unknown-mode) park either key unknown → not taken (`send_zoo_unknown`); in an
  offline park an unknown key is accepted (Sandbox keys by park name and may still be "wait").
  Not taken = the game's own Move screen opens as today.
- `tArrived` keeps `sTarget`; `_Deliver` passes it as the 4th `PZ2QoL_SendArrived` argument, so a
  re-send after Hello still says "trade". The JS handler takes the 4th parameter.
- `StorageSend.Move` accepts `"trade:arrival"`: only for an id in the current `tArrived` list (the
  animals the mod took from the Move screen); the page passes its run's `seq` too, and a `seq` that
  is not the current `tArrived.nSeq` (a late answer from an older run) drops to the strict
  `Kin.Move("trade:auto")` path, which is harmless. It mirrors `HabitatAnimalDestinationSelected` for a
  trade-centre destination: `VerifyHabitatAnimal` (alive; not escaped unless boxed), a trade
  centre exists, room (`nNow < nMax`), no transport job / box claim, then
  `animals:AttemptToSendToTradeCentre(e)`. No `CanSendAnimalToTradeCentre` pre-check, as in the
  Move screen (F4). Any other id falls back to `Kin.Move("trade:auto")` (the strict path).
- `StorageSend.Facts` adds `tc`, `tcNow`, `tcMax`, `boxed` (`IsAnimalBoxed`), `claimed`
  (`IsBoxingClaimed`), cheap reads in `call()`; trace `fetch_arrival_lt_<lt>` once per arrival.
- `PZ2QoL_SendOpenMove(csv)`: ids ∩ `tArrived` ids, still alive, no transport job (the Move
  screen's `VerifyAnimals` would fail on those) → stored as `tOpenMove` (≤ 30 s). The next
  `SelectMode.Advance` (patched, the same per-frame context in which the game itself opens the Move
  screen for arrivals, `selectmode.lua` ~603) calls the **original**
  `SetNewMode("AnimalMovementMode", {tSelectedAnimals = ids})` once, in `pcall`, and answers
  `PZ2QoL_SendOpenMoveResult(ok)`; on failure or timeout the card says "The game's Move screen did
  not open; use Move on each animal." One click, one screen.
- The JS run (`runTradeArrivals` in `storagefetchcore.js`, from `storagesend.js startRun` when
  `target === 'trade'`): one animal at a time; `busy` (Franchise DB operation) waits like Find a
  habitat; failures are skipped, only Stop ends the run (ground rule 3); the pause
  (`getPaceMs('moves')`, ≥ 1 s) follows every request, `ERROR_PAUSE_MS` after a refused or
  unconfirmed one online. An animal already in the trade centre costs no request and no pause.
- The boxed-animal alert (`kinboxed.js`) skips ids of a running send run and forgets their timer,
  so it starts fresh after the run (2-line change: `isInSendRun(id)` from `storagesend.js`).

### 3.5 Files

| File | Change |
|---|---|
| `Main/pz2qol.storagefetch.lua` (new) | `Fetch.Start/Hello/Ack`, one-shot pending (`fresh` once, 10 min expiry), zoo key; registered in `pz2qol.core.lua` and attached in `pz2qol.hub.lua` like TradeJump |
| `Main/pz2qol.tradejump.lua` | split `Open` into `_OpenHub(sKind)` (no behaviour change) so Fetch reuses the game's opening |
| `Main/pz2qol.storagesend.lua` | `SendArm` 3rd arg `sTarget` (+ `sZoo` from Fetch); `tArrived.sTarget`, `SendArrived` 4th arg; zoo check; `Move` "trade:arrival"; Facts trade-centre fields; `PZ2QoL_SendOpenMove` |
| `js/mods/pz2qol/storagefetchcore.js` (new) | pure logic: `fetchBlockReason`, `fetchNote`, `pickRows`, `sameKeys`, `hubStep`, `runTradeArrivals`, texts |
| `js/mods/pz2qol/storagefetch.js` (new) | park: `fetchRow(model, species, opts)` for the board; hub: pending, card, ticking, countdown / Send, re-check, send |
| `js/mods/pz2qol/storagesend.js` | export `armAndSend(keys, target)` (sets `ourSendAt`, so its own disarm listener ignores it); `startRun` branches on `target`; card per target with the Move-screen button; SendArm passes `'habitat'`; `isInSendRun(id)` |
| `js/mods/pz2qol/kinboxed.js` | skip ids in a running send run (2 lines) |
| `js/mods/pz2qol/main.js` | install `installStorageFetch()` |
| `css/mods/pz2qol_storagefetch.css` (new) | button row and hub card (reuse `PZ2QoL_ss*` card styles) |
| `js/mods/pz2qol/kinboard.js` | **minimal, anchored (4 lines), see 3.6.** Nothing in the Breeding programme / Deep code (agreed with planet-zoo-2-mods-45) |

### 3.6 The kinboard.js edit, exactly

After the tradejump import (line 48):
```js
import { fetchRow } from '/js/mods/pz2qol/storagefetch.js';
```
In `storedGroup`, after `if (!model || !sp) return;`:
```js
    const fetch = fetchRow(model, sp, { onOpened: () => closeSpeciesBoard(), onError: text => notice(text, 'warn') });
    if (fetch) content.appendChild(fetch);
```
The stored-list note (shown only when the stored list is non-empty): "… Send these to the zoo from
Animal Storage." → "… Bring them with the button above, or from Animal Storage."

## 4. Rules check

- **Click-started, one action at a time:** the board click starts it; a stale request never sends
  without a fresh click (one-shot `fresh`); the hub sends one game Send to Zoo; the park does at most
  one Send to Trade Centre at a time with the player's pace. No timer or background start. No
  "allow in Franchise" switch.
- **Nothing new sent to Frontier:** only the game's own Send to Zoo (as the player's button) and the
  game's own Move-screen trade-centre sequence (or its Move screen itself). Filter clearing and
  ticking are the same native UI calls the game's controls make (F9).
- **Fail soft:** every Lua call in `pcall`; any missing piece leaves the vanilla path (no card, or
  the game's own Move screen).
- **Exe / Denuvo:** untouched.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Arrivals are boxed outside the trade centre and the game refuses Send to Trade Centre for them | the Move screen's own sequence (no `CanSend` pre-check); anything left → one-click game Move screen for exactly those animals |
| Hub Send to Zoo ignores trade-centre room; too many arrive | cap at the room measured at the click; card names who stays |
| A row already in this zoo's trade centre is in storage (F8) | GUID / name+sex exclusion; arrival already in trade centre = done, no request |
| Native filters hide rows | `deskFilters('clear')`; the lister restores them when Storage transitions out (tested) |
| Stale pending sends without a click | one-shot `fresh`; later deliveries need the card's Send |
| Selection changed during the countdown | re-check right before sending; stop with a message |
| Hub pointed at another zoo before sending | Lua takes the request only in the zoo of the click; else vanilla Move screen |
| Find-a-habitat arm collides | one arm at a time; a new arm replaces the old; `canOpenTrade` blocks while a run is going |
| Room shrinks between the click and the arrival (a birth, a player's own send) | the per-animal room check skips them; they go to the Move-screen button |
| Server refusal on a Send to Trade Centre | skipped, run carries on; `ERROR_PAUSE_MS` after it (ground rule 3) |
| Boxed-animal alert fires mid-run | suppressed for the run's ids |
| Capping splits a mother and her young | adults first, and the card names who stays |
| kinboard.js conflict with the programme agent | anchored 4-line edit, agreed; programme harness re-run |

## 6. Tests

Unit (`node --test tests/storagefetch.test.mjs`, plus the full `tests/*.test.mjs`):
- `pickRows`: species match, shoal/moving/listed skipped, excluded by GUID and by name+sex, adults
  and fertile first, cap by room (names left behind), room 0, unknown room.
- `fetchBlockReason` / `fetchNote`: known 0, unknown, full, no building, blocked by a run.
- `sameKeys` and `hubStep`: wait rows → clear filters → tick → (fresh) countdown / (stale) wait for
  Send → re-check → send; changed selection; expiry; cancel.
- `runTradeArrivals` with fakes: already in trade centre (no move, no pause), moved and confirmed,
  boxed with the strict check false but the arrival path ok, refused (skip + error pause online),
  unconfirmed timeout, gone, busy wait, Stop; leftovers listed.

Lua (`tests/lua/test_storagesend.lua`, new `tests/lua/test_storagefetch.lua`):
- arm with "trade" → `_TryTake` → `SendArrived` has "trade", also when re-sent on Hello; default
  target "habitat"; zoo mismatch → not taken.
- `Move` "trade:arrival": only for arrival ids; `AttemptToSendToTradeCentre` called once without
  `CanSendAnimalToTradeCentre`; full → refused; a non-arrival id → strict `Kin.Move` path.
- `SendOpenMove` stores the ids (arrival ids only, no transport job) and the next `SelectMode.Advance`
  calls the original `SetNewMode` once; expiry after 30 s; a throwing `SetNewMode` answers false.
- Zoo key: Franchise with an unknown key → not taken; offline with an unknown key → taken.
- Facts carries the trade-centre fields; Fetch.Start: ok opens the hub once, full, no trade centre,
  no park, bad species; Hello gives `fresh` once then not; Ack/expiry.
- Lister: Storage TransitionOut after `deskFilters('clear')` restores the settings.

Browser harness (new `tests/uiharness/kin_storagefetch.mjs`, `--kin-only --only storagefetch`):
- Frontend: a row of the species on the market or already moving is not ticked.
- HUD: board with stored adults → button in the pinned trade column with count/room note; click →
  exactly one `PZ2QoL_FetchStart` with species + exclude list; board closes; full → disabled.
- Frontend: `FetchPending(fresh)` → chip set, the species' rows ticked (only them), countdown,
  then exactly one `PZ2QoL_SendArm(n, true, 'trade')` followed by one `AnimalStorage_SendToZoo`
  with the DataStore's keys. Stale delivery → no send until Send is clicked. Selection changed
  during the countdown → no send. Cancel → neither.
- HUD: `SendArrived(…, 'trade')` → card: one already in trade centre (no move), two moves, one
  refusal → summary and the "Open the game's Move screen for 1" button sends one
  `PZ2QoL_SendOpenMove`. A re-delivery through Hello keeps "trade".
- Screenshots of all states; **look at them**.
- Regression: `node --test tests/*.test.mjs`, `node tests/uiharness/run.mjs --kin-only --only
  programme`, and the `storagesend`, `tradejump`, `board_stored`, `boxed` scenarios.

In game (D: dev install only; needs the developer):
1. Franchise zoo with a trade centre and ≥ 2 stored animals of one species (ideally one young).
   Species board → that species → "Bring … to the trade centre". Expect: hub opens on Storage,
   species filtered, rows ticked, card counts down, the game's transition back to the zoo.
2. In the zoo: the card finishes; the trade centre's capacity rose by N; the board shows them.
3. Same in a Sandbox zoo.
4. Edge cases: leave Storage before the countdown ends and come back (card asks for Send); change
   the selection during the countdown (nothing sent); if any animal is skipped, press "Open the
   game's Move screen for N" (the game's Move screen opens for exactly those).
5. Send `dbg/trace.log` lines `fetch_*`, `send_taken`, `fetch_arrival_lt_*`, `kin_move_*`,
   `send_move_*` to settle F5-F8.

## 7. Open after the in-game test

- F5 (where arrivals wait), F6 (does Send to Zoo check room), F7 (is Send to Zoo a server request),
  F8 (are this zoo's trade-centre animals in storage). Update `animals-and-breeding.md` with the result.
- Separate cleanup (not this change): `storagesend.js` still keeps the old `allowOnline` switch
  plumbing (always true now).
