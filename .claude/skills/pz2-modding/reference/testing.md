# Testing

Run all of these before installing a build.

| Test | Command | Covers |
|---|---|---|
| Unit (JS logic) | `node --test tests/scores.test.mjs tests/pricing.test.mjs tests/zoo.test.mjs` | Gene and breeder scores, storage and zoo filters, pricing |
| Lua behaviour | `<cobra-tools>/modules/formats/utils/luadec/lua.exe tests/lua/test_pz2qol.lua mods/PZ2QoL/Main/` (and `tests/lua/test_storagesend.lua`, `tests/lua/test_lister.lua`) | Require hook, view redirects (FrontEnd, HUD), error receiver, overlay unload order, ModeHelper sweep and the Move-screen guard (section 13), autosave breadcrumbs (section 14), the player store of habitat assignments (end of section 11: offline/Franchise zoo keys, wait/noplayer, chunks, 64 KB cap, debounced save, old park-save import; section 16: probe cleanup; mocks the game's MainPlayer GetData/SetData), against a mock `api` |
| Lua syntax | `luac.exe -p <file>` (same folder) | Syntax only |
| Module load | `cd tests/uiharness && node probe_imports.mjs` | Every UI module imports in a real browser (`node --check` misses errors in these ES modules) |
| Browser harness | `node tests/uiharness/run.mjs [--no-vanilla]` | See below |

## Browser harness (`tests/uiharness/run.mjs`)

- Serves the **real unpacked game UI** plus the mod files (`server.mjs`) and runs them in Edge via
  playwright-core.
- Its page shims fake `engine` and seed DataStore dummy data. Compat CSS approximates Gameface.
- Scenarios:
  - Frontend: market and storage toolbars, badges, collapse.
  - Lister, against a fake native layer:
    - off by default;
    - price equals the shown recommendation;
    - 12 h duration;
    - sole selection while listing;
    - a skip on the 3rd animal and a fatal stop;
    - a 9-animal run that must finish (to catch the "stalls at the 6th" report);
    - a big selection stays compact.
  - HUD: opens management Animals (`Management_SetManagementIndex`, 7), then checks the habitat
    picker, that select-all only ticks visible rows, Clear, and toolbar height.
- Screenshots go to the scratchpad `harness/out`. **Look at them**: layout bugs pass the
  assertions surprisingly often.
- It prints `OK` or `FAIL` with `HARNESS ERRORS`.
- **Pitfall:** the harness runs detached, so `Engine.isCoherentPlayer()` is **true**. The game's
  debug-player-only listeners, such as `SetAnimalMarketScreen`, work here but **not in game**.
  Never let mod code depend on them, only harness navigation.
- The lister scenario also fakes the Lua side of the background market check
  (`PZ2QoL_MarketPeek` → `PZ2QoL_MarketPeekState` loading/ready → `PZ2QoL_MarketPeekRelease`). It checks
  that the screen stays on storage, that 3 prices are recorded, and the −10% price offset.
- Fertile adults (lister scenario): the fake storage normalises generated `maturity` 6 to 2 (the
  generator picks any `EAnimalMaturity`, and the lister skips 6 on purpose); a separate run of 2
  with one elderly infertile animal must send 1 and report "1 elderly and no longer fertile"; the
  Adults chip clicked twice (Fertile adults) must show only maturity 1-3 and keep the bar ≤ 90 px;
  a third click (Juveniles) shows only maturity 0, a fourth turns it off.
- Sellable (lister scenario): the Sellable chip must show exactly the rows with no blocker
  (maturity not 0/4-6, not pregnant, not listed, not moving), Not sellable exactly the rest, and
  the bar stays ≤ 90 px (two rows: Juveniles lives in the Adults cycle to make room). Unit tests:
  `tests/storagefilters.test.mjs`.
- Medals in the lister scenario: the target storage row is pinned to `ratings: 'silver'`, adult
  (`window.__fake.pinned`, re-applied on selection because the debug panel randomises rows), and
  the seeded listings carry `medal`; it checks the Silver pill, a "N Silver adult …" reason and the
  By medal chips. Peek pages set `ratings` gold/silver/bronze per row.
- Medal extrapolation and appeal pricing (no listings of the animal's medal, guessed or learned
  ratios, appeal fit/ratio, min/max caps, confidence caps) are covered by
  `tests/pricing.test.mjs` only; the harness target always has 3+ same-medal listings.

## In game

- Use a `--debug-trace` build and check `dbg/trace.log` (see `debugging.md`).
- The second PC runs the game from the shared `Y:` drive, so check it the same way there.

## Kin tests

- `node --test tests/kin.test.mjs`: the kin engine (relations, kinship coefficients, the game's own
  inbreeding rule, severities, offspring gene prediction, alerts diff, clusters, a big-zoo timing).
- `tests/lua/test_pz2qol.lua` section 10: the Lua collector against a mocked park (habitats,
  lineage, absent ancestors, exhibits, chunking, frame hook, actions, hub storage).
- Harness: every `tests/uiharness/kin_*.mjs` (except `kin_fixture.mjs`) exports
  `{ hud?(page, ctx), frontend?(page, ctx) }` and is run after the built-in scenarios.
  `kin_fixture.mjs` plants related families on the dummy zoo rows and applies a snapshot.
- `run.mjs --kin-only` skips the non-Kin scenarios; `--out <dir>` keeps parallel runs from
  overwriting each other's `report.json` and screenshots. Scenario facts are kept even when a
  scenario throws (`ctx.facts`).
- `node --test tests/kinbonds.test.mjs`: pair bonds ("Bonded elsewhere"). It covers:
  - every case of the hold rule;
  - a golden check that no bond data, the switch off, or `bondsOk: false` give exactly the old
    model;
  - board simulation (a moved mate gives a new risk, and fixes never break a bond);
  - the alerts ("Bond ended", none on a failed pass or a switch change);
  - the zoo-list filters.

  The Lua side is in `test_pz2qol.lua` section 10 ("pair bonds", in a `do … end` block: the
  main chunk is at Lua's 200-local limit). The harness scenario `kin_bonds.mjs` checks the
  matrix, the pair card, the legend and the switch, then restores the fixture.
- Pitfall (2026-10-16): `kin_mates.mjs` reads `keys.mothers[4]`, but the dummy Compare Mates data
  can have only 4 mother rows, so it fails with "reading 'key'" whatever the mod code does.
- `node --test tests/kinplanner.test.mjs`: the Kin planner's pure helpers (`kinplannercore.js`:
  sidebar order, overview groups, matrix squares, mate sections, open options and selection repair).
- `kin_planner.mjs` (harness): overview, matrix, a risk square, the mate list, one-click actions
  (exactly one event per click), Locate/heat map shrinking, settings, open options, empty states,
  Esc. Its layout check clips every element by its `overflow: hidden` ancestors and requires the
  result inside 1920×1080, no overlap between header items or columns, no text wider than its
  button, and matrix headers aligned with the squares.
- Pitfall: Playwright's `click()` scrolls `overflow: hidden` ancestors to bring the target into view.
  Synced header strips must follow the native `scroll` event, or they drift.
- `kin_board.mjs` (harness): the Species board. It extends the fixture (a second lion habitat, an
  empty suitable one, an unsuitable one, the trade centre, a lion in transit, a shared species,
  `mode`, `lt`) and fakes Lua in the page: `PZ2QoL_KinDestinations` → `…Result`, and
  `PZ2QoL_KinMove` → `…Result`, then a snapshot with the animal `moving` (one id is refused).
  It checks rail order, columns, hover relatives, drag-to-plan with its effect, a refused drop,
  select + "Move N here", Suggest fixes (0 risks left), the Franchise block and its switch, a run
  that sends one move at a time ≥1.5 s apart, in order, and stops at the refusal, Move now from a
  card menu, layout (including content spilling out of visible-overflow boxes), and Esc.
- Pitfall: `page.waitForFunction(async () => …)` returns a Promise, which counts as true at once.
  Use a synchronous predicate (expose the module on `window` first).
- Pitfall: the planner and the board share kit classes (`.PZ2QoL_kpMainTitle`…) and a closed panel
  stays in the DOM, so scope selectors to the panel root (`.PZ2QoL_kp …`, `.PZ2QoL_kb …`).
- `probe_imports.mjs` imports every file in `js/mods/pz2qol/` and fails on any error.
- In the detached harness the info panel is laid out partly off-screen; check info-panel
  injections through the DOM, not only screenshots.
- Pitfall: fake Lua handlers (`engine.on('PZ2QoL_KinDestinations', …)`) registered by one scenario stay on
  the shared HUD page, and `kinmoves.js` takes the first answer. Gate fakes with an `active` flag
  and switch it off at the end, or reset `engine.events[name] = []` before installing your own
  (`kin_programme.mjs`). `kin_programme.mjs` checks the breeding programme: preview numbers
  (related pairs → 0), the moves slider (3/4/5/7 moves), Use this plan, Execute, the no-answer
  warning. Since 2026-10-17 the optimiser runs in slices (`planProgrammeAsync`): wait for
  `.PZ2QoL_kbProg:not(.busy) .PZ2QoL_kbStats` after every click; it also checks the **Make-up**
  arrows (auto 1:* → 1:1 → auto, the `kinRatio` player-store entry set and removed, the same moves
  back on auto) and the per-habitat `Make-up N ♂ N ♀` lines.
- `node --test tests/kinprogramme.test.mjs`: the optimiser. Besides the scenarios (harem, 1:3 fill
  from the trade centre and from surplus, extra males, a new group from the trade centre) it checks
  `maxWeightPairs` against brute force (300 random matrices), the exhaustive answer against every
  layout scored from scratch with `scoreLayout`, the search alone (`exactLimit: 0`) against the
  exhaustive optimum on 160 random small zoos, determinism, and `planProgrammeAsync` (same plan,
  progress, cancel). ~7 s.
- The Market lister is on by default in game since 2026-10-16. Its panel covers the storage list,
  so `run.mjs` starts every page with `PZ2QoL.listerEnabled = 'false'` (init script) and the
  lister scenario turns it on. Without that, the market, kin storage, mates, storagesend and HUD
  scenarios time out.
- `kin_launcher.mjs` (harness): the park launcher above `.ToolsBar_root` (placed and aligned, clear
  of the alert column, autosave badge, autosave card sends `PZ2QoL_AutosaveSet` and
  `PZ2QoL_AutosaveNow`, Esc closes it, one click opens the Species board and a second closes it,
  hidden with the tools column). It closes management first (`Management_SetManagementIndex(0)`,
  None).
- `tests/autosave.test.mjs`: autosave summary and countdown helpers. Lua test sections 13–15:
  ModeHelper sweep and the Move guard, SaveTrace, Autosave clock.
- `kin_board.mjs` checks the board's `Pause between moves` slider and that a refused move is
  skipped while the run carries on; the lister scenario in `run.mjs` checks the
  `Pause between listings` slider, and that "fatal" and unnamed server errors skip the animal.
- Market desk (2026-10-17): `node --test tests/listercore.test.mjs` (blocks, filters, counts, the
  engine's job text, result tallies, retry list); Lua `tests/lua/test_lister.lua` (the listing
  engine against a mocked `api.planetHub`, DataStore and franchise); harness `desk_market.mjs`
  (frontend: a fake Lua engine in the page; the desk from the price panel's button (or the panel registry when the lister is off), GUID-keyed rows, the
  job text, progress, a refusal and Retry, Stop, the fallback pill, no `AnimalStorage_AddToMarket`
  while the engine answers). `run.mjs` loads `desk_*.mjs` like `kin_*.mjs`, and `--only <part of
  the name>` (with `--kin-only`) runs just those scenarios. The name is the file name without
  `kin_` and `.mjs` (`--only board` runs kin_board and kin_board_crowded); a name that matches
  nothing runs nothing and still prints OK. The Species board keeps its sideways scroll between
  scenarios: one that scrolls the strip must scroll it back (kin_board 8b). Harness pitfall: storage row keys come
  from a `DataStoreCollection` (`_source`), not `Object.keys(DS.getValue(list))`.
- "Find a habitat": `node --test tests/storagesend.test.mjs` (`storagesendcore.js`: ranking, skip
  reasons, the one-at-a-time run with fake game and clock: pauses, 8 s after a refusal online, busy
  wait, Stop); Lua `tests/lua/test_storagesend.lua` (same `lua.exe` command; arm/take/disarm/expiry/
  Franchise consent, facts JSON, one Kin move); harness `kin_storagesend.mjs` (frontend: the button
  under Send to Zoo, Franchise switch, arm then exactly one game Send to Zoo; HUD: fake Lua, a 5-animal
  run, Stop, Franchise block). The dummy hub data reads as Franchise: set
  `window.__PZ2QOL_TEST_FRANCHISE` explicitly. Localised strings (`stringLiteral`) show raw in the harness.
- `kin_cull.mjs` (harness): Thin out on 5 lemur habitats × 12 animals (polygyny, social max 8). Checks the
  preview counts, that the too-old and extra males leave and the best male stays, that the fill level
  changes the count (Core only > Strict > Lean > Balanced > Full), click-to-toggle keep/leave, a 0%
  fertility gene leaving a habitat with room (and its switch, `[data-opt="zeroFertility"]`), the
  poor-gene levels (`[data-genes]`), the "too old" switch (`[data-opt="oldAlways"]`), and that
  "Send N" plus Execute sends `trade:<id>` moves one at a time. Fixture pitfall: gene strings built
  by rotating one strand give identical strands (0% fertility) for half the animals; the fixture
  varies k loci instead. Unit tests: `tests/kincull.test.mjs`.
