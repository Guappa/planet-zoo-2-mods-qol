// Seeded random zoos for the Autopilot tests (golden engine outputs, the
// fixed-point property and the soak test). Pure, no game imports.
//
// makeZoo(seed, opts) -> { snap, info: { <species>: speciesInfo }, dest, assignments }
//   snap: a kin snapshot (the shape PZ2QoL.Kin sends, see kincore.js)
//   info: what requestSpeciesInfo answers (social, mating, habitats space)
//   dest: what requestDestinations answers (bySpecies, habitats, tradeCentre)
import { Sex } from '../../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';

export function rng(seed) {
    let a = (seed >>> 0) || 1;
    const next = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
        pick: list => list[Math.floor(next() * list.length)],
        chance: p => next() < p,
    };
}

export const SPECIES = {
    Lion: { mating: 'polygyny', social: { min: 3, max: 8 }, facts: { maturity: 3, infertility: 15, life: 20 }, perAdult: 400 },
    Wolf: { mating: 'monogamy', social: { min: 2, max: 8 }, facts: { maturity: 2, infertility: 10, life: 14 }, perAdult: 300 },
    Zebra: { mating: 'mixed', social: { min: 4, max: 12 }, facts: { maturity: 2, infertility: 18, life: 25 }, perAdult: 500 },
    Lemur: { mating: 'polygyny', social: { min: 3, max: 10 }, facts: { maturity: 2, infertility: 15, life: 20 }, perAdult: 80 },
};

const LETTERS = 'ABCDEFGHIJ';

function strand(r, pool) {
    let s = '';
    for (let i = 0; i < 6; i++) s += r.pick(pool);
    return s;
}

export function founderGenes(r, poolSize) {
    const pool = LETTERS.slice(0, poolSize).split('');
    const g = {};
    for (const k of ['F', 'I', 'S', 'L']) g[k] = strand(r, pool) + strand(r, pool);
    return g;
}

// one strand from each parent, as the game's prediction assumes
export function childGenes(r, m, f) {
    const g = {};
    for (const k of ['F', 'I', 'S', 'L']) {
        const pm = m.genes[k], pf = f.genes[k];
        const sm = r.chance(0.5) ? pm.slice(0, 6) : pm.slice(6, 12);
        const sf = r.chance(0.5) ? pf.slice(0, 6) : pf.slice(6, 12);
        g[k] = sm + sf;
    }
    return g;
}

export function makeZoo(seed, opts = {}) {
    const r = rng(seed);
    const speciesNames = opts.species || Object.keys(SPECIES).slice(0, r.int(1, 4));
    const nHab = opts.habitats || r.int(3, 6);
    const habitats = [];
    for (let i = 1; i <= nHab; i++) habitats.push({ id: String(i), name: `Habitat ${i}`, hid: String(100 + i) });
    const animals = [];
    let nextId = 1;
    const newAnimal = (species, over) => {
        const id = String(nextId++);
        const a = Object.assign({
            id, key: 'animal_' + id, guid: 'g' + id, name: `${species.slice(0, 2)}${id}`, species, sex: r.chance(0.5) ? Sex.Male : Sex.Female,
            juv: false, contra: false, infertile: false, preg: false, alive: true, hab: '', loc: '', lt: 'habitat', moving: false,
            age: 5, par: [], mates: [], genes: null,
        }, over);
        animals.push(a);
        return a;
    };
    const assignments = {};
    const homes = {};
    for (const sp of speciesNames) {
        // each species lives in 1..3 habitats
        const n = Math.min(nHab, r.int(1, 3));
        const hs = [];
        while (hs.length < n) {
            const h = r.pick(habitats).id;
            if (!hs.includes(h)) hs.push(h);
        }
        homes[sp] = hs;
        if (opts.assign !== false && r.chance(0.3)) assignments[hs[0]] = [sp];
    }
    for (const sp of speciesNames) {
        const S = SPECIES[sp];
        const poolSize = r.int(3, 8);
        const founders = [];
        for (const h of homes[sp]) {
            const n = r.int(2, 5);
            for (let i = 0; i < n; i++) {
                founders.push(newAnimal(sp, { hab: h, loc: `Habitat ${h}`, age: r.int(S.facts.maturity, S.facts.infertility + 2) + r.next(), genes: founderGenes(r, poolSize) }));
            }
        }
        // two generations of young, born in their mother's habitat
        let parents = founders;
        for (let gen = 0; gen < 2; gen++) {
            const kids = [];
            for (const h of homes[sp]) {
                const here = parents.filter(a => a.hab === h);
                const ms = here.filter(a => a.sex === Sex.Male), fs = here.filter(a => a.sex === Sex.Female);
                if (!ms.length || !fs.length) continue;
                const litters = r.int(0, 3);
                for (let i = 0; i < litters; i++) {
                    const m = r.pick(ms), f = r.pick(fs);
                    const age = gen === 0 ? r.int(S.facts.maturity, S.facts.maturity + 4) + r.next() : r.next() * S.facts.maturity * 1.2;
                    kids.push(newAnimal(sp, { hab: h, loc: `Habitat ${h}`, age, juv: age < S.facts.maturity, par: [m.guid, f.guid], genes: childGenes(r, m, f) }));
                }
            }
            parents = parents.concat(kids);
        }
    }
    for (const a of animals) {
        const S = SPECIES[a.species];
        if (!a.juv && a.age >= S.facts.infertility) a.infertile = true;
        if (!a.juv && r.chance(0.06)) a.contra = true;
        if (!a.juv && a.sex === Sex.Female && !a.infertile && r.chance(0.08)) a.preg = true;
        a.ageQ = a.juv ? 0 : a.age >= S.facts.infertility ? 3 : 2;
    }
    // a few at the trade centre (bought, waiting)
    for (const sp of speciesNames) {
        if (r.chance(0.35)) {
            const S = SPECIES[sp];
            newAnimal(sp, { hab: '', loc: 'Trade Centre', lt: 'trade', age: S.facts.maturity + 1 + r.next() * 3, genes: founderGenes(r, 10) }).ageQ = 2;
        }
    }
    const speciesFacts = {};
    for (const sp of speciesNames) speciesFacts[sp] = Object.assign({}, SPECIES[sp].facts);
    const snap = {
        v: 1, seq: 1, scope: 'park', mode: opts.mode || 'offline', park: 'Test Park',
        habitats: habitats.map(h => ({ id: h.id, name: h.name, kind: 'habitat' })),
        habs: habitats.map(h => ({ id: h.id, name: h.name, hid: h.hid })),
        animals, anc: {}, speciesFacts, tradeCentre: { id: '99', name: 'Trade Centre' },
    };
    const dest = { bySpecies: {}, habitats: habitats.map(h => ({ id: h.id, name: h.name })), tradeCentre: { id: '99', name: 'Trade Centre' } };
    const info = {};
    for (const sp of speciesNames) {
        const S = SPECIES[sp];
        dest.bySpecies[sp] = {};
        for (const h of habitats) {
            const ok = homes[sp].includes(h.id) || r.chance(0.4);
            dest.bySpecies[sp][h.id] = ok ? { ok: true } : { ok: false, reason: 'Not a suitable habitat for this species.' };
        }
        const habs = {};
        for (const h of habitats) {
            const adults = animals.filter(a => a.species === sp && a.hab === h.id && !a.juv).length;
            const land = S.perAdult * r.int(3, 10);
            habs[h.id] = { available: { land }, required: adults ? { land: S.perAdult * adults } : null, adults };
        }
        info[sp] = { social: S.social, mating: S.mating, fertilityAges: { maturity: S.facts.maturity, infertility: S.facts.infertility }, habitats: habs };
    }
    return { snap, info, dest, assignments, species: speciesNames };
}
