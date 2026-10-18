// Kin runtime: talks to PZ2QoL.Kin (Lua), keeps the current kin model and
// the player's Kin settings, and tells the surfaces (kin*.js) when it
// changes.
//
// Lua answers PZ2QoL_KinScan with the snapshot as JSON in chunks
// (PZ2QoL_KinChunk seq, i, n, text) or with PZ2QoL_KinState (same, busy,
// nopark, error, ...). Scans are asked for when a kin surface is on screen,
// on a slow timer for alerts, and shortly after anything that changes
// breeding (contraception, moves, births are caught by the timer).
import { buildKinModel, normalizeSnapshot, DEFAULT_CLOSE_KINSHIP } from '/js/mods/pz2qol/kincore.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';

const SCAN_INTERVAL_MS = 20000;   // background rescan (alerts)
const ACTIVE_INTERVAL_MS = 6000;  // while a kin surface is on screen
const MIN_GAP_MS = 1500;          // between two requests
const CHUNK_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------- settings

export const DEFAULT_KIN_SETTINGS = Object.freeze({
    enabled: true,        // badges, filters and panels
    alerts: true,         // "new inbreeding risk" toasts
    alertKin: false,      // also alert for close kin the game does not flag
    closeKinship: DEFAULT_CLOSE_KINSHIP,
    showCovered: true,    // grey badges for pairs kept apart by contraception
    // a related pair the game keeps apart by a monogamous pair bond counts as
    // 'held' (Bonded elsewhere) instead of a risk; off: every such pair is a risk
    bondHolds: true,
    // Species board: run a whole staged plan in a Franchise zoo (or when the
    // mode is unknown). Off by default; single moves are always one click.
    allowPlansOnline: false,
});
const SETTINGS_KEY = 'PZ2QoL.kin.settings';

function loadSettings() {
    try {
        const raw = window.localStorage && window.localStorage.getItem(SETTINGS_KEY);
        if (raw) return Object.assign({}, DEFAULT_KIN_SETTINGS, JSON.parse(raw));
    }
    catch (e) {
        // defaults
    }
    return Object.assign({}, DEFAULT_KIN_SETTINGS);
}

let settings = loadSettings();
const settingsListeners = new Set();

export function getKinSettings() {
    return settings;
}

export function setKinSettings(patch) {
    const before = settings;
    settings = Object.assign({}, settings, patch);
    try {
        if (window.localStorage) window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }
    catch (e) {
        // session only
    }
    if (before.closeKinship !== settings.closeKinship || before.bondHolds !== settings.bondHolds) rebuild();
    settingsListeners.forEach(fn => safeCall(fn, settings));
    notify();
}

export function onKinSettings(fn) {
    settingsListeners.add(fn);
    return () => settingsListeners.delete(fn);
}

// ------------------------------------------------------------------ state

let parkModel = null;
let parkSnapshot = null;
let storageModel = null;
let storageSnapshot = null;
let lastState = { state: 'idle', detail: '', time: 0 };
const listeners = new Set();
const stateListeners = new Set();
const chunks = new Map(); // seq -> { parts: [], n, time }
let lastRequest = 0;
let pending = null;
let activeUntil = 0;
let installed = false;
let available = typeof engine !== 'undefined';

function safeCall(fn, ...args) {
    try {
        fn(...args);
    }
    catch (e) {
        reportError('ui', 'Kin update failed', e, { silent: true });
    }
}

export function getKinModel() {
    return settings.enabled ? parkModel : null;
}

export function getStorageKinModel() {
    return settings.enabled ? storageModel : null;
}

// Last answer from the Lua side ('same', 'nopark', 'busy', 'error', ...).
export function getKinState() {
    return lastState;
}

export function onKin(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function onKinState(fn) {
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
}

function notify(scope) {
    listeners.forEach(fn => safeCall(fn, getKinModel(), scope || 'park'));
}

// What every kin model is built with (the planner's settings).
function modelOpts() {
    return { closeKinship: settings.closeKinship, bondHolds: settings.bondHolds !== false };
}

function rebuild() {
    try {
        if (parkSnapshot) parkModel = buildKinModel(parkSnapshot, modelOpts());
        if (storageSnapshot) storageModel = buildKinModel(storageSnapshot, modelOpts());
    }
    catch (e) {
        reportError('mod', 'Kin could not read the animals', e);
    }
}

// Applies a snapshot (also used by the browser harness).
export function applyKinSnapshot(raw) {
    const snap = normalizeSnapshot(raw);
    const model = buildKinModel(snap, modelOpts());
    if (snap.scope === 'storage') {
        storageSnapshot = snap;
        storageModel = model;
    }
    else {
        parkSnapshot = snap;
        parkModel = model;
    }
    breadcrumb('kin_model');
    notify(snap.scope);
    return model;
}

// Storage rows carry name, species, sex and age; Lua only adds lineage.
// New row data (a rename, a youngster growing up) is merged into the last
// lineage snapshot right away, without asking Lua again.
let storageRows = new Map();
let storageRaw = null;
let storageRowsSig = '';
export function setStorageRows(rows) {
    storageRows = new Map(rows.map(r => [String(r.id), r]));
    const sig = rows.map(r => [r.id, r.name, r.species, r.sex, r.juv, r.preg].join('|')).join('~');
    if (sig === storageRowsSig) return;
    storageRowsSig = sig;
    if (storageRaw) {
        try {
            applyKinSnapshot(mergeStorage(storageRaw));
        }
        catch (e) {
            reportError('mod', 'Kin could not read the stored animals', e, { silent: true });
        }
    }
}

function mergeStorage(raw) {
    const out = Object.assign({}, raw);
    out.animals = (raw.animals || []).map(a => {
        const row = storageRows.get(String(a.id)) || {};
        return Object.assign({ name: row.name, species: row.species, sex: row.sex, juv: row.juv, preg: row.preg }, a, { key: String(a.id), hab: '' });
    });
    return out;
}

function onChunk(seq, i, n, text) {
    const now = Date.now();
    for (const [k, v] of chunks) if (now - v.time > CHUNK_TIMEOUT_MS) chunks.delete(k);
    let entry = chunks.get(seq);
    if (!entry) chunks.set(seq, entry = { parts: [], n, time: now });
    entry.parts[i - 1] = text;
    let have = 0;
    for (const p of entry.parts) if (typeof p === 'string') have++;
    if (have < n) return;
    chunks.delete(seq);
    let raw;
    try {
        raw = JSON.parse(entry.parts.join(''));
    }
    catch (e) {
        reportError('mod', 'Kin data could not be read', e, { silent: true });
        return;
    }
    setState('ok', '');
    if (raw && raw.scope === 'storage') storageRaw = raw;
    else finishPending();
    try {
        applyKinSnapshot(raw && raw.scope === 'storage' ? mergeStorage(raw) : raw);
    }
    catch (e) {
        reportError('mod', 'Kin could not read the animals', e);
    }
}

function setState(state, detail) {
    lastState = { state, detail: detail || '', time: Date.now() };
    stateListeners.forEach(fn => safeCall(fn, lastState));
}

// A scan asked for while another was running (e.g. right after a
// contraception click) runs once that one has answered.
let followUp = null;
function finishPending() {
    pending = null;
    if (followUp) {
        const reason = followUp;
        followUp = null;
        requestKinScan(reason, { force: true, delay: 150 });
    }
}

function onState(state, detail) {
    if ((state === 'same' && detail !== 'storage') || state === 'busy' || state === 'nopark' || state === 'error') finishPending();
    if (state === 'error') reportError('mod', 'Kin scan failed', detail, { silent: true });
    if (state === 'failed') reportError('mod', 'Kin action failed', detail);
    if (state === 'nopark') {
        parkModel = null;
        parkSnapshot = null;
        notify('park');
    }
    if (state === 'contracept') requestKinScan('contracept', { force: true, delay: 400 });
    // Lua thinks this page already has the data, but it has none (reloaded)
    if (state === 'same' && ((detail === 'storage' && !storageSnapshot) || (detail !== 'storage' && !parkSnapshot))) {
        try {
            engine.trigger('PZ2QoL_KinForget');
        }
        catch (e) {
            // older Lua side
        }
        if (detail === 'storage') lastStorageIds = '';
        else requestKinScan('resend', { force: true, delay: 300 });
    }
    setState(state, detail);
}

// ---------------------------------------------------------------- requests

export function requestKinScan(reason = 'ui', { force = false, delay = 0 } = {}) {
    if (!available || !settings.enabled) return false;
    if (delay > 0) {
        setTimeout(() => requestKinScan(reason, { force }), delay);
        return true;
    }
    const now = Date.now();
    if (!force && now - lastRequest < MIN_GAP_MS) return false;
    if (pending && now - pending < CHUNK_TIMEOUT_MS) {
        if (force) followUp = reason;
        return false;
    }
    lastRequest = now;
    pending = now;
    try {
        engine.trigger('PZ2QoL_KinScan', String(reason));
        breadcrumb('kin_scan');
        return true;
    }
    catch (e) {
        pending = null;
        return false;
    }
}

// Lineage for the stored animals with these row ids (Animal Storage).
let lastStorageIds = '';
export function requestStorageKin(ids, { force = false } = {}) {
    if (!available || !settings.enabled) return false;
    const list = ids.map(String).sort().join(',');
    if (!list || (!force && list === lastStorageIds)) return false;
    lastStorageIds = list;
    try {
        engine.trigger('PZ2QoL_KinStorage', list);
        return true;
    }
    catch (e) {
        return false;
    }
}

// A kin surface is on screen: keep the data fresher for a while.
export function markKinActive() {
    const now = Date.now();
    const wasIdle = now > activeUntil;
    activeUntil = now + 3000;
    if (wasIdle) requestKinScan('active');
}

// ----------------------------------------------------------------- actions

function act(name, ...args) {
    try {
        engine.trigger(name, ...args);
        breadcrumb(name.replace('PZ2QoL_', '').toLowerCase());
        return true;
    }
    catch (e) {
        reportError('ui', 'Kin action could not be sent', e);
        return false;
    }
}

// One animal, one click (the game's own contraception setter).
export function setContraception(id, on) {
    return act('PZ2QoL_KinContracept', String(id), !!on);
}

export function locateAnimal(id) {
    return act('PZ2QoL_KinLocate', String(id));
}

// The game's own "Breeding" heat map (InbreedingRisk). The HUD's heat map
// panel opens on ShowHeatmap(category, subCategory), the event its own Lua
// sends (HeatMapManager.ClaimViewModeRequest); -1, -1 closes it. Indexes come
// from the game's HeatmapsData so a reordered list still works. Off the HUD
// page (or if that fails) the Lua side asks the heat map manager directly.
let heatmapOn = false;
export function isBreedingHeatmapOn() {
    return heatmapOn;
}
export async function setBreedingHeatmap(on) {
    heatmapOn = !!on;
    try {
        if (/HUD/i.test(String(location.pathname || ''))) {
            const data = await import('/js/project/modules/Heatmaps/HeatmapsData.js');
            const cats = data.categories || [];
            const ci = cats.findIndex(c => (c.subCategories || c.items || c.heatmaps || []).some(s => s.id === 'InbreedingRisk'));
            if (!heatmapOn) {
                engine.trigger('ShowHeatmap', -1, -1);
                return true;
            }
            if (ci >= 0) {
                const subs = cats[ci].subCategories || cats[ci].items || cats[ci].heatmaps;
                engine.trigger('ShowHeatmap', ci, subs.findIndex(s => s.id === 'InbreedingRisk'));
                return true;
            }
        }
    }
    catch (e) {
        // fall back to Lua
    }
    return act('PZ2QoL_KinHeatmap', heatmapOn);
}

// ----------------------------------------------------------------- install

export function installKin() {
    if (installed) return true;
    installed = true;
    if (typeof engine === 'undefined') {
        available = false;
        return true;
    }
    engine.on('PZ2QoL_KinChunk', (seq, i, n, text) => {
        try {
            onChunk(seq, i, n, text);
        }
        catch (e) {
            reportError('mod', 'Kin data failed', e, { silent: true });
        }
    });
    engine.on('PZ2QoL_KinState', (state, detail) => onState(String(state), detail));
    // the heat map panel tells the game which map it shows
    engine.on('Heatmaps_Select', id => {
        heatmapOn = id === 'InbreedingRisk';
    });
    engine.on('PZ2QoL_Hello', () => {
        // Lua side (re)connected: it may have lost what it sent before
        try {
            engine.trigger('PZ2QoL_KinForget');
        }
        catch (e) {
            // older Lua side
        }
        requestKinScan('hello', { force: true, delay: 1500 });
    });
    // a park started or ended (a wildlife reserve and back): the last park
    // snapshot holds the previous load's entity ids, so it is not used again
    engine.on('PZ2QoL_StoreReset', () => {
        if (!parkSnapshot) return;
        breadcrumb('kin_park_reset');
        parkModel = null;
        parkSnapshot = null;
        notify('park');
        requestKinScan('park_reset', { force: true, delay: 1500 });
    });
    // anything that may change who can breed with whom
    for (const name of ['ManagementAnimals_ContraceptionToggled', 'InfoPanel_Animal_Contraceptive', 'CompareMates_UI_ContraceptionToggled']) {
        engine.on(name, () => requestKinScan('game_' + name, { force: true, delay: 600 }));
    }
    setInterval(() => {
        const active = Date.now() < activeUntil;
        if (Date.now() - lastRequest >= (active ? ACTIVE_INTERVAL_MS : SCAN_INTERVAL_MS)) requestKinScan(active ? 'active' : 'timer');
    }, 1000);
    requestKinScan('install', { force: true, delay: 2500 });
    return true;
}
