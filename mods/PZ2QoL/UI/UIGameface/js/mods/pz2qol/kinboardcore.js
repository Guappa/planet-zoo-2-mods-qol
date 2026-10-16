// Species board: the planning engine. Pure, no game imports (Node tests).
//
// The board shows one species at a time: every habitat it lives in (and
// every habitat it could move to) as a column of animal cards. The player
// stages moves into a plan; the plan is simulated on the kin model so its
// effect shows before anything happens ("fixes 3 risks, creates 0").
//
// A plan is an array of moves: { id, to } where id is an animal id from the
// kin snapshot and `to` is a habitat id, or 'trade' for the trade centre.
// Destinations come from the Lua side (the game's own checks):
//   { bySpecies: { <species>: { <habitatId>: { ok, reason } } },
//     habitats: [{ id, name }], tradeCentre: { id, name } | null }
import { buildKinModel, normalizeSnapshot, severityRank, offspringScore, predictOffspring, Sex } from './kincore.js';

export const TRADE = 'trade';
const COUNTED = s => s === 'risk' || s === 'kin' || s === 'future';

// Animals that may be moved: in a habitat or the trade centre, not exhibit
// animals, not already on their way somewhere.
export function canMove(a) {
    return !!a && !a.exhibit && !a.moving && a.alive !== false && (a.lt === 'habitat' || a.lt === 'trade' || (!a.lt && !!a.hab));
}

function emptyCounts() {
    return { risk: 0, kin: 0, future: 0, covered: 0 };
}

// -------------------------------------------------------------- species

// Every species in the zoo (not exhibits), worst problems first.
export function speciesList(model) {
    if (!model) return [];
    const map = new Map();
    for (const a of model.animals.values()) {
        if (a.exhibit || !a.species) continue;
        let s = map.get(a.species);
        if (!s) map.set(a.species, s = { species: a.species, animals: 0, males: 0, females: 0, juveniles: 0, habitats: new Set(), away: 0, counts: emptyCounts() });
        s.animals++;
        if (a.sex === Sex.Male) s.males++;
        else if (a.sex === Sex.Female) s.females++;
        if (a.juv) s.juveniles++;
        if (a.hab) s.habitats.add(a.hab);
        else s.away++;
    }
    for (const p of model.pairs) {
        const s = map.get(p.species);
        if (s && p.severity in s.counts) s.counts[p.severity]++;
    }
    return Array.from(map.values()).map(s => Object.assign(s, { habitats: Array.from(s.habitats) }))
        .sort((x, y) => y.counts.risk - x.counts.risk || y.counts.kin - x.counts.kin || y.counts.future - x.counts.future
            || y.animals - x.animals || (x.species < y.species ? -1 : 1));
}

// ----------------------------------------------------------- simulation

function destName(model, to, destinations) {
    if (to === TRADE) return (destinations && destinations.tradeCentre && destinations.tradeCentre.name) || (model && model.tradeCentre && model.tradeCentre.name) || 'Trade centre';
    const h = model.habitats.get(String(to));
    if (h && h.name) return h.name;
    const d = destinations && (destinations.habitats || []).find(x => String(x.id) === String(to));
    return d ? d.name : String(to);
}

// The snapshot as it would be after the plan: moved animals sit in their
// destination habitat (or the trade centre, outside any habitat).
export function plannedSnapshot(model, plan, destinations) {
    const snap = model.snapshot;
    const moves = new Map((plan || []).map(m => [String(m.id), m]));
    const animals = snap.animals.map(a => {
        const m = moves.get(a.id);
        if (!m) return a;
        if (m.to === TRADE) return Object.assign({}, a, { hab: '', loc: destName(model, TRADE, destinations), lt: 'trade', mates: [] });
        return Object.assign({}, a, { hab: String(m.to), loc: destName(model, m.to, destinations), lt: 'habitat', mates: [] });
    });
    const habitats = snap.habitats.slice();
    for (const m of moves.values()) {
        if (m.to !== TRADE && !habitats.some(h => h.id === String(m.to))) {
            habitats.push({ id: String(m.to), name: destName(model, m.to, destinations), kind: 'habitat' });
        }
    }
    return Object.assign({}, snap, { animals, habitats, normalized: true });
}

export function simulatePlan(model, plan, destinations) {
    if (!model) return null;
    if (!plan || !plan.length) return model;
    return buildKinModel(plannedSnapshot(model, plan, destinations), { closeKinship: model.closeKinship });
}

// What a plan changes: pairs it removes and pairs it creates (counted
// severities only), and the counts before and after. Optionally for one
// species.
export function planImpact(before, after, species = null) {
    const pick = m => (m ? m.pairs.filter(p => COUNTED(p.severity) && (!species || p.species === species)) : []);
    const key = p => p.key;
    const b = new Map(pick(before).map(p => [key(p), p]));
    const a = new Map(pick(after).map(p => [key(p), p]));
    const fixed = [], created = [], changed = [];
    for (const [k, p] of b) {
        const q = a.get(k);
        if (!q) fixed.push(p);
        else if (severityRank(q.severity) < severityRank(p.severity)) fixed.push(p);
        else if (q.severity !== p.severity || q.hab !== p.hab) changed.push(q);
    }
    for (const [k, q] of a) {
        const p = b.get(k);
        if (!p || severityRank(q.severity) > severityRank(p.severity)) created.push(q);
    }
    const count = list => {
        const c = emptyCounts();
        for (const p of list) if (p.severity in c) c[p.severity]++;
        return c;
    };
    return {
        fixed, created, changed,
        before: count(pick(before)),
        after: count(pick(after)),
        risksFixed: fixed.filter(p => p.severity === 'risk').length,
        risksCreated: created.filter(p => p.severity === 'risk').length,
    };
}

// --------------------------------------------------------------- columns

function habitatOk(destinations, species, habId) {
    const bySpecies = destinations && destinations.bySpecies && destinations.bySpecies[species];
    if (!bySpecies) return null;                          // not known (yet)
    const d = bySpecies[String(habId)];
    return d ? d : { ok: false, reason: 'Not a suitable habitat for this species.' };
}

function countsOf(animals) {
    const c = { males: 0, females: 0, juveniles: 0, total: animals.length };
    for (const x of animals) {
        if (x.a.juv) c.juveniles++;
        else if (x.a.sex === Sex.Male) c.males++;
        else if (x.a.sex === Sex.Female) c.females++;
    }
    return c;
}

// The board for one species after the plan: columns of animal cards.
//   columns: [{ id, name, kind: 'habitat' | 'trade' | 'away', dest: { ok, reason } | null,
//               animals: [{ a, severity, pairs, planned: 'in' | null, from }],
//               leaving: [{ a, to, toName }], other: [{ species, count }], counts, risk: counts }]
export function boardColumns(model, species, plan, destinations, { includeEmpty = true } = {}) {
    if (!model || !species) return [];
    const after = simulatePlan(model, plan, destinations);
    const moves = new Map((plan || []).map(m => [String(m.id), m]));
    const columns = new Map();
    const col = (id, name, kind) => {
        if (!columns.has(id)) {
            columns.set(id, { id, name, kind, dest: kind === 'habitat' ? habitatOk(destinations, species, id) : null, animals: [], leaving: [], other: [], counts: null, risk: emptyCounts() });
        }
        return columns.get(id);
    };
    // where every animal of the species is after the plan
    for (const a of after.animals.values()) {
        if (a.species !== species || a.exhibit) continue;
        const before = model.animals.get(a.id);
        const m = moves.get(a.id);
        let c;
        if (a.hab) c = col(a.hab, (after.habitats.get(a.hab) || {}).name || a.loc || a.hab, 'habitat');
        else if (a.lt === 'trade') c = col(TRADE, destName(model, TRADE, destinations), 'trade');
        else c = col('away', 'Elsewhere', 'away');
        const pairs = (after.byAnimal.get(a.id) || []).filter(p => COUNTED(p.severity) || p.severity === 'covered');
        c.animals.push({ a, severity: pairs.length ? pairs[0].severity : null, pairs, planned: m ? 'in' : null, from: m && before ? (before.hab || before.lt || '') : null });
        if (m && before) {
            const fromId = before.hab || (before.lt === 'trade' ? TRADE : 'away');
            const fromCol = col(fromId, before.hab ? ((model.habitats.get(before.hab) || {}).name || before.loc) : (before.lt === 'trade' ? destName(model, TRADE, destinations) : 'Elsewhere'), before.hab ? 'habitat' : before.lt === 'trade' ? 'trade' : 'away');
            fromCol.leaving.push({ a: before, to: m.to, toName: destName(model, m.to, destinations) });
        }
    }
    // suitable habitats without this species yet
    if (includeEmpty && destinations && destinations.bySpecies && destinations.bySpecies[species]) {
        for (const [habId, d] of Object.entries(destinations.bySpecies[species])) {
            if (!d.ok || columns.has(habId)) continue;
            col(habId, destName(model, habId, destinations), 'habitat');
        }
    }
    // the trade centre is always offered: the Lua side finds it when the
    // move is made (the game's own "send to trade centre" does the same)
    col(TRADE, destName(model, TRADE, destinations), 'trade');
    // the other species sharing each habitat, and its risks for this species
    for (const c of columns.values()) {
        c.counts = countsOf(c.animals);
        if (c.kind !== 'habitat') continue;
        const bySpecies = after.groups.get(c.id);
        if (bySpecies) {
            for (const [sp, list] of bySpecies) if (sp !== species) c.other.push({ species: sp, count: list.length });
        }
        const s = after.habitatSummaries.get(c.id);
        const sp = s && s.species.find(x => x.species === species);
        if (sp) c.risk = Object.assign({}, sp.counts);
        c.animals.sort((x, y) => severityRank(y.severity) - severityRank(x.severity) || (x.a.sex - y.a.sex) || (x.a.juv - y.a.juv) || (x.a.name < y.a.name ? -1 : 1));
    }
    const order = c => (c.kind === 'habitat' ? (c.animals.length ? 0 : 1) : c.kind === 'trade' ? 2 : 3);
    return Array.from(columns.values()).sort((x, y) => order(x) - order(y)
        || (y.risk.risk - x.risk.risk) || (y.animals.length - x.animals.length) || (x.name < y.name ? -1 : 1));
}

// --------------------------------------------------------- plan editing

// Adds or replaces the move for one animal; moving it back home removes it.
export function setMove(model, plan, id, to) {
    const a = model && model.animals.get(String(id));
    const out = (plan || []).filter(m => String(m.id) !== String(id));
    if (!a) return out;
    const home = a.hab || (a.lt === 'trade' ? TRADE : null);
    if (to == null || String(to) === String(home)) return out;
    out.push({ id: String(id), to: String(to) });
    return out;
}

// Drops moves whose animal is gone, already moving, or already there.
export function prunePlan(model, plan) {
    return (plan || []).filter(m => {
        const a = model && model.animals.get(String(m.id));
        if (!a || !canMove(a)) return false;
        const home = a.hab || (a.lt === 'trade' ? TRADE : null);
        return String(m.to) !== String(home);
    });
}

// Problems with a plan before running it: unknown or unsuitable
// destinations, animals that cannot move.
export function planProblems(model, plan, destinations) {
    const out = [];
    for (const m of plan || []) {
        const a = model && model.animals.get(String(m.id));
        if (!a) {
            out.push({ id: m.id, text: 'This animal is no longer in the zoo.' });
            continue;
        }
        if (!canMove(a)) out.push({ id: m.id, text: `${a.name} cannot be moved right now${a.moving ? ' (already on the move)' : ''}.` });
        if (m.to !== TRADE) {
            const d = habitatOk(destinations, a.species, m.to);
            if (d && !d.ok) out.push({ id: m.id, text: `${a.name}: ${d.reason || 'not a suitable habitat'}` });
        }
    }
    return out;
}

// ------------------------------------------------------------ suggestions

function breedingValue(model, a, habId, species, after) {
    // unrelated adults of the other sex there: a reason to go there
    const g = after.groups.get(String(habId));
    const list = (g && g.get(species)) || [];
    let partners = 0, best = null;
    for (const b of list) {
        if (b.id === a.id || b.juv || b.sex === a.sex || a.sex === Sex.Unisex) continue;
        const rel = a.guid && b.guid ? model.ped.relation(a.guid, b.guid) : null;
        if (rel) continue;
        partners++;
        const s = offspringScore(predictOffspring(a.genes, b.genes));
        if (s != null && (best == null || s > best)) best = s;
    }
    return { partners, best };
}

// A plan that removes this species' inbreeding risks (and close kin) by
// moving as few animals as possible, each to the suitable habitat where it
// creates no new risk, keeps a partner of the other sex and the best
// expected young. Falls back to the trade centre only when nothing else
// works and `allowTrade` is set. Returns [{ id, to, reason }].
export function suggestPlan(model, species, destinations, { maxMoves = 12, allowTrade = false, includeKin = true } = {}) {
    if (!model || !species) return [];
    const watched = s => s === 'risk' || (includeKin && s === 'kin');
    const options = (destinations && destinations.bySpecies && destinations.bySpecies[species]) || null;
    const habitatsOk = options ? Object.entries(options).filter(([, d]) => d.ok).map(([id]) => id) : [];
    let plan = [];
    const tried = new Set();
    for (let step = 0; step < maxMoves; step++) {
        const current = simulatePlan(model, plan, destinations);
        const problems = current.pairs.filter(p => p.species === species && watched(p.severity));
        if (!problems.length) break;
        // the animal in the most problem pairs (ties: juveniles and males
        // first, they are the usual ones to move; then the weaker genes)
        const load = new Map();
        for (const p of problems) {
            for (const x of [p.a, p.b]) load.set(x.id, (load.get(x.id) || 0) + (p.severity === 'risk' ? 3 : 1));
        }
        const candidates = Array.from(load.entries())
            .map(([id, n]) => ({ a: current.animals.get(id), n }))
            .filter(x => x.a && canMove(model.animals.get(x.a.id)) && !tried.has(x.a.id) && !plan.some(m => m.id === x.a.id))
            .sort((x, y) => y.n - x.n || (y.a.juv - x.a.juv) || ((y.a.sex === Sex.Male) - (x.a.sex === Sex.Male)) || (x.a.name < y.a.name ? -1 : 1));
        if (!candidates.length) break;
        let chosen = null;
        for (const cand of candidates) {
            const a = cand.a;
            let best = null;
            const targets = habitatsOk.filter(h => h !== a.hab);
            if (allowTrade && destinations && destinations.tradeCentre) targets.push(TRADE);
            for (const to of targets) {
                const trial = plan.concat([{ id: a.id, to }]);
                const after = simulatePlan(model, trial, destinations);
                const impact = planImpact(current, after, species);
                const createdBad = impact.created.filter(p => watched(p.severity)).length;
                const fixedBad = impact.fixed.filter(p => watched(p.severity)).length;
                if (fixedBad === 0 || createdBad > 0) continue;
                const value = to === TRADE ? { partners: 0, best: null } : breedingValue(model, a, to, species, after);
                const score = fixedBad * 100 - createdBad * 200 + Math.min(value.partners, 3) * 10 + (value.best || 0) / 10 - (to === TRADE ? 50 : 0);
                if (!best || score > best.score) best = { to, score, fixedBad, value };
            }
            if (best) {
                chosen = { a, best };
                break;
            }
            tried.add(a.id);
        }
        if (!chosen) break;
        const { a, best } = chosen;
        const why = best.to === TRADE
            ? `to the trade centre: no habitat takes ${a.name} without another relative`
            : `${best.fixedBad} related pair${best.fixedBad > 1 ? 's' : ''} fewer${best.value.partners ? `; ${best.value.partners} unrelated ${a.sex === Sex.Male ? 'female' : 'male'}${best.value.partners > 1 ? 's' : ''} there` : ''}`;
        plan = plan.concat([{ id: a.id, to: best.to, reason: why }]);
    }
    return plan;
}

// Text for one move ("Kito ♂: Savannah Habitat → Jungle Habitat").
export function moveText(model, m, destinations) {
    const a = model && model.animals.get(String(m.id));
    if (!a) return String(m.id);
    const sym = a.sex === Sex.Male ? '♂' : a.sex === Sex.Female ? '♀' : '';
    const from = a.hab ? ((model.habitats.get(a.hab) || {}).name || a.loc) : (a.lt === 'trade' ? 'Trade centre' : (a.loc || 'elsewhere'));
    return `${a.name} ${sym}: ${from} → ${destName(model, m.to, destinations)}`;
}

export { normalizeSnapshot };
