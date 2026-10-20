// Auto mode runtime (park HUD page): for every species the player put on
// Auto (Species board), on its schedule, works out Thin out (if chosen) and
// the species' Breeding programme with kinautocore.js and runs the moves
// one at a time like the board's Execute. Remembers what it did
// (kinautoledger.js, kept in the zoo's PZ2QoL data). Design:
// docs/DESIGN-autopilot.md section 16.
//
// With no species on Auto in this zoo it does nothing at all: no listeners,
// no timers, no scans, nothing saved. installAutopilot() only reads the
// zoo's data to learn whether a species is on.
//
// When a run is due it plans and runs by itself, in every park, Franchise
// included: turning Auto mode on for a species is the player's opt-in
// (developer, 2026-10-19; CLAUDE.md). One move at a time, each confirmed by
// the game, the game's gate before each.
import { getKinModel, onKin, requestKinScan, setKinAlertFilter } from '/js/mods/pz2qol/kin.js';
import { getPlanRun, onPlanRun, requestDestinations, requestSpeciesInfo, runPlan, stopPlan } from '/js/mods/pz2qol/kinmoves.js';
import { getUserData, onUserData, setUserData, userDataEpoch, userDataStatus } from '/js/mods/pz2qol/userstore.js';
import { getAssignments } from '/js/mods/pz2qol/kinassign.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { isCollective } from '/js/mods/pz2qol/kincore.js';
import { TRADE } from '/js/mods/pz2qol/kinboardcore.js';
import { RATIO_CHOICES, planProgrammeAsync } from '/js/mods/pz2qol/kinprogramme.js';
import { cpuOf, deepJob } from '/js/mods/pz2qol/kinprogdeep.js';
import { getPref } from '/js/mods/pz2qol/prefs.js';
import { TUNE_PREF } from '/js/mods/pz2qol/kinprogtune.js';
import {
    AUTO_LIMITS, calendarMonths, finishAutoRun, observeChanges, prepareAutoRun, programmeOptionsFor, speciesFingerprints,
} from '/js/mods/pz2qol/kinautocore.js';
import {
    emptyLedger, fitBudget, isManualAnimal, isPinnedAnimal, ledgerView, logAction, normalizeLedger, noteManualMoves, noteReversal,
    noteUndone, pruneLedger, resumeSpecies, setSpeciesSettings, settleAction, speciesOn, speciesSettings, togglePinAnimal, undoOf,
} from '/js/mods/pz2qol/kinautoledger.js';

const DATA_KEY = 'kinAuto';
const RATIO_STORE = 'kinRatio';     // the board's group make-up per species (kinboard.js)
const TICK_MS = 1000;
const SCAN_MS = 10000;
const SCAN_FAST_MS = 3000;
const SAVE_EVERY_MS = 30000;
const CAL_MS = 5000;                 // the park's calendar is read this often while on
const RATE_MS = 10000;               // game speed measured over at least this long
const GATE_TIMEOUT_MS = 4000;
const QUIET_MS = 30000;              // a run's half-done pairs are not news this long after it

const A = {
    installed: false,
    running: false,          // the runtime is started (a species on Auto in this zoo)
    ledger: null,
    ledgerEpoch: -1,         // the store read the ledger belongs to
    epoch: -1,
    model: null,
    cal: null,               // the park's calendar: { months, at, rate (months per ms), base }
    calAsking: false,
    monthSec: null,          // the game's month length at 1x (GetMonthDurationInSeconds)
    seen: null,
    expected: new Map(),     // id -> { to, until }
    prints: new Map(),       // species -> fingerprint
    queue: [],               // species waiting for their turn, in order (one run at a time)
    planning: null,          // species being planned
    acting: null,            // { species, step, total, text }
    pausedUntil: new Map(),  // species -> ms (refusals)
    quiet: new Map(),        // species -> ms: its new pairs are not alerted
    lastPlan: new Map(),     // species -> the last plan made (the panel's preview)
    session: 0,              // bumped by stop(): a plan or run of an older session (another zoo) ends
    changed: new Map(),      // species -> settings version: a plan made with older settings is dropped
    loadAt: 0,
    scans: 0,
    lastScan: 0,
    lastTick: 0,
    lastSave: 0,
    saveDirty: false,
    lastGate: null,
    timers: [],
    unsub: [],
    listeners: new Set(),
    toastHook: null,
};

function safe(fn, what) {
    try {
        return fn();
    }
    catch (e) {
        reportError('mod', `Auto mode: ${what}`, e, { silent: true });
        return undefined;
    }
}

function notify() {
    A.listeners.forEach(fn => safe(() => fn(), 'listener'));
}

export function onAutopilot(fn) {
    A.listeners.add(fn);
    return () => A.listeners.delete(fn);
}

// The UI module tells the runtime how to show its notices.
export function setAutopilotToastHook(fn) {
    A.toastHook = typeof fn === 'function' ? fn : null;
}

function toast(kind, data) {
    if (A.toastHook) safe(() => A.toastHook(kind, data), 'toast');
}

// ------------------------------------------------------------ the calendar

// The park's date from the gate's answer: the schedule counts its months
// (game time: it stops while paused, runs faster at 2x and 5x).
function noteGate(g) {
    if (!g) return;
    A.lastGate = g;
    if (typeof g.monthSec === 'number' && g.monthSec > 0) A.monthSec = g.monthSec;
    const m = calendarMonths(g);
    if (m == null) return;
    const now = Date.now();
    // first reading, or the date went back (another zoo): start afresh
    if (!A.cal || m < A.cal.months - 0.5) {
        A.cal = { months: m, at: now, rate: null, base: { m, at: now } };
        return;
    }
    A.cal.months = Math.max(A.cal.months, m);
    A.cal.at = now;
    if (now - A.cal.base.at >= RATE_MS) {
        A.cal.rate = Math.max(0, (m - A.cal.base.m) / (now - A.cal.base.at));
        A.cal.base = { m, at: now };
    }
}

// Calendar years (the park's months / 12): the holds and windows of the
// memory (kinautoledger.js) are counted in these.
function parkYears() {
    return A.cal ? A.cal.months / 12 : (A.ledger ? A.ledger.clock : 0);
}

// Months per real ms at the speed the game runs now (0 while paused), or
// the game's 1x month length until it is measured; null if neither.
function gameRate() {
    if (A.cal && A.cal.rate != null) return A.cal.rate;
    return A.monthSec ? 1 / (A.monthSec * 1000) : null;
}

// --------------------------------------------------------------- storage

// This zoo's data, only once the store has read this zoo's data ('file').
// Before that (a park loading, the hub, no player profile) the store may
// still hold the previous zoo's data: Auto mode is off then.
function storeReady() {
    return userDataStatus() === 'file';
}

function loadLedger() {
    A.ledgerEpoch = userDataEpoch();
    return storeReady() ? normalizeLedger(getUserData(DATA_KEY)) : emptyLedger();
}

// Only into the zoo the ledger was read from (never queued for later).
function saveLedger(force) {
    if (!A.ledger) return;
    if (!storeReady() || A.ledgerEpoch !== userDataEpoch()) {
        A.saveDirty = false;
        return;
    }
    if (!force && Date.now() - A.lastSave < SAVE_EVERY_MS) {
        A.saveDirty = true;
        return;
    }
    A.lastSave = Date.now();
    A.saveDirty = false;
    safe(() => {
        fitBudget(A.ledger);
        setUserData(DATA_KEY, JSON.parse(JSON.stringify(A.ledger)));
    }, 'save');
}

export function getAutopilotLedger() {
    return A.ledger;
}

function currentLedger() {
    if (!A.ledger || A.ledgerEpoch !== userDataEpoch()) A.ledger = loadLedger();
    return A.ledger;
}

// ---------------------------------------------------------------- state

function gameMode() {
    const m = A.model || getKinModel();
    return (m && m.mode) || 'unknown';
}

export function isAutopilotOn() {
    return speciesOn(A.ledger).length > 0;
}

// The whole of it, for the UI: { storage, running, mode, acting, planning,
// queue: [species], on: [species] }
export function getAutopilotState() {
    return {
        storage: userDataStatus(), running: A.running, mode: gameMode(),
        acting: A.acting, planning: A.planning, queue: A.queue.slice(), on: speciesOn(A.ledger),
        settling: A.running && !settled(),
        monthSec: A.monthSec, rate: gameRate(),
    };
}

// One species, for its panel and button:
// { settings, status, why, left (months of game time to the next run, null
//   before the calendar is read), rate (months per real ms, 0 paused),
//   pausedMs, queued (place in the queue, 1 = next), last, plan, log }
//   status: off | stopped | paused | acting | planning | queued | waiting | due
export function getSpeciesAuto(species) {
    const l = A.ledger && A.ledgerEpoch === userDataEpoch() ? A.ledger : null;
    const s = speciesSettings(l, species);
    const left = A.cal ? Math.max(0, (s.next || 0) - A.cal.months) : null;
    const out = { settings: s, status: 'off', why: '', left, rate: gameRate(), pausedMs: 0, last: s.last || null, plan: A.lastPlan.get(species) || null, log: [] };
    if (l) out.log = l.log.filter(e => e.sp === species);
    if (!s.on) return out;
    const paused = A.pausedUntil.get(species);
    if (l && l.stopped[species]) {
        out.status = 'stopped';
        out.why = l.stopped[species];
    }
    else if (A.acting && A.acting.species === species) out.status = 'acting';
    else if (A.planning === species) out.status = 'planning';
    else if (A.queue.includes(species)) {
        out.status = 'queued';
        out.queued = A.queue.indexOf(species) + 1;
        out.why = A.running ? (blockedNow() || speciesBlocked(species) || (A.planning || A.acting ? 'another species is running' : '')) : '';
    }
    else if (paused && Date.now() < paused) {
        out.status = 'paused';
        out.why = 'the game refused several moves; it tries again later';
        out.pausedMs = paused - Date.now();
    }
    else if (A.running && !A.cal) {
        out.status = 'due';
        out.why = 'reading the park\'s calendar';
    }
    else if (left > 0) out.status = 'waiting';
    else {
        out.status = 'due';
        out.why = A.running ? (blockedNow() || speciesBlocked(species)) : 'starting';
    }
    return out;
}

// ------------------------------------------------------------- settings

// Changes a species' Auto settings ({ on, every, step, trade, thin, fill }).
// -> false when the zoo's data can't be kept (Auto mode can't be turned on).
export function setSpeciesAuto(species, patch) {
    if (!storeReady()) return false;
    const l = currentLedger();
    const wasOn = !!(l.sp[species] && l.sp[species].on);
    setSpeciesSettings(l, species, patch || {}, A.cal ? A.cal.months : null);
    bump(species);
    if (patch && patch.on === false) {
        dequeue(species);
        A.lastPlan.delete(species);
        const run = getPlanRun();
        if (A.acting && A.acting.species === species && run.running && run.owner === 'autopilot') stopPlan();
    }
    if (!wasOn && l.sp[species].on) breadcrumb('auto_species_on');
    else if (wasOn && !l.sp[species].on) breadcrumb('auto_species_off');
    saveLedger(true);
    sync();
    notify();
    return true;
}

function bump(species) {
    A.changed.set(species, (A.changed.get(species) || 0) + 1);
}

// The board's make-up for the species changed (kinautoui.js): a plan made
// with the old one is dropped.
export function speciesChoicesChanged(species) {
    bump(species);
    notify();
}

export function resumeSpeciesAuto(species) {
    const l = currentLedger();
    resumeSpecies(l, species);
    A.pausedUntil.delete(species);
    saveLedger(true);
    sync();
    notify();
}

// Start or stop the runtime as the zoo's data says.
function sync() {
    const want = storeReady() && A.ledgerEpoch === userDataEpoch() && isAutopilotOn();
    if (want && !A.running) start();
    else if (!want && A.running) stop();
}

function start() {
    if (A.running) return;
    A.running = true;
    A.loadAt = Date.now();
    A.lastTick = Date.now();
    A.scans = 0;
    A.seen = null;
    A.cal = null;
    A.unsub.push(onKin((model, scope) => {
        if (scope && scope !== 'park') return;
        safe(() => onModel(model), 'model');
    }));
    A.unsub.push(onPlanRun(() => notify()));
    A.timers.push(setInterval(() => safe(tick, 'tick'), TICK_MS));
    loadBoard().catch(() => {});
    setKinAlertFilter(p => {
        const until = A.quiet.get(p.species);
        return until != null && Date.now() < until;
    });
    requestKinScan('auto_start', { force: true, delay: 200 });
}

function stop() {
    A.running = false;
    A.session++;
    // a run of ours still going belongs to the zoo that ended: stopped
    const run = getPlanRun();
    if (run.running && run.owner === 'autopilot') safe(() => stopPlan(), 'stop run');
    for (const t of A.timers) clearInterval(t);
    A.timers = [];
    for (const fn of A.unsub) safe(fn, 'unsubscribe');
    A.unsub = [];
    setKinAlertFilter(null);
    A.quiet.clear();
    A.prints.clear();
    A.expected.clear();
    A.pausedUntil.clear();
    A.queue = [];
    A.acting = null;
    A.planning = null;
    // nothing of the old zoo is used again (a new zoo's model and gate come fresh)
    A.model = null;
    A.lastGate = null;
    A.seen = null;
    A.cal = null;
    A.calAsking = false;
}

// A plan or run started now is still wanted later (same session, same zoo
// data, same ledger).
function stillHere() {
    const sess = A.session, epoch = userDataEpoch(), led = A.ledger;
    return () => A.running && A.session === sess && userDataEpoch() === epoch && A.ledger === led && storeReady();
}

// ------------------------------------------------------------- watching

function settled() {
    return A.scans >= AUTO_LIMITS.settleScans && Date.now() - A.loadAt >= AUTO_LIMITS.settleMs;
}

function onModel(model) {
    if (!model || model.scope !== 'park') {
        A.model = null;
        A.seen = null;
        return;
    }
    // another zoo load (or a store read pending): the ledger may belong to
    // another zoo; checkZoo() decides again once this zoo's data is read
    if (A.ledgerEpoch !== userDataEpoch() || !storeReady()) {
        checkZoo();
        return;
    }
    if (A.epoch !== userDataEpoch()) {
        // a new zoo load: entity ids are new, start watching afresh
        A.epoch = userDataEpoch();
        A.loadAt = Date.now();
        A.scans = 0;
        A.seen = null;
        A.expected.clear();
            A.lastPlan.clear();
        A.cal = null;
    }
    A.model = model;
    A.scans++;
    A.lastScan = Date.now();
    const l = A.ledger;
    if (A.cal) l.clock = parkYears();
    const now = Date.now();
    for (const [id, e] of A.expected) {
        const a = model.animals.get(id);
        if (now > e.until && !(a && a.moving)) A.expected.delete(id);
    }
    // what changed that Auto mode did not do
    const first = !A.seen;
    const obs = observeChanges(A.seen || {}, model, A.expected);
    A.seen = obs.seen;
    // arrived where Auto mode sent it: no longer expected
    for (const [id, e] of A.expected) {
        const a = model.animals.get(id);
        if (!a || a.moving) continue;
        const here = a.hab || (a.lt === 'trade' ? TRADE : '');
        if (here === String(e.to)) A.expected.delete(id);
    }
    if (!first && obs.moved.length) {
        noteManualMoves(l, model, obs.moved, parkYears());
        A.saveDirty = true;
        breadcrumb('auto_manual_move');
    }
    pruneLedger(l, model, parkYears());
    A.prints = speciesFingerprints(model);
    if (A.saveDirty) saveLedger(false);
    notify();
}

// ------------------------------------------------------------- deciding

let boardModule = null;
function loadBoard() {
    if (boardModule) return Promise.resolve(boardModule);
    return import('/js/mods/pz2qol/kinboard.js').then(m => (boardModule = m));
}

// The player is working on this species on the board (a staged plan with
// its animals, its Breeding programme or Thin out open, a drag, a Move now)
function boardBusy(species) {
    try {
        return !!(boardModule && boardModule.isBoardBusy && boardModule.isBoardBusy(species));
    }
    catch (e) {
        return false;
    }
}

function popupOpen() {
    try {
        return !!document.querySelector('.PopupActionsModule_root.show');
    }
    catch (e) {
        return false;
    }
}

// Why nothing can start now ('' = it can).
function blockedNow() {
    if (!A.running) return 'off';
    if (!A.model) return 'no park';
    if (!settled()) return 'the zoo just loaded: watching it for a minute first';
    if (getPlanRun().running) return 'a plan is running';
    if (popupOpen()) return 'a game window is open';
    return '';
}

function speciesBlocked(species) {
    const model = A.model;
    if (!model) return 'no park';
    if (Array.from(model.animals.values()).some(a => a.species === species && a.moving)) return 'some of them are on the move';
    if (boardBusy(species)) return 'you are planning this species on the board';
    const dj = safe(() => deepJob(), 'deep job');
    if (dj && dj.species === species) return 'a deep search of this species is running';
    return '';
}

// ----------------------------------------------------------------- queue
// One run at a time: species whose turn has come wait in a queue, in the
// order they came due, and run one after another. Nothing is skipped or
// asked for again while another run (Auto mode's or the board's) goes on;
// a species that can't run just now (its animals on the move, the player
// planning it on the board) lets the next one go first and keeps its place.

function enqueue(species, front = false) {
    if (A.queue.includes(species)) {
        if (!front) return;
        dequeue(species);
    }
    if (front) A.queue.unshift(species);
    else A.queue.push(species);
}

function dequeue(species) {
    A.queue = A.queue.filter(x => x !== species);
}

// Every species whose run is due joins the queue (once).
function queueDue() {
    const l = A.ledger;
    if (!A.cal || !l) return;
    const now = Date.now();
    for (const sp of speciesOn(l)) {
        if ((l.sp[sp].next || 0) > A.cal.months) continue;
        if (A.planning === sp || (A.acting && A.acting.species === sp)) continue;
        const p = A.pausedUntil.get(sp);
        if (p && now < p) continue;
        if (A.model && isCollective(A.model, sp)) continue;
        enqueue(sp);
    }
}

// The next species that can run now (it leaves the queue), or null.
function takeNext() {
    const l = A.ledger;
    for (const sp of A.queue) {
        if (!l || !l.sp[sp] || !l.sp[sp].on || l.stopped[sp]) {
            dequeue(sp);
            return takeNext();
        }
        if (speciesBlocked(sp)) continue;
        dequeue(sp);
        return sp;
    }
    return null;
}

function tradeFree(model) {
    // the game's own numbers (PZ2QoL_AutoGate), else unknown (a send to a
    // full centre is refused and skipped)
    const g = A.lastGate;
    if (g && typeof g.tcMax === 'number' && typeof g.tcCount === 'number') return Math.max(0, g.tcMax - g.tcCount);
    return null;
}

function ratioOf(species) {
    const all = getUserData(RATIO_STORE);
    const v = all && typeof all === 'object' && !Array.isArray(all) ? all[species] : null;
    return RATIO_CHOICES.includes(v) ? v : 'auto';
}

// The habitats the game should describe for the species (as the board asks).
function habitatsFor(model, species, dest) {
    const habs = new Set();
    for (const a of model.animals.values()) if (a.species === species && a.hab) habs.add(a.hab);
    const d = dest && dest.bySpecies && dest.bySpecies[species];
    if (d) for (const [h, v] of Object.entries(d)) if (v && v.ok) habs.add(String(h));
    for (const [h, set] of getAssignments(model)) if (set && set.has(species)) habs.add(String(h));
    return Array.from(habs);
}

// One species' plan for the zoo as it is now (null: cancelled).
async function makePlan(species) {
    const here = stillHere();
    const version = A.changed.get(species) || 0;
    const fresh = () => here() && (A.changed.get(species) || 0) === version;
    const model = A.model;
    if (!model) return null;
    const ids = [];
    for (const a of model.animals.values()) if (a.species === species && !a.exhibit) ids.push(a.id);
    const dest = await requestDestinations(ids);
    const info0 = await requestSpeciesInfo(species, habitatsFor(A.model || model, species, dest));
    const info = info0 && !info0.error ? info0 : null;
    const gate = await askGate();
    if (!fresh()) return null;
    noteGate(gate);
    const cur = A.model;
    const l = A.ledger;
    if (!cur || !l || !l.sp[species] || !l.sp[species].on) return null;
    const settings = l.sp[species];
    const ratio = ratioOf(species);
    const assignments = getAssignments(cur);
    const view = ledgerView(l, cur, parkYears(), Date.now());
    const input = { model: cur, species, info, destinations: dest, assignments, settings, ratio, view, tradeFree: tradeFree(cur) };
    // Thin out first, then the programme on the zoo as it leaves it
    const prep = prepareAutoRun(input);
    const cpu = safe(() => cpuOf(), 'cpu') || { sliceMs: 16, restMs: 16 };
    const fp = A.prints.get(species);
    const r = await planProgrammeAsync(prep.model, species, info || {}, dest, {
        assignments,
        options: programmeOptionsFor(prep.settings, ratio, prep.pins, getPref(TUNE_PREF)),
        sliceMs: cpu.sliceMs,
        restMs: cpu.restMs,
        isCancelled: () => !fresh() || !A.ledger.sp[species] || !A.ledger.sp[species].on,
    });
    // another zoo, the species turned off, or its settings changed meanwhile:
    // this plan is not used (the next tick plans again)
    if (!fresh() || !A.ledger.sp[species] || !A.ledger.sp[species].on) return null;
    const plan = finishAutoRun(input, prep, r);
    plan.fp = fp;
    plan.session = A.session;
    plan.at = Date.now();
    plan.destinations = dest;
    A.lastPlan.set(species, plan);
    return plan;
}

async function planOne(species) {
    A.planning = species;
    notify();
    try {
        const plan = await makePlan(species);
        if (!plan || plan.session !== A.session) return;
        if (!plan.moves.length) {
            finishRun(species, { moves: 0, skipped: 0, note: 'nothing to change', notes: plan.notes });
            return;
        }
        A.planning = null;
        await startRun([plan], 'auto');
    }
    catch (e) {
        reportError('mod', `Auto mode: planning ${species} failed`, e, { silent: true });
        A.pausedUntil.set(species, Date.now() + AUTO_LIMITS.pauseAfterSkipsMs);
    }
    finally {
        if (A.planning === species) A.planning = null;
        notify();
    }
}

function tick() {
    if (!A.running) return;
    const now = Date.now();
    A.lastTick = now;
    // fresher scans while on (kin.js keeps its own gap between requests)
    const gap = A.acting ? SCAN_FAST_MS : SCAN_MS;
    if (now - A.lastScan >= gap) requestKinScan('auto');
    const l = A.ledger;
    if (!l || !A.model) return;
    // the park's calendar (the schedule is game time)
    if (!A.calAsking && (!A.cal || now - A.cal.at >= CAL_MS)) {
        A.calAsking = true;
        const sess = A.session;
        askGate().then(g => {
            A.calAsking = false;
            if (A.session === sess) noteGate(g);
        }, () => {
            A.calAsking = false;
        });
    }
    if (A.saveDirty) saveLedger(false);
    queueDue();
    if (blockedNow() || A.planning || A.acting) return;
    const sp = takeNext();
    if (sp) planOne(sp);
}

// Run now on the board: this species goes to the front of the queue and
// runs as soon as nothing else is running (at once if nothing is).
// -> 'now', 'queued', or why it can't.
export function runSpeciesNow(species) {
    if (!A.running) return 'Auto mode is off for this species';
    const l = A.ledger;
    if (!l || !l.sp[species] || !l.sp[species].on) return 'Auto mode is off for this species';
    if (l.stopped[species]) return 'Auto mode stopped for this species: hand it back first';
    if (A.model && isCollective(A.model, species)) return 'Auto mode does not manage shoals and colonies';
    if (A.planning === species || (A.acting && A.acting.species === species)) return 'now';
    A.pausedUntil.delete(species);
    enqueue(species, true);
    const busy = !!(A.planning || A.acting || blockedNow().replace(/^the zoo just loaded.*/, '') || speciesBlocked(species));
    if (!busy) {
        dequeue(species);
        planOne(species);
    }
    notify();
    return busy ? 'queued' : 'now';
}

// A run is over (or there was nothing to do): the next one on schedule.
function finishRun(species, { moves, skipped, note, notes = [] }) {
    const l = A.ledger;
    if (!l || !l.sp[species]) return;
    const s = l.sp[species];
    s.next = (A.cal ? A.cal.months : 0) + s.every;
    s.last = { real: Date.now(), run: l.run, moves, skipped, note: note || '' };
    // what the run could not do (trade centre full, no unrelated partner)
    if (notes.length) s.last.notes = notes.slice(0, 3).map(t => String(t).slice(0, 160));
    if (skipped >= AUTO_LIMITS.skipsToPause) A.pausedUntil.set(species, Date.now() + AUTO_LIMITS.pauseAfterSkipsMs);
    saveLedger(true);
    if (moves || skipped) toast('done', { species, moves, skipped });
}

// ---------------------------------------------------------------- acting

const sleep = ms => new Promise(r => setTimeout(r, ms));

let gateSeq = 0;
const gateWaiting = new Map();
let gateInstalled = false;

function askGate() {
    if (typeof engine === 'undefined') return Promise.resolve(null);
    if (!gateInstalled) {
        gateInstalled = true;
        engine.on('PZ2QoL_AutoGateResult', (reqId, json) => {
            const done = gateWaiting.get(String(reqId));
            if (!done) return;
            gateWaiting.delete(String(reqId));
            let v = null;
            try {
                v = JSON.parse(json);
            }
            catch (e) {
                v = null;
            }
            done(v);
        });
    }
    const id = 'G' + (++gateSeq);
    return new Promise(resolve => {
        const t = setTimeout(() => {
            if (gateWaiting.delete(id)) resolve(null);
        }, GATE_TIMEOUT_MS);
        gateWaiting.set(id, v => {
            clearTimeout(t);
            resolve(v);
        });
        try {
            engine.trigger('PZ2QoL_AutoGate', id);
        }
        catch (e) {
            gateWaiting.delete(id);
            clearTimeout(t);
            resolve(null);
        }
    });
}

// The game's side: '' to go on, or why not now. Waits while a Franchise
// server request is in flight (as the lister does).
async function gameGate() {
    if (popupOpen()) await sleep(1500);
    let modeWaits = 0;
    for (let i = 0; i < 10; i++) {
        const g = await askGate();
        noteGate(g);
        if (!g) return '';                       // older Lua side: the game's own checks still apply
        if (g.park === false) return 'no park is loaded';
        if (g.move === false) return 'the game does not allow moving animals right now';
        // the player may be placing animals with the game's Move screen; the
        // mode name is only a hint (it is not reset when a park ends), so
        // wait a little, then go on
        if (g.uiMode === 'AnimalMovementMode' && modeWaits < 3) {
            modeWaits++;
            await sleep(2000);
            continue;
        }
        if (g.dbBusy === true) {
            await sleep(1000);
            continue;
        }
        return '';
    }
    return 'the game stayed busy';
}

async function startRun(plans, how) {
    if (A.acting) return;
    const l = A.ledger;
    const here = stillHere();
    A.acting = { species: plans[0] && plans[0].species, step: 0, total: 0, text: '' };
    breadcrumb('auto_run_start');
    notify();
    try {
        for (let plan of plans) {
            if (!plan || !here() || plan.session !== A.session) break;
            const species = plan.species;
            if (!l.sp[species] || !l.sp[species].on || l.stopped[species]) continue;
            // planned on an older zoo: planned again first
            if (A.prints.get(species) !== plan.fp) {
                A.acting = { species, step: 0, total: 0, text: 'Planning again with the zoo as it is now' };
                notify();
                plan = await makePlan(species);
                if (!plan || !here()) continue;
                if (!plan.moves.length) {
                    finishRun(species, { moves: 0, skipped: 0, note: 'nothing to change', notes: plan.notes });
                    continue;
                }
            }
            // the board started a run meanwhile: this species waits at the
            // front of the queue
            if (getPlanRun().running) {
                enqueue(species, true);
                break;
            }
            l.run = (l.run || 0) + 1;
            const run = l.run;
            const model = getKinModel() || A.model;
            // a move back to a habitat left recently: two of them and Auto
            // mode stops for the species instead of trading animals back and forth
            if (plan.moves.some(x => x.reversal) && noteReversal(l, species, parkYears())) {
                breadcrumb('auto_stopped');
                saveLedger(true);
                toast('stopped', { species });
                continue;
            }
            const entries = new Map();
            for (const x of plan.moves) {
                entries.set(x.id, logAction(l, model, x, { run, clock: parkYears(), realNow: Date.now(), species }));
                A.expected.set(String(x.id), { to: x.to, until: Date.now() + 60 * 60 * 1000 });
            }
            A.quiet.set(species, Infinity);
            A.acting = { species, step: 0, total: plan.moves.length, text: 'Moving animals, one at a time' };
            notify();
            const gated = new Map();
            const reached = new Set();   // the moves the run got to (Stop ends it early)
            const res = await runPlan(plan.moves.map(x => ({ id: x.id, to: x.to })), {
                destinations: plan.destinations, owner: 'autopilot',
                beforeEach: async m => {
                    if (!here()) {
                        // another zoo: nothing more of this plan
                        safe(() => stopPlan(), 'stop run');
                        gated.set(String(m.id), 'another zoo was loaded');
                        return 'another zoo was loaded';
                    }
                    if (!l.sp[species] || !l.sp[species].on) {
                        gated.set(String(m.id), 'Auto mode was turned off');
                        return 'Auto mode was turned off';
                    }
                    const why = await gameGate();
                    if (why) gated.set(String(m.id), why);
                    else reached.add(String(m.id));
                    return why;
                },
            });
            A.quiet.set(species, Date.now() + QUIET_MS);
            // the zoo changed under the run: its results belong to the old one
            if (!here()) break;
            // the run never started (the board's own run got there first)
            const notRun = res && res.ok === false && res.done == null;
            // what the game did: the scan shows each animal on its way or there
            const after = getKinModel();
            let moved = 0, skipped = 0;
            for (const x of plan.moves) {
                const a = after && after.animals.get(String(x.id));
                const id = String(x.id);
                const ok = !notRun && !!after && (x.to === TRADE ? (!a || a.moving || a.lt === 'trade') : !!a && (a.moving || a.hab === String(x.to)));
                const logRow = getPlanRun().log.find(row => row.text && a && row.text.indexOf(a.name) === 0 && !row.ok);
                // only a move the game itself refused counts against it later
                // (not one the run never got to: Stop, the run's own checks)
                const tried = reached.has(id);
                const why = notRun ? (res.detail || 'not run') : gated.get(id) || (tried ? (logRow && logRow.detail) || 'not confirmed' : (logRow && logRow.detail) || 'not run (stopped)');
                settleAction(l, entries.get(x.id), x, ok, { why: ok ? '' : why, clock: parkYears(), realNow: Date.now(), noFail: notRun || !tried });
                if (ok) moved++;
                else {
                    A.expected.delete(id);
                    if (tried) skipped++;
                }
            }
            if (notRun) {
                enqueue(species, true);
                break;
            }
            finishRun(species, { moves: moved, skipped, note: '', notes: plan.notes });
        }
    }
    catch (e) {
        reportError('mod', 'Auto mode: a run failed', e, { silent: true });
    }
    finally {
        A.acting = null;
        saveLedger(true);
        breadcrumb('auto_run_end');
        notify();
    }
}

// ----------------------------------------------------------------- undo

// Undo log entries (one move, or a whole run): each animal goes back where
// it came from, run like any player action. What it restores is left alone
// by Auto mode for a while.
export async function undoEntries(entries) {
    const model = getKinModel();
    if (!model || !A.ledger) return { ok: false, detail: 'No zoo data yet.' };
    if (getPlanRun().running || A.acting) return { ok: false, detail: 'A plan is running. Wait for it to finish.' };
    const moves = [];
    const why = [];
    const byId = new Map();
    for (const e of entries) {
        const u = undoOf(A.ledger, model, e);
        if (!u.action) {
            why.push(`${e.n}: ${u.why}`);
            continue;
        }
        moves.push(u.action);
        byId.set(String(u.action.id), e);
        A.expected.set(String(u.action.id), { to: u.action.to, until: Date.now() + 60 * 60 * 1000 });
    }
    let done = 0;
    if (moves.length) {
        const led = A.ledger;
        await runPlan(moves, { owner: 'undo', beforeEach: () => gameGate() });
        // only what the game did is undone (and then left where it is)
        const after = getKinModel();
        for (const m of moves) {
            const a = after && after.animals.get(String(m.id));
            const e = byId.get(String(m.id));
            if (a && (a.moving || a.hab === String(m.to) || (m.to === TRADE && a.lt === 'trade'))) {
                if (A.ledger === led) noteUndone(led, after, e, parkYears());
                done++;
            }
            else {
                A.expected.delete(String(m.id));
                why.push(`${e.n}: the game did not move it`);
            }
        }
    }
    saveLedger(true);
    requestKinScan('auto_undo', { force: true, delay: 300 });
    notify();
    return { ok: true, done, skipped: why };
}

// ---------------------------------------------------------------- pins

// "Auto: hands off" in the card menu: never moved by Auto mode.
export function toggleAutoPin(id) {
    if (!storeReady()) return false;
    const l = currentLedger();
    const on = togglePinAnimal(l, getKinModel(), id);
    saveLedger(true);
    notify();
    return on;
}

export function isAutoPinned(id) {
    return !!A.ledger && isPinnedAnimal(A.ledger, getKinModel(), id);
}

// Moved by the player lately: Auto mode leaves it where it is for a while.
export function isAutoHeld(id) {
    return !!A.ledger && isManualAnimal(A.ledger, getKinModel(), id, parkYears());
}

// --------------------------------------------------------------- install

// Which species are on Auto in the zoo whose data the store holds now?
// Runs on every store read (a park started or ended, a save loaded). Until
// this zoo's data is read, Auto mode is off: the previous zoo's never
// carries over.
function checkZoo() {
    safe(() => {
        const sameZoo = A.ledgerEpoch === userDataEpoch();
        if (!storeReady()) {
            if (A.running) stop();
            if (!sameZoo) A.ledger = null;
            A.ledgerEpoch = userDataEpoch();
            notify();
            return;
        }
        if (!(sameZoo && A.ledger)) {
            if (A.running) stop();
            A.ledger = loadLedger();
            A.epoch = -1;
            A.lastPlan.clear();
        }
        sync();
        notify();
    }, 'zoo');
}

export function installAutopilot() {
    if (A.installed) return true;
    A.installed = true;
    onUserData(checkZoo);
    checkZoo();
    return true;
}

// for the Node tests
export function _autopilotInternals() {
    return A;
}
