// Species board: talking to the game about moves.
//
//  - requestDestinations(ids): which habitats each species may move to, by
//    the game's own checks (PZ2QoL.Kin on the Lua side).
//  - moveAnimal(id, to): ONE move, exactly what the game's own Move does
//    (a keeper boxes the animal and carries it). One click, one move.
//  - runPlan(plan): a staged plan, started by one click, run ONE move at a
//    time: send it, wait for the game to confirm it (the animal gets a
//    transport job), pause, then the next. It stops at the first refusal or
//    when the game does not confirm, and on Stop. In Franchise (or when the
//    mode is not known) it only runs with the player's explicit opt-in
//    (allowPlansOnline, off by default).
import { getKinModel, getKinSettings, onKin, requestKinScan } from '/js/mods/pz2qol/kin.js';
import { prunePlan, moveText, TRADE } from '/js/mods/pz2qol/kinboardcore.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';

const ANSWER_TIMEOUT_MS = 6000;
const CONFIRM_TIMEOUT_MS = 12000;
const GAP_MS = 1500;
const DEST_CACHE_MS = 30000;

let reqSeq = 0;
const waiting = new Map(); // reqId -> resolve
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

// ------------------------------------------------------------------ moves

// One move, one click. Resolves { ok, detail }.
export async function moveAnimal(id, to) {
    const model = getKinModel();
    const a = model && model.animals.get(String(id));
    if (!a) return { ok: false, detail: 'This animal is no longer in the zoo.' };
    let target = String(to);
    if (to === TRADE) {
        const tc = (lastDest && lastDest.tradeCentre) || model.tradeCentre;
        if (!tc) return { ok: false, detail: 'There is no trade centre.' };
        target = 'trade:' + tc.id;
    }
    breadcrumb('kin_move');
    const r = await ask('PZ2QoL_KinMove', { ok: false, detail: 'The game did not answer.' }, String(id), target);
    requestKinScan('move', { force: true, delay: 300 });
    return r;
}

// Waits until the kin data shows the animal on its way (or there).
function waitConfirmed(id, to, timeoutMs) {
    const confirmed = model => {
        const a = model && model.animals.get(String(id));
        if (!a) return false;
        if (a.moving) return true;
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
    if (model.mode !== 'offline' && !getKinSettings().allowPlansOnline) {
        return model.mode === 'franchise'
            ? 'This is a Franchise zoo: running a whole plan is off unless you allow it in the settings. You can still move animals one at a time.'
            : 'Running a whole plan is off until you allow it in the settings (the game mode is not known). You can still move animals one at a time.';
    }
    return '';
}

export function stopPlan() {
    if (run.running) setRun({ stopping: true });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs a plan: one move at a time, each confirmed by the game.
export async function runPlan(plan, { destinations } = {}) {
    const blocked = planBlockedReason();
    if (blocked) return { ok: false, detail: blocked };
    const moves = prunePlan(getKinModel(), plan);
    if (!moves.length) return { ok: false, detail: 'Nothing to move.' };
    setRun({ running: true, stopping: false, done: 0, total: moves.length, current: null, log: [], error: null, finished: false });
    breadcrumb('kin_plan_start');
    let error = null;
    for (const m of moves) {
        if (run.stopping) break;
        const model = getKinModel();
        const still = prunePlan(model, [m]);
        const text = moveText(model, m, destinations);
        if (!still.length) {
            setRun({ log: run.log.concat([{ text, ok: false, detail: 'skipped: it can no longer move (or is already there)' }]) });
            continue;
        }
        setRun({ current: text });
        const r = await moveAnimal(m.id, m.to);
        if (!r.ok) {
            error = `${text}: ${r.detail || 'the game refused the move'}`;
            setRun({ log: run.log.concat([{ text, ok: false, detail: r.detail }]) });
            break;
        }
        const ok = await waitConfirmed(m.id, m.to, CONFIRM_TIMEOUT_MS);
        if (!ok) {
            error = `${text}: the game did not confirm the move. Stopped to be safe.`;
            setRun({ log: run.log.concat([{ text, ok: false, detail: 'not confirmed' }]) });
            break;
        }
        setRun({ done: run.done + 1, log: run.log.concat([{ text, ok: true }]) });
        await sleep(GAP_MS);
    }
    const stopped = run.stopping;
    setRun({ running: false, stopping: false, current: null, error, finished: true });
    breadcrumb('kin_plan_end');
    // the board shows the error itself; keep a silent copy in the log
    if (error) reportError('mod', 'Kin plan stopped', error, { silent: true });
    return { ok: !error, detail: error || (stopped ? 'Stopped.' : ''), done: run.done };
}
