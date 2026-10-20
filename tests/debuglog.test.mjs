// node --test tests/debuglog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    _configureForTests, _flushForTests, _resetForTests, dlog, formatData, formatLine, formatValue, getLogLines, isLogEnabled, LOG_MAX,
    logPriceDecision, priceFields, setLogState, timeText,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/debuglog.js';

// a fixed clock: 2026-10-18 10:11:12.345 local time
const T0 = new Date(2026, 9, 18, 10, 11, 12, 345).getTime();
function fresh() {
    _resetForTests();
    let t = T0;
    const sent = [];
    _configureForTests({ now: () => t, send: text => sent.push(text) });
    return { sent, advance: ms => { t += ms; } };
}

test('values: numbers, booleans, strings, quoting, control characters, non-ASCII', () => {
    assert.equal(formatValue(1200), '1200');
    assert.equal(formatValue(1 / 3), '0.3333');
    assert.equal(formatValue(NaN), 'nan');
    assert.equal(formatValue(true), 'true');
    assert.equal(formatValue(null), 'null');
    assert.equal(formatValue(undefined), 'nil');
    assert.equal(formatValue('animal_3'), 'animal_3');
    assert.equal(formatValue('two words'), '"two words"');
    assert.equal(formatValue(''), '""');
    assert.equal(formatValue('a=b'), '"a=b"');
    assert.equal(formatValue('say "hi"'), `"say 'hi'"`);
    assert.equal(formatValue('l1\nl2'), '"l1 l2"');
    assert.equal(formatValue('Löwe'), 'L?we');
    assert.equal(formatValue(() => 1), '[fn]');
});

test('values: arrays and objects one level deep, long values cut', () => {
    assert.equal(formatValue([1, 'a', true]), '[1,a,true]');
    assert.equal(formatValue({ a: 1, b: 'x' }), '[a:1,b:x]');
    assert.equal(formatValue({ a: { b: 1 } }), '[a:[...]]');
    assert.equal(formatValue(Array.from({ length: 20 }, (_, i) => i)), '[0,1,2,3,4,5,6,7,8,9,10,11,...20]');
    const long = formatValue('x'.repeat(500));
    assert.ok(long.length <= 162 && long.endsWith('~'), `cut: ${long.length}`);
    assert.equal(formatValue(new Map([['k', 2]])), '[k:2]');
});

test('data: lead keys first, then as written; undefined left out; sensitive keys redacted', () => {
    assert.equal(formatData({ price: 900, guid: '4400000000001', run: 2, i: 3, extra: undefined, why: 'busy' }),
        ' run=2 i=3 guid=4400000000001 price=900 why=busy');
    assert.equal(formatData({ steamId: '7656', accountName: 'x', authToken: 'y', userName: 'me', species: 'Lion' }),
        ' steamId=[redacted] accountName=[redacted] authToken=[redacted] userName=[redacted] species=Lion');
    assert.equal(formatData({ m: { token: 'secret', ok: 1 } }), ' m=[ok:1]');
    assert.equal(formatData(undefined), '');
    assert.equal(formatData({}), '');
    assert.equal(formatData('just text'), ' "just text"');
});

test('line format: js#seq@time area event data', () => {
    const { sent } = fresh();
    setLogState('on');
    dlog('lister', 'send', { run: 4, guid: '77', price: 1500 });
    assert.deepEqual(getLogLines(), ['js#1@10:11:12.345 lister send run=4 guid=77 price=1500']);
    assert.equal(timeText(T0), '10:11:12.345');
    _flushForTests();
    assert.deepEqual(sent, ['js#1@10:11:12.345 lister send run=4 guid=77 price=1500']);
    // areas and events are single words
    dlog('my area', '', null);
    assert.equal(getLogLines(1)[0], 'js#2@10:11:12.345 my_area event');
    assert.equal(formatLine({ seq: 9, at: T0, area: 'a', event: 'b', text: ' x=' + 'y'.repeat(2000) }).length, 901);
});

test('ring buffer keeps the newest LOG_MAX lines', () => {
    fresh();
    setLogState('on');
    for (let i = 0; i < LOG_MAX + 250; i++) dlog('desk', 'tick', { n: i });
    const lines = getLogLines();
    assert.equal(lines.length, LOG_MAX);
    assert.ok(lines[0].includes(`n=250`), lines[0]);
    assert.ok(lines[LOG_MAX - 1].includes(`n=${LOG_MAX + 249}`));
    assert.equal(getLogLines(5).length, 5);
    assert.equal(getLogLines(LOG_MAX, 'lister').length, 0);
});

test('before Lua answers lines wait; on sends them in order; batches stay under Lua\'s cap', () => {
    const { sent } = fresh();
    assert.equal(isLogEnabled(), null);
    for (let i = 0; i < 150; i++) dlog('desk', 'early', { n: i });
    _flushForTests();
    assert.equal(sent.length, 0, 'nothing sent before Lua said on');
    setLogState('on');
    _flushForTests();
    const all = sent.join('\n').split('\n');
    assert.equal(all.length, 150);
    assert.ok(all[0].endsWith('n=0') && all[149].endsWith('n=149'));
    assert.ok(sent.every(b => b.split('\n').length <= 100), 'at most 100 lines per batch');
});

test('off (a release build): a no-op, nothing kept, nothing sent', () => {
    const { sent } = fresh();
    dlog('desk', 'before', {});
    setLogState('off');
    assert.equal(getLogLines().length, 0);
    dlog('desk', 'open', { n: 1 });
    logPriceDecision('desk', '1', { price: 5 });
    _flushForTests();
    assert.equal(sent.length, 0);
    assert.equal(getLogLines().length, 0);
    assert.equal(isLogEnabled(), false);
});

test('never throws: hostile data, a throwing sender, a throwing getter', () => {
    fresh();
    setLogState('on');
    _configureForTests({ send: () => { throw new Error('engine gone'); } });
    const hostile = {};
    Object.defineProperty(hostile, 'boom', { enumerable: true, get() { throw new Error('getter'); } });
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => dlog('desk', 'x', hostile));
    assert.doesNotThrow(() => dlog('desk', 'y', cyclic));
    assert.doesNotThrow(() => dlog(Symbol('s'), { toString() { throw new Error('t'); } }, 5));
    assert.doesNotThrow(() => _flushForTests());
    assert.doesNotThrow(() => logPriceDecision('desk', '1', hostile));
    assert.doesNotThrow(() => setLogState(undefined));
});

test('rate limit: more than 400 lines a second are counted and reported, not sent', () => {
    const { sent, advance } = fresh();
    setLogState('on');
    for (let i = 0; i < 450; i++) dlog('desk', 'flood', { n: i });
    advance(1100);
    dlog('desk', 'after', {});
    _flushForTests();
    const all = sent.join('\n').split('\n');
    assert.equal(all.filter(l => l.includes(' flood ')).length, 400);
    assert.ok(all.some(l => /log dropped n=50 reason=rate/.test(l)), 'the drop is reported');
    assert.equal(getLogLines(LOG_MAX).filter(l => l.includes(' flood ')).length, 450, 'the ring keeps them all');
});

test('price decisions: compact inputs, logged once per animal and outcome', () => {
    fresh();
    setLogState('on');
    const advice = {
        price: 1200, basePrice: 1300, confidence: 'medium', method: 'fit', medal: 'silver', morph: '', score: 61,
        gameValue: 900, marketPrice: 1350, offset: -0.1, reason: '4 Silver adult males: 1100-1500 CC',
        comps: { list: [{}, {}, {}, {}], tier: 1, medalMode: 'same', sameCount: 4 },
    };
    const f = priceFields(advice);
    assert.equal(f.comps, 4);
    assert.equal(f.medalMode, 'same');
    logPriceDecision('job', 'g1', advice, { run: 'next' });
    logPriceDecision('job', 'g1', advice);
    logPriceDecision('job', 'g1', Object.assign({}, advice, { price: 1250 }));
    const lines = getLogLines().filter(l => l.includes(' pricing decision '));
    assert.equal(lines.length, 2, 'same outcome logged once');
    assert.match(lines[0], /pricing decision run=next where=job id=g1 price=1200 base=1300 conf=medium method=fit comps=4 tier=1 medal=silver medalMode=same sameMedal=4 score=61 market=1350 game=900 offset=-0.1 reason="4 Silver adult males: 1100-1500 CC"/);
    assert.deepEqual(priceFields(null), { price: 'none' });
});
