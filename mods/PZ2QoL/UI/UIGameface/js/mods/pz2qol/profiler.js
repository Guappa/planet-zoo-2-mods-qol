// Script profiler panel (park HUD dock button, or Ctrl+Shift+P on any mod
// page). Shows which scripts take time each frame:
//  - Lua: the game's managers, components, modes, world/game scripts, hub
//    screens and PZ2QoL's own Lua, timed by pz2qol.profiler.lua and sent
//    here as PZ2QoL_ProfData every 0.5 s while it runs;
//  - JS on this page: engine.on handlers (game UI and PZ2QoL, including
//    the DataStore change callbacks that drive the game UI's data binding,
//    as one row), setInterval callbacks, and setTimeout /
//    requestAnimationFrame callbacks registered while it runs.
// Off by default; Start turns both sides on, Stop or closing the panel
// turns them off (Lua puts every function back). Pure timing.
//
// What it can't see: native engine work (simulation, pathing, animation,
// rendering, the GPU, Gameface's own layout and paint). That is the rest
// of the frame. The JS hooks only see handlers registered after this page
// started (the game's own early handlers are missed) and never Preact's
// renders, which run as promise jobs.
import { h, setText, setClass, clear } from '/js/mods/pz2qol/ui.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { dlog, isLogEnabled } from '/js/mods/pz2qol/debuglog.js';
import { btn, switchEl, closeButton, makeGuard, makeScroll, updateBars, scrollBoxTo } from '/js/mods/pz2qol/kinpanel.js';
import {
    parseProfData, mergeRows, sortRows, filterRows,
    fmtMs, fmtCalls, fmtPct, frameSummary, stripBars, stripCap, snapshotLines, groupLabel,
} from '/js/mods/pz2qol/profcore.js';
import { J, installJsHooks, jsStart, jsStop, jsReport, origTimers } from '/js/mods/pz2qol/profhooks.js';

const RENDER_MS = 500;
const HELLO_MS = 1500;
const MAX_ROWS = 80;
const STRIP_N = 120;
const guard = makeGuard('Script profiler');

// ---------------------------------------------------------------- state

const S = {
    open: false,
    running: false,
    deep: false,
    sampler: false,
    window: 120,
    sort: 's',
    desc: true,
    filter: 'all',
    compact: false,
    lua: null,          // last PZ2QoL_ProfData
    luaAt: 0,
    helloAt: 0,
    snapshot: null,     // lines shown after "Log snapshot"
    snapshotMsg: '',
};

let ui = null;
let renderTimer = 0;

function trigger(name, ...args) {
    try {
        if (typeof engine !== 'undefined') engine.trigger(name, ...args);
    }
    catch (e) {
        // no engine (harness without it)
    }
}

function sendStart() {
    trigger('PZ2QoL_ProfStart', JSON.stringify({ deep: S.deep, sampler: S.sampler, window: S.window }));
}

function start() {
    S.running = true;
    S.snapshot = null;
    breadcrumb('prof_start');
    dlog('prof', 'js_start', { deep: S.deep, sampler: S.sampler, window: S.window });
    sendStart();
    jsStart(S.window);
    render();
}

function stop() {
    if (S.running) {
        breadcrumb('prof_stop');
        dlog('prof', 'js_stop', {});
    }
    S.running = false;
    trigger('PZ2QoL_ProfStop');
    jsStop();
    render();
}

function restartIfRunning() {
    if (!S.running) return;
    sendStart();
    jsStart(S.window);
}

function onData(text) {
    const d = parseProfData(text);
    if (!d) return;
    S.lua = d;
    S.luaAt = Date.now();
    // Lua stopped on its own (a failed start): follow it
    if (S.running && d.on === false && d.err) {
        S.running = false;
        jsStop();
    }
    if (S.open) render();
}

// -------------------------------------------------------------- snapshot

function logSnapshot() {
    trigger('PZ2QoL_ProfSnapshot');
    const js = jsReport();
    const sum = frameSummary(S.lua, js);
    const rows = sortRows(mergeRows(S.lua ? S.lua.rows : [], js.rows), 's', true);
    S.snapshot = snapshotLines(sum, rows, 25);
    dlog('prof', 'js_summary', {
        wall: +sum.wall.toFixed(3), fps: Math.round(sum.fps), lua: +sum.lua.toFixed(3), js: +sum.js.toFixed(3),
        rest: +sum.rest.toFixed(3), jsFrames: js.frames, jsWall: +(js.wallAvg || 0).toFixed(3),
    });
    js.rows.slice().sort((a, b) => b.s - a.s).slice(0, 15).forEach((r, i) => {
        dlog('prof', 'js_row', {
            i: i + 1, name: r.n, grp: r.g, self: +r.s.toFixed(4), tot: +r.t.toFixed(4), calls: +r.c.toFixed(2),
            avg: +r.a.toFixed(4), max: +r.m.toFixed(3), worst: +r.x.toFixed(3),
        });
    });
    S.snapshotMsg = isLogEnabled()
        ? 'Snapshot written to dbg/trace.log (LOG lines, area "prof").'
        : 'This build has no log file: the snapshot is below (take a screenshot).';
    render();
}

// ------------------------------------------------------------------- UI

const COLS = [
    { key: 'n', label: 'Script', cls: 'name' },
    { key: 'g', label: 'Where', cls: 'grp' },
    { key: 's', label: 'Self ms', cls: 'num' },
    { key: 't', label: 'Total ms', cls: 'num' },
    { key: 'c', label: 'Calls', cls: 'num' },
    { key: 'a', label: 'Avg ms', cls: 'num' },
    { key: 'm', label: 'Max ms', cls: 'num' },
    { key: 'x', label: 'Worst f.', cls: 'num' },
];

const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'lua', label: 'Game Lua' },
    { id: 'pz2qol', label: 'PZ2QoL' },
    { id: 'js', label: 'Page JS' },
    { id: 'samples', label: 'Sampler' },
];

const WINDOWS = [60, 120, 300];

function tile(label) {
    const value = h('div.PZ2QoL_pfTileValue', { text: '–' });
    const sub = h('div.PZ2QoL_pfTileSub', { text: '' });
    const root = h('div.PZ2QoL_pfTile', null, h('div.PZ2QoL_pfTileLabel', { text: label }), value, sub);
    return { root, value, sub };
}

function build() {
    const root = h('div.PZ2QoL_pf.hidden');
    const startBtn = btn(guard, 'Start', null, () => (S.running ? stop() : start()), { cls: 'primary' });
    const resetBtn = btn(guard, 'Reset', null, () => {
        trigger('PZ2QoL_ProfReset');
        if (S.running) jsStart(S.window);
        render();
    }, { cls: 'small' });
    const snapBtn = btn(guard, 'Log snapshot', null, logSnapshot, { cls: 'small' });
    const compactBtn = btn(guard, 'Compact', null, () => {
        S.compact = !S.compact;
        render();
    }, { cls: 'small' });
    const status = h('div.PZ2QoL_pfStatus', { text: 'Off' });
    const head = h('div.PZ2QoL_pfHead', null,
        h('div.PZ2QoL_pfLogo'),
        h('div.PZ2QoL_pfTitles', null, h('div.PZ2QoL_pfTitle', { text: 'Script profiler' }), status),
        h('div.PZ2QoL_kpFlex'),
        startBtn, resetBtn, snapBtn, compactBtn,
        closeButton(guard, 'Close (stops profiling)', () => closeProfiler(), true));

    const tFrame = tile('Frame');
    const tLua = tile('Lua scripts');
    const tJs = tile('Page JS');
    const tRest = tile('Rest of frame');
    tRest.root.classList.add('rest');
    const tiles = h('div.PZ2QoL_pfTiles', null, tFrame.root, tLua.root, tJs.root, tRest.root);

    const bars = [];
    const barBox = h('div.PZ2QoL_pfBars');
    for (let i = 0; i < STRIP_N; i++) {
        const lua = h('div.PZ2QoL_pfBarLua');
        const bar = h('div.PZ2QoL_pfBar', null, lua);
        bars.push({ bar, lua });
        barBox.appendChild(bar);
    }
    const guide60 = h('div.PZ2QoL_pfGuide.g60', null, h('div.PZ2QoL_pfGuideLabel', { text: '60 fps' }));
    const guide30 = h('div.PZ2QoL_pfGuide.g30', null, h('div.PZ2QoL_pfGuideLabel', { text: '30 fps' }));
    const capLabel = h('div.PZ2QoL_pfCap', { text: '' });
    const strip = h('div.PZ2QoL_pfStrip', null, barBox, guide60, guide30, capLabel);

    const optRow = h('div.PZ2QoL_pfOpts');
    const groupRow = h('div.PZ2QoL_pfGroups');

    const headCells = COLS.map(c => {
        const cell = h(`div.PZ2QoL_pfCell.${c.cls}.head`, { onClick: guard('Sort', () => {
            if (S.sort === c.key) S.desc = !S.desc;
            else {
                S.sort = c.key;
                S.desc = c.key !== 'n' && c.key !== 'g';
            }
            render();
        }) }, h('span', { text: c.label }));
        cell.__key = c.key;
        return cell;
    });
    const headRow = h('div.PZ2QoL_pfRow.head', null, headCells);
    const scroll = makeScroll('pfList', { y: true });
    const table = h('div.PZ2QoL_pfTable', null, headRow, scroll.wrap);
    const empty = h('div.PZ2QoL_pfEmpty', { text: '' });

    const note = h('div.PZ2QoL_pfNote', { text:
        'Measures script time only: game Lua (managers, components, modes, UI scripts) and this page\'s JS. '
        + 'Native engine work (simulation, pathing, animation, rendering, the GPU, the UI\'s layout and paint) '
        + 'is not visible here: it is the rest of the frame. Lua can run on a worker thread next to rendering, '
        + 'so a small Lua share means the frame time is spent elsewhere.' });
    const snapBox = h('div.PZ2QoL_pfSnap.hidden');
    const foot = h('div.PZ2QoL_pfFoot', { text: '' });

    const body = h('div.PZ2QoL_pfBody', null, tiles, strip, optRow, groupRow, table, empty, snapBox, note);
    root.appendChild(head);
    root.appendChild(body);
    root.appendChild(foot);
    document.body.appendChild(root);
    // keep the game from seeing clicks and wheel inside the panel
    root.addEventListener('mousedown', e => e.stopPropagation());
    root.addEventListener('wheel', e => e.stopPropagation());
    ui = { root, startBtn, status, tFrame, tLua, tJs, tRest, bars, capLabel, guide60, guide30, optRow, groupRow, headCells, scroll, table, empty, snapBox, foot, body, rows: [] };
}

function chip(label, on, onClick, disabled = false) {
    const c = h(`div.PZ2QoL_pfChip${on ? '.on' : ''}${disabled ? '.disabled' : ''}`, { onClick: disabled ? undefined : guard(label, onClick) }, h('span', { text: label }));
    return c;
}

function renderOpts(caps) {
    clear(ui.optRow);
    const samplerOk = !!(caps && caps.sethook && caps.getinfo);
    ui.optRow.appendChild(switchEl(guard, 'Deep (all functions, slower)', S.deep, () => {
        S.deep = !S.deep;
        restartIfRunning();
        render();
    }));
    const sw = switchEl(guard, samplerOk ? 'Lua sampler' : 'Lua sampler (no debug library)', S.sampler && samplerOk, () => {
        if (!samplerOk) return;
        S.sampler = !S.sampler;
        restartIfRunning();
        render();
    });
    if (!samplerOk && caps) sw.classList.add('disabled');
    ui.optRow.appendChild(sw);
    ui.optRow.appendChild(h('div.PZ2QoL_pfOptLabel', { text: 'Window' }));
    for (const w of WINDOWS) {
        ui.optRow.appendChild(chip(`${w} frames`, S.window === w, () => {
            S.window = w;
            restartIfRunning();
            render();
        }));
    }
    ui.optRow.appendChild(h('div.PZ2QoL_kpFlex'));
    for (const f of FILTERS) {
        ui.optRow.appendChild(chip(f.label, S.filter === f.id, () => {
            S.filter = f.id;
            render();
        }));
    }
}

function renderGroups(lua, js) {
    clear(ui.groupRow);
    const all = Object.assign({}, (lua && lua.groups) || {}, (js && js.groups) || {});
    const list = Object.keys(all).map(g => ({ g, ms: all[g] })).filter(x => x.ms > 0).sort((a, b) => b.ms - a.ms);
    for (const x of list.slice(0, 10)) {
        const on = S.filter === x.g;
        ui.groupRow.appendChild(h(`div.PZ2QoL_pfGroup${on ? '.on' : ''}`, { onClick: guard('Group', () => {
            S.filter = on ? 'all' : x.g;
            render();
        }) }, h('span.PZ2QoL_pfGroupName', { text: groupLabel(x.g) }), h('span.PZ2QoL_pfGroupMs', { text: `${fmtMs(x.ms)} ms` })));
    }
}

function rowNode(i) {
    let r = ui.rows[i];
    if (r) return r;
    const cells = COLS.map(c => h(`div.PZ2QoL_pfCell.${c.cls}`));
    const share = h('div.PZ2QoL_pfShare');
    cells[0].appendChild(share);
    const name = h('span.PZ2QoL_pfName');
    cells[0].appendChild(name);
    const root = h('div.PZ2QoL_pfRow', null, cells);
    ui.scroll.content.appendChild(root);
    r = { root, cells, share, name };
    ui.rows[i] = r;
    return r;
}

function renderTable(rows, wall) {
    const n = Math.min(rows.length, MAX_ROWS);
    for (let i = 0; i < n; i++) {
        const r = rows[i];
        const node = rowNode(i);
        setClass(node.root, 'hidden', false);
        setClass(node.root, 'js', r.src === 'js');
        setClass(node.root, 'mod', r.g === 'mod' || r.g === 'js-mod');
        setClass(node.root, 'unhooked', !!r.h);
        setText(node.name, r.h ? `${r.n} (unhooked: too many calls)` : r.n);
        node.share.style.width = `${Math.min(100, wall > 0 ? (r.s * 100) / wall : 0).toFixed(1)}%`;
        setText(node.cells[1], groupLabel(r.g));
        setText(node.cells[2], fmtMs(r.s));
        setText(node.cells[3], fmtMs(r.t));
        setText(node.cells[4], fmtCalls(r.c));
        setText(node.cells[5], fmtMs(r.a));
        setText(node.cells[6], fmtMs(r.m));
        setText(node.cells[7], fmtMs(r.x));
    }
    for (let i = n; i < ui.rows.length; i++) setClass(ui.rows[i].root, 'hidden', true);
}

function renderSamples(samples) {
    const rows = ((samples && samples.rows) || []).slice(0, MAX_ROWS);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const node = rowNode(i);
        setClass(node.root, 'hidden', false);
        setClass(node.root, 'js', false);
        setClass(node.root, 'mod', /pz2qol/i.test(r.n));
        setClass(node.root, 'unhooked', false);
        setText(node.name, r.n);
        node.share.style.width = `${Math.min(100, r.p || 0).toFixed(1)}%`;
        setText(node.cells[1], 'sampled');
        setText(node.cells[2], fmtPct(r.p));
        setText(node.cells[3], String(r.k));
        for (let c = 4; c < 8; c++) setText(node.cells[c], '');
    }
    for (let i = rows.length; i < ui.rows.length; i++) setClass(ui.rows[i].root, 'hidden', true);
}

function render() {
    if (!ui || !S.open) return;
    const lua = S.lua;
    const js = jsReport();
    const caps = lua && lua.caps;
    setClass(ui.root, 'compact', S.compact);
    setText(ui.startBtn.querySelector('span'), S.running ? 'Stop' : 'Start');
    setClass(ui.startBtn, 'stop', S.running);

    const luaAnswering = S.luaAt > 0;
    let status;
    if (S.running) {
        status = lua && lua.on
            ? `Running · ${lua.frames || 0} frames · ${lua.hooked || 0} functions timed${lua.deep ? ' (deep)' : ''}`
            : (luaAnswering ? 'Starting…' : 'Running (page JS only: no answer from the game\'s Lua yet)');
        if (lua && lua.on && !(lua.frames > 0)) status += ' · waiting for the first frames';
    }
    else {
        status = lua && lua.err ? `Could not start: ${lua.err}` : (lua && lua.frames > 0 ? 'Stopped · last results' : 'Off · press Start');
    }
    setText(ui.status, status);

    const sum = frameSummary(lua, js);
    setText(ui.tFrame.value, sum.wall > 0 ? `${fmtMs(sum.wall)} ms` : '–');
    setText(ui.tFrame.sub, sum.wall > 0 ? `${Math.round(sum.fps)} fps · worst ${fmtMs(sum.wallMax)} ms` : (sum.source === 'none' ? 'no frames yet' : ''));
    setText(ui.tLua.value, sum.source === 'lua' ? `${fmtMs(sum.lua)} ms` : '–');
    setText(ui.tLua.sub, sum.source === 'lua' ? `${fmtPct(sum.luaPct)} of the frame · worst ${fmtMs(sum.luaMax)} ms` : '');
    setText(ui.tJs.value, js.frames > 0 ? `${fmtMs(sum.js)} ms` : '–');
    setText(ui.tJs.sub, js.frames > 0 ? `${fmtPct(sum.jsPct)} · page ${Math.round(js.wallAvg > 0 ? 1000 / js.wallAvg : 0)} fps` : '');
    setText(ui.tRest.value, sum.wall > 0 ? `${fmtMs(sum.rest)} ms` : '–');
    setText(ui.tRest.sub, sum.wall > 0 ? `${fmtPct(sum.restPct)} · native engine + GPU wait` : '');

    // frame strip (Lua's frames; the page's own when Lua has none)
    const strip = lua && lua.strip && lua.strip.wall.length ? lua.strip : { wall: [], lua: [] };
    const wall = strip.wall.slice(-STRIP_N);
    const luaMs = strip.lua.slice(-STRIP_N);
    const cap = stripCap(wall);
    const bars = stripBars(wall, luaMs, cap);
    const off = STRIP_N - bars.length;
    for (let i = 0; i < STRIP_N; i++) {
        const b = ui.bars[i];
        const v = i >= off ? bars[i - off] : null;
        b.bar.style.height = v ? `${v.h.toFixed(1)}%` : '0%';
        b.lua.style.height = v && v.h > 0 ? `${((v.l * 100) / v.h).toFixed(1)}%` : '0%';
        setClass(b.bar, 'over', !!(v && v.over));
        setClass(b.bar, 'slow', !!(v && v.wall > 33.4));
    }
    setText(ui.capLabel, wall.length ? `${Math.round(cap)} ms` : 'frame times appear here while running');
    ui.guide60.style.bottom = `${Math.min(100, (16.7 * 100) / cap).toFixed(1)}%`;
    ui.guide30.style.bottom = `${Math.min(100, (33.3 * 100) / cap).toFixed(1)}%`;
    setClass(ui.guide30, 'hidden', cap < 33.4);

    if (S.compact) return;
    renderOpts(caps);
    renderGroups(lua, js);

    for (const cell of ui.headCells) {
        setClass(cell, 'sorted', cell.__key === S.sort);
        setClass(cell, 'asc', cell.__key === S.sort && !S.desc);
    }
    let shown = 0;
    if (S.filter === 'samples') {
        const samples = lua && lua.samples;
        renderSamples(samples);
        shown = samples && samples.rows ? samples.rows.length : 0;
        setText(ui.empty, shown ? `Share of Lua instructions over the last ~2 s (${samples.total} samples; instructions, not time).`
            : (caps && caps.sethook ? 'Turn on "Lua sampler" and Start.' : 'Retail Lua has no debug.sethook here: the sampler is not available.'));
        setClass(ui.empty, 'hidden', false);
    }
    else {
        const rows = sortRows(filterRows(mergeRows(lua ? lua.rows : [], js.rows), S.filter), S.sort, S.desc);
        renderTable(rows, sum.wall);
        shown = rows.length;
        setText(ui.empty, shown ? '' : (S.running ? 'Nothing measured yet in this view.' : 'Press Start, then play for a few seconds.'));
        setClass(ui.empty, 'hidden', !!shown);
    }
    try {
        updateBars(ui.scroll);
    }
    catch (e) {
        // cosmetic
    }

    if (S.snapshot) {
        clear(ui.snapBox);
        ui.snapBox.appendChild(h('div.PZ2QoL_pfSnapMsg', { text: S.snapshotMsg }));
        for (const line of S.snapshot) ui.snapBox.appendChild(h('div.PZ2QoL_pfSnapLine', { text: line }));
        ui.snapBox.appendChild(h('div.PZ2QoL_pfSnapClose', { text: 'Hide', onClick: guard('Hide snapshot', () => {
            S.snapshot = null;
            render();
        }) }));
    }
    setClass(ui.snapBox, 'hidden', !S.snapshot);

    const parts = [];
    if (lua) {
        if (lua.overheadUs != null) {
            const perFrame = ((lua.overheadUs || 0) * (lua.callsPerFrame || 0)) / 1000;
            parts.push(`cost ${(+lua.overheadUs).toFixed(2)} µs a timed call (~${fmtMs(perFrame)} ms a frame, in the Lua figures)`);
        }
        if (lua.unhooked) parts.push(`${lua.unhooked} hot functions unhooked`);
        if (lua.heapKB) parts.push(`Lua heap ${(lua.heapKB / 1024).toFixed(1)} MB${lua.heapRate != null ? ` (${lua.heapRate >= 0 ? '+' : ''}${Math.round(lua.heapRate)} KB/s)` : ''}`);
        if (lua.envs) parts.push(`${lua.envs} environments`);
        if (lua.leaks) parts.push(`${lua.leaks} nesting repairs`);
        if (lua.note) parts.push(lua.note);
        if (caps) parts.push(`timer ${caps.timer || '?'}${caps.timerType ? '/' + caps.timerType : ''}, debug ${caps.debug ? (caps.sethook ? 'sethook' : 'partial') : 'none'}`);
    }
    else parts.push(luaAnswering ? '' : 'No answer from the game\'s Lua (yet).');
    if (J.hookError) parts.push(`JS hooks: ${J.hookError}`);
    else if (!J.hooks) parts.push('JS: engine handlers not hooked');
    setText(ui.foot, parts.filter(Boolean).join(' · '));
}

function tick() {
    if (!S.open) return;
    const t = Date.now();
    // while running, tell Lua the page is still here (it stops by itself
    // when the page goes, e.g. with the park)
    if (S.running && t - (S.pingAt || 0) >= 2000) {
        S.pingAt = t;
        trigger('PZ2QoL_ProfPing');
    }
    // Lua sends data from its frame tick; ask when it has gone quiet
    if (t - S.luaAt > HELLO_MS && t - S.helloAt > HELLO_MS) {
        S.helloAt = t;
        trigger('PZ2QoL_ProfHello');
    }
    render();
}

// ------------------------------------------------------------ open/close

export function isProfilerOpen() {
    return S.open;
}

export function openProfiler() {
    if (!ui) build();
    S.open = true;
    setClass(ui.root, 'hidden', false);
    breadcrumb('prof_open');
    trigger('PZ2QoL_ProfHello');
    S.helloAt = Date.now();
    if (!renderTimer) renderTimer = (origTimers().setInterval || setInterval).call(window, guard('Refresh', tick), RENDER_MS);
    render();
    try {
        scrollBoxTo(ui.scroll, 0, 0, true);
    }
    catch (e) {
        // cosmetic
    }
}

export function closeProfiler() {
    if (S.running) stop();
    S.open = false;
    if (ui) setClass(ui.root, 'hidden', true);
    if (renderTimer) {
        clearInterval(renderTimer);
        renderTimer = 0;
    }
}

export function toggleProfiler() {
    if (S.open) closeProfiler();
    else openProfiler();
}

let installed = false;
export function installProfiler() {
    if (installed) return true;
    installed = true;
    const hooked = installJsHooks();
    breadcrumb(hooked ? 'prof_hooks' : 'prof_hooks_failed');
    try {
        if (typeof engine !== 'undefined') engine.on('PZ2QoL_ProfData', text => {
            try {
                onData(text);
            }
            catch (e) {
                reportError('ui', 'Script profiler: data failed', e, { silent: true });
            }
        });
    }
    catch (e) {
        // no engine
    }
    try {
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p' || e.keyCode === 80)) {
                // debug builds only (a release build has no Lua profiler)
                if (isLogEnabled() !== true) return;
                e.stopPropagation();
                toggleProfiler();
            }
        });
    }
    catch (e) {
        // no keyboard
    }
    try {
        if (typeof window !== 'undefined') window.PZ2QoL_profiler = { open: openProfiler, close: closeProfiler, toggle: toggleProfiler, state: () => S, js: () => jsReport() };
    }
    catch (e) {
        // ignore
    }
    return true;
}

// tests
export function _profilerTestState() {
    return { S, J };
}
