// Habitat assignments for the Species board: which habitats the player has
// set aside for which species ("these five habitats are for lemurs").
// Kept per park (by the park's name from the Lua side) in localStorage;
// nothing is written to the save or the profile. A stored habitat whose
// name no longer matches is ignored (a different park with the same name,
// or a rebuilt habitat that got the same id).
import { normalizeAssignments } from '/js/mods/pz2qol/kinboardcore.js';
import { reportError } from '/js/mods/pz2qol/errors.js';

const KEY = 'PZ2QoL.kin.assign.v1';
const listeners = new Set();

function loadAll() {
    try {
        const raw = window.localStorage && window.localStorage.getItem(KEY);
        const v = raw ? JSON.parse(raw) : {};
        return v && typeof v === 'object' ? v : {};
    }
    catch (e) {
        return {};
    }
}

function saveAll(all) {
    try {
        if (window.localStorage) window.localStorage.setItem(KEY, JSON.stringify(all));
    }
    catch (e) {
        reportError('ui', 'Habitat assignments could not be saved', e, { silent: true });
    }
}

let all = loadAll();

export function parkKey(model) {
    return (model && model.park) || 'park';
}

function habitatName(model, habId) {
    const h = model && model.habitats.get(String(habId));
    return h && h.name ? h.name : '';
}

// habitat id -> Set(species) for this park
export function getAssignments(model) {
    const park = all[parkKey(model)] || {};
    const out = {};
    for (const [hab, v] of Object.entries(park)) {
        if (!v || !Array.isArray(v.species) || !v.species.length) continue;
        const now = habitatName(model, hab);
        if (now && v.name && now !== v.name) continue;
        out[hab] = v.species;
    }
    return normalizeAssignments(out);
}

export function assignmentsOf(model, habId) {
    return Array.from(getAssignments(model).get(String(habId)) || []);
}

// Adds or removes one species from a habitat's assignment.
export function toggleAssignment(model, habId, species, name) {
    const key = parkKey(model);
    const park = all[key] || (all[key] = {});
    const id = String(habId);
    const entry = park[id] || { name: name || habitatName(model, id), species: [] };
    const set = new Set(entry.species);
    if (set.has(species)) set.delete(species);
    else set.add(species);
    entry.species = Array.from(set);
    if (name || habitatName(model, id)) entry.name = name || habitatName(model, id);
    if (entry.species.length) park[id] = entry;
    else delete park[id];
    saveAll(all);
    listeners.forEach(fn => {
        try {
            fn();
        }
        catch (e) {
            // never break the toggle
        }
    });
    return set.has(species);
}

export function onAssignments(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
