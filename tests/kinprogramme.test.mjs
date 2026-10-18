// node --test tests/kinprogramme.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinModel, Sex } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';
import { TRADE, simulatePlan } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kinboardcore.js';
import {
    planProgramme, isBreeder, conceptionChance, youngQuality, habitatCapacity, estimateSpacePerAdult,
    groupRule, parseRatio, reduceRatio, ratioKey, groupTarget, maxWeightPairs, scoreLayout, planProgrammeAsync, RATIO_CHOICES,
    unknownMakeupText,
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

// ------------------------------------------------------- group make-up

test('make-up: parse, reduce and the sources in order', () => {
    assert.deepEqual(parseRatio('1:3'), { m: 1, f: 3 });
    assert.deepEqual(parseRatio('*:1'), { m: Infinity, f: 1 });
    assert.equal(parseRatio('2:3'), null);           // one side is always 1
    assert.equal(parseRatio('auto'), null);
    assert.equal(parseRatio('mixed'), 'mixed');
    for (const c of RATIO_CHOICES) if (c !== 'auto') assert.ok(parseRatio(c), c);
    assert.deepEqual(reduceRatio(2, 6), { m: 1, f: 3 });
    assert.deepEqual(reduceRatio(3, 1), { m: 3, f: 1 });
    // the mating system alone
    assert.equal(ratioKey(groupRule({ mating: 'polygyny' })), '1:*');
    assert.equal(ratioKey(groupRule({ mating: 'monogamy' })), '1:1');
    assert.equal(ratioKey(groupRule({ mating: 'polyandry' })), '*:1');
    const none = groupRule({});
    assert.equal(ratioKey(none), 'mixed');
    assert.equal(none.source, 'none');
    // the game's social groups beat the mating system (when they agree with it)
    const groups = [{ kind: 'pair', m: 1, f: 1 }, { kind: 'mixed', m: 2, f: 6 }];
    const g = groupRule({ mating: 'polygyny', groups });
    assert.equal(ratioKey(g), '1:3');
    assert.equal(g.source, 'groups');
    // a monogamous species keeps pairs whatever the groups say
    assert.equal(ratioKey(groupRule({ mating: 'monogamy', groups: [{ kind: 'mixed', m: 1, f: 4 }] })), '1:1');
    // the game's most per sex: ratio and caps
    const caps = groupRule({ mating: 'polygyny', sexMax: { male: 1, female: 5 }, groups });
    assert.equal(ratioKey(caps), '1:5');
    assert.equal(caps.source, 'game');
    assert.equal(caps.maxMales, 1);
    // the player's choice wins; the game's caps still hold
    const mine = groupRule({ mating: 'polygyny', sexMax: { male: 1, female: 5 } }, '1:2');
    assert.equal(ratioKey(mine), '1:2');
    assert.equal(mine.source, 'yours');
    assert.equal(mine.maxMales, 1);
    assert.equal(ratioKey(groupRule({ mating: 'polygyny' }, 'mixed')), 'mixed');
});

test('make-up: Polygyandry, solitary species and an unread rule', () => {
    // Polygyandry (the Zoopedia's "Promiscuous": tigers, bears) is a rule the
    // mod read: mixed groups from the mating system, no "unknown" note
    const solo = [{ kind: 'maleSolitary', m: 1, f: 0 }, { kind: 'femaleSolitary', m: 0, f: 1 }];
    const tiger = groupRule({ mating: 'mixed', groups: solo, social: { max: 2 } });
    assert.equal(ratioKey(tiger), 'mixed');
    assert.equal(tiger.source, 'mating');
    assert.equal(tiger.system, 'mixed');
    assert.equal(tiger.solitary, true);
    // a solitary species with a pair rule keeps it
    assert.equal(ratioKey(groupRule({ mating: 'monogamy', groups: solo })), '1:1');
    assert.equal(ratioKey(groupRule({ mating: 'polygyny', groups: solo })), '1:*');
    // Polygyandry with a mixed group: the group's make-up
    assert.equal(ratioKey(groupRule({ mating: 'mixed', groups: [{ kind: 'mixed', m: 1, f: 2 }] })), '1:2');
    // no rule read and one-sex groups: not known, mixed groups assumed
    const unread = groupRule({ matingRaw: '9', groups: solo });
    assert.equal(unread.source, 'none');
    assert.equal(unread.solitary, true);
    assert.equal(groupRule({ groups: [{ kind: 'mixed', m: 1, f: 3 }] }).solitary, false);
    assert.equal(groupRule({}).solitary, false);
    // only male groups, or groups without counts
    assert.equal(groupRule({ groups: [{ kind: 'maleBachelor', m: 3, f: 0 }] }).source, 'none');
    assert.equal(groupRule({ groups: [{ kind: 'maleBachelor', m: 3, f: 0 }] }).solitary, true);
});

test('make-up: the note when the make-up is not known', () => {
    const solo = [{ kind: 'maleSolitary', m: 1, f: 0 }, { kind: 'femaleSolitary', m: 0, f: 1 }];
    const t = unknownMakeupText({ matingRaw: '9', groups: solo, social: { max: 2 } });
    assert.match(t, /mating rule came as "9", which the mod can't read/);
    assert.match(t, /all of one sex \(male alone: 1 ♂ 0 ♀, female alone: 0 ♂ 1 ♀\), as for a solitary species/);
    assert.match(t, /Mixed groups are assumed: each female with her best unrelated male, up to 2 adults per habitat\./);
    assert.match(t, /choose the make-up with the arrows/);
    const bare = unknownMakeupText({});
    assert.match(bare, /^The game gave no mating rule, and no group make-up\. Mixed groups are assumed: each female with her best unrelated male\. /);
    assert.doesNotMatch(bare, /solitary|undefined|null/);
    // a group kind the mod has no words for keeps its name; missing counts read 0
    assert.match(unknownMakeupText({ groups: [{ kind: 'Herd', m: 2 }] }), /\(Herd: 2 ♂ 0 ♀\), as for a solitary species/);
    assert.doesNotMatch(unknownMakeupText({ matingRaw: '' }), /came as/);
});

test('make-up: the target group for the room of a habitat', () => {
    const r = s => groupRule({}, s);
    assert.deepEqual(groupTarget(r('1:3'), 8), { males: 2, females: 6 });
    assert.deepEqual(groupTarget(r('1:3'), 6), { males: 2, females: 4 });   // 4 pairs beat 3
    assert.deepEqual(groupTarget(r('1:3'), 4), { males: 1, females: 3 });
    assert.deepEqual(groupTarget(r('1:*'), 6), { males: 1, females: 5 });
    assert.deepEqual(groupTarget(r('1:1'), 5), { males: 2, females: 2 });
    assert.deepEqual(groupTarget(r('2:1'), 6), { males: 4, females: 2 });
    assert.equal(groupTarget(r('mixed'), 6), null);
    const capped = groupRule({ mating: 'polygyny', sexMax: { male: 1, female: 3 } }, '1:3');
    assert.deepEqual(groupTarget(capped, 10), { males: 1, females: 3 });
});

// a small seeded random source for the generated cases
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test('best pairs: exact against every matching', () => {
    const r = rng(7);
    for (let c = 0; c < 300; c++) {
        const nM = 1 + Math.floor(r() * 4), nF = 1 + Math.floor(r() * 5);
        const perMale = [1, 2, 3, Infinity][Math.floor(r() * 4)];
        const perFemale = perMale === 1 && r() < 0.4 ? [2, Infinity][Math.floor(r() * 2)] : 1;
        const w = Array.from({ length: nM }, () => Array.from({ length: nF }, () => (r() < 0.2 ? -1 : Math.round(r() * 100) / 100)));
        const males = Array.from({ length: nM }, (_, i) => i), females = Array.from({ length: nF }, (_, j) => 10 + j);
        const got = maxWeightPairs(males, females, (m, f) => w[m][f - 10], perMale, perFemale).reduce((s, p) => s + p[0], 0);
        // brute force: every set of pairs within the limits
        const pairs = [];
        for (let i = 0; i < nM; i++) for (let j = 0; j < nF; j++) if (w[i][j] > 0) pairs.push([i, j]);
        let best = 0;
        for (let mask = 0; mask < (1 << pairs.length); mask++) {
            const um = new Array(nM).fill(0), uf = new Array(nF).fill(0);
            let v = 0, ok = true;
            for (let k = 0; k < pairs.length && ok; k++) {
                if (!(mask & (1 << k))) continue;
                const [i, j] = pairs[k];
                if (++um[i] > perMale || ++uf[j] > perFemale) ok = false;
                v += w[i][j];
            }
            if (ok && v > best) best = v;
        }
        assert.ok(Math.abs(got - best) < 1e-9, `case ${c}: ${nM}x${nF} per ${perMale}/${perFemale}: got ${got}, best ${best}`);
    }
});

test('1:3: two males share a big habitat; a harem keeps one', () => {
    const animals = [an('m1', M, '1'), an('m2', M, '1'), ...[1, 2, 3, 4, 5, 6].map(i => an('f' + i, F, '1'))];
    const model = buildKinModel(snap(animals, ['1']));
    const three = planProgramme(model, 'Lion', { mating: 'polygyny', social: { max: 8 } }, DEST(['1']), { options: { ratio: '1:3' } });
    assert.equal(three.moves.length, 0, JSON.stringify(three.moves));
    assert.equal(three.after.breedingPairs, 6);
    assert.deepEqual(three.groups.find(g => g.hab === '1').target, { males: 2, females: 6 });
    const harem = planProgramme(model, 'Lion', { mating: 'polygyny', social: { max: 8 } }, DEST(['1']));
    assert.equal(harem.rule.source, 'mating');
    assert.deepEqual(harem.moves.map(m => m.to), [TRADE]);             // one male leaves
});

test('1:3: open places fill from the trade centre and from a habitat with surplus', () => {
    // habitat 1: a male with five females (two more than he takes); habitat 2: a male alone;
    // the trade centre: an unrelated female and a spare male
    const animals = [
        an('a', M, '1'), ...[1, 2, 3, 4, 5].map(i => an('f' + i, F, '1')),
        an('b', M, '2'),
        an('t1', F, '', [], { lt: 'trade' }), an('t2', M, '', [], { lt: 'trade' }),
    ];
    const model = buildKinModel(snap(animals, ['1', '2']));
    const plan = planProgramme(model, 'Lion', { mating: 'polygyny', social: { max: 6 } }, DEST(['1', '2']), { options: { ratio: '1:3' } });
    // every female breeds: the one from the trade centre and one of habitat
    // 1's surplus go to the lone male; the spare male takes the 4th female
    // left in habitat 1 (1:3 lets a habitat of 4 females have 2 males)
    assert.equal(where(model, plan, 't1'), '2', JSON.stringify(plan.moves));
    assert.ok(['f1', 'f2', 'f3', 'f4', 'f5'].some(id => where(model, plan, id) === '2'), JSON.stringify(plan.moves));
    assert.equal(plan.after.breedingPairs, 6);
    assert.equal(plan.after.idle, 0);
    assert.equal(plan.before.idle, 5);                                   // 2 surplus females, the lone male, the 2 at the trade centre
    // without the spare male, habitat 1 keeps 3 and the other 2 go to habitat 2
    const noSpare = buildKinModel(snap(animals.filter(a => a.id !== 't2'), ['1', '2']));
    const p2 = planProgramme(noSpare, 'Lion', { mating: 'polygyny', social: { max: 6 } }, DEST(['1', '2']), { options: { ratio: '1:3' } });
    const fem = ['f1', 'f2', 'f3', 'f4', 'f5', 't1'];
    assert.equal(fem.filter(id => where(noSpare, p2, id) === '1').length, 3, JSON.stringify(p2.moves));
    assert.equal(fem.filter(id => where(noSpare, p2, id) === '2').length, 3, JSON.stringify(p2.moves));
});

test('1:3: extra males leave for a habitat that has none', () => {
    const animals = [an('m1', M, '1'), an('m2', M, '1'), an('m3', M, '1'), an('f1', F, '1'), an('f2', F, '1'), an('f3', F, '1'), an('g1', F, '2'), an('g2', F, '2')];
    const model = buildKinModel(snap(animals, ['1', '2']));
    const plan = planProgramme(model, 'Lion', { mating: 'polygyny', social: { max: 8 } }, DEST(['1', '2']), { options: { ratio: '1:3' } });
    assert.equal(['m1', 'm2', 'm3'].filter(id => where(model, plan, id) === '1').length, 1);
    assert.equal(['m1', 'm2', 'm3'].filter(id => where(model, plan, id) === '2').length, 1);
    assert.equal(plan.after.breedingPairs, 5);
});

test('a new group: a male and a female from the trade centre together into an empty habitat', () => {
    const animals = [an('m', M, '', [], { lt: 'trade' }), an('f', F, '', [], { lt: 'trade' })];
    const model = buildKinModel(snap(animals, ['1']));
    const plan = planProgramme(model, 'Lion', { mating: 'monogamy', social: { max: 4 } }, DEST(['1']));
    assert.deepEqual(plan.moves.map(x => [x.id, x.to]).sort(), [['f', '1'], ['m', '1']]);
    // the search alone (no full enumeration) finds it too
    const heur = planProgramme(model, 'Lion', { mating: 'monogamy', social: { max: 4 } }, DEST(['1']), { options: { exactLimit: 0 } });
    assert.equal(heur.moves.length, 2);
});

// a random small zoo: families, genes, bonds, the trade centre
function smallZoo(seed) {
    const r = rng(seed);
    const L = 'ABCDEFGH';
    const strand = () => Array.from({ length: 6 }, () => L[Math.floor(r() * 8)]).join('');
    const habs = ['1', '2', '3'].slice(0, 2 + Math.floor(r() * 2));
    const n = 5 + Math.floor(r() * 3);
    const animals = [];
    for (let i = 0; i < n; i++) {
        const trade = r() < 0.2;
        const hab = trade ? '' : habs[Math.floor(r() * habs.length)];
        const fam = Math.floor(r() * 3);
        animals.push(an('a' + i, r() < 0.5 ? M : F, hab, r() < 0.6 ? ['p' + fam, 'q' + fam] : [], {
            lt: trade ? 'trade' : 'habitat',
            genes: { F: strand() + strand(), I: strand() + strand(), S: strand() + strand(), L: strand() + strand() },
        }));
    }
    for (const a of animals) {
        if (a.mates.length || !a.hab || r() > 0.3) continue;
        const b = animals.find(x => x !== a && x.hab === a.hab && x.sex !== a.sex && !x.mates.length);
        if (b) {
            a.mates = [b.id];
            b.mates = [a.id];
        }
    }
    const mating = ['polygyny', 'monogamy', 'mixed', 'polyandry'][Math.floor(r() * 4)];
    const ratio = ['auto', 'auto', '1:2', '1:3', '2:1'][Math.floor(r() * 5)];
    const info = { mating, social: { max: 2 + Math.floor(r() * 4) } };
    return { model: buildKinModel(snap(animals, habs)), habs, info, ratio };
}

test('every layout: the exhaustive answer is the true optimum (each layout scored from scratch)', () => {
    for (let seed = 1; seed <= 12; seed++) {
        const { model, habs, info, ratio } = smallZoo(seed);
        const dest = DEST(habs);
        const plan = planProgramme(model, 'Lion', info, dest, { options: { ratio } });
        assert.equal(plan.exact, true);
        const ids = Array.from(model.animals.values()).map(a => a.id);
        const places = habs.concat([TRADE]);
        let best = -Infinity;
        const total = places.length ** ids.length;
        for (let k = 0; k < total; k++) {
            let x = k;
            const moves = [];
            for (const id of ids) {
                const to = places[x % places.length];
                x = Math.floor(x / places.length);
                const a = model.animals.get(id);
                if (to !== (a.hab || TRADE)) moves.push({ id, to });
            }
            const s = scoreLayout(model, 'Lion', info, dest, { options: { ratio } }, moves);
            if (s != null && s > best) best = s;
        }
        assert.ok(Math.abs(plan.score - best) < 1e-6, `seed ${seed}: plan ${plan.score}, best ${best}`);
        assert.ok(Math.abs(scoreLayout(model, 'Lion', info, dest, { options: { ratio } }, plan.moves) - plan.score) < 1e-6);
    }
});

test('the search alone finds the optimum on small zoos', () => {
    const missed = [];
    for (let seed = 100; seed < 260; seed++) {
        const { model, habs, info, ratio } = smallZoo(seed);
        const exact = planProgramme(model, 'Lion', info, DEST(habs), { options: { ratio } });
        const heur = planProgramme(model, 'Lion', info, DEST(habs), { options: { ratio, exactLimit: 0 } });
        assert.equal(heur.exact, false);
        if (heur.score < exact.score - 1e-6) missed.push(`${seed}: ${heur.score.toFixed(4)} < ${exact.score.toFixed(4)}`);
    }
    assert.deepEqual(missed, []);
});

test('the same zoo gives the same plan', () => {
    const animals = [];
    for (let i = 0; i < 40; i++) animals.push(an('a' + i, i % 3 === 0 ? M : F, String(1 + (i % 5)), ['p' + (i % 7), 'q' + (i % 7)], { genes: G('ABCDEFGH'[i % 8], 'ABCDEFGH'[(i + 3) % 8]) }));
    const model = buildKinModel(snap(animals, ['1', '2', '3', '4', '5', '6']));
    const info = { mating: 'polygyny', social: { max: 9 } };
    const dest = DEST(['1', '2', '3', '4', '5', '6']);
    const a = planProgramme(model, 'Lion', info, dest, { options: { ratio: '1:3' } });
    const b = planProgramme(model, 'Lion', info, dest, { options: { ratio: '1:3' } });
    assert.deepEqual(a.moves, b.moves);
    assert.equal(a.score, b.score);
});

test('in slices: the same plan, with progress, and it can be stopped', async () => {
    const animals = [];
    for (let i = 0; i < 30; i++) animals.push(an('a' + i, i % 2 ? M : F, String(1 + (i % 4)), ['p' + (i % 5), 'q' + (i % 5)], { genes: G('ABCDEFGH'[i % 8], 'ABCDEFGH'[(i + 5) % 8]) }));
    const model = buildKinModel(snap(animals, ['1', '2', '3', '4', '5']));
    const info = { mating: 'monogamy', social: { max: 8 } };
    const dest = DEST(['1', '2', '3', '4', '5']);
    const sync = planProgramme(model, 'Lion', info, dest);
    const seen = [];
    const slow = await planProgrammeAsync(model, 'Lion', info, dest, { sliceMs: 2, onProgress: v => seen.push(v) });
    assert.deepEqual(slow.moves, sync.moves);
    assert.ok(seen.length > 1, 'progress reported');
    assert.ok(seen.every(v => v >= 0 && v <= 1));
    let calls = 0;
    const stopped = await planProgrammeAsync(model, 'Lion', info, dest, { sliceMs: 1, isCancelled: () => ++calls > 2 });
    assert.equal(stopped, null);
});

test('unisex: two make one couple, one partner each under 1:1', () => {
    const U = Sex.Unisex;
    const two = buildKinModel(snap([an('u1', U, '1'), an('u2', U, '1')], ['1']));
    for (const mating of ['monogamy', 'mixed']) {
        const plan = planProgramme(two, 'Lion', { mating, social: { max: 4 } }, DEST(['1']));
        assert.equal(plan.after.breedingPairs, 1, mating);
        assert.equal(plan.after.idle, 0, mating);
    }
    const three = buildKinModel(snap([an('u1', U, '1'), an('u2', U, '1'), an('u3', U, '1')], ['1']));
    const pairs = planProgramme(three, 'Lion', { mating: 'monogamy', social: { max: 4 } }, DEST(['1']));
    assert.equal(pairs.after.breedingPairs, 1);
    assert.equal(pairs.after.idle, 1);
});

test('assignments: a breeder outside them may stay where it is', () => {
    // habitat 2 is not assigned to the species; its pair there is fine, so nothing moves
    const animals = [an('m', M, '2'), an('f', F, '2'), an('m1', M, '1'), an('f1', F, '1')];
    const model = buildKinModel(snap(animals, ['1', '2']));
    for (const exactLimit of [20000, 0]) {
        const plan = planProgramme(model, 'Lion', { mating: 'monogamy', social: { max: 2 } }, DEST(['1', '2']), { assignments: { '1': ['Lion'] }, options: { exactLimit } });
        assert.equal(plan.moves.length, 0, JSON.stringify(plan.moves));
    }
});
