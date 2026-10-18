// Pure computations for PZ2QoL. No game imports, so it runs under Node tests.
//
// An "animal" here is a plain object:
// { id, species, gender, maturity, isShoal, isExhibit, isPregnant, isAlpha,
//   storageTag, price, isCC, genes: { size, longevity, fertility, immunity } }
// Gene values are 0..1 as the game sends them; missing genes are undefined.

export const Gender = { Male: 0, Female: 1, Unisex: 2 };
// The game's EAnimalMaturity (ManagementDataTypes.js): age stage plus
// fertility in one value. Storage and market rows carry it as `maturity`.
export const Maturity = { Infant: 0, YoungAdult: 1, Adult: 2, Elderly: 3, YoungAdultInfertile: 4, AdultInfertile: 5, ElderlyInfertile: 6 };

function isNum(v) {
    return typeof v === 'number' && isFinite(v);
}

// Which genes count for this animal. The game shows a dash for size and
// immunity on exhibit animals and for every gene on shoals.
export function relevantGenes(a) {
    if (a.isShoal) {
        return [];
    }
    if (a.isExhibit) {
        return ['longevity', 'fertility'];
    }
    return ['size', 'longevity', 'fertility', 'immunity'];
}

// Mean of the relevant genes, 0..100, or null when unknown.
export function geneScore(a) {
    const genes = a.genes || {};
    const values = relevantGenes(a).map(k => genes[k]).filter(isNum);
    if (values.length == 0) {
        return null;
    }
    return Math.round(values.reduce((s, v) => s + v, 0) / values.length * 100);
}

// Weighted for breeding: fertility matters most, then longevity, immunity.
export function breederScore(a) {
    const genes = a.genes || {};
    const weights = a.isExhibit ? { fertility: 0.55, longevity: 0.45 } : { fertility: 0.4, longevity: 0.3, immunity: 0.3 };
    if (a.isShoal) {
        return null;
    }
    let total = 0;
    let weightSum = 0;
    for (const k in weights) {
        if (isNum(genes[k])) {
            total += genes[k] * weights[k];
            weightSum += weights[k];
        }
    }
    return weightSum > 0 ? Math.round(total / weightSum * 100) : null;
}

// Gene score per price unit: per 1,000 cash or per 100 CC. Higher is better.
export function valueIndex(a) {
    const score = geneScore(a);
    if (score == null || !isNum(a.price) || a.price <= 0) {
        return null;
    }
    const units = a.isCC ? a.price / 100 : a.price / 1000;
    return Math.round(score / units * 10) / 10;
}

// The ★ "best value" only goes to animals that are worth having at all.
export const BEST_VALUE_MIN_SCORE = 60;

export function isBestValueCandidate(a) {
    const g = geneScore(a);
    return g != null && g >= BEST_VALUE_MIN_SCORE && valueIndex(a) != null;
}

export function scoreTier(score) {
    if (score == null) {
        return 'none';
    }
    if (score >= 80) {
        return 'great';
    }
    if (score >= 60) {
        return 'good';
    }
    if (score >= 40) {
        return 'fair';
    }
    return 'poor';
}

export function isAdult(a) {
    return a.maturity != undefined && a.maturity != Maturity.Infant;
}

// An adult the game marks fertile (young adult, adult or elderly). Infants
// and the three "infertile" stages are out.
export function isFertileAdult(a) {
    return a.maturity == Maturity.YoungAdult || a.maturity == Maturity.Adult || a.maturity == Maturity.Elderly;
}

// Elderly and no longer fertile: the Franchise market won't take these
// (developer report); the game's own in-park sell lists "infertile" as a
// sell preventer (bInfertileSell, RelocateAnimalsPopup).
export function isInfertileElderly(a) {
    return a.maturity == Maturity.ElderlyInfertile;
}

// Why the game would refuse to list this storage animal, from what the row
// shows. The park's own sell flow blocks juveniles, infertile animals and
// pregnant ones (RelocateAnimalsPopup g_tSellPreventers: bJuvenileSell,
// bInfertileSell, bPregnant, bPendingTransport); a storage row can also be
// on the market already or on its way to the zoo. Dead, boxed, injured,
// sick, escaped and in-surgery only happen in a park, and "can't be sold"
// has no row field, so the game's own check still has the last word.
// Unknown maturity blocks nothing.
export const SELL_BLOCKERS = {
    juvenile: 'Juvenile',
    infertile: 'Infertile',
    pregnant: 'Pregnant',
    listed: 'Already listed',
    moving: 'Being moved',
};

export function sellBlockers(a) {
    const out = [];
    if (a.maturity == Maturity.Infant) out.push('juvenile');
    if (a.maturity == Maturity.YoungAdultInfertile || a.maturity == Maturity.AdultInfertile || a.maturity == Maturity.ElderlyInfertile) out.push('infertile');
    if (a.isPregnant) out.push('pregnant');
    if (isOnMarket(a)) out.push('listed');
    if (a.isMoving) out.push('moving');
    return out;
}

export function isSellable(a) {
    return sellBlockers(a).length == 0;
}

export function canBreed(a) {
    return a.maturity == Maturity.YoungAdult || a.maturity == Maturity.Adult;
}

// Per-species summary used by the storage filters and summary bar.
export function speciesStats(animals) {
    const stats = new Map();
    for (const a of animals) {
        const key = a.species || '?';
        let s = stats.get(key);
        if (!s) {
            s = { species: key, total: 0, males: [], females: [], breedingMales: 0, breedingFemales: 0 };
            stats.set(key, s);
        }
        s.total++;
        if (a.gender == Gender.Male) {
            s.males.push(a);
            if (canBreed(a)) s.breedingMales++;
        }
        else if (a.gender == Gender.Female) {
            s.females.push(a);
            if (canBreed(a)) s.breedingFemales++;
        }
    }
    for (const s of stats.values()) {
        s.pairs = Math.min(s.breedingMales, s.breedingFemales);
    }
    return stats;
}

// Animals beyond the best `keep` of each species+sex, ranked by gene score.
// These are trade or release candidates.
export function surplusIds(animals, keep) {
    const ids = new Set();
    for (const s of speciesStats(animals).values()) {
        for (const group of [s.males, s.females]) {
            if (group.length <= keep) {
                continue;
            }
            const ranked = group.slice().sort((x, y) => (geneScore(y) ?? -1) - (geneScore(x) ?? -1));
            for (const a of ranked.slice(keep)) {
                ids.add(a.id);
            }
        }
    }
    return ids;
}

export const DEFAULT_STORAGE_FILTERS = Object.freeze({
    minScore: 0,
    pregnant: false,
    alpha: false,
    adults: false,
    fertileAdults: false, // adults the game marks fertile (no infertile elderly)
    juveniles: false,
    pairsOnly: false,
    surplusOnly: false,
    surplusKeep: 2,
    hideListed: false, // hide animals already listed on the market
    related: false, // only animals with a close relative in storage (Kin)
    sellable: 'any', // 'any' | 'yes' (the market would take it) | 'no' (sellBlockers)
    sort: 'none', // 'none' | 'gene' | 'breeder'
});

// Same test the game's storage row uses (MarketAnimalListItem: isOnMarket).
export function isOnMarket(a) {
    return a.auctionTimerSeconds != undefined && a.auctionTimerSeconds > 0;
}

export function storageFiltersActive(f) {
    return f.minScore > 0 || f.pregnant || f.alpha || f.adults || f.fertileAdults || f.juveniles || f.pairsOnly || f.surplusOnly || f.hideListed || !!f.related || (!!f.sellable && f.sellable != 'any') || f.sort != 'none';
}

// Returns the animals to show, in display order. Input order is kept
// unless a sort is chosen. `predicates` holds filters other modules add
// (key -> animal -> bool, e.g. Kin's `related`); each applies while the
// flag of the same name is on. A flag without a predicate filters nothing.
export function applyStorageFilters(animals, f, predicates = {}) {
    // listed animals are leaving: they don't count for pairs or surplus either
    if (f.hideListed) animals = animals.filter(a => !isOnMarket(a));
    const stats = (f.pairsOnly) ? speciesStats(animals) : null;
    const surplus = (f.surplusOnly) ? surplusIds(animals, f.surplusKeep) : null;
    const extra = Object.keys(predicates || {}).filter(k => f[k] && typeof predicates[k] === 'function').map(k => predicates[k]);
    let out = animals.filter(a => {
        for (const test of extra) {
            if (!test(a)) return false;
        }
        if (f.minScore > 0) {
            const s = geneScore(a);
            if (s == null || s < f.minScore) return false;
        }
        if (f.pregnant && !a.isPregnant) return false;
        if (f.alpha && !a.isAlpha) return false;
        if (f.adults && !isAdult(a)) return false;
        if (f.fertileAdults && !isFertileAdult(a)) return false;
        if (f.juveniles && isAdult(a)) return false;
        if (f.sellable == 'yes' && !isSellable(a)) return false;
        if (f.sellable == 'no' && isSellable(a)) return false;
        if (stats) {
            const s = stats.get(a.species || '?');
            if (!s || s.pairs < 1) return false;
        }
        if (surplus && !surplus.has(a.id)) return false;
        return true;
    });
    if (f.sort == 'gene' || f.sort == 'breeder') {
        const fn = f.sort == 'gene' ? geneScore : breederScore;
        out = out.map((a, i) => ({ a, i, s: fn(a) }))
            .sort((x, y) => ((y.s ?? -1) - (x.s ?? -1)) || (x.i - y.i))
            .map(x => x.a);
    }
    return out;
}

export function storageSummary(animals) {
    const scores = animals.map(geneScore).filter(isNum);
    const stats = speciesStats(animals);
    let pairs = 0;
    for (const s of stats.values()) pairs += s.pairs;
    return {
        count: animals.length,
        males: animals.filter(a => a.gender == Gender.Male).length,
        females: animals.filter(a => a.gender == Gender.Female).length,
        pregnant: animals.filter(a => a.isPregnant).length,
        species: stats.size,
        pairs,
        avgScore: scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null,
    };
}

// Market presets: lists of [eventSuffix, value] sent through the game's own
// filter events, so they run in native code across every page.
export const MARKET_PRESETS = [
    {
        id: 'topGenes', label: 'Top genes', tooltip: 'Size, longevity, fertility and immunity all 80%+',
        events: [['FilterSizeMin', 80], ['FilterLongevityMin', 80], ['FilterFertilityMin', 80], ['FilterImmunityMin', 80]],
    },
    {
        id: 'breeders', label: 'Breeders', tooltip: 'Fertility 75%+, longevity 60%+, immunity 60%+',
        events: [['FilterSizeMin', 0], ['FilterLongevityMin', 60], ['FilterFertilityMin', 75], ['FilterImmunityMin', 60]],
    },
    {
        id: 'longLived', label: 'Long-lived', tooltip: 'Longevity 85%+',
        events: [['FilterSizeMin', 0], ['FilterLongevityMin', 85], ['FilterFertilityMin', 0], ['FilterImmunityMin', 0]],
    },
    {
        id: 'endingSoon', label: 'Ending ≤1h', tooltip: 'Listings with an hour or less remaining',
        events: [['FilterAuctionTimeMax', 2]],
    },
    {
        id: 'cash', label: 'Cash', tooltip: 'Only listings priced in cash',
        events: [['FilterCredits', false], ['FilterCash', true]],
    },
    {
        id: 'cc', label: 'CC', tooltip: 'Only listings priced in Conservation Credits',
        events: [['FilterCash', false], ['FilterCredits', true]],
    },
];

// ------------------------------------------------------------ zoo list
// Filters for the zoo management Animals list. Animals there also carry
// `habitat` (location name), `contracepted` and `welfare` (0..1).

export const DEFAULT_ZOO_FILTERS = Object.freeze({
    habitat: null,      // location name, or null for all
    sex: 'any',         // 'any' | 'male' | 'female'
    stage: 'any',       // 'any' | 'adult' | 'juvenile'
    pregnant: false,
    alpha: false,
    contracepted: false,
    unhappy: false,     // welfare below a third
    minScore: 0,
    minFertility: 0,    // 0..100
    kin: 'off',         // 'off' | 'risk' (inbreeding risk) | 'any' (risk, close kin, later)
    sort: 'none',       // 'none' | 'gene' | 'breeder' | 'welfare' | 'kin'
});

// Zoo animals may carry kinSeverity ('risk' | 'kin' | 'future' | 'held' | 'covered')
// and kinCluster (relatives share one key), set from the Kin model.
const KIN_RANK = { risk: 5, kin: 4, future: 3, held: 2, covered: 1 };

export const UNHAPPY_WELFARE = 1 / 3;

export function zooFiltersActive(f) {
    return f.habitat != null || f.sex != 'any' || f.stage != 'any' || f.pregnant || f.alpha || f.contracepted
        || f.unhappy || f.minScore > 0 || f.minFertility > 0 || f.sort != 'none' || (!!f.kin && f.kin != 'off');
}

export function applyZooFilters(animals, f) {
    let out = animals.filter(a => {
        if (f.habitat != null && a.habitat != f.habitat) return false;
        if (f.sex == 'male' && a.gender != Gender.Male) return false;
        if (f.sex == 'female' && a.gender != Gender.Female) return false;
        if (f.stage == 'adult' && !isAdult(a)) return false;
        if (f.stage == 'juvenile' && isAdult(a)) return false;
        if (f.pregnant && !a.isPregnant) return false;
        if (f.alpha && !a.isAlpha) return false;
        if (f.contracepted && !a.contracepted) return false;
        if (f.unhappy && !(typeof a.welfare === 'number' && a.welfare < UNHAPPY_WELFARE)) return false;
        if (f.minScore > 0) {
            const s = geneScore(a);
            if (s == null || s < f.minScore) return false;
        }
        if (f.minFertility > 0) {
            const v = a.genes && a.genes.fertility;
            if (typeof v !== 'number' || v * 100 < f.minFertility) return false;
        }
        if (f.kin == 'risk' && a.kinSeverity != 'risk') return false;
        if (f.kin == 'any' && !(KIN_RANK[a.kinSeverity] >= KIN_RANK.future)) return false;
        return true;
    });
    if (f.sort == 'kin') {
        // worst first, relatives next to each other, then the game's order
        const clusterRank = new Map();
        for (const a of out) {
            const r = KIN_RANK[a.kinSeverity] || 0;
            if (a.kinCluster != null && r > (clusterRank.get(a.kinCluster) || 0)) clusterRank.set(a.kinCluster, r);
        }
        return out.map((a, i) => ({ a, i, c: a.kinCluster != null ? clusterRank.get(a.kinCluster) : (KIN_RANK[a.kinSeverity] || 0) }))
            .sort((x, y) => y.c - x.c || String(x.a.kinCluster ?? '~' + x.i).localeCompare(String(y.a.kinCluster ?? '~' + y.i)) || x.i - y.i)
            .map(x => x.a);
    }
    if (f.sort != 'none') {
        const key = f.sort == 'gene' ? geneScore : f.sort == 'breeder' ? breederScore : (a => typeof a.welfare === 'number' ? Math.round(a.welfare * 100) : null);
        const desc = f.sort != 'welfare'; // welfare: worst first, so problems surface
        out = out.map((a, i) => ({ a, i, s: key(a) }))
            .sort((x, y) => {
                const xs = x.s ?? (desc ? -1 : 101);
                const ys = y.s ?? (desc ? -1 : 101);
                return (desc ? ys - xs : xs - ys) || (x.i - y.i);
            })
            .map(x => x.a);
    }
    return out;
}

// Habitat names with counts, most populated first (for the habitat picker).
export function habitatCounts(animals) {
    const counts = new Map();
    for (const a of animals) {
        if (!a.habitat) continue;
        counts.set(a.habitat, (counts.get(a.habitat) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([name, count]) => ({ name, count }))
        .sort((x, y) => y.count - x.count || (x.name < y.name ? -1 : 1));
}
