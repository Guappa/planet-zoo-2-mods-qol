// Kin: relatedness, inbreeding risk and offspring genetics for PZ2QoL.
// Pure computations, no game imports, so it runs under Node tests.
//
// Input is the snapshot the Lua side (PZ2QoL.Kin) sends:
//   { v, seq, scope: 'park' | 'storage',
//     habitats: [{ id, name, kind: 'habitat' | 'exhibit' }],
//     animals: [{ id, key, guid, name, species, sex, juv, contra, infertile,
//                 preg, hab, loc, par: [guid, guid], mates: [id],
//                 genes: { F, I, S, L } }],
//     anc: { guid: [parentGuid, parentGuid] } }   // ancestors not in the zoo
// ids are strings (entity ids; exhibit animals 'x<uid>'); guids are strings,
// '' or '0' when unknown. Genes are 12 alleles per stat (strand A = 1..6,
// strand B = 7..12), one letter each.
//
// The game itself only ever calls a pair "inbred" when one is the other's
// parent or they share a parent (CompareMatesPopup.CompareParentsForInbreeding).
// That tier is 'game'. Kin adds the relatives the game does not flag
// (grandparents, aunts/uncles, cousins...) as 'close', using the coefficient
// of kinship over the known pedigree.

export const Sex = { Male: 0, Female: 1, Unisex: 2 };

// Worst first. 'distant' pairs are only shown in the planner.
export const SEVERITY_ORDER = ['risk', 'kin', 'future', 'covered', 'distant'];
const SEVERITY_RANK = { risk: 5, kin: 4, future: 3, covered: 2, distant: 1 };
export function severityRank(s) {
    return SEVERITY_RANK[s] || 0;
}
export function worstSeverity(list) {
    let worst = null;
    for (const s of list) if (severityRank(s) > severityRank(worst)) worst = s;
    return worst;
}

export const SEVERITY_INFO = {
    risk: { label: 'Inbreeding risk', short: 'Risk', tip: 'The game counts this pair as inbred, and both can breed now.' },
    kin: { label: 'Close kin', short: 'Kin', tip: 'Closely related, but the game does not warn about it. Their young lose fertility and immunity all the same.' },
    future: { label: 'Future risk', short: 'Later', tip: 'Related, and one of them is still young. They become a risk when it grows up.' },
    covered: { label: 'Covered', short: 'Covered', tip: 'Related, but contraception or infertility stops them breeding.' },
    distant: { label: 'Distant kin', short: 'Far', tip: 'Distantly related (below the close-kin threshold).' },
};

// Kinship below this is 'distant' unless the game flags the pair.
// 1/16 = first cousins, great-grandparents, half aunts/uncles.
export const DEFAULT_CLOSE_KINSHIP = 1 / 16;
const MAX_GENERATIONS = 8;

function known(g) {
    return g != null && g !== '' && g !== '0' && g !== 0;
}

function asArray(v) {
    return Array.isArray(v) ? v : [];
}

// ------------------------------------------------------------- snapshot

export function normalizeSnapshot(raw) {
    const snap = raw && typeof raw === 'object' ? raw : {};
    const animals = asArray(snap.animals).filter(a => a && a.id != null).map(a => ({
        id: String(a.id),
        key: a.key != null ? String(a.key) : `animal_${a.id}`,
        guid: known(a.guid) ? String(a.guid) : '',
        name: a.name != null && a.name !== '' ? String(a.name) : '?',
        species: a.species != null ? String(a.species) : '',
        sex: typeof a.sex === 'number' ? a.sex : Sex.Unisex,
        juv: !!a.juv,
        contra: !!a.contra,
        infertile: !!a.infertile,
        preg: !!a.preg,
        alive: a.alive !== false,
        hab: a.hab != null && a.hab !== '' && a.hab !== 0 ? String(a.hab) : '',
        loc: a.loc != null ? String(a.loc) : '',
        exhibit: !!a.exhibit,
        // where it is: 'habitat' | 'trade' | 'transit' | 'quarantine' | 'vet' | 'escaped' | 'other'
        lt: a.lt != null ? String(a.lt) : (a.hab != null && a.hab !== '' ? 'habitat' : ''),
        moving: !!a.moving,
        age: typeof a.age === 'number' ? a.age : undefined,
        par: asArray(a.par).filter(known).map(String),
        mates: asArray(a.mates).map(String),
        genes: a.genes && typeof a.genes === 'object' ? a.genes : null,
    }));
    const anc = {};
    if (snap.anc && typeof snap.anc === 'object') {
        for (const g in snap.anc) {
            if (known(g)) anc[String(g)] = asArray(snap.anc[g]).filter(known).map(String);
        }
    }
    const habitats = asArray(snap.habitats).filter(h => h && h.id != null).map(h => ({
        id: String(h.id),
        name: h.name != null ? String(h.name) : '',
        kind: h.kind === 'exhibit' ? 'exhibit' : 'habitat',
    }));
    return {
        normalized: true,
        v: snap.v || 1,
        seq: snap.seq || 0,
        scope: snap.scope === 'storage' ? 'storage' : 'park',
        habitats,
        animals,
        anc,
        names: snap.names && typeof snap.names === 'object' ? snap.names : {},
        park: snap.park != null ? String(snap.park) : '',
        // 'franchise' | 'offline' (Sandbox, Career, Challenge) | 'unknown'
        mode: snap.mode === 'franchise' || snap.mode === 'offline' ? snap.mode : 'unknown',
        tradeCentre: snap.tradeCentre && snap.tradeCentre.id != null ? { id: String(snap.tradeCentre.id), name: String(snap.tradeCentre.name || 'Trade centre') } : null,
    };
}

// ------------------------------------------------------------- pedigree

export class Pedigree {
    constructor(snapshot) {
        this.parents = new Map();   // guid -> [guid...]
        this.byGuid = new Map();    // guid -> animal (present ones)
        this.names = new Map();     // guid -> name (present + known ancestors)
        for (const g in snapshot.anc) this.parents.set(g, snapshot.anc[g]);
        for (const g in snapshot.names || {}) this.names.set(g, String(snapshot.names[g]));
        for (const a of snapshot.animals) {
            if (!a.guid) continue;
            this.parents.set(a.guid, a.par);
            this.byGuid.set(a.guid, a);
            this.names.set(a.guid, a.name);
        }
        this._anc = new Map();
        this._kin = new Map();
    }

    parentsOf(g) {
        return known(g) ? (this.parents.get(g) || []) : [];
    }

    // guid -> generations up (1 = parent). Nearest generation wins.
    ancestors(g) {
        let m = this._anc.get(g);
        if (m) return m;
        m = new Map();
        let frontier = [g];
        for (let gen = 1; gen <= MAX_GENERATIONS && frontier.length; gen++) {
            const nextFrontier = [];
            for (const x of frontier) {
                for (const p of this.parentsOf(x)) {
                    if (p === g || m.has(p)) continue;
                    m.set(p, gen);
                    nextFrontier.push(p);
                }
            }
            frontier = nextFrontier;
        }
        this._anc.set(g, m);
        return m;
    }

    isAncestor(a, b) {
        return this.ancestors(b).has(a);
    }

    // Coefficient of kinship: the chance that an allele picked from each is
    // identical by descent. Parent/child and full siblings 1/4, half siblings
    // and grandparents 1/8, first cousins 1/16. Unknown parents count as
    // unrelated founders.
    kinship(a, b, depth = 0) {
        if (!known(a) || !known(b)) return 0;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const cached = this._kin.get(key);
        if (cached !== undefined) return cached;
        if (depth > 2 * MAX_GENERATIONS) return 0;
        // guards against a malformed (cyclic) pedigree
        this._kin.set(key, 0);
        let value;
        if (a === b) {
            const [p, q] = this.parentsOf(a);
            value = 0.5 * (1 + (p && q ? this.kinship(p, q, depth + 1) : 0));
        }
        else {
            // expand the one that is not an ancestor of the other
            let x = a, y = b;
            if (this.isAncestor(a, b)) {
                x = b;
                y = a;
            }
            const [p, q] = this.parentsOf(x);
            value = 0.5 * ((p ? this.kinship(p, y, depth + 1) : 0) + (q ? this.kinship(q, y, depth + 1) : 0));
        }
        this._kin.set(key, value);
        return value;
    }

    // The game's own rule, exactly (CompareParentsForInbreeding).
    gameInbred(a, b) {
        if (!known(a) || !known(b)) return false;
        const pa = this.parentsOf(a);
        const pb = this.parentsOf(b);
        if (pa.includes(b) || pb.includes(a)) return true;
        return pa.some(p => pb.includes(p));
    }

    // How y is related to x, from x's point of view ("y is x's ...").
    // { code, full, kinship, game, via: [guid] }
    relation(x, y) {
        if (!known(x) || !known(y) || x === y) return null;
        const ax = this.ancestors(x);
        const ay = this.ancestors(y);
        // fast path: no direct line and no common ancestor
        if (!ax.has(y) && !ay.has(x)) {
            let common = false;
            const [small, big] = ax.size <= ay.size ? [ax, ay] : [ay, ax];
            for (const g of small.keys()) {
                if (big.has(g)) {
                    common = true;
                    break;
                }
            }
            if (!common) return null;
        }
        const kinship = this.kinship(x, y);
        const game = this.gameInbred(x, y);
        const px = this.parentsOf(x);
        const py = this.parentsOf(y);
        const shared = px.filter(p => py.includes(p));
        let code = null, full = false, via = [];
        if (px.includes(y)) code = 'parent';
        else if (py.includes(x)) code = 'child';
        else if (shared.length) {
            code = 'sibling';
            full = shared.length >= 2;
            via = shared;
        }
        else if (ax.get(y) === 2) {
            code = 'grandparent';
            via = px.filter(p => this.parentsOf(p).includes(y));
        }
        else if (ay.get(x) === 2) {
            code = 'grandchild';
            via = py.filter(p => this.parentsOf(p).includes(x));
        }
        else {
            // y is a sibling of one of x's parents, or the other way round
            for (const p of px) {
                const s = this.parentsOf(p).filter(g => py.includes(g));
                if (s.length && p !== y) {
                    code = 'auntUncle';
                    full = s.length >= 2;
                    via = [p];
                    break;
                }
            }
            if (!code) {
                for (const p of py) {
                    const s = this.parentsOf(p).filter(g => px.includes(g));
                    if (s.length && p !== x) {
                        code = 'nieceNephew';
                        full = s.length >= 2;
                        via = [p];
                        break;
                    }
                }
            }
            if (!code && ax.get(y) === 3) code = 'greatGrandparent';
            if (!code && ay.get(x) === 3) code = 'greatGrandchild';
            if (!code) {
                const commonGrand = [];
                for (const [g, gen] of ax) if (gen === 2 && ay.get(g) === 2) commonGrand.push(g);
                if (commonGrand.length) {
                    code = 'cousin';
                    full = commonGrand.length >= 2;
                    via = commonGrand;
                }
            }
            if (!code) {
                for (const g of ax.keys()) {
                    if (ay.has(g)) {
                        code = 'distant';
                        via = [g];
                        break;
                    }
                }
            }
        }
        if (!code && !game && kinship <= 0) return null;
        return { code: code || 'distant', full, kinship, game, via };
    }

    nameOf(g) {
        return this.names.get(g) || null;
    }
}

// ----------------------------------------------------------- relation text

const WORDS = {
    parent: ['father', 'mother', 'parent'],
    child: ['son', 'daughter', 'offspring'],
    sibling: ['brother', 'sister', 'sibling'],
    grandparent: ['grandfather', 'grandmother', 'grandparent'],
    grandchild: ['grandson', 'granddaughter', 'grandchild'],
    auntUncle: ['uncle', 'aunt', 'parent\'s sibling'],
    nieceNephew: ['nephew', 'niece', 'sibling\'s offspring'],
    greatGrandparent: ['great-grandfather', 'great-grandmother', 'great-grandparent'],
    greatGrandchild: ['great-grandson', 'great-granddaughter', 'great-grandchild'],
    cousin: ['cousin', 'cousin', 'cousin'],
    distant: ['relative', 'relative', 'relative'],
};

// "half-sister", "mother", "cousin": what y is to x. ySex picks the word.
export function relationWord(rel, ySex) {
    if (!rel) return '';
    const words = WORDS[rel.code] || WORDS.distant;
    const i = ySex === Sex.Male ? 0 : ySex === Sex.Female ? 1 : 2;
    let w = words[i];
    if (!rel.full && (rel.code === 'sibling' || rel.code === 'auntUncle' || rel.code === 'nieceNephew' || rel.code === 'cousin')) {
        w = 'half-' + w;
    }
    return w;
}

export function percent(k) {
    if (!(k > 0)) return '0%';
    return String(Number((k * 100).toFixed(2))) + '%';
}

// ------------------------------------------------------------ genetics

const STATS = [
    { id: 'fertility', key: 'F', hetero: true },
    { id: 'immunity', key: 'I', hetero: true },
    { id: 'size', key: 'S', hetero: false },
    { id: 'longevity', key: 'L', hetero: false },
];

function strands(genes, key) {
    const s = genes && genes[key];
    if (typeof s !== 'string') return null;
    const list = s.length === 12 ? s.split('') : s.split('.');
    if (list.length !== 12) return null;
    return [list.slice(0, 6), list.slice(6, 12)];
}

function diffCount(a, b) {
    let n = 0;
    for (let i = 0; i < 6; i++) if (a[i] !== b[i]) n++;
    return n;
}

function goodCount(strand) {
    let n = 0;
    for (const c of strand) if (c === 'A' || c === 'B') n++;
    return n;
}

// An animal's own gene grades from its alleles (0..1), as the game shows them.
export function ownGrades(genes) {
    const out = {};
    for (const st of STATS) {
        const s = strands(genes, st.key);
        if (!s) continue;
        out[st.id] = st.hetero ? diffCount(s[0], s[1]) / 6 : (goodCount(s[0]) + goodCount(s[1])) / 12;
    }
    return out;
}

// The game's offspring prediction (CompareMatesUIUtils.GetMinMaxGeneGrades):
// the young get one strand from each parent. Fertility and immunity are the
// number of loci where the two inherited strands differ (so related parents,
// who share strands, have less fertile and less healthy young); size and
// longevity count the good alleles (A, B). Each of the four strand
// combinations is equally likely, so mean is the expected value.
// Returns { fertility: { min, max, mean }, ... } in 0..1, or null.
export function predictOffspring(genesA, genesB) {
    if (!genesA || !genesB) return null;
    const out = {};
    let any = false;
    for (const st of STATS) {
        const a = strands(genesA, st.key);
        const b = strands(genesB, st.key);
        if (!a || !b) continue;
        const values = [];
        for (const sa of a) {
            for (const sb of b) {
                values.push(st.hetero ? diffCount(sa, sb) / 6 : (goodCount(sa) + goodCount(sb)) / 12);
            }
        }
        out[st.id] = {
            min: Math.min(...values),
            max: Math.max(...values),
            mean: values.reduce((s, v) => s + v, 0) / values.length,
        };
        any = true;
    }
    return any ? out : null;
}

// One number for ranking mates: mean of the predicted means (0..100).
export function offspringScore(pred) {
    if (!pred) return null;
    const vals = STATS.map(s => pred[s.id] && pred[s.id].mean).filter(v => typeof v === 'number');
    if (!vals.length) return null;
    return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 100);
}

// ---------------------------------------------------------------- model

function compatibleSexes(a, b) {
    if (a.sex === Sex.Unisex || b.sex === Sex.Unisex) return true;
    return a.sex !== b.sex;
}

function canBreedNow(a) {
    return !a.juv && !a.contra && !a.infertile;
}

// Contraception, or adult infertility, stops this one breeding. Juveniles
// are reported as infertile because of their age; that is a later risk,
// not a cover.
function isCovered(a) {
    return a.contra || (a.infertile && !a.juv);
}

export function pairSeverity(x, y, tier) {
    if (tier === 'distant') return 'distant';
    if (isCovered(x) || isCovered(y)) return 'covered';
    if (x.juv || y.juv) return 'future';
    return tier === 'game' ? 'risk' : 'kin';
}

function pairKeyOf(x, y) {
    const a = x.guid || 'e' + x.id;
    const b = y.guid || 'e' + y.id;
    return a < b ? `${a}~${b}` : `${b}~${a}`;
}

// Orders a pair male first, so text reads "♂ Kito – ♀ Zuri".
function ordered(x, y) {
    if (x.sex === Sex.Female && y.sex !== Sex.Female) return [y, x];
    return [x, y];
}

export function buildKinModel(raw, opts = {}) {
    const snap = raw && raw.normalized ? raw : normalizeSnapshot(raw);
    const closeKinship = opts.closeKinship != null ? opts.closeKinship : DEFAULT_CLOSE_KINSHIP;
    const ped = new Pedigree(snap);
    const animals = new Map();
    const byKey = new Map();
    const byGuid = ped.byGuid;
    for (const a of snap.animals) {
        animals.set(a.id, a);
        byKey.set(a.key, a);
    }
    const habitats = new Map();
    for (const h of snap.habitats) habitats.set(h.id, { id: h.id, name: h.name, kind: h.kind });
    // groups: habitat id -> species -> animals
    const groups = new Map();
    for (const a of snap.animals) {
        if (!a.hab || !a.alive) continue;
        if (!habitats.has(a.hab)) habitats.set(a.hab, { id: a.hab, name: a.loc || a.hab, kind: a.exhibit ? 'exhibit' : 'habitat' });
        const h = habitats.get(a.hab);
        if (!h.name && a.loc) h.name = a.loc;
        let bySpecies = groups.get(a.hab);
        if (!bySpecies) groups.set(a.hab, bySpecies = new Map());
        if (!bySpecies.has(a.species)) bySpecies.set(a.species, []);
        bySpecies.get(a.species).push(a);
    }
    const pairs = [];
    const byAnimal = new Map();
    const addTo = (id, p) => {
        if (!byAnimal.has(id)) byAnimal.set(id, []);
        byAnimal.get(id).push(p);
    };
    for (const [hab, bySpecies] of groups) {
        for (const [species, list] of bySpecies) {
            for (let i = 0; i < list.length; i++) {
                for (let j = i + 1; j < list.length; j++) {
                    const x = list[i], y = list[j];
                    if (!compatibleSexes(x, y) || !x.guid || !y.guid) continue;
                    const rel = ped.relation(x.guid, y.guid);
                    if (!rel) continue;
                    const tier = rel.game ? 'game' : rel.kinship >= closeKinship - 1e-9 ? 'close' : 'distant';
                    const [m, f] = ordered(x, y);
                    const relMF = m === x ? rel : ped.relation(m.guid, f.guid);
                    const p = {
                        key: pairKeyOf(m, f),
                        a: m,
                        b: f,
                        hab,
                        species,
                        rel: relMF,               // f is m's <relation>
                        tier,
                        severity: pairSeverity(m, f, tier),
                        kinship: rel.kinship,
                        mated: m.mates.includes(f.id) || f.mates.includes(m.id),
                    };
                    pairs.push(p);
                    addTo(m.id, p);
                    addTo(f.id, p);
                }
            }
        }
    }
    const sortPairs = list => list.sort((p, q) => severityRank(q.severity) - severityRank(p.severity)
        || (q.mated - p.mated) || q.kinship - p.kinship);
    sortPairs(pairs);
    for (const list of byAnimal.values()) sortPairs(list);
    const counts = { risk: 0, kin: 0, future: 0, covered: 0, distant: 0 };
    for (const p of pairs) counts[p.severity]++;
    const model = {
        seq: snap.seq,
        scope: snap.scope,
        snapshot: snap,
        park: snap.park,
        mode: snap.mode,
        tradeCentre: snap.tradeCentre,
        ped,
        animals,
        byKey,
        byGuid,
        habitats,
        groups,
        pairs,
        byAnimal,
        counts,
        closeKinship,
    };
    model.habitatSummaries = summarizeHabitats(model);
    return model;
}

// ----------------------------------------------------------- per animal

// Pairs that count on the animal's own badge (not the distant ones).
export function animalPairs(model, id, { includeDistant = false } = {}) {
    const list = (model && model.byAnimal.get(String(id))) || [];
    return includeDistant ? list : list.filter(p => p.severity !== 'distant');
}

export function animalSeverity(model, id) {
    const list = animalPairs(model, id);
    return list.length ? list[0].severity : null;
}

// The other animal of a pair.
export function partnerOf(pair, id) {
    return pair.a.id === String(id) ? pair.b : pair.a;
}

// What `other` is to `self` ("half-sister"), with the right sex word.
export function relationFor(model, self, other) {
    if (!self.guid || !other.guid) return null;
    return model.ped.relation(self.guid, other.guid);
}

export function describeRelation(model, self, other) {
    const rel = relationFor(model, self, other);
    return rel ? relationWord(rel, other.sex) : '';
}

// A sentence on how two animals are related, naming the link if known.
export function explainRelation(model, x, y) {
    const rel = relationFor(model, x, y);
    if (!rel) return `${x.name} and ${y.name} are not related as far as the game records.`;
    const name = g => {
        const n = model.ped.nameOf(g);
        return n ? n : 'an animal no longer in the zoo';
    };
    const word = relationWord(rel, y.sex);
    switch (rel.code) {
        case 'parent':
        case 'child':
        case 'grandparent':
        case 'grandchild':
        case 'greatGrandparent':
        case 'greatGrandchild':
            return `${y.name} is ${x.name}'s ${word}${rel.via.length ? ` (through ${name(rel.via[0])})` : ''}.`;
        case 'sibling':
            return rel.full
                ? `${x.name} and ${y.name} are full siblings (same mother and father).`
                : `${x.name} and ${y.name} are half-siblings: they share ${name(rel.via[0])}.`;
        case 'auntUncle':
            return `${y.name} is ${x.name}'s ${word}: a ${rel.full ? '' : 'half-'}sibling of ${name(rel.via[0])}.`;
        case 'nieceNephew':
            return `${y.name} is ${x.name}'s ${word}: ${name(rel.via[0])} is ${x.name}'s ${rel.full ? '' : 'half-'}sibling.`;
        case 'cousin':
            return `${x.name} and ${y.name} are ${rel.full ? 'first' : 'half'} cousins: they share grandparent${rel.via.length > 1 ? 's' : ''} ${rel.via.map(name).join(' and ')}.`;
        default:
            return `${x.name} and ${y.name} share an ancestor${rel.via.length ? ` (${name(rel.via[0])})` : ''}.`;
    }
}

// Related animals as connected groups (over the counted pairs), so a list
// can be sorted with relatives next to each other. id -> group key.
export function kinClusters(model) {
    const parent = new Map();
    const find = x => {
        while (parent.get(x) !== x) {
            parent.set(x, parent.get(parent.get(x)));
            x = parent.get(x);
        }
        return x;
    };
    for (const p of (model && model.pairs) || []) {
        if (p.severity === 'distant') continue;
        for (const id of [p.a.id, p.b.id]) if (!parent.has(id)) parent.set(id, id);
        const ra = find(p.a.id), rb = find(p.b.id);
        if (ra !== rb) parent.set(ra, rb);
    }
    const out = new Map();
    for (const id of parent.keys()) out.set(id, find(id));
    return out;
}

// --------------------------------------------------------- per habitat

function summarizeHabitats(model) {
    const out = new Map();
    for (const [hab, bySpecies] of model.groups) {
        const h = model.habitats.get(hab) || { id: hab, name: hab, kind: 'habitat' };
        const entry = { id: hab, name: h.name, kind: h.kind, counts: { risk: 0, kin: 0, future: 0, covered: 0 }, species: [] };
        for (const [species, list] of bySpecies) {
            const sp = {
                species,
                animals: list,
                males: list.filter(a => a.sex === Sex.Male),
                females: list.filter(a => a.sex === Sex.Female),
                counts: { risk: 0, kin: 0, future: 0, covered: 0 },
                pairs: [],
            };
            entry.species.push(sp);
        }
        out.set(hab, entry);
    }
    for (const p of model.pairs) {
        const entry = out.get(p.hab);
        if (!entry || p.severity === 'distant') continue;
        entry.counts[p.severity]++;
        const sp = entry.species.find(s => s.species === p.species);
        if (sp) {
            sp.counts[p.severity]++;
            sp.pairs.push(p);
        }
    }
    return out;
}

export function habitatSummary(model, habId) {
    return model ? model.habitatSummaries.get(String(habId)) || null : null;
}

// By the location text the game shows ("Savannah Habitat").
export function habitatByName(model, name) {
    if (!model || !name) return null;
    for (const h of model.habitatSummaries.values()) if (h.name === name) return h;
    return null;
}

// Habitats with problems, worst first.
export function habitatsAtRisk(model) {
    if (!model) return [];
    return Array.from(model.habitatSummaries.values())
        .filter(h => h.counts.risk + h.counts.kin + h.counts.future > 0)
        .sort((x, y) => y.counts.risk - x.counts.risk || y.counts.kin - x.counts.kin || y.counts.future - x.counts.future
            || (x.name < y.name ? -1 : 1));
}

// --------------------------------------------------------- mate finder

// Every possible mate for `id` in the zoo: same species, compatible sex,
// alive, not itself. Ranked: safest relation first, then the best expected
// offspring genes. { animal, rel, kinship, game, pred, score, sameHabitat }
export function mateCandidates(model, id, { includeJuveniles = false } = {}) {
    const self = model && model.animals.get(String(id));
    if (!self) return [];
    const out = [];
    for (const other of model.animals.values()) {
        if (other === self || other.species !== self.species || !other.alive) continue;
        if (!compatibleSexes(self, other)) continue;
        if (other.juv && !includeJuveniles) continue;
        const rel = self.guid && other.guid ? model.ped.relation(self.guid, other.guid) : null;
        const kinship = rel ? rel.kinship : 0;
        const game = rel ? rel.game : false;
        const pred = predictOffspring(self.genes, other.genes);
        out.push({
            animal: other,
            rel,
            kinship,
            game,
            tier: game ? 'game' : kinship >= model.closeKinship - 1e-9 ? 'close' : kinship > 0 ? 'distant' : 'none',
            pred,
            score: offspringScore(pred),
            sameHabitat: !!self.hab && self.hab === other.hab,
        });
    }
    const tierRank = { none: 0, distant: 1, close: 2, game: 3 };
    out.sort((p, q) => tierRank[p.tier] - tierRank[q.tier]
        || (q.score ?? -1) - (p.score ?? -1)
        || (q.sameHabitat - p.sameHabitat)
        || (p.animal.name < q.animal.name ? -1 : 1));
    return out;
}

// --------------------------------------------------------------- alerts

// Pairs that are at risk now and were not at risk before (or did not
// exist). With `includeKin`, close-kin pairs count too.
export function newRisks(prev, next, { includeKin = false } = {}) {
    if (!next) return [];
    const watched = s => s === 'risk' || (includeKin && s === 'kin');
    // by pair, not by habitat: a pair that moves together is not new
    const before = new Map();
    if (prev) {
        for (const p of prev.pairs) {
            if (!watched(before.get(p.key))) before.set(p.key, p.severity);
        }
    }
    return next.pairs.filter(p => watched(p.severity) && !watched(before.get(p.key)));
}

// ------------------------------------------------------- storage (hub)

// Storage animals are not in habitats; every related pair among them is
// reported (both sexes), for the "related to selection" filter.
export function relatedAmong(model, ids) {
    const list = ids.map(id => model.animals.get(String(id))).filter(a => a && a.guid);
    const out = [];
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const rel = model.ped.relation(list[i].guid, list[j].guid);
            if (!rel) continue;
            const tier = rel.game ? 'game' : rel.kinship >= model.closeKinship - 1e-9 ? 'close' : 'distant';
            if (tier === 'distant') continue;
            out.push({ a: list[i], b: list[j], rel, tier, kinship: rel.kinship, breeding: compatibleSexes(list[i], list[j]) });
        }
    }
    return out.sort((p, q) => (q.tier === 'game') - (p.tier === 'game') || q.kinship - p.kinship);
}

// All relatives of one animal among the given set.
export function relativesOf(model, id, pool) {
    const self = model && model.animals.get(String(id));
    if (!self || !self.guid) return [];
    const out = [];
    for (const other of pool || model.animals.values()) {
        if (other === self || !other.guid) continue;
        const rel = model.ped.relation(self.guid, other.guid);
        if (!rel) continue;
        const tier = rel.game ? 'game' : rel.kinship >= model.closeKinship - 1e-9 ? 'close' : 'distant';
        out.push({ animal: other, rel, tier, kinship: rel.kinship });
    }
    return out.sort((p, q) => (q.tier === 'game') - (p.tier === 'game') || q.kinship - p.kinship);
}

// Locate needs the animal out in the park: in a habitat, not an exhibit
// animal (the Lua side refuses those and anything without a transform).
export function canLocate(a) {
    return !!(a && a.hab && !a.exhibit && !/^x/.test(String(a.id)));
}

export { canBreedNow, isCovered, compatibleSexes };
