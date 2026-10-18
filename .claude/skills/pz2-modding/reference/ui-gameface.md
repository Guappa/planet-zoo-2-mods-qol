# UI: Coherent Gameface

## Runtime

- Coherent Gameface (cohtml) runs the game UI. It is written in **Preact** with ES modules served
  from `coui://UIGameface/...`. **proven**
- Main views:
  - `Frontend.html`: the hub (Market, Animal Storage, Franchise).
  - `HUD.html`: the in-park HUD, including zoo management. **HUD.html is also active in the hub.**
  **proven**
- The JS↔native bridge is a global `engine`:
  - `engine.trigger(name, ...args)` sends an event to Lua/native listeners **and** to JS `engine.on`
    handlers;
  - `engine.on(name, fn)` listens.
  - The game also wraps these in `/js/common/core/Engine.js` (`triggerListener`, `addListener`).
  **proven**

## Injecting mod UI

1. Ship copies of the entry pages (`PZ2QoLFrontend.html`, `PZ2QoLHUD.html`). Each loads the game's
   own bundle and then `js/mods/<mod>/main.js`. **proven**
2. Redirect the view in Lua (see `lua-runtime.md`).
3. In `main.js`, install each feature with `step(name, fn)` so one failure doesn't stop the rest.
- Wrapping `engine.trigger` lets the mod intercept UI→game events, e.g. to filter select-all.
  **proven**

## CSS rules for Gameface

- **Set `display:flex` explicitly.** Gameface's default differs from browsers, and the game sets
  `display:flex` about 2,300 times. Mod CSS sets it on all its descendants
  (`.PZ2QoL_card *` etc.). **proven**
- Not supported or avoided: CSS grid, `backdrop-filter`, `conic-gradient`. Box-shadow, transforms,
  transitions, keyframe animations and `filter` on icons all work. **proven**
- Size with `rem`, like the game does.
- The browser harness's compat CSS leaves mod elements as `block`, so a missing `display:flex`
  shows up in tests.

## DataStore and lists

- `/js/common/core/DataStore.js`: `getValue(ctx, key)` and `setValue(ctx, key, v)`. A context is
  an array path, e.g. `['hubAnimalsData','animalStorageData','list']`. **proven**
- `DataStoreCollection(ctx)` (`/js/common/data/DataStoreCollection.js`) backs lists:
  - `.source` is the array of item contexts;
  - `._source` holds the raw contexts;
  - `.dispose()` releases it.
- **Filtering a game list:** patch `DataStoreCollection.prototype.source`'s getter, scoped to one
  list context (PZ2QoL `listfilter.js` registry). Never filter globally. **proven**
- **Rows are recycled** by the game's `Repeater`. Never restyle or attach state to row roots. Put
  badges inside an inner element (`.MarketAnimalListItem_listRoot`) and refresh them after updates.
  **proven**
- **Select-all safety:** while a filter hides rows, turn the game's select-all event into "clear,
  then tick each visible row" with the per-item checkbox event. Clear the selection whenever a
  filter changes. **proven**

## Layout facts

- **In-park HUD (1.0.4/1.0.5, harness 1920×1080, 1rem = 18px × the UI scale), offline:**
  - Top-left column `.NotificationsModule_buttons` (0,20, 50 wide): Help, Zoopedia, Research,
    Timeline, Objectives, Challenges, Inspector, then the alert buttons. It grows down with alerts
    to about y≈594.
  - Bottom-left tools column `.ToolsBar_root` (`js/project/modules/HUD/Components/ToolsBar.js`,
    0,645, 50×315, `bottom: 6.667rem`, grows upward): Paths, Barriers, Terrain, Foliage, Multi-select
    and Demolish. Its background panel `.ToolsBar_background` is #3C472E with radius 0 10px 10px 0.
    Buttons are 40px round, background #fff2dd, outline 2/2/4px #c7b5a3 at opacity 0.9, 26px icon
    with the brown filter, and pink #FFC5C5 on hover (the `.hover` class, set by the game's JS).
  - The column gets `.hidden` while a management screen is open, in camera or photo mode, with the
    UI hidden, during cinematics and in explorer mode. It is only dimmed when the build browser or
    an info panel is open.
  - Management shortcuts (Zoo management, Staff, Market & Storage) are tabs in the bottom TaskBar
    row, which is centred and sized by its text, so it is a poor anchor.
  - PZ2QoL's launcher (`hudlauncher.js`, `pz2qol_hud.css`) docks above `.ToolsBar_root` in its own
    element under `<body>`, never inside the game's preact column (the game recreates it). It
    hides with the column and drops buttons when the alert column leaves no room.
- The game's icons (`/img/icons/*.svg`) are not in the unpacked UI OVL, so they don't render in
  the harness. Names the game uses: `IconAnimals`, `save`, `Icon_SaveLoad`, `IconTime`.
- `::before` / `::after` in Gameface: unproven. Mod widgets use real elements instead.

- Management Animals panel root: `.ManagementAnimals_root`. Reserve toolbar space with
  `padding-top`. **proven** in harness.
- The management screen is chosen with `Management_SetManagementIndex(sectionId)`.
  `ManagementSectionID.Animals = 7` (`js/project/data/GameTypes.js`). **offline**
- **`localStorage` is not kept across game restarts** (strong evidence): the game's own UI never
  uses it, and no storage file exists anywhere in the profile or install after using it. Treat it
  as session memory (fine for toolbar collapse state, `PZ2QoL.collapsed.<key>`). Anything the
  player expects to keep goes through the Lua file store: `js/mods/pz2qol/userstore.js`
  (`getUserData`/`updateUserData`, status `loading|file|memory`), Lua `Kin.StoreLoad/StoreSave`
  in `pz2qol.kin.lua` (events `PZ2QoL_StoreLoad` -> `PZ2QoL_StoreData` chunks,
  `PZ2QoL_StoreSave` -> `PZ2QoL_StoreSaved`). Changes made before the file is read are replayed
  on top of it, so updates must be idempotent (set on/off, not toggle).
  The Lua side keeps this data on the device in the game's player save, one entry per zoo,
  Franchise included (see lua-runtime.md "the player save"; the api.debug file calls are retail
  stubs). Status `file` means "kept on this device"; `memory` comes with a reason
  (`userDataReason()`: `wait` (zoo or player profile not known yet; a `PZ2QoL_StoreReset` follows,
  and changes made meanwhile are replayed), `noplayer`, `nopark`, `failed`, `nolua`). The Species
  board shows its "last until you close the game" notice only for reasons other than `wait`.
  `PZ2QoL_StoreReset` (Lua to JS) makes the page read the store again when a park starts or ends
  or the zoo's store becomes known. The store is the truth once read: data the page held before
  (another zoo's, the localStorage mirror) is not merged in, only this view's pending changes.

## Preact runtime: hooking game components (used by Kin)

- The game ships its **own fork of Preact 8**, not Preact 10 (`/js/common/lib/preact.js`, import by URL):
  VNodes are `{nodeName, attributes, children, key}`; no hooks, no Fragment; `options.afterUpdate`
  fires on updates only, never on mount. **offline**
- Event props go through a fixed table (`onClick`, `onMouseDown/Up/Over/Out/Enter/Leave/Move`, ...),
  attached with `addEventListener` on the element. **offline**
- A component's `id` prop becomes the DOM `id`. Children get Preact context
  `{dataStoreContext: props.context}`, so anything rendered inside a DataStore row knows its row. **offline**
- **Decorated components** (`DataStoreComponent.decorate`, `Focusable.decorate[Ex]`) wrap an
  anonymous inner class; the wrapper's `render(props)` is `h(Inner, {...props})`, so
  `W.prototype.render.call({props:{},state:{},context:{}}, {}, {}, {}).nodeName` is the inner class.
  Patch the inner class's `prototype.render` once: call the original, then append a mod VNode to a
  known child (`kinhooks.js`: `unwrap`, `patchRender`, `findVNode`, `appendVNode`). The game renders
  the mod's node itself, so it **survives row recycling**. Never push onto a VNode's `children`
  (childless VNodes share one constant array); assign a new array. **proven** in the harness (Kin
  badges on zoo, habitat-panel and Habitats rows).
- **Foreign DOM between Preact-managed siblings is removed** on the parent's next render (raw DOM
  appended after all managed children survives). Prefer VNode injection.
- A mod Preact component that subscribes to the mod's own store and calls `setState` keeps injected
  badges live (`kinhooks.js` `KinSlot`).
- Row hover can change a game row's layout (e.g. the Animals list), which moves an injected badge
  out from under the pointer; a "hide on mouseout" must check the pointer is really outside.
  **proven** in the harness.
- `DS.setValue` / `createContext` **throw in the real game** (they assert the Coherent debug player);
  they only work in the harness. Mod data must come from Lua. **offline**
- `InfoPanelModule` (HUD) shows **one** info panel at a time; its context arrives with
  `InfoPanel_SetContext` (`ctx[2]` = entity) and it opens/closes on `InfoPanel_Show` / `InfoPanel_Hide`.
  **proven** in the harness.
- The HUD heat map panel opens on the JS event `ShowHeatmap(categoryIndex, subIndex)` (what Lua's
  `HUDUI:ShowHeatmap` sends); `-1, -1` closes it. Indexes are into `categories` of
  `js/project/modules/Heatmaps/HeatmapsData.js` (`items[]`); InbreedingRisk is Animals/1.
  Don't send `Heatmaps_Select` alone. **offline**
- `.PZ2QoL_x *` "display:flex" catch-all rules have the same specificity as single-class rules, so a
  later file's catch-all overrides an earlier file's `flex-direction: column`; restate it.

## Scrolling and big mod panels

- **The game UI never scrolls natively.** Its CSS has no `overflow: auto/scroll`. `ScrollPane`
  (`js/common/components/ScrollPane.js`) keeps the content in an `overflow: hidden` box, sets
  `scrollTop`/`scrollLeft` itself, handles `wheel` (sign of `deltaY` × `scrollSpeed` em) and draws its
  own `ScrollBar`. Mod scroll areas do the same: `kinpanel.js` `makeScroll` (wheel, draggable
  thumbs, Shift+wheel sideways), shared by the Kin planner and the Species board. **offline**; works
  in the harness.
- **Big mod panels share one kit** (`kinpanel.js`): scroll areas, buttons, switches, count pills,
  `placePanel` (min(96rem, 92vw) × 84vh, centred) and a registry (`registerPanel`, `panelApi`,
  `closeOtherPanels`) so panels open each other without import cycles and only one is on screen.
  A later stylesheet's `.X *` catch-all overrides the kit's single-class rules (direction,
  `display: none` on scroll thumbs), so `pz2qol_kinboard.css` restates them with two-class selectors.
- **Pointer drag** (Species board): mousedown on the card, then document `mousemove`/`mouseup`, a
  6 px threshold, a `position: fixed; pointer-events: none` ghost, and drop targets found by
  hit-testing the columns' rects (no HTML5 drag and drop, no `elementFromPoint`). Call
  `preventDefault()` on the mousedown and set `user-select: none`: in a browser a text selection
  left by one drag makes the next mousedown start a native text drag, and no more `mousemove`
  arrives. Clear the "this click belongs to the drag" flag in a `setTimeout(0)` after mouseup, since
  no click fires when the drag ends on another element. Hold re-renders while a drag or a menu is
  open. **harness**
- **Frozen table headers** without `position: sticky`: put the column heads and row heads in their own
  `overflow: hidden` strips and copy the body's `scrollLeft`/`scrollTop` to them (the Kin planner's
  relatedness matrix). Also copy on the body's native `scroll` event: a click or focus can scroll an
  `overflow: hidden` box by itself (Playwright's click does). **harness**
- The game's icons (`/img/icons/*.svg`) are not in the unpacked UI, so harness screenshots show them
  blank. Check icon names by grepping the game's JS (`Icon_Close`, `Icon_Heart`, `Icon_Heatmap`,
  `IconSettings`, `Icon_CircleWithArrows`, `IconExhibit` exist). Never let a layout depend on an icon:
  draw small marks (close cross, check mark, chevron, selection ring) with CSS borders.
- Pseudo-elements (`::after`) and inset `box-shadow` are unconfirmed in Gameface; the mod uses real
  child elements with borders for anything that must show. **guess**
- `title` tooltips are probably not drawn by Gameface; put what matters in visible text or an
  expandable row. **guess**
