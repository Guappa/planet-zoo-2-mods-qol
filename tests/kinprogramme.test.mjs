// node --test tests/kinprogramme.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinModel, Sex } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';
import { TRADE, simulatePlan } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kinboardcore.js';
import {
    planProgramme, isBreeder, conceptionChance, youngQuality, habitatCapacity, estimateSpacePerAdult,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kinprogramme.js';

const M = Sex.Male, F = Sex.Female;
// genes: a strand letter per animal makes everyone heterozygous with everyone
const G = (a, b) => ({ F: a.repeat(6) + b.repeat(6), I: a.repeat(6) + b.repeat(6), S: 'AAAAAACCCCCC', L: 'AAAAAACCCCCC' });
const an = (id, sex, hab, par = [], over = {}) => Object.assign({
    id, key: 'animal_' + id, guid: 'g' + id, name: id, species: 'Lion', sex, juv: false, contra: false, infertile: false,
    hab, loc: 'H' + hab, lt: 'habitat', par: par.map(p => 'g' + p), mates: [], genes: G('C', 'D'),
}, over);
const snap = (animals, habitats = ['1', '2', '3']) => ({ v: 1, seq: 1, scope: 'park', mode: 'offline', habitats: habitats.map(h => ({ id: h, name: 'H' + h })), animals, anc: {} });
const DEST = (ids) => ({ bySpecies: { Lion: Object.fromEntries(ids.map(i => [i, { ok: true }])) }, habitats: [] });
const where = (model, plan, id) => {
    const m = plan.moves.find(x => x.id === id);
    return m ? m.to : model.animals.get(id).hab;
};

test('breeders: adults, fertile, within fertility ages', () => {
    assert.equal(isBreeder(an('a', M, '1')), true);
    assert.equal(isBreeder(an('a', M, '1', [], { juv: true })), false);
    assert.equal(isBreeder(an('a', M, '1', [], { contra: true })), false);
    assert.equal(isBreeder(an('a', M, '1', [], { infertile: true })), false);
    assert.equal(isBreeder(an('a', M, '1', [], { age: 25 }), { fertilityAges: { maturity: 3, infertility: 20 } }), false);
    assert.equal(isBreeder(an('a', M, '1', [], { age: 2 }), { fertilityAges: { maturity: 3, infertility: 999 } }), false);
});

test('pair value: young quality and the game conception table', () => {
    const m = an('m', M, '1', [], { genes: G('A', 'B') });
    const f1 = an('f', F, '1', [], { genes: G('A', 'B') });       // same strands: young less heterozygous
    const f2 = an('g', F, '1', [], { genes: G('E', 'F') });       // different strands: better young
    assert.ok(youngQuality(m, f2) > youngQuality(m, f1));
    const table = Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (_, j) => (i + j) / 20));
    assert.equal(conceptionChance(m, f1, { conception: table }), 12 / 20);   // both fertility grade 6
});

test('polygyny: one breeding male per habitat, relatives separated', () => {
    // habitat 1: male a with his three daughters and an unrelated female; habitat 2: male b alone
    const animals = [
        an('a', M, '1'), an('d1', F, '1', ['a', 'x']), an('d2', F, '1', ['a', 'x']), an('d3', F, '1', ['a', 'x']), an('u', F, '1'),
        an('b', M, '2'),
    ];
    const model = buildKinModel(snap(animals));
    const plan = planProgramme(model, 'Lion', { mating: 'polygyny', social: { max: 6 } }, DEST(['1', '2']));
    assert.equal(plan.system, 'polygyny');
    assert.equal(plan.after.relatedPairs, 0);
    assert.equal(plan.before.relatedPairs, 3);
    // every female has an unrelated male
    assert.equal(plan.after.breedingPairs, 4);
    for (const h of ['1', '2']) {
        const males = ['a', 'b'].filter(id => where(model, plan, id) === h).length;
        assert.ok(males <= 1, `habitat ${h} has ${males} males`);
    }
    // the daughters are with b, not with their father
    for (const d of ['d1', 'd2', 'd3']) assert.notEqual(where(model, plan, d), where(model, plan, 'a'));
    // applying the moves leaves no inbreeding risk
    const after = simulatePlan(model, plan.moves, DEST(['1', '2']));
    assert.equal(after.pairs.filter(p => p.severity === 'risk').length, 0);
});

test('monogamy: swaps partners for better young', () => {
    // pairs as they are: (m1, f1) and (m2, f2) share strands; crossing them gives better young
    const animals = [
        an('m1', M, '1', [], { genes: G('A', 'B') }), an('f1', F, '1', [], { genes: G('A', 'B') }),
        an('m2', M, '2', [], { genes: G('E', 'F') }), an('f2', F, '2', [], { genes: G('E', 'F') }),
    ];
    const model = buildKinModel(snap(animals));
    const plan = planProgramme(model, 'Lion', { mating: 'monogamy', social: { max: 2 } }, DEST(['1', '2']));
    assert.ok(plan.after.youngQuality > plan.before.youngQuality, JSON.stringify([plan.before, plan.after]));
    assert.equal(plan.moves.length, 2);                                  // one swap
    assert.equal(plan.after.breedingPairs, 2);
});

test('small gains do not split bonded mates', () => {
    const animals = [
        an('m1', M, '1', [], { genes: G('A', 'B'), mates: ['f1'] }), an('f1', F, '1', [], { genes: G('A', 'C'), mates: ['m1'] }),
        an('m2', M, '2', [], { genes: G('E', 'F'), mates: ['f2'] }), an('f2', F, '2', [], { genes: G('E', 'G'), mates: ['m2'] }),
    ];
    const model = buildKinModel(snap(animals));
    // the cross gives better young, but not enough to break two bonds
    const plan = planProgramme(model, 'Lion', { mating: 'monogamy', social: { max: 2 } }, DEST(['1', '2']), { options: { bondBreakCost: 0.5 } });
    assert.equal(plan.moves.length, 0);
    // without the bonds the same layout is swapped
    const free = buildKinModel(snap(animals.map(a => Object.assign({}, a, { mates: [] }))));
    assert.equal(planProgramme(free, 'Lion', { mating: 'monogamy', social: { max: 2 } }, DEST(['1', '2'])).moves.length, 2);
});

test('capacity: no habitat over the social maximum; the surplus goes to the trade centre', () => {
    const animals = [an('m1', M, '1'), an('f1', F, '1'), an('f2', F, '1'), an('f3', F, '1'), an('f4', F, '1')];
    const model = buildKinModel(snap(animals, ['1']));
    const plan = planProgramme(model, 'Lion', { mating: 'polygyny', social: { max: 3 } }, DEST(['1']));
    const inHab = ['m1', 'f1', 'f2', 'f3', 'f4'].filter(id => where(model, plan, id) === '1').length;
    assert.equal(inHab, 3);
    assert.equal(plan.moves.filter(m => m.to === TRADE).length, 2);
});

test('assignments: only the species own habitats', () => {
    const animals = [an('a', M, '1'), an('d', F, '1', ['a', 'x']), an('b', M, '2')];
    const model = buildKinModel(snap(animals));
    const plan = planProgramme(model, 'Lion', { mating: 'polygyny', social: { max: 4 } }, DEST(['1', '2', '3']), { assignments: { '1': ['Lion'], '3': ['Lion'], '2': ['Zebra'] } });
    for (const m of plan.moves) assert.ok(['1', '3', TRADE].includes(m.to), JSON.stringify(plan.moves));
    assert.equal(plan.after.relatedPairs, 0);
});

test('juveniles and non-breeders stay; they still use capacity', () => {
    const animals = [
        an('m', M, '1'), an('f', F, '1'), an('kid', F, '1', ['m', 'f'], { juv: true }),
        an('old', F, '1', [], { contra: true }),
    ];
    const model = buildKinModel(snap(animals, ['1']));
    const plan = planProgramme(model, 'Lion', { mating: 'mixed', social: { max: 3 } }, DEST(['1']));
    assert.ok(!plan.moves.some(m => m.id === 'kid' || m.id === 'old'));
    assert.equal(plan.groups.find(g => g.hab === '1').staying, 1);        // the contracepted adult
});

test('space: capacity from the game requirement per adult', () => {
    const info = {
        social: { max: 10 },
        habitats: {
            '1': { available: { land: 1000 }, required: { land: 400 }, adults: 4 },   // 100 per adult
            '2': { available: { land: 250 } },
        },
    };
    const per = estimateSpacePerAdult(info);
    assert.equal(per.land, 100);
    assert.equal(habitatCapacity(Object.assign({}, info, { spacePerAdult: per }), '2', 8), 2);
    assert.equal(habitatCapacity(Object.assign({}, info, { spacePerAdult: per }), '1', 8), 10);
    assert.equal(habitatCapacity({}, '9', 8), 8);
});

test('a big species plans in reasonable time', () => {
    const animals = [];
    for (let i = 0; i < 80; i++) {
        const fam = i % 8;
        animals.push(an('a' + i, i % 3 === 0 ? M : F, String(1 + (i % 5)), ['p' + fam, 'q' + fam], { genes: G('ABCDEFGH'[fam], 'ABCDEFGH'[(fam + 3) % 8]) }));
    }
    const model = buildKinModel(snap(animals, ['1', '2', '3', '4', '5', '6']));
    const t = Date.now();
    const plan = planProgramme(model, 'Lion', { mating: 'polygyny', social: { max: 16 } }, DEST(['1', '2', '3', '4', '5', '6']));
    const ms = Date.now() - t;
    console.log(`80 animals: ${ms} ms, ${plan.evaluations} evaluations, ${plan.moves.length} moves, related ${plan.before.relatedPairs} -> ${plan.after.relatedPairs}, pairs ${plan.before.breedingPairs} -> ${plan.after.breedingPairs}`);
    assert.ok(ms < 8000);
    assert.ok(plan.after.relatedPairs < plan.before.relatedPairs);
});

test('no needless moves: an equal layout with fewer moves wins', () => {
    // a has his daughter d with him; habitat 2 has an unrelated male b and female u.
    // Moving d alone to b fixes it; nothing else needs to move.
    const animals = [an('a', M, '1'), an('d', F, '1', ['a', 'x']), an('w', F, '1'), an('b', M, '2'), an('u', F, '2')];
    const model = buildKinModel(snap(animals));
    const plan = planProgramme(model, 'Lion', { mating: 'polygyny', social: { max: 5 } }, DEST(['1', '2', '3']));
    assert.equal(plan.after.relatedPairs, 0);
    assert.equal(plan.moves.length, 1, JSON.stringify(plan.moves));
    assert.equal(plan.moves[0].id, 'd');
});

test('pulls a breeder out of the trade centre into a habitat that needs one', () => {
    // habitat 1: two unrelated females, no male; an unrelated male waits at the trade centre
    const animals = [an('f1', F, '1'), an('f2', F, '1'), an('m', M, '', [], { lt: 'trade' })];
    const model = buildKinModel(snap(animals));
    const plan = planProgramme(model, 'Lion', { mating: 'polygyny', social: { max: 5 } }, DEST(['1', '2']));
    assert.deepEqual(plan.moves.map(m => [m.id, String(m.to)]), [['m', '1']]);
    assert.equal(plan.fromTrade, 1);
    assert.equal(plan.after.breedingPairs, 2);
});

test('trade centre animals stay put when asked not to use them', () => {
    const animals = [an('f1', F, '1'), an('m', M, '', [], { lt: 'trade' })];
    const model = buildKinModel(snap(animals));
    const plan = planProgramme(model, 'Lion', { mating: 'polygyny' }, DEST(['1']), { options: { useTradeCentre: false } });
    assert.equal(plan.moves.length, 0);
});
