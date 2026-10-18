// Breeding programme: the best layout of one species' breeders across its
// habitats, for genetics. Pure, no game imports (Node tests).
//
// Objective (higher is better), summed over the habitats:
//   + each breeding pair's value: expected young (the mean of the predicted
//     fertility, immunity, size and longevity, by the game's own gene
//     formula) x the chance of conception (the game's own probability, by
//     fertility grade) x how long the pair can breed (fertile years left of
//     the one that ages out first; old or infertile animals are not
//     breeders)
//   - relatives living together: a related, fertile male-female pair in one
//     habitat is a heavy penalty, so the search removes it
//   - adults over the habitat's room, breeders over the group make-up
//   + a little per distinct family line (room to swap partners later)
// minus the cost of the moves: each moved animal, joining an established
// group, separating bonded mates.
//
// Group make-up (groupRule): m males with f females. 1:1 pairs, 1:3 a male
// with three females, 1:any a harem (one breeding male per habitat), any:1
// one breeding female per habitat, or mixed groups (every female with her
// best unrelated male). First found: the player's choice for the species,
// the game's most of each sex per habitat, the game's own social groups for
// the species, the mating system. In a habitat each male breeds with up to
// f/m females (each female with up to m/f males) and the pairs are the best
// possible set (maxWeightPairs, exact). Breeders beyond what the other sex
// needs (1:3 with 4 females: 2 males) or over the game's most per sex are a
// penalty, so the surplus moves on, and open places draw breeders in from
// the trade centre and from other habitats' surplus.
//
// Habitat room (adults of this species) comes from the species' social
// maximum and the habitat's space (estimated per adult from the game's own
// requirement for the current population). Juveniles and non-breeding
// adults stay where they are and count towards it.
//
// Breeders waiting at the trade centre (bought, or sent there) count as
// breeders with no group: the search may bring them into a habitat
// (option useTradeCentre, on by default).
//
// Search (solveLayout), the same answer every time for the same zoo:
//   - few breeders (up to exactLimit layouts): every layout is scored, the
//     best wins (ties: fewer moves);
//   - more: local search from the current layout (move one breeder, swap
//     two, move a male and a female together into a habitat) and each sex
//     placed at once given the other (reassign: an exact assignment of the
//     plentiful sex to the habitats' room and partners); then rounds of a
//     kick (one or two breeders of the scarce sex, often a group's head,
//     moved at random and the rest placed again around them) or a ruin and
//     recreate (the breeders of one or two habitats, or a few at random,
//     taken out and put back where they do the most good, a male and a
//     female as a new group). Simulated annealing decides whether to keep
//     each round, and the best layout seen is kept. A seeded random source,
//     an evaluation budget, and a time cap as a safety net.
// Then every move the result does not need is undone (an equal layout with
// fewer moves wins). A habitat's score is cached by who lives there, and a
// step only scores again the habitats it changes. Checked against every
// layout on small zoos and against long runs on big ones
// (tests/kinprogramme.test.mjs).
import { predictOffspring, Sex } from './kincore.js';
import { TRADE, normalizeAssignments, assignedHabitatsOf, habitatAllowedFor } from './kinboardcore.js';

export const PROGRAMME_DEFAULTS = Object.freeze({
    moveCost: 0.04,          // per moved animal, in pair-value units (0..1)
    bondBreakCost: 0.15,     // separating two current mates
    outsiderCost: 0.02,      // joining a habitat that already has this species
    relatedPenalty: 2,       // per related fertile pair living together
    overCapacityPenalty: 1,  // per adult over capacity
    structurePenalty: 1,     // per breeder over the group make-up or the game's most per sex
    lineBonus: 0.01,         // per distinct family line in a habitat (future flexibility)
    maxEvaluations: 600000,  // search budget: layout changes scored (about 0.4 s for 100 breeders)
    timeBudgetMs: 1500,      // safety net: stop searching after this long
    exactLimit: 20000,       // score every layout when there are no more than this many
    defaultCapacity: 8,
    useTradeCentre: true,    // breeders waiting at the trade centre may join a group
    ratio: 'auto',           // the player's group make-up (RATIO_CHOICES); 'auto': the game's
    seed: 0,                 // mixed into the zoo's own seed (tests)
});

const MATING = new Set(['monogamy', 'polygyny', 'polyandry', 'mixed']);
const EPS = 1e-9;
const AWAY = 'away';

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
    const st = a.fert && a.fert.state;
    if (st === 'old' || st === 'young' || st === 'sterile') return false;
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

// Fertile years left (null: unknown or for life): the snapshot's
// fertility, else the species' fertility ages from the game.
export function fertileYearsLeft(a, info = {}) {
    if (a.fert && a.fert.yearsLeft != null) return a.fert.yearsLeft;
    const b = info.fertilityAges;
    if (b && typeof a.age === 'number' && b.infertility != null && b.infertility < 900) return Math.max(0, b.infertility - a.age);
    return null;
}

// How long a pair can breed, as a weight 0.25..1: full when both have at
// least `horizon` fertile years left (a third of the species' fertile span,
// at least 2 years), less as the first of them ages out.
export function longevityWeight(m, f, info = {}) {
    const left = [fertileYearsLeft(m, info), fertileYearsLeft(f, info)].filter(v => v != null);
    if (!left.length) return 1;
    const b = info.fertilityAges;
    const span = b && b.infertility != null && b.infertility < 900 && b.maturity != null ? b.infertility - b.maturity : null;
    const horizon = Math.max(2, span != null ? span / 3 : 3);
    return Math.max(0.25, Math.min(1, Math.min(...left) / horizon));
}

// Expected young genetics (0..1): mean of the predicted means.
export function youngQuality(m, f) {
    const pred = predictOffspring(m.genes, f.genes);
    if (!pred) return 0.5;
    const vals = ['fertility', 'immunity', 'size', 'longevity'].map(k => pred[k] && pred[k].mean).filter(v => typeof v === 'number');
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0.5;
}

// ---------------------------------------------------------- group make-up

// What the player can pick per species ('auto': the game's facts).
// '1:*' one male with any number of females (a harem), '*:1' the reverse.
export const RATIO_CHOICES = Object.freeze(['auto', '1:1', '1:2', '1:3', '1:4', '1:5', '1:*', '2:1', '3:1', '*:1', 'mixed']);

// '1:3' -> { m: 1, f: 3 }, '1:*' -> { m: 1, f: Infinity }, 'mixed' ->
// 'mixed'; anything else (or 'auto') -> null. One side is always 1.
export function parseRatio(s) {
    const t = String(s == null ? '' : s).trim();
    if (t === 'mixed') return 'mixed';
    const x = /^(\d+|\*):(\d+|\*)$/.exec(t);
    if (!x) return null;
    const n = v => (v === '*' ? Infinity : parseInt(v, 10));
    const m = n(x[1]), f = n(x[2]);
    if (!(m >= 1) || !(f >= 1) || (m !== 1 && f !== 1)) return null;
    return { m, f };
}

// Counts of males and females -> the nearest 1:k or k:1.
export function reduceRatio(males, females) {
    if (!(males > 0) || !(females > 0)) return null;
    if (females >= males) return { m: 1, f: Math.max(1, Math.round(females / males)) };
    return { m: Math.max(1, Math.round(males / females)), f: 1 };
}

// '1:3', '1:*', 'mixed'...: a rule's make-up in RATIO_CHOICES words.
export function ratioKey(rule) {
    if (!rule || rule.m == null) return 'mixed';
    const w = v => (v === Infinity ? '*' : String(v));
    return `${w(rule.m)}:${w(rule.f)}`;
}

const harem = r => !!r && r.m === 1 && r.f > 1;
const reverseHarem = r => !!r && r.f === 1 && r.m > 1;
// a make-up that agrees with the mating system
function fitsSystem(r, system) {
    if (system === 'monogamy') return r.m === 1 && r.f === 1;
    if (system === 'polygyny') return harem(r);
    if (system === 'polyandry') return reverseHarem(r);
    return true;
}
const SYSTEM_RATIO = {
    monogamy: { m: 1, f: 1 },
    polygyny: { m: 1, f: Infinity },
    polyandry: { m: Infinity, f: 1 },
};
const GROUP_ORDER = ['mixed', 'mixedLarge', 'pair'];

// How the species' breeders form groups:
//   m, f                 m males with f females (null: mixed groups)
//   maxMales, maxFemales the game's most breeders of a sex per habitat (or null)
//   source               'yours' (the player's choice), 'game' (the game's most
//                        per sex), 'groups' (the game's social groups for the
//                        species), 'mating' (the mating system; 'mixed' for
//                        Polygyandry, where both sexes take several mates),
//                        'none' (no mating system the mod could read)
//   system               the mating system ('mixed' when unknown)
//   solitary             the game's groups are all of one sex (male alone,
//                        female alone, bachelor groups): a solitary species
// info.sexMax = { male, female } and info.groups = [{ kind, m, f }] come
// from the game (Kin.SpeciesInfo); choice is a RATIO_CHOICES entry.
export function groupRule(info = {}, choice = 'auto') {
    const known = MATING.has(info && info.mating);
    const system = known ? info.mating : 'mixed';
    const caps = info && info.sexMax && typeof info.sexMax === 'object' ? info.sexMax : {};
    const allGroups = (info && Array.isArray(info.groups) ? info.groups : []).filter(g => g && typeof g === 'object');
    const solitary = allGroups.length > 0 && allGroups.every(g => !(g.m > 0 && g.f > 0));
    const out = (r, source) => ({
        m: r ? r.m : null,
        f: r ? r.f : null,
        maxMales: caps.male > 0 ? Math.floor(caps.male) : null,
        maxFemales: caps.female > 0 ? Math.floor(caps.female) : null,
        source,
        system,
        solitary,
    });
    const mine = parseRatio(choice);
    if (mine) return out(mine === 'mixed' ? null : mine, 'yours');
    const fromCaps = reduceRatio(caps.male, caps.female);
    if (fromCaps && fitsSystem(fromCaps, system)) return out(fromCaps, 'game');
    const groups = allGroups.filter(g => g.m > 0 && g.f > 0);
    const rank = g => {
        const i = GROUP_ORDER.indexOf(g.kind);
        return i < 0 ? GROUP_ORDER.length : i;
    };
    for (const g of groups.slice().sort((x, y) => rank(x) - rank(y))) {
        const r = reduceRatio(g.m, g.f);
        if (r && fitsSystem(r, system)) return out(r, 'groups');
    }
    if (SYSTEM_RATIO[system]) return out(SYSTEM_RATIO[system], 'mating');
    // Polygyandry (both sexes take several mates; the Zoopedia's
    // "Promiscuous", e.g. tigers and bears): mixed groups, as the game says
    if (known) return out(null, 'mating');
    return out(null, 'none');
}

// The game's social group kinds (Kin.SpeciesInfo `groups[].kind`) in words.
export const GROUP_KIND_WORDS = Object.freeze({
    mixed: 'mixed group', mixedLarge: 'large mixed group', pair: 'breeding pair', maleBachelor: 'male group',
    femaleBachelor: 'female group', maleSolitary: 'male alone', femaleSolitary: 'female alone',
});

// Why the make-up is not known (groupRule source 'none'), with what the game
// did give: its mating rule as it came when the mod could not read it
// (info.matingRaw), and its groups, which then have no group with both sexes
// (all one sex: a solitary species; or none at all).
export function unknownMakeupText(info = {}) {
    const groups = (info && Array.isArray(info.groups) ? info.groups : []).filter(g => g && typeof g === 'object');
    const raw = info && info.matingRaw != null && String(info.matingRaw) !== '' ? String(info.matingRaw) : null;
    const rule = raw ? `The game's mating rule came as "${raw}", which the mod can't read` : 'The game gave no mating rule';
    const solitary = groups.length > 0 && groups.every(g => !(g.m > 0 && g.f > 0));
    let about;
    if (!groups.length) about = 'and no group make-up';
    else {
        const list = groups.map(g => `${GROUP_KIND_WORDS[g.kind] || g.kind || 'group'}: ${g.m || 0} ♂ ${g.f || 0} ♀`).join(', ');
        about = solitary ? `and its groups are all of one sex (${list}), as for a solitary species` : `and its groups (${list}) don't say`;
    }
    const max = info && info.social && info.social.max > 0 ? `, up to ${info.social.max} adults per habitat` : '';
    return `${rule}, ${about}. Mixed groups are assumed: each female with her best unrelated male${max}. `
        + 'If you know how it breeds, choose the make-up with the arrows (kept for this zoo).';
}

// Partners per animal: a male breeds with up to `male` females, a female
// with up to `female` males (one of the two is always 1).
function partnersPer(rule) {
    if (!rule || rule.m == null) return { male: Infinity, female: 1 }; // mixed: each female her best male
    return { male: rule.m === 1 ? rule.f : 1, female: rule.f === 1 ? rule.m : 1 };
}

// The breeders a habitat with room for `room` adults asks for under the
// make-up: { males, females }, the most pairs (ties: fewer of the scarce
// sex), within the game's most per sex. null for mixed groups.
export function groupTarget(rule, room) {
    if (!rule || rule.m == null || !(room >= 1)) return null;
    room = Math.floor(room);
    const scarceIsMale = rule.m === 1;
    const k = scarceIsMale ? rule.f : rule.m;               // partners of one scarce-sex animal
    const capScarce = (scarceIsMale ? rule.maxMales : rule.maxFemales) ?? Infinity;
    const capOther = (scarceIsMale ? rule.maxFemales : rule.maxMales) ?? Infinity;
    let best = null;
    for (let s = 1; s <= Math.min(room, capScarce); s++) {
        const o = Math.min(room - s, s * k, capOther);
        if (!best || o > best.o) best = { s, o };
    }
    if (!best) return null;
    return scarceIsMale ? { males: best.s, females: best.o } : { males: best.o, females: best.s };
}

// ---------------------------------------------------------- best pairs

// Hungarian method (shortest augmenting paths): n rows <= m columns, cost
// n x m (flat), the lowest total. -> column of each row.
function hungarian(n, m, cost) {
    const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
    const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
    const minv = new Float64Array(m + 1), used = new Uint8Array(m + 1);
    for (let i = 1; i <= n; i++) {
        p[0] = i;
        let j0 = 0;
        minv.fill(Infinity);
        used.fill(0);
        do {
            used[j0] = 1;
            const i0 = p[j0];
            let delta = Infinity, j1 = 0;
            const row = (i0 - 1) * m;
            for (let j = 1; j <= m; j++) {
                if (used[j]) continue;
                const cur = cost[row + j - 1] - u[i0] - v[j];
                if (cur < minv[j]) {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if (minv[j] < delta) {
                    delta = minv[j];
                    j1 = j;
                }
            }
            for (let j = 0; j <= m; j++) {
                if (used[j]) {
                    u[p[j]] += delta;
                    v[j] -= delta;
                }
                else minv[j] -= delta;
            }
            j0 = j1;
        } while (p[j0] !== 0);
        do {
            const j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        } while (j0);
    }
    const match = new Int32Array(n).fill(-1);
    for (let j = 1; j <= m; j++) if (p[j]) match[p[j] - 1] = j - 1;
    return match;
}

// The best set of pairs: each male with up to perMale females, each female
// with up to perFemale males, the most total value (only pairs worth more
// than 0). Exact: when one side may take any number of partners, each
// animal of the other side simply takes its best; otherwise the Hungarian
// method on copies of the animals that take several partners.
// value(m, f) -> number. Returns [[value, male, female], ...].
export function maxWeightPairs(males, females, value, perMale = 1, perFemale = 1) {
    const out = [];
    const M = males.length, F = females.length;
    if (!M || !F) return out;
    const w = new Float64Array(M * F);
    let any = false;
    for (let i = 0; i < M; i++) {
        for (let j = 0; j < F; j++) {
            const v = males[i] === females[j] ? 0 : value(males[i], females[j]);
            if (v > 0) {
                w[i * F + j] = v;
                any = true;
            }
        }
    }
    if (!any) return out;
    if (perMale >= F && perFemale === 1) {
        // each female with her best male
        for (let j = 0; j < F; j++) {
            let bi = -1;
            for (let i = 0; i < M; i++) if (w[i * F + j] > 0 && (bi < 0 || w[i * F + j] > w[bi * F + j])) bi = i;
            if (bi >= 0) out.push([w[bi * F + j], males[bi], females[j]]);
        }
        return out;
    }
    if (perFemale >= M && perMale === 1) {
        for (let i = 0; i < M; i++) {
            let bj = -1;
            for (let j = 0; j < F; j++) if (w[i * F + j] > 0 && (bj < 0 || w[i * F + j] > w[i * F + bj])) bj = j;
            if (bj >= 0) out.push([w[i * F + bj], males[i], females[bj]]);
        }
        return out;
    }
    const rows = [], cols = [];
    for (let i = 0; i < M; i++) for (let c = 0; c < Math.min(perMale, F); c++) rows.push(i);
    for (let j = 0; j < F; j++) for (let c = 0; c < Math.min(perFemale, M); c++) cols.push(j);
    const flip = rows.length > cols.length;
    const n = flip ? cols.length : rows.length, m = flip ? rows.length : cols.length;
    const cost = new Float64Array(n * m);
    for (let a = 0; a < n; a++) {
        for (let b = 0; b < m; b++) {
            const r = flip ? rows[b] : rows[a], c = flip ? cols[a] : cols[b];
            cost[a * m + b] = -w[r * F + c];
        }
    }
    const match = hungarian(n, m, cost);
    for (let a = 0; a < n; a++) {
        const b = match[a];
        if (b < 0) continue;
        const r = flip ? rows[b] : rows[a], c = flip ? cols[a] : cols[b];
        const v = w[r * F + c];
        if (v > 0) out.push([v, males[r], females[c]]);
    }
    return out;
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

const isMaleSide = s => s === Sex.Male || s === Sex.Unisex;
const isFemaleSide = s => s === Sex.Female || s === Sex.Unisex;

const wallClock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function hashSeed(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

// mulberry32: a small seeded random source (the same plan every time)
function randomSource(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Evaluations and time (opts.clock: the async runner's searching time).
function makeBudget(opts) {
    const clock = typeof opts.clock === 'function' ? opts.clock : wallClock;
    const t0 = clock();
    let checked = 0;
    const b = {
        evals: 0,
        limit: opts.maxEvaluations,
        timedOut: false,
        ms: () => clock() - t0,
        out() {
            if (b.evals >= b.limit) return true;
            if (b.evals - checked >= 200) {
                checked = b.evals;
                if (clock() - t0 > opts.timeBudgetMs) b.timedOut = true;
            }
            return b.timedOut;
        },
    };
    return b;
}

// The search's view of the species: breeders by index, places by index
// (the habitats, the breeders' own habitats, the trade centre).
function makeContext(model, info, opts, breeders, all, habitats, home) {
    const n = breeders.length;
    const placeKeys = habitats.slice();
    for (const a of breeders) if (!placeKeys.includes(home.get(a.id))) placeKeys.push(home.get(a.id));
    if (!placeKeys.includes(TRADE)) placeKeys.push(TRADE);
    const P = placeKeys.length;
    const placeOf = new Map(placeKeys.map((k, i) => [k, i]));
    const trade = placeOf.get(TRADE);
    const groupPlace = placeKeys.map(k => k !== TRADE && k !== AWAY);
    const allowed = new Set(habitats);
    const fixedAdults = new Map();
    for (const a of all) {
        if (breeders.includes(a) || a.juv || !a.hab) continue;
        fixedAdults.set(a.hab, (fixedAdults.get(a.hab) || 0) + 1);
    }
    const capacity = new Map();
    for (const k of placeKeys) if (k !== TRADE && k !== AWAY) capacity.set(k, habitatCapacity(info, k, opts.defaultCapacity));
    const established = new Set(all.filter(a => a.hab && !a.juv).map(a => a.hab));
    const rule = groupRule(info, opts.ratio);
    const per = partnersPer(rule);
    const ctx = {
        model, info, opts, rule, per, n, P, placeKeys, placeOf, trade, groupPlace,
        B: breeders,
        sex: breeders.map(a => a.sex),
        line: breeders.map(lineOf),
        home: Int32Array.from(breeders.map(a => placeOf.get(home.get(a.id)))),
        fixed: placeKeys.map(k => fixedAdults.get(k) || 0),
        cap: placeKeys.map(k => (capacity.has(k) ? capacity.get(k) : null)),
        estab: placeKeys.map(k => established.has(k)),
        capacity, fixedAdults,
        memo: new Map(),
        pvCache: new Float64Array(n * n).fill(NaN),
        // random words for the score cache's keys (32 + 21 bits)
        zA: new Uint32Array(n), zB: new Uint32Array(n), zpA: new Uint32Array(P), zpB: new Uint32Array(P),
        all: Array.from({ length: n }, (_, i) => i),
    };
    const zr = randomSource(hashSeed(`z|${n}|${P}`));
    for (let i = 0; i < n; i++) {
        ctx.zA[i] = Math.floor(zr() * 4294967296);
        ctx.zB[i] = Math.floor(zr() * 2097152);
    }
    for (let q = 0; q < P; q++) {
        ctx.zpA[q] = Math.floor(zr() * 4294967296);
        ctx.zpB[q] = Math.floor(zr() * 2097152);
    }
    ctx.maleSide = ctx.all.filter(i => isMaleSide(ctx.sex[i]));
    ctx.femaleSide = ctx.all.filter(i => isFemaleSide(ctx.sex[i]));
    ctx.allowedPlace = placeKeys.map(k => allowed.has(k));
    ctx.groupPlaces = placeKeys.map((k, p) => p).filter(p => groupPlace[p] && allowed.has(placeKeys[p]));
    // where each breeder may go: the allowed habitats, the trade centre, home
    ctx.targetsOf = ctx.all.map(i => {
        const t = new Set(ctx.groupPlaces);
        t.add(trade);
        t.add(ctx.home[i]);
        return Array.from(t).sort((x, y) => x - y);
    });
    ctx.canGo = (i, p) => p === ctx.home[i] || p === trade || (groupPlace[p] && allowed.has(placeKeys[p]));
    // the pair's value, male m with female f (indices): -1 = related
    ctx.pv = (m, f) => {
        const k = m * n + f;
        let v = ctx.pvCache[k];
        if (v !== v) {
            const a = breeders[m], b = breeders[f];
            v = relatedPair(model, a, b) ? -1 : youngQuality(a, b) * conceptionChance(a, b, info) * longevityWeight(a, b, info);
            ctx.pvCache[k] = v;
        }
        return v;
    };
    ctx.compatible = (i, j) => i !== j && ((isMaleSide(ctx.sex[i]) && isFemaleSide(ctx.sex[j])) || (isFemaleSide(ctx.sex[i]) && isMaleSide(ctx.sex[j])));
    // either order: the male (or the first) as the father
    ctx.pvAny = (i, j) => (isMaleSide(ctx.sex[i]) && isFemaleSide(ctx.sex[j]) ? ctx.pv(i, j) : ctx.pv(j, i));
    // bonds between current mates: { a, b (breeder index or -1), ext (the other's place, or -1) }
    const byId = new Map(breeders.map((a, i) => [a.id, i]));
    const allIds = new Map(all.map(a => [a.id, a]));
    ctx.bonds = [];
    ctx.bondsOf = ctx.all.map(() => []);
    const seen = new Set();
    breeders.forEach((a, i) => {
        for (const mateId of a.mates || []) {
            if (!allIds.has(mateId)) continue;
            const key = a.id < mateId ? a.id + '|' + mateId : mateId + '|' + a.id;
            if (seen.has(key)) continue;
            seen.add(key);
            const j = byId.has(mateId) ? byId.get(mateId) : -1;
            const extKey = j < 0 ? home.get(mateId) : null;
            const bond = { a: i, b: j, ext: j < 0 && placeOf.has(extKey) ? placeOf.get(extKey) : -1 };
            ctx.bonds.push(bond);
            ctx.bondsOf[i].push(ctx.bonds.length - 1);
            if (j >= 0) ctx.bondsOf[j].push(ctx.bonds.length - 1);
        }
    });
    return ctx;
}

// ------------------------------------------------------------- evaluation

// The breeding pairs of one habitat's breeders (indices), under the make-up.
// A unisex animal is on both sides: two of them make one couple (the lower
// index as the father), and it keeps its number of partners over both roles.
function groupPairs(ctx, list) {
    const males = [], females = [];
    let unisex = false;
    for (const i of list) {
        if (isMaleSide(ctx.sex[i])) males.push(i);
        if (isFemaleSide(ctx.sex[i])) females.push(i);
        if (ctx.sex[i] === Sex.Unisex) unisex = true;
    }
    if (!unisex) return maxWeightPairs(males, females, ctx.pv, ctx.per.male, ctx.per.female);
    const U = Sex.Unisex;
    const value = (m, f) => (ctx.sex[m] === U && ctx.sex[f] === U && m > f ? 0 : ctx.pv(m, f));
    const pairs = maxWeightPairs(males, females, value, ctx.per.male, ctx.per.female);
    // a unisex animal used as father and as mother: keep its best pairs only
    const most = ctx.per.male === 1 && ctx.per.female === 1 ? 1 : Infinity;
    if (most === Infinity) return pairs;
    const used = new Map();
    return pairs.sort((x, y) => y[0] - x[0]).filter(([, m, f]) => {
        if (ctx.sex[m] !== U && ctx.sex[f] !== U) return true;
        if ((used.get(m) || 0) >= most || (used.get(f) || 0) >= most) return false;
        used.set(m, (used.get(m) || 0) + 1);
        used.set(f, (used.get(f) || 0) + 1);
        return true;
    });
}

function relatedCount(ctx, list) {
    let n = 0;
    for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) {
            const i = list[x], j = list[y];
            if (ctx.compatible(i, j) && ctx.pvAny(i, j) < 0) n++;
        }
    }
    return n;
}

// Breeders over the make-up: males beyond what the females need (1:3 with
// 4 females: 2), or beyond the game's most per sex; the same for females.
function overStructure(ctx, nm, nf) {
    const r = ctx.rule;
    let allowM = Infinity, allowF = Infinity;
    if (harem(r)) allowM = Math.max(1, Math.ceil(nf / r.f));
    else if (reverseHarem(r)) allowF = Math.max(1, Math.ceil(nm / r.m));
    if (r.maxMales != null) allowM = Math.min(allowM, r.maxMales);
    if (r.maxFemales != null) allowF = Math.min(allowF, r.maxFemales);
    return Math.max(0, nm - allowM) + Math.max(0, nf - allowF);
}

// Score of one place's breeders (indices); cached by who is there.
function placeScore(ctx, p, list) {
    if (!ctx.groupPlace[p] || !list.length) return 0;
    // key: the place and who is there, as two xor-hashes in one number
    let ha = ctx.zpA[p], hb = ctx.zpB[p];
    for (const i of list) {
        ha ^= ctx.zA[i];
        hb ^= ctx.zB[i];
    }
    const key = hb * 4294967296 + (ha >>> 0);
    const hit = ctx.memo.get(key);
    if (hit !== undefined) return hit;
    const P = ctx.opts;
    let value = 0, penalty = relatedCount(ctx, list) * P.relatedPenalty;
    for (const pr of groupPairs(ctx, list)) value += pr[0];
    let nm = 0, nf = 0;
    for (const i of list) {
        if (ctx.sex[i] === Sex.Male) nm++;
        else if (ctx.sex[i] === Sex.Female) nf++;
    }
    penalty += overStructure(ctx, nm, nf) * P.structurePenalty;
    const adults = list.length + ctx.fixed[p];
    const cap = ctx.cap[p];
    if (cap != null && adults > cap) penalty += (adults - cap) * P.overCapacityPenalty;
    const lines = new Set();
    for (const i of list) lines.add(ctx.line[i]);
    value += lines.size * P.lineBonus;
    const s = value - penalty;
    if (ctx.memo.size > 200000) ctx.memo.clear();
    ctx.memo.set(key, s);
    return s;
}

function moveCost(ctx, i, p) {
    if (p === ctx.home[i]) return 0;
    return ctx.opts.moveCost + (ctx.groupPlace[p] && ctx.estab[p] ? ctx.opts.outsiderCost : 0);
}

// a bond is broken when one of the two moved and they live apart
function bondBroken(ctx, b, at) {
    const bond = ctx.bonds[b];
    const pa = at(bond.a);
    if (bond.b < 0) return pa !== ctx.home[bond.a] && pa !== bond.ext;
    const pb = at(bond.b);
    return (pa !== ctx.home[bond.a] || pb !== ctx.home[bond.b]) && pa !== pb;
}

function makeState(ctx, place) {
    const members = ctx.placeKeys.map(() => []);
    for (let i = 0; i < ctx.n; i++) members[place[i]].push(i);
    const hs = new Float64Array(ctx.P);
    let total = 0;
    for (let p = 0; p < ctx.P; p++) {
        hs[p] = placeScore(ctx, p, members[p]);
        total += hs[p];
    }
    for (let i = 0; i < ctx.n; i++) total -= moveCost(ctx, i, place[i]);
    const at = i => place[i];
    for (let b = 0; b < ctx.bonds.length; b++) if (bondBroken(ctx, b, at)) total -= ctx.opts.bondBreakCost;
    return { place, members, hs, total };
}

function restore(ctx, st, place) {
    Object.assign(st, makeState(ctx, Int32Array.from(place)));
}

// The change in score if breeders move: changes = [[i, place], ...].
function evaluate(ctx, st, changes) {
    ctx.budget.evals++;
    const moved = new Map();
    for (const [i, q] of changes) if (st.place[i] !== q) moved.set(i, q);
    if (!moved.size) return null;
    const lists = new Map();
    for (const [i, q] of moved) {
        const p = st.place[i];
        if (!lists.has(p)) lists.set(p, st.members[p].slice());
        if (!lists.has(q)) lists.set(q, st.members[q].slice());
    }
    for (const [i, q] of moved) {
        const lp = lists.get(st.place[i]);
        lp.splice(lp.indexOf(i), 1);
        lists.get(q).push(i);
    }
    let d = 0;
    const scores = new Map();
    for (const [p, list] of lists) {
        const s = placeScore(ctx, p, list);
        scores.set(p, s);
        d += s - st.hs[p];
    }
    for (const [i, q] of moved) d -= moveCost(ctx, i, q) - moveCost(ctx, i, st.place[i]);
    if (ctx.bonds.length) {
        const after = i => (moved.has(i) ? moved.get(i) : st.place[i]);
        const before = i => st.place[i];
        const seen = new Set();
        for (const i of moved.keys()) {
            for (const b of ctx.bondsOf[i]) {
                if (seen.has(b)) continue;
                seen.add(b);
                d -= ctx.opts.bondBreakCost * (bondBroken(ctx, b, after) - bondBroken(ctx, b, before));
            }
        }
    }
    return { d, moved, lists, scores };
}

function apply(st, ev) {
    for (const [i, q] of ev.moved) st.place[i] = q;
    for (const [p, list] of ev.lists) {
        st.members[p] = list;
        st.hs[p] = ev.scores.get(p);
    }
    st.total += ev.d;
}

// ----------------------------------------------------------------- search
//
// The search steps are generators: they yield now and then (a progress
// fraction) so the page can run them in short slices (planProgrammeAsync)
// and the game's UI never stalls; planProgramme runs them in one go.

// Every layout (few breeders): the best score, then the fewest moves.
function* exhaustive(ctx, st, count) {
    let best = { total: st.total, moves: 0, place: Int32Array.from(st.place) };
    let leaves = 0;
    function* rec(k, moves) {
        if (k === ctx.n) {
            if (st.total > best.total + EPS || (st.total > best.total - EPS && moves < best.moves)) {
                best = { total: st.total, moves, place: Int32Array.from(st.place) };
            }
            if ((++leaves & 1023) === 0) yield leaves / count;
            return;
        }
        for (const q of ctx.targetsOf[k]) {
            const from = st.place[k];
            const mv = moves + (q !== ctx.home[k] ? 1 : 0);
            if (q === from) {
                yield* rec(k + 1, mv);
                continue;
            }
            apply(st, evaluate(ctx, st, [[k, q]]));
            yield* rec(k + 1, mv);
            apply(st, evaluate(ctx, st, [[k, from]]));
        }
    }
    yield* rec(0, 0);
    return best.place;
}

function layoutCount(ctx, limit) {
    let n = 1;
    for (const t of ctx.targetsOf) {
        n *= t.length;
        if (n > limit) return Infinity;
    }
    return n;
}

const progress = ctx => Math.min(0.99, ctx.budget.evals / ctx.budget.limit);

// Improve until no step helps: move one breeder (to its best place), swap
// two in different places, move a male and a female together into a
// habitat. Cheaper steps first. `only`: move only these breeders.
function* localSearch(ctx, st, { swaps = true, pairs = true, only = null } = {}) {
    const B = ctx.budget;
    const order = only || ctx.all;
    let improved = true;
    while (improved && !B.out()) {
        improved = false;
        for (const i of order) {
            let best = null;
            for (const q of ctx.targetsOf[i]) {
                if (q === st.place[i]) continue;
                const ev = evaluate(ctx, st, [[i, q]]);
                if (ev && ev.d > EPS && (!best || ev.d > best.d)) best = ev;
            }
            if (best) {
                apply(st, best);
                improved = true;
            }
            if (B.out()) return;
        }
        yield progress(ctx);
        if (improved || !swaps) continue;
        for (let x = 0; x < order.length && !B.out(); x++) {
            for (let y = x + 1; y < order.length; y++) {
                const i = order[x], j = order[y];
                const p = st.place[i], q = st.place[j];
                if (p === q || !ctx.canGo(i, q) || !ctx.canGo(j, p)) continue;
                const ev = evaluate(ctx, st, [[i, q], [j, p]]);
                if (ev && ev.d > EPS) {
                    apply(st, ev);
                    improved = true;
                }
            }
            if ((x & 7) === 7) yield progress(ctx);
        }
        if (improved || !pairs) continue;
        let best = null;
        for (const m of ctx.maleSide) {
            if (B.out()) break;
            for (const f of ctx.femaleSide) {
                if (m === f || ctx.pv(m, f) <= 0) continue;
                for (const q of ctx.groupPlaces) {
                    // one of them there already: a single move (above)
                    if (st.place[m] === q || st.place[f] === q) continue;
                    const ev = evaluate(ctx, st, [[m, q], [f, q]]);
                    if (ev && ev.d > EPS && (!best || ev.d > best.d)) best = ev;
                }
            }
            yield progress(ctx);
        }
        if (best) {
            apply(st, best);
            improved = true;
        }
    }
}

function shuffle(list, rnd) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = list[i];
        list[i] = list[j];
        list[j] = t;
    }
    return list;
}

// Take some breeders out (to the trade centre) and put them back one at a
// time, each where it does the most good; a male and a female still out
// may go in together (a new group). -> the breeders that were taken out.
function ruinRecreate(ctx, st, rnd) {
    const n = ctx.n;
    const pick = list => list[Math.floor(rnd() * list.length)];
    const out = new Set();
    const groups = ctx.groupPlaces.filter(p => st.members[p].length);
    const r = rnd();
    if (r < 0.4 && groups.length) {
        // the breeders of one or two habitats
        const first = pick(groups);
        for (const i of st.members[first]) out.add(i);
        if (groups.length > 1 && rnd() < 0.5) {
            const second = pick(groups);
            if (second !== first) for (const i of st.members[second]) out.add(i);
        }
    }
    else if (r < 0.7) {
        // a few at random
        const k = 2 + Math.floor(rnd() * Math.max(1, Math.min(8, Math.ceil(n / 3))));
        for (let t = 0; t < k; t++) out.add(Math.floor(rnd() * n));
    }
    else {
        // one breeder's group, and rivals of its sex from elsewhere
        const i = Math.floor(rnd() * n);
        for (const j of st.members[st.place[i]]) out.add(j);
        const rivals = ctx.all.filter(j => ctx.sex[j] === ctx.sex[i] && st.place[j] !== st.place[i]);
        for (let t = 0; t < 3 && rivals.length; t++) out.add(pick(rivals));
    }
    // breeders waiting without a group join in now and then
    const waiting = st.members[ctx.trade];
    if (waiting.length && rnd() < 0.5) for (let t = 0; t < 2; t++) out.add(pick(waiting));
    let list = shuffle(Array.from(out), rnd);
    const most = Math.max(6, Math.ceil(n * 0.4));
    if (list.length > most) list = list.slice(0, most);
    const ev = evaluate(ctx, st, list.map(i => [i, ctx.trade]));
    if (ev) apply(st, ev);
    const left = new Set(list);
    for (const i of list) {
        if (!left.has(i)) continue;
        left.delete(i);
        let best = null, partner = -1;
        for (const q of ctx.targetsOf[i]) {
            if (q === st.place[i]) continue;
            const e = evaluate(ctx, st, [[i, q]]);
            if (e && (!best || e.d > best.d)) best = e;
        }
        const partners = Array.from(left).filter(j => ctx.compatible(i, j) && ctx.pvAny(i, j) > 0)
            .sort((x, y) => ctx.pvAny(i, y) - ctx.pvAny(i, x)).slice(0, 2);
        for (const j of partners) {
            for (const q of ctx.groupPlaces) {
                if (!ctx.canGo(i, q) || !ctx.canGo(j, q)) continue;
                const e = evaluate(ctx, st, [[i, q], [j, q]]);
                if (e && (!best || e.d > best.d)) {
                    best = e;
                    partner = j;
                }
            }
        }
        if (best && best.d > EPS) {
            apply(st, best);
            if (partner >= 0 && best.moved.has(partner)) left.delete(partner);
        }
    }
    return list;
}

// The sexes the search places all at once (reassign): the plentiful one
// (females under a harem or mixed groups, males under any:1), both for 1:1.
function plentifulSides(ctx) {
    const r = ctx.rule;
    if (reverseHarem(r)) return ['M'];
    if (r && r.m === 1 && r.f === 1) return ['F', 'M'];
    return ['F'];
}

// Every breeder of one sex placed at once, the best way given where the
// other sex is: an assignment (Hungarian method) of those breeders to the
// places in each habitat (its room) and, where partners are limited (1:1,
// 1:3), to their partners' free places. A place is worth the pair's value,
// less the relatives living there and the move. The make-up's penalties and
// bonds are left to the exact score: the result is a proposal, scored and
// kept only if the zoo is better. side: 'F' or 'M'. -> evaluate() or null.
function reassign(ctx, st, side) {
    const movers = ctx.all.filter(i => ctx.sex[i] === (side === 'F' ? Sex.Female : Sex.Male));
    if (!movers.length) return null;
    const isMover = new Uint8Array(ctx.n);
    for (const i of movers) isMover[i] = 1;
    const perPartner = side === 'F' ? ctx.per.male : ctx.per.female;
    const partnerSide = side === 'F' ? isMaleSide : isFemaleSide;
    const capSide = side === 'F' ? ctx.rule.maxFemales : ctx.rule.maxMales;
    const pvOf = (x, i) => (side === 'F' ? ctx.pv(x, i) : ctx.pv(i, x));
    const cols = [];      // { p, x (partner or -1), own (one mover only, or -1) }
    for (const p of ctx.groupPlaces) {
        const stay = st.members[p].filter(i => !isMover[i]);
        const partners = stay.filter(i => partnerSide(ctx.sex[i]));
        let room = ctx.cap[p] == null ? movers.length : ctx.cap[p] - ctx.fixed[p] - stay.length;
        if (capSide != null) room = Math.min(room, capSide);
        room = Math.min(room, movers.length);
        if (room <= 0) continue;
        if (perPartner >= movers.length) {
            for (let k = 0; k < room; k++) cols.push({ p, x: -2, own: -1, partners });
        }
        else {
            let used = 0;
            for (const x of partners) for (let k = 0; k < perPartner && used < room; k++, used++) cols.push({ p, x, own: -1, partners });
            for (; used < room; used++) cols.push({ p, x: -1, own: -1, partners });
        }
    }
    // the places outside any group (the trade centre, a home elsewhere), and
    // a home outside the allowed habitats: one each, for that breeder only
    for (const i of movers) {
        for (const q of ctx.targetsOf[i]) {
            if (!ctx.groupPlace[q]) cols.push({ p: q, x: -1, own: i, partners: [] });
            else if (!ctx.allowedPlace[q]) cols.push({ p: q, x: -2, own: i, partners: st.members[q].filter(y => !isMover[y] && partnerSide(ctx.sex[y])) });
        }
    }
    const n = movers.length, m = cols.length;
    if (m < n) return null;
    const P = ctx.opts;
    const cost = new Float64Array(n * m);
    const related = new Map();
    for (let a = 0; a < n; a++) {
        const i = movers[a];
        for (let b = 0; b < m; b++) {
            const c = cols[b];
            if ((c.own >= 0 && c.own !== i) || !ctx.canGo(i, c.p)) {
                cost[a * m + b] = 1e6;
                continue;
            }
            let v = -moveCost(ctx, i, c.p);
            if (ctx.groupPlace[c.p]) {
                const key = i * ctx.P + c.p;
                let rel = related.get(key);
                if (rel === undefined) {
                    rel = 0;
                    for (const y of st.members[c.p]) if (!isMover[y] && ctx.compatible(i, y) && ctx.pvAny(i, y) < 0) rel++;
                    related.set(key, rel);
                }
                v -= rel * P.relatedPenalty;
                if (c.x >= 0) v += Math.max(0, pvOf(c.x, i));
                else if (c.x === -2) {
                    let best = 0;
                    for (const x of c.partners) best = Math.max(best, pvOf(x, i));
                    v += best;
                }
            }
            cost[a * m + b] = -v;
        }
    }
    const match = hungarian(n, m, cost);
    ctx.budget.evals += Math.ceil(n * m / 4);
    const changes = [];
    for (let a = 0; a < n; a++) {
        const b = match[a];
        if (b < 0 || cost[a * m + b] >= 1e5) return null;
        if (cols[b].p !== st.place[movers[a]]) changes.push([movers[a], cols[b].p]);
    }
    return changes.length ? evaluate(ctx, st, changes) : null;
}

// The scarce sex placed at once, given where the plentiful sex is: each
// habitat takes as many as the make-up allows for its plentiful breeders
// (a harem: one male), each worth the pairs it would make there (its best
// partners up to its number of partners), less relatives and the move. A
// proposal like reassign(), kept only if the zoo scores better.
function reassignScarce(ctx, st, side) {
    const r = ctx.rule;
    if (!r || r.m == null || (r.m === 1 && r.f === 1)) return null;
    const movers = ctx.all.filter(i => ctx.sex[i] === (side === 'M' ? Sex.Male : Sex.Female));
    if (!movers.length) return null;
    const isMover = new Uint8Array(ctx.n);
    for (const i of movers) isMover[i] = 1;
    const k = side === 'M' ? ctx.per.male : ctx.per.female;           // partners of one scarce animal
    const ratioOther = side === 'M' ? r.f : r.m;
    const capSide = side === 'M' ? r.maxMales : r.maxFemales;
    const plentiful = side === 'M' ? isFemaleSide : isMaleSide;
    const pvOf = (i, x) => (side === 'M' ? ctx.pv(i, x) : ctx.pv(x, i));
    const cols = [];
    for (const p of ctx.groupPlaces) {
        const stay = st.members[p].filter(i => !isMover[i]);
        const partners = stay.filter(i => plentiful(ctx.sex[i]));
        let slots = Math.max(1, Math.ceil(partners.length / ratioOther));
        if (capSide != null) slots = Math.min(slots, capSide);
        if (ctx.cap[p] != null) slots = Math.min(slots, ctx.cap[p] - ctx.fixed[p] - stay.length);
        for (let t = 0; t < Math.min(slots, movers.length); t++) cols.push({ p, partners });
    }
    for (const i of movers) {
        for (const q of ctx.targetsOf[i]) {
            if (!ctx.groupPlace[q]) cols.push({ p: q, own: i, partners: [] });
            else if (!ctx.allowedPlace[q]) cols.push({ p: q, own: i, partners: st.members[q].filter(y => !isMover[y] && plentiful(ctx.sex[y])) });
        }
    }
    const n = movers.length, m = cols.length;
    if (m < n) return null;
    const P = ctx.opts;
    const cost = new Float64Array(n * m);
    const worth = new Map();
    for (let a = 0; a < n; a++) {
        const i = movers[a];
        for (let b = 0; b < m; b++) {
            const c = cols[b];
            if ((c.own != null && c.own !== i) || !ctx.canGo(i, c.p)) {
                cost[a * m + b] = 1e6;
                continue;
            }
            let v = -moveCost(ctx, i, c.p);
            if (ctx.groupPlace[c.p]) {
                const key = i * ctx.P + c.p;
                let w = worth.get(key);
                if (w === undefined) {
                    let rel = 0;
                    const vals = [];
                    for (const y of st.members[c.p]) {
                        if (isMover[y] || !ctx.compatible(i, y)) continue;
                        if (ctx.pvAny(i, y) < 0) rel++;
                        else if (plentiful(ctx.sex[y])) vals.push(Math.max(0, pvOf(i, y)));
                    }
                    vals.sort((x, y) => y - x);
                    w = -rel * P.relatedPenalty;
                    for (let t = 0; t < Math.min(k, vals.length); t++) w += vals[t];
                    worth.set(key, w);
                }
                v += w;
            }
            cost[a * m + b] = -v;
        }
    }
    const match = hungarian(n, m, cost);
    ctx.budget.evals += Math.ceil(n * m / 4);
    const changes = [];
    for (let a = 0; a < n; a++) {
        const b = match[a];
        if (b < 0 || cost[a * m + b] >= 1e5) return null;
        if (cols[b].p !== st.place[movers[a]]) changes.push([movers[a], cols[b].p]);
    }
    return changes.length ? evaluate(ctx, st, changes) : null;
}

// Place each sex at once (the plentiful one, then the scarce one) until
// that no longer helps.
function intensify(ctx, st, rounds = 6) {
    let any = false;
    const sides = plentifulSides(ctx);
    const scarce = sides.length === 1 ? (sides[0] === 'F' ? 'M' : 'F') : null;
    for (let round = 0; round < rounds; round++) {
        let improved = false;
        for (const side of sides) {
            const ev = reassign(ctx, st, side);
            if (ev && ev.d > EPS) {
                apply(st, ev);
                improved = any = true;
            }
        }
        if (scarce) {
            const ev = reassignScarce(ctx, st, scarce);
            if (ev && ev.d > EPS) {
                apply(st, ev);
                improved = any = true;
            }
        }
        if (!improved) break;
    }
    return any;
}

// A kick: move one or two breeders of the scarce sex (or anyone, now and
// then) somewhere at random, then place the plentiful sex again around
// them. -> the breeders the kick moved.
function kick(ctx, st, rnd) {
    const side = plentifulSides(ctx)[0];
    const scarce = ctx.all.filter(i => ctx.sex[i] !== (side === 'F' ? Sex.Female : Sex.Male));
    const pool = scarce.length && rnd() < 0.8 ? scarce : ctx.all;
    // the heads of groups (the pool's breeders in a habitat) and the others
    const heads = pool.filter(i => ctx.groupPlace[st.place[i]]);
    const moved = [];
    const k = 1 + (rnd() < 0.4 ? 1 : 0);
    for (let t = 0; t < k; t++) {
        const i = heads.length && rnd() < 0.7 ? heads[Math.floor(rnd() * heads.length)] : pool[Math.floor(rnd() * pool.length)];
        if (rnd() < 0.5) {
            const others = pool.filter(j => st.place[j] !== st.place[i]);
            if (!others.length) continue;
            const j = others[Math.floor(rnd() * others.length)];
            const p = st.place[i], q = st.place[j];
            if (p !== q && ctx.canGo(i, q) && ctx.canGo(j, p)) {
                apply(st, evaluate(ctx, st, [[i, q], [j, p]]));
                moved.push(i, j);
            }
        }
        else {
            const tg = ctx.targetsOf[i];
            const q = tg[Math.floor(rnd() * tg.length)];
            if (q !== st.place[i]) {
                apply(st, evaluate(ctx, st, [[i, q]]));
                moved.push(i);
            }
        }
    }
    intensify(ctx, st, 2);
    return moved;
}

// The best layout found: { place (Int32Array of place indices), exact
// (every layout was scored) }. Few breeders: every layout. More: local
// search and both sexes placed at once, then rounds of a kick (80%: one or
// two breeders of the scarce sex moved, the rest placed again around them)
// or a ruin and recreate (20%), each settled by local search and kept or
// not by simulated annealing; the best layout seen wins, polished at the
// end.
function* solveLayout(ctx) {
    const st = makeState(ctx, Int32Array.from(ctx.home));
    const count = layoutCount(ctx, ctx.opts.exactLimit);
    if (count <= ctx.opts.exactLimit) return { place: yield* exhaustive(ctx, st, count), exact: true };
    const B = ctx.budget;
    const rnd = ctx.rnd;
    yield* localSearch(ctx, st);
    if (intensify(ctx, st)) yield* localSearch(ctx, st);
    yield progress(ctx);
    const best = { total: st.total, place: Int32Array.from(st.place) };
    const rounds = Math.min(6000, 300 + 40 * ctx.n);
    const stopAt = Math.floor(B.limit * 0.85);
    const T0 = 0.03, T1 = 0.001;
    const cool = Math.pow(T1 / T0, 1 / rounds);
    let T = T0;
    for (let it = 0; it < rounds && B.evals < stopAt && !B.out(); it++) {
        const snap = Int32Array.from(st.place);
        const before = st.total;
        const list = rnd() < 0.8 ? kick(ctx, st, rnd) : ruinRecreate(ctx, st, rnd);
        // settle: the breeders moved and the groups they joined
        const touched = new Set(list);
        for (const i of list) for (const j of st.members[st.place[i]]) touched.add(j);
        yield* localSearch(ctx, st, { swaps: false, pairs: false, only: Array.from(touched) });
        const d = st.total - before;
        if (d > -EPS || rnd() < Math.exp(d / T)) {
            if (st.total > best.total + EPS) {
                best.total = st.total;
                best.place = Int32Array.from(st.place);
            }
        }
        else restore(ctx, st, snap);
        T *= cool;
        yield progress(ctx);
    }
    restore(ctx, st, best.place);
    intensify(ctx, st);
    yield* localSearch(ctx, st);
    return { place: Int32Array.from(st.place), exact: false };
}

// Undo every move the layout does not need: alone, then two at a time.
function prune(ctx, place) {
    const st = makeState(ctx, Int32Array.from(place));
    let again = true;
    while (again) {
        again = false;
        for (let i = 0; i < ctx.n; i++) {
            if (st.place[i] === ctx.home[i]) continue;
            const ev = evaluate(ctx, st, [[i, ctx.home[i]]]);
            if (ev && ev.d >= -EPS) {
                apply(st, ev);
                again = true;
            }
        }
        if (again) continue;
        const moved = ctx.all.filter(i => st.place[i] !== ctx.home[i]);
        for (let x = 0; x < moved.length && !again; x++) {
            for (let y = x + 1; y < moved.length; y++) {
                const i = moved[x], j = moved[y];
                const ev = evaluate(ctx, st, [[i, ctx.home[i]], [j, ctx.home[j]]]);
                if (ev && ev.d >= -EPS) {
                    apply(st, ev);
                    again = true;
                    break;
                }
            }
        }
    }
    return st.place;
}

// ---------------------------------------------------------------- planner

// The search's setup for one species (planProgramme, scoreLayout).
function prepare(model, species, info, destinations, assignments, options) {
    const opts = Object.assign({}, PROGRAMME_DEFAULTS, options);
    if (!model || !species) return null;
    info = info || {};
    // the species' fertility ages from the kin snapshot when the game was not asked
    const facts = model.speciesFacts && model.speciesFacts[species];
    if (!info.fertilityAges && facts && facts.maturity != null) info = Object.assign({}, info, { fertilityAges: { maturity: facts.maturity, infertility: facts.infertility } });
    const all = Array.from(model.animals.values()).filter(a => a.species === species && !a.exhibit && a.alive !== false);
    const canMoveA = a => !a.moving && (a.lt === 'habitat' || a.lt === 'trade' || (!a.lt && !!a.hab));
    const inTrade = a => a.lt === 'trade' && !a.hab;
    const breeders = all.filter(a => isBreeder(a, info) && canMoveA(a) && (opts.useTradeCentre || !inTrade(a)));
    const tradeWaiting = all.filter(a => inTrade(a) && isBreeder(a, info) && canMoveA(a)).length;
    const home = new Map(all.map(a => [a.id, a.hab || (a.lt === 'trade' ? TRADE : AWAY)]));
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
    const infoX = Object.assign({}, info);
    if (!infoX.spacePerAdult) infoX.spacePerAdult = estimateSpacePerAdult(info);
    const ctx = makeContext(model, infoX, opts, breeders, all, habitats, home);
    ctx.budget = makeBudget(opts);
    ctx.rnd = randomSource(hashSeed(`${species}|${breeders.map(a => a.id).join(',')}|${opts.seed}`));
    return { ctx, opts, breeders, habitats, tradeWaiting };
}

// The objective of the current layout with `moves` ([{id, to}]) applied
// (tests, benchmarks). Same arguments as planProgramme.
export function scoreLayout(model, species, info = {}, destinations = null, { assignments = null, options = {} } = {}, moves = []) {
    const prep = prepare(model, species, info, destinations, assignments, options);
    if (!prep) return null;
    const { ctx } = prep;
    const place = Int32Array.from(ctx.home);
    const index = new Map(ctx.B.map((a, i) => [a.id, i]));
    for (const m of moves) {
        const i = index.get(m.id);
        if (i == null) continue;
        if (!ctx.placeOf.has(m.to)) return null;
        place[i] = ctx.placeOf.get(m.to);
    }
    return makeState(ctx, place).total;
}

function* programmeSteps(model, species, info, destinations, assignments, options) {
    const prep = prepare(model, species, info, destinations, assignments, options);
    if (!prep) return null;
    const { ctx, opts, breeders, habitats, tradeWaiting } = prep;
    const start = Int32Array.from(ctx.home);
    const solved = breeders.length ? yield* solveLayout(ctx) : { place: start, exact: true };
    const place = prune(ctx, solved.place);
    // the reported numbers scored afresh (the cache's keys are hashes)
    ctx.memo.clear();
    const finalState = makeState(ctx, Int32Array.from(place));
    const startState = makeState(ctx, start);
    // the plan: every breeder that ends up somewhere else
    const moves = [];
    breeders.forEach((a, i) => {
        if (place[i] === ctx.home[i]) return;
        const to = ctx.placeKeys[place[i]];
        const fromTrade = ctx.home[i] === ctx.trade;
        moves.push({ id: a.id, to, fromTrade, reason: to === TRADE ? 'no place in a breeding group' : fromTrade ? 'from the trade centre into a breeding group' : 'breeding programme' });
    });
    return {
        system: ctx.rule.system,
        rule: ctx.rule,
        moves,
        // breeders taken out of the trade centre / waiting there (and usable)
        fromTrade: moves.filter(m => m.fromTrade).length,
        tradeWaiting,
        usedTradeCentre: !!opts.useTradeCentre,
        score: finalState.total,
        startScore: startState.total,
        exact: solved.exact,
        evaluations: ctx.budget.evals,
        timedOut: ctx.budget.timedOut,
        searchMs: Math.round(ctx.budget.ms()),
        before: programmeStats(ctx, start),
        after: programmeStats(ctx, place),
        groups: groupsOf(ctx, place),
        capacity: Object.fromEntries(ctx.capacity),
        // per habitat: the adults staying (not breeders) and the make-up's target
        staying: Object.fromEntries(ctx.fixedAdults),
        targets: Object.fromEntries(Array.from(ctx.capacity, ([k, cap]) => [k, groupTarget(ctx.rule, cap - (ctx.fixedAdults.get(k) || 0))])),
        habitats,
    };
}

// info: { social: {min,max}, fertilityAges: {maturity, infertility},
//         mating: 'monogamy'|'polygyny'|'polyandry'|'mixed'|null,
//         sexMax: {male, female}, groups: [{kind, m, f}],
//         conception: [[p]], habitats: { habId: { available, required, adults } } }
// destinations: the Species board destinations; assignments: habitat -> species.
// options: PROGRAMME_DEFAULTS. Runs the whole search at once.
export function planProgramme(model, species, info = {}, destinations = null, { assignments = null, options = {} } = {}) {
    const gen = programmeSteps(model, species, info, destinations, assignments, options);
    for (;;) {
        const r = gen.next();
        if (r.done) return r.value;
    }
}


// The same, in slices of about sliceMs, so the page stays responsive.
// onProgress(0..1) after each slice; isCancelled() -> true stops it (the
// promise then gives null). The time cap counts only the time spent
// searching.
export function planProgrammeAsync(model, species, info = {}, destinations = null, { assignments = null, options = {}, sliceMs = 24, onProgress = null, isCancelled = null } = {}) {
    let busy = 0, sliceStart = 0, running = false;
    const clock = () => busy + (running ? wallClock() - sliceStart : 0);
    const gen = programmeSteps(model, species, info, destinations, assignments, Object.assign({}, options, { clock }));
    return new Promise((resolve, reject) => {
        const slice = () => {
            if (isCancelled && isCancelled()) return resolve(null);
            sliceStart = wallClock();
            running = true;
            let last = 0;
            try {
                for (;;) {
                    const r = gen.next();
                    if (r.done) return resolve(r.value);
                    if (typeof r.value === 'number') last = r.value;
                    if (wallClock() - sliceStart >= sliceMs) break;
                }
            }
            catch (e) {
                return reject(e);
            }
            finally {
                busy += wallClock() - sliceStart;
                running = false;
            }
            if (onProgress) {
                try {
                    onProgress(last);
                }
                catch (e) {
                    // the page's business
                }
            }
            setTimeout(slice, 0);
        };
        setTimeout(slice, 0);
    });
}

// Breeding pairs, expected young and related pairs for a layout.
function programmeStats(ctx, place) {
    const st = makeState(ctx, Int32Array.from(place));
    let pairs = 0, related = 0, quality = 0, chance = 0, idle = 0;
    const breedingFemales = new Set();
    for (let p = 0; p < ctx.P; p++) {
        const list = st.members[p];
        if (!list.length) continue;
        if (!ctx.groupPlace[p]) {
            idle += list.length;
            continue;
        }
        related += relatedCount(ctx, list);
        const busy = new Set();
        for (const [, m, f] of groupPairs(ctx, list)) {
            pairs++;
            quality += youngQuality(ctx.B[m], ctx.B[f]);
            chance += conceptionChance(ctx.B[m], ctx.B[f], ctx.info);
            busy.add(m);
            busy.add(f);
            breedingFemales.add(f);
        }
        for (const i of list) if (!busy.has(i)) idle++;
    }
    return {
        breedingPairs: pairs,
        relatedPairs: related,
        youngQuality: pairs ? Math.round(quality / pairs * 100) : null,     // 0..100
        conception: pairs ? Math.round(chance / pairs * 100) : null,        // %
        breedingFemales: breedingFemales.size,
        idle,                                                               // breeders without a partner
    };
}

// Each place's breeders, with its room and the make-up's target.
function groupsOf(ctx, place) {
    const map = new Map();
    for (let i = 0; i < ctx.n; i++) {
        const k = ctx.placeKeys[place[i]];
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(ctx.B[i]);
    }
    return Array.from(map.entries()).map(([hab, animals]) => {
        const capacity = ctx.capacity.has(hab) ? ctx.capacity.get(hab) : null;
        const staying = ctx.fixedAdults.get(hab) || 0;
        return {
            hab,
            animals,
            males: animals.filter(a => a.sex === Sex.Male).length,
            females: animals.filter(a => a.sex === Sex.Female).length,
            capacity,
            staying,
            target: hab === TRADE || capacity == null ? null : groupTarget(ctx.rule, capacity - staying),
        };
    });
}
