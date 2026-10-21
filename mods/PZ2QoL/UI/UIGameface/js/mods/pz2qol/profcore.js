// Script profiler: the pure parts (no DOM, no engine), node-tested in
// tests/profiler.test.mjs.
//
//  - the JS side's aggregation, the same rolling-bucket maths as Lua's
//    PZ2QoL.ProfCore (per stat: calls, total, self, slowest call, worst
//    frame, over the last buckets x perBucket frames);
//  - merging Lua's report with the JS one, sorting, filtering, formatting;
//  - the frame summary (wall, Lua, JS, the rest) and the frame strip;
//  - a label for a callback from the stack where it was registered.

export const GROUPS = {
    manager: { label: 'Managers', src: 'lua' },
    component: { label: 'Components', src: 'lua' },
    mode: { label: 'Modes', src: 'lua' },
    ui: { label: 'Game UI (Lua)', src: 'lua' },
    hub: { label: 'Hub screens', src: 'lua' },
    objective: { label: 'Objectives', src: 'lua' },
    world: { label: 'World & game', src: 'lua' },
    other: { label: 'Other Lua', src: 'lua' },
    mod: { label: 'PZ2QoL (Lua)', src: 'lua' },
    'js-mod': { label: 'PZ2QoL (JS)', src: 'js' },
    'js-game': { label: 'Game UI (JS)', src: 'js' },
};

export function groupLabel(g) {
    return (GROUPS[g] && GROUPS[g].label) || String(g || 'other');
}

// ------------------------------------------------------------ aggregation

export function createAgg({ buckets = 4, perBucket = 30 } = {}) {
    return {
        B: Math.max(1, Math.floor(buckets)),
        M: Math.max(1, Math.floor(perBucket)),
        frame: 0,
        fg: [], fn: [], fw: [], fl: [], fx: [], flx: [],
        active: [],
    };
}

export function newStat(name, group) {
    return { name, group, ff: -1, fc: 0, ft: 0, fs: 0, fm: 0, bg: [], bc: [], bt: [], bs: [], bm: [], bf: [], act: false };
}

export function resetStat(s) {
    s.ff = -1;
    s.fc = s.ft = s.fs = s.fm = 0;
    s.bg = []; s.bc = []; s.bt = []; s.bs = []; s.bm = []; s.bf = [];
    s.act = false;
}

function flush(agg, s) {
    if (s.ff < 0) return;
    const g = Math.floor(s.ff / agg.M), k = g % agg.B;
    if (s.bg[k] !== g) {
        s.bg[k] = g; s.bc[k] = 0; s.bt[k] = 0; s.bs[k] = 0; s.bm[k] = 0; s.bf[k] = 0;
    }
    s.bc[k] += s.fc;
    s.bt[k] += s.ft;
    s.bs[k] += s.fs;
    if (s.fm > s.bm[k]) s.bm[k] = s.fm;
    if (s.ft > s.bf[k]) s.bf[k] = s.ft;
    s.ff = -1;
}

// One finished call; returns the stat's calls in this frame.
export function aggAdd(agg, s, ms, selfMs) {
    const f = agg.frame;
    if (s.ff !== f) {
        if (s.ff >= 0) flush(agg, s);
        s.ff = f; s.fc = 0; s.ft = 0; s.fs = 0; s.fm = 0;
        if (!s.act) {
            s.act = true;
            agg.active.push(s);
        }
    }
    s.fc++;
    s.ft += ms;
    s.fs += Math.max(0, selfMs);
    if (ms > s.fm) s.fm = ms;
    return s.fc;
}

export function aggEndFrame(agg, wallMs, scriptMs) {
    const g = Math.floor(agg.frame / agg.M), k = g % agg.B;
    if (agg.fg[k] !== g) {
        agg.fg[k] = g; agg.fn[k] = 0; agg.fw[k] = 0; agg.fl[k] = 0; agg.fx[k] = 0; agg.flx[k] = 0;
    }
    agg.fn[k]++;
    agg.fw[k] += wallMs;
    agg.fl[k] += scriptMs;
    if (wallMs > agg.fx[k]) agg.fx[k] = wallMs;
    if (scriptMs > agg.flx[k]) agg.flx[k] = scriptMs;
    agg.frame++;
}

function inWindow(agg, g) {
    if (agg.frame <= 0 || g === undefined) return false;
    const gNow = Math.floor((agg.frame - 1) / agg.M);
    return g <= gNow && g > gNow - agg.B;
}

export function aggReport(agg, top = 80) {
    let n = 0, w = 0, l = 0, x = 0, lx = 0;
    for (let k = 0; k < agg.B; k++) {
        if (!inWindow(agg, agg.fg[k])) continue;
        n += agg.fn[k]; w += agg.fw[k]; l += agg.fl[k];
        if (agg.fx[k] > x) x = agg.fx[k];
        if (agg.flx[k] > lx) lx = agg.flx[k];
    }
    const rows = [];
    const keep = [];
    for (const s of agg.active) {
        if (s.ff >= 0 && s.ff < agg.frame) flush(agg, s);
        let c = 0, t = 0, sf = 0, m = 0, wf = 0;
        for (let k = 0; k < agg.B; k++) {
            if (!inWindow(agg, s.bg[k])) continue;
            c += s.bc[k]; t += s.bt[k]; sf += s.bs[k];
            if (s.bm[k] > m) m = s.bm[k];
            if (s.bf[k] > wf) wf = s.bf[k];
        }
        if (c > 0) {
            const nf = n > 0 ? n : 1;
            rows.push({ n: s.name, g: s.group, c: c / nf, t: t / nf, s: sf / nf, a: t / c, m, x: wf, k: c });
            keep.push(s);
        }
        else if (s.ff >= 0) keep.push(s);
        else s.act = false;
    }
    agg.active = keep;
    rows.sort((a, b) => b.t - a.t);
    const groups = {};
    for (const r of rows) groups[r.g] = (groups[r.g] || 0) + r.s;
    return {
        frames: n,
        wallAvg: n > 0 ? w / n : 0,
        wallMax: x,
        scriptAvg: n > 0 ? l / n : 0,
        scriptMax: lx,
        rows: rows.slice(0, top),
        active: rows.length,
        groups,
    };
}

// ----------------------------------------------------------------- data

export function parseProfData(text) {
    try {
        const d = typeof text === 'string' ? JSON.parse(text) : text;
        if (!d || typeof d !== 'object') return null;
        if (!Array.isArray(d.rows)) d.rows = [];
        if (!d.strip || typeof d.strip !== 'object') d.strip = { wall: [], lua: [] };
        if (!Array.isArray(d.strip.wall)) d.strip.wall = [];
        if (!Array.isArray(d.strip.lua)) d.strip.lua = [];
        return d;
    }
    catch (e) {
        return null;
    }
}

// Lua rows and JS rows in one list, each with src 'lua' / 'js'.
export function mergeRows(luaRows, jsRows) {
    const out = [];
    for (const r of luaRows || []) out.push(Object.assign({ src: 'lua' }, r));
    for (const r of jsRows || []) out.push(Object.assign({ src: 'js' }, r));
    return out;
}

export const SORT_KEYS = ['n', 'g', 's', 't', 'c', 'a', 'm', 'x'];

export function sortRows(rows, key = 's', desc = true) {
    const k = SORT_KEYS.includes(key) ? key : 's';
    const sign = desc ? -1 : 1;
    return rows.slice().sort((a, b) => {
        const va = a[k], vb = b[k];
        if (typeof va === 'string' || typeof vb === 'string') {
            const c = String(va || '').localeCompare(String(vb || ''));
            return c * sign || (b.s || 0) - (a.s || 0);
        }
        const d = ((va || 0) - (vb || 0)) * sign;
        return d || String(a.n).localeCompare(String(b.n));
    });
}

// 'all' | 'lua' (game Lua) | 'pz2qol' (PZ2QoL, Lua and JS) | 'js' | a
// group id ('mod' is the group of PZ2QoL's Lua only)
const VIEWS = ['all', 'lua', 'pz2qol', 'js'];
export function filterRows(rows, filter = 'all', text = '') {
    const q = String(text || '').trim().toLowerCase();
    return rows.filter(r => {
        if (filter === 'lua' && !(r.src === 'lua' && r.g !== 'mod')) return false;
        if (filter === 'pz2qol' && !(r.g === 'mod' || r.g === 'js-mod')) return false;
        if (filter === 'js' && r.src !== 'js') return false;
        if (!VIEWS.includes(filter) && r.g !== filter) return false;
        if (q && !String(r.n).toLowerCase().includes(q)) return false;
        return true;
    });
}

// ---------------------------------------------------------------- format

export function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return '–';
    if (ms <= 0) return '0';
    if (ms < 0.01) return '<0.01';
    if (ms < 10) return ms.toFixed(2);
    if (ms < 1000) return ms.toFixed(1);
    return String(Math.round(ms));
}

export function fmtCalls(c) {
    if (c == null || !isFinite(c)) return '–';
    if (c === 0) return '0';
    if (c < 0.1) return c.toFixed(2);
    if (c < 10) return c.toFixed(1);
    return String(Math.round(c));
}

export function fmtPct(p) {
    if (p == null || !isFinite(p)) return '–';
    return p < 1 && p > 0 ? '<1%' : `${Math.round(p)}%`;
}

// The frame as Lua and JS saw it. wall: Lua's frame-to-frame time (the
// game's frame), else the page's own frame interval.
export function frameSummary(lua, js) {
    const luaFrames = lua && lua.frames > 0;
    const wall = luaFrames ? lua.wallAvg : (js && js.frames > 0 ? js.wallAvg : 0);
    const luaMs = luaFrames ? lua.luaAvg || 0 : 0;
    const jsMs = js && js.frames > 0 ? js.scriptAvg || 0 : 0;
    const rest = Math.max(0, wall - luaMs - jsMs);
    const pct = v => (wall > 0 ? (v * 100) / wall : 0);
    return {
        wall,
        wallMax: luaFrames ? lua.wallMax : (js && js.wallMax) || 0,
        fps: wall > 0 ? 1000 / wall : 0,
        lua: luaMs,
        luaMax: luaFrames ? lua.luaMax || 0 : 0,
        luaPct: pct(luaMs),
        js: jsMs,
        jsPct: pct(jsMs),
        rest,
        restPct: pct(rest),
        source: luaFrames ? 'lua' : (js && js.frames > 0 ? 'js' : 'none'),
    };
}

// Bars for the frame strip: heights in % of capMs (the frame time that
// fills the strip), the Lua part inside it, and whether the frame was over
// the cap (drawn full and marked).
export function stripBars(wall, lua, capMs = 50) {
    const cap = capMs > 0 ? capMs : 50;
    const out = [];
    for (let i = 0; i < (wall || []).length; i++) {
        const w = Math.max(0, +wall[i] || 0);
        const l = Math.min(w, Math.max(0, +(lua && lua[i]) || 0));
        out.push({ h: Math.min(100, (w * 100) / cap), l: Math.min(100, (l * 100) / cap), over: w > cap, wall: w, lua: l });
    }
    return out;
}

// A strip scale that fits the frames: 33 ms, 50 ms, 100 ms or 250 ms.
export function stripCap(wall) {
    let max = 0;
    for (const w of wall || []) if (w > max) max = w;
    for (const c of [33.4, 50, 100, 250]) if (max <= c) return c;
    return 500;
}

// "kinboard.js renderBoard" from a stack captured where a callback was
// registered; mod: true for the mod's own files. skip: our own file.
const OWN_FILES = ['profiler.js', 'profhooks.js', 'profcore.js'];
export function stackLabel(stack, skip = OWN_FILES) {
    const skipList = Array.isArray(skip) ? skip : [skip];
    const lines = String(stack || '').split('\n');
    for (const line of lines) {
        const m = /at (?:(.+?) \()?(?:.*\/)?([^/\s():]+\.js):\d+(?::\d+)?\)?\s*$/.exec(line.trim())
            || /^(?:(.*?)@)?(?:.*\/)?([^/\s():@]+\.js):\d+(?::\d+)?\s*$/.exec(line.trim());
        if (!m) continue;
        const file = m[2];
        if (!file || skipList.includes(file)) continue;
        let fn = (m[1] || '').replace(/^(?:async |new )/, '').replace(/^(?:Object|Array|Module|window|globalThis)\./, '').trim();
        if (fn.length > 40) fn = fn.slice(0, 40);
        return { file, fn, mod: /\/mods\/pz2qol\//i.test(line) };
    }
    return null;
}

// Plain text lines for a snapshot (the panel and the debug log).
export function snapshotLines(summary, rows, n = 25) {
    const s = summary || {};
    const out = [`frame ${fmtMs(s.wall)} ms (${Math.round(s.fps || 0)} fps), worst ${fmtMs(s.wallMax)} · Lua ${fmtMs(s.lua)} ms (${fmtPct(s.luaPct)}) · JS ${fmtMs(s.js)} ms · rest ${fmtMs(s.rest)} ms`];
    (rows || []).slice(0, n).forEach((r, i) => {
        out.push(`${i + 1}. ${r.n} [${r.src === 'js' ? 'JS' : 'Lua'} ${groupLabel(r.g)}] self ${fmtMs(r.s)} total ${fmtMs(r.t)} calls ${fmtCalls(r.c)} avg ${fmtMs(r.a)} max ${fmtMs(r.m)} worst ${fmtMs(r.x)}`);
    });
    return out;
}
