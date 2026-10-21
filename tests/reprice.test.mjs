// node --test tests/reprice.test.mjs
// My listings (repricecore.js): staleness, suggestions, strategies, the
// preview, the job texts, the run's counts and the ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Gender, Maturity } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/scores.js';
import { listingKey } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/pricing.js';
import {
    assessListing, encodeRelistJob, encodeUnlistJob, filterListings, ledgerPrune, ledgerTake, listingClock, listingRows, marketPools, ownListingKeys,
    planReprice, repriceSeconds, runCounts, runSummary, sortListings, spanText, strandedItems, strategyPrice, suggestPrice, verdictCounts,
    STALE_AT, WATCH_AT,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/repricecore.js';

const H = 3600;
const g = s => ({ size: s / 100, longevity: s / 100, fertility: s / 100, immunity: s / 100 });
// a competing market listing (price book shape)
const comp = (id, price, over = {}) => Object.assign({
    id: `c${id}`, species: 'Lion', gender: Gender.Male, maturity: Maturity.Adult, isShoal: false,
    score: 60, price, isCC: true, source: 'market', seenAt: 0,
}, over);
// one of my listings (storage row, readAnimal shape)
const mine = (over = {}) => Object.assign({
    id: 7, key: 'animal_7', name: 'Leo', species: 'Lion', gender: Gender.Male, maturity: Maturity.Adult, isShoal: false, isExhibit: false,
    genes: g(60), price: 1000, isCC: false, auctionTimerSeconds: 6 * H,
}, over);
const ten = (base = 1000) => Array.from({ length: 10 }, (_, i) => comp(i, base + i * 20));
const NOW = 1e12;
const fresh = { now: NOW, checkedAt: NOW - 60000 };

test('the clock: ledger, inferred 12 h, assumed', () => {
    let c = listingClock(mine({ auctionTimerSeconds: 3 * H }), { at: NOW - 3 * H * 1000, hours: 6 }, NOW);
    assert.equal(c.known, 'ledger');
    assert.equal(c.duration, 6 * H);
    assert.equal(c.frac, 0.5);
    c = listingClock(mine({ auctionTimerSeconds: 9 * H }), null, NOW);
    assert.equal(c.known, 'inferred');
    assert.equal(c.duration, 12 * H);
    assert.equal(c.frac, 0.25);
    c = listingClock(mine({ auctionTimerSeconds: 3 * H }), null, NOW);
    assert.equal(c.known, 'assumed');
    assert.equal(c.frac, 0.75);
    // a ledger entry from an older listing (more left than it had): ignored
    c = listingClock(mine({ auctionTimerSeconds: 11 * H }), { at: NOW - 1000, hours: 6 }, NOW);
    assert.equal(c.known, 'inferred');
    assert.equal(spanText(3 * H + 600), '3h 10m');
    assert.equal(spanText(30), '<1m');
});

test('my own listings never compete with themselves or each other', () => {
    const a = mine({ price: 1500 });
    const b = mine({ id: 8, key: 'animal_8', name: 'Leon', price: 1400 });
    // what the market shows for them (CC listings at their asked prices)
    const book = ten().concat([Object.assign(comp('m1', 1500, { name: 'Leo', genes: g(60) }), { id: listingKey(Object.assign({}, a, { isCC: true })) }),
        Object.assign(comp('m2', 1400), { id: listingKey(Object.assign({}, b, { isCC: true })) })]);
    const keys = ownListingKeys([a, b]);
    assert.equal(keys.size, 4);
    const pools = marketPools(book, [a, b]);
    assert.equal(pools.live.length, 10);
    const s = assessListing(a, Object.assign({ pools }, fresh));
    assert.equal(s.n, 10);
    assert.equal(s.cheaper, 10);
});

test('a listing well over the market, up most of its time: stale, suggestion first in line', () => {
    const s = assessListing(mine({ price: 1600, auctionTimerSeconds: 2 * H }), Object.assign({ book: ten() }, fresh));
    assert.ok(s.fair > 900 && s.fair < 1200, `fair ${s.fair}`);
    assert.equal(s.n, 10);
    assert.equal(s.cheaper, 10);
    assert.equal(s.queue, 1);
    assert.equal(s.premScore, 1);
    assert.ok(s.score >= STALE_AT, `score ${s.score}`);
    assert.equal(s.verdict, 'stale');
    // just under the cheapest (1,000): 980
    assert.equal(s.suggestion, 980);
    assert.match(s.suggestionWhy, /cheapest comparable/);
    assert.equal(s.flags.staleData, false);
    assert.ok(s.reasons.some(r => r.k === 'queue' && r.value === '11 of 11'));
});

test('the same overpriced listing just put up: not yet stale (time weight)', () => {
    const s = assessListing(mine({ price: 1600, auctionTimerSeconds: 12 * H }), Object.assign({ book: ten() }, fresh));
    assert.equal(s.clock.frac, 0);
    assert.equal(s.score, 50);
    // at the border: 50 is stale (high pressure); one a little less is watch
    const t = assessListing(mine({ price: 1250, auctionTimerSeconds: 12 * H }), Object.assign({ book: ten() }, fresh));
    assert.ok(t.score < STALE_AT && t.score >= WATCH_AT, `score ${t.score}`);
    assert.equal(t.verdict, 'watch');
});

test('priced at the cheapest comparable: healthy, keep', () => {
    const s = assessListing(mine({ price: 990, auctionTimerSeconds: 1.5 * H }), Object.assign({ book: ten() }, fresh));
    assert.equal(s.cheaper, 0);
    assert.ok(s.score < WATCH_AT, `score ${s.score}`);
    assert.equal(s.verdict, 'ok');
    assert.equal(s.suggestion, 990);
    assert.match(s.suggestionWhy, /^Keep/);
});

test('far under the market and the cheapest: underpriced, raise to fair', () => {
    const s = assessListing(mine({ price: 600 }), Object.assign({ book: ten() }, fresh));
    assert.equal(s.verdict, 'under');
    assert.equal(s.suggestion, s.fair);
});

test('no market data: no verdict, no suggestion; old checks flagged', () => {
    const s = assessListing(mine(), { book: [], now: NOW, checkedAt: null });
    assert.equal(s.verdict, 'nodata');
    assert.equal(s.suggestion, null);
    assert.equal(s.score, null);
    assert.equal(s.flags.staleData, true);
    const old = assessListing(mine(), { book: ten(), now: NOW, checkedAt: NOW - 3 * 3600 * 1000 });
    assert.equal(old.flags.staleData, true);
    assert.ok(old.reasons.some(r => r.k === 'data' && /180 min old/.test(r.value)));
});

test('expiring: under an hour left', () => {
    const s = assessListing(mine({ auctionTimerSeconds: 1800 }), Object.assign({ book: ten() }, fresh));
    assert.equal(s.flags.expiring, true);
});

test('the suggestion never goes under 85% of fair', () => {
    const r = suggestPrice(2000, 1000, 400, 'stale');
    assert.equal(r.price, 850);
    assert.match(r.why, /85% of the fair price/);
    // no comparables: the fair price
    assert.equal(suggestPrice(2000, 1000, null, 'stale').price, 1000);
});

test('strategies, the floor and overrides', () => {
    const as = { price: 1600, fair: 1000, cheapest: 900, suggestion: 880, suggestionWhy: 'x' };
    assert.equal(strategyPrice(as, 'suggested').price, 880);
    assert.equal(strategyPrice(as, 'fair').price, 1000);
    assert.equal(strategyPrice(as, 'cheapest').price, 900);
    assert.equal(strategyPrice(as, 'undercut', { pct: 10 }).price, 810);
    assert.equal(strategyPrice(as, 'cut', { pct: 25 }).price, 1200);
    // undercut 30%: 630, held at 80% of fair
    const f = strategyPrice(as, 'undercut', { pct: 30, floorPct: 80 });
    assert.equal(f.price, 800);
    assert.equal(f.floored, true);
    assert.equal(strategyPrice({ price: 1000, fair: 1000, cheapest: null }, 'cheapest').price, null);
    const rows = [
        { guid: '1', key: 'animal_1', assess: as },
        { guid: '2', key: 'animal_2', assess: Object.assign({}, as, { price: 800 }) },
        { guid: '3', key: 'animal_3', assess: { price: 500, fair: null, cheapest: null, suggestion: null } },
    ];
    const plan = planReprice(rows, { strategy: 'fair', overrides: { 2: 777 } });
    assert.equal(plan.items.length, 3);
    assert.equal(plan.ready.length, 2);
    assert.equal(plan.noPrice.length, 1);
    assert.equal(plan.items[1].next, 777);
    assert.equal(plan.items[1].override, true);
    assert.equal(plan.oldTotal, 2400);
    assert.equal(plan.newTotal, 1777);
    assert.equal(plan.lowered, 2);
    assert.equal(plan.aboveCheapest, 1);
});

test('the job texts', () => {
    const items = [{ guid: '900000000000000007', key: 'animal_7', next: 980 }, { guid: 'bad guid', key: 'animal_8', next: 1 }, { guid: 'fp3', key: 'animal_9', next: 0 }];
    const u = encodeUnlistJob(items, { paceMs: 500 });
    assert.equal(u.text, 'v1 1000 unlist\n900000000000000007 animal_7 - max\nfp3 animal_9 - max');
    assert.equal(u.items.length, 2);
    const r = encodeRelistJob(items, { paceMs: 3000, hours: 'default' });
    assert.equal(r.text, 'v1 3000\n900000000000000007 animal_7 980 default');
    assert.ok(repriceSeconds(4, 3000) > 40);
});

test('the run: counts, stranded, summary', () => {
    const run = { items: [
        { guid: '1', old: 1000, next: 900, off: 'unlisted', on: 'listed', listedPrice: 900 },
        { guid: '2', old: 1000, next: 900, off: 'unlisted', on: 'skipped' },
        { guid: '3', old: 1000, next: 900, off: 'timeout', on: '' },
        { guid: '4', old: 1000, next: 900, off: 'unlisted', on: 'pending' },
    ] };
    const c = runCounts(run);
    assert.equal(c.off, 3);
    assert.equal(c.offFailed, 1);
    assert.equal(c.relisted, 1);
    assert.equal(c.stranded, 1);
    assert.equal(c.waiting, 1);
    assert.deepEqual(strandedItems(run).map(i => i.guid), ['2', '4']);
    assert.equal(runSummary(run), 'Repriced 1 of 4 · 1 not taken off (still at the old price) · 2 off the market, not listed again · asking −100 CC in all');
});

test('the ledger: listings of list runs, once per run, pruned', () => {
    const led = {};
    assert.equal(ledgerTake(led, { run: 3, mode: 'list', results: [{ guid: '5', status: 'listed', hours: 12, price: 800 }, { guid: '6', status: 'skipped' }] }, 1000), true);
    assert.deepEqual(led['5'], { at: 1000, hours: 12, price: 800, run: 3 });
    assert.equal(ledgerTake(led, { run: 3, mode: 'list', results: [{ guid: '5', status: 'listed', hours: 12, price: 800 }] }, 5000), false);
    assert.equal(led['5'].at, 1000);
    assert.equal(ledgerTake(led, { run: 4, mode: 'unlist', results: [{ guid: '5', status: 'unlisted' }] }, 6000), false);
    ledgerPrune(led, 1000 + 25 * 3600 * 1000);
    assert.equal(led['5'], undefined);
});

test('rows of the view: sort, filter, counts', () => {
    const book = ten();
    const rows = [
        { id: 'g1', guid: '1', key: 'animal_1', species: 'Lion', a: mine({ id: 1, name: 'A', price: 1700, auctionTimerSeconds: 1 * H }) },
        { id: 'g2', guid: '2', key: 'animal_2', species: 'Lion', a: mine({ id: 2, name: 'B', price: 995, auctionTimerSeconds: 2000 }) },
        { id: 'g3', guid: '3', key: 'animal_3', species: 'Tiger', a: mine({ id: 3, name: 'C', species: 'Tiger', price: 900 }) },
    ];
    const out = listingRows(rows, { book, now: NOW, checkedAtOf: sp => (sp === 'Lion' ? NOW : null), ledger: {} });
    assert.equal(out[0].assess.verdict, 'stale');
    assert.equal(out[1].assess.verdict, 'ok');
    assert.equal(out[2].assess.verdict, 'nodata');
    assert.equal(out[2].assess.flags.staleData, true);
    assert.deepEqual(sortListings(out, 'score').map(r => r.guid), ['1', '2', '3']);
    assert.deepEqual(sortListings(out, 'left').map(r => r.guid), ['2', '1', '3']);
    assert.deepEqual(filterListings(out, { verdicts: ['stale', 'nodata'] }).map(r => r.guid), ['1', '3']);
    assert.deepEqual(filterListings(out, { species: 'Lion', expiring: true }).map(r => r.guid), ['2']);
    const c = verdictCounts(out);
    assert.equal(c.stale, 1);
    assert.equal(c.ok, 1);
    assert.equal(c.nodata, 1);
    assert.equal(c.expiring, 1);
});

// ------------------------------------------------ quick trade / release
import { quickSheet } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/listercore.js';
import { normalizeAction, quickPreview } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/repricecore.js';

test('quick preview: listed rows judged as off the market, prices from their verdicts, the first-run limit', () => {
    const v = (qt, price) => ({ trade: true, quickTrade: qt, quickRelease: true, rehome: false, reasons: { trade: '', quickTrade: qt ? '' : 'X', quickRelease: '' }, values: {}, prices: { quickTrade: price, quickRelease: 40 } });
    const rows = [
        { guid: '1', key: 'animal_1', block: 'listed', a: { price: 1200 }, verdict: v(true, 800) },
        { guid: '2', key: 'animal_2', block: 'listed', a: { price: 900 }, verdict: null },
        { guid: '3', key: 'animal_3', block: 'listed', a: { price: 700 }, verdict: v(false, null) },
        { guid: null, key: 'animal_4', block: 'listed', a: { price: 500 } },
    ];
    const q = quickPreview(rows, 'quicktrade', quickSheet, { fmt: n => String(n) });
    assert.deepEqual(q.go.map(r => r.guid), ['1', '2']);
    assert.equal(q.skip.length, 2);
    assert.equal(q.asking, 2100);
    assert.equal(q.perRow.get('1'), 800);
    assert.equal(q.perRow.get('2'), null);
    assert.equal(q.sheet.totalText, '$800 + 1 priced when checked');
    // the rows themselves are not changed
    assert.equal(rows[0].block, 'listed');
    const r = quickPreview(rows, 'release', quickSheet, { accepted: false });
    assert.equal(r.go.length, 1);
    assert.equal(r.sheet.totalText, '40 CC');
    assert.equal(normalizeAction('bogus'), 'reprice');
});

test('a quick run: sold, unconfirmed and the ones left off the market', () => {
    const run = { action: 'quicktrade', items: [
        { guid: '1', old: 1000, next: 1000, off: 'unlisted', on: 'traded', soldFor: 800 },
        { guid: '2', old: 900, next: 900, off: 'unlisted', on: 'traded', soldFor: 700 },
        { guid: '3', old: 900, next: 900, off: 'unlisted', on: 'unconfirmed' },
        { guid: '4', old: 900, next: 900, off: 'unlisted', on: 'pending' },
        { guid: '5', old: 900, next: 900, off: 'unlisted', on: 'skipped' },
        { guid: '6', old: 900, next: 900, off: 'refused', on: '' },
    ] };
    const c = runCounts(run);
    assert.equal(c.sold, 2);
    assert.equal(c.soldFor, 1500);
    assert.equal(c.unconfirmed, 1);
    assert.deepEqual(strandedItems(run).map(i => i.guid), ['4', '5']);
    assert.equal(runSummary(run), 'Quick-traded 2 of 6 · $1,500 · 1 not taken off (still at the old price) · 1 sent, not confirmed: check storage · 2 off the market, not sold');
    run.action = 'release';
    run.items[0].on = 'released';
    run.items[1].on = 'released';
    assert.match(runSummary(run), /^Released 2 of 6 · 1,500 CC/);
});
