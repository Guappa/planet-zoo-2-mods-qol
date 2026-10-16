// node --test tests/zoo.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyZooFilters, DEFAULT_ZOO_FILTERS, Gender, habitatCounts, Maturity, zooFiltersActive } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/scores.js';

const g = s => ({ size: s / 100, longevity: s / 100, fertility: s / 100, immunity: s / 100 });
const a = (id, over = {}) => Object.assign({
    id, species: 'Lion', gender: Gender.Male, maturity: Maturity.Adult, isPregnant: false, isAlpha: false,
    contracepted: false, welfare: 0.8, habitat: 'Savannah', genes: g(60),
}, over);
const zoo = [
    a('l1'), a('l2', { gender: Gender.Female, isPregnant: true, genes: g(85) }),
    a('l3', { maturity: Maturity.Infant, welfare: 0.2 }),
    a('t1', { species: 'Tiger', habitat: 'Jungle', contracepted: true, genes: g(30) }),
    a('t2', { species: 'Tiger', habitat: 'Jungle', isAlpha: true, welfare: 0.5, genes: { size: 0.9, longevity: 0.9, fertility: 0.2, immunity: 0.9 } }),
];
const f = over => Object.assign({}, DEFAULT_ZOO_FILTERS, over);
const ids = list => list.map(x => x.id);

test('zoo filters: habitat, sex, stage, flags', () => {
    assert.equal(zooFiltersActive(f({})), false);
    assert.deepEqual(ids(applyZooFilters(zoo, f({ habitat: 'Jungle' }))), ['t1', 't2']);
    assert.deepEqual(ids(applyZooFilters(zoo, f({ sex: 'female' }))), ['l2']);
    assert.deepEqual(ids(applyZooFilters(zoo, f({ stage: 'juvenile' }))), ['l3']);
    assert.deepEqual(ids(applyZooFilters(zoo, f({ pregnant: true }))), ['l2']);
    assert.deepEqual(ids(applyZooFilters(zoo, f({ alpha: true }))), ['t2']);
    assert.deepEqual(ids(applyZooFilters(zoo, f({ contracepted: true }))), ['t1']);
    assert.deepEqual(ids(applyZooFilters(zoo, f({ unhappy: true }))), ['l3']);
});

test('zoo filters: genes and combinations', () => {
    assert.deepEqual(ids(applyZooFilters(zoo, f({ minScore: 70 }))), ['l2', 't2']);
    assert.deepEqual(ids(applyZooFilters(zoo, f({ minFertility: 50 }))), ['l1', 'l2', 'l3']);
    assert.deepEqual(ids(applyZooFilters(zoo, f({ habitat: 'Jungle', minScore: 50 }))), ['t2']);
});

test('zoo sort: gene desc, welfare worst first', () => {
    assert.equal(ids(applyZooFilters(zoo, f({ sort: 'gene' })))[0], 'l2');
    assert.deepEqual(ids(applyZooFilters(zoo, f({ sort: 'welfare' }))).slice(0, 2), ['l3', 't2']);
});

test('habitatCounts', () => {
    assert.deepEqual(habitatCounts(zoo), [{ name: 'Savannah', count: 3 }, { name: 'Jungle', count: 2 }]);
});

test('zoo kin filter and sort', () => {
    const list = [
        a('p1', { kinSeverity: 'covered', kinCluster: 'B' }),
        a('p2'),
        a('p3', { kinSeverity: 'risk', kinCluster: 'A' }),
        a('p4', { kinSeverity: 'kin', kinCluster: 'C' }),
        a('p5', { kinSeverity: 'future', kinCluster: 'A' }),
        a('p6', { kinSeverity: 'risk', kinCluster: 'A' }),
    ];
    assert.equal(zooFiltersActive(f({ kin: 'risk' })), true);
    assert.equal(zooFiltersActive(Object.assign({}, DEFAULT_ZOO_FILTERS, { kin: undefined })), false);
    assert.deepEqual(ids(applyZooFilters(list, f({ kin: 'risk' }))), ['p3', 'p6']);
    assert.deepEqual(ids(applyZooFilters(list, f({ kin: 'any' }))), ['p3', 'p4', 'p5', 'p6']);
    // cluster A (worst: risk) together first, then C (kin), B (covered), then unrelated
    assert.deepEqual(ids(applyZooFilters(list, f({ sort: 'kin' }))), ['p3', 'p5', 'p6', 'p4', 'p1', 'p2']);
});
