# Skill changelog

One line per update: date, what changed, why.

- 2026-10-14: Created from the PZ2QoL work (v1.0–1.2): formats, entry point, overlay and view
  redirects, Gameface CSS rules, data contexts and events, trace DLLs with repeating `mark`, crash
  dump analysis, tests. Listing duration is now the game maximum (12 h).
- 2026-10-14: The JS→Lua listener must be registered in the ready callback. Added server error
  marks, lister stall notes, 0-byte dumps, and the `CLAUDE.md` rule that keeps this skill updated.
- 2026-10-14: Documented the "on the market" test (`auctionTimerSeconds > 0`, default -1), used by
  the storage "Not listed" filter.
- 2026-10-15: Market/history row ids are screen slots (Nexus bug #1151539); price book now keyed by
  content. JS→Lua trace listener confirmed working in game. Note on concurrent agents and builds.
- 2026-10-15: `SetAnimalMarketScreen` only exists in the Coherent debug player. That was the
  root cause of the in-game "Check market prices" failure. Documented the native market data
  manager (`MarketUI*`, display slot) and the new background check (MarketPeek, storage-mode
  patch), plus the harness `isCoherentPlayer` pitfall.
- 2026-10-15: Overlay unload in `OnPrepareToShutdown` confirmed in game (clean exit, no dump).
- 2026-10-15: Background market check proven in game (storage stays on screen). Added the
  market paging facts (`pageIndex`/`pages`, `MarketUISetPage`).
- 2026-10-15: Market check now pages (`MarketUISetPage`, up to 20) and runs for several species in
  sequence. Noted the content-based page-change check; both still offline.
- 2026-10-15: Market paging proven in game (6 pages, about 0.55 s each).
- 2026-10-15: Pitfall: Lua→JS answers arrive late, so a stale answer can be taken for the next request (multi-species check bug).
- 2026-10-15: Root cause of the lister stalls: server errors only reached the HUD view. Timeouts now skip; numbers can be traced.
- 2026-10-15: Storage list keys are positions (rebuilt on sales): runs must track animals by id + fingerprint. Server code 255 / request 42 seen.
- 2026-10-15: New animals-and-breeding.md: the game's inbreeding rule is a Lua parent-ID check (parent/child, shared parent only), with no native kinship call; lineage, habitat and UI keys for a kin feature.
- 2026-10-15: Crash cause: server code 5 on request 42 (listing) makes the game hit its own 0xFDEAD, 2 of 2. Request 28 code 5 is harmless background noise. Automation must stop at unnamed codes, pause after every request, and check IsDatabaseOperationInProgress.
- 2026-10-15: Kin implemented: Preact 8 fork facts and VNode injection (ui-gameface), HeatMapManager.Advance as park frame hook and chunked JSON (lua-runtime), Kin events (game-data-and-events), bulk animal data, contraception, locate and the gene model (animals-and-breeding), Kin tests and harness flags (testing).
- 2026-10-15: Kin planner: the game UI never scrolls natively (ScrollPane pattern), frozen matrix headers via synced overflow:hidden strips, harness icons are blank, Playwright clicks scroll overflow:hidden boxes (ui-gameface, testing).
- 2026-10-15: DatabaseError names resolve via the storage mode's tWorldAPIs.franchise (not api.world.GetWorldAPIs() in the message receiver). Request 42 refused with Unknown and NotAllowed, no crash.
- 2026-10-15: Species board: the game's move sequence and valid-destination checks, location types, busy-animal checks, game mode in a park (animals-and-breeding); board events (game-data-and-events).
- 2026-10-15: Species board: shared panel kit (kinpanel.js), pointer drag rules (preventDefault, user-select, click suppression), kin_board harness scenario and two harness pitfalls (async waitForFunction, shared kit selectors) (ui-gameface, testing).
- 2026-10-15: Pitfall: installs over the Y: network share can be incomplete; verify by hash.
