// The Market desk's second view, My listings (docs/DESIGN-reprice.md): the
// player's own live listings, how stale each one is and why, and a reprice
// workflow (the game has no "change price": take off, then list again).
//
//   left    species with listings: how many, how many stale
//   middle  the listings, most stale first: asking price, fair price, place
//           in line among comparable listings, time on the market, the
//           staleness score and verdict, the new price; filters by verdict,
//           expiring, sort; a row opens its working (a price ladder of the
//           comparables, every number behind the score) and a price editor
//   right   the reprice: the price rule for the ticked listings (Suggested,
//           Fair, Match cheapest, Undercut X%, Cut mine X%, a floor), the
//           preview (old → new totals, how many lower / higher / still above
//           the cheapest), duration, pace, Reprice N → a confirmation sheet;
//           the run card (take off → settle → list again), Stop, and what is
//           left off the market with one click to list it again
//
// Rendering follows the desk (marketdesk.js calls renderListings when this
// view is on): the desk's rows (deskRows) are the source, keyed by GUID.
import {
    ACTIONS, filterListings, listingRows, LISTING_SORTS, normalizeStrategy, planReprice, quickPreview, repriceSeconds, runCounts, runSummary, sortListings, spanText, strandedItems,
    STRATEGIES, VERDICT_ORDER, VERDICTS, verdictCounts,
} from '/js/mods/pz2qol/repricecore.js';
import { dismissReprice, getLedger, getReprice, quickLeft, reconcileListed, relistLeft, repriceActive, setLeftPrice, startReprice, stopReprice } from '/js/mods/pz2qol/repricerun.js';
import { checkMarketFor, checkMarketForAll, getMarketCheck, getMultiMarketCheck, isFranchise, isListingBusy, isMultiCheckBusy, priceCheckOf, PRICE_CHECK_FRESH_MS, stopMultiCheck } from '/js/mods/pz2qol/lister.js';
import { getPriceBook } from '/js/mods/pz2qol/pricebook.js';
import { medalLabel, nicePrice } from '/js/mods/pz2qol/pricing.js';
import { getEngineState } from '/js/mods/pz2qol/listerlua.js';
import { FIRST_TEXT, QUICK_MODES, QUICK_WARNING, quickAccepted, quickMoney, quickSheet, STEP_WORDS } from '/js/mods/pz2qol/listercore.js';
import { getPref } from '/js/mods/pz2qol/prefs.js';
import { Gender, Maturity } from '/js/mods/pz2qol/scores.js';
import { clear, fmtInt, h, setClass, tierOf } from '/js/mods/pz2qol/ui.js';
import { makeScroll, restoreScroll, speciesName, trunc } from '/js/mods/pz2qol/kinpanel.js';
import { translate } from '/js/common/core/Localisation.js';
import { breadcrumb } from '/js/mods/pz2qol/errors.js';
import { dlog } from '/js/mods/pz2qol/debuglog.js';

const SEX = { [Gender.Male]: '♂', [Gender.Female]: '♀' };
const SEX_CLASS = { [Gender.Male]: 'male', [Gender.Female]: 'female' };
const STAGE = { [Maturity.Infant]: 'Juv', [Maturity.YoungAdult]: 'Young', [Maturity.Adult]: 'Adult', [Maturity.Elderly]: 'Elderly', [Maturity.YoungAdultInfertile]: 'Young', [Maturity.AdultInfertile]: 'Adult', [Maturity.ElderlyInfertile]: 'Elderly' };
const VIEW_KEY = 'PZ2QoL.repriceView';
const SHORT = { stale: 'Stale', watch: 'Watch', ok: 'Healthy', under: 'Under', nodata: 'No data' };

// The view's own state (ticks and price edits live only while the page does).
const V = {
    species: null,
    verdicts: [],
    expiring: false,
    sort: 'score',
    strategy: 'suggested',
    pct: 5,
    floor: 80,
    hours: 'max',
    // what to do with the ticked listings: 'reprice' | 'quicktrade' |
    // 'release' (a quick action is never remembered: back to reprice on close)
    action: 'reprice',
    chosen: new Set(),     // GUIDs ticked
    over: {},              // GUID -> the player's own new price
    open: null,            // GUID whose working is shown
    sheet: null,           // the confirmation: { plan, openedAt }
    scroll: { rail: 0, list: 0 },
    editor: null,          // { guid, input }: the open row's price box (kept across renders)
    sheetEl: null,
    rows: [],              // listingRows() of the last render
    sigRows: '',
    ctx: null,             // what the desk passes in
};

function loadView() {
    try {
        const v = window.localStorage && JSON.parse(window.localStorage.getItem(VIEW_KEY) || 'null');
        if (!v) return;
        if (LISTING_SORTS[v.sort]) V.sort = v.sort;
        V.strategy = normalizeStrategy(v.strategy);
        if (v.pct >= 1 && v.pct <= 50) V.pct = Math.round(v.pct);
        if (v.floor >= 0 && v.floor <= 100) V.floor = Math.round(v.floor);
        if (v.hours === 'default') V.hours = 'default';
    }
    catch (e) {
        // defaults
    }
}
loadView();

function saveView() {
    try {
        if (window.localStorage) window.localStorage.setItem(VIEW_KEY, JSON.stringify({ sort: V.sort, strategy: V.strategy, pct: V.pct, floor: V.floor, hours: V.hours }));
    }
    catch (e) {
        // session only
    }
}

function t(s) {
    if (typeof s !== 'string') return s == undefined ? '' : String(s);
    try {
        return translate(s);
    }
    catch (e) {
        return s;
    }
}

function rerender() {
    if (V.ctx && V.ctx.queueRender) V.ctx.queueRender();
}

function say(text, tone) {
    if (V.ctx && V.ctx.notice) V.ctx.notice(text, tone);
}

function labelOfRow(r) {
    return `${speciesName(r.species)} ${SEX[r.a.gender] || ''} "${t(r.a.name)}"`.replace(/\s+/g, ' ');
}

const pct = x => (x == null ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(Math.round(x * 100))}%`);

// When the species' market was last seen: the desk's market check, or the
// newest market row of it in the price book (the player browsing counts too).
function checkedAtOf(species) {
    let at = 0;
    const c = priceCheckOf(species);
    if (c && c.ok !== false && c.at > at) at = c.at;
    for (const l of getPriceBook()) if (l.species === species && l.source === 'market' && l.seenAt > at) at = l.seenAt;
    return at || null;
}

// ------------------------------------------------------------------ data

// The desk's rows on the market, assessed (once per change of what counts).
function computeRows(deskRows) {
    const listed = deskRows.filter(r => r.block === 'listed');
    const now = Date.now();
    try {
        reconcileListed(new Map(listed.filter(r => r.guid).map(r => [r.guid, { price: r.a.price, left: r.a.auctionTimerSeconds }])));
    }
    catch (e) {
        // the run card still offers to list them again
    }
    // the score moves with time: ten-minute steps are enough
    const sig = JSON.stringify([listed.map(r => [r.id, r.a.price, r.verdict ? `${r.verdict.quickTrade}|${r.verdict.prices.quickTrade}|${r.verdict.quickRelease}|${r.verdict.prices.quickRelease}` : "", Math.ceil((r.a.auctionTimerSeconds || 0) / 600)]), getPriceBook().length,
        Array.from(new Set(listed.map(r => r.species))).map(sp => Math.floor((now - (checkedAtOf(sp) || 0)) / 300000))]);
    if (sig === V.sigRows) return V.rows;
    V.sigRows = sig;
    V.rows = listingRows(listed, { book: getPriceBook(), now, checkedAtOf, ledger: getLedger(), freshMs: PRICE_CHECK_FRESH_MS });
    // ticks of listings no longer on the market go (not the price edits: a
    // reprice keeps its own copy)
    const live = new Set(V.rows.map(r => r.guid).filter(Boolean));
    for (const g of Array.from(V.chosen)) if (!live.has(g)) V.chosen.delete(g);
    return V.rows;
}

function shownRows() {
    return sortListings(filterListings(V.rows, { species: V.species, verdicts: V.verdicts, expiring: V.expiring }), V.sort, r => String(t(r.a.name) || ''));
}

function chosenRows() {
    return V.rows.filter(r => r.guid && V.chosen.has(r.guid));
}

function plan(rows = chosenRows()) {
    return planReprice(rows, { strategy: V.strategy, pct: V.pct, floorPct: V.floor, overrides: V.over });
}

// Counts for the desk's tab: { n, stale } over every listing.
export function listingsCounts(deskRows) {
    const rows = computeRows(deskRows || []);
    const c = verdictCounts(rows);
    return { n: rows.length, stale: c.stale, left: (getReprice() ? strandedItems(getReprice()).length : 0) };
}

// What the desk adds to its redraw signature while this view is on.
export function listingsSig() {
    const run = getReprice();
    return JSON.stringify([V.sigRows, V.action, isAccepted(V.action), V.species, V.verdicts, V.expiring, V.sort, V.strategy, V.pct, V.floor, V.hours, Array.from(V.chosen), V.over, V.open, !!V.sheet,
        run && [run.id, run.phase, run.message, run.items.map(i => `${i.off}|${i.on}|${i.next}`).join(','), run.engine && [run.engine.index, run.engine.step, Math.round(run.engine.waited || 0)]],
        (getMarketCheck() || {}).message, (getMultiMarketCheck() || {}).message, isListingBusy()]);
}

// ---------------------------------------------------------------- actions

function toggle(r) {
    if (!r.guid || repriceActive()) return;
    if (V.chosen.has(r.guid)) V.chosen.delete(r.guid);
    else V.chosen.add(r.guid);
    rerender();
}

function tickShown(which) {
    if (repriceActive()) return;
    for (const r of shownRows()) {
        if (!r.guid) continue;
        if (which === 'none') V.chosen.delete(r.guid);
        else if (which === 'all' || (which === 'stale' && r.assess.verdict === 'stale')) V.chosen.add(r.guid);
    }
    dlog('reprice', 'tick', { which, ticked: V.chosen.size });
    rerender();
}

function setOverride(guid, price) {
    if (price > 0) V.over[guid] = Math.max(1, Math.round(price));
    else delete V.over[guid];
    rerender();
}

// Ticked species not checked in the last half hour.
function uncheckedSpecies(rows) {
    const out = new Set();
    for (const r of rows) if (r.assess.flags.staleData) out.add(r.species);
    return Array.from(out);
}

// The live acceptance of a quick mode (listercore quickAccepted; the desk
// records it when one animal was confirmed gone).
function isAccepted(mode) {
    if (!QUICK_MODES[mode]) return true;
    try {
        return quickAccepted(mode, getPref('quickAccepted'));
    }
    catch (e) {
        return quickAccepted(mode, null);
    }
}

// The quick action's money for the ticked listings (repricecore quickPreview
// over listercore quickSheet).
function quickInfo(rows = chosenRows(), mode = V.action) {
    return quickPreview(rows, mode, quickSheet, { fmt: fmtInt, nameOf: labelOfRow, accepted: isAccepted(mode) });
}

function openSheet() {
    if (QUICK_MODES[V.action]) {
        const q = quickInfo();
        if (!q.go.length) return say(`Tick listings the game allows ${QUICK_MODES[V.action].label} for first.`, 'warn');
        V.sheet = { action: V.action, quick: q, openedAt: Date.now() };
        dlog('reprice', 'sheet', { action: V.action, n: q.go.length, skip: q.skip.length, asking: q.asking, total: q.sheet.total });
        rerender();
        return;
    }
    const p = plan();
    if (!p.ready.length) return say('Tick listings with a new price first.', 'warn');
    V.sheet = { plan: p, openedAt: Date.now() };
    dlog('reprice', 'sheet', { n: p.ready.length, old: p.oldTotal, next: p.newTotal });
    rerender();
}

function closeSheet() {
    if (!V.sheet) return;
    V.sheet = null;
    rerender();
}

async function confirmSheet() {
    const s = V.sheet;
    // a stray double click or Enter right after opening does not confirm
    if (!s || Date.now() - s.openedAt < 300) return;
    V.sheet = null;
    const action = s.action || 'reprice';
    // a quick action: each listing's own price is kept, to list it again at
    // should the quick action not go through
    const items = s.quick
        ? s.quick.go.map(r => ({ guid: r.guid, key: r.key, label: labelOfRow(r), species: r.species, old: r.a.price, next: r.a.price, left: r.a.auctionTimerSeconds }))
        : s.plan.ready.map(i => ({ guid: i.guid, key: i.key, label: labelOfRow(i.row), species: i.row.species, old: i.old, next: i.next, left: i.row.a.auctionTimerSeconds }));
    breadcrumb('desk_listings');
    const r = await startReprice(items, { hours: V.hours, action });
    if (!r.ok) say(r.message || 'It did not start.', 'warn');
    else {
        const what = action === 'reprice' ? 'listing them again at the new prices' : `${QUICK_MODES[action].label.toLowerCase()} for each, one at a time`;
        say(`${ACTIONS[action].label}: ${r.count} listing${r.count === 1 ? '' : 's'}, taking them off the market one at a time, then ${what}. Stop any time.`, 'ok');
        for (const i of items) {
            V.chosen.delete(i.guid);
            delete V.over[i.guid];
        }
    }
    rerender();
}

// Keys while the view is on (the desk asks first): the sheet's Esc / Enter.
export function listingsKey(e) {
    if (!V.sheet) return false;
    if (e.key === 'Escape' || e.keyCode === 27) {
        closeSheet();
        return true;
    }
    if ((e.key === 'Enter' || e.keyCode === 13) && !e.repeat) {
        confirmSheet();
        return true;
    }
    return true;
}

export function listingsSheetOpen() {
    return !!V.sheet;
}

// The desk closed or switched view: the sheet goes.
export function listingsHidden() {
    V.sheet = null;
    V.action = 'reprice';
    V.editor = null;
    if (V.sheetEl) setClass(V.sheetEl, 'hidden', true);
}

// ----------------------------------------------------------------- render
//   ctx: { guard, btn, rows (desk rows), notice, queueRender, pace (node),
//          root (the desk), segmented(label, value, options, onPick, title) }
export function renderListings(els, ctx) {
    V.ctx = ctx;
    computeRows(ctx.rows);
    renderRail(els.rail, ctx);
    renderTable(els.main, ctx);
    renderPanel(els.side, ctx);
    renderSheet(ctx);
}

function renderRail(el, ctx) {
    const y = V.scroll.rail;
    clear(el);
    const box = makeScroll('mdRail', { onScroll: (x, yy) => { V.scroll.rail = yy; } });
    ctx.boxes.rail = box;
    const by = new Map();
    for (const r of V.rows) {
        let c = by.get(r.species);
        if (!c) by.set(r.species, c = { species: r.species, n: 0, stale: 0, watch: 0, expiring: 0 });
        c.n++;
        if (r.assess.verdict === 'stale') c.stale++;
        if (r.assess.verdict === 'watch') c.watch++;
        if (r.assess.flags.expiring) c.expiring++;
    }
    const list = Array.from(by.values()).sort((x, y2) => y2.stale - x.stale || y2.n - x.n || String(x.species).localeCompare(String(y2.species)));
    const all = verdictCounts(V.rows);
    for (const c of [{ species: null, n: V.rows.length, stale: all.stale, watch: all.watch, expiring: all.expiring }].concat(list)) {
        const on = (V.species || null) === c.species;
        const ticked = c.species ? chosenRows().filter(r => r.species === c.species).length : V.chosen.size;
        box.content.appendChild(h(`div.PZ2QoL_mdSpecies${on ? '.on' : ''}`, {
            'data-species': c.species || '',
            title: c.species ? speciesName(c.species) : 'All your listings',
            onClick: ctx.guard('Species', () => {
                V.species = c.species === V.species ? null : c.species;
                V.scroll.list = 0;
                rerender();
            }),
        },
            h('div.PZ2QoL_mdSpeciesName', { text: c.species ? trunc(speciesName(c.species), 22) : 'All my listings' }),
            h('div.PZ2QoL_mdSpeciesMeta', null,
                h('span.listed', { text: `${c.n} listed` }),
                c.stale ? h('span.stale', { text: `${c.stale} stale` }) : null,
                c.watch ? h('span.watch', { text: `${c.watch} watch` }) : null,
                c.expiring ? h('span.expiring', { text: `${c.expiring} expiring` }) : null,
                ticked ? h('span.chosen', { text: `${ticked} ticked` }) : null),
            // the share of stale (red) and watch (amber) listings
            c.n ? h('div.PZ2QoL_rpRailBar', null,
                h('div.stale', { style: { width: `${Math.round(c.stale / c.n * 100)}%` } }),
                h('div.watch', { style: { width: `${Math.round(c.watch / c.n * 100)}%` } })) : null));
    }
    if (!V.rows.length) box.content.appendChild(h('div.PZ2QoL_mdEmpty', { text: 'Nothing on the market.' }));
    el.appendChild(box.wrap);
    restoreScroll(box, 0, y);
}

function chip(label, n, on, onClick, cls = '', title = '') {
    return h(`div.PZ2QoL_mdSegItem.PZ2QoL_rpChip${cls ? '.' + cls : ''}${on ? '.on' : ''}`, { text: n == null ? label : `${label} ${n}`, title: title || undefined, onClick });
}

// The market data the verdicts stand on: checked when, and a button.
function dataCard(ctx, rows) {
    const multi = getMultiMarketCheck();
    const check = getMarketCheck();
    const checking = isMultiCheckBusy() || (check && (check.state === 'starting' || check.state === 'loading' || check.state === 'reading'));
    const species = Array.from(new Set(rows.map(r => r.species)));
    const old = uncheckedSpecies(rows);
    const box = h(`div.PZ2QoL_rpData${old.length ? '.old' : '.ok'}`);
    if (checking) {
        box.appendChild(h('span.PZ2QoL_rpDataText', { text: (multi && !multi.finished && multi.message) || (check && check.message) || 'Checking the market…' }));
        if (isMultiCheckBusy()) box.appendChild(ctx.btn('Stop', 'Icon_Close', () => stopMultiCheck(), { cls: 'small' }));
        return box;
    }
    if (!species.length) {
        box.appendChild(h('span.PZ2QoL_rpDataText', { text: 'No listings shown.' }));
        return box;
    }
    let newest = 0;
    for (const sp of species) newest = Math.max(newest, checkedAtOf(sp) || 0);
    const ago = newest ? Math.round((Date.now() - newest) / 60000) : null;
    box.appendChild(h('span.PZ2QoL_rpDataText', {
        text: old.length ? `${old.length} of ${species.length} species not checked in ${PRICE_CHECK_FRESH_MS / 60000} min: the verdicts may be off`
            : `✓ Market prices ${ago < 1 ? 'just' : `${ago} min ago`} for ${species.length === 1 ? 'this species' : `all ${species.length} species`}`,
        title: 'The verdicts compare your listings with the comparable listings the mod has seen on the Market (the price book). Check market prices loads them fresh, in the background.',
    }));
    const todo = old.length ? old : species;
    box.appendChild(ctx.btn(old.length ? (todo.length === 1 ? 'Check market prices' : `Check market prices (${todo.length})`) : 'Check again', 'IconSearch',
        () => (todo.length === 1 ? checkMarketFor(todo[0]) : checkMarketForAll(todo)), {
            cls: `small${old.length ? '.attention' : ''}${isListingBusy() ? '.disabled' : ''}`,
            title: "Loads the current Market listings of these species in the background (the screen stays on Animal Storage), so the verdicts follow today's market.",
        }));
    return box;
}

function sortHead(ctx, cls, text, key, title) {
    const on = V.sort === key;
    return h(`div.PZ2QoL_mdCell.${cls}.sortable${on ? '.on' : ''}`, {
        text: text + (on ? (key === 'name' || key === 'left' ? ' ▲' : ' ▼') : ''), title: title || `Sort by ${text.toLowerCase()}`,
        onClick: ctx.guard('Sort', () => {
            V.sort = key;
            saveView();
            rerender();
        }),
    });
}

function renderTable(el, ctx) {
    const y = V.scroll.list;
    const typing = V.editor && document.activeElement === V.editor.input;
    clear(el);
    const base = filterListings(V.rows, { species: V.species });
    const counts = verdictCounts(base);
    const shown = shownRows();
    const busy = repriceActive();
    // filters: verdicts (several at once), expiring
    const vs = new Set(V.verdicts);
    const pick = v => ctx.guard('Verdict', () => {
        if (v === 'all') V.verdicts = [];
        else if (vs.has(v)) V.verdicts = V.verdicts.filter(x => x !== v);
        else V.verdicts = V.verdicts.concat(v);
        V.scroll.list = 0;
        rerender();
    });
    el.appendChild(h('div.PZ2QoL_mdTools', null,
        h('div.PZ2QoL_mdSeg.PZ2QoL_rpVerdicts', { title: 'Show listings by verdict (several at once)' },
            h('span.PZ2QoL_mdSegLabel', { text: 'Show' }),
            chip('All', counts.all, !vs.size, pick('all')),
            VERDICT_ORDER.map(v => chip(SHORT[v], counts[v], vs.has(v), pick(v), `v_${v}`, VERDICTS[v].text))),
        h('div.PZ2QoL_mdSeg', { title: 'Under an hour left: it goes back to storage unsold when the time runs out; listing it again restarts the clock' },
            chip('Expiring < 1h', counts.expiring, V.expiring, ctx.guard('Expiring', () => {
                V.expiring = !V.expiring;
                rerender();
            }), 'expiring')),
        dataCard(ctx, base)));
    const staleShown = shown.filter(r => r.guid && r.assess.verdict === 'stale').length;
    el.appendChild(h('div.PZ2QoL_mdTools.second', null,
        ctx.btn(`Tick stale (${staleShown})`, null, () => tickShown('stale'), { cls: staleShown && !busy ? 'attention' : 'disabled', title: 'Tick every stale listing shown' }),
        ctx.btn(`Tick all shown (${shown.filter(r => r.guid).length})`, null, () => tickShown('all'), { cls: busy ? 'disabled' : '' }),
        ctx.btn('Untick shown', null, () => tickShown('none'), { cls: busy ? 'disabled' : '' }),
        h('div.PZ2QoL_mdShown', { text: `${fmtInt(shown.length)} of ${fmtInt(base.length)} shown` }),
        h('div.PZ2QoL_kpFlex'),
        h('div.PZ2QoL_rpLegend', { title: 'Staleness = price pressure × time weight. Price pressure: half how far over the fair price you ask (0 at 5% under, 100 at 30% over), half your place in line among comparable listings (0 = cheapest, 100 = dearest). Time weight: 0.5 just listed, 1.0 at the end of its time. 50 or more is stale, 25-49 watch.' },
            h('span', { text: 'Staleness = price pressure × time on market' }), h('span.PZ2QoL_rpInfo', { text: 'i' }))));
    // the table
    el.appendChild(h('div.PZ2QoL_mdRow.head.PZ2QoL_rpRow', null,
        h('div.PZ2QoL_mdCell.tick'), h('div.PZ2QoL_mdCell.sex'), sortHead(ctx, 'name', 'Animal', 'name'),
        h('div.PZ2QoL_mdCell.medal', { text: 'Rating' }), h('div.PZ2QoL_mdCell.genes', { text: 'Genes' }),
        sortHead(ctx, 'rpAsk', 'Asking', 'price', 'Your price now (CC)'),
        sortHead(ctx, 'rpFair', 'vs fair', 'premium', "Your price against the fair price (the desk's own advice for this animal)"),
        h('div.PZ2QoL_mdCell.rpLine', { text: 'In line', title: 'Your place among the comparable listings on the market (1 = cheapest)' }),
        sortHead(ctx, 'rpTime', 'On market', 'left', 'Time up and left (sort: least left first)'),
        sortHead(ctx, 'rpScore', 'Staleness', 'score', 'Staleness score 0-100 and verdict'),
        h('div.PZ2QoL_mdCell.rpNew', { text: 'New price', title: 'Ticked: the price it will be listed again at (the rule on the right, or your own). Not ticked: the suggestion, faded.' }),
        h('div.PZ2QoL_mdCell.rpMore')));
    const box = makeScroll('mdList', { onScroll: (x, yy) => { V.scroll.list = yy; } });
    ctx.boxes.list = box;
    if (!shown.length) {
        box.content.appendChild(h('div.PZ2QoL_mdEmpty', {
            text: V.rows.length ? 'No listing matches these filters.' : 'None of your animals is on the market now. List some from Sell from storage.',
        }));
    }
    const ticked = shown.filter(r => r.guid && V.chosen.has(r.guid));
    const p = plan(ticked);
    const planned = new Map(p.items.map(i => [i.guid, i]));
    // a quick action: what each ticked one would fetch (or why not)
    let quickRows = null;
    if (QUICK_MODES[V.action]) {
        const q = quickInfo(ticked);
        quickRows = new Map();
        for (const [g, price] of q.perRow) quickRows.set(g, { ok: true, price });
        for (const x of q.skip) quickRows.set(x.r.guid, { ok: false, why: x.why });
    }
    for (const r of shown) {
        box.content.appendChild(rowEl(ctx, r, quickRows ? null : planned.get(r.guid), quickRows ? quickRows.get(r.guid) : null));
        if (V.open && r.guid === V.open) box.content.appendChild(detailEl(ctx, r, planned.get(r.guid)));
    }
    el.appendChild(box.wrap);
    restoreScroll(box, 0, y);
    if (typing) {
        try {
            V.editor.input.focus();
        }
        catch (e) {
            // typing again works
        }
    }
}

function scoreCell(a) {
    const v = a.verdict;
    const s = a.score;
    const tip = `${VERDICTS[v].label}: ${VERDICTS[v].text}.${s != null ? ` Score ${s} of 100.` : ''}${a.flags.staleData ? ' Market data old: check market prices.' : ''}${a.flags.lowConf ? ' Few comparables: low confidence.' : ''}`;
    return h(`div.PZ2QoL_mdCell.rpScore.v_${v}${a.flags.staleData || a.flags.lowConf ? '.unsure' : ''}`, { title: tip },
        h('div.PZ2QoL_rpBar', null, h('div.PZ2QoL_rpBarFill', { style: { width: `${s == null ? 0 : Math.max(4, s)}%` } })),
        h('span.PZ2QoL_rpScoreN', { text: s == null ? '–' : String(s) }),
        h('span.PZ2QoL_rpVerdict', { text: SHORT[v] }),
        (a.flags.staleData || a.flags.lowConf) && v !== 'nodata' ? h('span.PZ2QoL_rpUnsure', { text: '?' }) : null);
}

function rowEl(ctx, r, item, qi = null) {
    const a = r.a;
    const as = r.assess;
    const on = !!(r.guid && V.chosen.has(r.guid));
    const off = !r.guid || repriceActive();
    const rp = getReprice();
    const inRun = !!(r.guid && rp && repriceActive() && rp.items.some(i => i.guid === r.guid));
    const prem = as.premium;
    const c = as.clock;
    const line = as.n ? `${as.cheaper + 1} / ${as.n + 1}` : 'alone';
    let newText = '';
    let newCls = 'faded';
    let delta = null;
    if (item && item.next > 0) {
        newText = fmtInt(item.next);
        newCls = item.override ? 'own' : 'set';
        delta = item.old ? item.next / item.old - 1 : null;
    }
    else if (item) {
        newText = 'no price';
        newCls = 'none';
    }
    else if (as.suggestion > 0) {
        newText = as.suggestion === as.price ? 'keep' : `→ ${fmtInt(as.suggestion)}`;
    }
    if (qi) {
        // the quick action's money (the game's price when it was last selected)
        newText = !qi.ok ? 'not allowed' : qi.price != null ? quickMoney(V.action, qi.price, fmtInt) : 'when off';
        newCls = qi.ok ? 'quickv' : 'none';
        delta = null;
    }
    if (inRun) {
        const i = rp.items.find(x => x.guid === r.guid);
        newText = QUICK_MODES[rp.action] ? QUICK_MODES[rp.action].label : `→ ${fmtInt(i.next)}`;
        newCls = 'inrun';
    }
    return h(`div.PZ2QoL_mdRow.PZ2QoL_rpRow.v_${as.verdict}${on ? '.on' : ''}${off ? '.blocked' : ''}${V.open === r.guid ? '.open' : ''}`, {
        'data-guid': r.guid || '', 'data-verdict': as.verdict,
        title: r.guid ? undefined : 'The game gave no id for this animal: the desk cannot take it off the market.',
        onClick: ctx.guard('Tick', () => toggle(r)),
    },
        h('div.PZ2QoL_mdCell.tick', null, h(`div.PZ2QoL_mdBox${on ? '.on' : ''}${!r.guid ? '.off' : ''}`)),
        h(`div.PZ2QoL_mdCell.sex.${SEX_CLASS[a.gender] || 'other'}`, { text: SEX[a.gender] || '·' }),
        h('div.PZ2QoL_mdCell.name', { title: `${speciesName(a.species)} · ${t(a.name)} · ${STAGE[a.maturity] || ''}` },
            h('span.PZ2QoL_mdName', { text: trunc(t(a.name), 20) }),
            V.species ? null : h('span.PZ2QoL_mdSpeciesTag', { text: trunc(speciesName(a.species), 14) }),
            as.flags.expiring ? h('span.PZ2QoL_rpTag.expiring', { text: '<1h', title: 'Under an hour left: it goes back to storage unsold when the time runs out' }) : null),
        h('div.PZ2QoL_mdCell.medal', null, r.medal != undefined ? h(`span.PZ2QoL_medalDot.${r.medal}`, { title: medalLabel(r.medal) }) : h('span', { text: '–' })),
        h(`div.PZ2QoL_mdCell.genes.${tierOf(r.score)}`, { text: r.score == null ? '–' : String(r.score) }),
        h('div.PZ2QoL_mdCell.rpAsk', { text: fmtInt(as.price) }),
        h(`div.PZ2QoL_mdCell.rpFair${prem == null ? '' : prem > 0.1 ? '.over' : prem < -0.1 ? '.under' : '.even'}`, {
            title: as.fair ? `Fair price ${fmtInt(as.fair)} CC (${as.conf} confidence)` : 'No fair price: no comparables',
        }, h('span.p', { text: pct(prem) }), h('span.f', { text: as.fair ? fmtInt(as.fair) : '' })),
        h(`div.PZ2QoL_mdCell.rpLine${as.n && as.queue > 0.5 && (as.verdict === 'stale' || as.verdict === 'watch') ? '.back' : ''}`, {
            text: line, title: as.n ? `${as.cheaper} of ${as.n} comparable listings are cheaper; cheapest ${fmtInt(as.cheapest)} CC` : 'No comparable listing on the market now',
        }),
        h('div.PZ2QoL_mdCell.rpTime', { title: `${spanText(c.elapsed)} up, ${spanText(c.left)} left of ${Math.round(c.duration / 3600)} h${c.known === 'assumed' ? ' (length assumed: listed before this session)' : ''}` },
            h('div.PZ2QoL_rpClock', null, h('div.PZ2QoL_rpClockFill', { style: { width: `${Math.round(c.frac * 100)}%` } })),
            h('span', { text: `${spanText(c.left)} left` })),
        scoreCell(as),
        h(`div.PZ2QoL_mdCell.rpNew.${newCls}`, { title: qi ? (qi.ok ? (qi.price != null ? `${QUICK_MODES[V.action].label}: ${quickMoney(V.action, qi.price, fmtInt)} (the game's price when it was last selected)` : 'Its price shows once the game has selected it off the market') : qi.why) : item ? item.why : as.suggestionWhy || '' },
            h('span.n', { text: newText }),
            delta != null && Math.abs(delta) >= 0.005 ? h(`span.d${delta < 0 ? '.down' : '.up'}`, { text: pct(delta) }) : null),
        h(`div.PZ2QoL_mdCell.rpMore${V.open === r.guid ? '.on' : ''}`, {
            text: V.open === r.guid ? '▾' : '▸', title: 'The working and your own price',
            onClick: ctx.guard('Details', e => {
                if (e && e.stopPropagation) e.stopPropagation();
                V.open = V.open === r.guid ? null : r.guid;
                V.editor = null;
                rerender();
            }),
        }));
}

// The comparables on one line: each listing a dot, the fair price a line,
// yours (red) and the new price (green) as markers.
function ladderEl(as, next) {
    const pts = as.ladder.slice();
    const marks = [as.price, as.fair, next].filter(x => x > 0);
    const all = pts.concat(marks);
    if (!all.length) return h('div.PZ2QoL_rpLadderNone', { text: 'No comparable listings to draw.' });
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (hi - lo < hi * 0.1) {
        lo *= 0.95;
        hi *= 1.05;
    }
    const pad = (hi - lo) * 0.06;
    lo = Math.max(0, lo - pad);
    hi += pad;
    const x = v => `${((v - lo) / (hi - lo) * 100).toFixed(2)}%`;
    const track = h('div.PZ2QoL_rpLadderTrack', null, h('div.PZ2QoL_rpLadderRail'));
    for (const v of pts) track.appendChild(h('div.PZ2QoL_rpDot', { style: { left: x(v) }, title: `${fmtInt(v)} CC` }));
    if (as.fair > 0) track.appendChild(h('div.PZ2QoL_rpMark.fair', { style: { left: x(as.fair) }, title: `Fair ${fmtInt(as.fair)} CC` }));
    if (as.price > 0) track.appendChild(h('div.PZ2QoL_rpMark.mine', { style: { left: x(as.price) }, title: `Yours now ${fmtInt(as.price)} CC` }));
    if (next > 0 && next !== as.price) track.appendChild(h('div.PZ2QoL_rpMark.next', { style: { left: x(next) }, title: `New ${fmtInt(next)} CC` }));
    return h('div.PZ2QoL_rpLadder', null,
        h('div.PZ2QoL_rpLadderHead', null,
            h('span', { text: `${as.n} comparable${as.n === 1 ? '' : 's'}` }),
            h('div.PZ2QoL_kpFlex'),
            h('span.k', null, h('span.PZ2QoL_rpKey.comp'), h('span', { text: 'others' })),
            h('span.k', null, h('span.PZ2QoL_rpKey.mine'), h('span', { text: 'yours' })),
            h('span.k', null, h('span.PZ2QoL_rpKey.fair'), h('span', { text: 'fair' })),
            next > 0 && next !== as.price ? h('span.k', null, h('span.PZ2QoL_rpKey.next'), h('span', { text: 'new' })) : null),
        track,
        h('div.PZ2QoL_rpLadderAxis', null, h('span', { text: `${fmtInt(lo)} CC` }), h('div.PZ2QoL_kpFlex'), h('span', { text: `${fmtInt(hi)} CC` })));
}

// The price box of the open row: built once per open row, kept across
// renders (a re-render must not interrupt typing).
function editorFor(ctx, r) {
    if (V.editor && V.editor.guid === r.guid) return V.editor.input;
    const input = h('input.PZ2QoL_mdText.PZ2QoL_rpInput', { type: 'text', maxlength: '7', placeholder: 'CC' });
    if (V.over[r.guid]) input.value = String(V.over[r.guid]);
    let timer = 0;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            const n = parseInt(String(input.value).replace(/[^\d]/g, ''), 10);
            setOverride(r.guid, n > 0 ? n : 0);
        }, 300);
    });
    input.addEventListener('keydown', e => {
        if (e.key !== 'Escape' && e.keyCode !== 27) e.stopPropagation();
    });
    input.addEventListener('click', e => e.stopPropagation());
    V.editor = { guid: r.guid, input };
    return input;
}

function detailEl(ctx, r, item) {
    const as = r.assess;
    const next = item && item.next > 0 ? item.next : V.over[r.guid] || as.suggestion;
    const why = h('div.PZ2QoL_rpWhyList');
    for (const x of as.reasons) {
        why.appendChild(h(`div.PZ2QoL_rpWhy.k_${x.k}`, null,
            h('span.l', { text: x.label }), h('span.v', { text: x.value }), h('span.d', { text: x.detail, title: x.detail })));
    }
    if (as.suggestion > 0) why.appendChild(h('div.PZ2QoL_rpWhy.k_sug', null, h('span.l', { text: 'Suggestion' }), h('span.v', { text: as.suggestion === as.price ? 'keep' : `${fmtInt(as.suggestion)} CC` }), h('span.d', { text: as.suggestionWhy })));
    const input = editorFor(ctx, r);
    const step = d => ctx.guard('Nudge', e => {
        if (e && e.stopPropagation) e.stopPropagation();
        const base = V.over[r.guid] || next || as.price;
        const n = Math.max(1, nicePrice(base * (1 + d)));
        input.value = String(n);
        setOverride(r.guid, n);
        if (r.guid && !V.chosen.has(r.guid) && !repriceActive()) V.chosen.add(r.guid);
    });
    const use = (v, label) => ctx.btn(label, null, () => {
        input.value = String(v);
        setOverride(r.guid, v);
        if (!V.chosen.has(r.guid) && !repriceActive()) V.chosen.add(r.guid);
    }, { cls: `small${v > 0 ? '' : '.disabled'}` });
    const own = h('div.PZ2QoL_rpEdit', { onClick: e => e.stopPropagation() },
        h('div.PZ2QoL_mdCardTitle', { text: 'Your own price for it' }),
        h('div.PZ2QoL_rpEditRow', null,
            h('div.PZ2QoL_rpStep', { text: '−5%', onClick: step(-0.05) }),
            input,
            h('div.PZ2QoL_rpStep', { text: '+5%', onClick: step(0.05) }),
            h('span.PZ2QoL_rpEditNote', { text: V.over[r.guid] ? `${pct(V.over[r.guid] / as.price - 1)} vs now` : 'empty: the rule on the right' })),
        h('div.PZ2QoL_rpEditRow', null,
            use(as.suggestion, 'Suggestion'), use(as.fair, 'Fair'), use(as.cheapest, 'Cheapest'),
            V.over[r.guid] ? ctx.btn('Clear', null, () => {
                input.value = '';
                setOverride(r.guid, 0);
            }, { cls: 'small' }) : null));
    return h('div.PZ2QoL_rpDetail', { onClick: e => e.stopPropagation() },
        h('div.PZ2QoL_rpDetailLeft', null, ladderEl(as, next), own),
        why);
}

// ------------------------------------------------------------ the panel

function strategyList(ctx) {
    const box = h('div.PZ2QoL_rpStrats');
    for (const [k, s] of Object.entries(STRATEGIES)) {
        const on = V.strategy === k;
        box.appendChild(h(`div.PZ2QoL_rpStrat${on ? '.on' : ''}`, {
            'data-value': k, title: s.title,
            onClick: ctx.guard('Rule', () => {
                V.strategy = k;
                saveView();
                rerender();
            }),
        }, h('div.PZ2QoL_rpRadio'), h('span.l', { text: k === 'undercut' ? `Undercut cheapest by ${V.pct}%` : k === 'cut' ? `Cut my price by ${V.pct}%` : s.label })));
    }
    return box;
}

function stepper(ctx, label, value, unit, onStep, title, min, max, stepBy) {
    return h('div.PZ2QoL_rpStepper', { title },
        h('span.PZ2QoL_mdSegLabel', { text: label }),
        h(`div.PZ2QoL_rpStep${value <= min ? '.off' : ''}`, { text: '−', onClick: ctx.guard(label, () => onStep(Math.max(min, value - stepBy))) }),
        h('span.PZ2QoL_rpStepValue', { text: `${value}${unit}` }),
        h(`div.PZ2QoL_rpStep${value >= max ? '.off' : ''}`, { text: '+', onClick: ctx.guard(label, () => onStep(Math.min(max, value + stepBy))) }));
}

function previewEl(p) {
    const box = h('div.PZ2QoL_rpPreview');
    if (!p.items.length) {
        box.appendChild(h('div.PZ2QoL_rpPrevNone', { text: 'Tick listings to see the new prices here.' }));
        return box;
    }
    const diff = p.newTotal - p.oldTotal;
    box.appendChild(h('div.PZ2QoL_rpPrevTotals', null,
        h('span.old', { text: fmtInt(p.oldTotal) }), h('span.arrow', { text: '→' }), h('span.new', { text: `${fmtInt(p.newTotal)} CC` })));
    box.appendChild(h(`div.PZ2QoL_rpPrevDiff${diff < 0 ? '.down' : diff > 0 ? '.up' : ''}`, {
        text: `${diff < 0 ? '−' : diff > 0 ? '+' : '±'}${fmtInt(Math.abs(diff))} CC${p.oldTotal ? ` (${pct(diff / p.oldTotal)})` : ''} · ${p.lowered} lower · ${p.raised} higher${p.same ? ` · ${p.same} same` : ''}`,
    }));
    const notes = [];
    if (p.aboveCheapest) notes.push(`${p.aboveCheapest} still above the cheapest comparable`);
    if (p.floored) notes.push(`${p.floored} held at ${V.floor}% of fair`);
    if (p.same) notes.push(`${p.same} at the same price: listing again only restarts the clock`);
    if (p.noPrice.length) notes.push(`${p.noPrice.length} with no price under this rule: left out`);
    for (const n of notes) box.appendChild(h('div.PZ2QoL_rpPrevNote', { text: n }));
    const lines = p.ready.slice().sort((x, y) => (x.change || 0) - (y.change || 0));
    for (const i of lines.slice(0, 5)) {
        box.appendChild(h('div.PZ2QoL_rpPrevLine', { title: i.why },
            h('span.n', { text: trunc(labelOfRow(i.row), 26) }),
            h('div.PZ2QoL_kpFlex'),
            h('span.o', { text: fmtInt(i.old) }), h('span.a', { text: '→' }), h(`span.x${i.change < 0 ? '.down' : i.change > 0 ? '.up' : ''}`, { text: fmtInt(i.next) })));
    }
    if (lines.length > 5) box.appendChild(h('div.PZ2QoL_rpPrevNote', { text: `and ${lines.length - 5} more` }));
    return box;
}

function renderPanel(el, ctx) {
    clear(el);
    setClass(el, 'quick', false);
    const run = getReprice();
    const active = repriceActive();
    const left = run ? strandedItems(run) : [];
    // run mode: while a reprice goes, or listings it took off wait to be
    // listed again, the panel is about that run only
    if (run && (active || left.length)) {
        setClass(el, 'quick', !!QUICK_MODES[run.action]);
        el.appendChild(h('div.PZ2QoL_mdCardTitle', { text: ACTIONS[run.action] ? ACTIONS[run.action].label : 'Reprice' }));
        el.appendChild(runCard(ctx, run));
        el.appendChild(ctx.pace);
        if (!active) el.appendChild(h('div.PZ2QoL_rpNeed', { text: QUICK_MODES[run.action] ? 'They stay in storage until you send or list them again; the next run waits for that.' : 'They stay in storage until you list them again; the next reprice waits for that.' }));
        return;
    }
    // what to do with the ticked listings
    const seg = ctx.segmented('', V.action, [['reprice', 'Reprice'], ['quicktrade', 'Quick trade'], ['release', 'Quick release']], v => {
        if (repriceActive()) return;
        V.action = ACTIONS[v] ? v : 'reprice';
        V.sheet = null;
        dlog('reprice', 'action', { action: V.action, accepted: isAccepted(V.action) });
        rerender();
    }, 'Reprice: take them off and list them again at a new price. Quick trade (cash) / Quick release (CC): take them off, then sell them to the game at once; permanent.');
    seg.classList.add('mode');
    el.appendChild(seg);
    // the last run, in one line
    if (run) {
        el.appendChild(h(`div.PZ2QoL_rpLast.${run.phase}`, null,
            h('span', { text: runSummary(run, fmtInt) || run.message || 'Reprice finished.', title: run.message || '' }),
            h('div.PZ2QoL_kpFlex'),
            h('div.PZ2QoL_rpDismiss', { text: '×', title: 'Dismiss', onClick: ctx.guard('Dismiss', () => {
                dismissReprice();
                rerender();
            }) })));
    }
    const rows = chosenRows();
    if (QUICK_MODES[V.action]) {
        setClass(el, 'quick', true);
        return quickPanel(el, ctx, rows);
    }
    const p = plan(rows);
    el.appendChild(h('div.PZ2QoL_mdBig', null, h('span.n', { text: String(rows.length) }), h('span.l', { text: `listing${rows.length === 1 ? '' : 's'} ticked` })));
    el.appendChild(h('div.PZ2QoL_mdTotal', { text: 'New price for each:' }));
    el.appendChild(strategyList(ctx));
    const knobs = h('div.PZ2QoL_rpKnobs');
    if (V.strategy === 'undercut' || V.strategy === 'cut') {
        knobs.appendChild(stepper(ctx, V.strategy === 'cut' ? 'Cut' : 'Under', V.pct, '%', v => {
            V.pct = v;
            saveView();
            rerender();
        }, 'How many percent', 1, 50, 1));
    }
    if (V.strategy !== 'suggested') {
        knobs.appendChild(stepper(ctx, 'Floor', V.floor, '% of fair', v => {
            V.floor = v;
            saveView();
            rerender();
        }, 'Never under this share of the fair price (0: no floor)', 0, 100, 5));
    }
    if (knobs.childNodes.length) el.appendChild(knobs);
    el.appendChild(previewEl(p));
    el.appendChild(ctx.segmented('Duration', V.hours, [['max', 'Longest'], ['default', 'Game default']], v => {
        V.hours = v;
        saveView();
        rerender();
    }, 'How long each is listed again for: the longest the game allows (12 h), or its default (6 h)'));
    el.appendChild(ctx.pace);
    {
        const unchecked = uncheckedSpecies(rows);
        const busy = isListingBusy();
        const can = p.ready.length && isFranchise() && !busy && !unchecked.length;
        el.appendChild(ctx.btn(`Reprice ${p.ready.length} listing${p.ready.length === 1 ? '' : 's'}`, 'IconTrade', openSheet, {
            cls: `primary.wide${can ? '' : '.disabled'}`, tint: 'white',
            title: !isFranchise() ? 'Franchise only' : busy ? 'A listing or market check is running'
                : unchecked.length ? `Check market prices first (${unchecked.length} species not checked in ${PRICE_CHECK_FRESH_MS / 60000} min)`
                    : 'Shows the plan first; nothing changes until you confirm',
        }));
        if (unchecked.length && rows.length) el.appendChild(h('div.PZ2QoL_rpNeed', { text: `Check market prices first: ${unchecked.length} of the ticked species not checked in ${PRICE_CHECK_FRESH_MS / 60000} min.` }));
    }
}

// Quick trade / Quick release of the ticked listings: the money (what each
// would fetch against what it asks now), who can't go and why, the first-run
// limit, the button that opens the sheet.
function quickPanel(el, ctx, rows) {
    const mode = V.action;
    const m = QUICK_MODES[mode];
    const q = quickInfo(rows, mode);
    el.appendChild(h('div.PZ2QoL_mdQuickHead', { text: m.header }));
    el.appendChild(h('div.PZ2QoL_mdBig', null, h('span.n', { text: String(q.go.length) }), h('span.l', { text: `listing${q.go.length === 1 ? '' : 's'} to ${m.label.toLowerCase()}` })));
    const box = h('div.PZ2QoL_rpPreview.quick');
    if (!rows.length) box.appendChild(h('div.PZ2QoL_rpPrevNone', { text: `Tick listings to see what ${m.label} pays for them.` }));
    else {
        box.appendChild(h('div.PZ2QoL_rpQuickSum', null,
            h('div.PZ2QoL_rpQuickCol', null, h('span.k', { text: 'Asking now' }), h('span.v', { text: `${fmtInt(q.asking)} CC` })),
            h('div.PZ2QoL_rpQuickCol.pay', null, h('span.k', { text: `${m.label} pays` }), h('span.v', { text: q.sheet.totalText || '–' }))));
        const unpriced = q.go.length - q.sheet.priced;
        if (unpriced) box.appendChild(h('div.PZ2QoL_rpPrevNote', { text: `${unpriced} not priced yet: the game shows the price once it has selected the animal off the market; it goes only if the game allows ${m.label} then.` }));
        for (const r of q.go.slice(0, 6)) {
            const price = q.perRow.get(r.guid);
            box.appendChild(h('div.PZ2QoL_rpPrevLine', null,
                h('span.n', { text: trunc(labelOfRow(r), 24) }), h('div.PZ2QoL_kpFlex'),
                h('span.o', { text: `${fmtInt(r.a.price)} CC` }), h('span.a', { text: '→' }),
                h(`span.x${price != null ? '' : '.unknown'}`, { text: price != null ? quickMoney(mode, price, fmtInt) : 'when off' })));
        }
        if (q.go.length > 6) box.appendChild(h('div.PZ2QoL_rpPrevNote', { text: `and ${q.go.length - 6} more` }));
        for (const x of q.skip.slice(0, 3)) box.appendChild(h('div.PZ2QoL_rpPrevLine.skip', { title: x.why }, h('span.n', { text: `✕ ${trunc(labelOfRow(x.r), 22)}: ${x.why}` })));
        if (q.skip.length > 3) box.appendChild(h('div.PZ2QoL_rpPrevNote', { text: `${q.skip.length - 3} more left out` }));
    }
    el.appendChild(box);
    if (!isAccepted(mode)) el.appendChild(h('div.PZ2QoL_mdQuickFirst', { text: `${FIRST_TEXT[mode]}.`, title: 'Until one animal has been confirmed gone from storage this way, one at a time.' }));
    el.appendChild(h('div.PZ2QoL_rpQuickHow', { text: `Each is taken off the market first (the game offers ${m.label} only for animals not on the market), then sent one at a time. Anything unexpected stops it; the ones taken off and not sold wait in storage.` }));
    el.appendChild(ctx.pace);
    const busy = isListingBusy();
    const can = q.go.length && isFranchise() && !busy;
    el.appendChild(ctx.btn(`${m.label} ${q.go.length} listing${q.go.length === 1 ? '' : 's'}…`, m.cash ? 'Icon_Cash_Symbol' : 'Icon_ConservationCredits', openSheet, {
        cls: `quick.wide${can ? '' : '.disabled'}`, tint: 'white',
        title: !isFranchise() ? 'Franchise only' : busy ? 'A listing or market check is running' : 'Opens a confirmation; nothing is sent until you confirm there',
    }));
}

const PHASES = [['off', 'Take off'], ['settle', 'Settle'], ['relist', 'List again']];

function runCard(ctx, run) {
    const c = runCounts(run);
    const active = repriceActive();
    const done = run.phase === 'done';
    const qm = QUICK_MODES[run.action];
    const name = qm ? qm.label : 'Reprice';
    const finished = qm ? c.sold : c.relisted;
    const card = h(`div.PZ2QoL_mdRun.PZ2QoL_rpRun${qm ? '.quick' : ''}.${active ? 'running' : run.phase}`);
    card.appendChild(h('div.PZ2QoL_mdRunHead', null,
        h('span', { text: active ? (qm ? qm.working : 'Repricing…') : done ? `${name} finished` : `${name} stopped` }),
        h('div.PZ2QoL_kpFlex'),
        h('span.PZ2QoL_mdRunCount', { text: `${finished}/${c.total} ${qm ? qm.verb.toLowerCase() : 'repriced'}` })));
    // the three phases
    const phases = qm ? [PHASES[0], PHASES[1], ['quick', qm.cash ? 'Trade' : 'Release']] : PHASES;
    const at = phases.findIndex(([k]) => k === run.phase);
    const offDone = c.off + c.offFailed;
    card.appendChild(h('div.PZ2QoL_rpPhases', null, phases.map(([k, label], n) => {
        const cls = n === at ? 'now' : (at > n || done || (!active && n === 0)) ? 'past' : '';
        const count = k === 'off' ? `${offDone}/${c.total}` : k === 'relist' || k === 'quick' ? `${finished}/${c.off}` : '';
        return h(`div.PZ2QoL_rpPhase${cls ? '.' + cls : ''}${n === phases.length - 1 ? '.last' : ''}`, null, h('span.i', { text: String(n + 1) }), h('span.l', { text: label }), count ? h('span.c', { text: count }) : null);
    })));
    const total = c.total * 2;
    const progress = total ? (offDone + c.relisted + c.sold + c.unconfirmed + c.relistFailed) / total : 0;
    card.appendChild(h('div.PZ2QoL_mdProgress', null, h('div.PZ2QoL_mdProgressFill', { style: { width: `${Math.round(progress * 100)}%` } })));
    if (active) {
        const e = run.engine || {};
        const s = getEngineState();
        const cur = s && s.phase === 'running' ? s.results[s.index] : null;
        const item = cur ? run.items.find(i => i.guid === String(cur.guid)) : null;
        if (run.phase === 'settle') card.appendChild(h('div.PZ2QoL_mdRunStep', { text: run.message || 'Letting the game put them back in storage…' }));
        else if (item) {
            card.appendChild(h('div.PZ2QoL_mdRunNow', { text: `${item.label}${run.phase === 'relist' ? ` · ${fmtInt(item.next)} CC` : run.phase === 'quick' ? ` · ${qm.label}` : ''}` }));
            card.appendChild(h('div.PZ2QoL_mdRunStep', { text: `${STEP_WORDS[e.step] || 'Working…'}${e.waited >= 2 ? ` (${Math.round(e.waited)}s)` : ''}` }));
        }
        else if (run.message) card.appendChild(h('div.PZ2QoL_mdRunStep', { text: run.message }));
        card.appendChild(ctx.btn('Stop', 'Icon_Close', () => stopReprice(), {
            cls: 'stop.wide', tint: 'white', title: 'Stops after the current listing. The ones already taken off stay off until you list them again (a button here does it); nothing is listed again by itself after a Stop.',
        }));
    }
    else {
        if (finished || c.unconfirmed || done) card.appendChild(h('div.PZ2QoL_mdRunStep.sum', { text: `${runSummary(run, fmtInt)}.` }));
        if (run.message) card.appendChild(h('div.PZ2QoL_mdRunStep.why', { text: run.message, title: run.message }));
    }
    const left = strandedItems(run);
    if (!active && left.length) {
        card.appendChild(h('div.PZ2QoL_rpLeft', null,
            h('div.PZ2QoL_rpLeftHead', { text: `${left.length} off the market, ${qm ? 'not sold, ' : ''}waiting in storage` }),
            left.slice(0, 6).map(i => h('div.PZ2QoL_rpLeftLine', null,
                h('span.n', { text: trunc(i.label || 'animal', 22) }),
                h('div.PZ2QoL_kpFlex'),
                h('div.PZ2QoL_rpStep.mini', { text: '−', title: '5% lower', onClick: ctx.guard('Left price', () => setLeftPrice(i.guid, nicePrice(i.next * 0.95))) }),
                h('span.p', { text: fmtInt(i.next) }),
                h('div.PZ2QoL_rpStep.mini', { text: '+', title: '5% higher', onClick: ctx.guard('Left price', () => setLeftPrice(i.guid, nicePrice(i.next * 1.05))) }))),
            left.length > 6 ? h('div.PZ2QoL_rpLeftLine', { text: `and ${left.length - 6} more` }) : null));
        if (qm) {
            card.appendChild(ctx.btn(`${qm.label} the ${left.length} again`, qm.cash ? 'Icon_Cash_Symbol' : 'Icon_ConservationCredits', async () => {
                const r = await quickLeft();
                if (!r.ok && !r.pending && r.message) say(r.message, 'warn');
            }, { cls: `quick.wide${isListingBusy() ? '.disabled' : ''}`, tint: 'white', title: `${qm.label} them, one at a time (each checked again; the run stops at anything unexpected). Permanent.` }));
        }
        card.appendChild(ctx.btn(`List the ${left.length} again${qm ? ' (prices above)' : ''}`, 'IconTrade', async () => {
            const r = await relistLeft();
            if (!r.ok && !r.pending && r.message) say(r.message, 'warn');
        }, { cls: `primary.wide${isListingBusy() ? '.disabled' : ''}`, tint: 'white', title: 'Lists them again at the prices shown, one at a time' }));
    }
    // a line per listing (failures first)
    const lines = run.items.slice().sort((x, y) => lineRank(x) - lineRank(y));
    for (const i of lines.slice(0, active ? 6 : 8)) {
        const { cls, text, title } = itemLine(i);
        card.appendChild(h(`div.PZ2QoL_mdRunLine.${cls}`, { text, title: title || text }));
    }
    if (lines.length > (active ? 6 : 8)) card.appendChild(h('div.PZ2QoL_mdRunLine', { text: `and ${lines.length - (active ? 6 : 8)} more` }));
    if (!active && !left.length) {
        card.appendChild(ctx.btn('Dismiss', null, () => {
            dismissReprice();
            rerender();
        }, { cls: 'small' }));
    }
    return card;
}

function lineRank(i) {
    if (i.on === 'working' || i.off === 'working') return 0;
    if (i.off === 'unlisted' && i.on && i.on !== 'listed' && i.on !== 'pending') return 1;
    if (i.off && i.off !== 'unlisted' && i.off !== 'pending') return 2;
    if (i.on === 'listed') return 4;
    return 3;
}

function itemLine(i, run = getReprice()) {
    const name = trunc(i.label || 'animal', 24);
    const qm = run && QUICK_MODES[run.action];
    if (i.on === 'traded' || i.on === 'released') return { cls: 'ok', text: `✓ ${name} · ${i.on === 'traded' ? 'quick-traded' : 'released'}${i.soldFor ? ` · ${quickMoney(i.on === 'traded' ? 'quicktrade' : 'release', i.soldFor, fmtInt)}` : ''}` };
    if (i.on === 'unconfirmed') return { cls: 'no', text: `? ${name} · sent, not confirmed: check storage`, title: i.onWhy };
    if (qm && i.on === 'working') return { cls: 'now', text: `… ${name} · ${qm.working.toLowerCase()}` };
    if (qm && i.off === 'unlisted' && i.on && i.on !== 'pending' && i.on !== 'listed') return { cls: 'no', text: `! ${name} · off the market, not sold: ${i.onWhy || i.on}`, title: i.onWhy };
    if (qm && i.off === 'unlisted' && i.on !== 'listed') return { cls: '', text: `· ${name} · off, to ${qm.label.toLowerCase()}` };
    if (i.on === 'listed') {
        const p = i.listedPrice || i.next;
        return { cls: 'ok', text: `✓ ${name} · ${fmtInt(i.old)} → ${fmtInt(p)} CC${i.capped ? ` (game ${i.capped})` : ''}` };
    }
    if (i.on === 'working') return { cls: 'now', text: `… ${name} · listing at ${fmtInt(i.next)} CC` };
    if (i.off === 'working') return { cls: 'now', text: `… ${name} · taking it off` };
    if (i.off === 'unlisted' && i.on && i.on !== 'pending') return { cls: 'no', text: `! ${name} · off the market, not listed again`, title: i.onWhy };
    if (i.off === 'unlisted') return { cls: '', text: `· ${name} · off, to list at ${fmtInt(i.next)} CC` };
    if (i.off === 'pending') {
        return repriceActive() ? { cls: '', text: `· ${name} · ${fmtInt(i.old)} → ${fmtInt(i.next)} CC` }
            : { cls: '', text: `· ${name} · not reached: still listed at ${fmtInt(i.old)} CC` };
    }
    return { cls: 'no', text: `✕ ${name} · not taken off: ${i.offWhy || i.off}`, title: `Still listed at its old price (${fmtInt(i.old)} CC). ${i.offWhy || ''}` };
}

// ------------------------------------------------------------- the sheet

function renderSheet(ctx) {
    let el = V.sheetEl;
    if (!el || el.parentNode !== ctx.root) {
        el = h('div.PZ2QoL_mdSheet.PZ2QoL_rpSheet.hidden');
        for (const ev of ['mousedown', 'click', 'wheel']) el.addEventListener(ev, e => e.stopPropagation());
        ctx.root.appendChild(el);
        V.sheetEl = el;
    }
    const s = V.sheet;
    setClass(el, 'hidden', !s);
    clear(el);
    if (!s) return;
    if (s.quick) return quickSheetEl(ctx, el, s);
    const p = s.plan;
    const n = p.ready.length;
    const secs = repriceSeconds(n, ctx.paceMs || 3000);
    const card = h('div.PZ2QoL_mdSheetCard.PZ2QoL_rpSheetCard');
    card.appendChild(h('div.PZ2QoL_rpSheetTitle', { text: `Reprice ${n} listing${n === 1 ? '' : 's'}` }));
    card.appendChild(h('div.PZ2QoL_rpSheetSteps', null,
        h('div.PZ2QoL_rpSheetStep', null, h('span.i', { text: '1' }), h('span', { text: `Take all ${n} off the market, one at a time, each confirmed by the game.` })),
        h('div.PZ2QoL_rpSheetStep', null, h('span.i', { text: '2' }), h('span', { text: 'Wait a few seconds for them to be back in storage.' })),
        h('div.PZ2QoL_rpSheetStep', null, h('span.i', { text: '3' }), h('span', { text: `List them again at the new prices for ${V.hours === 'max' ? 'the longest time' : "the game's default time"}, one at a time.` }))));
    const diff = p.newTotal - p.oldTotal;
    card.appendChild(h('div.PZ2QoL_rpSheetTotals', null,
        h('span', { text: `Asking ${fmtInt(p.oldTotal)} → ${fmtInt(p.newTotal)} CC` }),
        h(`span.d${diff < 0 ? '.down' : diff > 0 ? '.up' : ''}`, { text: ` (${diff < 0 ? '−' : '+'}${fmtInt(Math.abs(diff))})` }),
        h('div.PZ2QoL_kpFlex'),
        h('span.t', { text: `about ${Math.max(1, Math.round(secs / 60))} min` })));
    const list = makeScroll('rpSheetList');
    for (const i of p.ready) {
        list.content.appendChild(h('div.PZ2QoL_rpSheetLine', { title: i.why },
            h('span.n', { text: labelOfRow(i.row) }),
            h('div.PZ2QoL_kpFlex'),
            h('span.o', { text: fmtInt(i.old) }), h('span.a', { text: '→' }),
            h(`span.x${i.change < 0 ? '.down' : i.change > 0 ? '.up' : ''}`, { text: `${fmtInt(i.next)} CC` }),
            h('span.w', { text: i.override ? 'your price' : trunc(i.why, 34) })));
    }
    card.appendChild(list.wrap);
    card.appendChild(h('div.PZ2QoL_rpSheetNote', {
        text: "While a listing is off the market no one can buy it. If the run stops early (your Stop, the server, leaving Animal Storage), the ones already taken off stay in storage, listed under My listings with a button to list them again; nothing is listed again by itself after a Stop.",
    }));
    card.appendChild(h('div.PZ2QoL_rpSheetButtons', null,
        ctx.btn('Cancel', null, closeSheet, { title: 'Nothing is sent (Esc)' }),
        h('div.PZ2QoL_kpFlex'),
        ctx.btn(`Confirm: reprice ${n}`, 'IconTrade', confirmSheet, { cls: 'primary', tint: 'white', title: 'Starts it (Enter)' })));
    el.appendChild(card);
    setTimeout(() => {
        try {
            if (ctx.refreshBox) ctx.refreshBox(list);
        }
        catch (e) {
            // the list still scrolls on the next render
        }
    }, 0);
}

// The confirmation of a quick action on listings: red like the desk's own
// quick sheet; the three steps, each animal with what it asks and fetches,
// who is left out, the permanence.
function quickSheetEl(ctx, el, s) {
    const m = QUICK_MODES[s.action];
    const q = s.quick;
    const n = q.go.length;
    const card = h('div.PZ2QoL_mdSheetCard.PZ2QoL_rpSheetCard.quick');
    card.appendChild(h('div.PZ2QoL_mdSheetHead', { text: m.header }));
    card.appendChild(h('div.PZ2QoL_rpSheetTitle', { text: `${m.label} ${n} listing${n === 1 ? '' : 's'} for ${q.sheet.totalText}?` }));
    card.appendChild(h('div.PZ2QoL_rpSheetSteps', null,
        h('div.PZ2QoL_rpSheetStep', null, h('span.i', { text: '1' }), h('span', { text: `Take all ${n} off the market, one at a time, each confirmed by the game.` })),
        h('div.PZ2QoL_rpSheetStep', null, h('span.i', { text: '2' }), h('span', { text: 'Wait a few seconds for them to be back in storage.' })),
        h('div.PZ2QoL_rpSheetStep', null, h('span.i', { text: '3' }), h('span', { text: `${m.label} each, one at a time, only if the game allows it then.` }))));
    card.appendChild(h('div.PZ2QoL_rpSheetTotals', null,
        h('span', { text: `Asking ${fmtInt(q.asking)} CC → ${m.label} ${q.sheet.totalText}` }),
        h('div.PZ2QoL_kpFlex'),
        h('span.t', { text: `about ${Math.max(1, Math.round(repriceSeconds(n, ctx.paceMs || 3000) / 60))} min` })));
    const list = makeScroll('rpSheetList');
    for (const r of q.go) {
        const price = q.perRow.get(r.guid);
        list.content.appendChild(h('div.PZ2QoL_rpSheetLine', null,
            h('span.n', { text: labelOfRow(r) }), h('div.PZ2QoL_kpFlex'),
            h('span.o', { text: `${fmtInt(r.a.price)} CC` }), h('span.a', { text: '→' }),
            h('span.x', { text: price != null ? quickMoney(s.action, price, fmtInt) : 'priced when off' })));
    }
    for (const x of q.skip) list.content.appendChild(h('div.PZ2QoL_rpSheetLine.skip', { title: x.why }, h('span.n', { text: `Left out: ${labelOfRow(x.r)} · ${x.why}` })));
    card.appendChild(list.wrap);
    card.appendChild(h('div.PZ2QoL_mdSheetWarn', { text: QUICK_WARNING }));
    card.appendChild(h('div.PZ2QoL_rpSheetNote', {
        text: `While a listing is off the market no one can buy it. If the game won't take one, or anything unexpected happens, the run stops; the ones taken off and not sold stay in storage, under My listings, with buttons to ${m.label.toLowerCase()} them again or list them again. Nothing happens by itself after a stop.`,
    }));
    card.appendChild(h('div.PZ2QoL_rpSheetButtons', null,
        ctx.btn('Cancel', null, closeSheet, { title: 'Nothing is sent (Esc)' }),
        h('div.PZ2QoL_kpFlex'),
        ctx.btn(`${m.confirm}: ${n}`, m.cash ? 'Icon_Cash_Symbol' : 'Icon_ConservationCredits', confirmSheet, { cls: 'quick.confirm', tint: 'white', title: 'Starts it (Enter)' })));
    el.appendChild(card);
}
