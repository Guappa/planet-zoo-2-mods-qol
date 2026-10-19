// Species display names, pure (no game imports, so node tests can load it).
// The game's own name for a species is the text symbol Animal_<SpeciesId>
// (e.g. [Animal_Warthog_Common]); speciesnames.js plugs in the game's
// Localisation.js. Without a translation the internal id is shown with
// spaces ("Warthog Common"), as before.

// '[Animal_Warthog_Common]' | 'Animal_Warthog_Common' | 'Warthog_Common' -> 'Warthog_Common'
export function speciesId(raw) {
    return String(raw == null ? '' : raw).replace(/^\[/, '').replace(/\]$/, '').replace(/^Animal_/, '');
}

// The internal name: 'Warthog Common' (or 'Unknown species').
export function plainSpeciesName(raw) {
    return speciesId(raw).replace(/_/g, ' ').trim() || 'Unknown species';
}

// loc: { exists(id) -> bool (no brackets), translate('[sym]') -> string } or null.
// enabled(): false shows the internal names without asking loc.
// onFail(e): called once, on the first lookup that throws.
// Only successful translations are cached, so a call made before the game's
// localisation is ready is retried next time.
export function createSpeciesNamer({ loc = null, enabled = () => true, onFail = () => {} } = {}) {
    const cache = new Map();
    let failed = false;
    const good = (out, sym) => typeof out === 'string' && out.trim() !== '' && out !== sym && !/^!.*!$/.test(out);
    function name(raw) {
        const plain = plainSpeciesName(raw);
        const id = speciesId(raw);
        if (!id || !loc || !enabled()) return plain;
        if (cache.has(id)) return cache.get(id);
        const s = String(raw);
        try {
            let out = null;
            if (/^\[.+\]$/.test(s)) {
                const t = loc.translate(s);
                if (good(t, s)) out = t;
            }
            if (out == null) {
                const key = `Animal_${id}`;
                const sym = `[${key}]`;
                if (loc.exists(key)) {
                    const t = loc.translate(sym);
                    if (good(t, sym)) out = t;
                }
            }
            if (out != null) {
                cache.set(id, out);
                return out;
            }
        }
        catch (e) {
            if (!failed) {
                failed = true;
                try { onFail(e); } catch (_) { /* never break a name */ }
            }
        }
        return plain;
    }
    name.setLoc = (l) => { loc = l; cache.clear(); };
    return name;
}
