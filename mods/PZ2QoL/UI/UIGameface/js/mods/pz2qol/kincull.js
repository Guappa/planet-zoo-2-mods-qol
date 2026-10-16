// Thin out: which animals of one species to send to the trade centre (to
// sell, trade or release) when its habitats are full. Pure, no game
// imports (Node tests).
//
// Per habitat: a target number of adults = the habitat's room for the
// species (social maximum and space, as the breeding programme measures
// it) x a fill level (lean 70% / balanced 85% / full 100%; the room left
// is for the young). Habitats over their target give up their least
// valuable animals until they fit.
//
// Keep value (higher = keep):
//   genes        the animal's own gene score (the game's grades, 0..1)
//   fertility    fertile years ahead: too old / infertile 0, last fertile
//                years 0.3, young or fertile 1
//   relatives    each related animal in the same habitat lowers it (its
//                young there would be inbred)
//   role         alpha and bonded animals a little higher; in a harem, the
//                2nd, 3rd... fertile male lower
// Juveniles are only sent away by hand. Never sent away: pregnant females,
// animals on the move, the best fertile
// male and the best fertile females of each habitat (a breeding core), and
// the species' best genes overall (`keepBest` per sex).
import { ownGrades, fertilityText, Sex } from './kincore.js';
import { TRADE } from './kinboardcore.js';
import { habitatCapacity, estimateSpacePerAdult } from './kinprogramme.js';

export const FILL_STEPS = Object.freeze([
    { id: 'lean', label: 'Lean', fill: 0.7 },
    { id: 'balanced', label: 'Balanced', fill: 0.85 },
    { id: 'full', label: 'Full', fill: 1 },
]);

export const CULL_DEFAULTS = Object.freeze({
    fill: 0.85,
    oldAlways: false,       // send too-old animals away even from habitats that are not full
    keepBest: 1,            // per sex, the species' best genes are never sent away
    coreMales: 1,           // fertile males kept per habitat
    coreFemales: 2,         // fertile females kept per habitat
    keepIds: null,          // Set: the player said keep
    cullIds: null,          // Set: the player said send away
});

export function geneScore(a) {
    const g = ownGrades(a && a.genes);
    const vals = Object.values(g).filter(v => typeof v === 'number');
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

function fertilityValue(a) {
    const st = a.fert && a.fert.state;
    if (st === 'old' || st === 'sterile') return 0;
    if (st === 'ending') return 0.3;
    if (!st && a.infertile && !a.juv) return 0;
    return 1;
}

function breedsNow(a) {
    const st = a.fert && a.fert.state;
    return !a.juv && !a.contra && !a.infertile && st !== 'old' && st !== 'young' && st !== 'sterile';
}

function related(model, a, b) {
    if (!a.guid || !b.guid) return false;
    const rel = model.ped.relation(a.guid, b.guid);
    return !!rel && (rel.game || rel.kinship >= model.closeKinship - 1e-9);
}

// { value, gene, fert, relatives, parts }
export function keepValue(model, a, group, { system = 'mixed', maleRank = 0 } = {}) {
    const gene = geneScore(a);
    const fert = fertilityValue(a);
    const relatives = group.filter(b => b !== a && related(model, a, b)).length;
    let value = 0.55 * (gene == null ? 0.5 : gene) + 0.35 * fert - 0.06 * relatives;
    if (a.alpha) value += 0.08;
    if ((a.mates || []).some(id => group.some(b => b.id === id))) value += 0.05;
    if (system === 'polygyny' && a.sex === Sex.Male && breedsNow(a) && maleRank > 0) value -= 0.2;
    return { value, gene, fert, relatives };
}

function cullReason(a, k, group, system, maleRank) {
    const st = a.fert && a.fert.state;
    if (st === 'old') return 'too old to breed';
    if (st === 'sterile' || (!st && a.infertile && !a.juv)) return 'infertile';
    if (system === 'polygyny' && a.sex === Sex.Male && maleRank > 0 && breedsNow(a)) return 'an extra male (harem: one breeding male per habitat)';
    if (st === 'ending') return fertilityText(a);
    const best = Math.max(...group.map(b => geneScore(b) ?? 0));
    if (k.relatives >= 2) return `related to ${k.relatives} in this habitat`;
    if (k.gene != null) return `weaker genes (${Math.round(k.gene * 100)}; best here ${Math.round(best * 100)})`;
    return 'surplus';
}

// The plan for one species. info: the breeding programme's species facts
// (social, habitats space...), or {} (then the current count is the room).
export function cullPlan(model, species, info = {}, { options = {} } = {}) {
    const opts = Object.assign({}, CULL_DEFAULTS, options);
    if (!model || !species) return null;
    const keepIds = opts.keepIds instanceof Set ? opts.keepIds : new Set(opts.keepIds || []);
    const cullIds = opts.cullIds instanceof Set ? opts.cullIds : new Set(opts.cullIds || []);
    const system = info.mating || 'mixed';
    const infoX = Object.assign({}, info);
    if (!infoX.spacePerAdult) infoX.spacePerAdult = estimateSpacePerAdult(info);
    const all = Array.from(model.animals.values()).filter(a => a.species === species && !a.exhibit && a.alive !== false);
    const inHabitats = all.filter(a => a.hab);
    const atTrade = all.filter(a => !a.hab && a.lt === 'trade').length;
    // the species' best genes, per sex: never sent away
    const protectedBest = new Set();
    for (const sex of [Sex.Male, Sex.Female, Sex.Unisex]) {
        inHabitats.filter(a => a.sex === sex && !a.juv && fertilityValue(a) > 0)
            .sort((x, y) => (geneScore(y) ?? 0) - (geneScore(x) ?? 0))
            .slice(0, opts.keepBest).forEach(a => protectedBest.add(a.id));
    }
    const byHab = new Map();
    for (const a of inHabitats) {
        if (!byHab.has(a.hab)) byHab.set(a.hab, []);
        byHab.get(a.hab).push(a);
    }
    const habitats = [];
    const moves = [];
    for (const [hab, group] of byHab) {
        const adults = group.filter(a => !a.juv);
        const r = habitatCapacity(infoX, hab, NaN); // NaN: the game gave no room for it
        const room = Number.isFinite(r) ? r : null;
        const capacity = room != null ? room : adults.length;
        const target = Math.max(opts.coreMales + opts.coreFemales, Math.floor(capacity * opts.fill + 1e-9));
        // harem: rank the fertile males by genes
        const fertileMales = group.filter(a => a.sex === Sex.Male && breedsNow(a)).sort((x, y) => (geneScore(y) ?? 0) - (geneScore(x) ?? 0));
        const maleRankOf = a => fertileMales.indexOf(a);
        const scored = group.map(a => ({ a, k: keepValue(model, a, group, { system, maleRank: Math.max(0, maleRankOf(a)) }) }));
        // the breeding core: the best fertile male(s), then the best fertile
        // females not related to them (keep value, so relatives rank lower)
        const valueOf = new Map(scored.map(x => [x.a.id, x.k.value]));
        const byValue = list => list.slice().sort((x, y) => valueOf.get(y.id) - valueOf.get(x.id));
        const core = new Set();
        const coreMales = fertileMales.slice(0, opts.coreMales);
        coreMales.forEach(a => core.add(a.id));
        const females = group.filter(a => a.sex === Sex.Female && breedsNow(a));
        const unrelatedFirst = byValue(females).sort((x, y) => coreMales.some(m => related(model, m, x)) - coreMales.some(m => related(model, m, y)));
        unrelatedFirst.slice(0, opts.coreFemales).forEach(a => core.add(a.id));
        byValue(group.filter(a => a.sex === Sex.Unisex && breedsNow(a))).slice(0, opts.coreMales + opts.coreFemales).forEach(a => core.add(a.id));
        const fixed = a => keepIds.has(a.id) || a.preg || a.moving || core.has(a.id) || protectedBest.has(a.id);
        const why = new Map();
        // the player's choices first
        for (const { a } of scored) if (cullIds.has(a.id) && !a.moving) why.set(a.id, 'your choice');
        // the player's sends come on top: they do not make room for another to stay
        let over = adults.length - target;
        const candidates = scored.filter(x => !fixed(x.a) && !why.has(x.a.id)).sort((x, y) => x.k.value - y.k.value);
        for (const x of candidates) {
            const oldOne = fertilityValue(x.a) === 0 && !x.a.juv;
            // juveniles only by hand: the target counts adults, and the room
            // left by the fill level is for the young
            if (x.a.juv) continue;
            if (over > 0 || (opts.oldAlways && oldOne)) {
                why.set(x.a.id, cullReason(x.a, x.k, group, system, Math.max(0, maleRankOf(x.a))));
                if (!x.a.juv) over--;
            }
        }
        const cull = scored.filter(x => why.has(x.a.id)).map(x => ({ id: x.a.id, reason: why.get(x.a.id), value: x.k.value, gene: x.k.gene }));
        const keep = scored.filter(x => !why.has(x.a.id)).map(x => ({
            id: x.a.id, value: x.k.value, gene: x.k.gene,
            why: keepIds.has(x.a.id) ? 'your choice' : x.a.preg ? 'pregnant' : x.a.moving ? 'on the move' : core.has(x.a.id) ? 'breeding core' : protectedBest.has(x.a.id) ? 'best genes of the species' : '',
        }));
        habitats.push({ hab, adults: adults.length, juveniles: group.length - adults.length, capacity, room: room != null, target, keep, cull,
            keptAdults: keep.filter(x => !model.animals.get(x.id).juv).length });
        for (const c of cull) moves.push({ id: c.id, to: TRADE, reason: c.reason });
    }
    habitats.sort((x, y) => (y.adults - y.target) - (x.adults - x.target));
    const avg = list => {
        const v = list.map(a => geneScore(a)).filter(x => x != null);
        return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length * 100) : null;
    };
    const culled = new Set(moves.map(m => m.id));
    const kept = inHabitats.filter(a => !culled.has(a.id));
    const gone = inHabitats.filter(a => culled.has(a.id));
    return {
        species, system, fill: opts.fill, moves, habitats, atTrade,
        before: { animals: inHabitats.length, adults: inHabitats.filter(a => !a.juv).length, gene: avg(inHabitats), old: inHabitats.filter(a => fertilityValue(a) === 0 && !a.juv).length },
        after: { animals: kept.length, adults: kept.filter(a => !a.juv).length, gene: avg(kept), old: kept.filter(a => fertilityValue(a) === 0 && !a.juv).length },
        removedGene: avg(gone),
        estimated: !info.social && !(info.habitats && Object.keys(info.habitats).length),
    };
}
