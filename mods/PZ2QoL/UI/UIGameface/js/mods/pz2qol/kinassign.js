// Habitat assignments for the Species board: which habitats the player has
// set aside for which species ("these five habitats are for lemurs").
// Kept per park (by the park's name from the Lua side) in the player's data
// file (userstore.js: Win64\ovldata\PZ2QoL\userdata.json), so they outlast
// closing the board and restarting the game. Nothing is written to the
// save or the profile. Assignments are keyed by habitat id; the stored name
// is only for reading the file (habitat names differ between the game's
// calls and change when the player renames a habitat).
import { normalizeAssignments } from '/js/mods/pz2qol/kinboardcore.js';
import { getUserData, setUserData, updateUserData, loadUserData, onUserData, userDataStatus } from '/js/mods/pz2qol/userstore.js';

const DATA_KEY = 'kinAssign';
const OLD_KEY = 'PZ2QoL.kin.assign.v1'; // earlier builds: localStorage only
const listeners = new Set();

function readAll() {
    const v = getUserData(DATA_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// once: what earlier builds kept in localStorage (this session only)
(function migrate() {
    try {
        const raw = window.localStorage && window.localStorage.getItem(OLD_KEY);
        if (!raw) return;
        const old = JSON.parse(raw);
        if (old && typeof old === 'object' && !getUserData(DATA_KEY)) setUserData(DATA_KEY, old);
        window.localStorage.removeItem(OLD_KEY);
    }
    catch (e) {
        // nothing to keep
    }
})();

function notify() {
    listeners.forEach(fn => {
        try {
            fn();
        }
        catch (e) {
            // never break the toggle
        }
    });
}

// the file arrived (or could not be used): redraw with what it holds
onUserData(() => notify());
loadUserData();

// 'loading' | 'file' (kept across restarts) | 'memory' (until the game closes)
export function assignmentStorage() {
    return userDataStatus();
}

export function parkKey(model) {
    return (model && model.park) || 'park';
}

function habitatName(model, habId) {
    const h = model && model.habitats.get(String(habId));
    return h && h.name ? h.name : '';
}

// habitat id -> Set(species) for this park
export function getAssignments(model) {
    const park = readAll()[parkKey(model)] || {};
    const out = {};
    for (const [hab, v] of Object.entries(park)) {
        if (!v || !Array.isArray(v.species) || !v.species.length) continue;
        out[hab] = v.species;
    }
    return normalizeAssignments(out);
}

export function assignmentsOf(model, habId) {
    return Array.from(getAssignments(model).get(String(habId)) || []);
}

// Adds or removes one species from a habitat's assignment. Stored as "this
// species on (or off) for this habitat", so it can be applied again on top
// of the file when the file arrives after the click.
export function toggleAssignment(model, habId, species, name) {
    const key = parkKey(model);
    const id = String(habId);
    const label = name || habitatName(model, id);
    const cur = ((readAll()[key] || {})[id] || {}).species || [];
    const on = !cur.includes(species);
    updateUserData(DATA_KEY, old => {
        const all = Object.assign({}, old && typeof old === 'object' && !Array.isArray(old) ? old : {});
        const park = Object.assign({}, all[key] || {});
        const entry = Object.assign({ species: [] }, park[id] || {});
        const set = new Set(Array.isArray(entry.species) ? entry.species : []);
        if (on) set.add(species);
        else set.delete(species);
        entry.species = Array.from(set);
        if (label) entry.name = label;
        if (entry.species.length) park[id] = entry;
        else delete park[id];
        if (Object.keys(park).length) all[key] = park;
        else delete all[key];
        return all;
    });
    notify();
    return on;
}

export function onAssignments(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
