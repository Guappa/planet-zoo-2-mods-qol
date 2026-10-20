// Trade shortcuts (tradejumpcore.js): the Species board / Kin planner buttons
// that open the hub's Animal Storage or Market for one species.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    countsText, EMPTY_STORAGE_WAIT_MS, normSpecies, parseCounts, PENDING_MAX_MS, pendingStep, tradeBlockReason,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/tradejumpcore.js';

test('species ids match however they are spelled', () => {
    assert.equal(normSpecies('[Animal_Leopard_African]'), 'leopard_african');
    assert.equal(normSpecies('Animal_Leopard_African'), 'leopard_african');
    assert.equal(normSpecies('Leopard_African'), 'leopard_african');
    assert.equal(normSpecies(' Lion '), 'lion');
    assert.equal(normSpecies('Lion;drop'), 'liondrop');
    assert.equal(normSpecies(null), '');
    assert.equal(normSpecies(undefined), '');
});

test('why the buttons are blocked, in order', () => {
    assert.equal(tradeBlockReason({}), '');
    assert.equal(tradeBlockReason({ hasBuilding: undefined }), '', 'unknown building: allowed');
    assert.match(tradeBlockReason({ engine: false, hasBuilding: false }), /Not available/);
    assert.match(tradeBlockReason({ hasBuilding: false, hubDisabled: true, planRunning: true }), /Build a trade centre/);
    assert.match(tradeBlockReason({ hasBuilding: true, hubDisabled: true, planRunning: true }), /hub can't be opened/);
    assert.match(tradeBlockReason({ planRunning: true, sendRunning: true }), /move plan is running/);
    assert.match(tradeBlockReason({ sendRunning: true }), /being placed/);
});

test('the counts answer', () => {
    const c = parseCounts('{"ok":true,"mode":"franchise","bySpecies":{"Lion":{"m":2,"f":3},"Leopard_African":{"m":0,"f":1},"Bad":{"m":-1,"f":2}}}');
    assert.deepEqual(c, { ok: true, mode: 'franchise', bySpecies: { lion: { m: 2, f: 3 }, leopard_african: { m: 0, f: 1 } } });
    assert.equal(parseCounts('not json'), null);
    assert.equal(parseCounts('null'), null);
    assert.equal(parseCounts('[1,2]'), null);
    assert.deepEqual(parseCounts('{"ok":false,"bySpecies":[]}'), { ok: false, mode: 'unknown', bySpecies: {} });
});

test('the counts line', () => {
    assert.equal(countsText({ m: 2, f: 3 }), '2♂ 3♀ adults in storage');
    assert.equal(countsText({ m: 1, f: 0 }), '1♂ 0♀ adult in storage');
    assert.equal(countsText({ m: 0, f: 0 }), 'No adults in storage');
    assert.equal(countsText(null), '');
    assert.equal(countsText({}), '');
    assert.equal(countsText({ m: 2, f: 3 }, 'f'), '3 adult females in storage');
    assert.equal(countsText({ m: 1, f: 3 }, 'm'), '1 adult male in storage');
    assert.equal(countsText({ m: 0, f: 3 }, 'm'), 'No adult males in storage');
});

test('the hub page applies a pending storage filter when Storage shows', () => {
    const p = { seq: 3, species: 'Lion', at: 1000 };
    assert.equal(pendingStep(null, { now: 2000 }), 'wait');
    assert.equal(pendingStep(p, { now: 2000, storageVisible: false }), 'wait');
    assert.equal(pendingStep(p, { now: 2000, storageVisible: true, rowCount: 0, visibleSince: 1900 }), 'wait');
    assert.equal(pendingStep(p, { now: 2000, storageVisible: true, rowCount: 12, visibleSince: 1990 }), 'apply');
    assert.equal(pendingStep(p, { now: 1900 + EMPTY_STORAGE_WAIT_MS, storageVisible: true, rowCount: 0, visibleSince: 1900 }), 'apply', 'empty storage: after 3 s');
    assert.equal(pendingStep(p, { now: 1000 + PENDING_MAX_MS + 1, storageVisible: true, rowCount: 5, visibleSince: 1000 }), 'expire');
    assert.equal(pendingStep(p, { now: 1000 + PENDING_MAX_MS + 1, storageVisible: false }), 'expire');
});
