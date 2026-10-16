# Testing

Run all of these before installing a build.

| Test | Command | Covers |
|---|---|---|
| Unit (JS logic) | `node --test tests/scores.test.mjs tests/pricing.test.mjs tests/zoo.test.mjs` | Gene and breeder scores, storage and zoo filters, pricing |
| Lua behaviour | `<cobra-tools>/modules/formats/utils/luadec/lua.exe tests/lua/test_pz2qol.lua mods/PZ2QoL/Main/` | Require hook, view redirects (FrontEnd, HUD), error receiver, overlay unload order, against a mock `api` |
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
- Medals in the lister scenario: the target storage row is pinned to `ratings: 'silver'`, adult
  (`window.__fake.pinned`, re-applied on selection because the debug panel randomises rows), and
  the seeded listings carry `medal`; it checks the Silver pill, a "N Silver adult …" reason and the
  By medal chips. Peek pages set `ratings` gold/silver/bronze per row.

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
  warning.
- `kin_cull.mjs` (harness): Thin out on 5 lemur habitats × 12 animals (polygyny, social max 8). Checks the
  preview counts, that the too-old and extra males leave and the best male stays, that the fill level
  changes the count, click-to-toggle keep/leave, the "too old from habitats with room" switch, and that
  "Send N" plus Execute sends `trade:<id>` moves one at a time.
