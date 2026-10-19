// Species board: talking to the game about moves.
//
//  - requestDestinations(ids): which habitats each species may move to, by
//    the game's own checks (PZ2QoL.Kin on the Lua side).
//  - requestStoredAdults(species): the player's stored adults of a species
//    (Find a mate, Franchise only; read-only).
//  - moveAnimal(id, to): ONE move, exactly what the game's own Move does
//    (a keeper boxes the animal and carries it). One click, one move.
//  - runPlan(plan): a staged plan, started by one click, run ONE move at a
//    time: send it, wait for the game to confirm it (the animal gets a
//    transport job), pause, then the next. A refused or unconfirmed move is
//    skipped and the run carries on; only Stop ends it. Franchise zoos run the
//    same way: the Execute click is the opt-in.
import { getKinModel, getKinSettings, onKin, requestKinScan } from '/js/mods/pz2qol/kin.js';
import { prunePlan, moveText, TRADE, isPinned } from '/js/mods/pz2qol/kinboardcore.js';
import { normalizeStored } from '/js/mods/pz2qol/kincore.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { getPaceMs } from '/js/mods/pz2qol/pace.js';

const ANSWER_TIMEOUT_MS = 6000;
const CONFIRM_TIMEOUT_MS = 12000;
// the pause after each confirmed move: the player's 'moves' pace (default 0.5 s)
const DEST_CACHE_MS = 30000;

let reqSeq = 0;
const waiting = new Map(); // reqId -> resolve
const storedChunks = new Map(); // reqId -> { parts, n }
let installed = false;

function install() {
    if (installed || typeof engine === 'undefined') return;
    installed = true;
    engine.on('PZ2QoL_KinDestinationsResult', (reqId, json) => {
        const done = waiting.get(String(reqId));
        if (!done) return;
        waiting.delete(String(reqId));
        let out = null;
        try {
            out = JSON.parse(json);
        }
        catch (e) {
            reportError('mod', 'Kin: destinations could not be read', e, { silent: true });
        }
        done(out);
    });
    engine.on('PZ2QoL_KinSpeciesResult', (reqId, json) => {
        const done = waiting.get(String(reqId));
        if (!done) return;
        waiting.delete(String(reqId));
        let out = null;
        try {
            out = JSON.parse(json);
        }
        catch (e) {
            reportError('mod', 'Kin: species facts could not be read', e, { silent: true });
        }
        done(out);
    });
    // the stored adults come in chunks, like the park snapshot
    engine.on('PZ2QoL_KinStoredChunk', (reqId, i, n, text) => {
        const key = String(reqId);
        const done = waiting.get(key);
        if (!done) return;
        let entry = storedChunks.get(key);
        if (!entry) storedChunks.set(key, entry = { parts: [], n: Number(n) || 1 });
        entry.parts[(Number(i) || 1) - 1] = String(text == null ? '' : text);
        let have = 0;
        for (const p of entry.parts) if (typeof p === 'string') have++;
        if (have < entry.n) return;
        storedChunks.delete(key);
        waiting.delete(key);
        let out = null;
        try {
            out = JSON.parse(entry.parts.join(''));
        }
        catch (e) {
            reportError('mod', 'Kin: stored animals could not be read', e, { silent: true });
        }
        done(out);
    });
    engine.on('PZ2QoL_KinMoveResult', (reqId, ok, detail) => {
        const done = waiting.get(String(reqId));
        if (!done) return;
        waiting.delete(String(reqId));
        done({ ok: ok === true, detail: detail ? String(detail) : '' });
    });
}

function ask(event, timeoutValue, ...args) {
    install();
    if (typeof engine === 'undefined') return Promise.resolve(timeoutValue);
    const reqId = String(++reqSeq);
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            if (waiting.delete(reqId)) resolve(timeoutValue);
        }, ANSWER_TIMEOUT_MS);
        waiting.set(reqId, v => {
            clearTimeout(timer);
            resolve(v);
        });
        try {
            engine.trigger(event, reqId, ...args);
        }
        catch (e) {
            waiting.delete(reqId);
            clearTimeout(timer);
            resolve(timeoutValue);
        }
    });
}

// ------------------------------------------------------------ destinations

const destCache = new Map(); // species -> { time, value }
let lastDest = null;

function merge(a, b) {
    if (!a) return b;
    if (!b) return a;
    const habitats = new Map((a.habitats || []).map(h => [String(h.id), h]));
    for (const h of b.habitats || []) habitats.set(String(h.id), h);
    return {
        bySpecies: Object.assign({}, a.bySpecies, b.bySpecies),
        habitats: Array.from(habitats.values()),
        tradeCentre: b.tradeCentre || a.tradeCentre || null,
    };
}

// Destinations for the species of these animals (cached 30 s per species).
// Resolves { bySpecies, habitats, tradeCentre } or null.
export async function requestDestinations(ids, { force = false } = {}) {
    const model = getKinModel();
    const species = new Set();
    const need = [];
    for (const id of ids || []) {
        const a = model && model.animals.get(String(id));
        if (!a) continue;
        const c = destCache.get(a.species);
        if (!force && c && Date.now() - c.time < DEST_CACHE_MS) continue;
        if (!species.has(a.species)) need.push(a.id);
        species.add(a.species);
    }
    if (need.length) {
        const value = await ask('PZ2QoL_KinDestinations', null, need.join(','));
        if (value) {
            for (const sp of Object.keys(value.bySpecies || {})) destCache.set(sp, { time: Date.now(), value: { bySpecies: { [sp]: value.bySpecies[sp] } } });
            lastDest = merge(lastDest, value);
        }
    }
    return lastDest;
}

export function cachedDestinations() {
    return lastDest;
}

// ------------------------------------------------------- species facts

const speciesCache = new Map(); // species -> { time, habs, value }

// What the breeding programme needs about one species (social range,
// fertility ages, mating system, the game's conception table) and the
// space in the given habitats. Cached for a minute. Resolves the facts or
// null (no answer).
export async function requestSpeciesInfo(species, habIds = [], { force = false } = {}) {
    const habs = Array.from(new Set(habIds.map(String))).filter(h => /^\d+$/.test(h)).sort().join(',');
    const c = speciesCache.get(species);
    if (!force && c && c.habs === habs && Date.now() - c.time < 60000) return c.value;
    const value = await ask('PZ2QoL_KinSpecies', null, String(species), habs);
    if (value && !value.error) speciesCache.set(species, { time: Date.now(), habs, value });
    return value;
}

// ------------------------------------------------------ stored adults

const STORED_CACHE_MS = 60000;
const storedCache = new Map();    // species -> normalized answer (with .time)
const storedAsking = new Map();   // species -> Promise

// The player's stored adults of one species (Franchise only, as the game's
// own Compare Mates lists them): read-only, cached for a minute. Resolves
// normalizeStored()'s { species, animals, anc, error, capped, time }, or
// null when Lua did not answer.
export function requestStoredAdults(species, { force = false } = {}) {
    const sp = String(species || '');
    if (!sp) return Promise.resolve(null);
    const c = storedCache.get(sp);
    if (!force && c && Date.now() - c.time < STORED_CACHE_MS) return Promise.resolve(c);
    if (storedAsking.has(sp)) return storedAsking.get(sp);
    const p = ask('PZ2QoL_KinStored', null, sp).then(raw => {
        storedAsking.delete(sp);
        if (!raw) {
            // no answer: remembered briefly so a page that keeps rendering
            // does not ask again and again
            const none = Object.assign(normalizeStored({ species: sp, error: 'noanswer' }), { time: Date.now() - STORED_CACHE_MS + 15000 });
            storedCache.set(sp, none);
            return null;
        }
        const value = normalizeStored(raw);
        value.time = Date.now();
        storedCache.set(sp, value);
        breadcrumb(value.error ? 'kin_stored_error' : 'kin_stored');
        return value;
    }).catch(e => {
        storedAsking.delete(sp);
        reportError('mod', 'Kin: stored animals failed', e, { silent: true });
        return null;
    });
    storedAsking.set(sp, p);
    return p;
}

// The last answer for a species ({ ..., error: 'noanswer' } after a silent
// Lua), or null when none is cached; never asks.
export function cachedStoredAdults(species) {
    const c = storedCache.get(String(species || ''));
    return c && Date.now() - c.time < STORED_CACHE_MS ? c : null;
}

// True while a request for the species is out.
export function isAskingStored(species) {
    return storedAsking.has(String(species || ''));
}

// For the browser harness: forget every cached answer.
export function _clearStoredCache() {
    storedCache.clear();
}

// ------------------------------------------------------------------ moves

// Animals sent to a quarantine on their way to the trade centre (this
// page): kinquarantine.js offers to send them on once they pass.
const toTradeAfterQuarantine = new Set();

export function quarantinedForTrade() {
    return toTradeAfterQuarantine;
}

// One move, one click. Resolves { ok, detail, quarantine }. opts.direct:
// to the trade centre even when sick (the "passed quarantine" notice).
export async function moveAnimal(id, to, opts = {}) {
    const model = getKinModel();
    const a = model && model.animals.get(String(id));
    if (!a) return { ok: false, detail: 'This animal is no longer in the zoo.' };
    let target = String(to);
    if (to === TRADE) {
        // a known trade centre, or let the Lua side find one now
        const tc = (lastDest && lastDest.tradeCentre) || model.tradeCentre;
        // sick or injured: a quarantine first (the market refuses it)
        const q = !opts.direct && getKinSettings().quarantineSick !== false;
        target = (q ? 'tradeq:' : 'trade:') + (tc ? tc.id : 'auto');
    }
    breadcrumb('kin_move');
    const r = await ask('PZ2QoL_KinMove', { ok: false, detail: 'The game did not answer.' }, String(id), target);
    if (r && r.ok && r.detail === 'quarantine') {
        toTradeAfterQuarantine.add(String(id));
        r.quarantine = true;
        r.detail = `${a.name} is sick or injured: sent to a quarantine first. You can send it on to the trade centre when it passes.`;
        breadcrumb('kin_move_quarantine');
    }
    requestKinScan('move', { force: true, delay: 300 });
    return r;
}

// Waits until the kin data shows the animal on its way (or there).
function waitConfirmed(id, to, timeoutMs) {
    const confirmed = model => {
        const a = model && model.animals.get(String(id));
        // gone from the zoo after Send to Trade Centre: it has left
        if (!a) return to === TRADE && !!model;
        if (a.moving) return true;
        // sick: on its way to a quarantine instead (moveAnimal)
        if (to === TRADE && a.lt === 'quarantine') return true;
        return to === TRADE ? a.lt === 'trade' : a.hab === String(to);
    };
    return new Promise(resolve => {
        if (confirmed(getKinModel())) return resolve(true);
        let off = null;
        const timer = setTimeout(() => {
            if (off) off();
            resolve(false);
        }, timeoutMs);
        off = onKin(model => {
            if (confirmed(model)) {
                clearTimeout(timer);
                off();
                resolve(true);
            }
        });
        // ask again a few times while waiting
        for (const t of [1500, 4000, 8000]) setTimeout(() => requestKinScan('confirm', { force: true }), t);
    });
}

// -------------------------------------------------------------- plan runs

let run = { running: false, stopping: false, done: 0, total: 0, current: null, log: [], error: null, finished: false };
const runListeners = new Set();

function setRun(patch) {
    run = Object.assign({}, run, patch);
    runListeners.forEach(fn => {
        try {
            fn(run);
        }
        catch (e) {
            // a listener must never stop the run
        }
    });
}

export function getPlanRun() {
    return run;
}

export function onPlanRun(fn) {
    runListeners.add(fn);
    return () => runListeners.delete(fn);
}

// Why a plan may not run now ('' when it may).
export function planBlockedReason(model = getKinModel()) {
    if (!model) return 'No kin data yet.';
    if (run.running) return 'A plan is already running.';
    // Franchise too: the Execute click is the opt-in (the developer's decision, 2026-10-16)
    return '';
}

export function stopPlan() {
    if (run.running) setRun({ stopping: true });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs a plan: one move at a time, each confirmed by the game.
// Options only Auto mode passes (unset: exactly the board's run):
//   beforeEach    async (move) => '' to go on, or a reason to skip it (the
//                 game's gate: movement allowed, server idle...)
//   owner         who started the run ('board' unless said)
export async function runPlan(plan, { destinations, beforeEach = null, owner = 'board' } = {}) {
    const blocked = planBlockedReason();
    if (blocked) return { ok: false, detail: blocked };
    const moves = prunePlan(getKinModel(), plan);
    if (!moves.length) return { ok: false, detail: 'Nothing to move.' };
    setRun({ running: true, stopping: false, done: 0, total: moves.length, current: null, log: [], error: null, finished: false, owner });
    breadcrumb('kin_plan_start');
    let error = null;
    let skipped = 0;
    for (const m of moves) {
        if (run.stopping) break;
        const model = getKinModel();
        const still = prunePlan(model, [m]);
        const text = moveText(model, m, destinations);
        if (!still.length) {
            setRun({ log: run.log.concat([{ text, ok: false, detail: 'skipped: it can no longer move (or is already there)' }]) });
            continue;
        }
        // a pregnant animal stays (she can't be sold and has to give birth
        // first): only a move the player planned by hand is run
        if (!m.byPlayer && isPinned(model && model.animals.get(String(m.id)))) {
            skipped++;
            error = `${text}: she is pregnant; plans never move her until she gives birth.`;
            breadcrumb('kin_plan_skip_pregnant');
            setRun({ log: run.log.concat([{ text, ok: false, detail: 'skipped: pregnant (plans never move her until she gives birth)' }]) });
            continue;
        }
        setRun({ current: text });
        if (beforeEach) {
            let why = '';
            try {
                why = await beforeEach(m);
            }
            catch (e) {
                why = '';
            }
            if (run.stopping) break;
            if (why) {
                skipped++;
                error = `${text}: ${why}`;
                setRun({ log: run.log.concat([{ text, ok: false, detail: `skipped: ${why}` }]) });
                await sleep(getPaceMs('moves'));
                continue;
            }
        }
        // a refused or unconfirmed move is skipped and the plan carries on;
        // only Stop ends a run (the developer's decision, 2026-10-16)
        const r = await moveAnimal(m.id, m.to);
        if (!r.ok) {
            skipped++;
            error = `${text}: ${r.detail || 'the game refused the move'}`;
            setRun({ log: run.log.concat([{ text, ok: false, detail: `skipped: ${r.detail || 'refused'}` }]) });
            await sleep(getPaceMs('moves'));
            continue;
        }
        const ok = await waitConfirmed(m.id, m.to, CONFIRM_TIMEOUT_MS);
        if (!ok) {
            skipped++;
            error = `${text}: the game did not confirm the move.`;
            setRun({ log: run.log.concat([{ text, ok: false, detail: 'skipped: not confirmed' }]) });
            await sleep(getPaceMs('moves'));
            continue;
        }
        setRun({ done: run.done + 1, log: run.log.concat([{ text, ok: true }]) });
        await sleep(getPaceMs('moves'));
    }
    if (skipped) error = `${skipped} move${skipped === 1 ? '' : 's'} skipped; the last: ${error}`;
    const stopped = run.stopping;
    setRun({ running: false, stopping: false, current: null, error, finished: true });
    breadcrumb('kin_plan_end');
    // the board shows the error itself; keep a silent copy in the log
    if (error) reportError('mod', 'Kin plan stopped', error, { silent: true });
    return { ok: !error, detail: error || (stopped ? 'Stopped.' : ''), done: run.done };
}
