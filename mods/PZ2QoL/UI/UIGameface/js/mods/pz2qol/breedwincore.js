// Breeding window: the pure part (no game imports, so node tests can load it).
//  - which habitat a click in the park picked (the game's info panel context);
//  - the species list: in the zoo, in storage, and every species the game
//    knows (its Zoopedia), filtered by a search;
//  - a species' habitats: set aside for it, where it lives now, where it
//    may go;
//  - the programme's moves that can run now.
import { speciesId } from './speciesnamecore.js';
import { canMove, isPinned, TRADE } from './kinboardcore.js';

// The info panel the game opened, as InfoPanel_SetContext names it:
// [root, kind, entity, ...]. A habitat's own panel is 'habitatGateInfoPanel'
// (its fence or gate; kinhabitat.js reads the same), an animal's panel names
// an animal kind. -> { kind: 'habitat' | 'animal' | 'other', id }
export function infoPanelTarget(ctx) {
    if (!Array.isArray(ctx) || ctx.length < 3 || ctx[2] == null) return { kind: 'other', id: '' };
    const kind = String(ctx[1] || '');
    const id = String(ctx[2]).replace(/\.0+$/, '');
    if (kind === 'habitatGateInfoPanel') return { kind: 'habitat', id };
    if (/exhibit/i.test(kind)) return { kind: 'other', id };
    if (/animal/i.test(kind)) return { kind: 'animal', id };
    return { kind: 'other', id };
}

// The habitat a park click picked, for the Breeding window's "Pick in the
// park": the habitat itself, or the habitat an animal lives in.
// -> { hab, name, via } or { error }
export function pickedHabitat(ctx, model) {
    const t = infoPanelTarget(ctx);
    if (t.kind === 'habitat') {
        const h = model && model.habitats ? model.habitats.get(t.id) : null;
        if (h && h.kind === 'exhibit') return { error: 'That is an exhibit, not a habitat.' };
        return { hab: t.id, name: (h && h.name) || '', via: 'habitat' };
    }
    if (t.kind === 'animal') {
        const a = model && model.animals ? model.animals.get(t.id) : null;
        if (!a) return { error: 'That animal is not known yet. Click the habitat\'s fence or gate instead.' };
        if (a.exhibit) return { error: `${a.name || 'That animal'} lives in an exhibit, not a habitat.` };
        if (!a.hab) return { error: `${a.name || 'That animal'} is not in a habitat right now.` };
        const h = model.habitats.get(String(a.hab));
        return { hab: String(a.hab), name: (h && h.name) || a.loc || '', via: 'animal', animal: a };
    }
    return { error: 'That is not a habitat. Click a habitat\'s fence or gate, or an animal in it.' };
}

// The species a game info panel shows (to open the window on it):
// an animal's species, or a habitat's most numerous species.
export function speciesOfPanel(ctx, model) {
    const t = infoPanelTarget(ctx);
    if (!model || !model.animals) return null;
    if (t.kind === 'animal') {
        const a = model.animals.get(t.id);
        return a && a.species && !a.exhibit ? a.species : null;
    }
    if (t.kind === 'habitat') {
        const n = new Map();
        for (const a of model.animals.values()) if (a.hab === t.id && a.species && !a.exhibit) n.set(a.species, (n.get(a.species) || 0) + 1);
        let best = null;
        for (const [sp, c] of n) if (!best || c > best[1]) best = [sp, c];
        return best ? best[0] : null;
    }
    return null;
}

// The game's Zoopedia rows (DataStore ['Zoopedia','Animals']) -> species ids.
// Shoals, exhibit animals and locked species are left out. rows: [{ key,
// id, isShoal, isExhibitAnimal, isLocked, isDlcLocked }]
export function catalogueFromZoopedia(rows) {
    const out = [];
    const seen = new Set();
    for (const r of rows || []) {
        if (!r) continue;
        const raw = r.id != null && String(r.id) !== '' ? r.id : r.key;
        const id = speciesId(raw);
        if (!id || !/^[A-Za-z0-9_]+$/.test(id) || seen.has(id)) continue;
        if (r.isShoal === true || r.isExhibitAnimal === true || r.isLocked === true || r.isDlcLocked === true) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

function words(s) {
    return String(s || '').toLowerCase().replace(/_/g, ' ').trim();
}

// Does `query` match a species (its name in the game, or its id)?
export function matchesQuery(species, name, query) {
    const q = words(query);
    if (!q) return true;
    const hay = `${words(name)} ${words(species)}`;
    return q.split(/\s+/).every(w => hay.includes(w));
}

// The species list of the window's picker, in three groups:
//   zoo      species with animals in the zoo (zoo: speciesList() rows)
//   stored   species with adults in Animal Storage and none in the zoo
//            (stored: Map species -> { m, f })
//   other    every other species the game knows (only while searching)
// Each row: { species, name, zoo (animals in the zoo), stored (adults in
// storage or null), assigned (habitats set aside) }.
export function speciesChoices({ zoo = [], stored = new Map(), catalogue = [], assigned = new Map(), query = '', nameOf = s => s, otherMax = 30 } = {}) {
    const rows = new Map();
    const row = sp => {
        if (!rows.has(sp)) rows.set(sp, { species: sp, name: nameOf(sp), zoo: 0, males: 0, females: 0, stored: null, assigned: assigned.get(sp) || 0 });
        return rows.get(sp);
    };
    for (const s of zoo) Object.assign(row(s.species), { zoo: s.animals || 0, males: s.males || 0, females: s.females || 0 });
    for (const [sp, c] of stored) {
        if (!c || !(c.m + c.f > 0)) continue;
        row(sp).stored = c.m + c.f;
    }
    for (const sp of assigned.keys()) row(sp);
    const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
    const hit = r => matchesQuery(r.species, r.name, query);
    const all = Array.from(rows.values());
    const zooRows = all.filter(r => r.zoo > 0 && hit(r)).sort(byName);
    const storedRows = all.filter(r => !r.zoo && (r.stored || r.assigned) && hit(r)).sort(byName);
    let other = [];
    if (words(query)) {
        for (const sp of catalogue) {
            if (rows.has(sp)) continue;
            const name = nameOf(sp);
            if (matchesQuery(sp, name, query)) other.push({ species: sp, name, zoo: 0, males: 0, females: 0, stored: null, assigned: 0 });
        }
        other.sort(byName);
    }
    const more = Math.max(0, other.length - otherMax);
    other = other.slice(0, otherMax);
    return { zoo: zooRows, stored: storedRows, other, more };
}

// A species' habitats for the window's Habitats tab:
//   assigned  set aside for it (assignments: Map habitat -> Set(species))
//   living    it lives there, not set aside
//   suitable  the game says it may go there (dest.bySpecies), not set aside,
//             none of it there yet
// Each row: { hab, name, here: { m, f, young }, others (other species there),
//   ok (the game's check: true, false or null unknown), reason, shared
//   (other species set aside for it too) }.
export function habitatRows(model, species, assignments, dest) {
    const out = { assigned: [], living: [], suitable: [] };
    if (!model || !species) return out;
    const d = dest && dest.bySpecies ? dest.bySpecies[species] || null : null;
    const habs = new Map();
    const nameOf = id => {
        const h = model.habitats && model.habitats.get(String(id));
        if (h && h.name) return h.name;
        const x = dest && Array.isArray(dest.habitats) ? dest.habitats.find(y => String(y.id) === String(id)) : null;
        return x && x.name ? x.name : `Habitat ${id}`;
    };
    const row = id => {
        const k = String(id);
        if (!habs.has(k)) {
            const v = d && d[k];
            habs.set(k, { hab: k, name: nameOf(k), here: { m: 0, f: 0, young: 0 }, others: new Set(), ok: v ? !!v.ok : null, reason: v && v.reason ? String(v.reason) : '', shared: [] });
        }
        return habs.get(k);
    };
    for (const a of model.animals.values()) {
        if (!a.hab || a.exhibit || a.alive === false) continue;
        const h = model.habitats.get(String(a.hab));
        if (h && h.kind === 'exhibit') continue;
        if (a.species === species) {
            const r = row(a.hab);
            if (a.juv) r.here.young++;
            else if (a.sex === 1) r.here.f++;
            else r.here.m++;
        }
    }
    for (const a of model.animals.values()) {
        if (a.hab && a.species && a.species !== species && habs.has(String(a.hab))) habs.get(String(a.hab)).others.add(a.species);
    }
    const set = new Set();
    for (const [hab, sps] of assignments || []) {
        if (!sps || !sps.has(species)) continue;
        set.add(String(hab));
        const r = row(hab);
        r.shared = Array.from(sps).filter(x => x !== species);
    }
    if (d) {
        for (const [id, v] of Object.entries(d)) if (v && v.ok && !habs.has(String(id))) row(id);
    }
    // a habitat set aside for other species only is not suggested
    const takenByOthers = id => {
        const sps = assignments && assignments.get ? assignments.get(String(id)) : null;
        return !!(sps && sps.size && !sps.has(species));
    };
    const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
    for (const r of habs.values()) {
        r.others = Array.from(r.others);
        const n = r.here.m + r.here.f + r.here.young;
        if (set.has(r.hab)) out.assigned.push(r);
        else if (n > 0) out.living.push(r);
        else if (r.ok && !takenByOthers(r.hab)) out.suitable.push(r);
    }
    out.assigned.sort(byName);
    out.living.sort(byName);
    out.suitable.sort(byName);
    return out;
}

// The programme's moves that may run now (the board's useProgramme rule):
// animals that can move and are not pinned (pregnant).
export function runnableMoves(model, moves) {
    const out = [];
    for (const m of moves || []) {
        const a = model && model.animals ? model.animals.get(String(m.id)) : null;
        if (!a || !canMove(a) || isPinned(a)) continue;
        out.push({ id: a.id, to: m.to });
    }
    return out;
}

// What the programme depends on for one species (the board's
// programmeSig): its animals and its habitats set aside. A scan that
// changes nothing of it keeps the plan.
export function programmeSignature(model, species, assignments) {
    if (!model) return '';
    const rows = [];
    for (const a of model.animals.values()) {
        if (a.species !== species || a.exhibit) continue;
        rows.push([a.id, a.hab || '', a.lt || '', a.moving ? 1 : 0, a.sex, a.juv ? 1 : 0, a.contra ? 1 : 0, a.infertile ? 1 : 0,
            a.alive === false ? 0 : 1, (a.fert && a.fert.state) || '', (a.mates || []).join('+'), (a.par || []).join('+'), a.preg ? 1 : 0].join(','));
    }
    rows.sort();
    const assigned = [];
    for (const [hab, set] of assignments || []) if (set && set.has(species)) assigned.push(String(hab));
    return rows.join(';') + '|' + assigned.sort().join(',');
}

// "Lion Savannah" -> "Lion Savannah" | the trade centre
export function moveTarget(model, to, dest) {
    if (to === TRADE) return (dest && dest.tradeCentre && dest.tradeCentre.name) || (model && model.tradeCentre && model.tradeCentre.name) || 'Trade centre';
    const h = model && model.habitats ? model.habitats.get(String(to)) : null;
    if (h && h.name) return h.name;
    const x = dest && Array.isArray(dest.habitats) ? dest.habitats.find(y => String(y.id) === String(to)) : null;
    return x && x.name ? x.name : `Habitat ${to}`;
}
