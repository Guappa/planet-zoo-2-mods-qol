// node --test tests/listercore.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    activeFilterCount, basisScore, beyondBest, blockOf, cautionOf, DESK_FILTERS, deskRows, encodeJob, filterRows, normalizeFilters, normalizeState,
    resetFilters, retryGuids, sortRows, speciesCounts, summaryText, tally, tickable, timeLeftText,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/listercore.js';

const A = (key, over = {}) => Object.assign({
    id: key.replace('animal_', ''), key, species: 'Lion', gender: 0, maturity: 2, isPregnant: false, isMoving: false, isShoal: false,
    auctionTimerSeconds: -1, name: 'L' + key, medal: 'silver', genes: { size: 0.5, longevity: 0.5, fertility: 0.5, immunity: 0.5 },
}, over);
const advise = a => ({ price: a.name === 'Lnoprice' ? 0 : 1000, confidence: 'high', reason: '' });

test('blocks: listed, moving, juvenile, elderly infertile; cautions: pregnant, infertile', () => {
    assert.equal(blockOf(A('animal_1', { auctionTimerSeconds: 3600 })), 'listed');
    assert.equal(blockOf(A('animal_1', { isMoving: true })), 'moving');
    assert.equal(blockOf(A('animal_1', { maturity: 0 })), 'juvenile');
    assert.equal(blockOf(A('animal_1', { maturity: 6 })), 'elderly');
    assert.equal(blockOf(A('animal_1', { maturity: 4 })), null);
    assert.equal(blockOf(A('animal_1', { auctionTimerSeconds: 0 })), null);    // an expired listing is not on the market
    assert.equal(cautionOf(A('animal_1', { isPregnant: true })), 'pregnant');
    assert.equal(cautionOf(A('animal_1', { maturity: 5 })), 'infertile');
    assert.equal(cautionOf(A('animal_1')), null);
});

test('rows are keyed by GUID once known; shoals and id-less rows left out', () => {
    const rows = deskRows([A('animal_1'), A('animal_2'), A('animal_3', { isShoal: true }), A('animal_4', { id: undefined })], new Map([['animal_1', '900000000000000001']]), advise);
    assert.equal(rows[0].id, 'g900000000000000001');
    assert.ok(rows[1].id.startsWith('kanimal_2|'));                       // no GUID: the key plus what the row holds
    // the same key holding another animal is another row (a tick never moves to it)
    const other = deskRows([A('animal_2', { name: 'Other' })], new Map(), advise);
    assert.notEqual(other[0].id, rows[1].id);
    assert.equal(rows[0].guid, '900000000000000001');
    assert.equal(rows[1].guid, null);
});

test('species counts and filters', () => {
    const rows = deskRows([
        A('animal_1'), A('animal_2', { gender: 1, medal: 'gold' }), A('animal_3', { auctionTimerSeconds: 99 }),
        A('animal_4', { species: 'Zebra', maturity: 0, medal: 'bronze' }), A('animal_5', { species: 'Zebra', gender: 1, maturity: 6 }),
    ], new Map(), advise);
    const c = speciesCounts(rows);
    assert.deepEqual(c.map(x => [x.species, x.total, x.sellable, x.listed]), [['Lion', 3, 2, 1], ['Zebra', 2, 0, 0]]);
    assert.equal(filterRows(rows, { species: 'Lion', sex: 'female', age: 'any', medal: 'any', state: 'any' }).length, 1);
    assert.equal(filterRows(rows, { species: null, sex: 'any', age: 'any', medal: 'gold', state: 'any' }).length, 1);
    assert.equal(filterRows(rows, { species: null, sex: 'any', age: 'any', medal: 'silver', state: 'any' }).length, 4);   // silver or better (the elderly zebra is silver too)
    assert.equal(filterRows(rows, { species: null, sex: 'any', age: 'fertile', medal: 'any', state: 'any' }).length, 3);  // not the juvenile or the elderly-infertile
    assert.equal(filterRows(rows, { species: null, sex: 'any', age: 'any', medal: 'any', state: 'sellable' }).length, 2);
    assert.equal(filterRows(rows, { species: null, sex: 'any', age: 'any', medal: 'any', state: 'listed' }).length, 1);
    assert.equal(filterRows(rows, { species: null, sex: 'any', age: 'any', medal: 'any', state: 'blocked' }).length, 2);
    // sellable first
    assert.equal(sortRows(rows)[0].block, null);
    assert.ok(sortRows(rows).slice(-1)[0].block);
});

test('job text: header, one line per listable animal, no price as "-"', () => {
    const rows = deskRows([
        A('animal_1'), A('animal_2', { name: 'Lnoprice' }), A('animal_3', { auctionTimerSeconds: 9 }), A('animal_4'),
    ], new Map([['animal_1', '11'], ['animal_2', '22'], ['animal_3', '33']]), advise);
    const { text, items } = encodeJob(rows, { paceMs: 2500, hours: 'max' });
    assert.equal(text, 'v1 2500\n11 animal_1 1000 max\n22 animal_2 - max');
    assert.deepEqual(items.map(r => r.guid), ['11', '22']);                    // listed and GUID-less rows left out
    assert.equal(encodeJob(rows, { paceMs: 200, hours: 6.4 }).text.split('\n')[0], 'v1 1000');   // pace never under 1 s
    assert.ok(encodeJob(rows, { hours: 6.4 }).text.endsWith('22 animal_2 - 6'));
    // odd keys or GUIDs never reach the engine (a space would break the line)
    const odd = deskRows([A('animal 9'), A('animal_8'), A('animal_7')], new Map([['animal 9', '9'], ['animal_8', '8 5'], ['animal_7', 'ab-12']]), advise);
    assert.deepEqual(encodeJob(odd).items.map(r => r.guid), ['ab-12']);
});

test('state: normalised, tallied, summed up, retry list', () => {
    const s = normalizeState({
        run: 3, req: 'R1', phase: 'stopped', index: 4,
        results: [
            { guid: 1, status: 'listed', price: 1200 }, { guid: 2, status: 'listed', price: 800 },
            { guid: 3, status: 'skipped', kind: 'untradeable', detail: '[AnimalList_Problem_Pregnant]' },
            { guid: 4, status: 'refused', kind: 'refused', detail: 'NotAllowed' },
            { guid: 5, status: 'timeout', kind: 'timeout' }, { guid: 6, status: 'pending' }, { status: 'listed' },
        ],
    });
    assert.equal(s.results.length, 6);
    assert.equal(s.results[0].guid, '1');
    const tl = tally(s);
    assert.deepEqual([tl.total, tl.listed, tl.skipped, tl.refused, tl.timeout, tl.pending, tl.earned], [6, 2, 1, 1, 1, 1, 2000]);
    assert.equal(summaryText(s), "Listed 2 of 6 (≈ 2000 CC asked); not listed 3 (1 the game doesn't allow trading it, 1 refused by the server, 1 no confirmation in time); 1 not started.");
    assert.deepEqual(retryGuids(s), ['4', '5', '6']);
    assert.equal(normalizeState(null), null);
    assert.equal(summaryText(normalizeState({ results: [] })), 'Nothing to list.');
});

test('time left', () => {
    assert.equal(timeLeftText(-1), '');
    assert.equal(timeLeftText(30), '<1m left');
    assert.equal(timeLeftText(45 * 60), '45m left');
    assert.equal(timeLeftText(7 * 3600 + 20 * 60), '7h 20m left');
    assert.equal(timeLeftText(12 * 3600), '12h left');
});

// genes as fractions: one number for all four, or per gene
const G = (v, o = {}) => Object.assign({ size: v, longevity: v, fertility: v, immunity: v }, o);

test('gene range: keep the best, sell the rest (0-50)', () => {
    const rows = deskRows([
        A('animal_1', { genes: G(0.3) }), A('animal_2', { genes: G(0.5) }), A('animal_3', { genes: G(0.51) }),
        A('animal_4', { genes: G(0.9) }), A('animal_5', { genes: {} }),
    ], new Map(), advise);
    const names = f => filterRows(rows, f).map(r => r.key).sort();
    assert.deepEqual(names({ geneMin: 0, geneMax: 50 }), ['animal_1', 'animal_2']);         // 50 is in; unknown genes out
    assert.deepEqual(names({ geneMin: 51, geneMax: 100 }), ['animal_3', 'animal_4']);
    assert.equal(filterRows(rows, {}).length, 5);                                              // the full range filters nothing, unknown genes too
    // one gene as the basis
    const fert = deskRows([A('animal_1', { genes: G(0.9, { fertility: 0.2 }) }), A('animal_2', { genes: G(0.2, { fertility: 0.9 }) })], new Map(), advise);
    assert.deepEqual(filterRows(fert, { geneBasis: 'fertility', geneMax: 40 }).map(r => r.key), ['animal_1']);
    assert.deepEqual(filterRows(fert, { geneMax: 40 }).map(r => r.key), ['animal_2']);
    // per-gene ranges under "More filters"
    assert.deepEqual(filterRows(fert, { fertilityMin: 50 }).map(r => r.key), ['animal_2']);
    assert.deepEqual(filterRows(fert, { sizeMin: 50, fertilityMax: 50 }).map(r => r.key), ['animal_1']);
    // exhibit animals have no size gene: a size range leaves them out
    const ex = deskRows([A('animal_1', { isExhibit: true, genes: G(0.8) })], new Map(), advise);
    assert.equal(filterRows(ex, { sizeMin: 10 }).length, 0);
    assert.equal(filterRows(ex, { longevityMin: 10 }).length, 1);
    assert.equal(basisScore(ex[0], 'size'), null);
});

test('ages, fertility, ratings, pregnancy, tags, price, name', () => {
    const rows = deskRows([
        A('animal_1', { maturity: 1 }), A('animal_2', { maturity: 2, medal: 'gold' }), A('animal_3', { maturity: 5, medal: 'none' }),
        A('animal_4', { maturity: 3, isPregnant: true, storageTag: 4 }), A('animal_5', { maturity: 0, storageTag: 1, name: 'Simba' }),
    ], new Map(), a => ({ price: a.maturity * 1000, confidence: 'high', reason: '' }));
    const keys = f => filterRows(rows, f).map(r => r.key);
    assert.deepEqual(keys({ ages: ['young', 'elderly'] }), ['animal_1', 'animal_4']);
    assert.deepEqual(keys({ ages: ['adult'] }), ['animal_2', 'animal_3']);            // adult, fertile or not
    assert.deepEqual(keys({ fertile: 'no' }), ['animal_3', 'animal_5']);
    assert.deepEqual(keys({ fertile: 'yes', ages: ['adult'] }), ['animal_2']);
    assert.deepEqual(keys({ medals: ['gold', 'none'] }), ['animal_2', 'animal_3']);
    assert.deepEqual(keys({ pregnant: 'only' }), ['animal_4']);
    assert.equal(keys({ pregnant: 'hide' }).length, 4);
    assert.deepEqual(keys({ tags: [0] }), ['animal_1', 'animal_2', 'animal_3']);   // no tag
    assert.deepEqual(keys({ tags: [1, 4] }), ['animal_4', 'animal_5']);
    assert.deepEqual(keys({ priceMin: 2000, priceMax: 3000 }), ['animal_2', 'animal_4']);
    assert.deepEqual(keys({ priceMax: 1500 }), ['animal_1']);                         // no price (0) is not "at most 1,500"
    assert.deepEqual(keys({ text: 'simB' }), ['animal_5']);
    // Kin: only when Kin knows storage
    assert.deepEqual(filterRows(rows, { kin: 'related' }, { related: a => a.key === 'animal_2' }).map(r => r.key), ['animal_2']);
    assert.equal(filterRows(rows, { kin: 'unrelated' }, { related: a => a.key === 'animal_2' }).length, 4);
    assert.equal(filterRows(rows, { kin: 'related' }).length, 5);
    // Tick all leaves Keep-tagged animals alone unless asked for
    const kept = rows.find(r => r.key === 'animal_4');
    assert.equal(tickable(kept, normalizeFilters({})), false);
    assert.equal(tickable(kept, normalizeFilters({ tags: [4] })), true);
    assert.equal(tickable(rows.find(r => r.key === 'animal_5')), false);          // juvenile: blocked
});

test('keep the best N per species and sex: the rest are the cull candidates', () => {
    const rows = deskRows([
        A('animal_1', { genes: G(0.9) }), A('animal_2', { genes: G(0.7) }), A('animal_3', { genes: G(0.4) }), A('animal_4', { genes: G(0.2) }),
        A('animal_5', { gender: 1, genes: G(0.3) }), A('animal_6', { gender: 1, genes: G(0.6) }),
        A('animal_7', { genes: G(0.1), auctionTimerSeconds: 900 }),                     // listed: leaving, not kept, not counted
        A('animal_8', { species: 'Zebra', genes: G(0.1) }),
    ], new Map(), advise);
    assert.deepEqual(Array.from(beyondBest(rows, 2)).map(id => id.split('|')[0]).sort(), ['kanimal_3', 'kanimal_4']);
    assert.deepEqual(filterRows(rows, { keepBest: 1 }).map(r => r.key).sort(), ['animal_2', 'animal_3', 'animal_4', 'animal_5']);
    assert.deepEqual(filterRows(rows, { keepBest: 1, species: 'Lion', sex: 'female' }).map(r => r.key), ['animal_5']);
    // a juvenile (or elderly infertile) never takes a kept place
    const young = deskRows([
        A('animal_1', { gender: 1, genes: G(0.95), maturity: 0 }), A('animal_2', { gender: 1, genes: G(0.8) }), A('animal_3', { gender: 1, genes: G(0.5) }),
        A('animal_4', { gender: 1, genes: G(0.99), maturity: 6 }),
    ], new Map(), advise);
    assert.deepEqual(filterRows(young, { keepBest: 1 }).map(r => r.key), ['animal_3']);
    // by fertility instead
    const fert = deskRows([A('animal_1', { genes: G(0.9, { fertility: 0.1 }) }), A('animal_2', { genes: G(0.1, { fertility: 0.9 }) })], new Map(), advise);
    assert.deepEqual(filterRows(fert, { keepBest: 1, geneBasis: 'fertility' }).map(r => r.key), ['animal_1']);
});

test('sort, normalise, counts, reset', () => {
    const rows = deskRows([
        A('animal_1', { genes: G(0.5), name: 'B' }), A('animal_2', { genes: G(0.9), name: 'C' }), A('animal_3', { genes: G(0.1), name: 'A' }),
        A('animal_4', { genes: G(1), maturity: 0 }),
    ], new Map(), a => ({ price: Math.round(a.genes.size * 1000), confidence: 'high', reason: '' }));
    assert.deepEqual(sortRows(rows, 'best').map(r => r.key), ['animal_2', 'animal_1', 'animal_3', 'animal_4']);   // blocked last
    assert.deepEqual(sortRows(rows, 'worst').map(r => r.key), ['animal_3', 'animal_1', 'animal_2', 'animal_4']);
    assert.deepEqual(sortRows(rows, 'name').map(r => r.key), ['animal_3', 'animal_1', 'animal_2', 'animal_4']);
    assert.deepEqual(sortRows(rows, 'price').map(r => r.key), ['animal_2', 'animal_1', 'animal_3', 'animal_4']);
    const n = normalizeFilters({ geneMin: 80, geneMax: 20, sex: 'x', medals: ['gold', 'shiny', 'gold'], tags: ['4', 9], keepBest: -3, sort: 'zzz', priceMin: 900, priceMax: 100 });
    assert.equal(n.geneMin, 20);
    assert.equal(n.geneMax, 80);
    assert.equal(n.sex, 'any');
    assert.deepEqual(n.medals, ['gold']);
    assert.deepEqual(n.tags, [4]);
    assert.equal(n.keepBest, 0);
    assert.equal(n.sort, 'best');
    assert.equal(n.priceMax, 900);
    assert.deepEqual(normalizeFilters(null), Object.assign({}, DESK_FILTERS, { ages: [], medals: [], tags: [] }));
    assert.deepEqual(activeFilterCount(normalizeFilters({})), { main: 0, more: 0, total: 0 });
    assert.deepEqual(activeFilterCount(normalizeFilters({ geneMax: 50, sex: 'male', sizeMin: 10, sizeMax: 90, pregnant: 'hide', text: '  ' })), { main: 2, more: 2, total: 4 });
    const r = resetFilters(normalizeFilters({ species: 'Lion', sort: 'worst', geneMax: 50, keepBest: 3 }));
    assert.equal(r.species, 'Lion');
    assert.equal(r.sort, 'worst');
    assert.equal(r.geneMax, 100);
    assert.equal(r.keepBest, 0);
});

import { encodeSeen, readSeen, SEEN_LIMITS } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/listercore.js';

test('page reports for the engine: what the DataStore shows, as plain text', () => {
    const store = {
        'hubAnimalsData/animalStorageData': { selectedAnimalIDs: ['animal_3'] },
        'hubAnimalsData/animalStorageData/actions': { tradeAllowed: true, tradeDisallowedReason: '' },
        animalTradeListingData: { tradePriceMin: 100, tradePriceMax: 5000, tradePriceDefault: 812.5, tradeDurationMin: 1, tradeDurationMax: 12, tradeDurationDefault: 6 },
    };
    const read = (c, p) => (store[c.join('/')] || {})[p];
    const s = readSeen('animal_3', read);
    assert.deepEqual(s.sel, ['animal_3']);
    assert.equal(s.allowed, true);
    assert.equal(SEEN_LIMITS.length, 6);
    assert.equal(encodeSeen(s), 'v1|animal_3|animal_3|1|100,5000,812.5,1,12,6|');
    // nothing selected, not allowed with a reason that holds pipes, limits missing
    store['hubAnimalsData/animalStorageData'].selectedAnimalIDs = [];
    store['hubAnimalsData/animalStorageData/actions'] = { tradeAllowed: false, tradeDisallowedReason: '[STRING_LITERAL:Value=|Pregnant|]\n' };
    store.animalTradeListingData = { tradePriceMin: NaN, tradePriceMax: '5000' };
    assert.equal(encodeSeen(readSeen('animal_3', read)), 'v1|animal_3||0|-,-,-,-,-,-|[STRING_LITERAL:Value=|Pregnant|] ');
    // unreadable selection and data; a read that throws; odd ids
    assert.equal(encodeSeen(readSeen('animal_3', () => undefined)), 'v1|animal_3|?|-|-,-,-,-,-,-|');
    assert.equal(encodeSeen(readSeen('animal_3', () => { throw new Error('x'); })), 'v1|animal_3|?|-|-,-,-,-,-,-|');
    store['hubAnimalsData/animalStorageData'].selectedAnimalIDs = ['animal_3', 7, null, 'a|b,c d'];
    assert.equal(readSeen('animal_3', read).sel.length, 3);
    assert.ok(encodeSeen(readSeen('animal_3', read)).startsWith('v1|animal_3|animal_3,7,abcd|0|'));
});
