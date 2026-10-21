// node --test tests/profiler.test.mjs
// Script profiler: the JS aggregation and helpers (profcore.js) and the
// page hooks of profiler.js (engine.on/off wrapping, timers) against a fake
// engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import {
    createAgg, newStat, aggAdd, aggEndFrame, aggReport, parseProfData, mergeRows, sortRows, filterRows,
    fmtMs, fmtCalls, fmtPct, frameSummary, stripBars, stripCap, stackLabel, snapshotLines, groupLabel, resetStat,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/profcore.js';

register('./gameface-loader.mjs', import.meta.url);

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('per-frame figures over the window: calls, total, self, slowest call, worst frame', () => {
    const agg = createAgg({ buckets: 2, perBucket: 3 });
    const a = newStat('A', 'js-mod');
    const b = newStat('B', 'js-game');
    for (let f = 0; f < 6; f++) {
        aggAdd(agg, a, 1, 0.5);
        aggAdd(agg, a, 1, 0.5);
        if (f % 2 === 0) aggAdd(agg, b, 3, 3);
        aggEndFrame(agg, 16, 2 + (f % 2 === 0 ? 3 : 0));
    }
    const r = aggReport(agg);
    assert.equal(r.frames, 6);
    assert.ok(near(r.wallAvg, 16) && near(r.scriptAvg, 3.5) && near(r.scriptMax, 5));
    const by = Object.fromEntries(r.rows.map(x => [x.n, x]));
    assert.ok(near(by.A.c, 2) && near(by.A.t, 2) && near(by.A.s, 1) && near(by.A.a, 1) && near(by.A.x, 2));
    assert.ok(near(by.B.c, 0.5) && near(by.B.t, 1.5) && near(by.B.x, 3) && by.B.k === 3);
    assert.ok(near(r.groups['js-mod'], 1) && near(r.groups['js-game'], 1.5));
});

test('the window rolls a whole bucket at a time and idle stats leave it', () => {
    const agg = createAgg({ buckets: 2, perBucket: 3 });
    const a = newStat('A', 'js-mod');
    const b = newStat('B', 'js-mod');
    for (let f = 0; f < 6; f++) {
        aggAdd(agg, a, 1, 1);
        aggEndFrame(agg, 16, 1);
    }
    for (let f = 6; f < 9; f++) {
        aggAdd(agg, b, 1, 1);
        aggEndFrame(agg, 10, 1);
    }
    let r = aggReport(agg);
    assert.equal(r.frames, 6);
    assert.ok(near(r.wallAvg, 13));
    const by = Object.fromEntries(r.rows.map(x => [x.n, x]));
    assert.ok(near(by.A.t, 0.5) && near(by.B.t, 0.5), 'A only in frames 3..5, B in 6..8');
    for (let f = 9; f < 15; f++) aggEndFrame(agg, 10, 0);
    r = aggReport(agg);
    assert.equal(r.rows.length, 0);
    assert.equal(agg.active.length, 0);
    assert.equal(aggAdd(agg, a, 1, 1), 1, 'comes back on its next call');
    resetStat(a);
    assert.equal(a.ff, -1);
});

test('negative self time is clamped and a still-open frame keeps its stat', () => {
    const agg = createAgg({ buckets: 1, perBucket: 5 });
    const s = newStat('S', 'js-mod');
    aggAdd(agg, s, 1, -0.3);
    aggEndFrame(agg, 5, 1);
    assert.equal(aggReport(agg).rows[0].s, 0);
    aggAdd(agg, s, 1, 1); // frame 1 not closed
    const r = aggReport(agg);
    assert.equal(agg.active.length, 1);
    assert.equal(r.rows[0].k, 1, 'only the closed frame counts');
});

test('Lua data parses safely; rows merge, filter and sort', () => {
    assert.equal(parseProfData('not json'), null);
    const d = parseProfData('{"on":true,"frames":10,"rows":[{"n":"Managers.X:Advance","g":"manager","s":1,"t":2,"c":1,"a":2,"m":3,"x":3}]}');
    assert.deepEqual(d.strip, { wall: [], lua: [] });
    const rows = mergeRows(d.rows, [{ n: 'on PZ2QoL_KinChunk (kin.js)', g: 'js-mod', s: 0.5, t: 0.5, c: 2, a: 0.25, m: 0.4, x: 0.5 },
        { n: 'DataStore change callbacks (game UI data binding)', g: 'js-game', s: 3, t: 3, c: 40, a: 0.075, m: 1, x: 4 }]);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].src, 'lua');
    assert.deepEqual(sortRows(rows, 's').map(r => r.g), ['js-game', 'manager', 'js-mod']);
    assert.deepEqual(sortRows(rows, 'c', false).map(r => r.c), [1, 2, 40]);
    assert.deepEqual(sortRows(rows, 'n', false).map(r => r.n[0]), ['D', 'M', 'o']);
    assert.deepEqual(filterRows(rows, 'lua').map(r => r.g), ['manager']);
    assert.deepEqual(filterRows(rows, 'pz2qol').map(r => r.g), ['js-mod']);
    assert.deepEqual(filterRows(mergeRows([{ n: 'PZ2QoL.Kin:_Tick', g: 'mod' }], rows), 'mod').map(r => r.g), ['mod'], 'the mod group is Lua only');
    assert.deepEqual(filterRows(rows, 'js').map(r => r.g), ['js-mod', 'js-game']);
    assert.deepEqual(filterRows(rows, 'manager').map(r => r.g), ['manager']);
    assert.deepEqual(filterRows(rows, 'all', 'kinchunk').map(r => r.g), ['js-mod']);
    assert.equal(sortRows(rows, 'bogus')[0].g, 'js-game', 'unknown key sorts by self');
});

test('formatting', () => {
    assert.equal(fmtMs(0), '0');
    assert.equal(fmtMs(0.004), '<0.01');
    assert.equal(fmtMs(1.234), '1.23');
    assert.equal(fmtMs(12.34), '12.3');
    assert.equal(fmtMs(1234.4), '1234');
    assert.equal(fmtMs(undefined), '–');
    assert.equal(fmtCalls(0.05), '0.05');
    assert.equal(fmtCalls(3.33), '3.3');
    assert.equal(fmtCalls(120.4), '120');
    assert.equal(fmtPct(0.4), '<1%');
    assert.equal(fmtPct(42.6), '43%');
    assert.equal(groupLabel('js-game'), 'Game UI (JS)');
    assert.equal(groupLabel('nope'), 'nope');
});

test('frame summary: Lua frame time first, the rest is native', () => {
    const s = frameSummary({ frames: 100, wallAvg: 40, wallMax: 80, luaAvg: 6, luaMax: 9 }, { frames: 50, wallAvg: 16, scriptAvg: 2 });
    assert.equal(s.source, 'lua');
    assert.ok(near(s.fps, 25) && near(s.lua, 6) && near(s.js, 2) && near(s.rest, 32) && near(s.restPct, 80) && near(s.luaPct, 15));
    const j = frameSummary(null, { frames: 10, wallAvg: 20, wallMax: 30, scriptAvg: 1 });
    assert.equal(j.source, 'js');
    assert.ok(near(j.wall, 20) && near(j.rest, 19) && j.lua === 0);
    assert.equal(frameSummary(null, null).source, 'none');
    assert.equal(frameSummary({ frames: 5, wallAvg: 10, luaAvg: 12 }, null).rest, 0, 'never negative');
});

test('frame strip bars and scale', () => {
    const bars = stripBars([10, 50, 120], [2, 60, 10], 100);
    assert.deepEqual(bars.map(b => b.h), [10, 50, 100]);
    assert.deepEqual(bars.map(b => b.l), [2, 50, 10], 'Lua part never above its frame');
    assert.deepEqual(bars.map(b => b.over), [false, false, true]);
    assert.equal(stripCap([10, 20]), 33.4);
    assert.equal(stripCap([10, 40]), 50);
    assert.equal(stripCap([90]), 100);
    assert.equal(stripCap([300, 10]), 500);
    assert.equal(stripCap([]), 33.4);
});

test('a callback label from the registration stack', () => {
    const v8 = `Error
    at where (coui://UIGameface/js/mods/pz2qol/profiler.js:120:16)
    at window.setInterval (coui://UIGameface/js/mods/pz2qol/profiler.js:170:23)
    at installHudLauncher (coui://UIGameface/js/mods/pz2qol/hudlauncher.js:186:5)
    at step (coui://UIGameface/js/mods/pz2qol/main.js:40:20)`;
    assert.deepEqual(stackLabel(v8), { file: 'hudlauncher.js', fn: 'installHudLauncher', mod: true });
    const game = `Error
    at where (coui://UIGameface/js/mods/pz2qol/profiler.js:120:16)
    at engine.on (coui://UIGameface/js/mods/pz2qol/profiler.js:140:5)
    at Module.addListener (coui://UIGameface/js/common/core/Engine.js:37:12)`;
    assert.deepEqual(stackLabel(game), { file: 'Engine.js', fn: 'addListener', mod: false });
    const anon = `Error
    at coui://UIGameface/js/project/modules/HUD/HUDModule.js:10:3`;
    assert.deepEqual(stackLabel(anon), { file: 'HUDModule.js', fn: '', mod: false });
    const sm = `where@coui://UIGameface/js/mods/pz2qol/profiler.js:1:1
sync@coui://UIGameface/js/mods/pz2qol/kinboard.js:5:2`;
    assert.deepEqual(stackLabel(sm), { file: 'kinboard.js', fn: 'sync', mod: true });
    assert.equal(stackLabel(''), null);
    assert.equal(stackLabel(undefined), null);
});

test('snapshot lines', () => {
    const lines = snapshotLines({ wall: 40, fps: 25, wallMax: 80, lua: 6, luaPct: 15, js: 2, rest: 32 },
        [{ n: 'Managers.X:Advance', g: 'manager', src: 'lua', s: 1, t: 2, c: 1, a: 2, m: 3, x: 3 }], 5);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /frame 40\.0 ms \(25 fps\).*Lua 6\.00 ms \(15%\).*rest 32\.0 ms/);
    assert.match(lines[1], /^1\. Managers\.X:Advance \[Lua Managers\] self 1\.00 total 2\.00/);
});

// ---------------------------------------------------------- page hooks

function fakeEngine() {
    const handlers = new Map();
    return {
        handlers,
        on(name, cb) {
            const list = handlers.get(name) || [];
            list.push(cb);
            handlers.set(name, list);
            return { clear() {} };
        },
        off(name, cb) {
            const list = handlers.get(name) || [];
            const i = list.indexOf(cb);
            if (i >= 0) list.splice(i, 1);
        },
        trigger(name, ...args) {
            for (const cb of (handlers.get(name) || []).slice()) cb(...args);
        },
    };
}

test('page hooks: handlers are wrapped, still removable, and timed only while on', async () => {
    const eng = fakeEngine();
    globalThis.engine = eng;
    const timers = [];
    globalThis.window = {
        setTimeout: (cb, ms) => { timers.push(cb); return timers.length; },
        setInterval: (cb, ms) => { timers.push(cb); return 100 + timers.length; },
        requestAnimationFrame: cb => 7,
    };
    globalThis.document = globalThis.document || { addEventListener() {}, body: { appendChild() {} } };
    const P = await import('../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/profhooks.js');
    assert.equal(P.installJsHooks(), true, 'engine hooked');
    const { J } = P;

    let got = 0;
    const cb = n => { got += n; return 'r'; };
    engine.on('Foo', cb);
    const list = eng.handlers.get('Foo');
    assert.equal(list.length, 1);
    assert.notEqual(list[0], cb, 'the engine holds a wrapper');
    engine.trigger('Foo', 2);
    assert.equal(got, 2, 'the handler runs with its arguments');
    assert.equal(J.stats.size >= 1, true);
    for (const s of J.stats.values()) assert.equal(s.fc, 0, 'nothing timed while off');

    J.on = true;
    engine.trigger('Foo', 3);
    assert.equal(got, 5);
    const stat = [...J.stats.values()].find(s => s.name.startsWith('on Foo'));
    assert.ok(stat && stat.fc === 1, 'timed while on');
    assert.ok(stat.group === 'js-mod' || stat.group === 'js-game');

    // nested handler: the outer one's self time excludes the inner one
    engine.on('Inner', () => {});
    engine.on('Outer', () => engine.trigger('Inner'));
    engine.trigger('Outer');
    assert.equal(J.depth, 0, 'nesting closed');

    // an error passes through unchanged and the nesting recovers
    engine.on('Bad', () => { throw new Error('bad handler'); });
    assert.throws(() => engine.trigger('Bad'), /bad handler/);
    assert.equal(J.depth, 0);

    // off() with the caller's own function removes the wrapper
    engine.off('Foo', cb);
    assert.equal(eng.handlers.get('Foo').length, 0, 'removed');
    engine.trigger('Foo', 10);
    assert.equal(got, 5);

    // DataStore callbacks are one row
    engine.on('DSCallID1', () => {});
    engine.on('DSCallID2', () => {});
    engine.trigger('DSCallID1');
    engine.trigger('DSCallID2');
    const ds = [...J.stats.values()].find(s => /DataStore/.test(s.name));
    assert.ok(ds && ds.fc === 2 && ds.group === 'js-game');

    // timeouts are wrapped only while on; intervals always
    const nBefore = timers.length;
    J.on = false;
    const plain = () => {};
    window.setTimeout(plain, 5);
    assert.equal(timers[timers.length - 1], plain, 'off: the timeout is not wrapped');
    J.on = true;
    window.setTimeout(plain, 5);
    assert.notEqual(timers[timers.length - 1], plain, 'on: wrapped');
    window.setInterval(plain, 5);
    assert.notEqual(timers[timers.length - 1], plain, 'intervals wrapped');
    assert.equal(timers.length, nBefore + 3);
    J.on = false;
    delete globalThis.engine;
});
