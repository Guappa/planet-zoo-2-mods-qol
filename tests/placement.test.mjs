// node --test tests/placement.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { besideAnchor } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/placement.js';

const view = { vw: 1920, vh: 1080 };
const rect = (left, top, w = 20, h = 20) => ({ left, top, right: left + w, bottom: top + h });
const opts = { gap: 8, minW: 450, minH: 180 };

test('near the right edge it flips left even when the card measures 0 x 0', () => {
    const at = besideAnchor(rect(1890, 300), { w: 0, h: 0 }, view, opts);
    assert.equal(at.side, 'left');
    assert.ok(at.left + 450 <= 1890 - 8 + 0.5, 'the whole card is left of the anchor');
    assert.ok(at.left >= 8);
});

test('an anchor in the right half goes left when the card fits there', () => {
    const at = besideAnchor(rect(1200, 300), { w: 450, h: 300 }, view, opts);
    assert.equal(at.side, 'left');
    assert.equal(at.left, 1200 - 8 - 450);
});

test('with room on the right (left half) it stays right of the anchor', () => {
    const at = besideAnchor(rect(300, 300), { w: 0, h: 0 }, view, opts);
    assert.equal(at.side, 'right');
    assert.equal(at.left, 328);
    assert.equal(at.top, 294);
});

test('a larger measured size wins over the minimum', () => {
    const at = besideAnchor(rect(1300, 300), { w: 700, h: 300 }, view, opts);
    assert.equal(at.left, 1300 - 8 - 700);
});

test('clamped inside the screen: bottom edge, narrow screen, top', () => {
    const low = besideAnchor(rect(300, 1060), { w: 450, h: 400 }, view, opts);
    assert.equal(low.top, 1080 - 8 - 400);
    const narrow = besideAnchor(rect(200, 100), { w: 450, h: 200 }, { vw: 500, vh: 600 }, opts);
    assert.ok(narrow.left >= 8 && narrow.left + 450 <= 500 - 8 + 0.5, JSON.stringify(narrow));
    const tooWide = besideAnchor(rect(200, 100), { w: 900, h: 200 }, { vw: 500, vh: 600 }, opts);
    assert.equal(tooWide.left, 8);
    const top = besideAnchor(rect(300, 0), { w: 450, h: 200 }, view, opts);
    assert.equal(top.top, 8);
});
