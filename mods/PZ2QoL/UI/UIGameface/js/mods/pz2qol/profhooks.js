// Script profiler: the page's JS timing (no DOM, no game imports, so
// node can test it: tests/profiler.test.mjs). Installed at page start
// (main.js, before the features register their handlers):
//  - engine.on: every handler registered from then on is wrapped (game UI
//    and PZ2QoL alike; the game's DataStore change callbacks, which drive
//    its data binding, are one row). engine.off with the caller's own
//    function still removes it (the wrapper is looked up);
//  - setInterval: always wrapped (few, labelled from the registration
//    stack); setTimeout and requestAnimationFrame only while profiling.
// A wrapper only times while J.on; otherwise it calls straight through.
// Errors pass through unchanged (try/finally).
import { createAgg, newStat, aggAdd, aggEndFrame, aggReport, stackLabel } from '/js/mods/pz2qol/profcore.js';

export const J = {
    on: false,
    agg: createAgg({ buckets: 4, perBucket: 30 }),
    stats: new Map(),       // key -> stat
    depth: 0,
    child: [],
    frameMs: 0,
    last: 0,
    loop: 0,
    installed: false,
    hooks: false,
    hookError: '',
};

let origSetTimeout = null;
let origSetInterval = null;
let origRAF = null;

function now() {
    try {
        return performance.now();
    }
    catch (e) {
        return Date.now();
    }
}

function statFor(key, name, group) {
    let s = J.stats.get(key);
    if (!s) {
        s = newStat(name, group);
        J.stats.set(key, s);
    }
    return s;
}

// fn.apply with timing while on; errors pass through unchanged
function timed(s, fn, self, args) {
    if (!J.on) return fn.apply(self, args);
    const d = ++J.depth;
    J.child[d] = 0;
    const t0 = now();
    try {
        return fn.apply(self, args);
    }
    finally {
        const el = now() - t0;
        J.depth = d - 1;
        if (J.on) {
            if (d > 1) J.child[d - 1] = (J.child[d - 1] || 0) + el;
            else J.frameMs += el;
            try {
                aggAdd(J.agg, s, el, el - (J.child[d] || 0));
            }
            catch (e) {
                // timing only
            }
        }
    }
}

function where() {
    try {
        return stackLabel(new Error().stack);
    }
    catch (e) {
        return null;
    }
}

function labelFor(kind, what, fn, loc) {
    const fnName = (loc && loc.fn) || (fn && fn.name) || '';
    const file = loc ? loc.file : '';
    const mod = !!(loc && loc.mod);
    const tail = [file, fnName].filter(Boolean).join(' ');
    return {
        key: `${kind}|${what}|${mod ? 'm' : 'g'}|${tail}`,
        name: `${kind}${what ? ' ' + what : ''}${tail ? ` (${tail})` : ''}`,
        group: mod ? 'js-mod' : 'js-game',
    };
}

// engine.on / engine.off: handlers are wrapped from page start, so a
// handler that was added can still be removed with the function the caller
// holds (the wrapper is looked up).
const wrapped = new WeakMap(); // fn -> Map(name -> [wrapper, ...])

function remember(fn, name, w) {
    let m = wrapped.get(fn);
    if (!m) {
        m = new Map();
        wrapped.set(fn, m);
    }
    const list = m.get(name) || [];
    list.push(w);
    m.set(name, list);
}

function takeWrapper(fn, name) {
    const m = wrapped.get(fn);
    if (!m) return null;
    const list = m.get(name);
    if (!list || !list.length) return null;
    const w = list.shift();
    if (!list.length) m.delete(name);
    return w;
}

function hookEngine() {
    if (typeof engine === 'undefined' || typeof engine.on !== 'function') return false;
    const on = engine.on;
    const off = engine.off;
    engine.on = function (name, cb, ctx) {
        if (typeof cb !== 'function') return on.call(this, name, cb, ctx);
        let label;
        try {
            if (/^DSCallID/.test(String(name))) {
                label = { key: 'ds', name: 'DataStore change callbacks (game UI data binding)', group: 'js-game' };
            }
            else {
                label = labelFor('on', String(name), cb, where());
            }
        }
        catch (e) {
            return on.call(this, name, cb, ctx);
        }
        const s = statFor(label.key, label.name, label.group);
        const w = function (...args) {
            return timed(s, cb, this, args);
        };
        remember(cb, name, w);
        return on.call(this, name, w, ctx);
    };
    if (typeof off === 'function') {
        engine.off = function (name, cb, ctx) {
            if (typeof cb === 'function') {
                const w = takeWrapper(cb, name);
                if (w) return off.call(this, name, w, ctx);
            }
            return off.call(this, name, cb, ctx);
        };
    }
    return true;
}

function hookTimers() {
    if (typeof window === 'undefined') return;
    origSetTimeout = window.setTimeout;
    origSetInterval = window.setInterval;
    origRAF = window.requestAnimationFrame;
    // intervals: few, mostly set at install time, so always labelled
    window.setInterval = function (cb, ms, ...rest) {
        if (typeof cb !== 'function') return origSetInterval.call(window, cb, ms, ...rest);
        const label = labelFor('interval', '', cb, where());
        const s = statFor(label.key, label.name, label.group);
        return origSetInterval.call(window, function (...args) {
            return timed(s, cb, this, args);
        }, ms, ...rest);
    };
    // timeouts and animation frames: only while profiling (many, short-lived)
    window.setTimeout = function (cb, ms, ...rest) {
        if (!J.on || typeof cb !== 'function') return origSetTimeout.call(window, cb, ms, ...rest);
        const label = labelFor('timeout', '', cb, where());
        const s = statFor(label.key, label.name, label.group);
        return origSetTimeout.call(window, function (...args) {
            return timed(s, cb, this, args);
        }, ms, ...rest);
    };
    if (typeof origRAF === 'function') {
        window.requestAnimationFrame = function (cb) {
            if (!J.on || typeof cb !== 'function') return origRAF.call(window, cb);
            const label = labelFor('frame callback', '', cb, where());
            const s = statFor(label.key, label.name, label.group);
            return origRAF.call(window, function (...args) {
                return timed(s, cb, this, args);
            });
        };
    }
}

// Returns whether the engine's handlers are hooked.
export function installJsHooks() {
    if (J.installed) return J.hooks;
    J.installed = true;
    try {
        hookTimers();
        J.hooks = hookEngine();
    }
    catch (e) {
        J.hookError = String(e && e.message || e);
    }
    return J.hooks;
}

export function origTimers() {
    return { setTimeout: origSetTimeout, setInterval: origSetInterval, requestAnimationFrame: origRAF };
}

export function jsReport(top = 80) {
    try {
        return aggReport(J.agg, top);
    }
    catch (e) {
        return { frames: 0, rows: [], groups: {} };
    }
}

// the page's own frames: requestAnimationFrame while on
function jsFrame() {
    if (!J.on) return;
    const t = now();
    if (J.last) aggEndFrame(J.agg, t - J.last, J.frameMs);
    J.frameMs = 0;
    J.depth = 0; // top of the event loop: nothing of ours is open
    J.last = t;
    const raf = origRAF || (typeof window !== 'undefined' && window.requestAnimationFrame);
    if (typeof raf === 'function') raf.call(window, jsFrame);
    else J.loop = (origSetTimeout || setTimeout)(jsFrame, 16);
}

export function jsStart(windowFrames) {
    J.agg = createAgg({ buckets: 4, perBucket: Math.max(5, Math.round(windowFrames / 4)) });
    for (const s of J.stats.values()) {
        s.ff = -1; s.fc = s.ft = s.fs = s.fm = 0;
        s.bg = []; s.bc = []; s.bt = []; s.bs = []; s.bm = []; s.bf = [];
        s.act = false;
    }
    J.on = true;
    J.last = 0;
    J.frameMs = 0;
    J.depth = 0;
    jsFrame();
}

export function jsStop() {
    J.on = false;
}

