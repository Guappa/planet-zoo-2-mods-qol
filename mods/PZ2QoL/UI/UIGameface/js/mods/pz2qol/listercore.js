// Market desk: the pure parts (Node tests). What each storage animal can
// do on the market, the desk's rows and counts, the job text the Lua
// listing engine reads, and what its results mean.
// See docs/DESIGN-market-desk.md.
import { Gender, Maturity, breederScore, geneScore, isOnMarket, relevantGenes } from './scores.js';
import { medalOf, MEDALS } from './pricing.js';

// Why the engine would not list an animal, from what its row shows. The
// game's own check (tradeAllowed, for the selected animal) still has the
// last word; these never reach the server.
export const BLOCK_WORDS = Object.freeze({
    listed: 'On the market',
    moving: 'Being moved',
    juvenile: 'Juvenile',
    elderly: 'Elderly, no longer fertile',
});

// Shown but not blocked: the game may refuse these (its rule is native).
export const CAUTION_WORDS = Object.freeze({
    pregnant: 'Pregnant: the game may refuse',
    infertile: 'Infertile: the game may refuse',
});

export function blockOf(a) {
    if (isOnMarket(a)) return 'listed';
    if (a.isMoving) return 'moving';
    if (a.maturity == Maturity.Infant) return 'juvenile';
    if (a.maturity == Maturity.ElderlyInfertile) return 'elderly';
    return null;
}

export function cautionOf(a) {
    if (a.isPregnant) return 'pregnant';
    if (a.maturity == Maturity.YoungAdultInfertile || a.maturity == Maturity.AdultInfertile) return 'infertile';
    return null;
}

// "7h 20m left", "45m left", "<1m left"
export function timeLeftText(seconds) {
    if (!(seconds > 0)) return '';
    const m = Math.floor(seconds / 60);
    if (m < 1) return '<1m left';
    const h = Math.floor(m / 60);
    return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''} left` : `${m}m left`;
}

// What the engine's result kinds mean on a row and in the summary.
export const RESULT_WORDS = Object.freeze({
    gone: 'no longer in storage',
    listed: 'already on the market',
    moving: 'being moved',
    elderly: 'elderly and no longer fertile',
    juvenile: 'juvenile',
    untradeable: "the game doesn't allow trading it",
    unselectable: "the game didn't select it",
    changed: 'the list changed just before sending',
    busy: 'the server stayed busy',
    noprice: 'no price',
    refused: 'refused by the server',
    timeout: 'no confirmation in time',
    stopped: 'stopped (it may still appear on the market)',
    error: 'an error in the mod',
    closed: 'Animal Storage was closed',
});

export const STEP_WORDS = Object.freeze({
    server: 'Waiting for the server to be free…',
    resolve: 'Finding it in storage…',
    select: 'Selecting it…',
    selected: "Reading the game's price limits…",
    send: 'Sending the listing…',
    confirm: 'Waiting for the game to confirm…',
    pause: 'Pausing before the next one…',
});

// What a storage row holds (keys are positions: a rebuilt list gives a key
// another animal, and this tells them apart).
export function rowFingerprint(a) {
    const g = a.genes || {};
    return [a.species, a.name, a.gender, g.size, g.longevity, g.fertility, g.immunity].join('|');
}

// GUIDs as the engine prints them: decimal, or another plain token.
export const GUID_TOKEN = /^[A-Za-z0-9_.:-]+$/;

// A row of the desk: the storage animal plus its GUID (from Lua), price
// advice and state. Without a GUID the id also carries what the row holds,
// so a tick can never move to another animal when the list is rebuilt.
//   rows    readAnimal() objects from the storage list
//   guids   Map row key -> GUID string (Lua); missing: not resolved yet
//   advise  a => { price, confidence, reason } (pricing.js)
export function deskRows(rows, guids, advise) {
    const out = [];
    for (const a of rows) {
        if (!a || a.id == undefined || a.isShoal) continue;
        const guid = guids && guids.get(a.key);
        const advice = advise ? advise(a) : { price: 0, confidence: 'none', reason: '' };
        out.push({
            id: guid ? 'g' + guid : 'k' + a.key + '|' + rowFingerprint(a),
            guid: guid || null,
            key: a.key,
            a,
            species: a.species,
            score: geneScore(a),
            medal: medalOf(a),
            block: blockOf(a),
            caution: cautionOf(a),
            advice,
        });
    }
    return out;
}

// Species with their counts: total, sellable now, on the market.
export function speciesCounts(rows) {
    const m = new Map();
    for (const r of rows) {
        const sp = r.species || '?';
        let c = m.get(sp);
        if (!c) m.set(sp, c = { species: sp, total: 0, sellable: 0, listed: 0 });
        c.total++;
        if (!r.block) c.sellable++;
        if (r.block === 'listed') c.listed++;
    }
    return Array.from(m.values()).sort((x, y) => y.sellable - x.sellable || y.total - x.total || String(x.species).localeCompare(String(y.species)));
}

// ------------------------------------------------------------- filters
// What the desk shows, so the player can pick a population to sell (e.g.
// genes 0-50: tick all, list them, keep the rest). The main bar holds sex,
// age, rating, the gene range and what to show; "More filters" holds the
// rest. A filter left at its default filters nothing.

export const GENE_BASES = Object.freeze({
    overall: 'Overall',
    breeder: 'Breeding',
    size: 'Size',
    longevity: 'Longevity',
    fertility: 'Fertility',
    immunity: 'Immunity',
});
export const GENE_KEYS = Object.freeze(['size', 'longevity', 'fertility', 'immunity']);
export const DESK_AGES = Object.freeze(['juvenile', 'young', 'adult', 'elderly']);
// the game's EAnimalStorageTag (GameTypes.js); 0 = no tag
export const STORAGE_TAGS = Object.freeze({ 0: 'No tag', 1: 'Sell', 2: 'Release', 3: 'Move', 4: 'Keep' });
export const TAG_KEEP = 4;
export const DESK_SORTS = Object.freeze({ best: 'Best genes', worst: 'Worst genes', price: 'Price', name: 'Name' });

const MEDAL_RANK = Object.fromEntries(MEDALS.map((m, i) => [m, i]));

export const DESK_FILTERS = Object.freeze({
    species: null,
    sex: 'any',           // 'any' | 'male' | 'female'
    ages: Object.freeze([]), // DESK_AGES picked; none = any age
    fertile: 'any',       // 'any' | 'yes' (the game marks it fertile) | 'no'
    medals: Object.freeze([]), // MEDALS picked; none = any rating
    state: 'any',         // 'any' | 'sellable' | 'listed' | 'blocked'
    geneBasis: 'overall', // GENE_BASES: what the gene range and the sort use
    geneMin: 0,
    geneMax: 100,
    // "More filters"
    sizeMin: 0, sizeMax: 100,
    longevityMin: 0, longevityMax: 100,
    fertilityMin: 0, fertilityMax: 100,
    immunityMin: 0, immunityMax: 100,
    pregnant: 'any',      // 'any' | 'hide' | 'only'
    tags: Object.freeze([]), // storage tags picked (0..4); none = any
    keepBest: 0,          // > 0: only what is left after the best N of each species and sex
    priceMin: 0,          // recommended price, CC; 0 = no lower bound
    priceMax: 0,          // 0 = no upper bound
    kin: 'any',           // 'any' | 'related' (a close relative in storage) | 'unrelated'
    text: '',             // name contains (any case)
    sort: 'best',         // DESK_SORTS
});

const MAIN_KEYS = ['sex', 'ages', 'fertile', 'medals', 'state', 'geneMin', 'geneMax'];
const MORE_KEYS = ['sizeMin', 'sizeMax', 'longevityMin', 'longevityMax', 'fertilityMin', 'fertilityMax', 'immunityMin', 'immunityMax',
    'pregnant', 'tags', 'keepBest', 'priceMin', 'priceMax', 'kin', 'text'];

const clampPct = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const listOf = (v, list) => (Array.isArray(v) ? Array.from(new Set(v.filter(x => list.includes(x)))) : []);

// Any saved or partial filter object -> a complete, valid one. Older shapes
// still read: medal 'silver' (silver or better), age 'fertile'.
export function normalizeFilters(f) {
    const o = Object.assign({}, DESK_FILTERS, { ages: [], medals: [], tags: [] });
    if (!f || typeof f !== 'object') return o;
    o.species = typeof f.species === 'string' && f.species ? f.species : null;
    o.sex = oneOf(f.sex, ['any', 'male', 'female'], 'any');
    o.ages = listOf(f.ages, DESK_AGES);
    o.fertile = oneOf(f.fertile, ['any', 'yes', 'no'], 'any');
    if (f.age === 'fertile') o.fertile = 'yes';
    o.medals = listOf(f.medals, MEDALS);
    if (typeof f.medal === 'string' && MEDAL_RANK[f.medal] != undefined) o.medals = MEDALS.filter(m => MEDAL_RANK[m] >= MEDAL_RANK[f.medal]);
    o.state = oneOf(f.state, ['any', 'sellable', 'listed', 'blocked'], 'any');
    o.geneBasis = oneOf(f.geneBasis, Object.keys(GENE_BASES), 'overall');
    for (const k of ['gene'].concat(GENE_KEYS)) {
        const lo = f[k + 'Min'] == undefined ? 0 : clampPct(f[k + 'Min']);
        const hi = f[k + 'Max'] == undefined ? 100 : clampPct(f[k + 'Max']);
        o[k + 'Min'] = Math.min(lo, hi);
        o[k + 'Max'] = Math.max(lo, hi);
    }
    o.pregnant = oneOf(f.pregnant, ['any', 'hide', 'only'], 'any');
    o.tags = listOf((Array.isArray(f.tags) ? f.tags : []).map(Number), [0, 1, 2, 3, 4]);
    o.keepBest = Math.max(0, Math.min(99, Math.round(Number(f.keepBest) || 0)));
    o.priceMin = Math.max(0, Math.round(Number(f.priceMin) || 0));
    o.priceMax = Math.max(0, Math.round(Number(f.priceMax) || 0));
    if (o.priceMax && o.priceMin > o.priceMax) o.priceMax = o.priceMin;
    o.kin = oneOf(f.kin, ['any', 'related', 'unrelated'], 'any');
    o.text = typeof f.text === 'string' ? f.text.slice(0, 40) : '';
    o.sort = oneOf(f.sort, Object.keys(DESK_SORTS), 'best');
    return o;
}

function differs(f, k) {
    const a = f[k], b = DESK_FILTERS[k];
    if (Array.isArray(b)) return Array.isArray(a) && a.length > 0;
    if (k === 'text') return typeof a === 'string' && a.trim() !== '';
    return a !== b;
}

// How many filters are set, on the main bar and under "More filters" (a
// min/max pair counts once).
export function activeFilterCount(f) {
    const n = keys => {
        const seen = new Set();
        for (const k of keys) if (differs(f, k)) seen.add(k.replace(/M(in|ax)$/, ''));
        return seen.size;
    };
    const main = n(MAIN_KEYS);
    const more = n(MORE_KEYS);
    return { main, more, total: main + more };
}

// Back to the defaults, keeping the species, the sort and the gene basis.
export function resetFilters(f) {
    return Object.assign(normalizeFilters(null), { species: f ? f.species : null, sort: f ? f.sort : 'best', geneBasis: f ? f.geneBasis : 'overall' });
}

const AGE_OF = {
    [Maturity.Infant]: 'juvenile',
    [Maturity.YoungAdult]: 'young', [Maturity.YoungAdultInfertile]: 'young',
    [Maturity.Adult]: 'adult', [Maturity.AdultInfertile]: 'adult',
    [Maturity.Elderly]: 'elderly', [Maturity.ElderlyInfertile]: 'elderly',
};
export function ageOf(a) {
    return AGE_OF[a.maturity] || null;
}

function isFertile(a) {
    return a.maturity == Maturity.YoungAdult || a.maturity == Maturity.Adult || a.maturity == Maturity.Elderly;
}

function pct(v) {
    return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) : null;
}

// One gene 0..100 as the game shows it (a dash where it doesn't count: size
// and immunity on exhibit animals, every gene on shoals).
export function geneOf(a, k) {
    return relevantGenes(a).includes(k) ? pct((a.genes || {})[k]) : null;
}

// The score the gene range and the sort use, 0..100 or null.
export function basisScore(r, basis = 'overall') {
    if (basis === 'overall') return r.score;
    if (basis === 'breeder') return breederScore(r.a);
    return geneOf(r.a, basis);
}

// Row ids beyond the best `keep` of each species and sex, best first by the
// basis (unknown scores last). Only animals the desk could list count: one on
// the market, a juvenile, an elderly infertile or a moving animal never takes
// a kept place (else the best adult could be the one sold). These are the
// cull candidates.
export function beyondBest(rows, keep, basis = 'overall') {
    const out = new Set();
    if (!(keep > 0)) return out;
    const groups = new Map();
    for (const r of rows) {
        if (r.block) continue;
        const k = `${r.species}|${r.a.gender}`;
        let g = groups.get(k);
        if (!g) groups.set(k, g = []);
        g.push(r);
    }
    for (const g of groups.values()) {
        if (g.length <= keep) continue;
        g.map(r => ({ r, s: basisScore(r, basis) }))
            .sort((x, y) => ((y.s ?? -1) - (x.s ?? -1)) || String(x.r.a.name || '').localeCompare(String(y.r.a.name || '')) || String(x.r.id).localeCompare(String(y.r.id)))
            .slice(keep)
            .forEach(x => out.add(x.r.id));
    }
    return out;
}

// ctx: { related: a => bool (Kin, when it knows storage), nameOf: a => string }
export function filterRows(rows, filters = DESK_FILTERS, ctx = {}) {
    const f = normalizeFilters(filters);
    const beyond = f.keepBest > 0 ? beyondBest(rows, f.keepBest, f.geneBasis) : null;
    const text = f.text.trim().toLowerCase();
    const nameOf = ctx.nameOf || (a => String(a.name || ''));
    const geneRange = f.geneMin > 0 || f.geneMax < 100;
    return rows.filter(r => {
        const a = r.a;
        if (f.species && r.species !== f.species) return false;
        if (f.sex === 'male' && a.gender != Gender.Male) return false;
        if (f.sex === 'female' && a.gender != Gender.Female) return false;
        if (f.ages.length && !f.ages.includes(ageOf(a))) return false;
        if (f.fertile === 'yes' && !isFertile(a)) return false;
        if (f.fertile === 'no' && isFertile(a)) return false;
        if (f.medals.length && !(r.medal != undefined && f.medals.includes(r.medal))) return false;
        if (f.state === 'sellable' && r.block) return false;
        if (f.state === 'listed' && r.block !== 'listed') return false;
        if (f.state === 'blocked' && (!r.block || r.block === 'listed')) return false;
        if (geneRange) {
            const s = basisScore(r, f.geneBasis);
            if (s == null || s < f.geneMin || s > f.geneMax) return false;
        }
        for (const k of GENE_KEYS) {
            const lo = f[k + 'Min'], hi = f[k + 'Max'];
            if (lo === 0 && hi === 100) continue;
            const v = geneOf(a, k);
            if (v == null || v < lo || v > hi) return false;
        }
        if (f.pregnant === 'hide' && a.isPregnant) return false;
        if (f.pregnant === 'only' && !a.isPregnant) return false;
        if (f.tags.length && !f.tags.includes(Number(a.storageTag) || 0)) return false;
        if (beyond && !beyond.has(r.id)) return false;
        const price = r.advice && r.advice.price > 0 ? r.advice.price : 0;
        if (f.priceMin > 0 && price < f.priceMin) return false;
        if (f.priceMax > 0 && !(price > 0 && price <= f.priceMax)) return false;
        if (f.kin !== 'any' && typeof ctx.related === 'function') {
            const rel = !!ctx.related(a);
            if (f.kin === 'related' ? !rel : rel) return false;
        }
        if (text && !nameOf(a).toLowerCase().includes(text)) return false;
        return true;
    });
}

// What "Tick all" takes: sellable now and not tagged Keep in storage (unless
// the player filtered to Keep-tagged animals on purpose).
export function tickable(r, filters = DESK_FILTERS) {
    if (r.block) return false;
    const tags = (filters && filters.tags) || [];
    return !(Number(r.a.storageTag) === TAG_KEEP && !tags.includes(TAG_KEEP));
}

// Desk order: sellable first, then by the chosen sort (genes by the basis),
// then by name.
export function sortRows(rows, sort = 'best', basis = 'overall') {
    const name = r => String(r.a.name || '');
    const price = r => (r.advice && r.advice.price) || 0;
    const by = {
        best: (x, y) => (basisScore(y, basis) ?? -1) - (basisScore(x, basis) ?? -1),
        worst: (x, y) => (basisScore(x, basis) ?? 101) - (basisScore(y, basis) ?? 101),
        price: (x, y) => price(y) - price(x),
    }[sort] || (() => 0);
    return rows.slice().sort((x, y) => (!!x.block - !!y.block) || by(x, y) || name(x).localeCompare(name(y)));
}

// The engine's job text (docs/DESIGN-market-desk.md): "v1 <paceMs>", then
// "<guid> <key> <price|-> <hours>" per animal. Rows without a GUID or with
// a block are left out (the engine would skip them anyway).
export function encodeJob(rows, { paceMs = 3000, hours = 'max' } = {}) {
    const lines = [`v1 ${Math.max(1000, Math.round(paceMs))}`];
    const items = [];
    for (const r of rows) {
        if (!r.guid || r.block || !GUID_TOKEN.test(r.guid) || !/^[A-Za-z0-9_]+$/.test(String(r.key))) continue;
        const p = r.advice && r.advice.price > 0 ? String(Math.round(r.advice.price)) : '-';
        const hr = hours === 'max' || hours === 'default' ? hours : String(Math.max(1, Math.round(hours)));
        lines.push(`${r.guid} ${r.key} ${p} ${hr}`);
        items.push(r);
    }
    return { text: lines.join('\n'), items };
}

// The engine's state, made safe to read (missing fields filled).
export function normalizeState(s) {
    if (!s || typeof s !== 'object') return null;
    const results = Array.isArray(s.results) ? s.results.filter(x => x && x.guid != undefined).map(x => Object.assign({ status: 'pending', kind: '', detail: '' }, x, { guid: String(x.guid) })) : [];
    return Object.assign({ run: 0, phase: 'running', total: results.length, index: 0, step: '', waited: 0, message: '' }, s, { results });
}

// Counts of a run's results.
export function tally(state) {
    const t = { total: 0, pending: 0, working: 0, listed: 0, skipped: 0, refused: 0, timeout: 0, stopped: 0, earned: 0, kinds: {} };
    if (!state) return t;
    for (const r of state.results) {
        t.total++;
        if (t[r.status] != undefined) t[r.status]++;
        if (r.status === 'listed' && r.price > 0) t.earned += r.price;
        if (r.status !== 'listed' && r.status !== 'pending' && r.status !== 'working' && r.kind) t.kinds[r.kind] = (t.kinds[r.kind] || 0) + 1;
    }
    return t;
}

// "listed 7 of 10 (≈ 9,800 CC); skipped 2 (2 refused by the server); 1 not started"
export function summaryText(state, fmt = n => String(n)) {
    const t = tally(state);
    if (!t.total) return 'Nothing to list.';
    const parts = [`listed ${t.listed} of ${t.total}${t.earned ? ` (≈ ${fmt(t.earned)} CC asked)` : ''}`];
    const notListed = t.skipped + t.refused + t.timeout + t.stopped;
    if (notListed) {
        const kinds = Object.entries(t.kinds).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${RESULT_WORDS[k] || k}`).join(', ');
        parts.push(`not listed ${notListed}${kinds ? ` (${kinds})` : ''}`);
    }
    if (t.pending) parts.push(`${t.pending} not started`);
    const s = parts.join('; ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// The GUIDs of a finished run worth another try: skipped for a passing
// reason, refused, timed out, or never started.
const RETRY_KINDS = new Set(['busy', 'unselectable', 'changed', 'refused', 'timeout', 'error', 'closed', 'stopped']);
export function retryGuids(state) {
    if (!state) return [];
    return state.results.filter(r => r.status === 'pending' || (r.status !== 'listed' && RETRY_KINDS.has(r.kind))).map(r => r.guid);
}

// Page-assisted reads for the engine (docs/DESIGN-market-desk.md): while it
// selects an animal, the page reads the selection, tradeAllowed and the
// listing limits from its DataStore (Lua's own reads never saw the
// selection in game, Y: 2026-10-17) and reports them in plain text (the
// mod's Lua has no JSON decoder; pz2qol.lister.lua parseSeen).
export const SEEN_CONTEXTS = Object.freeze({
    data: ['hubAnimalsData', 'animalStorageData'],
    actions: ['hubAnimalsData', 'animalStorageData', 'actions'],
    limits: ['animalTradeListingData'],
});
export const SEEN_LIMITS = Object.freeze(['tradePriceMin', 'tradePriceMax', 'tradePriceDefault', 'tradeDurationMin', 'tradeDurationMax', 'tradeDurationDefault']);

// What the page sees for row key `key`; read(context, prop) is the DataStore
// read (game.js get). sel null: the selection could not be read.
export function readSeen(key, read) {
    const r = (c, p) => {
        try {
            return read(c, p);
        }
        catch (e) {
            return undefined;
        }
    };
    const v = r(SEEN_CONTEXTS.data, 'selectedAnimalIDs');
    const sel = Array.isArray(v) ? v.filter(x => typeof x === 'string' || typeof x === 'number').map(String) : null;
    const allowed = r(SEEN_CONTEXTS.actions, 'tradeAllowed');
    const reason = r(SEEN_CONTEXTS.actions, 'tradeDisallowedReason');
    const limits = {};
    for (const p of SEEN_LIMITS) {
        const n = r(SEEN_CONTEXTS.limits, p);
        limits[p] = typeof n === 'number' && Number.isFinite(n) ? n : null;
    }
    return { key: String(key), sel, allowed: typeof allowed === 'boolean' ? allowed : null, reason: typeof reason === 'string' ? reason : '', limits };
}

// "v1|<key>|<sel,...|?>|<1|0|->|<pmin,pmax,pdef,hmin,hmax,hdef (- none)>|<reason>"
export function encodeSeen(s) {
    const token = x => String(x).replace(/[|,\s]/g, '');
    const sel = Array.isArray(s.sel) ? s.sel.map(token).filter(Boolean).join(',') : '?';
    const allowed = s.allowed === true ? '1' : s.allowed === false ? '0' : '-';
    const lim = SEEN_LIMITS.map(p => {
        const n = s.limits ? s.limits[p] : null;
        return typeof n === 'number' && Number.isFinite(n) ? String(n) : '-';
    }).join(',');
    const reason = String(s.reason || '').replace(/[\r\n]/g, ' ');
    return ['v1', token(s.key), sel, allowed, lim, reason].join('|');
}
