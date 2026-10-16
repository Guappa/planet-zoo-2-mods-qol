// Breeding programme: the best layout of one species' breeders across its
// habitats, for genetics. Pure, no game imports (Node tests).
//
// Value of a breeding pair = expected young (the mean of the predicted
// fertility, immunity, size and longevity, by the game's own gene formula)
// x the chance of conception (the game's own probability, by fertility
// grade). Relatives never breed: a related, fertile male-female pair in one
// habitat is a heavy penalty, so the search removes it.
//
// Group shape follows the species' mating system:
//   monogamy   each animal breeds with one partner (best matching)
//   polygyny   one breeding male per habitat, any number of females
//   polyandry  one breeding female per habitat, any number of males
//   mixed      every female with her best unrelated male (default)
// Habitat capacity (adults of this species) comes from the species' social
// maximum and the habitat's space (estimated per adult from the game's own
// requirement for the current population).
//
// Search: start from the current layout, then improve by moving one breeder
// (to another allowed habitat, or out to the trade centre) or swapping two
// breeders of the same sex, until nothing improves. Every move costs a
// little; splitting a bonded pair and joining an established group cost
// more. Juveniles and non-breeding adults stay where they are and count
// towards capacity.
import { predictOffspring, Sex } from './kincore.js';
import { TRADE, normalizeAssignments, assignedHabitatsOf, habitatAllowedFor } from './kinboardcore.js';

export const PROGRAMME_DEFAULTS = Object.freeze({
    moveCost: 0.04,          // per moved animal, in pair-value units (0..1)
    bondBreakCost: 0.15,     // separating two current mates
    outsiderCost: 0.02,      // joining a habitat that already has this species
    relatedPenalty: 2,       // per related fertile pair living together
    overCapacityPenalty: 1,  // per adult over capacity
    structurePenalty: 1,     // per extra breeding male (polygyny) / female (polyandry)
    lineBonus: 0.01,         // per distinct family line in a habitat (future flexibility)
    maxEvaluations: 60000,
    defaultCapacity: 8,
});

const MATING = new Set(['monogamy', 'polygyny', 'polyandry', 'mixed']);

function fertGrade(a) {
    const g = a.genes && a.genes.F;
    if (typeof g !== 'string') return null;
    const s = g.length === 12 ? g.split('') : g.split('.');
    if (s.length !== 12) return null;
    let d = 0;
    for (let i = 0; i < 6; i++) if (s[i] !== s[i + 6]) d++;
    return d; // 0..6, the game's fertility grade x 6
}

// The animal's age limits and state decide whether it breeds.
export function isBreeder(a, info = {}) {
    if (!a || a.exhibit || a.juv || a.alive === false) return false;
    if (a.contra) return false;
    if (a.infertile) return false;              // sterile (contraception handled above)
    const bounds = info.fertilityAges;
    if (bounds && typeof a.age === 'number') {
        if (bounds.maturity != null && a.age < bounds.maturity) return false;
        if (bounds.infertility != null && bounds.infertility < 900 && a.age >= bounds.infertility) return false;
    }
    return a.sex === Sex.Male || a.sex === Sex.Female || a.sex === Sex.Unisex;
}

// Conception chance for a pair: the game's own table by fertility grades
// (info.conception[fM][fF], 0..1), else a fertility-based estimate.
export function conceptionChance(m, f, info = {}) {
    const fm = fertGrade(m), ff = fertGrade(f);
    const t = info.conception;
    if (t && fm != null && ff != null && t[fm] && typeof t[fm][ff] === 'number') return t[fm][ff];
    if (fm == null || ff == null) return 0.5;
    return Math.max(0.05, Math.min(1, (fm + ff) / 12));
}

// Expected young genetics (0..1): mean of the predicted means.
export function youngQuality(m, f) {
    const pred = predictOffspring(m.genes, f.genes);
    if (!pred) return 0.5;
    const vals = ['fertility', 'immunity', 'size', 'longevity'].map(k => pred[k] && pred[k].mean).filter(v => typeof v === 'number');
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0.5;
}

// ------------------------------------------------------------------ setup

function relatedPair(model, a, b) {
    if (!a.guid || !b.guid) return false;
    const rel = model.ped.relation(a.guid, b.guid);
    return !!rel && (rel.game || rel.kinship >= model.closeKinship - 1e-9);
}

function lineOf(a) {
    return a.par && a.par.length ? a.par.slice().sort().join('+') : 'f:' + a.id;
}

// capacity in adults of this species, per habitat
export function habitatCapacity(info, habId, fallback) {
    const h = info.habitats && info.habitats[habId];
    const social = info.social && info.social.max > 0 ? info.social.max : null;
    let space = null;
    if (h && h.available) {
        const perAdult = info.spacePerAdult || {};
        for (const k of Object.keys(perAdult)) {
            const need = perAdult[k];
            const have = h.available[k];
            if (!(need > 0) || typeof have !== 'number') continue;
            const n = Math.floor(have / need);
            space = space == null ? n : Math.min(space, n);
        }
    }
    let cap = social != null && space != null ? Math.min(social, space) : (social != null ? social : space);
    if (cap == null) cap = fallback;
    return Math.max(0, cap);
}

// Space one adult needs, per area type: the game's requirement for the
// current population divided by that population, averaged over habitats.
export function estimateSpacePerAdult(info) {
    const sums = {}, counts = {};
    for (const h of Object.values(info.habitats || {})) {
        if (!h.required || !(h.adults > 0)) continue;
        for (const [k, v] of Object.entries(h.required)) {
            if (!(v > 0)) continue;
            sums[k] = (sums[k] || 0) + v / h.adults;
            counts[k] = (counts[k] || 0) + 1;
        }
    }
    const out = {};
    for (const k of Object.keys(sums)) out[k] = sums[k] / counts[k];
    return out;
}

// ------------------------------------------------------------- evaluation

function pairValue(ctx, m, f) {
    const key = m.id < f.id ? m.id + '|' + f.id : f.id + '|' + m.id;
    let v = ctx.pairCache.get(key);
    if (v === undefined) {
        v = relatedPair(ctx.model, m, f) ? -1 : youngQuality(m, f) * conceptionChance(m, f, ctx.info);
        ctx.pairCache.set(key, v);
    }
    return v; // -1 = related
}

// Value of one habitat's breeders under the mating system (+ penalties).
function habitatScore(ctx, habId, breeders) {
    if (habId === TRADE) return 0;
    const males = breeders.filter(a => a.sex === Sex.Male || a.sex === Sex.Unisex);
    const females = breeders.filter(a => a.sex === Sex.Female || (a.sex === Sex.Unisex && !males.includes(a)));
    const P = ctx.opts;
    let value = 0, penalty = 0;
    // related fertile pairs living together
    for (const m of males) for (const f of females) if (m !== f && pairValue(ctx, m, f) < 0) penalty += P.relatedPenalty;
    const system = ctx.system;
    if (system === 'monogamy') {
        // greedy best matching
        const pairs = [];
        for (const m of males) for (const f of females) {
            const v = pairValue(ctx, m, f);
            if (v > 0) pairs.push([v, m, f]);
        }
        pairs.sort((x, y) => y[0] - x[0]);
        const used = new Set();
        for (const [v, m, f] of pairs) {
            if (used.has(m) || used.has(f)) continue;
            used.add(m);
            used.add(f);
            value += v;
        }
    }
    else if (system === 'polyandry') {
        if (females.length > 1) penalty += (females.length - 1) * P.structurePenalty;
        for (const m of males) {
            let best = 0;
            for (const f of females) best = Math.max(best, pairValue(ctx, m, f));
            value += best;
        }
    }
    else {
        if (system === 'polygyny' && males.length > 1) penalty += (males.length - 1) * P.structurePenalty;
        for (const f of females) {
            let best = 0;
            for (const m of males) if (m !== f) best = Math.max(best, pairValue(ctx, m, f));
            value += best;
        }
    }
    // capacity (adults of this species, breeders and the ones staying)
    const adults = breeders.length + (ctx.fixedAdults.get(habId) || 0);
    const cap = ctx.capacity.get(habId);
    if (cap != null && adults > cap) penalty += (adults - cap) * P.overCapacityPenalty;
    // distinct family lines: room to swap partners next generation
    const lines = new Set(breeders.map(lineOf));
    value += lines.size * P.lineBonus;
    return value - penalty;
}

function moveCosts(ctx, layout) {
    const P = ctx.opts;
    let cost = 0;
    const broken = new Set();
    for (const a of ctx.breeders) {
        const to = layout.get(a.id);
        if (to === ctx.home.get(a.id)) continue;
        cost += P.moveCost;
        if (to !== TRADE && ctx.establishedHere.has(to)) cost += P.outsiderCost;
        // a bonded mate left behind (or taken elsewhere): each bond once
        for (const mateId of a.mates || []) {
            if (!ctx.byId.has(mateId)) continue;
            const mateTo = layout.has(mateId) ? layout.get(mateId) : ctx.home.get(mateId);
            const key = a.id < mateId ? a.id + '|' + mateId : mateId + '|' + a.id;
            if (mateTo !== to && !broken.has(key)) {
                broken.add(key);
                cost += P.bondBreakCost;
            }
        }
    }
    return cost;
}

function totalScore(ctx, layout) {
    const groups = new Map();
    for (const h of ctx.habitats) groups.set(h, []);
    for (const a of ctx.breeders) {
        const h = layout.get(a.id);
        if (!groups.has(h)) groups.set(h, []);
        groups.get(h).push(a);
    }
    let s = 0;
    for (const [h, list] of groups) s += habitatScore(ctx, h, list);
    return s - moveCosts(ctx, layout);
}

// ---------------------------------------------------------------- planner

// info: { social: {min,max}, fertilityAges: {maturity, infertility},
//         mating: 'monogamy'|'polygyny'|'polyandry'|'mixed'|null,
//         conception: [[p]], habitats: { habId: { available, required, adults } } }
// destinations: the Species board destinations; assignments: habitat -> species.
export function planProgramme(model, species, info = {}, destinations = null, { assignments = null, options = {} } = {}) {
    const opts = Object.assign({}, PROGRAMME_DEFAULTS, options);
    if (!model || !species) return null;
    const all = Array.from(model.animals.values()).filter(a => a.species === species && !a.exhibit && a.alive !== false);
    const byId = new Map(all.map(a => [a.id, a]));
    const canMoveA = a => !a.moving && (a.lt === 'habitat' || a.lt === 'trade' || (!a.lt && !!a.hab));
    const breeders = all.filter(a => isBreeder(a, info) && canMoveA(a));
    const home = new Map(all.map(a => [a.id, a.hab || (a.lt === 'trade' ? TRADE : 'away')]));
    // where the species may live
    const assign = normalizeAssignments(assignments);
    const mine = assignedHabitatsOf(assign, species);
    const ok = destinations && destinations.bySpecies && destinations.bySpecies[species];
    let habitats;
    if (mine.length) habitats = mine.filter(h => !ok || !ok[h] || ok[h].ok);
    else {
        const set = new Set(all.filter(a => a.hab).map(a => a.hab));
        if (ok) for (const [h, d] of Object.entries(ok)) if (d.ok) set.add(h);
        habitats = Array.from(set).filter(h => habitatAllowedFor(assign, h, species));
    }
    // breeders already in a habitat outside the allowed list stay allowed there
    const allowed = new Set(habitats);
    for (const a of breeders) if (a.hab && !allowed.has(a.hab) && !mine.length) allowed.add(a.hab);
    habitats = Array.from(allowed);
    const fixedAdults = new Map();
    for (const a of all) {
        if (breeders.includes(a) || a.juv || !a.hab) continue;
        fixedAdults.set(a.hab, (fixedAdults.get(a.hab) || 0) + 1);
    }
    const infoX = Object.assign({}, info);
    if (!infoX.spacePerAdult) infoX.spacePerAdult = estimateSpacePerAdult(info);
    const capacity = new Map(habitats.map(h => [h, habitatCapacity(infoX, h, opts.defaultCapacity)]));
    const establishedHere = new Set(all.filter(a => a.hab && !a.juv).map(a => a.hab));
    const system = MATING.has(info.mating) ? info.mating : 'mixed';
    const ctx = { model, info: infoX, opts, breeders, byId, home, habitats, capacity, fixedAdults, establishedHere, system, pairCache: new Map() };

    // start: everyone where they are (animals at the trade centre stay there)
    const layout = new Map(breeders.map(a => [a.id, home.get(a.id)]));
    const startLayout = new Map(layout);
    let score = totalScore(ctx, layout);
    const startScore = score;
    const targets = habitats.concat([TRADE]);
    let evals = 0, improved = true;
    while (improved && evals < opts.maxEvaluations) {
        improved = false;
        // move one breeder
        for (const a of breeders) {
            const from = layout.get(a.id);
            let best = null;
            for (const to of targets) {
                if (to === from) continue;
                layout.set(a.id, to);
                const s = totalScore(ctx, layout);
                evals++;
                if (s > score + 1e-9 && (!best || s > best.s)) best = { to, s };
            }
            layout.set(a.id, best ? best.to : from);
            if (best) {
                score = best.s;
                improved = true;
            }
            if (evals >= opts.maxEvaluations) break;
        }
        // swap two breeders of the same sex between habitats
        for (let i = 0; i < breeders.length && evals < opts.maxEvaluations; i++) {
            for (let j = i + 1; j < breeders.length; j++) {
                const a = breeders[i], b = breeders[j];
                if (a.sex !== b.sex) continue;
                const ha = layout.get(a.id), hb = layout.get(b.id);
                if (ha === hb) continue;
                layout.set(a.id, hb);
                layout.set(b.id, ha);
                const s = totalScore(ctx, layout);
                evals++;
                if (s > score + 1e-9) {
                    score = s;
                    improved = true;
                }
                else {
                    layout.set(a.id, ha);
                    layout.set(b.id, hb);
                }
            }
        }
    }
    // tidy up: undo every move the result does not need (the search can
    // take a detour, e.g. two moves where one would do)
    let pruned = true;
    while (pruned) {
        pruned = false;
        for (const a of breeders) {
            const to = layout.get(a.id);
            const back = home.get(a.id);
            if (to === back) continue;
            layout.set(a.id, back);
            const s = totalScore(ctx, layout);
            evals++;
            if (s >= score - 1e-9) {
                score = s;
                pruned = true;
            }
            else layout.set(a.id, to);
        }
        // and pairs of moves that only swap places (two same-sex animals)
        for (let i = 0; i < breeders.length && !pruned; i++) {
            for (let j = i + 1; j < breeders.length; j++) {
                const a = breeders[i], b = breeders[j];
                const ta = layout.get(a.id), tb = layout.get(b.id);
                if (ta === home.get(a.id) || tb === home.get(b.id)) continue;
                layout.set(a.id, home.get(a.id));
                layout.set(b.id, home.get(b.id));
                const s = totalScore(ctx, layout);
                evals++;
                if (s >= score - 1e-9) {
                    score = s;
                    pruned = true;
                    break;
                }
                layout.set(a.id, ta);
                layout.set(b.id, tb);
            }
        }
    }
    // the plan: every breeder that ends up somewhere else
    const moves = [];
    for (const a of breeders) {
        const to = layout.get(a.id);
        if (to !== home.get(a.id)) moves.push({ id: a.id, to, reason: to === TRADE ? 'no place in a breeding group' : 'breeding programme' });
    }
    return {
        system,
        moves,
        score, startScore,
        evaluations: evals,
        before: programmeStats(ctx, startLayout),
        after: programmeStats(ctx, layout),
        groups: groupsOf(ctx, layout),
        capacity: Object.fromEntries(capacity),
        habitats,
    };
}

// Breeding pairs, expected young and related pairs for a layout.
function programmeStats(ctx, layout) {
    const groups = groupsOf(ctx, layout);
    let pairs = 0, related = 0, quality = 0, chance = 0, breedingFemales = 0, idle = 0;
    for (const g of groups) {
        if (g.hab === TRADE) {
            idle += g.animals.length;
            continue;
        }
        const males = g.animals.filter(a => a.sex !== Sex.Female);
        const females = g.animals.filter(a => a.sex !== Sex.Male);
        for (const m of males) for (const f of females) if (m !== f && pairValue(ctx, m, f) < 0) related++;
        for (const f of females) {
            let best = null;
            for (const m of males) {
                if (m === f) continue;
                const v = pairValue(ctx, m, f);
                if (v > 0 && (!best || v > best.v)) best = { v, q: youngQuality(m, f), c: conceptionChance(m, f, ctx.info) };
            }
            if (best) {
                pairs++;
                breedingFemales++;
                quality += best.q;
                chance += best.c;
            }
            else idle++;
        }
    }
    return {
        breedingPairs: pairs,
        relatedPairs: related,
        youngQuality: pairs ? Math.round(quality / pairs * 100) : null,     // 0..100
        conception: pairs ? Math.round(chance / pairs * 100) : null,        // %
        breedingFemales,
        idle,
    };
}

function groupsOf(ctx, layout) {
    const map = new Map();
    for (const a of ctx.breeders) {
        const h = layout.get(a.id);
        if (!map.has(h)) map.set(h, []);
        map.get(h).push(a);
    }
    return Array.from(map.entries()).map(([hab, animals]) => ({
        hab,
        animals,
        males: animals.filter(a => a.sex === Sex.Male).length,
        females: animals.filter(a => a.sex === Sex.Female).length,
        capacity: ctx.capacity.get(hab) ?? null,
        staying: ctx.fixedAdults.get(hab) || 0,
    }));
}
