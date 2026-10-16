// Market price analysis and price recommendation. Pure functions, no game
// imports, so they run under Node tests.
//
// A "listing" is { id, species, gender, maturity, isShoal, isExhibit, score,
// medal, price, isCC, source: 'market' | 'history', seenAt }. Its id is listingKey(),
// not the game's row id: market and history rows reuse the same row ids on
// every page (they are screen slots), so keying by them kept only one page.
import { Gender, geneScore, Maturity } from './scores.js';

export const LifeStage = { Juvenile: 'juvenile', Adult: 'adult', Elderly: 'elderly' };

export function lifeStage(maturity) {
    if (maturity == Maturity.Infant) return LifeStage.Juvenile;
    if (maturity == Maturity.Elderly) return LifeStage.Elderly;
    return LifeStage.Adult;
}

export function median(values) {
    const v = values.filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
    if (v.length == 0) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// The genetics medal the game shows in the market's Rating column (row field
// `ratings`: 'none' | 'bronze' | 'silver' | 'gold'). undefined when unknown:
// rows recorded before 1.3, or shoals (the game shows a dash for them).
export const MEDALS = ['none', 'bronze', 'silver', 'gold'];
const MEDAL_RANK = { none: 0, bronze: 1, silver: 2, gold: 3 };
const MEDAL_LABEL = { none: 'Unranked', bronze: 'Bronze', silver: 'Silver', gold: 'Gold' };

export function medalOf(a) {
    if (!a || a.isShoal || typeof a.medal !== 'string') return undefined;
    const m = a.medal.toLowerCase();
    return MEDAL_RANK[m] != undefined ? m : undefined;
}

export function medalLabel(m) {
    return MEDAL_LABEL[m] || '';
}

// "1,240": thousands separators without toLocaleString (unsure in Gameface).
function fmt(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Round to a price a person would pick: 5s under 500, 10s under 5,000, 50s above.
export function nicePrice(p) {
    if (!(p > 0)) return p;
    const step = p < 500 ? 5 : p < 5000 ? 10 : 50;
    return Math.max(step, Math.round(p / step) * step);
}

// Theil-Sen fit of price against gene score: robust to a few odd listings.
export function fitPriceVsScore(points) {
    const pts = points.filter(p => p.score != null && p.price > 0);
    if (pts.length < 4) return null;
    const slopes = [];
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            const ds = pts[j].score - pts[i].score;
            if (Math.abs(ds) >= 3) slopes.push((pts[j].price - pts[i].price) / ds);
        }
    }
    if (slopes.length < 3) return null;
    // Better genes should never make an animal cheaper.
    const slope = Math.max(0, median(slopes));
    const intercept = median(pts.map(p => p.price - slope * p.score));
    return { slope, intercept, predict: s => intercept + slope * s };
}

// Stable id for a market or history row, built from what the row shows.
// Two listings equal in every field merge into one entry, which is rare.
export function listingKey(a) {
    if (!a || !a.species || !(a.price > 0)) return undefined;
    const g = a.genes || {};
    const num = v => typeof v === 'number' && isFinite(v) ? Math.round(v * 10000) : '';
    return [a.species, a.name == undefined ? '' : String(a.name), a.gender, a.maturity,
        a.isShoal ? 1 : 0, a.isExhibit ? 1 : 0,
        num(g.size), num(g.longevity), num(g.fertility), num(g.immunity),
        a.price, a.isCC ? 1 : 0].join('|');
}

// How much more the next medal up sells for: the median price of medal
// `upper` over the median of the medal below it. Taken from the narrowest
// group with 2+ listings of both medals (same sex and age group, then the
// species), else the median of that ratio over every species in the book.
// Clamped to 1..4: a better medal is never cheaper. null when unknown.
const MIN_PER_MEDAL = 2;
function stepRatioIn(list, upper) {
    const lower = MEDALS[MEDAL_RANK[upper] - 1];
    const hi = list.filter(l => medalOf(l) == upper).map(l => l.price);
    const lo = list.filter(l => medalOf(l) == lower).map(l => l.price);
    if (hi.length < MIN_PER_MEDAL || lo.length < MIN_PER_MEDAL) return null;
    const r = median(hi) / median(lo);
    return isFinite(r) && r > 0 ? r : null;
}
const clampRatio = r => Math.max(1, Math.min(4, r));

export function medalStepRatio(upper, groups, allListings) {
    if (!(MEDAL_RANK[upper] > 0)) return null;
    for (const g of groups) {
        const r = stepRatioIn(g.list, upper);
        if (r != null) return { ratio: clampRatio(r), source: g.source };
    }
    const bySpecies = new Map();
    for (const l of allListings || []) {
        if (!l.isCC || !(l.price > 0) || medalOf(l) == undefined) continue;
        if (!bySpecies.has(l.species)) bySpecies.set(l.species, []);
        bySpecies.get(l.species).push(l);
    }
    const ratios = [];
    for (const list of bySpecies.values()) {
        const r = stepRatioIn(list, upper);
        if (r != null) ratios.push(r);
    }
    return ratios.length ? { ratio: clampRatio(median(ratios)), source: 'all species' } : null;
}

// The listings that are comparable to `animal`, best tier first.
//   Medal tiers, only when the animal's medal and some listings' medals are
//   known, within the same sex and age group:
//     same medal (3+ listings);
//     same medal plus the adjacent medals, their prices scaled by the
//     observed medal price ratio (3+ in all).
//   Otherwise, as before medals were recorded:
//     tier 1: same gender and life stage
//     tier 2: same gender
//     tier 3: any gender
// Scaled entries are copies with the scaled `price` and the listed `rawPrice`.
export function comparables(animal, listings) {
    const stage = lifeStage(animal.maturity);
    // A storage animal that is already listed shows up on the market too.
    const ownKey = listingKey(animal);
    const base = listings.filter(l => l.species == animal.species && l.isCC && l.price > 0
        && l.id != animal.id && l.id != ownKey && !!l.isShoal == !!animal.isShoal);
    const group = base.filter(l => l.gender == animal.gender && lifeStage(l.maturity) == stage);
    const medal = medalOf(animal);
    let medalNote = null;
    if (medal != undefined && group.some(l => medalOf(l) != undefined)) {
        const same = group.filter(l => medalOf(l) == medal);
        if (same.length >= 3) {
            return { tier: 1, label: 'same medal, sex and age group', medal, medalMode: 'same', sameCount: same.length, list: same };
        }
        const rank = MEDAL_RANK[medal];
        const groups = [{ list: group, source: 'this sex and age group' }, { list: base, source: 'this species' }];
        const adjusted = [];
        const factors = {};
        for (const other of [MEDALS[rank - 1], MEDALS[rank + 1]]) {
            if (!other) continue;
            const list = group.filter(l => medalOf(l) == other);
            if (!list.length) continue;
            // the step between the two medals; a lower medal's price goes up by it
            const lower = MEDAL_RANK[other] < rank;
            const step = medalStepRatio(lower ? medal : other, groups, listings);
            if (!step) continue;
            const f = lower ? step.ratio : 1 / step.ratio;
            factors[other] = { factor: f, source: step.source, count: list.length };
            for (const l of list) adjusted.push(Object.assign({}, l, { price: l.price * f, rawPrice: l.price, medalFactor: f }));
        }
        if (adjusted.length && same.length + adjusted.length >= 3) {
            return { tier: 1, label: 'same sex and age group, adjacent medals scaled', medal, medalMode: 'adjacent', sameCount: same.length, factors, list: same.concat(adjusted) };
        }
        medalNote = { medal, sameCount: same.length };
    }
    const tiers = [
        { tier: 1, label: 'same sex and age group', list: group },
        { tier: 2, label: 'same sex', list: base.filter(l => l.gender == animal.gender) },
        { tier: 3, label: 'any sex', list: base },
    ];
    const pick = tiers.find(t => t.list.length >= 3) || tiers.find(t => t.list.length > 0) || { tier: 0, label: 'no market data', list: [] };
    return medalNote ? Object.assign({}, pick, { medalNote }) : pick;
}

// "Silver adult females", "Gold juvenile males", "adult animals"
function groupName(animal, medal) {
    const sex = animal.gender == Gender.Male ? 'males' : animal.gender == Gender.Female ? 'females' : 'animals';
    return [medal != undefined ? medalLabel(medal) : '', lifeStage(animal.maturity), sex].filter(Boolean).join(' ');
}

function groupSummary(list) {
    const prices = list.map(l => l.price);
    return {
        count: list.length,
        median: median(prices),
        min: prices.length ? Math.min(...prices) : null,
        max: prices.length ? Math.max(...prices) : null,
        medianScore: median(list.map(l => l.score)),
    };
}

// Per-sex and per-medal breakdown of current CC prices for a species, plus
// your own sales.
export function speciesMarketSummary(species, listings) {
    const live = listings.filter(l => l.species == species && l.isCC && l.price > 0 && l.source != 'history');
    const sold = listings.filter(l => l.species == species && l.isCC && l.price > 0 && l.source == 'history');
    return {
        species,
        male: groupSummary(live.filter(l => l.gender == Gender.Male)),
        female: groupSummary(live.filter(l => l.gender == Gender.Female)),
        other: groupSummary(live.filter(l => l.gender != Gender.Male && l.gender != Gender.Female)),
        juvenile: groupSummary(live.filter(l => lifeStage(l.maturity) == LifeStage.Juvenile)),
        all: groupSummary(live),
        history: groupSummary(sold),
        // only the medals seen, best first; empty when no listing has one
        byMedal: Object.fromEntries(MEDALS.slice().reverse()
            .map(m => [m, live.filter(l => medalOf(l) == m)])
            .filter(([, list]) => list.length)
            .map(([m, list]) => [m, Object.assign(groupSummary(list), {
                males: list.filter(l => l.gender == Gender.Male).length,
                females: list.filter(l => l.gender == Gender.Female).length,
            })])),
    };
}

export const PRICING_DEFAULTS = Object.freeze({
    undercut: 0.03,       // list a little under the fitted price so it sells
    gamePriceWeightMin: 0, // weight on the game's own value once data is plentiful
    fullConfidenceAt: 6,   // comparables needed to rely on the market alone
    offset: 0,             // player's global adjustment, e.g. -0.1 = 10% under
});

// The player's offset as a label: "-10%", "+20%", "" for none.
export function offsetLabel(offset) {
    const pct = Math.round((offset || 0) * 100);
    return pct ? `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%` : '';
}

// Recommends a CC price.
//   animal: plain animal (scores.js shape) with id/species/gender/maturity/genes
//   listings: price book entries
//   game: { defaultPrice, min, max } from the game's trade listing data
//   opts: overrides for PRICING_DEFAULTS, e.g. { offset: -0.1 }
export function recommendPrice(animal, listings, game = {}, options = {}) {
    const opts = Object.assign({}, PRICING_DEFAULTS, options);
    const score = geneScore(animal);
    const comp = comparables(animal, listings);
    const list = comp.list;
    const prices = list.map(l => l.price);
    const med = median(prices);
    const medScore = median(list.map(l => l.score));
    let marketPrice = null;
    let method = 'none';
    if (list.length > 0) {
        const fit = score != null ? fitPriceVsScore(list) : null;
        if (fit) {
            marketPrice = fit.predict(score);
            method = 'fit';
        }
        else if (score != null && medScore != null) {
            // About 1% per gene point above or below the typical listing, capped at 40%.
            const adj = Math.max(-0.4, Math.min(0.4, (score - medScore) * 0.01));
            marketPrice = med * (1 + adj);
            method = 'median-adjusted';
        }
        else {
            marketPrice = med;
            method = 'median';
        }
        // never recommend outside what the comparables span by more than 25%
        marketPrice = Math.max(Math.min(...prices) * 0.75, Math.min(Math.max(...prices) * 1.25, marketPrice));
        marketPrice *= 1 - opts.undercut;
    }
    const gameValue = game.defaultPrice > 0 ? game.defaultPrice : null;
    const weight = Math.min(1, list.length / opts.fullConfidenceAt);
    let price;
    if (marketPrice != null && gameValue != null) {
        price = weight * marketPrice + (1 - weight) * gameValue;
    }
    else {
        price = marketPrice ?? gameValue;
    }
    const confidence = list.length >= opts.fullConfidenceAt && comp.tier <= 2 ? 'high'
        : list.length >= 3 ? 'medium'
            : list.length > 0 ? 'low' : 'none';
    if (price == null) {
        return { price: null, confidence: 'none', reason: 'No market data and no game value', comps: comp, score, gameValue };
    }
    // the price before the player's offset, for display
    let basePrice = nicePrice(price);
    const offset = isFinite(opts.offset) ? opts.offset : 0;
    price = nicePrice(price * (1 + offset));
    const clamp = p => {
        if (game.min != null) p = Math.max(game.min, p);
        if (game.max != null) p = Math.min(game.max, p);
        return p;
    };
    basePrice = clamp(basePrice);
    price = clamp(price);
    const parts = [];
    const at = `median ${fmt(med)} CC at gene ${medScore ?? '–'}`;
    if (comp.medalMode == 'same') {
        parts.push(`${list.length} ${groupName(animal, comp.medal)}: ${at}`);
    }
    else if (comp.medalMode == 'adjacent') {
        const f = Object.entries(comp.factors);
        const others = f.map(([m, x]) => `${x.count} ${medalLabel(m)}`).join(' + ');
        parts.push(`${comp.sameCount} ${groupName(animal, comp.medal)} + ${others} scaled to ${medalLabel(comp.medal)}: ${at}`);
        parts.push(`medal price ratio ${f.map(([m, x]) => `${medalLabel(m)} ×${x.factor.toFixed(2)} (${x.source})`).join(', ')}`);
    }
    else if (list.length) {
        parts.push(`${list.length} listings (${comp.label}), ${at}`);
    }
    if (comp.medalNote) {
        parts.push(`only ${comp.medalNote.sameCount} ${medalLabel(comp.medalNote.medal)} ${comp.medalNote.sameCount == 1 ? 'listing' : 'listings'}, so all medals compared by gene score`);
    }
    if (method == 'fit') parts.push('price fitted to gene score');
    if (gameValue != null) parts.push(`game value ${gameValue} CC (weight ${Math.round((1 - weight) * 100)}%)`);
    if (offset) parts.push(`your offset ${offsetLabel(offset)} (${basePrice} CC before it)`);
    return {
        price,
        basePrice,
        offset,
        confidence,
        method,
        reason: parts.join('; ') || 'game value only',
        comps: comp,
        medal: medalOf(animal),
        score,
        gameValue,
        marketPrice: marketPrice != null ? Math.round(marketPrice) : null,
    };
}

// Price book maintenance: newest observation per listing id wins; entries
// older than maxAgeMs are dropped (market listings expire within hours).
export function mergeListings(book, observed, now, maxAgeMs = 12 * 3600 * 1000) {
    const byId = new Map();
    for (const l of book) {
        if (now - l.seenAt <= maxAgeMs) byId.set(l.source + ':' + l.id, l);
    }
    for (const l of observed) {
        if (l.id == undefined || !(l.price > 0)) continue;
        const k = l.source + ':' + l.id;
        const prev = byId.get(k);
        const next = Object.assign({}, l, { seenAt: now });
        // a row read before the game filled its medal keeps the known one
        if (next.medal == undefined && prev && prev.medal != undefined) next.medal = prev.medal;
        byId.set(k, next);
    }
    return Array.from(byId.values());
}
