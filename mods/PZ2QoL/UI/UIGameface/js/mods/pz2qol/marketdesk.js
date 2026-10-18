// Market desk: list storage animals on the Franchise market from one place
// (docs/DESIGN-market-desk.md).
//
//   head    title, how listing works now (the game's own listing call, or
//           the storage screen as a fallback), Close
//   left    species in storage: sellable / on the market
//   middle  the species' animals with their recommended price and state;
//           filters to pick a population (sex, age, fertility, rating, a
//           gene range, what to show; "More filters": per-gene ranges, keep
//           the best N per sex, pregnancy, storage tags, Kin, price, name);
//           the desk's own ticks (it opens with the storage screen's)
//   right   the run: how many, the total, duration, price offset, pace,
//           List N / Stop, progress and results, Retry
//
// The storage list under it is rewritten by the game all the time (every
// listed row's countdown, rebuilds after sales); the desk reads it at most
// once a second, keys its rows by the animal's GUID, and redraws only when
// something it shows changed. Nothing is listed until the player presses
// List; the engine lists one animal at a time and waits for the game.
// Gameface: own DOM under <body>, explicit display:flex, no grid, scroll
// areas from kinpanel.js.
import { childrenOf, STORAGE_DATA, STORAGE_LIST, get, readAnimal } from '/js/mods/pz2qol/game.js';
import {
    adviceFor, buildOffsetControl, checkMarketFor, checkMarketForAll, fingerprint, getMarketCheck, getMultiMarketCheck, getPriceOffset, identityOf, isFranchise,
    isListingBusy, isMultiCheckBusy, isPriceCheckFresh, labelOf, listAnimals, onListerSettingChanged, onMarketCheckChanged, PRICE_CHECK_FRESH_MS,
    stopListing, stopMultiCheck,
} from '/js/mods/pz2qol/lister.js';
import {
    activeFilterCount, basisScore, BLOCK_WORDS, CAUTION_WORDS, deskRows, filterRows, GENE_BASES, GENE_KEYS, normalizeFilters, resetFilters, RESULT_WORDS,
    retryGuids, sortRows, speciesCounts, STEP_WORDS, STORAGE_TAGS, summaryText, tally, tickable, timeLeftText,
} from '/js/mods/pz2qol/listercore.js';
import { capsAgeMs, engineCaps, engineRunning, engineUsable, engineWhyNot, getEngineState, onEngineState, resolveGuids } from '/js/mods/pz2qol/listerlua.js';
import { Gender, Maturity } from '/js/mods/pz2qol/scores.js';
import { medalLabel, MEDALS } from '/js/mods/pz2qol/pricing.js';
import { getStoragePredicates } from '/js/mods/pz2qol/listfilter.js';
import { rangeSlider } from '/js/mods/pz2qol/rangeslider.js';
import { getPriceBook, onPriceBookChanged } from '/js/mods/pz2qol/pricebook.js';
import { paceSlider } from '/js/mods/pz2qol/pace.js';
import { clear, fmtInt, h, setClass, setText, tierOf } from '/js/mods/pz2qol/ui.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { translate } from '/js/common/core/Localisation.js';
import {
    btn as kitBtn, closeButton, closeOtherPanels, makeGuard, makeScroll, placePanel, refreshBars, registerPanel, restoreScroll, speciesName, trunc,
} from '/js/mods/pz2qol/kinpanel.js';

const READ_MS = 1000;
const guard = makeGuard('Market desk');
const btn = (...args) => kitBtn(guard, ...args);

const SEX = { [Gender.Male]: '♂', [Gender.Female]: '♀' };
const SEX_CLASS = { [Gender.Male]: 'male', [Gender.Female]: 'female' };
const STAGE = {
    [Maturity.Infant]: 'Juvenile',
    [Maturity.YoungAdult]: 'Young adult',
    [Maturity.Adult]: 'Adult',
    [Maturity.Elderly]: 'Elderly',
    [Maturity.YoungAdultInfertile]: 'Young adult, infertile',
    [Maturity.AdultInfertile]: 'Adult, infertile',
    [Maturity.ElderlyInfertile]: 'Elderly, infertile',
};
const FILTERS_KEY = 'PZ2QoL.deskFilters';

// The desk's filters, kept for the session (Gameface keeps localStorage for
// the session only; it is a convenience, the desk works without it).
function loadFilters() {
    try {
        const saved = window.localStorage && JSON.parse(window.localStorage.getItem(FILTERS_KEY) || 'null');
        return normalizeFilters(saved);
    }
    catch (e) {
        return normalizeFilters(null);
    }
}

function saveFilters() {
    try {
        if (window.localStorage) window.localStorage.setItem(FILTERS_KEY, JSON.stringify(D.filters));
    }
    catch (e) {
        // session only
    }
}

const CONFIDENCE = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence (few listings)', none: "no market data: the game's own price" };

const D = {
    root: null,
    el: {},
    open: false,
    filters: null,           // normalizeFilters(), loaded on first open
    moreOpen: false,         // "More filters" shown
    ctl: null,               // controls built once (sliders, the name box)
    chosen: new Set(),       // row ids (g<guid>) the player ticked
    pendingKeys: null,       // storage keys to tick once their GUIDs are known
    hours: 'max',
    rows: [],                // deskRows()
    readSig: '',
    lastRead: 0,
    reading: false,
    caps: null,
    timer: 0,
    queued: false,
    unsub: [],
    boxes: {},
    scroll: { rail: 0, list: 0 },
    notice: null,
    offset: null,
    pace: null,
    renderSig: '',
};

function t(s) {
    if (typeof s !== 'string') return s == undefined ? '' : String(s);
    try {
        return translate(s);
    }
    catch (e) {
        return s;
    }
}

function notice(text, tone = 'info') {
    D.notice = { text, tone, until: Date.now() + 9000 };
    queueRender();
}

// ------------------------------------------------------------------ data

// Reads the storage list. Only when something the desk keys on changed
// (an animal arrived, left, or a row now holds another animal) are GUIDs
// asked again; countdown ticks change nothing here.
async function readRows(force = false) {
    if (D.reading) return;
    D.reading = true;
    try {
        const animals = childrenOf(STORAGE_LIST).map(ctx => readAnimal(ctx)).filter(a => a.id != undefined);
        const sig = animals.map(a => `${a.key}:${fingerprint(a)}`).join('|');
        const pageRows = animals.length;
        // ask again while the engine can't be used (it may still be starting,
        // or the list was loading), and every 10 s anyway
        if (force || !D.caps || !engineUsable(D.caps, pageRows) || capsAgeMs() > 10000) D.caps = await engineCaps({ force, maxAgeMs: 1500 });
        let guids = new Map();
        if (engineUsable(D.caps, pageRows)) guids = await resolveGuids(animals.map(identityOf));
        D.rows = deskRows(animals, guids, a => adviceFor(a, {}));
        D.lastRead = Date.now();
        if (sig !== D.readSig) {
            D.readSig = sig;
            // the storage screen's ticks, once their GUIDs are known
            if (D.pendingKeys) {
                const keys = D.pendingKeys;
                D.pendingKeys = null;
                for (const r of D.rows) if (keys.has(r.key) && !r.block) D.chosen.add(r.id);
                const first = D.rows.find(r => D.chosen.has(r.id));
                if (first && !D.filters.species) D.filters = Object.assign({}, D.filters, { species: first.species });
            }
            // ticks of animals no longer in storage go
            const ids = new Set(D.rows.map(r => r.id));
            for (const id of Array.from(D.chosen)) if (!ids.has(id)) D.chosen.delete(id);
        }
        queueRender();
    }
    catch (e) {
        reportError('ui', 'Market desk: reading storage failed', e, { silent: true });
    }
    finally {
        D.reading = false;
    }
}

// What filterRows needs from the page: Kin's "close relative in storage"
// (only once Kin has read storage) and the names as the game shows them.
function filterCtx() {
    let related = null;
    try {
        related = getStoragePredicates().related || null;
    }
    catch (e) {
        related = null;
    }
    return { related, nameOf: a => String(t(a.name) || '') };
}

function rowsShown() {
    const f = D.filters;
    return sortRows(filterRows(D.rows, f, filterCtx()), f.sort, f.geneBasis);
}

// A new view drops the ticks it no longer shows: List only ever lists what
// the player can see ticked (in game, ticks of another species stayed and
// were listed with the ones in view).
function setFilters(patch) {
    D.filters = normalizeFilters(Object.assign({}, D.filters, patch));
    D.scroll.list = 0;
    const shown = new Set(rowsShown().map(r => r.id));
    for (const id of Array.from(D.chosen)) if (!shown.has(id)) D.chosen.delete(id);
    saveFilters();
    queueRender();
}

function chosenRows() {
    return D.rows.filter(r => D.chosen.has(r.id));
}

function resultsByGuid() {
    const s = getEngineState();
    const m = new Map();
    if (s) for (const r of s.results) m.set(r.guid, r);
    return m;
}

// --------------------------------------------------------------- actions

function toggleRow(r) {
    if (r.block || isListingBusy()) return;
    if (D.chosen.has(r.id)) D.chosen.delete(r.id);
    else D.chosen.add(r.id);
    queueRender();
}

// Tick: every sellable animal shown, except those tagged Keep in storage
// (unless the Keep tag is filtered for). Untick: every animal shown.
function chooseShown(on) {
    for (const r of rowsShown()) {
        if (on && tickable(r, D.filters)) D.chosen.add(r.id);
        else if (!on) D.chosen.delete(r.id);
    }
    queueRender();
}

async function startListing() {
    if (isListingBusy()) return;
    const rows = chosenRows().filter(r => !r.block);
    if (!rows.length) return notice('Tick the animals to list first.', 'warn');
    const stale = uncheckedSpecies(rows);
    if (stale.length) return notice(`Check market prices first (${stale.length} species not checked in the last ${PRICE_CHECK_FRESH_MS / 60000} minutes).`, 'warn');
    breadcrumb('desk_list');
    const r = await listAnimals(rows.map(x => x.a), { hours: D.hours });
    if (!r.ok) notice(r.message || 'Nothing was listed.', 'warn');
    else if (!r.engine) notice(`Listing through the storage screen (the fallback): ${r.message}`, 'warn');
    else notice(`Listing ${r.count} animal${r.count === 1 ? '' : 's'}, one at a time. You can keep browsing; Stop ends it.`, 'ok');
    queueRender();
}

function retry() {
    const s = getEngineState();
    const again = new Set(retryGuids(s));
    D.chosen.clear();
    for (const r of D.rows) if (r.guid && again.has(r.guid) && !r.block) D.chosen.add(r.id);
    notice(D.chosen.size ? `${D.chosen.size} ticked again. Press List to try them once more.` : 'Nothing to retry: the others are listed or cannot be listed.', D.chosen.size ? 'ok' : 'info');
}

// ---------------------------------------------------------------- render

function ensureRoot() {
    if (D.root && D.root.parentNode) return D.root;
    const el = D.el;
    el.sub = h('div.PZ2QoL_mdSub');
    el.engine = h('div.PZ2QoL_mdEngine');
    el.rail = h('div.PZ2QoL_mdRail');
    el.main = h('div.PZ2QoL_mdMain');
    el.side = h('div.PZ2QoL_mdSide');
    el.notice = h('div.PZ2QoL_mdNotice.hidden');
    el.status = h('div.PZ2QoL_kpStatus');
    const head = h('div.PZ2QoL_kpHead', null,
        h('div.PZ2QoL_kpLogo.desk'),
        h('div.PZ2QoL_kpTitles', null, h('div.PZ2QoL_kpTitle', { text: 'Market desk' }), el.sub),
        h('div.PZ2QoL_kpFlex'),
        el.engine,
        btn('Read storage again', 'Icon_CircleWithArrows', () => {
            readRows(true);
            notice('Reading Animal Storage again…');
        }, { title: 'Read the animals and what the game-side engine can do again' }),
        closeButton(guard, 'Close (Esc)', () => closeMarketDesk()));
    D.offset = buildOffsetControl();
    D.pace = paceSlider('lister');
    const root = h('div.PZ2QoL_md.hidden', null,
        head,
        el.notice,
        h('div.PZ2QoL_mdBody', null, el.rail, el.main, el.side),
        h('div.PZ2QoL_kpFoot', null,
            h('div.PZ2QoL_mdRules', { text: "Nothing is listed until you press List · one animal at a time, each confirmed by the game · a pause between listings · Stop any time" }),
            h('div.PZ2QoL_kpFlex'), el.status));
    root.addEventListener('mousedown', e => e.stopPropagation());
    root.addEventListener('click', e => e.stopPropagation());
    root.addEventListener('wheel', e => {
        e.preventDefault();
        e.stopPropagation();
    });
    // a dim layer over Animal Storage while the desk is open: the engine
    // selects each animal there before listing it (the game gives the price
    // limits only for the selection), and the storage screen need not be
    // watched or used meanwhile
    const scrim = h('div.PZ2QoL_mdScrim.hidden');
    for (const ev of ['mousedown', 'click', 'wheel']) scrim.addEventListener(ev, e => {
        e.preventDefault();
        e.stopPropagation();
    });
    document.body.appendChild(scrim);
    document.body.appendChild(root);
    D.scrim = scrim;
    D.root = root;
    return root;
}

function queueRender() {
    if (!D.open || D.queued) return;
    D.queued = true;
    setTimeout(() => {
        D.queued = false;
        renderAll();
    }, 0);
}

function renderAll(force = false) {
    if (!D.root || !D.open) return;
    try {
        // while a run selects animals in Animal Storage, nothing of it shows
        if (D.scrim) setClass(D.scrim, 'solid', engineRunning());
        const s = getEngineState();
        const sig = JSON.stringify([
            D.rows.map(r => [r.id, r.block, r.caution, r.advice.price, r.advice.confidence, Math.ceil((r.a.auctionTimerSeconds || 0) / 300)]),
            Array.from(D.chosen), D.filters, D.moreOpen, !!filterCtx().related, D.hours, D.caps && [D.caps.ok, D.caps.rows, D.caps.storage], getPriceOffset(), isFranchise(),
            s && [s.run, s.phase, s.index, s.step, Math.round(s.waited || 0), s.results.map(r => r.status + r.kind).join(',')],
            D.notice && D.notice.until > Date.now() ? D.notice.text : '', isListingBusy(), getPriceBook().length,
            (getMarketCheck() || {}).message, (getMultiMarketCheck() || {}).message, uncheckedSpecies(chosenRows().filter(r => !r.block)).join(','),
        ]);
        if (!force && sig === D.renderSig) return;
        D.renderSig = sig;
        renderHead();
        renderNotice();
        renderRail();
        renderMain();
        renderSide();
        setTimeout(() => refreshBars(D.boxes), 0);
    }
    catch (e) {
        reportError('ui', 'Market desk: drawing failed', e, { silent: true });
    }
}

function renderHead() {
    const el = D.el;
    const pageRows = D.rows.length;
    const usable = engineUsable(D.caps, pageRows);
    const counts = speciesCounts(D.rows);
    const sellable = counts.reduce((n, c) => n + c.sellable, 0);
    const listed = counts.reduce((n, c) => n + c.listed, 0);
    setText(el.sub, isFranchise()
        ? `${fmtInt(D.rows.length)} animals in storage · ${fmtInt(sellable)} sellable · ${fmtInt(listed)} on the market`
        : 'Listing animals is only available in Franchise mode.');
    clear(el.engine);
    if (!D.caps) return;
    el.engine.appendChild(h(`div.PZ2QoL_mdEnginePill.${usable ? 'ok' : 'fallback'}`, {
        text: usable ? "Direct: the game's own listing call" : 'Fallback: the storage screen',
        title: usable
            ? 'Each animal is found by its id, selected and listed by the mod inside Animal Storage, with the same call the game\'s Trade → Confirm makes, and checked again just before sending.'
            : `${engineWhyNot(D.caps, pageRows)} Listing still works, through the storage screen's own buttons, one animal at a time.`,
    }));
}

function renderNotice() {
    const n = D.notice;
    const el = D.el.notice;
    const show = n && n.until > Date.now();
    setClass(el, 'hidden', !show);
    if (!show) return;
    el.className = `PZ2QoL_mdNotice ${n.tone}`;
    setText(el, n.text);
    setTimeout(queueRender, Math.max(0, n.until - Date.now()) + 50);
}

function renderRail() {
    const el = D.el.rail;
    const y = D.scroll.rail;
    clear(el);
    const box = makeScroll('mdRail', { onScroll: (x, yy) => { D.scroll.rail = yy; } });
    D.boxes.rail = box;
    const counts = speciesCounts(D.rows);
    const all = { species: null, total: D.rows.length, sellable: counts.reduce((n, c) => n + c.sellable, 0), listed: counts.reduce((n, c) => n + c.listed, 0) };
    for (const c of [all].concat(counts)) {
        const on = (D.filters.species || null) === c.species;
        const chosen = D.rows.filter(r => D.chosen.has(r.id) && (c.species === null || r.species === c.species)).length;
        box.content.appendChild(h(`div.PZ2QoL_mdSpecies${on ? '.on' : ''}`, {
            'data-species': c.species || '',
            title: c.species ? t(c.species) : 'Every species in storage',
            // a price range belongs to one species' prices
            onClick: guard('Species', () => setFilters(c.species === D.filters.species ? {} : { species: c.species, priceMin: 0, priceMax: 0 })),
        },
            h('div.PZ2QoL_mdSpeciesName', { text: c.species ? trunc(t(c.species) || speciesName(c.species), 22) : 'All species' }),
            h('div.PZ2QoL_mdSpeciesMeta', null,
                h('span.sell', { text: `${c.sellable} sellable` }),
                c.listed ? h('span.listed', { text: `${c.listed} listed` }) : null,
                chosen ? h('span.chosen', { text: `${chosen} ticked` }) : null)));
    }
    el.appendChild(box.wrap);
    restoreScroll(box, 0, y);
}

function segmented(label, value, options, onPick, title) {
    return h('div.PZ2QoL_mdSeg', { title: title || undefined },
        h('span.PZ2QoL_mdSegLabel', { text: label }),
        options.map(([v, text]) => h(`div.PZ2QoL_mdSegItem${v === value ? '.on' : ''}`, { 'data-value': v, text, onClick: guard(label, () => onPick(v)) })));
}

// Several values at once: "Any" clears them.
function multiSeg(label, values, options, onChange, title) {
    const on = new Set(values);
    return h('div.PZ2QoL_mdSeg', { title: title || undefined },
        h('span.PZ2QoL_mdSegLabel', { text: label }),
        h(`div.PZ2QoL_mdSegItem${on.size ? '' : '.on'}`, { 'data-value': 'any', text: 'Any', onClick: guard(label, () => onChange([])) }),
        options.map(([v, text, tip]) => h(`div.PZ2QoL_mdSegItem${on.has(v) ? '.on' : ''}`, {
            'data-value': String(v), text, title: tip || undefined,
            onClick: guard(label, () => {
                const next = new Set(on);
                if (next.has(v)) next.delete(v);
                else next.add(v);
                onChange(Array.from(next));
            }),
        })));
}

const pctText = (lo, hi) => (lo <= 0 && hi >= 100 ? 'All' : lo <= 0 ? `≤ ${hi}` : hi >= 100 ? `≥ ${lo}` : `${lo}–${hi}`);

// The highest recommended price in view, rounded up: the price slider's end.
function priceCeil() {
    const f = D.filters;
    let max = 0;
    for (const r of D.rows) if ((!f.species || r.species === f.species) && r.advice && r.advice.price > max) max = r.advice.price;
    return Math.max(1000, Math.ceil(max / 500) * 500, f.priceMin, f.priceMax);
}

// Built once and kept: a re-render must not interrupt a drag or typing.
function controls() {
    if (D.ctl) return D.ctl;
    const c = {};
    c.genes = rangeSlider({
        bounds: () => [0, 100],
        get: () => [D.filters.geneMin, D.filters.geneMax],
        set: (lo, hi) => setFilters({ geneMin: lo, geneMax: hi }),
        fmt: pctText,
        title: 'Gene range: drag the ends (or click the track). 0–50 shows the weakest half, e.g. to sell them and keep the rest.',
    });
    for (const k of GENE_KEYS) {
        c[k] = rangeSlider({
            bounds: () => [0, 100],
            get: () => [D.filters[k + 'Min'], D.filters[k + 'Max']],
            set: (lo, hi) => setFilters({ [k + 'Min']: lo, [k + 'Max']: hi }),
            fmt: pctText,
            cls: 'small',
            title: `${GENE_BASES[k]} gene range (animals without this gene, such as shoals, are left out once it is set)`,
        });
    }
    c.price = rangeSlider({
        bounds: () => [0, priceCeil()],
        get: () => [D.filters.priceMin, D.filters.priceMax || priceCeil()],
        set: (lo, hi) => setFilters({ priceMin: lo, priceMax: hi >= priceCeil() ? 0 : hi }),
        step: 50,
        fmt: (lo, hi, [, max]) => (lo <= 0 && hi >= max ? 'Any' : `${fmtInt(lo)}–${hi >= max ? 'max' : fmtInt(hi)}`),
        cls: 'small',
        title: 'Recommended price range, CC (the desk\'s price; the game\'s limits still apply when listing)',
    });
    const text = h('input.PZ2QoL_mdText', { type: 'text', placeholder: 'Name contains…', maxlength: '40' });
    text.addEventListener('input', () => {
        clearTimeout(c.textTimer);
        c.textTimer = setTimeout(() => setFilters({ text: text.value }), 250);
    });
    // typing goes to the box, not to the game's shortcuts (Esc still closes)
    text.addEventListener('keydown', e => {
        if (e.key !== 'Escape' && e.keyCode !== 27) e.stopPropagation();
    });
    c.text = text;
    D.ctl = c;
    return c;
}

function geneBar(f) {
    const c = controls();
    c.genes.__update();
    const basis = f.geneBasis === 'overall' ? 'Genes' : `Genes · ${GENE_BASES[f.geneBasis]}`;
    const preset = (label, lo, hi, tip) => h(`div.PZ2QoL_mdSegItem${f.geneMin === lo && f.geneMax === hi ? '.on' : ''}`, {
        text: label, title: tip, onClick: guard('Genes', () => setFilters({ geneMin: lo, geneMax: hi })),
    });
    return h('div.PZ2QoL_mdSeg.genes', { title: f.geneBasis === 'overall' ? 'The average of the genes that count for the animal (the Genes column)' : `By ${GENE_BASES[f.geneBasis].toLowerCase()} (set under More filters)` },
        h('span.PZ2QoL_mdSegLabel', { text: basis }),
        c.genes,
        preset('≤ 40', 0, 40, 'Genes 40 and below'),
        preset('≤ 50', 0, 50, 'Genes 50 and below: the weakest half'),
        preset('≥ 70', 70, 100, 'Genes 70 and above'),
        preset('All', 0, 100, 'Any genes'));
}

function moreFilters(f, ctx) {
    const c = controls();
    const box = h('div.PZ2QoL_mdMore');
    const col = (title, ...kids) => h('div.PZ2QoL_mdMoreCol', null, h('div.PZ2QoL_mdMoreTitle', { text: title }), kids);
    const geneRow = k => {
        c[k].__update();
        return h('div.PZ2QoL_mdMoreRow', null, h('span.PZ2QoL_mdMoreLabel', { text: GENE_BASES[k] }), c[k]);
    };
    const top = h('div.PZ2QoL_mdMoreLine');
    top.appendChild(col('Genes',
        segmented('By', f.geneBasis, Object.entries(GENE_BASES), v => setFilters({ geneBasis: v }),
            'What the gene range, Keep the best and the gene sort use: the average (Overall), the breeding score (fertility, longevity, immunity) or one gene'),
        h('div.PZ2QoL_mdGeneGrid', null,
            h('div.PZ2QoL_mdMoreCol', null, geneRow('size'), geneRow('longevity')),
            h('div.PZ2QoL_mdMoreCol', null, geneRow('fertility'), geneRow('immunity')))));
    const keep = f.keepBest;
    c.price.__update();
    // the box shows the filter (after Reset, or one kept from earlier)
    if (document.activeElement !== c.text && c.text.value !== f.text) c.text.value = f.text;
    top.appendChild(col('Population',
        h('div.PZ2QoL_mdSeg.stepper', { title: 'Shows only what is left after the best N males and the best N females of each species (by the gene choice under Genes · By); animals on the market are not counted. Tick all, then List: you keep the best.' },
            h('span.PZ2QoL_mdSegLabel', { text: 'Keep the best' }),
            h('div.PZ2QoL_mdSegItem', { text: '−', onClick: guard('Keep', () => setFilters({ keepBest: Math.max(0, keep - 1) })) }),
            h('span.PZ2QoL_mdStepValue', { text: keep ? `${keep} ♂ + ${keep} ♀` : 'Off' }),
            h('div.PZ2QoL_mdSegItem', { text: '+', onClick: guard('Keep', () => setFilters({ keepBest: Math.min(99, keep + 1) })) })),
        segmented('Pregnant', f.pregnant, [['any', 'Any'], ['hide', 'Hide'], ['only', 'Only']], v => setFilters({ pregnant: v }), 'The game may refuse to list a pregnant animal'),
        ctx.related || f.kin !== 'any'
            ? segmented('Kin', f.kin, [['any', 'Any'], ['related', 'Has kin'], ['unrelated', 'No kin']], v => setFilters({ kin: v }),
                'A close relative of the same species in storage (from the family records the game keeps; Kin reads them when Animal Storage opens)')
            : h('div.PZ2QoL_mdSeg.off', { title: 'Kin has not read the family records of storage yet (turn Kin on, or reopen Animal Storage)' },
                h('span.PZ2QoL_mdSegLabel', { text: 'Kin' }), h('span.PZ2QoL_mdSegNote', { text: 'not read yet' }))));
    box.appendChild(top);
    box.appendChild(h('div.PZ2QoL_mdMoreLine.other', null,
        multiSeg('Tag', f.tags, Object.entries(STORAGE_TAGS).map(([v, l]) => [Number(v), l]), v => setFilters({ tags: v }),
            'The tag set on the animal in Animal Storage. Tick all leaves Keep-tagged animals alone unless Keep is picked here.'),
        h('div.PZ2QoL_mdMoreRow', null, h('span.PZ2QoL_mdMoreLabel.short', { text: 'Price' }), c.price),
        h('div.PZ2QoL_mdMoreRow', null, h('span.PZ2QoL_mdMoreLabel.short', { text: 'Name' }), c.text)));
    return box;
}

// The species of these rows whose market prices were not checked lately,
// most animals first. List waits for them.
function uncheckedSpecies(rows) {
    const n = new Map();
    for (const r of rows) if (!isPriceCheckFresh(r.species)) n.set(r.species, (n.get(r.species) || 0) + 1);
    return Array.from(n.keys()).sort((x, y) => n.get(y) - n.get(x));
}

// Check market prices, right above List: for the ticked animals' species
// (or, with nothing ticked, the species picked on the left). List is only
// possible once each of them was checked in the last 30 minutes.
function priceCheckCard(listable) {
    const multi = getMultiMarketCheck();
    const check = getMarketCheck();
    const checking = check && (check.state === 'starting' || check.state === 'loading' || check.state === 'reading');
    const busy = isListingBusy();
    const pick = listable.length ? Array.from(new Set(listable.map(r => r.species))) : (D.filters.species ? [D.filters.species] : []);
    const stale = listable.length ? uncheckedSpecies(listable) : pick.filter(sp => !isPriceCheckFresh(sp));
    const card = h(`div.PZ2QoL_mdPriceCheck${stale.length && listable.length ? '.needed' : ''}`);
    let status = '';
    let tone = '';
    if (isMultiCheckBusy()) {
        card.appendChild(btn('Stop checking', 'Icon_Close', () => stopMultiCheck(), { cls: 'wide', title: 'Stops after the species being checked now' }));
        status = (multi && multi.message) || 'Checking…';
        tone = 'reading';
    }
    else if (checking) {
        card.appendChild(btn('Checking market…', 'IconSearch', () => {}, { cls: 'wide.disabled' }));
        status = (check && check.message) || 'Checking…';
        tone = 'reading';
    }
    else if (!pick.length) {
        status = 'Tick animals, then check their market prices here before listing.';
    }
    else {
        const todo = stale.length ? stale : pick;
        const label = stale.length
            ? (todo.length === 1 ? 'Check market prices' : `Check market prices (${todo.length} species)`)
            : 'Check prices again';
        card.appendChild(btn(label, 'IconSearch', () => (todo.length === 1 ? checkMarketFor(todo[0]) : checkMarketForAll(todo)), {
            cls: `wide${stale.length ? '.attention' : ''}${busy ? '.disabled' : ''}`,
            title: "Loads the current Market listings of these species (all pages) in the background, one species after another, so the recommended prices follow today's market. The screen stays on Animal Storage.",
        }));
        if (stale.length) {
            status = listable.length
                ? `Needed before listing: ${stale.length} of ${pick.length} species not checked in the last ${PRICE_CHECK_FRESH_MS / 60000} minutes.`
                : `Not checked in the last ${PRICE_CHECK_FRESH_MS / 60000} minutes.`;
            tone = listable.length ? 'warn' : '';
        }
        else {
            status = `✓ Prices checked for ${pick.length === 1 ? 'this species' : `all ${pick.length} species`}.`;
            tone = 'ok';
            const last = multi && multi.finished && multi.message ? multi.message : check && check.state !== 'starting' && check.message ? check.message : '';
            if (last) status += ` ${last}`;
        }
    }
    if (status) card.appendChild(h(`div.PZ2QoL_mdPriceStatus${tone ? '.' + tone : ''}`, { text: status, title: status }));
    return card;
}

// A column header that sorts; a second click on Genes flips best/worst.
function sortHead(cls, text, key) {
    const f = D.filters;
    const on = key === 'genes' ? (f.sort === 'best' || f.sort === 'worst') : f.sort === key;
    const arrow = !on ? '' : key === 'genes' ? (f.sort === 'best' ? ' ▼' : ' ▲') : key === 'price' ? ' ▼' : ' ▲';
    return h(`div.PZ2QoL_mdCell.${cls}.sortable${on ? '.on' : ''}`, {
        text: text + arrow,
        title: key === 'genes' ? 'Sort by genes (click again: worst first)' : `Sort by ${text.toLowerCase()}`,
        onClick: guard('Sort', () => setFilters({ sort: key === 'genes' ? (f.sort === 'best' ? 'worst' : 'best') : key })),
    });
}

function renderMain() {
    const el = D.el.main;
    const y = D.scroll.list;
    const c = controls();
    const typing = document.activeElement === c.text;
    clear(el);
    const f = D.filters;
    const ctx = filterCtx();
    const shown = sortRows(filterRows(D.rows, f, ctx), f.sort, f.geneBasis);
    const shownTickable = shown.filter(r => tickable(r, f));
    const counts = activeFilterCount(f);
    const species = f.species;
    const check = getMarketCheck();
    const checking = check && (check.state === 'starting' || check.state === 'loading' || check.state === 'reading');
    el.appendChild(h('div.PZ2QoL_mdTools', null,
        segmented('Sex', f.sex, [['any', 'Any'], ['male', '♂'], ['female', '♀']], v => setFilters({ sex: v })),
        multiSeg('Age', f.ages, [['juvenile', 'Juvenile'], ['young', 'Young'], ['adult', 'Adult'], ['elderly', 'Elderly']], v => setFilters({ ages: v }), 'Pick one or more age stages'),
        segmented('Fertility', f.fertile, [['any', 'Any'], ['yes', 'Fertile'], ['no', 'Infertile']], v => setFilters({ fertile: v }), 'What the game shows: young adults, adults and elderly that can still breed are fertile'),
        multiSeg('Rating', f.medals, MEDALS.map(m => [m, medalLabel(m)]), v => setFilters({ medals: v }), "The game's genetics rating (medal); pick one or more"),
        geneBar(f),
        segmented('Show', f.state, [['any', 'All'], ['sellable', 'Sellable'], ['listed', 'On market'], ['blocked', 'Not sellable']], v => setFilters({ state: v }))));
    const busy = isListingBusy();
    const keepLeft = shown.filter(r => !r.block && !tickable(r, f)).length;
    el.appendChild(h('div.PZ2QoL_mdTools.second', null,
        btn(`Tick all shown (${shownTickable.length})`, null, () => chooseShown(true), {
            cls: shownTickable.length && !busy ? '' : 'disabled',
            title: `Tick every sellable animal shown${keepLeft ? ` (${keepLeft} tagged Keep left alone)` : ''}`,
        }),
        btn('Untick shown', null, () => chooseShown(false), { cls: busy ? 'disabled' : '', title: 'Untick the animals shown' }),
        btn(counts.total ? `Reset (${counts.total})` : 'Reset', null, () => {
            clearTimeout(controls().textTimer);
            controls().text.value = '';
            setFilters(resetFilters(f));
        }, { cls: counts.total ? '' : 'disabled', title: 'All filters back to Any (keeps the species and the sort)' }),
        btn(`More filters${counts.more ? ` (${counts.more})` : ''}`, 'IconSettings', () => {
            D.moreOpen = !D.moreOpen;
            queueRender();
        }, { cls: D.moreOpen || counts.more ? 'on' : '', title: 'Per-gene ranges, keep the best N per sex, pregnancy, storage tags, Kin, price and name' }),
        h('div.PZ2QoL_mdShown', { text: `${fmtInt(shown.length)} of ${fmtInt(species ? D.rows.filter(r => r.species === species).length : D.rows.length)} shown` })));
    if (D.moreOpen) el.appendChild(moreFilters(f, ctx));
    // the table
    const geneHead = f.geneBasis === 'overall' ? 'Genes' : GENE_BASES[f.geneBasis].slice(0, 5);
    el.appendChild(h('div.PZ2QoL_mdRow.head', null,
        h('div.PZ2QoL_mdCell.tick'), h('div.PZ2QoL_mdCell.sex'), sortHead('name', 'Animal', 'name'),
        h('div.PZ2QoL_mdCell.stage', { text: 'Age' }), h('div.PZ2QoL_mdCell.medal', { text: 'Rating' }), sortHead('genes', geneHead, 'genes'),
        sortHead('price', 'Price (CC)', 'price'), h('div.PZ2QoL_mdCell.state', { text: 'State' })));
    const box = makeScroll('mdList', { onScroll: (x, yy) => { D.scroll.list = yy; } });
    D.boxes.list = box;
    const results = resultsByGuid();
    if (!shown.length) {
        box.content.appendChild(h('div.PZ2QoL_mdEmpty', { text: D.rows.length ? 'No animal matches these filters.' : 'No animals in storage (or Animal Storage is still loading).' }));
    }
    for (const r of shown) box.content.appendChild(rowEl(r, results.get(r.guid)));
    el.appendChild(box.wrap);
    restoreScroll(box, 0, y);
    if (typing && D.moreOpen) {
        try {
            c.text.focus();
        }
        catch (e) {
            // typing again works
        }
    }
}

function stateOf(r, res) {
    if (res && res.status !== 'pending') {
        if (res.status === 'working') return { cls: 'working', text: 'Listing…' };
        if (res.status === 'listed') return { cls: 'done', text: `✓ Listed${res.price ? ` ${fmtInt(res.price)} CC` : ''}${res.capped ? ` (game ${res.capped})` : ''}` };
        const why = `${RESULT_WORDS[res.kind] || res.status}${res.detail ? `: ${t(res.detail)}` : ''}`;
        return { cls: res.status === 'refused' ? 'refused' : 'skipped', text: `Not listed · ${why}`, title: why };
    }
    if (r.block === 'listed') return { cls: 'listed', text: `On market${r.a.price ? ` · ${fmtInt(r.a.price)} CC` : ''} · ${timeLeftText(r.a.auctionTimerSeconds)}` };
    if (r.block) return { cls: 'blocked', text: BLOCK_WORDS[r.block] };
    if (res && res.status === 'pending') return { cls: 'queued', text: 'Queued' };
    if (r.caution) return { cls: 'caution', text: CAUTION_WORDS[r.caution] };
    return { cls: 'sellable', text: 'Sellable' };
}

function geneCell(r) {
    const basis = D.filters.geneBasis;
    const v = basisScore(r, basis);
    const g = (r.a.genes || {});
    const pct = x => (typeof x === 'number' ? Math.round(x * 100) : '–');
    return h(`div.PZ2QoL_mdCell.genes.${tierOf(v)}`, {
        text: v == null ? '–' : String(v),
        title: `Size ${pct(g.size)} · Longevity ${pct(g.longevity)} · Fertility ${pct(g.fertility)} · Immunity ${pct(g.immunity)}${basis === 'overall' ? '' : ` (shown: ${GENE_BASES[basis].toLowerCase()})`}`,
    });
}

function rowEl(r, res) {
    const a = r.a;
    const on = D.chosen.has(r.id);
    const st = stateOf(r, res);
    const adv = r.advice;
    return h(`div.PZ2QoL_mdRow${on ? '.on' : ''}${r.block ? '.blocked' : ''}`, {
        'data-id': r.id, 'data-key': a.key,
        onClick: guard('Tick', () => toggleRow(r)),
    },
        h('div.PZ2QoL_mdCell.tick', null, h(`div.PZ2QoL_mdBox${on ? '.on' : ''}${r.block ? '.off' : ''}`)),
        h(`div.PZ2QoL_mdCell.sex.${SEX_CLASS[a.gender] || 'other'}`, { text: SEX[a.gender] || '·' }),
        h('div.PZ2QoL_mdCell.name', { title: `${t(a.species)} · ${t(a.name)}` },
            h('span.PZ2QoL_mdName', { text: trunc(t(a.name), 22) }),
            D.filters.species ? null : h('span.PZ2QoL_mdSpeciesTag', { text: trunc(t(a.species), 16) })),
        h('div.PZ2QoL_mdCell.stage', { text: STAGE[a.maturity] || '–' }),
        h('div.PZ2QoL_mdCell.medal', null, r.medal != undefined ? h(`span.PZ2QoL_medalDot.${r.medal}`, { title: medalLabel(r.medal) }) : h('span', { text: '–' })),
        geneCell(r),
        h(`div.PZ2QoL_mdCell.price.conf_${adv.confidence}`, { title: `${CONFIDENCE[adv.confidence] || ''}${adv.reason ? `: ${adv.reason}` : ''}` },
            h('span', { text: adv.price > 0 ? fmtInt(adv.price) : 'game' }),
            h(`span.PZ2QoL_mdConf.c_${adv.confidence}`)),
        h(`div.PZ2QoL_mdCell.state.${st.cls}`, { text: st.text, title: st.title || st.text }));
}

function renderSide() {
    const el = D.el.side;
    clear(el);
    const s = getEngineState();
    const running = engineRunning();
    const busy = isListingBusy();
    const chosen = chosenRows();
    const listable = chosen.filter(r => !r.block);
    const total = listable.reduce((n, r) => n + (r.advice.price > 0 ? r.advice.price : 0), 0);
    const noPrice = listable.filter(r => !(r.advice.price > 0)).length;
    el.appendChild(h('div.PZ2QoL_mdCardTitle', { text: 'Listing' }));
    el.appendChild(h('div.PZ2QoL_mdBig', null,
        h('span.n', { text: String(listable.length) }),
        h('span.l', { text: `animal${listable.length === 1 ? '' : 's'} ticked` })));
    el.appendChild(h('div.PZ2QoL_mdTotal', { text: listable.length ? `≈ ${fmtInt(total)} CC asked${noPrice ? ` + ${noPrice} at the game's price` : ''}` : 'Tick animals in the list.' }));
    el.appendChild(segmented('Duration', D.hours, [['max', 'Longest'], ['default', 'Game default']], v => {
        D.hours = v;
        queueRender();
    }, "Longest: the most hours the game allows (12 h today). Game default: what the game's own slider starts at (6 h)."));
    D.offset.__update();
    el.appendChild(D.offset);
    el.appendChild(D.pace);
    if (!running) el.appendChild(priceCheckCard(listable));
    if (running) {
        el.appendChild(btn('Stop', 'Icon_Close', () => stopListing(), { cls: 'stop.wide', tint: 'white', title: 'Stops after the current wait; an animal already sent may still appear on the market' }));
    }
    else {
        const stale = uncheckedSpecies(listable);
        const can = listable.length && isFranchise() && !busy && !stale.length;
        el.appendChild(btn(`List ${listable.length} animal${listable.length === 1 ? '' : 's'}`, 'IconTrade', startListing, {
            cls: `primary.wide${can ? '' : '.disabled'}`, tint: 'white',
            title: !isFranchise() ? 'Franchise only' : busy ? 'A listing or market check is running'
                : stale.length ? 'Check market prices first (the button above)' : 'Lists the ticked animals at their recommended prices, one at a time',
        }));
    }
    if (s) el.appendChild(runCard(s));
}

function runCard(s) {
    const tl = tally(s);
    const processed = tl.total - tl.pending - tl.working;
    const pct = tl.total ? Math.round(processed / tl.total * 100) : 0;
    const running = s.phase === 'running';
    const cur = s.results[s.index];
    const card = h(`div.PZ2QoL_mdRun.${running ? 'running' : s.phase}`);
    card.appendChild(h('div.PZ2QoL_mdRunHead', null,
        h('span', { text: running ? 'Listing…' : s.phase === 'done' ? 'Finished' : s.phase === 'closed' ? 'Stopped: storage closed' : 'Stopped' }),
        h('div.PZ2QoL_kpFlex'),
        h('span.PZ2QoL_mdRunCount', { text: `${tl.listed}/${tl.total} listed` })));
    card.appendChild(h('div.PZ2QoL_mdProgress', null, h('div.PZ2QoL_mdProgressFill', { style: { width: `${pct}%` } })));
    if (running && cur) {
        card.appendChild(h('div.PZ2QoL_mdRunNow', { text: `${labelOf(cur.guid)}` }));
        card.appendChild(h('div.PZ2QoL_mdRunStep', { text: `${STEP_WORDS[s.step] || s.message || 'Working…'}${s.waited >= 2 ? ` (${Math.round(s.waited)}s)` : ''}` }));
    }
    else {
        card.appendChild(h('div.PZ2QoL_mdRunStep', { text: summaryText(s, fmtInt) }));
        const again = retryGuids(s).length;
        if (again) card.appendChild(btn(`Tick the ${again} to retry`, null, retry, { cls: 'small', title: 'Ticks the animals that were not listed for a passing reason (server busy, refused, no confirmation, stopped)' }));
    }
    const recent = s.results.filter(r => r.status !== 'pending' && r.status !== 'working').slice(-5).reverse();
    for (const r of recent) {
        const ok = r.status === 'listed';
        const text = ok ? `${labelOf(r.guid)} · ${fmtInt(r.price || 0)} CC` : `${labelOf(r.guid)} · ${RESULT_WORDS[r.kind] || r.status}`;
        card.appendChild(h(`div.PZ2QoL_mdRunLine.${ok ? 'ok' : 'no'}`, { text: `${ok ? '✓' : '·'} ${text}`, title: r.detail ? `${text} (${t(r.detail)})` : text }));
    }
    return card;
}

// ------------------------------------------------------------- open/close

function storageOpen() {
    const n = document.querySelector('.AnimalMarketStorage_header');
    if (!n) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

// opts.keys: storage row keys to tick (the storage screen's selection).
export function openMarketDesk(opts = {}) {
    try {
        ensureRoot();
        if (!D.filters) D.filters = loadFilters();
        closeOtherPanels('desk');
        let keys = Array.isArray(opts.keys) ? opts.keys : null;
        if (!keys) {
            const sel = get(STORAGE_DATA, 'selectedAnimalIDs');
            keys = Array.isArray(sel) ? sel.slice() : [];
        }
        if (keys.length) {
            D.chosen.clear();
            D.pendingKeys = new Set(keys.map(String));
            D.readSig = '';
        }
        D.open = true;
        setClass(D.root, 'hidden', false);
        setClass(D.scrim, 'hidden', false);
        placePanel(D.root);
        breadcrumb('desk_open');
        if (!D.unsub.length) {
            D.unsub.push(onEngineState(() => queueRender()));
            D.unsub.push(onPriceBookChanged(() => {
                D.readSig = '';
                readRows(false);
            }));
            D.unsub.push(onMarketCheckChanged(() => queueRender()));
            D.unsub.push(onListerSettingChanged(() => {
                D.readSig = '';
                readRows(false);
            }));
        }
        clearInterval(D.timer);
        D.timer = setInterval(() => {
            if (!D.open) return;
            if (!storageOpen()) {
                closeMarketDesk();
                return;
            }
            readRows(false);
        }, READ_MS);
        readRows(true);
        renderAll(true);
        return true;
    }
    catch (e) {
        reportError('ui', 'Market desk could not open', e);
        return false;
    }
}

export function closeMarketDesk() {
    try {
        D.open = false;
        clearInterval(D.timer);
        D.timer = 0;
        for (const off of D.unsub) off();
        D.unsub = [];
        if (D.root) setClass(D.root, 'hidden', true);
        if (D.scrim) setClass(D.scrim, 'hidden', true);
        // a run keeps going: it lives in the game-side engine
    }
    catch (e) {
        reportError('ui', 'Market desk could not close', e, { silent: true });
    }
    return true;
}

export function isMarketDeskOpen() {
    return D.open;
}

let installed = false;
export function installMarketDesk() {
    if (installed) return true;
    installed = true;
    document.addEventListener('keydown', e => {
        if (!D.open || (e.key !== 'Escape' && e.keyCode !== 27)) return;
        e.preventDefault();
        e.stopPropagation();
        closeMarketDesk();
    }, true);
    window.addEventListener('resize', () => {
        if (!D.open) return;
        placePanel(D.root);
        setTimeout(() => refreshBars(D.boxes), 0);
    });
    return true;
}

registerPanel('desk', { open: openMarketDesk, close: closeMarketDesk, isOpen: isMarketDeskOpen });
