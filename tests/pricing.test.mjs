// node --test tests/pricing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Gender, Maturity } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/scores.js';
import {
    comparables, fitPriceVsScore, lifeStage, listingKey, median, mergeListings, nicePrice, recommendPrice, speciesMarketSummary,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/pricing.js';

const g = s => ({ size: s / 100, longevity: s / 100, fertility: s / 100, immunity: s / 100 });
const listing = (id, over = {}) => Object.assign({
    id, species: 'Lion', gender: Gender.Male, maturity: Maturity.Adult, isShoal: false,
    score: 60, price: 1000, isCC: true, source: 'market', seenAt: 0,
}, over);
const animal = (over = {}) => Object.assign({
    id: 'mine', species: 'Lion', gender: Gender.Male, maturity: Maturity.Adult, isShoal: false, isExhibit: false, genes: g(60),
}, over);

test('median and nicePrice', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([]), null);
    assert.equal(nicePrice(123), 125);
    assert.equal(nicePrice(1234), 1230);
    assert.equal(nicePrice(12340), 12350);
    assert.equal(nicePrice(2), 5);
});

test('lifeStage groups young adults with adults', () => {
    assert.equal(lifeStage(Maturity.Infant), 'juvenile');
    assert.equal(lifeStage(Maturity.YoungAdult), 'adult');
    assert.equal(lifeStage(Maturity.Elderly), 'elderly');
});

test('fitPriceVsScore recovers a linear trend and ignores an outlier', () => {
    const pts = [40, 50, 60, 70, 80].map(s => ({ score: s, price: 200 + 10 * s }));
    pts.push({ score: 55, price: 5000 });
    const fit = fitPriceVsScore(pts);
    assert.ok(Math.abs(fit.slope - 10) < 0.01);
    assert.ok(Math.abs(fit.predict(65) - 850) < 1);
});

test('fitPriceVsScore never gives a negative slope', () => {
    const pts = [40, 50, 60, 70].map(s => ({ score: s, price: 2000 - 10 * s }));
    assert.equal(fitPriceVsScore(pts).slope, 0);
});

test('comparables prefer same sex and age group, CC only, same species', () => {
    const book = [
        listing('a'), listing('b'), listing('c'),
        listing('d', { gender: Gender.Female }),
        listing('e', { isCC: false }),
        listing('f', { species: 'Tiger' }),
        listing('g', { maturity: Maturity.Infant }),
    ];
    const c = comparables(animal(), book);
    assert.equal(c.tier, 1);
    assert.deepEqual(c.list.map(l => l.id), ['a', 'b', 'c']);
    const female = comparables(animal({ gender: Gender.Female }), book);
    assert.equal(female.tier, 3);
    assert.equal(female.list.length, 5);
    assert.equal(comparables(animal({ species: 'Okapi' }), book).tier, 0);
});

test('recommendPrice follows the gene trend and undercuts slightly', () => {
    const book = [40, 50, 60, 70, 80, 55, 65].map((s, i) => listing('m' + i, { score: s, price: 200 + 10 * s }));
    const r = recommendPrice(animal({ genes: g(75) }), book, { defaultPrice: 900, min: 10, max: 10000 });
    // fitted 950, -3% = 921.5, 7 comps -> full market weight, nice price
    assert.equal(r.method, 'fit');
    assert.equal(r.confidence, 'high');
    assert.equal(r.price, 920);
});

test('recommendPrice blends with the game value when data is thin', () => {
    const book = [listing('a', { score: 60, price: 1000 })];
    const r = recommendPrice(animal(), book, { defaultPrice: 400 });
    // market 970 (median, -3%), weight 1/6 -> 970/6 + 400*5/6 = 495
    assert.equal(r.confidence, 'low');
    assert.equal(r.price, 495);
});

test('recommendPrice falls back to the game value and respects limits', () => {
    assert.equal(recommendPrice(animal(), [], { defaultPrice: 777 }).price, 780);
    assert.equal(recommendPrice(animal(), [], { defaultPrice: 777, max: 500 }).price, 500);
    assert.equal(recommendPrice(animal(), [], { defaultPrice: 3, min: 10 }).price, 10);
    const none = recommendPrice(animal(), [], {});
    assert.equal(none.price, null);
    assert.equal(none.confidence, 'none');
});

test('recommendPrice stays within the range the comparables span', () => {
    const book = [listing('a', { price: 1000, score: 50 }), listing('b', { price: 1100, score: 52 }), listing('c', { price: 1050, score: 51 })];
    const r = recommendPrice(animal({ genes: g(100) }), book, {});
    assert.ok(r.price <= 1100 * 1.25);
});

test('speciesMarketSummary splits by sex and keeps own sales apart', () => {
    const book = [
        listing('a', { price: 1000 }), listing('b', { price: 1200 }),
        listing('c', { gender: Gender.Female, price: 1500, score: 70 }),
        listing('d', { source: 'history', price: 900 }),
        listing('e', { maturity: Maturity.Infant, price: 300 }),
    ];
    const s = speciesMarketSummary('Lion', book);
    assert.equal(s.male.count, 3);
    assert.equal(s.male.median, 1000);
    assert.equal(s.female.count, 1);
    assert.equal(s.female.medianScore, 70);
    assert.equal(s.juvenile.count, 1);
    assert.equal(s.history.count, 1);
});

test('mergeListings dedupes by id, refreshes, and expires', () => {
    let book = mergeListings([], [listing('a', { price: 100 })], 1000);
    book = mergeListings(book, [listing('a', { price: 120 }), listing('b')], 2000);
    assert.equal(book.length, 2);
    assert.equal(book.find(l => l.id == 'a').price, 120);
    book = mergeListings(book, [], 2000 + 13 * 3600 * 1000);
    assert.equal(book.length, 0);
    assert.equal(mergeListings([], [listing('x', { price: 0 })], 0).length, 0);
});

// Nexus bug #1151539: market and history row ids are screen slots, reused on
// every page, so keying the book by them kept only the last page (~12 rows).
test('listingKey keeps listings from different pages that share slot ids', () => {
    const row = (slot, over) => Object.assign({
        id: slot, species: 'Lion', name: 'Leo', gender: Gender.Male, maturity: Maturity.Adult,
        isShoal: false, isExhibit: false, genes: g(60), price: 1000, isCC: true,
    }, over);
    const page = (n, prices) => prices.map((p, i) => row('animal_' + i, { name: `Leo ${n}-${i}`, price: p }));
    const toListing = a => Object.assign({}, a, { id: listingKey(a), source: 'market' });
    let book = mergeListings([], page(1, Array(12).fill(1000)).map(toListing), 1000);
    book = mergeListings(book, page(2, Array(12).fill(1200)).map(toListing), 2000);
    assert.equal(book.length, 24);
    // Seeing the same listing again refreshes it instead of adding a copy.
    book = mergeListings(book, page(1, Array(12).fill(1000)).map(toListing), 3000);
    assert.equal(book.length, 24);
    // Unpriced or species-less rows have no key and are not recorded.
    assert.equal(listingKey(row('animal_0', { price: 0 })), undefined);
    assert.equal(listingKey(row('animal_0', { species: undefined })), undefined);
    assert.notEqual(listingKey(row('a', { genes: g(61) })), listingKey(row('a')));
});

test('comparables leave out the own market listing of a storage animal', () => {
    const mine = animal({ name: 'Leo', price: 900, isCC: true });
    const own = Object.assign({}, mine, { id: listingKey(mine), score: 60, source: 'market' });
    const other = listing(listingKey(animal({ name: 'Rex', price: 1000, isCC: true })));
    const comp = comparables(mine, [own, other]);
    assert.deepEqual(comp.list.map(l => l.id), [other.id]);
});

test('recommendPrice applies the player offset after pricing, before rounding and limits', async () => {
    const { offsetLabel } = await import('../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/pricing.js');
    const base = recommendPrice(animal(), [], { defaultPrice: 1000 });
    assert.equal(base.price, 1000);
    assert.equal(base.offset, 0);
    const under = recommendPrice(animal(), [], { defaultPrice: 1000 }, { offset: -0.1 });
    assert.equal(under.price, 900);
    assert.equal(under.basePrice, 1000);
    assert.match(under.reason, /offset/);
    assert.equal(recommendPrice(animal(), [], { defaultPrice: 1000 }, { offset: 0.2 }).price, 1200);
    // the game's limits still win
    assert.equal(recommendPrice(animal(), [], { defaultPrice: 1000, max: 1100 }, { offset: 0.2 }).price, 1100);
    assert.equal(recommendPrice(animal(), [], { defaultPrice: 100, min: 95 }, { offset: -0.5 }).price, 95);
    // other defaults stay when only the offset is passed
    const book = [40, 50, 60, 70, 80, 55, 65].map((s, i) => listing('l' + i, { score: s, price: 500 + 10 * s }));
    const plain = recommendPrice(animal({ genes: g(60) }), book, {});
    const off = recommendPrice(animal({ genes: g(60) }), book, {}, { offset: -0.1 });
    assert.equal(off.basePrice, plain.price);
    assert.ok(off.price < plain.price);
    assert.equal(offsetLabel(-0.1), '−10%');
    assert.equal(offsetLabel(0.2), '+20%');
    assert.equal(offsetLabel(0), '');
});
