# Mike's QoL Toolbox for Planet Zoo 2 (version 2.1.0)

*Breeding, market, storage and park quality-of-life tools for Planet Zoo 2, formerly Genes & Gold
(and PZ2QoL before that). Installs as `Win64\ovldata\PZ2QoL`.*

**In short:** gene and breeder scores on every animal; quick filters for the Market, Animal
Storage and your zoo's Animals list; Kin, which shows inbreeding risks and close kin on every
animal screen with alerts, a planner and a Species board that plans and runs moves (Suggest
fixes, Breeding programme, Thin out, habitat assignments); a market price advisor and one-click
lister; Find a habitat for animals sent from storage; a more reliable autosave; and an error
banner for the server errors the game hides. Works in Franchise, Sandbox and Career.

What's in the toolbox:

| Area | Tools |
|---|---|
| **Scores** | Gene, breeder and value badges on every Market and Storage row |
| **Market** | Quick filters (Top genes, Breeders, Long-lived, Ending ≤1h, Cash, CC), Dim below a gene score |
| **Animal Storage** | Filters (Pregnant, Alpha, Adults / Fertile adults / Juveniles, Sellable, Not listed, Has pair, Surplus, Gene ≥, Kin), lister on/off, sort by score, summary line, Find a habitat |
| **Zoo Animals list** | Filter bar (habitat, sex, age, pregnant, alpha, contraception, unhappy, gene and fertility minimums, Kin) and sort by gene, breeder or welfare |
| **Kin (inbreeding)** | Risk badges in every animal screen, alerts, Kin planner, Find a mate, Compare Mates and Genealogy additions, fertility over a life |
| **Species board** | Plan moves by drag and drop, Suggest fixes, Breeding programme, Thin out, habitat assignments, Execute plan one move at a time |
| **Market lister** | Price book, price advisor with recommended prices, background price checks, Sell at recommended price, Market desk (list many at once) |
| **Park tools** | Launcher buttons on the tools column, reliable Autosave with Save now, pause sliders for automated runs |
| **Safety net** | Error banner for silent server and script errors, stuck-spinner watchdog, crash guard for the game's Move screen |

The mod never changes what is sent to Frontier's servers. Everything it does in Franchise goes
through the game's own buttons and events, starts only from your click, and runs one action at a
time.

## Changelog

### Unreleased

- **Species board: the trade centre is pinned on the right.** It no longer scrolls away with the
  habitats: its animals are always in view, so you can drag them into any habitat (or a habitat's
  animals into it) and see at once who is related to whom. The board is a little wider so the
  habitats keep their room.
- **Market desk** (a button in the Market lister panel's header): list many animals at once. Pick a
  species, filter, tick what to sell (or Tick all shown), check the prices, and press **List**.
  Filters: sex, age stages, fertility, rating, a **gene range** (e.g. 0-50 to sell the weakest and
  keep the rest), and under **More filters**: what "genes" means (average, breeding score or one
  gene), a range per gene, **keep the best N males and N females** of each species (shows the
  rest), pregnant, the storage tag, Kin, price and name. Sort by genes (best or worst first),
  price or name. Tick all leaves animals tagged Keep alone. It shows every animal's state (sellable, on the market with time left, or why
  not) and each result as it happens, with Stop and Retry.
- **Fixed: every listing skipped with "the game didn't select it".** The engine now reads the
  selection the way the game draws it (each row's own flag).
- **Listing no longer works the storage screen.** The mod now lists through the game's own listing
  call, finding each animal by its id inside Animal Storage, so the storage list refreshing while
  many animals are on the market can't make it lose or mix up animals. Still one animal at a time,
  each confirmed by the game, with your pause between listings. (Older game-side files fall back to
  the old way automatically.)
- **Breeding programme: group make-up.** Each species is planned with its make-up: pairs (1 ♂ :
  1 ♀), one male with several females (1:2 to 1:5), a harem (one male with any number), the
  reverse, or mixed groups. It comes from the game (the species' social groups and mating
  system); the **Make-up** arrows in the programme let you choose your own per species (kept for
  this zoo). Habitats are filled towards it from the trade centre and from other habitats' surplus,
  extra males (or females) move on, and a male and a female can be brought together to start a
  new group in an empty habitat. Each habitat card shows its target ("Make-up 2 ♂ 6 ♀ · 1 open").
  Thin out follows the same make-up, so it no longer sends away a second male a 1:3 group needs.
- **Breeding programme: a real optimiser.** The best pairs inside a habitat are now worked out
  exactly, and the search places a whole sex at once around the other, tries many group
  layouts, and checks every layout outright for small species. It runs in the background with a
  progress bar, so the game never stalls, and the same zoo always gives the same plan.

### 2.1.0

- **Habitat assignments are kept in every zoo, Franchise included.** They are stored on this PC
  in the game's player profile (Steam Cloud carries it to your other PCs), one set per zoo, and
  nothing is added to online or park saves. Assignments from Sandbox/Career park saves move over
  once.
- **Shoals and colonies** (fish shoals, insect and other colony species) are left out of Kin: no
  more inbreeding warnings for them.

### 2.0.0

- **Franchise first.** The Species board's plans and Find a habitat now work in Franchise zoos
  with no extra switch: your click is the opt-in. The Market lister is on by default. Runs
  (listings, plans, placements) skip a step that fails and carry on; only **Stop** ends them.
  Everything still goes one action at a time, each confirmed by the game.
- **Park launcher:** two round buttons on top of the game's tools column (bottom left): the
  Species board in one click, and Autosave.
- **More reliable Autosave:** the game restarts its 10-minute autosave timer after every trip to
  the hub, so players who go back and forth often got none. The mod keeps its own clock of park
  time that survives hub trips and asks the game for its normal autosave: Off (game default) /
  2 / 3 / 5 / 10 minutes, plus **Save now**. The setting resets each time the game starts.
- **Pause sliders:** pause between listings (1–10 s) and between moves (1–10 s).
- **Fertile adults** storage filter (the Adults chip cycles to it): hides infertile animals such
  as elderly ones past breeding age. The lister skips infertile elderly animals, which the market
  refuses.
- **Smarter prices:** Gold and Silver animals are priced against listings of their own medal;
  when none is listed, the price is extrapolated from the other medals. Appeal is taken into
  account within a medal.
- **Find a habitat** (Animal Storage): sends the selected animals to the zoo and places each one
  in a habitat that suits it, one at a time, instead of one destination for all.
- **Trade centre animals** now appear on the Species board and in the Breeding programme.
- **Habitat assignments** are kept in Sandbox/Career park saves (in Franchise, until the game
  closes; see 2.1.0).
- **Crash guard:** the game's own Move screen could crash when its selected animal had gone
  (stale selection); the mod now catches that and the game shows "Move failed" instead.

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
- Pregnant, Alpha.
- **Adults** (click to cycle): all adults, then fertile adults only, then juveniles only, then off.
- **Sellable** (click to cycle): animals the market would take, then the ones it won't, then off.
  Not sellable means juvenile, infertile (including elderly past breeding age), pregnant, already
  listed or being moved. The chip's tooltip counts each reason. The game still checks every animal
  when you list it, so a rare case (e.g. an animal the game marks "can't be sold") can still be
  refused.
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

**Market lister** (Franchise only; **on by default**; turn it off with the **Lister** chip in the
storage toolbar; listing only starts when you click **Sell**):
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
  animals, through the game's own listing call (the same one its Trade → Confirm makes). The mod's
  game-side engine does it inside Animal Storage, one animal at a time. For each animal it:
  1. waits until the game has no other server request running;
  2. finds the animal by its id (so the storage list refreshing can't swap it for another);
  3. selects it and waits for the game to say it can be traded and to give its price limits;
  4. checks once more that the row is still that animal, then lists it at the recommended price
     (inside the game's limits; the game's own price when there is no market data) for the longest
     duration the game allows;
  5. waits for the game to show it on the market.

  Then it pauses (your pace, 3 s by default; the same after a server problem) before the next. A
  refused or timed-out animal is skipped and the run carries on; only **Stop** ends it. Errors from
  the game's other background requests are ignored. When it finishes, the panel counts what was
  listed and why the rest was not. It never runs on a timer or in the background. With older
  game-side files the old way runs instead (selecting each row and pressing the game's buttons).
- **Market desk** (a button in the Market lister panel's header): the same listing for many animals at once,
  in its own window over Animal Storage. Species on the left with how many can be sold; the
  species' animals in the middle with their recommended price and state (sellable, on the market
  with time left, juvenile, being moved...), filters (sex, age, fertility, rating, a gene range;
  More filters: per-gene ranges, keep the best N per sex, pregnant, storage tag, Kin, price, name),
  **Tick all shown** (never the animals tagged Keep);
  on the right the run: how many, the total asked, duration (longest or the game's default), the
  price offset and pause, **List N animals**, progress, Stop, and **Retry** for the ones that did not
  go through.

**Zoo management, Animals list** (in parks): a filter bar over the game's Animals panel.
- **Habitat** picker, **sex** and **age** (segmented), **Pregnant**, **Alpha**, **Contra**
  (on contraception), **Unhappy** (low welfare).
- **Gene ≥ N** and **Fertility ≥ N** minimums.
- **Sort** by gene score, breeder score or welfare.
- **Kin** filter and the **Planner**, **Board** and **Heat** buttons (see Kin below), and **Clear**.
- Select all only selects the animals you can see.

**Find a habitat** (Animal Storage): a button under the game's own **Send to Zoo**. One click sends
the selection to the zoo with the game's Send to Zoo, then, back in the park, places each animal
in a habitat that suits it (the game's own habitat rules, reachable by keepers), one move at a
time, instead of the game's single destination for all of them. Works with select all and the
storage filters, Franchise included.

**Park launcher:** two round buttons on top of the game's tools column (bottom left, above Paths,
Barriers, Terrain): the **Species board** in one click, and **Autosave**, which shows when the next
save is due.

**Autosave:** the game restarts its 10-minute autosave timer after every trip to the hub, so
players who go back and forth often get none. The mod keeps its own clock of park time that
survives hub trips and asks the game for its normal autosave: Off (game default) / 2 / 3 / 5 /
10 minutes, plus **Save now**. The setting resets each time the game starts.

**Pause sliders:** the pause between Market lister listings and between Species board moves,
1–10 s each. Every step still waits for the game to confirm it.

**Crash guard:** the game's own Move screen could crash when the animal it had selected was gone
(a stale selection); the mod catches that and the game shows "Move failed" instead.

**Kin: inbreeding at a glance** (in parks; new in 1.3). The game only shows relatedness one
animal or one pair at a time, so in a big zoo it is hard to tell who is related to whom. Kin reads
every animal's lineage (the game's own parent records) and shows, wherever you manage animals,
which male and female in the same habitat are related and would inbreed. Collective species
(shoals of fish, butterfly and other colonies) breed as one group and are left out.
- **Five colours, everywhere:**
  - **red, Inbreeding risk**: the game itself counts the pair as inbred (one is the other's parent,
    or they share a parent), both are adults and neither is on contraception;
  - **amber, Close kin**: grandparents, aunts/uncles and cousins. The game does not warn about
    these, but their young lose fertility and immunity just the same;
  - **gold, Later**: related, but one of them is still young;
  - **blue, Bonded elsewhere**: related, but the game will not let them breed because one of them
    is bonded to another mate (monogamous species, such as flamingos). This is the game's own
    rule, the same lock its Compare Mates screen shows. The card names the mate. If the bond ends
    (the mate dies, moves or leaves), the pair becomes a risk again and you get an alert. It also
    works for species added later, because Kin asks the game rather than using a species list;
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
  - **Settings:** alerts on/off, alerts for close kin too, show covered pairs, **pair bonds count
    as protection** (on by default; off shows every bonded related pair as a risk, as before), and
    how distant a relative still counts as close kin (1/8, 1/16 or 1/32 kinship). Plus Rescan and
    the heat map.
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
  conception (the game's own probability). It follows the species' **group make-up** (pairs; one
  male with 2 to 5 females; a harem: one breeding male per habitat; the reverse; mixed groups),
  taken from the game's social groups and mating system, or your own choice with the **Make-up**
  arrows (kept per species for this zoo). It fills each habitat towards that make-up from the trade
  centre and from other habitats' surplus, moves extra males or females on, can start a new group
  (a male and a female together) in an empty habitat, and respects the habitats' room (the
  species' social maximum and the space the game requires), your habitat assignments and existing
  bonds. It never puts relatives together, and sends animals without a place in a group to the
  trade centre. The optimiser pairs animals exactly within each habitat, checks every layout for
  small species, and runs a guided search (with a progress bar, in the background) for big ones;
  the same zoo always gives the same plan. The preview shows breeding pairs, related pairs,
  expected young and chance of young before → after, and each habitat's target group ("Make-up
  2 ♂ 6 ♀ · 1 open"); a slider trades **fewer moves** against **best genetics**.
  **Use this plan** loads it into the normal plan (Execute, one move at a time). Breeders waiting
  at the **trade centre** (bought, or sent there) are part of it: the programme brings them into a
  group where they breed best ("1 from the trade centre"); **Use the trade centre (N waiting)**
  switches that off.
- **Thin out** (Species board): picks who to send to the trade centre (to sell, trade or release).
  Each habitat keeps a target number of adults (its room for the species x **Core only** (just the
  breeding core: 1 male, 2 females) / Strict 55% / Lean 70% / Balanced 85% / Full 100%); over-full
  habitats give up their least valuable animals first: too old or infertile, males beyond the
  group make-up (a harem keeps one; 1:3 keeps one per three females), those in their last fertile
  years, those living with relatives, then the weakest genes.
  The best fertile male and females of every habitat, pregnant females and the species' best genes
  stay.
  To clear poor genes out of the gene pool, these go from **every** habitat, full or not, and the
  breeding core does not protect them:
  - **0% fertility genes** (on by default): any animal with a 0% fertility gene.
  - **Poor genes**: Off / **Weakest** (gene score under 35, or 0% immunity) / **Below average**
    (below the species average) / **Best only** (only the best quarter of each sex stays). A
    habitat can lose its only male this way; the Breeding programme can bring a better one in.
  - **Too old or infertile**: also from habitats with room. **Young too**: the gene rules also
    pick young animals.
  Only pregnant females, animals on the move, those you keep and, if every breeder of a sex has
  poor genes, the best of them stay. Your choices are remembered until you close the game. Click
  any animal in the preview to keep it or send it; **Send N to the trade centre** puts the moves in
  the plan, and Execute runs them one at a time.
- **Recompute** (in the Breeding programme and Thin out): both follow the animals as they change
  (the board re-reads them every few seconds), but the game's room, group sizes and fertile ages
  are asked once, when you open them. Recompute asks again and works the preview out afresh; your
  choices in it stay. On the board itself, **Rescan** does the same.
- **Habitat assignments:** in the Species board, **☆ Assign to <species>** on a habitat's column sets
  it aside for that species. Assignments are kept on this PC in the game's player profile (Steam
  Cloud carries it to your other PCs), one set per zoo, Franchise zoos included, so they come back
  when you open the zoo again. Nothing is added to online saves. Sandbox and Career parks are known
  by their name: renaming one starts its assignments afresh. Each assignment is found again by its
  habitat's name and the animals living there (the game numbers its habitats afresh every time a
  zoo loads), so rename a habitat while the zoo is open and its assignment follows; a habitat that
  is gone drops its assignment after a few loads. Suggest fixes then moves the species only into its
  assigned habitats and never puts another species there; the column also flags other species
  living in it. **Execute plan** then moves the animals through the
  game's own Move (a keeper boxes and carries each one), **one at a time**, waiting for the game to
  confirm each move; a move the game refuses is skipped and the run carries on until it is done or
  you press **Stop**. Destinations are checked with the game's own rules (habitat type, reachable
  by keepers). Plans run the same way in Franchise zoos: the **Execute** click is the opt-in.
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
- **Uninstall:** delete `Win64\ovldata\PZ2QoL`. No game files are modified. The only thing the
  mod writes is its own small `PZ2QoL` entry in your player profile (`Saves\player`: habitat
  assignments, at most 64 KB); the game keeps but never reads it. No mod data goes into
  park or online saves.

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
  - The harness runs the lister end to end against a fake native layer. It checks: on by default in game (the harness starts it off);
    the listed price equals the shown recommendation; the game's default duration is used; the
    animal is the sole selection when listed; 7 ticked animals list at most 5; listings are at
    least 3 s apart; a server rejection on the 3rd stops the run at 2/5 with the banner shown.
- **Not yet verified in the game.** Steam is in offline mode and Denuvo needs one online launch of
  the current build. Once that's done, check in this order:
  1. the overlay loads (look for the score badges)
  2. presets filter the market
  3. storage filters
  4. the error banner, e.g. trigger NotEnoughCC by buying a CC listing you can't afford
