// Market price analysis and price recommendation. Pure functions, no game
// imports, so they run under Node tests.
//
// A "listing" is { id, species, gender, maturity, isShoal, isExhibit, score,
// price, isCC, source: 'market' | 'history', seenAt }. Its id is listingKey(),
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

// The listings that are comparable to `animal`, best tier first.
//   tier 1: same gender and life stage
//   tier 2: same gender
//   tier 3: any gender
export function comparables(animal, listings) {
    const stage = lifeStage(animal.maturity);
    // A storage animal that is already listed shows up on the market too.
    const ownKey = listingKey(animal);
    const base = listings.filter(l => l.species == animal.species && l.isCC && l.price > 0
        && l.id != animal.id && l.id != ownKey && !!l.isShoal == !!animal.isShoal);
    const tiers = [
        { tier: 1, label: 'same sex and age group', list: base.filter(l => l.gender == animal.gender && lifeStage(l.maturity) == stage) },
        { tier: 2, label: 'same sex', list: base.filter(l => l.gender == animal.gender) },
        { tier: 3, label: 'any sex', list: base },
    ];
    for (const t of tiers) {
        if (t.list.length >= 3) return t;
    }
    return tiers.find(t => t.list.length > 0) || { tier: 0, label: 'no market data', list: [] };
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

// Per-sex breakdown of current CC prices for a species, plus your own sales.
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
    if (list.length) parts.push(`${list.length} listings (${comp.label}), median ${Math.round(med)} CC at gene ${medScore ?? '–'}`);
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
        byId.set(l.source + ':' + l.id, Object.assign({}, l, { seenAt: now }));
    }
    return Array.from(byId.values());
}
