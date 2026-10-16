// Storage filter extension point (scores.js): flags other modules back with
// a predicate, e.g. Kin's `related` ("Kin" chip in Animal Storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStorageFilters, DEFAULT_STORAGE_FILTERS, storageFiltersActive } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/scores.js';

const f = over => Object.assign({}, DEFAULT_STORAGE_FILTERS, over);
const herd = [
    { id: 'a', gender: 0, maturity: 2, genes: { size: 0.9, longevity: 0.9, fertility: 0.9, immunity: 0.9 } },
    { id: 'b', gender: 1, maturity: 2, genes: { size: 0.2, longevity: 0.2, fertility: 0.2, immunity: 0.2 } },
    { id: 'c', gender: 1, maturity: 0, genes: { size: 0.5, longevity: 0.5, fertility: 0.5, immunity: 0.5 } },
];
const ids = list => list.map(a => a.id);

test('related is off by default and counts as an active filter', () => {
    assert.equal(DEFAULT_STORAGE_FILTERS.related, false);
    assert.equal(storageFiltersActive(f({})), false);
    assert.equal(storageFiltersActive(f({ related: true })), true);
});

test('a predicate applies only while its flag is on', () => {
    const related = new Set(['a', 'c']);
    const predicates = { related: a => related.has(a.id) };
    assert.deepEqual(ids(applyStorageFilters(herd, f({}), predicates)), ['a', 'b', 'c']);
    assert.deepEqual(ids(applyStorageFilters(herd, f({ related: true }), predicates)), ['a', 'c']);
    // combines with the built-in filters and sorts
    assert.deepEqual(ids(applyStorageFilters(herd, f({ related: true, adults: true }), predicates)), ['a']);
    assert.deepEqual(ids(applyStorageFilters(herd, f({ related: true, sort: 'gene' }), predicates)), ['a', 'c']);
});

test('a flag without a predicate filters nothing (Kin off or no data yet)', () => {
    assert.deepEqual(ids(applyStorageFilters(herd, f({ related: true }))), ['a', 'b', 'c']);
    assert.deepEqual(ids(applyStorageFilters(herd, f({ related: true }), {})), ['a', 'b', 'c']);
});
