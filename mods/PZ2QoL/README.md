# Genes & Gold for Planet Zoo 2 (version 1.3.0)

*Breeding and market tools for Planet Zoo 2, formerly PZ2QoL. Installs as `Win64\ovldata\PZ2QoL`.*

Quality-of-life additions for the hub's **Animal Market** (trading) and **Animal Storage** screens, in
Franchise, Sandbox and Career. The mod also **shows errors** that the game normally drops, so a menu
that would spin forever tells you what went wrong.

The mod never changes what is sent to Frontier's servers. Market presets drive the game's own filter
menu; everything else is display only.

## Features

**Score badges** on every market and storage row:
- `G`: **gene score**, the average of size, longevity, fertility and immunity (0–100). Exhibit
  animals use longevity and fertility only; shoals have none.
- `B`: **breeder score**: fertility 40%, longevity 30%, immunity 30%.
- `V` (market only): **value**, gene score per 1,000 cash or per 100 CC. ★ marks the best value on
  the page.
- Colour by gene score: green ≥ 80, blue ≥ 60, amber ≥ 40, red below.

**Market quick filters.** These use the game's own filters, so they cover every page:
- Top genes, Breeders, Long-lived, Ending ≤1h, Cash, CC, Reset.
- **Dim < N** fades listings on the current page below a gene score.

**Storage filters.** Client side; storage isn't paged, so they cover everything:
- Pregnant, Alpha, Adults, Juveniles.
- **Not listed**: hides animals already listed on the market. They also stop counting for
  Has pair and Surplus.
- **Has pair**: species with at least one breeding-age male and female.
- **Surplus (keep N)**: everything beyond your best N per species and sex. These are trade or
  release candidates.
- **Gene ≥ N** and **Sort** by gene or breeder score.
- A summary line: counts, sexes, pregnant, species, breeding pairs, average gene score.
- Safety: changing a filter clears the selection, and "select all" only selects the rows you can
  see, so a bulk trade or release never includes hidden animals.

**Error banner** at the top of the screen. It shows:
- **Franchise server errors**, with names and hints, e.g. "Server error: NotEnoughCC: Not enough
  Conservation Credits". The game only reacts to "server unreachable"; the market and storage
  screens drop every other error, which is what leaves a spinner going forever.
- Lua script errors and errors reported by game code.
- UI script errors and failed UI requests.
- **Stuck spinners**: anything still loading after 20 s, with the last server error if there was one.

Click **Details** for the last 50 entries.

**Market lister** (Franchise only; **off by default**; turn it on with the **Lister** chip in the
storage toolbar):
- **Price book.** The mod remembers every Conservation Credits listing you have seen on the Market,
  and every row in your Trade History. It records species, sex, age group, gene score, genetics medal and price.
  It only reads what is already on screen and never requests data. Entries expire after 12 hours.
  Each listing is identified by what it shows (species, name, sex, age, genes, price), because the
  game reuses the same row ids on every market page. 1.2.1 starts a fresh book for this reason.
- **Advisor panel** for the selected storage animal:
  - current market prices **by sex**, plus juveniles and your own trades (count, median, range,
    median gene score);
  - the five closest listings by gene score;
  - a **recommended price**.
- **How the price is worked out:**
  - It uses comparable listings in order of preference: same sex and age group, then same sex, then
    any sex. CC listings only.
  - The **genetics medal** (Gold, Silver, Bronze or Unranked: the game's Rating column) comes
    first: listings with the same medal, sex and age group, then the next medal up or down scaled
    by the price ratio seen between those medals, and only then the gene-score fit below; the
    panel names the medal it used and shows the species' prices by medal.
  - Price is fitted against gene score with a fit that a few odd listings can't skew, then set 3%
    below the fit so it sells.
  - It's blended with the game's own suggested price when there are fewer than 6 comparables.
  - Your **price offset** is applied next (see below).
  - It's rounded and clamped to the game's min/max.
  - Confidence is shown: high, medium, low, or "no market data" (game price only).
- **Price vs recommended** (`−` / `+` in the lister header) is one global offset in 5% steps, from
  −50% to +50%. Go under to sell faster or over to earn more. It applies to every recommended
  price: the panel, multi-select totals, and every listing the lister makes. The panel also shows
  the price before the offset. Click the value to reset it to ±0%. The setting is remembered.
- **Check market prices** loads that species' current Market listings (Conservation Credits)
  **in the background**, so the screen stays on Animal Storage. It reads **every page** (up to the
  20 the Market shows), one page at a time with a short pause, like paging through the Market
  yourself. The prices go into the price book, and a line under the button says how many were
  found on how many pages. It sends the same request the Market tab sends when you filter it.
- **Refresh prices (N species)** appears under Sell when several animals are selected (e.g. after
  select all). One click checks the species one after another, most-selected first, each with all
  its pages, at least 3 s apart. **Stop checking** ends it after the current species. Listing is
  disabled while a check runs.
- **Sell at recommended price** lists the selected animal at the shown price, or all ticked
  animals, through the game's own path. For each animal it:
  1. selects it with the game's select event and checks the selection really is that animal;
  2. checks the game allows trading it;
  3. reads the game's price limits and default duration for it;
  4. sends `AddToMarket`;
  5. waits for the game to show it on the market.
  
  Listings go one at a time, at least 3 s apart (8 s after a server problem), and only once the
  game has no other server request running. A timeout skips the animal and carries on. The run
  stops on **Stop**, on a fatal error (shown in the banner), and on any unnamed server code
  (`code 255`, `code 5`, `Unknown`): in testing, the game crashed when the server answered a listing with
  code 5 shortly after such a refusal. Errors from the game's other background requests are
  ignored. Selected animals already on the market are left out before the run starts (the Sell
  button counts only the rest). When it finishes, the status counts the skips by reason. It never
  runs on a timer or in the background.

**Kin: inbreeding at a glance** (in parks; new in 1.3). The game only shows relatedness one
animal or one pair at a time, so in a big zoo it is hard to tell who is related to whom. Kin reads
every animal's lineage (the game's own parent records) and shows, wherever you manage animals,
which male and female in the same habitat are related and would inbreed.
- **Four colours, everywhere:**
  - **red, Inbreeding risk**: the game itself counts the pair as inbred (one is the other's parent,
    or they share a parent), both are adults and neither is on contraception;
  - **amber, Close kin**: grandparents, aunts/uncles and cousins. The game does not warn about
    these, but their young lose fertility and immunity just the same;
  - **gold, Later**: related, but one of them is still young;
  - **grey, Covered**: related, but they cannot breed: contraception, infertility, old age, or one
    of them will be too old by the time the young one grows up. The card says which.
- **Fertility over a life:** cards, the planner and the Species board say where each animal is:
  too young ("breeds in about 2 years"), not mature yet, fertile ("fertile for about 9 years
  more", or "for life" for species that never age out), its **last fertile years** (a "2y
  fertile" tag), **too old to breed**, or infertile, from the game's own age group (elderly) and
  the species' fertility ages. Too old animals are never counted as breeders; Suggest fixes counts
  a pair in its last fertile years as half a pair, Find a mate lists animals that can breed first,
  and the Breeding programme weighs each pair by how long it can still breed.
- **Zoo management, Animals list:** a DNA badge on every animal that has a relative to breed with
  in its habitat. Hover it to see who and how ("Zuri ♀, half-sister, 12.5% kinship, mates now"),
  why ("they share their mother Ama"), and the young they would have (fertility, immunity, size
  and longevity ranges from the game's own gene model). Click it for one-click actions:
  **Contraception** for one animal (the game's own toggle) and **Locate**.
- **Toolbar:** **Kin** filter (cycle: inbreeding risks only, or every related pair; combine it
  with the habitat picker), **Sort: Kin** (relatives next to each other, worst first), an
  "inbreeding risks" count, and **Planner** (Kin planner), **Board** (Species board) and **Heat**
  (the game's own breeding heat map) one click away.
- **Habitats list:** a badge per habitat with its related pairs.
- **Habitat info panel, Animals tab:** a line under each species' male/female counts
  ("2 inbreeding risks · 1 close kin") and a badge on each animal row.
- **Animal info panel:** a Kin line on the Overview card, and on the Studbook and Social lists a
  badge on each relative that lives in the same habitat and could breed with this animal.
- **Kin planner** (from the toolbar, any kin card or an alert): one screen for the whole zoo.
  - **Zoo overview:** every related pair, worst first, grouped by habitat.
  - **Habitat view:** for each species, a matrix of males × females. Each square shows the relation
    ("sister", "cousin"), the kinship % and the expected quality of their young (0–100, from the
    game's gene model), coloured by risk; current mates are marked. Click a square for the
    explanation, the expected young's genes and one-click actions; click a name for **Find a
    mate**: every possible partner in the zoo, unrelated first, best expected young first, with
    where they live.
  - **Settings:** alerts on/off, alerts for close kin too, show covered pairs, and how distant a
    relative still counts as close kin (1/8, 1/16 or 1/32 kinship). Plus Rescan and the heat map.
- **Compare Mates** (in parks and in the hub): every candidate related to the animal you picked
  gets a badge ("Half-sister"), and the offspring box says how the pair is related, including
  cousins the game does not warn about. An optional **Unrelated first** toggle groups the safe
  mates at the top.
- **Genealogy:** each relative shows where it lives now ("Savannah Habitat" / "Not in the zoo")
  and, if it shares a habitat with the animal, the pair's badge.
- **Animal Storage (hub):** stored animals related to other stored animals get a "Related N"
  badge, a **Kin** filter chip shows only those, and the info panel warns before **Send to Zoo**
  when the animals you selected include a related pair ("Tau ♂ and Zuri ♀ are full siblings —
  they would inbreed if housed together"). It never blocks or changes the send.
- **Species board** (toolbar, or **Plan moves** on any kin card): pick a species and see all
  its habitats side by side as columns of animal cards, plus the suitable habitats it isn't in
  yet, the trade centre, and animals elsewhere. Hover an animal to light up its relatives across
  the board. Drag animals (or select them and click a column) to **stage moves into a plan**: the
  plan shows its effect before anything happens ("fixes 3 inbreeding risks, creates 0"), and
  **Suggest fixes** proposes the fewest moves that clear a species' risks while keeping animals
  able to breed: it counts fertile, unrelated male–female pairs (no contraception, not infertile),
  never takes a habitat's last breeding pair, and avoids groups of only males or only females.
- **Breeding programme** (Species board, next to Suggest fixes): plans the best layout of a
  species' breeders for **genetics**: expected young (the game's gene formula) × the chance of
  conception (the game's own probability). It follows the species' mating system (harem: one
  breeding male per habitat; pairs; mixed groups), the habitats' room (the species' social maximum
  and the space the game requires), your habitat assignments and existing bonds, never puts
  relatives together, and sends animals without a place in a group to the trade centre. The
  preview shows breeding pairs, related pairs, expected young and chance of young before → after,
  and each habitat's target group; a slider trades **fewer moves** against **best genetics**.
  **Use this plan** loads it into the normal plan (Execute, one move at a time). Breeders waiting
  at the **trade centre** (bought, or sent there) are part of it: the programme brings them into a
  group where they breed best ("1 from the trade centre"); **Use the trade centre (N waiting)**
  switches that off.
- **Thin out** (Species board): for a species whose habitats are full, picks who to send to the
  trade centre (to sell, trade or release). Each habitat keeps a target number of adults (its room
  for the species x Lean 70% / Balanced 85% / Full 100%); over-full habitats give up their least
  valuable animals first: too old or infertile, extra males in a harem, those in their last
  fertile years, those living with relatives, then the weakest genes. The best fertile male and
  females of every habitat, pregnant females and the species' best genes always stay. Click any
  animal in the preview to keep it or send it; **Send N to the trade centre** puts the moves in the
  plan, and Execute runs them one at a time.
- **Habitat assignments:** in the Species board, **☆ Assign to <species>** on a habitat's column sets
  it aside for that species (per park; it lasts until you close the game, because for now the game
  gives mods no place to keep data). Suggest fixes then moves the species only into its
  assigned habitats and never puts another species there; the column also flags other species
  living in it. **Execute plan** then moves the animals through the
  game's own Move (a keeper boxes and carries each one), **one at a time**, waiting for the game to
  confirm each move and stopping at the first refusal or on **Stop**. Destinations are checked
  with the game's own rules (habitat type, reachable by keepers). In a Franchise zoo, running a
  whole plan is **off by default** (a setting turns it on); moving one animal is always one click.
  Each animal's **⋯** menu also has **Send to Trade Centre** (one move), and the trade centre is a
  column you can drag animals onto.
- **Alerts:** when a pair becomes an inbreeding risk (a youngster grows up next to its sibling, an
  animal moves in with its father, contraception is lifted) a note appears at the top of the
  screen within about 20 seconds, with **Show** and **Contraception** buttons. The game's own
  warning only comes once they have mated. On loading a park you get one summary if there are
  risks already. Alerts can be turned off (or extended to close kin) in the planner.
- **Read-only and safe:** Kin only reads. The only things it changes are the ones you click, one
  animal per click, through the same calls the game's own buttons make (contraception, camera).

## Install / uninstall

The mod is a folder in the game's data directory:

```
<Planet Zoo 2>\Win64\ovldata\PZ2QoL\
    Manifest.xml
    Main.ovl          Lua
    UI\PZ2QoLUI.ovl   UI overlay (HTML/JS/CSS)
```

- **Build:** `python tools/build_pz2qol.py --cobra-tools <cobra-tools checkout> --python <python with cobra-tools deps>`
- **Build and install:** add `--install "<Planet Zoo 2 folder>"`.
- **Update:** copy the new `Win64` folder over the old one (Replace).
- **Uninstall:** delete `Win64\ovldata\PZ2QoL`. No game files are modified, and nothing is
  written to saves or the player profile.

The game will show its standard one-time "modifications detected" notice.

## How it works

- `Database.PZ2QoLLuaDatabase` is picked up by the game's own per-content-pack hook. It wraps
  `require` so game modules are patched when they first load.
- **UI injection** uses the game's UI overlay system (the same `api.ui2.LoadOverlay` /
  `MapResources` that Content0 uses):
  1. A hidden probe page first proves the overlay serves files.
  2. The hub's FrontEnd view then loads `PZ2QoLFrontend.html`, which is the game's own
     `Frontend.js` plus `js/mods/pz2qol/main.js`.
  3. If anything fails, the vanilla page loads and server errors fall back to the game's dialog.
- **Storage filtering** patches `DataStoreCollection.source` for the storage list context only.
- **Badges** are added to row DOM after each preact update.
- **Kin** (`Main/pz2qol.kin.lua` + `js/mods/pz2qol/kin*.js`): the Lua side reads each animal's
  parents (`animals:GetParents`), habitat, sex, age, contraception, mates and alleles, a few dozen
  animals per frame, and sends a JSON snapshot to the page in chunks. The page (`kincore.js`)
  works out relations (the game's own rule plus grandparents, aunts/uncles and cousins), the
  coefficient of kinship and the expected young (the game's own gene formula). Badges are VNodes
  added to the game's own row renders, so they survive list recycling.

## Status

- **Verified offline:**
  - unit tests for scoring, filters and pricing
    (`node --test tests/scores.test.mjs tests/pricing.test.mjs`)
  - a Lua behaviour test against a mock game API (`tests/lua/test_pz2qol.lua`)
  - build round-trips both OVLs
  - the UI runs in a browser harness with the game's real UI code (`node tests/uiharness/run.mjs`;
    `tests/uiharness/probe_imports.mjs` checks every module loads)
  - The harness runs the lister end to end against a fake native layer. It checks: off by default;
    the listed price equals the shown recommendation; the game's default duration is used; the
    animal is the sole selection when listed; 7 ticked animals list at most 5; listings are at
    least 3 s apart; a server rejection on the 3rd stops the run at 2/5 with the banner shown.
- **Not yet verified in the game.** Steam is in offline mode and Denuvo needs one online launch of
  the current build. Once that's done, check in this order:
  1. the overlay loads (look for the score badges)
  2. presets filter the market
  3. storage filters
  4. the error banner, e.g. trigger NotEnoughCC by buying a CC listing you can't afford
