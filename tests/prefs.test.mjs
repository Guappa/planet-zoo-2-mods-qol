// node --test tests/prefs.test.mjs
// The player-wide settings (prefs.js) hold across zoos: they live in the
// game's player save on this device (the Lua side's Prefs area), read once
// per page. The fake below stands for that Lua store; 'file' is the status
// name for "kept".
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./gameface-loader.mjs', import.meta.url);

// --- a fake game: engine events, localStorage and the Lua store
const fake = { file: null, answer: true, available: true, reason: '', saveOk: true, loads: 0, saves: [], handlers: new Map() };

function freshStorage() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _map: m };
}

const fakeEngine = {
    on(name, fn) {
        if (!fake.handlers.has(name)) fake.handlers.set(name, []);
        fake.handlers.get(name).push(fn);
    },
    trigger(name, ...args) {
        const fire = (ev, ...a) => setTimeout(() => (fake.handlers.get(ev) || []).forEach(fn => fn(...a)), 5);
        if (name === 'PZ2QoL_PrefsLoad') {
            fake.loads++;
            fake.lastLoad = args[0];
            if (!fake.answer) return;
            if (!fake.available) return fire('PZ2QoL_PrefsData', args[0], false, fake.reason || 'noplayer');
            fire('PZ2QoL_PrefsData', args[0], true, fake.file == null ? '' : fake.file);
        }
        if (name === 'PZ2QoL_PrefsSave') {
            assert.ok(/^[\x20-\x7e]*$/.test(args[1]), 'the stored text is ASCII');
            fake.saves.push(args[1]);
            if (fake.saveOk) fake.file = args[1];
            fire('PZ2QoL_PrefsSaved', args[0], fake.saveOk);
        }
    },
};

globalThis.window = { localStorage: freshStorage() };
globalThis.engine = fakeEngine;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let boot = 0;
// a page load: a fresh module, fresh UI storage, no event listeners
async function start({ keepStorage = false } = {}) {
    await sleep(450); // the previous page's last save lands first
    boot++;
    fake.handlers = new Map();
    fake.saves = [];
    fake.loads = 0;
    if (!keepStorage) window.localStorage = freshStorage();
    return import(`../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/prefs.js?boot=${boot}`);
}

test('read once on first use, and the stored settings come back', async () => {
    fake.file = '{"progOpt":{"engine":"deep","preset":"standard","cpu":"normal"}}';
    const p = await start();
    assert.equal(fake.loads, 0, 'nothing asked before the first use');
    assert.equal(p.prefsStatus(), 'loading');
    assert.equal(fake.loads, 1, 'asked on first use');
    p.loadPrefs();
    p.getPref('progOpt');
    assert.equal(fake.loads, 1, 'asked once per page');
    await sleep(50);
    assert.equal(p.prefsStatus(), 'file');
    assert.deepEqual(p.getPref('progOpt'), { engine: 'deep', preset: 'standard', cpu: 'normal' });
    assert.equal(fake.saves.length, 0, 'a plain read writes nothing');
});

test('nothing kept yet: empty, and the store is used', async () => {
    fake.file = null;
    const p = await start();
    p.loadPrefs();
    await sleep(50);
    assert.equal(p.prefsStatus(), 'file');
    assert.equal(p.getPref('progOpt'), undefined);
});

test('changes are saved once, 400 ms after the last one, as ASCII JSON', async () => {
    fake.file = '{}';
    const p = await start();
    p.loadPrefs();
    await sleep(50);
    p.setPref('progOpt', { engine: 'classic' });
    await sleep(200);
    p.setPref('progOpt', { engine: 'deep' });
    p.setPref('label', 'Löwe');
    await sleep(300);
    assert.equal(fake.saves.length, 0, 'not yet: 400 ms after the last change');
    await sleep(200);
    assert.equal(fake.saves.length, 1, 'one save for the burst');
    assert.deepEqual(JSON.parse(fake.saves[0]), { progOpt: { engine: 'deep' }, label: 'Löwe' });
    assert.ok(fake.saves[0].includes('\\u00f6'), 'non-ASCII escaped');

    const q = await start();
    q.loadPrefs();
    await sleep(50);
    assert.deepEqual(q.getPref('progOpt'), { engine: 'deep' }, 'back after a restart');
    assert.equal(q.getPref('label'), 'Löwe');
});

test('changes made before the store is read are replayed on top of it', async () => {
    fake.file = '{"progOpt":{"engine":"deep","preset":"long"},"keep":1}';
    const p = await start();
    // before the answer: the session has no file data yet
    p.updatePref('count', v => (v || 0) + 1);
    p.setPref('keep', undefined);
    assert.equal(p.prefsStatus(), 'loading');
    assert.equal(p.getPref('count'), 1);
    await sleep(50);
    assert.equal(p.prefsStatus(), 'file');
    assert.deepEqual(p.getPref('progOpt'), { engine: 'deep', preset: 'long' }, 'the stored data kept');
    assert.equal(p.getPref('count'), 1);
    assert.equal(p.getPref('keep'), undefined, 'a removal replayed too');
    await sleep(50);
    assert.equal(fake.saves.length, 1, 'the merged data saved at once');
    assert.deepEqual(JSON.parse(fake.saves[0]), { progOpt: { engine: 'deep', preset: 'long' }, count: 1 });
});

test('a replayed updatePref works on the stored value', async () => {
    fake.file = '{"count":5}';
    const p = await start();
    p.updatePref('count', v => (v || 0) + 1);
    await sleep(50);
    assert.equal(p.getPref('count'), 6);
});

test('removing a setting (undefined) is saved', async () => {
    fake.file = '{"a":1,"b":2}';
    const p = await start();
    p.loadPrefs();
    await sleep(50);
    p.setPref('a', undefined);
    await sleep(500);
    assert.deepEqual(JSON.parse(fake.file), { b: 2 });
    p.setPref('b', undefined);
    await sleep(500);
    assert.equal(fake.file, '{}');
});

test('onPrefs: called after the load and on every change; unsubscribe stops it', async () => {
    fake.file = '{"a":1}';
    const p = await start();
    const seen = [];
    const off = p.onPrefs((status, key) => seen.push([status, key]));
    assert.equal(fake.loads, 1, 'onPrefs starts the read');
    p.setPref('b', 2); // before the load
    await sleep(50);
    p.setPref('c', 3);
    p.setPref('c', undefined);
    off();
    p.setPref('d', 4);
    assert.deepEqual(seen, [['loading', 'b'], ['file', undefined], ['file', 'c'], ['file', 'c']]);
    p.onPrefs(() => {
        throw new Error('a bad listener');
    });
    p.setPref('e', 5); // never breaks the store
    assert.equal(p.getPref('e'), 5);
});

test('no player profile: memory only, the session keeps working, nothing sent', async () => {
    fake.available = false;
    fake.reason = 'noplayer';
    const p = await start();
    const seen = [];
    p.onPrefs(s => seen.push(s));
    await sleep(50);
    assert.equal(p.prefsStatus(), 'memory');
    assert.equal(p.prefsReason(), 'noplayer');
    assert.deepEqual(seen, ['memory'], 'told once');
    p.setPref('a', 1);
    assert.equal(p.getPref('a'), 1);
    await sleep(500);
    assert.equal(fake.saves.length, 0, 'nothing saved without the store');
    fake.available = true;
    fake.reason = '';
});

test('no answer within 6 s: memory; a late answer still reads the store', async t => {
    fake.file = '{"a":1}';
    fake.answer = false;
    const p = await start();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        p.setPref('b', 2);
        t.mock.timers.tick(5900);
        assert.equal(p.prefsStatus(), 'loading');
        t.mock.timers.tick(200);
        assert.equal(p.prefsStatus(), 'memory');
        assert.equal(p.prefsReason(), 'nolua');
        assert.equal(p.getPref('b'), 2, 'the session keeps its changes');
        assert.equal(fake.saves.length, 0);
        // the answer turns up after all
        (fake.handlers.get('PZ2QoL_PrefsData') || []).forEach(fn => fn(fake.lastLoad, true, fake.file));
        assert.equal(p.prefsStatus(), 'file');
        assert.equal(p.getPref('a'), 1);
        assert.equal(p.getPref('b'), 2);
        // a save reads the store first; with no answer it saves after 1 s
        t.mock.timers.tick(10);
        t.mock.timers.tick(1100);
        assert.deepEqual(JSON.parse(fake.saves[0]), { a: 1, b: 2 });
    }
    finally {
        t.mock.timers.reset();
        fake.answer = true;
    }
});

test('PZ2QoL_Hello asks again while the store was not read', async () => {
    fake.file = '{"a":7}';
    fake.answer = false;
    const p = await start();
    p.loadPrefs();
    fake.answer = true;
    (fake.handlers.get('PZ2QoL_Hello') || []).forEach(fn => fn());
    await sleep(50);
    assert.equal(fake.loads, 2);
    assert.equal(p.prefsStatus(), 'file');
    assert.equal(p.getPref('a'), 7);
    (fake.handlers.get('PZ2QoL_Hello') || []).forEach(fn => fn());
    assert.equal(fake.loads, 2, 'not again once read');
});

test('a refused save: memory, and the UI knows why', async () => {
    fake.file = '{}';
    const p = await start();
    p.loadPrefs();
    await sleep(50);
    fake.saveOk = false;
    p.setPref('a', 1);
    await sleep(500);
    assert.equal(p.prefsStatus(), 'memory');
    assert.equal(p.prefsReason(), 'failed');
    assert.equal(p.getPref('a'), 1);
    fake.saveOk = true;
});

test('localStorage mirrors the session (and a broken one never breaks it)', async () => {
    fake.file = '{"a":1}';
    const p = await start();
    p.loadPrefs();
    await sleep(50);
    p.setPref('b', 2);
    assert.deepEqual(JSON.parse(window.localStorage.getItem('PZ2QoL.prefs.v1')), { a: 1, b: 2 });
    window.localStorage = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
    p.setPref('c', 3);
    assert.equal(p.getPref('c'), 3);
    await sleep(500);
    assert.deepEqual(JSON.parse(fake.file), { a: 1, b: 2, c: 3 });
    window.localStorage = freshStorage();
});

test('no engine (tests, harness): memory, never throws', async () => {
    await sleep(450);
    delete globalThis.engine;
    try {
        boot++;
        const p = await import(`../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/prefs.js?boot=${boot}`);
        assert.equal(p.prefsStatus(), 'memory');
        p.setPref('a', 1);
        assert.equal(p.getPref('a'), 1);
        await sleep(450);
        assert.equal(p.prefsStatus(), 'memory');
    }
    finally {
        globalThis.engine = fakeEngine;
    }
});

test('two pages: a save keeps what the other page saved', async () => {
    fake.file = '{}';
    fake.answer = true;
    fake.available = true;
    const a = await start();
    a.loadPrefs();
    await sleep(30);
    boot++;
    const b = await import(`../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/prefs.js?boot=${boot}`);
    b.loadPrefs();
    await sleep(30);
    a.setPref('kinSettings', { alertLife: true });
    await sleep(500);
    b.setPref('progOpt', { engine: 'deep' });
    await sleep(500);
    assert.deepEqual(JSON.parse(fake.file), { kinSettings: { alertLife: true }, progOpt: { engine: 'deep' } });
    assert.deepEqual(b.getPref('kinSettings'), { alertLife: true }, 'the save from the other page is taken in');
});
