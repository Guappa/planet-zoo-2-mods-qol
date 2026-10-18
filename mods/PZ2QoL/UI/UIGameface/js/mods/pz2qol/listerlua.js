// Market desk: the page side of the Lua listing engine (Main/pz2qol.lister.lua,
// docs/DESIGN-market-desk.md). The engine runs inside Animal Storage, works
// on animal GUIDs and calls the game's own listing function; this module
// asks what it can do, turns storage row keys into GUIDs, starts and stops
// runs, and keeps the engine's latest state for the panels.
import { breadcrumb } from '/js/mods/pz2qol/errors.js';
import { encodeSeen, normalizeState, readSeen } from '/js/mods/pz2qol/listercore.js';
import { get } from '/js/mods/pz2qol/game.js';

const ANSWER_TIMEOUT_MS = 2500;
const CAPS_MAX_AGE_MS = 4000;
const RESOLVE_BATCH = 250;
const WATCH_POLL_MS = 100;     // how often the page reports while the engine selects
const WATCH_MAX_MS = 60000;    // a watch the engine never ends stops by itself

let installed = false;
let reqSeq = 0;
// request ids unique per page load (a reloaded page must never take a
// running run's state for its own)
const PAGE = Math.random().toString(36).slice(2, 7);
const waiters = new Map();     // req -> resolve(answer)
let caps = null;               // the last capabilities answer
let capsAt = 0;
let capsAsking = null;         // the Hello in flight (asks are shared)
let state = null;              // the engine's latest state (normalizeState)
let ownRuns = new Set();       // reqs of runs this page started
const listeners = new Set();
const guidCache = new Map();   // row key -> { fp, guid }
let watch = null;              // { req, key, timer, since, reported }

function parse(json) {
    try {
        return typeof json === 'string' ? JSON.parse(json) : json;
    }
    catch (e) {
        return null;
    }
}

function install() {
    if (installed || typeof engine === 'undefined') return;
    installed = true;
    const answer = (req, json) => {
        const fn = waiters.get(String(req));
        if (!fn) return;
        waiters.delete(String(req));
        fn(parse(json));
    };
    engine.on('PZ2QoL_ListerCaps', answer);
    engine.on('PZ2QoL_ListerIds', answer);
    engine.on('PZ2QoL_ListerState', json => {
        const s = normalizeState(parse(json));
        if (!s) return;
        // a refused start (another run, storage closed) keeps the run shown
        if (!s.refused) state = s;
        // a run that ended: nothing more to watch
        if (!s.refused && s.phase !== 'running') stopWatch();
        notify(s);
    });
    engine.on('PZ2QoL_ListerWatch', (req, key) => startWatch(req, key));
}

// The engine's selection watch (pz2qol.lister.lua _Watch): while it selects
// an animal, report what this page's DataStore shows for it every 100 ms
// (PZ2QoL_ListerSeen). Read only; nothing is sent to the game but the report.
function startWatch(req, key) {
    req = String(req == undefined ? '' : req);
    key = String(key == undefined ? '' : key);
    if (!req || !key) {
        stopWatch();
        return;
    }
    if (watch && watch.req === req && watch.key === key) {
        watch.since = Date.now();   // asked again: keep going
        return;
    }
    stopWatch(true);
    breadcrumb('lister_watch');
    watch = { req, key, since: Date.now(), reported: false, timer: null };
    reportSeen();
    if (watch) watch.timer = setInterval(reportSeen, WATCH_POLL_MS);
}

function stopWatch(quiet = false) {
    if (!watch) return;
    clearInterval(watch.timer);
    watch = null;
    if (!quiet) breadcrumb('lister_watch_end');
}

function reportSeen() {
    const w = watch;
    if (!w) return;
    if (Date.now() - w.since > WATCH_MAX_MS) {
        stopWatch();
        return;
    }
    try {
        engine.trigger('PZ2QoL_ListerSeen', w.req, encodeSeen(readSeen(w.key, get)));
        if (!w.reported) {
            w.reported = true;
            breadcrumb('lister_seen');
        }
    }
    catch (e) {
        stopWatch();
    }
}

function notify(s = state) {
    listeners.forEach(fn => {
        try {
            fn(s);
        }
        catch (e) {
            // a listener never breaks the engine view
        }
    });
}

function ask(event, args, timeoutMs = ANSWER_TIMEOUT_MS) {
    install();
    if (typeof engine === 'undefined') return Promise.resolve(null);
    const req = `L${PAGE}_${++reqSeq}`;
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            waiters.delete(req);
            resolve(null);
        }, timeoutMs);
        waiters.set(req, v => {
            clearTimeout(timer);
            resolve(v);
        });
        try {
            engine.trigger(event, req, ...args);
        }
        catch (e) {
            clearTimeout(timer);
            waiters.delete(req);
            resolve(null);
        }
    });
}

// What the Lua side can do: { ok, missing, storage, online, rows, running }
// or { ok: false, reason: 'noanswer' } (an older Main.ovl, or no storage).
// maxAgeMs: an answer younger than this is used as it is.
export function engineCaps({ force = false, maxAgeMs = CAPS_MAX_AGE_MS } = {}) {
    if (!force && caps && Date.now() - capsAt < maxAgeMs) return Promise.resolve(caps);
    if (capsAsking) return capsAsking;
    capsAsking = ask('PZ2QoL_ListerHello', []).then(c => {
        const was = caps && caps.ok;
        caps = c && typeof c === 'object' ? c : { ok: false, reason: 'noanswer' };
        capsAt = Date.now();
        capsAsking = null;
        if (was !== caps.ok) breadcrumb(caps.ok ? 'lister_engine_ok' : 'lister_engine_off');
        return caps;
    });
    return capsAsking;
}

export function lastCaps() {
    return caps;
}

// How old the last answer is (Infinity: none yet).
export function capsAgeMs() {
    return caps ? Date.now() - capsAt : Infinity;
}

// Whether runs go through the engine. pageRows: how many storage rows the
// page sees; when it sees some and Lua reads none, Lua cannot read the list.
export function engineUsable(c, pageRows = 0) {
    if (!c || !c.ok || c.storage === false) return false;
    if (pageRows > 0 && !(c.rows > 0)) return false;
    return true;
}

export function engineWhyNot(c, pageRows = 0) {
    if (!c || c.reason === 'noanswer') return "The mod's game-side listing engine did not answer (an older Main.ovl?).";
    if (Array.isArray(c.missing) && c.missing.length) return `This game version lacks ${c.missing.join(', ')}.`;
    if (c.storage === false) return 'Animal Storage is not open on the game side.';
    if (pageRows > 0 && !(c.rows > 0)) return "The game-side engine cannot read the storage list.";
    return '';
}

// Row keys -> GUID strings, cached while the row's content stays the same
// (keys are positions: a rebuilt list gives a key another animal). Lua sends
// what each row held when it read the GUID; a GUID is kept only if that is
// still the animal the page read (else the list changed in between).
// rows: [{ key, fp, name, species, gender }]. Returns Map key -> guid.
export async function resolveGuids(rows) {
    const out = new Map();
    const need = [];
    for (const r of rows) {
        const c = guidCache.get(r.key);
        if (c && c.fp === r.fp) out.set(r.key, c.guid);
        else need.push(r);
    }
    for (let i = 0; i < need.length; i += RESOLVE_BATCH) {
        const batch = need.slice(i, i + RESOLVE_BATCH);
        const ans = await ask('PZ2QoL_ListerResolve', [batch.map(r => r.key).join(',')]);
        const ids = ans && ans.ids && typeof ans.ids === 'object' ? ans.ids : null;
        if (!ids) break;
        const held = ans.rows && typeof ans.rows === 'object' ? ans.rows : {};
        for (const r of batch) {
            const g = ids[r.key];
            if (g == undefined || g === '') continue;
            const h = held[r.key];
            if (!h || h.name !== r.name || h.species !== r.species || Number(h.gender) !== Number(r.gender)) {
                breadcrumb('lister_resolve_mismatch');
                continue;
            }
            const guid = String(g);
            guidCache.set(r.key, { fp: r.fp, guid });
            out.set(r.key, guid);
        }
    }
    return out;
}

export function forgetGuids() {
    guidCache.clear();
}

// Starts a run (the job text from encodeJob). Resolves { ok, message } once
// the engine reports the run (ok) or refused it, or did not answer.
export function startEngineRun(text) {
    install();
    if (typeof engine === 'undefined') return Promise.resolve({ ok: false, message: 'No game-side engine.' });
    const req = `R${PAGE}_${++reqSeq}`;
    ownRuns.add(req);
    breadcrumb('lister_engine_start');
    return new Promise(resolve => {
        let done = false;
        const off = onEngineState(s => {
            if (done || !s || s.req !== req) return;
            done = true;
            off();
            clearTimeout(timer);
            const ok = !s.refused && (s.phase === 'running' || s.total > 0);
            resolve({ ok, message: ok ? '' : s.message || 'The engine refused the run.' });
        });
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            off();
            resolve({ ok: false, message: 'The game-side engine did not answer.' });
        }, ANSWER_TIMEOUT_MS * 2);
        try {
            engine.trigger('PZ2QoL_ListerStart', req, text);
        }
        catch (e) {
            done = true;
            off();
            clearTimeout(timer);
            resolve({ ok: false, message: String(e && e.message) });
        }
    });
}

export function stopEngineRun() {
    install();
    breadcrumb('lister_engine_stop');
    try {
        engine.trigger('PZ2QoL_ListerStop');
    }
    catch (e) {
        // no engine: nothing runs
    }
}

export function setEnginePace(ms) {
    install();
    try {
        engine.trigger('PZ2QoL_ListerPace', Math.max(1000, Math.round(ms)));
    }
    catch (e) {
        // applied to the next run
    }
}

export function getEngineState() {
    return state;
}

export function engineRunning() {
    return !!state && state.phase === 'running';
}

// Whether the current state belongs to a run this page started.
export function isOwnRun(s = state) {
    return !!s && ownRuns.has(String(s.req));
}

export function onEngineState(fn) {
    install();
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// test hook
export function _resetEngineForTests() {
    caps = null;
    capsAt = 0;
    capsAsking = null;
    state = null;
    ownRuns = new Set();
    guidCache.clear();
    waiters.clear();
    stopWatch(true);
}
