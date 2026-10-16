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
- `probe_imports.mjs` imports every file in `js/mods/pz2qol/` and fails on any error.
- In the detached harness the info panel is laid out partly off-screen; check info-panel
  injections through the DOM, not only screenshots.
