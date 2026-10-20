# Plan: Market desk: market, Quick trade and Quick release (2026-10-18, revision 3)

Status: **approved** (reviews: 7.0 → 8.6 → **9.2**; review nits folded in). Revision 3 adds:
- page-report-only sends;
- the separate selection and key checks plus the existing send guards;
- a release acceptance;
- the price check;
- the timeout taken from 0b.

Revision 2 answered review 1:
- adds Phase 0b and the key shape;
- decides results by the storage list;
- fixes the v2 encoding and the desk's segments;
- adds rehome;
- makes Quick trade the default quick mode;
- adds the frozen job and double-start guards;
- adds UX and tests.

## Request (developer, 2026-10-18)

Animals that vanilla greys out for trading with "Animal was not born in a player zoo" must not show as market-sellable on the desk. They should show as their own category, mainly **Quick trade**, with a filter. From the desk the player can quick-trade (or quick-release) the selected animals instead of listing them: "make it clear and confirmed", because it's permanent.

Rules: CLAUDE.md and the pz2-modding skill.
- Franchise automation starts from a click, does one action at a time, pauses after each, and skips a failure. Exception (below): a permanent action stops the run on anything unexpected.
- Never change what is sent to Frontier beyond the game's own requests.

## 1. Facts (offline unless marked)

- **Per selection only.** The actions context `['hubAnimalsData','animalStorageData','actions']` is filled only for the current selection (`AnimalMarketAndStorageSchema.js:600-614`, `AnimalStorageInfoPanel.js:66-97`).

  | Action | Flags | Event → native |
  |---|---|---|
  | Trade (market) | `tradeAllowed`, `tradeDisallowedReason` | `AnimalStorage_AddToMarket` → `StorageUIStartAnimalAuction` |
  | Quick trade (cash) | `quickTradeAllowed`, `quickTradeDisallowedReason`, `quickTradeValue` (string) | `AnimalStorage_QuickTrade_Cash(keys)` → `StorageUIQuickTradeAnimals` |
  | Quick release (CC) | `quickReleaseAllowed`, `quickReleaseDisallowedReason`, `quickReleaseValue` (string) | `AnimalStorage_QuickTrade_Credits(keys)` → `StorageUIReleaseAnimalsToWild` |
  | Rehome | `rehomeAllowed`: when true, vanilla shows neither quick button (`AnimalStorageInfoPanel.js:321`) | `AnimalStorage_Rehome` |

  - The Lua handlers just pass the keys through (`startscreen.globe.animalstoragehubmode.lua:225-238`).
  - Pressing the vanilla quick button only changes UI state, and the request goes on Confirm (`:363-387`). So the desk calling the native directly sends what Confirm would.
  - Numeric prices: `quickTradePrice` and `quickReleasePrice` in `['animalTradeListingData']`, the context the engine already reads limits from.
- **`[AnimalList_Problem_NoBirthZoo]`** = "Animal was not born in a player zoo". The developer saw it grey out Trade and Quick release in game (**proven**). The skill's `game-data-and-events.md` line "applies to release only" is wrong and is corrected in this change, with a changelog line.
  - Whether Quick trade is allowed for such animals is **unknown**; Phase 0a settles it.
  - If Quick trade is refused too, those animals are `blocked` (with the reason), and the desk says so; there is then nothing to quick-trade.

## 2. Phase 0: the in-game probe (before anything permanent ships)

**0a. During a normal listing run** (the current flow, nothing extra sent). For about 20 animals, log:
- the quick flags and values from the page report;
- the row's `source` text and the native `isReleaseable` filter state;
- `connectingAction` / `IsDatabaseOperationInProgress` just before and after each select, which tells whether a select sends a request;
- every database-error request type during the run (`lister_server_error_type_<n>`);
- the numeric `animalTradeListingData.quickTradePrice` / `quickReleasePrice` next to each selection's `quickTradeValue` / `quickReleaseValue` text, to see whether the numbers are per selection.

**0b. One vanilla quick trade**, by the developer, of one throwaway animal, with tracing on.
- `AnimalStorageHubMode.OnQuickTradeAnimals` and `OnReleaseAnimalsToWild` are wrapped. **The wrappers only log, then call the original unchanged.**
- What gets logged:
  - the `_tIDs` shape: `type`, `#`, the key range, and each value's type and text;
  - the request type and any database errors in the next 10 s;
  - when the row leaves the storage list.

The developer then does **one vanilla Quick release** of a second throwaway animal, logged the same way. Both actions use `onQuickTradeOrRelease`, but release's request, errors and list rebuild are observed separately.

Phase 2 copies the key shape **exactly** and doesn't depend on knowing error types.

**Decision after Phase 0:**
- If `source` or `isReleaseable` classifies the rows exactly as the quick flags do on all ~20, the desk uses it and needs no selects for categories.
- Otherwise it falls back to Check storage (§3.2).

## 3. Phase 1: categories, filter, Check storage (no permanent action)

### 3.1 Categories (`listercore.js`, pure)

- **`verdicts`: guid → `{ trade, quickTrade, quickRelease, rehome, reasons, prices, at }`.** It is filled by:
  - every listing run (its page report gains the quick fields, §3.3);
  - Check storage.

  It lives for the page. **Read storage again** clears it.
- **`categoryOf`** returns:
  - `market` when trade is allowed;
  - `quick` when trade isn't allowed, rehome isn't offered, and quick trade or quick release is allowed;
  - `blocked` otherwise (including "Rehome only"), with the reasons in words (`reasonText`);
  - `unknown` when not checked yet, which behaves as today: listable, and the run checks it.
- **A row in `quick`** shows exactly what it allows: "Quick trade · $1,200" and/or "Quick release · 85 CC".
- **The desk's segmented control** gets a fifth segment: Show all | Sellable | **Quick trade** | On market | Not sellable (`marketdesk.js:790`, `state` in `listercore.js`).
  - `speciesCounts` counts `quick` separately and never as `sellable`.
  - In List mode, `tickable`, Tick all and the sort order treat `quick` and `blocked` as not listable.

### 3.2 Check storage (only if Phase 0 says it's needed)

- **Button**: "Check storage (N not checked, ≈ M min)" in the desk header.
- **The engine's new job, `mode: 'check'`.** Per unknown animal of the shown species:
  1. resolve;
  2. clear;
  3. select;
  4. read the report;
  5. record.

  It never reaches send.
- **Pace**: the desk's pause if Phase 0a shows a select sends a request, else 150 ms between selects. Stop works at any time. The selection ends cleared.

### 3.3 The page report v2 (`listercore.js` `readSeen` / `encodeSeen`, Lua `parseSeen`)

- **Today's v1** puts the trade reason last, with only newlines stripped (`listercore.js:550-561`). It has no escaping.
- **v2 percent-encodes every reason field** (`encodeURIComponent` in JS, a matching decoder in Lua) and adds:
  - the quick-trade and quick-release allowed flags, reasons and numeric prices;
  - `rehomeAllowed`.
- **Compatibility**: Lua still parses v1. The unit test includes `|`, `,`, `%` and long nested loc tokens.

## 4. Phase 2: Quick trade / Quick release from the desk (only after Phase 0b)

### 4.1 Modes and the look

- **The right panel's mode switch**: List on market | **Quick trade** | Quick release. It always starts on List; a quick mode is never remembered.
- **A quick mode recolours the panel** (red tint, a header naming the mode: "QUICK TRADE · sells for cash at once · can't be undone").
- **In a quick mode**, only `quick` rows whose own action is allowed can be ticked. Others show why.

### 4.2 The confirmation sheet

- **The button**: "Quick trade 7 animals ($8,400)…". The total comes from the numeric prices only if Phase 0a showed they match the selected animal's value text; otherwise "≈" from the value text.
- **The sheet**, inside the desk:
  - the count and total;
  - every animal that will go: up to 12 names, then "and N more";
  - **the ticked animals that will be skipped, and why**;
  - "These animals leave your storage for good. This can't be undone."
- **Confirm is a 2 s hold**, with the mouse or the gamepad's A, and a fill shows the hold. Cancel or Esc closes the sheet. Esc is checked not to be taken first by the game's own back-out of the screen.
- **When the hold completes:**
  - the job is **frozen** to exactly the GUIDs shown in the sheet;
  - the hold button is disabled;
  - the sheet closes;
  - the run starts.

### 4.3 The run: engine `mode: 'quicktrade' | 'release'`, one animal at a time

1. resolve;
2. clear;
3. select;
4. read the report. **In quick modes it must be a fresh page report** (`sSrc == "page"`) for this animal and this step. Lua's own DataStore reads never saw the selection in game (proven, Y: 2026-10-17), so they are never trusted for a permanent action. Without a page report the animal is skipped. After two **missing page reports** in a row, **the run stops**. Ordinary "not allowed" skips don't count towards this;
5. **the action's own flag must be allowed now** (from that report), else skip with the reason;
6. **in the same tick**, both of these, plus today's send guards:
   - `_IsSelected`: the selection is exactly this animal. **In quick modes it takes the page report's answer only.** It never falls back to Lua's reads when the report is older than `nPageFresh`; a Lua test checks that a send tick with only Lua's reads sends nothing;
   - `_Holds`: the key still resolves to this animal (GUID or fingerprint);
   - `_Busy`: the game is idle, else wait, then skip;
   - the `dataPrint` stability check: the report settles again if the data changes;
7. send one key, **in the shape Phase 0b recorded**, to `StorageUIQuickTradeAnimals` / `StorageUIReleaseAnimalsToWild`;
8. **the storage list decides the result:**
   - **Gone**: the GUID left the list, or for a fingerprint-token animal, no row matches its fingerprint any more. That's done.
   - **Still there after the timeout**: "not confirmed: check storage". There's **no retry**, and **the whole run stops**. The timeout is 3× the slowest list update Phase 0b saw, at least 10 s. Every live run logs the real time (`lister quick_gone ms=`) so the figure can be tuned.
   - **Ambiguous** (the fingerprint now matches a different count of rows): **stop the run**.
   - A database error during the wait only shortens the wait. The list still decides.
9. pause (the desk's pace, at least 1 s).

- A failed allowed check (step 5) skips that animal and goes on. Every other unexpected outcome **stops the run**: this is a permanent action, an exception to "skip and carry on", stated in the run card.
- **Lua refuses to start any job while another runs.** Stop ends after the current animal.
- **A page reload mid-run**: Lua sends nothing once the page report is stale, **even mid-step**. The send step itself requires a report fresher than the step's start, so it never fires after a reload. The run stops; it never restarts or grows. The page shows "Stopped: page reloaded" with the per-animal lines.
- **The run card**: "Quick-traded 6 of 7 · $7,200", with a line per animal.

## 5. Tests

- **Unit**:
  - `categoryOf`, including rehome → blocked;
  - the segment counts, the ticking rules in each mode and Tick all;
  - the v2 encoding round trip with `|`, `,`, `%` and long tokens;
  - the sheet text (go and skip lists, totals).
- **Lua**:
  - check mode never sends;
  - quick modes send one key per animal, only after the allowed flag and `_Holds`;
  - a stale selection is skipped;
  - the result comes from the list, including when a stray database error arrives;
  - a timeout or ambiguity stops the run;
  - a second start while one runs is refused;
  - a fingerprint-token animal's confirmation;
  - the frozen job never grows.
- **UI harness**:
  - the categories and segment;
  - Check storage;
  - the mode colours and header;
  - the sheet: hold, Cancel and Esc send nothing;
  - the hold button is disabled while a run is active;
  - a fake engine's quick-trade run.

  Screenshots are looked at.
- **Live acceptance**: one throwaway animal per mode, tracing on, the result checked against storage, before more than one is ever run in that mode. Quick release opens only after its own acceptance.
- **Lua, added for revision 3**:
  - no send without a fresh page report; two such skips stop the run;
  - `_IsSelected` false → no send;
  - `_Holds` false → no send;
  - `_Busy` → wait, then skip;
  - a changed `dataPrint` → settle again;
  - the total is shown as exact only when the prices matched.
- **UI harness, added**: the stopped-run card after a reload ("Stopped: page reloaded", with the per-animal lines).

## 6. Delivery

- **Phase 0** (the probe wrappers and marks) ships in the next build. It's harmless: logging only, plus the developer's one vanilla quick trade and one vanilla quick release, each of a throwaway animal.
- **Phase 1** ships next.
- **Phase 2** after Phase 0b's trace, and per mode after that mode's live single-animal acceptance (Quick release opens only after its own).
- The skill's references (game-data-and-events.md, the storage actions) are updated with each phase: the key shape and confirmation timing from 0b, with a changelog line each time.
- The README states that quick runs **stop** on anything unexpected, unlike the lister's skip-and-carry-on rule, so the developer signs off on it.
- If `source` or `isReleaseable` classifies the rows, the segment shows 'Classified from the storage list; each animal is checked again before it goes.'
