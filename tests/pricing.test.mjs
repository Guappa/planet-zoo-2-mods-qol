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

// Genetics medals (the market's Rating column, row field `ratings`).
test('medalOf reads the game value, ignores shoals and unknown values', async () => {
    const { medalOf, medalLabel } = await import('../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/pricing.js');
    assert.equal(medalOf({ medal: 'gold' }), 'gold');
    assert.equal(medalOf({ medal: 'Silver' }), 'silver');
    assert.equal(medalOf({ medal: 'none' }), 'none');
    assert.equal(medalOf({ medal: 'platinum' }), undefined);
    assert.equal(medalOf({}), undefined);
    assert.equal(medalOf({ medal: 'gold', isShoal: true }), undefined);
    assert.equal(medalLabel('none'), 'Unranked');
});

const medalBook = () => [
    ...[1180, 1200, 1220, 1240].map((p, i) => listing('s' + i, { medal: 'silver', price: p, score: 60 + i })),
    ...[1900, 2000, 2100, 2200].map((p, i) => listing('g' + i, { medal: 'gold', price: p, score: 64 + i })),
    ...[700, 800].map((p, i) => listing('b' + i, { medal: 'bronze', price: p, score: 50 + i })),
];

test('comparables prefer listings with the same medal, sex and age group', () => {
    const c = comparables(animal({ medal: 'silver' }), medalBook());
    assert.equal(c.medalMode, 'same');
    assert.equal(c.medal, 'silver');
    assert.deepEqual(c.list.map(l => l.id), ['s0', 's1', 's2', 's3']);
    const r = recommendPrice(animal({ medal: 'silver', genes: g(61) }), medalBook(), {});
    // the silver median (1,210) less 3%, not dragged up by the gold listings
    assert.ok(r.price >= 1150 && r.price <= 1200, `price ${r.price}`);
    assert.match(r.reason, /^4 Silver adult males: median 1,210 CC/);
    assert.equal(r.medal, 'silver');
    const fem = recommendPrice(animal({ medal: 'silver', gender: Gender.Female }), medalBook().map(l => Object.assign(l, { gender: Gender.Female })), {});
    assert.match(fem.reason, /^4 Silver adult females/);
});

test('too few of the medal: other medals scaled by the observed price ratio', () => {
    // one gold lion; silver lions; the gold/silver ratio comes from tigers (3000/2000)
    const book = [
        listing('g0', { medal: 'gold', price: 1600, score: 70 }),
        ...[1000, 1000, 1000].map((p, i) => listing('s' + i, { medal: 'silver', price: p, score: 60 })),
        ...[3000, 3000].map((p, i) => listing('tg' + i, { species: 'Tiger', medal: 'gold', price: p })),
        ...[2000, 2000].map((p, i) => listing('ts' + i, { species: 'Tiger', medal: 'silver', price: p })),
    ];
    const c = comparables(animal({ medal: 'gold' }), book);
    assert.equal(c.medalMode, 'scaled');
    assert.equal(c.sameCount, 1);
    assert.equal(c.guessed, false);
    assert.equal(c.factors.silver.source, 'all species');
    assert.ok(Math.abs(c.factors.silver.factor - 1.5) < 1e-9);
    const scaled = c.list.find(l => l.id == 's0');
    assert.equal(scaled.price, 1500);
    assert.equal(scaled.rawPrice, 1000);
    const r = recommendPrice(animal({ medal: 'gold', genes: g(70) }), book, {});
    assert.match(r.reason, /^Only 1 Gold listed among adult males; with 3 Silver at median 1,000 CC ×1\.50 \(ratio from all species\): median 1,500 CC/);
    // learned ratio, 4 comparables: medium at best
    assert.equal(r.confidence, 'medium');
    // a higher medal scales down: a silver animal among gold lions
    const down = comparables(animal({ medal: 'silver' }), [
        listing('x', { medal: 'silver', price: 1000 }),
        ...[1600, 1600].map((p, i) => listing('g' + i, { medal: 'gold', price: p })),
        listing('y', { medal: 'silver', price: 1000 }),
    ]);
    // same group has 2 silver and 2 gold: the ratio comes from it
    assert.equal(down.medalMode, 'scaled');
    assert.equal(down.factors.gold.source, 'this sex and age group');
    assert.ok(Math.abs(down.factors.gold.factor - 1 / 1.6) < 1e-9);
});

test('a better medal is never priced lower than the worse one', async () => {
    const { medalStepRatio, medalRatio } = await import('../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/pricing.js');
    const list = [listing('a', { medal: 'gold', price: 500 }), listing('b', { medal: 'gold', price: 500 }),
        listing('c', { medal: 'silver', price: 900 }), listing('d', { medal: 'silver', price: 900 })];
    assert.equal(medalStepRatio('gold', [{ list, source: 'x' }], list).ratio, 1);
    assert.equal(medalStepRatio('none', [{ list, source: 'x' }], list), null);
    assert.equal(medalRatio('silver', 'gold', [{ list, source: 'x' }], list).ratio, 1);
    assert.equal(medalRatio('gold', 'platinum', [], []), null);
    assert.equal(medalRatio('gold', 'gold', [], []).ratio, 1);
});

// The developer's case: a Gold animal and no Gold listings at all.
test('no gold listed and no ratio in the book: default medal ladder, low confidence, says so', async () => {
    const { DEFAULT_MEDAL_VALUE, medalRatio } = await import('../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/pricing.js');
    assert.equal(DEFAULT_MEDAL_VALUE.gold / DEFAULT_MEDAL_VALUE.bronze, 3);
    assert.equal(DEFAULT_MEDAL_VALUE.silver / DEFAULT_MEDAL_VALUE.bronze, 1.6);
    const silver = [380, 400, 420, 400].map((p, i) => listing('s' + i, { medal: 'silver', price: p }));
    const c = comparables(animal({ medal: 'gold' }), silver);
    assert.equal(c.medalMode, 'scaled');
    assert.equal(c.sameCount, 0);
    assert.equal(c.guessed, true);
    assert.ok(Math.abs(c.factors.silver.factor - 3 / 1.6) < 1e-9);
    assert.equal(c.factors.silver.source, 'default guess');
    const r = recommendPrice(animal({ medal: 'gold' }), silver, {});
    // 400 x 1.875 = 750, -3% = 727.5 -> 730; the old code priced it like the silver ones (~390)
    assert.equal(r.price, 730);
    assert.equal(r.confidence, 'low');
    assert.match(r.reason, /^No Gold listed among adult males; 4 Silver at median 400 CC ×1\.88 \(guessed ratio\): median 750 CC/);
    // only bronze listed: two default steps, 3x
    const bronze = [200, 200, 200].map((p, i) => listing('b' + i, { medal: 'bronze', price: p }));
    const fromBronze = recommendPrice(animal({ medal: 'gold' }), bronze, {});
    assert.equal(fromBronze.comps.factors.bronze.factor, 3);
    assert.equal(fromBronze.price, 580);
    // nearest medal first: with silver and bronze listed, gold uses silver only
    const both = comparables(animal({ medal: 'gold' }), silver.concat(bronze));
    assert.deepEqual(Object.keys(both.factors), ['silver']);
    // a learned step beats the default; the missing step stays a guess
    const tigers = [...[1000, 1000].map((p, i) => listing('tb' + i, { species: 'Tiger', medal: 'bronze', price: p })),
        ...[1200, 1200].map((p, i) => listing('ts' + i, { species: 'Tiger', medal: 'silver', price: p }))];
    const chained = medalRatio('bronze', 'gold', [], tigers);
    assert.ok(Math.abs(chained.ratio - 1.2 * 1.875) < 1e-9);
    assert.equal(chained.source, 'all species + default guess');
    assert.equal(chained.guessed, true);
});

test('few of the medal in this sex: same medal of any sex comes before scaling', () => {
    const book = [
        ...[2000, 2100, 2200].map((p, i) => listing('gf' + i, { medal: 'gold', gender: Gender.Female, price: p })),
        ...[800, 800, 800, 800].map((p, i) => listing('sm' + i, { medal: 'silver', price: p })),
    ];
    const c = comparables(animal({ medal: 'gold' }), book);
    assert.equal(c.medalMode, 'same');
    assert.equal(c.tier, 2);
    const r = recommendPrice(animal({ medal: 'gold' }), book, {});
    assert.match(r.reason, /^3 Gold adult animals: median 2,100 CC/);
});

test('appeal adjusts the price within a medal', async () => {
    const { appealAdjustment } = await import('../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/pricing.js');
    // five gold lions, price rising with appeal (5,000 -> 1,000 CC ... 9,000 -> 1,400 CC)
    const gold = [5000, 6000, 7000, 8000, 9000].map((a, i) => listing('g' + i, { medal: 'gold', appeal: `[SEPERATED_INT_VALUE:Value={${a}}]`, price: 1000 + 100 * i }));
    const high = recommendPrice(animal({ medal: 'gold', appeal: '8,500' }), gold, {});
    assert.equal(high.method, 'appeal');
    assert.equal(high.appealAdj.how, 'fit');
    // fit 1,350 at appeal 8,500, -3% = 1,309.5 -> 1,310
    assert.equal(high.price, 1310);
    assert.match(high.reason, /appeal 8,500 vs median 7,000 of 5 Gold: \+13%/);
    const low = recommendPrice(animal({ medal: 'gold', appeal: 5500 }), gold, {});
    assert.ok(low.price < high.price);
    // without the animal's appeal: the gene-score path as before
    assert.notEqual(recommendPrice(animal({ medal: 'gold' }), gold, {}).method, 'appeal');
    // two listings: half the relative difference, capped at +33%
    const two = gold.slice(0, 2);
    const adj = appealAdjustment(animal({ appeal: 6600 }), two);
    assert.equal(adj.how, 'ratio');
    assert.ok(Math.abs(adj.factor - 1.1) < 1e-9);
    assert.ok(Math.abs(appealAdjustment(animal({ appeal: 60000 }), two).factor - 4 / 3) < 1e-9);
    // scaled listings of another medal never set the appeal baseline
    const scaled = two.map(l => Object.assign({}, l, { medalFactor: 1.5 }));
    assert.equal(appealAdjustment(animal({ appeal: 6600 }), scaled), null);
});

test('parseAppeal reads the formats the game uses', async () => {
    const { parseAppeal, appealOf } = await import('../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/pricing.js');
    assert.equal(parseAppeal('[SEPERATED_INT_VALUE:Value={12345}]'), 12345);
    assert.equal(parseAppeal('[AnimalList_AppealValue:Value=(1234)]'), 1234);
    assert.equal(parseAppeal('12,345'), 12345);
    assert.equal(parseAppeal('12.345'), 12345);
    assert.equal(parseAppeal(800), 800);
    assert.equal(parseAppeal(''), undefined);
    assert.equal(parseAppeal('[SEPERATED_INT_VALUE:Value={0}]'), undefined);
    assert.equal(parseAppeal(undefined), undefined);
    assert.equal(appealOf({ appeal: '2,000' }), 2000);
});

test("the game's limits always win and the reason says so", () => {
    const gold = [3000, 3100, 3200].map((p, i) => listing('g' + i, { medal: 'gold', price: p }));
    const capped = recommendPrice(animal({ medal: 'gold' }), gold, { max: 2500 });
    assert.equal(capped.price, 2500);
    assert.match(capped.reason, /capped at the game's maximum 2,500 CC/);
    const raised = recommendPrice(animal({ medal: 'gold' }), gold, { min: 4000 });
    assert.equal(raised.price, 4000);
    assert.match(raised.reason, /raised to the game's minimum 4,000 CC/);
    // an extrapolated gold price is capped too
    const silver = [3000, 3000, 3000].map((p, i) => listing('s' + i, { medal: 'silver', price: p }));
    assert.equal(recommendPrice(animal({ medal: 'gold' }), silver, { min: 10, max: 5000 }).price, 5000);
});

test('confidence: same medal can be high, scaled at most medium, guessed at most low', () => {
    const many = n => Array.from({ length: n }, (_, i) => listing('x' + i, { medal: 'silver', price: 1000 + i }));
    assert.equal(recommendPrice(animal({ medal: 'silver' }), many(6), {}).confidence, 'high');
    assert.equal(recommendPrice(animal({ medal: 'silver' }), many(3), {}).confidence, 'medium');
    // 8 silver, gold animal, no ratio anywhere: guessed
    assert.equal(recommendPrice(animal({ medal: 'gold' }), many(8), {}).confidence, 'low');
    // 8 silver + 2 gold in the group: ratio learned, 10 comparables, still medium
    const learned = many(8).concat([2000, 2000].map((p, i) => listing('g' + i, { medal: 'gold', price: p })));
    assert.equal(recommendPrice(animal({ medal: 'gold' }), learned, {}).confidence, 'medium');
    // fewer than 3 in all: low
    assert.equal(recommendPrice(animal({ medal: 'silver' }), many(2), {}).confidence, 'low');
});

test('mergeListings keeps a known appeal when a later read has none', () => {
    let book = mergeListings([], [listing('a', { appeal: 4000 })], 1000);
    book = mergeListings(book, [listing('a', { price: 1100 })], 2000);
    assert.equal(book[0].appeal, 4000);
});

test('without medal data the price is the same as before', () => {
    const book = [40, 50, 60, 70, 80, 55, 65].map((s, i) => listing('m' + i, { score: s, price: 200 + 10 * s }));
    const plain = recommendPrice(animal({ genes: g(75) }), book, { defaultPrice: 900 });
    const withMedal = recommendPrice(animal({ genes: g(75), medal: 'gold' }), book, { defaultPrice: 900 });
    assert.equal(withMedal.price, plain.price);
    assert.equal(withMedal.reason, plain.reason);
    assert.equal(plain.price, 920);
    // and the animal's medal unknown, listings with medals: also unchanged tiers
    const c = comparables(animal(), medalBook());
    assert.equal(c.medalMode, undefined);
    assert.equal(c.list.length, 10);
});

test('speciesMarketSummary breaks live listings down by medal', () => {
    const s = speciesMarketSummary('Lion', medalBook().concat([listing('h', { medal: 'gold', source: 'history', price: 5000 })]));
    assert.deepEqual(Object.keys(s.byMedal), ['gold', 'silver', 'bronze']);
    assert.equal(s.byMedal.gold.count, 4);
    assert.equal(s.byMedal.gold.median, 2050);
    assert.equal(s.byMedal.silver.males, 4);
    assert.deepEqual(speciesMarketSummary('Lion', [listing('a')]).byMedal, {});
});

test('mergeListings keeps a known medal when a later read has none', () => {
    let book = mergeListings([], [listing('a', { medal: 'silver' })], 1000);
    book = mergeListings(book, [listing('a', { price: 1100 })], 2000);
    assert.equal(book[0].medal, 'silver');
    assert.equal(book[0].price, 1100);
    // the medal is not part of the listing key (v2 keys stay valid)
    const row = { species: 'Lion', name: 'Leo', gender: 0, maturity: 2, genes: g(60), price: 1000, isCC: true };
    assert.equal(listingKey(Object.assign({ medal: 'gold' }, row)), listingKey(row));
});
