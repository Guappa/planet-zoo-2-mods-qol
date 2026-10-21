// My listings (the Market desk's second view): the pure parts (Node tests).
// How stale each of the player's own live listings is, what to ask instead,
// the bulk price strategies, the preview, and the job texts of a reprice
// (take off, then list again). See docs/DESIGN-reprice.md.
//
// A listing here is a storage row that is on the market (readAnimal shape:
// price = auctionPrice, auctionTimerSeconds = time left). Comparables come
// from the price book (pricing.js), with every one of the player's own
// listings taken out first: they show on the market too, and an animal must
// never be compared with itself or with its stable-mates.
import { comparables, listingKey, median, medalOf, nicePrice, recommendPrice } from './pricing.js';

// The game's longest listing (12 h in 1.0.5) and its default (6 h): when
// the desk did not list it itself this session, a listing with more than
// 6 h left must be a 12 h one, and shorter ones are assumed 12 h too (the
// desk lists at the longest by default).
export const MAX_HOURS = 12;
export const DEFAULT_HOURS = 6;
// Score bands (0-100): at or above STALE_AT the listing is stale.
export const STALE_AT = 50;
export const WATCH_AT = 25;
// Premium scale: 0 at 5 % under the fair price, 1 at 30 % over it.
export const PREMIUM_FROM = -0.05;
export const PREMIUM_SPAN = 0.35;
// Underpriced: this far under the fair price, and the cheapest of its kind.
export const UNDER_BY = 0.15;
// Expiring: less than this left (it goes back to storage unsold).
export const EXPIRING_S = 3600;
// The suggestion: just under the cheapest comparable (first in line), never
// above the fair price and never under SUGGEST_FLOOR of it.
export const SUGGEST_UNDERCUT = 0.02;
export const SUGGEST_FLOOR = 0.85;
// Ties: prices within this share of each other count as the same price.
const TIE = 0.005;

export const VERDICTS = Object.freeze({
    stale: { label: 'Stale', text: 'Priced above the market and has been up a while: relist it lower' },
    watch: { label: 'Watch', text: 'Somewhat above the market; give it time or trim the price' },
    ok: { label: 'Healthy', text: 'Priced in line with the market' },
    under: { label: 'Underpriced', text: 'Well under the market and the cheapest of its kind: it should sell; you could ask more' },
    nodata: { label: 'No data', text: 'No comparable listings in the price book: check market prices' },
});
// Most urgent first (the default sort and the filter chips).
export const VERDICT_ORDER = Object.freeze(['stale', 'watch', 'under', 'ok', 'nodata']);

const clamp01 = x => Math.max(0, Math.min(1, x));
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// The ids the price book may hold for one of the player's listings: the
// market row shows it as a CC listing at its asked price (the storage row
// may not say CC, so both forms).
export function ownListingKeys(mine) {
    const keys = new Set();
    for (const a of mine || []) {
        if (!a || !(a.price > 0)) continue;
        for (const isCC of [true, false]) {
            const k = listingKey(Object.assign({}, a, { isCC }));
            if (k) keys.add(k);
        }
    }
    return keys;
}

// The price book without the player's own listings. live: market rows
// only (what a buyer sees now); all: also the trade history (what the
// desk's price advice uses).
export function marketPools(book, mine) {
    const own = ownListingKeys(mine);
    const all = (book || []).filter(l => l && !(l.source === 'market' && own.has(l.id)));
    return { all, live: all.filter(l => l.source === 'market'), own: own.size };
}

// How long it has been up: { left, duration, elapsed (s), frac (0-1), known }
//   known 'ledger' (the desk listed it: its hours), 'inferred' (more than
//   the default left: a 12 h listing), 'assumed' (12 h, not known)
export function listingClock(a, entry = null, now = Date.now()) {
    const left = Math.max(0, Number(a && a.auctionTimerSeconds) || 0);
    let duration;
    let known;
    if (entry && entry.hours > 0 && entry.hours * 3600 >= left - 60 && now - entry.at <= entry.hours * 3600 * 1000 + 600000) {
        duration = entry.hours * 3600;
        known = 'ledger';
    }
    else if (left > DEFAULT_HOURS * 3600 + 60) {
        duration = MAX_HOURS * 3600;
        known = 'inferred';
    }
    else {
        duration = MAX_HOURS * 3600;
        known = 'assumed';
    }
    duration = Math.max(duration, left);
    const elapsed = Math.max(0, duration - left);
    return { left, duration, elapsed, frac: duration > 0 ? clamp01(elapsed / duration) : 0, known };
}

// "4h 10m", "35m", "<1m"
export function spanText(seconds) {
    if (!(seconds > 0)) return '0m';
    const m = Math.floor(seconds / 60);
    if (m < 1) return '<1m';
    const h = Math.floor(m / 60);
    return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
}

// The suggested new price for a listing priced p, with its fair price and
// the cheapest comparable on the market now.
export function suggestPrice(p, fair, cheapest, verdict) {
    if (!(fair > 0)) return { price: null, why: 'No fair price to suggest from' };
    if (verdict === 'under') return { price: nicePrice(fair), why: `Raise to the fair price (${fmt(fair)} CC)` };
    // healthy: no change needed
    if (verdict === 'ok') return { price: p, why: 'Keep: in line with the market' };
    const floor = fair * SUGGEST_FLOOR;
    let target = fair;
    let why = `The fair price (${fmt(fair)} CC)`;
    if (cheapest > 0 && cheapest * (1 - SUGGEST_UNDERCUT) < fair) {
        target = cheapest * (1 - SUGGEST_UNDERCUT);
        why = `${Math.round(SUGGEST_UNDERCUT * 100)}% under the cheapest comparable (${fmt(cheapest)} CC): first in line`;
    }
    if (target < floor) {
        target = floor;
        why = `${Math.round(SUGGEST_FLOOR * 100)}% of the fair price (the cheapest comparable, ${fmt(cheapest)} CC, is far under it)`;
    }
    const price = nicePrice(target);
    // already at or under it: keep
    if (verdict === 'watch' && price >= p) return { price: p, why: 'Keep: already at or under the suggested price' };
    return { price, why };
}

// One listing assessed against the market.
//   a        the storage row (readAnimal shape), on the market
//   ctx      { book, mine (all the player's listings, readAnimal rows),
//              entry (ledger entry or null), now, checkedAt (ms of the
//              species' last market check, or null), freshMs, morphName }
// Returns { price, fair, conf, clock, n, cheaper, ties, queue, cheapest,
//   median, ladder, premium, premScore, pressure, score, verdict, flags,
//   suggestion, suggestionWhy, rec, reasons }
export function assessListing(a, ctx = {}) {
    const now = ctx.now ?? Date.now();
    const freshMs = ctx.freshMs ?? 30 * 60 * 1000;
    const pools = ctx.pools || marketPools(ctx.book, ctx.mine);
    const animal = Object.assign({}, a, { isCC: true });
    const p = a.price > 0 ? a.price : null;
    // the fair price: the desk's own advice (no player offset), from the
    // market and the trade history, the player's listings left out
    const rec = recommendPrice(animal, pools.all, {}, { offset: 0, morphName: ctx.morphName });
    const fair = rec && rec.price > 0 ? rec.price : null;
    // live comparables: what a buyer browsing this species sees now (the same
    // choice of comparables, scaled to this animal's medal / morph)
    const comp = comparables(animal, pools.live);
    const ladder = comp.list.map(l => l.price).filter(x => x > 0).sort((x, y) => x - y);
    const n = ladder.length;
    let cheaper = 0;
    let ties = 0;
    if (p) {
        for (const x of ladder) {
            if (Math.abs(x - p) <= p * TIE) ties++;
            else if (x < p) cheaper++;
        }
    }
    const queue = n && p ? (cheaper + ties / 2) / n : null;
    const cheapest = n ? ladder[0] : null;
    const med = n ? median(ladder) : null;
    const clock = listingClock(a, ctx.entry || null, now);
    const premium = p && fair ? p / fair - 1 : null;
    const premScore = premium == null ? null : clamp01((premium - PREMIUM_FROM) / PREMIUM_SPAN);
    let pressure = null;
    if (premScore != null) pressure = queue == null ? premScore : 0.5 * premScore + 0.5 * queue;
    const score = pressure == null ? null : Math.round(100 * pressure * (0.5 + 0.5 * clock.frac));
    let verdict;
    if (fair == null || !p) verdict = 'nodata';
    else if (premium <= -UNDER_BY && (cheapest == null || p < cheapest)) verdict = 'under';
    else if (score >= STALE_AT) verdict = 'stale';
    else if (score >= WATCH_AT) verdict = 'watch';
    else verdict = 'ok';
    const checked = ctx.checkedAt > 0 ? now - ctx.checkedAt : null;
    const flags = {
        expiring: clock.left > 0 && clock.left < EXPIRING_S,
        staleData: checked == null || checked > freshMs,
        checkedAgoMs: checked,
        lowConf: !fair || rec.confidence === 'low' || rec.confidence === 'none',
        assumedClock: clock.known === 'assumed',
    };
    const sug = p ? suggestPrice(p, fair, cheapest, verdict) : { price: null, why: '' };
    const out = {
        price: p, fair, conf: rec ? rec.confidence : 'none', clock, n, cheaper, ties, queue, cheapest, median: med, ladder,
        premium, premScore, pressure, score, verdict, flags, suggestion: sug.price, suggestionWhy: sug.why, rec,
        medal: medalOf(a), comps: comp,
    };
    out.reasons = reasonsOf(out);
    return out;
}

const pctText = x => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(Math.round(x * 100))}%`;

// The working, line by line, for the explanation drawer and the tooltip.
export function reasonsOf(s) {
    const r = [];
    if (s.fair) {
        r.push({ k: 'fair', label: 'Fair price', value: `${fmt(s.fair)} CC`, detail: s.rec && s.rec.reason ? s.rec.reason : '' });
        r.push({ k: 'premium', label: 'Your price vs fair', value: pctText(s.premium), detail: `${fmt(s.price)} CC asked; premium score ${Math.round(s.premScore * 100)} of 100 (0 at 5% under fair, 100 at 30% over)` });
    }
    else r.push({ k: 'fair', label: 'Fair price', value: 'unknown', detail: 'No comparable listings or sales in the price book' });
    if (s.n) {
        const pos = s.cheaper + 1;
        r.push({ k: 'queue', label: 'Place in line', value: `${pos} of ${s.n + 1}`, detail: `${s.cheaper} comparable listing${s.cheaper === 1 ? ' is' : 's are'} cheaper${s.ties ? `, ${s.ties} at about your price` : ''}; cheapest ${fmt(s.cheapest)} CC, median ${fmt(s.median)} CC` });
    }
    else r.push({ k: 'queue', label: 'Place in line', value: 'alone', detail: 'No comparable listing on the market now (yours are left out)' });
    const c = s.clock;
    r.push({ k: 'time', label: 'Time on market', value: `${Math.round(c.frac * 100)}%`, detail: `${spanText(c.elapsed)} up, ${spanText(c.left)} left of ${Math.round(c.duration / 3600)} h${c.known === 'assumed' ? ' (length assumed)' : c.known === 'inferred' ? ' (a 12 h listing)' : ''}` });
    if (s.score != null) {
        const pr = Math.round(s.pressure * 100);
        r.push({ k: 'score', label: 'Staleness', value: `${s.score}`, detail: `price pressure ${pr}${s.queue != null ? ' (half premium, half place in line)' : ' (premium only)'} × time weight ${(0.5 + 0.5 * c.frac).toFixed(2)}` });
    }
    if (s.flags.staleData) r.push({ k: 'data', label: 'Market data', value: s.flags.checkedAgoMs == null ? 'not checked' : `${Math.round(s.flags.checkedAgoMs / 60000)} min old`, detail: 'Check market prices for a reliable verdict' });
    return r;
}

// ---------------------------------------------------------- strategies

export const STRATEGIES = Object.freeze({
    suggested: { label: 'Suggested', title: 'Each listing at its own suggestion: just under the cheapest comparable, never above the fair price, never under 85% of it' },
    fair: { label: 'Fair', title: "The desk's fair price for each animal (what it would list it at)" },
    cheapest: { label: 'Match cheapest', title: 'The price of the cheapest comparable listing' },
    undercut: { label: 'Undercut', title: 'The cheapest comparable listing, less X%' },
    cut: { label: 'Cut mine', title: 'My current price, less X%' },
});

export function normalizeStrategy(s) {
    return STRATEGIES[s] ? s : 'suggested';
}

// The new price for one assessed listing: { price, why, floored }.
//   pct: the X of Undercut / Cut mine; floorPct: never under this % of fair
export function strategyPrice(as, strategy = 'suggested', { pct = 5, floorPct = 80 } = {}) {
    const st = normalizeStrategy(strategy);
    let price = null;
    let why = '';
    if (st === 'suggested') {
        price = as.suggestion;
        why = as.suggestionWhy || '';
    }
    else if (st === 'fair') {
        price = as.fair;
        why = 'The fair price';
    }
    else if (st === 'cheapest') {
        price = as.cheapest;
        why = as.cheapest ? 'The cheapest comparable' : 'No comparable listed';
    }
    else if (st === 'undercut') {
        price = as.cheapest ? as.cheapest * (1 - pct / 100) : null;
        why = as.cheapest ? `${pct}% under the cheapest comparable` : 'No comparable listed';
    }
    else if (st === 'cut') {
        price = as.price ? as.price * (1 - pct / 100) : null;
        why = `${pct}% under my price`;
    }
    if (!(price > 0)) return { price: null, why: why || 'No price', floored: false };
    let floored = false;
    if (st !== 'suggested' && as.fair > 0 && floorPct > 0 && price < as.fair * floorPct / 100) {
        price = as.fair * floorPct / 100;
        floored = true;
        why = `${why}; held at ${floorPct}% of fair`;
    }
    return { price: Math.max(1, Math.round(nicePrice(price))), why, floored };
}

// Per-row overrides win over the strategy: { guid: price }.
export function planReprice(rows, { strategy = 'suggested', pct = 5, floorPct = 80, overrides = null } = {}) {
    const items = [];
    for (const r of rows) {
        const as = r.assess;
        if (!as || !r.guid) continue;
        const o = overrides && overrides[r.guid];
        let next;
        if (o > 0) next = { price: Math.round(o), why: 'Your own price', floored: false, override: true };
        else next = Object.assign(strategyPrice(as, strategy, { pct, floorPct }), { override: false });
        items.push({
            guid: r.guid, key: r.key, row: r, old: as.price, next: next.price, why: next.why, floored: next.floored, override: next.override,
            change: next.price && as.price ? next.price - as.price : null,
            aboveCheapest: !!(next.price && as.cheapest && next.price > as.cheapest * (1 + TIE)),
        });
    }
    const ok = items.filter(i => i.next > 0);
    const sum = (list, f) => list.reduce((n, i) => n + (f(i) || 0), 0);
    return {
        items,
        ready: ok,
        noPrice: items.filter(i => !(i.next > 0)),
        oldTotal: sum(ok, i => i.old),
        newTotal: sum(ok, i => i.next),
        lowered: ok.filter(i => i.change < 0).length,
        raised: ok.filter(i => i.change > 0).length,
        same: ok.filter(i => i.change === 0).length,
        aboveCheapest: ok.filter(i => i.aboveCheapest).length,
        floored: ok.filter(i => i.floored).length,
    };
}

// ------------------------------------------------------------ the jobs

const GUID = /^[A-Za-z0-9_.:-]+$/;
const KEY = /^[A-Za-z0-9_]+$/;

// "v1 <pace> unlist" + "<guid> <key> - max" per listing (pz2qol.lister.lua
// parseJob; price and hours are unused in this mode).
export function encodeUnlistJob(items, { paceMs = 3000 } = {}) {
    const lines = [`v1 ${Math.max(1000, Math.round(paceMs))} unlist`];
    const out = [];
    for (const i of items) {
        if (!i || !GUID.test(String(i.guid || '')) || !KEY.test(String(i.key || ''))) continue;
        lines.push(`${i.guid} ${i.key} - max`);
        out.push(i);
    }
    return { text: lines.join('\n'), items: out };
}

// The relist job: the normal listing job at the chosen prices.
//   items: { guid, key, next }; hours 'max' | 'default'
export function encodeRelistJob(items, { paceMs = 3000, hours = 'max' } = {}) {
    const lines = [`v1 ${Math.max(1000, Math.round(paceMs))}`];
    const out = [];
    const hr = hours === 'default' ? 'default' : 'max';
    for (const i of items) {
        if (!i || !(i.next > 0) || !GUID.test(String(i.guid || '')) || !KEY.test(String(i.key || ''))) continue;
        lines.push(`${i.guid} ${i.key} ${Math.round(i.next)} ${hr}`);
        out.push(i);
    }
    return { text: lines.join('\n'), items: out };
}

// About how long a reprice takes (s): per listing, phase 1 (select, cancel,
// confirm ≈ 3 s) and phase 2 (select, list, confirm ≈ 4 s), each followed by
// the pause, plus the settle between the phases.
export function repriceSeconds(n, paceMs = 3000, settleMs = 5000) {
    if (!(n > 0)) return 0;
    return Math.round(n * (3 + 4 + 2 * paceMs / 1000) + settleMs / 1000);
}

// ------------------------------------------------------------- the run
// The run lives on the page (repricerun.js); these read it.
//   item: { guid, label, old, next, off: '' | engine status, offWhy,
//           on: '' | engine status, onWhy, listedAt }

// What a run does with the listings it took off: list them again at a new
// price, or the desk's Quick trade / Quick release (permanent).
export const ACTIONS = Object.freeze({
    reprice: { label: 'Reprice', done: 'listed', second: 'List again' },
    quicktrade: { label: 'Quick trade', done: 'traded', second: 'Quick trade' },
    release: { label: 'Quick release', done: 'released', second: 'Quick release' },
});

export function normalizeAction(a) {
    return ACTIONS[a] ? a : 'reprice';
}

const DONE = new Set(['listed', 'traded', 'released']);
const isOpen = s => !s || s === 'pending' || s === 'working';

export function runCounts(run) {
    const c = { total: 0, off: 0, offFailed: 0, relisted: 0, relistFailed: 0, sold: 0, soldFor: 0, unconfirmed: 0, stranded: 0, waiting: 0 };
    if (!run || !Array.isArray(run.items)) return c;
    for (const i of run.items) {
        c.total++;
        if (i.off === 'unlisted') c.off++;
        else if (!isOpen(i.off)) c.offFailed++;
        if (i.on === 'listed') c.relisted++;
        else if (i.on === 'traded' || i.on === 'released') {
            c.sold++;
            c.soldFor += i.soldFor > 0 ? i.soldFor : 0;
        }
        else if (i.on === 'unconfirmed') c.unconfirmed++;
        else if (!isOpen(i.on)) c.relistFailed++;
        if (i.off === 'unlisted' && !DONE.has(i.on) && i.on !== 'unconfirmed') {
            if (isOpen(i.on)) c.waiting++;
            else c.stranded++;
        }
    }
    return c;
}

// Off the market by the run, and neither listed again nor sold (yet): these
// wait in storage for the player's next click. A quick action that was sent
// but not confirmed is not among them (check storage first).
export function strandedItems(run) {
    if (!run || !Array.isArray(run.items)) return [];
    return run.items.filter(i => i.off === 'unlisted' && !DONE.has(i.on) && i.on !== 'unconfirmed');
}

// "Repriced 5 of 6 · 1 still listed at its old price"
// "Quick-traded 3 of 4 · $2,400 · 1 off the market, not sold"
export function runSummary(run, fmtN = fmt) {
    const c = runCounts(run);
    if (!c.total) return '';
    const action = normalizeAction(run.action);
    const parts = [];
    if (action === 'reprice') parts.push(`Repriced ${c.relisted} of ${c.total}`);
    else parts.push(`${action === 'quicktrade' ? 'Quick-traded' : 'Released'} ${c.sold} of ${c.total}${c.soldFor ? ` · ${action === 'quicktrade' ? `$${fmtN(c.soldFor)}` : `${fmtN(c.soldFor)} CC`}` : ''}`);
    if (action !== 'reprice' && c.relisted) parts.push(`${c.relisted} listed again`);
    if (c.offFailed) parts.push(`${c.offFailed} not taken off (still at the old price)`);
    if (c.unconfirmed) parts.push(`${c.unconfirmed} sent, not confirmed: check storage`);
    const left = strandedItems(run).length;
    if (left > 0) parts.push(`${left} off the market, ${action === 'reprice' ? 'not listed again' : 'not sold'}`);
    if (action === 'reprice') {
        const gain = (run.items || []).filter(i => i.on === 'listed').reduce((n, i) => n + ((i.listedPrice || i.next || 0) - (i.old || 0)), 0);
        if (c.relisted && gain) parts.push(`asking ${gain > 0 ? '+' : '−'}${fmtN(Math.abs(gain))} CC in all`);
    }
    return parts.join(' · ');
}

// The money of a quick action on the ticked listings (the desk's quickSheet
// on the rows as if off the market: a listed animal's verdict is from when it
// was last selected). -> { sheet, asking, go, skip, perRow: Map guid -> price|null }
//   quickSheet: listercore's (passed in: this file stays free of it)
export function quickPreview(rows, mode, quickSheet, opts = {}) {
    const off = rows.map(r => Object.assign({}, r, { block: null }));
    const sheet = quickSheet(off, mode, opts);
    const flag = mode === 'quicktrade' ? 'quickTrade' : 'quickRelease';
    const perRow = new Map();
    for (const r of sheet.go) {
        const p = r.verdict && r.verdict.prices ? r.verdict.prices[flag] : null;
        perRow.set(r.guid, typeof p === 'number' && Number.isFinite(p) ? p : null);
    }
    const asking = sheet.go.reduce((n, r) => n + (r.a && r.a.price > 0 ? r.a.price : 0), 0);
    return { sheet, asking, go: sheet.go, skip: sheet.skip, perRow };
}

// A quick job's results onto the run's items: { status, price }.
export function quickDone(mode) {
    return mode === 'quicktrade' ? 'traded' : mode === 'release' ? 'released' : 'listed';
}

// ---------------------------------------------------------- the ledger
// When the desk listed each animal (guid -> { at, hours, price, run }), so
// the time on market is known, not assumed. Session-only (Gameface keeps
// localStorage for the session).

// Takes in the listings of one engine state (a 'list' run): a result
// 'listed' with hours, first seen now.
export function ledgerTake(ledger, state, now = Date.now()) {
    let changed = false;
    if (!state || state.mode && state.mode !== 'list' || !Array.isArray(state.results)) return changed;
    for (const r of state.results) {
        if (!r || r.status !== 'listed' || !(r.hours > 0) || r.guid == undefined) continue;
        const g = String(r.guid);
        const e = ledger[g];
        if (e && e.run === state.run) continue;
        ledger[g] = { at: now, hours: r.hours, price: r.price > 0 ? r.price : null, run: state.run };
        changed = true;
    }
    return changed;
}

export function ledgerPrune(ledger, now = Date.now(), maxMs = 2 * MAX_HOURS * 3600 * 1000) {
    for (const g of Object.keys(ledger)) {
        const e = ledger[g];
        if (!e || !(e.at > 0) || now - e.at > maxMs) delete ledger[g];
    }
    return ledger;
}

// -------------------------------------------------------------- the view

// Rows of the view: the player's listings with their assessment.
//   rows: desk rows ({ id, guid, key, species, a, ... }) of listed animals
//   ctx: as assessListing, plus checkedAtOf(species) and ledger
export function listingRows(rows, ctx = {}) {
    const mine = rows.map(r => r.a);
    const pools = marketPools(ctx.book, mine);
    return rows.map(r => {
        const assess = assessListing(r.a, Object.assign({}, ctx, {
            pools, entry: ctx.ledger && r.guid ? ctx.ledger[r.guid] || null : null,
            checkedAt: ctx.checkedAtOf ? ctx.checkedAtOf(r.species) : null,
        }));
        return Object.assign({}, r, { assess });
    });
}

export const LISTING_SORTS = Object.freeze({
    score: 'Staleness', premium: 'Over fair', left: 'Time left', price: 'Price', name: 'Name',
});

export function sortListings(rows, sort = 'score', nameOf = r => String(r.a && r.a.name || '')) {
    const v = r => r.assess || {};
    const rank = r => VERDICT_ORDER.indexOf(v(r).verdict);
    const by = {
        score: (x, y) => (v(y).score ?? -1) - (v(x).score ?? -1) || rank(x) - rank(y),
        premium: (x, y) => (v(y).premium ?? -9) - (v(x).premium ?? -9),
        left: (x, y) => (v(x).clock ? v(x).clock.left : 0) - (v(y).clock ? v(y).clock.left : 0),
        price: (x, y) => (v(y).price || 0) - (v(x).price || 0),
        name: (x, y) => nameOf(x).localeCompare(nameOf(y)),
    }[LISTING_SORTS[sort] ? sort : 'score'];
    return rows.slice().sort((x, y) => by(x, y) || String(x.id).localeCompare(String(y.id)));
}

// verdicts: [] for all, else the verdicts to show; expiring: only those
export function filterListings(rows, { species = null, verdicts = [], expiring = false } = {}) {
    const want = new Set(verdicts || []);
    return rows.filter(r => (!species || r.species === species)
        && (!want.size || want.has(r.assess && r.assess.verdict))
        && (!expiring || (r.assess && r.assess.flags.expiring)));
}

// Counts per verdict (and expiring) for the chips and the rail.
export function verdictCounts(rows) {
    const c = { all: rows.length, expiring: 0 };
    for (const k of VERDICT_ORDER) c[k] = 0;
    for (const r of rows) {
        const a = r.assess;
        if (!a) continue;
        c[a.verdict] = (c[a.verdict] || 0) + 1;
        if (a.flags.expiring) c.expiring++;
    }
    return c;
}
