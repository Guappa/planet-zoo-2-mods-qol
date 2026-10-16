// node --test tests/kincull.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinModel, Sex } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';
import { cullPlan, geneScore } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincull.js';

const M = Sex.Male, F = Sex.Female;
// gene strings: fertility/immunity count differing loci (hetero), size/longevity good alleles
const G = q => {
    const het = 'ABCDEF'.slice(0, q) + 'ABCDEF'.slice(q);   // first q loci differ below
    const f = 'AAAAAA' + 'BBBBBB'.slice(0, q) + 'AAAAAA'.slice(q);
    return { F: f, I: f, S: 'A'.repeat(q) + 'Z'.repeat(6 - q) + 'A'.repeat(q) + 'Z'.repeat(6 - q), L: 'A'.repeat(q) + 'Z'.repeat(6 - q) + 'A'.repeat(q) + 'Z'.repeat(6 - q) };
};
let n = 0;
const an = (sex, hab, q, over = {}) => {
    n++;
    return Object.assign({ id: 'a' + n, key: 'animal_a' + n, guid: 'g' + n, name: 'L' + n, species: 'Lemur', sex, juv: false, contra: false, infertile: false,
        hab, loc: 'H' + hab, lt: 'habitat', par: [], mates: [], genes: G(q), age: 5, ageQ: 2 }, over);
};
const LEMUR = { maturity: 2, infertility: 15, life: 20 };
const model = animals => buildKinModel({ v: 1, seq: 1, scope: 'park', mode: 'offline', habitats: [{ id: '1', name: 'Lemur Woods' }, { id: '2', name: 'Lemur Isle' }], animals, anc: {}, speciesFacts: { Lemur: LEMUR } });
const INFO = { social: { max: 6 }, mating: 'polygyny' };

test('an over-full habitat gives up its old and weak animals first, keeps the best', () => {
    n = 0;
    const animals = [
        an(M, '1', 6), an(M, '1', 2), an(F, '1', 6), an(F, '1', 5), an(F, '1', 4),
        an(F, '1', 3), an(F, '1', 1), an(F, '1', 5, { age: 17, ageQ: 3, infertile: true }), an(M, '1', 4, { age: 16, infertile: true }),
    ];
    const plan = cullPlan(model(animals), 'Lemur', INFO, { options: { fill: 0.85 } });
    const h = plan.habitats[0];
    assert.equal(h.adults, 9);
    assert.equal(h.target, 5);
    assert.equal(plan.moves.length, 4);
    const out = new Set(plan.moves.map(m => m.id));
    assert.ok(out.has('a8') && out.has('a9'), 'the old ones go');
    assert.ok(out.has('a2'), 'the extra, weaker male goes (harem)');
    assert.ok(!out.has('a1') && !out.has('a3'), 'the best male and female stay');
    assert.match(plan.moves.find(m => m.id === 'a8').reason, /too old/);
    assert.match(plan.moves.find(m => m.id === 'a2').reason, /extra male/);
    assert.ok(plan.after.gene > plan.before.gene, 'the kept animals have better genes');
});

test('a habitat within its room is left alone; old animals only with oldAlways', () => {
    n = 0;
    const animals = [an(M, '2', 5), an(F, '2', 5), an(F, '2', 4, { age: 17, infertile: true })];
    assert.equal(cullPlan(model(animals), 'Lemur', INFO).moves.length, 0);
    const p = cullPlan(model(animals), 'Lemur', INFO, { options: { oldAlways: true } });
    assert.deepEqual(p.moves.map(m => m.id), ['a3']);
});

test('pregnant females, the breeding core and the player\'s keeps stay', () => {
    n = 0;
    const animals = [an(M, '1', 1), an(F, '1', 1, { preg: true }), an(F, '1', 1), an(F, '1', 1), an(F, '1', 2), an(F, '1', 2), an(F, '1', 2), an(F, '1', 3)];
    const plan = cullPlan(model(animals), 'Lemur', { social: { max: 4 } }, { options: { fill: 1, keepIds: new Set(['a3']), keepBest: 0 } });
    const out = new Set(plan.moves.map(m => m.id));
    // 8 adults, room 4: but the male, the pregnant one, the kept one and the
    // two best other females (breeding core) stay, so only 3 can go
    assert.equal(out.size, 3);
    assert.ok(!out.has('a1'), 'the only male stays');
    assert.ok(!out.has('a2'), 'pregnant stays');
    assert.ok(!out.has('a3'), 'kept by the player');
});

test('the player can send one away by hand; fill levels change the count', () => {
    n = 0;
    const animals = Array.from({ length: 10 }, (_, i) => an(i < 3 ? M : F, '1', 1 + (i % 6)));
    const m = model(animals);
    const lean = cullPlan(m, 'Lemur', { social: { max: 10 } }, { options: { fill: 0.7 } }).moves.length;
    const full = cullPlan(m, 'Lemur', { social: { max: 10 } }, { options: { fill: 1 } }).moves.length;
    assert.ok(lean > full && full === 0);
    const hand = cullPlan(m, 'Lemur', { social: { max: 10 } }, { options: { fill: 1, cullIds: new Set(['a5']) } });
    assert.deepEqual(hand.moves.map(x => [x.id, x.reason]), [['a5', 'your choice']]);
});

test('relatives in the same habitat lower the keep value', () => {
    n = 0;
    const dad = an(M, '1', 5);
    const kids = [an(F, '1', 5, { par: [dad.guid, 'gm'] }), an(F, '1', 5, { par: [dad.guid, 'gm'] })];
    const other = an(F, '1', 5);
    const extra = [an(F, '1', 5), an(F, '1', 5)];
    const plan = cullPlan(model([dad, ...kids, other, ...extra]), 'Lemur', { social: { max: 5 }, mating: 'polygyny' }, { options: { fill: 0.8, keepBest: 0 } });
    const out = plan.moves.map(m => m.id);
    assert.equal(out.length, 2);
    assert.ok(out.every(id => kids.some(k => k.id === id)), `the daughters living with their father go first: ${out}`);
});

test('gene score from the game grades', () => {
    n = 0;
    assert.ok(geneScore(an(M, '1', 6)) > geneScore(an(M, '1', 1)));
});

test('sending one by hand adds to the plan, it does not swap another back', () => {
    n = 0;
    const animals = Array.from({ length: 10 }, (_, i) => an(i < 3 ? M : F, '1', 1 + (i % 6)));
    const m = model(animals);
    const base = cullPlan(m, 'Lemur', { social: { max: 10 } }, { options: { fill: 0.8 } });
    const kept = base.habitats[0].keep.find(k => !k.why);
    const more = cullPlan(m, 'Lemur', { social: { max: 10 } }, { options: { fill: 0.8, cullIds: new Set([kept.id]) } });
    assert.equal(more.moves.length, base.moves.length + 1);
    for (const mv of base.moves) assert.ok(more.moves.some(x => x.id === mv.id));
});

test('juveniles are never picked automatically, only by hand', () => {
    n = 0;
    const animals = [an(M, '1', 5), an(F, '1', 5), an(F, '1', 4), an(F, '1', 2), an(F, '1', 1),
        an(F, '1', 1, { juv: true, infertile: true, age: 1 }), an(M, '1', 1, { juv: true, infertile: true, age: 1 })];
    const plan = cullPlan(model(animals), 'Lemur', { social: { max: 4 } }, { options: { fill: 1 } });
    assert.deepEqual(plan.moves.map(m => m.id), ['a5']);
    const hand = cullPlan(model(animals), 'Lemur', { social: { max: 4 } }, { options: { fill: 1, cullIds: new Set(['a6']) } });
    assert.ok(hand.moves.some(m => m.id === 'a6'));
});
