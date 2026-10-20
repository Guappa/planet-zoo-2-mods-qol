// node --test tests/kinlife.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinModel, Sex } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';
import {
    LEVELS, ageRate, assessGrowUp, createLifeState, describeEvent, growthOf, habitatAdults, lifeEvents, stableRate, whenText,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kinlife.js';

const M = Sex.Male, F = Sex.Female;
let n = 0;
// an adult lion in the Savannah (habitat 1), unrelated founder by default
const adult = (id, sex, over = {}) => Object.assign({
    id, key: `animal_${id}`, guid: 'g' + id, name: id.toUpperCase(), species: 'Lion', sex, juv: false, contra: false,
    infertile: false, preg: false, hab: '1', loc: 'Savannah Habitat', par: [], mates: [], age: 6 + (n++ % 3),
}, over);
// a cub: juvenile, infertile because young, adult at 2 years
const cub = (id, sex, over = {}) => adult(id, sex, Object.assign({ juv: true, infertile: true, age: 1.8, adultAge: 2, adultIn: 0.2 }, over));

function snap(animals, facts = {}) {
    return {
        v: 1, seq: 1, scope: 'park',
        habitats: [{ id: '1', name: 'Savannah Habitat' }, { id: '2', name: 'Plains Habitat' }],
        animals,
        anc: {},
        speciesFacts: { Lion: Object.assign({ maturity: 3, infertility: 15, life: 20 }, facts) },
    };
}

const adults = k => Array.from({ length: k }, (_, i) => adult('a' + i, i === 0 ? M : F));

test('levels: three, ranked', () => {
    assert.ok(LEVELS.action.rank > LEVELS.heads.rank && LEVELS.heads.rank > LEVELS.info.rank);
    assert.equal(LEVELS.action.label, 'Needs you');
    assert.equal(LEVELS.heads.label, 'Heads-up');
});

test('growthOf: adult age first, the breeding age as a fallback, young adults', () => {
    assert.deepEqual(growthOf(cub('c', M)), { kind: 'adult', years: 0.2, source: 'adultAge' });
    assert.equal(growthOf(cub('c', M, { adultIn: undefined })).years.toFixed(2), '0.20');
    const m = buildKinModel(snap([cub('c', M, { adultIn: undefined, adultAge: undefined, age: 2.8 })]));
    assert.equal(growthOf(m.animals.get('c')).source, 'maturity');
    assert.equal(growthOf(m.animals.get('c')).years.toFixed(2), '0.20');
    const young = buildKinModel(snap([adult('y', F, { infertile: true, age: 2.7 })])).animals.get('y');
    assert.equal(growthOf(young).kind, 'breed');
    assert.equal(growthOf(adult('z', F)), null);
    assert.equal(growthOf(cub('c', M, { adultIn: undefined, adultAge: undefined })), null, 'no ages known: no growth');
});

test('a contracepted cub with room in the group: info only', () => {
    const m = buildKinModel(snap([...adults(3), cub('c', F, { contra: true })], { social: { min: 2, max: 8 }, maturation: 'males' }));
    const r = assessGrowUp(m, m.animals.get('c'));
    assert.equal(r.level, 'info');
    assert.deepEqual(r.reasons, []);
    assert.equal(habitatAdults(m, '1', 'Lion').length, 3);
});

test('group limit: 9 adults with a limit of 8 needs you, exactly 8 is a heads-up', () => {
    let m = buildKinModel(snap([...adults(8), cub('c', F, { contra: true })], { social: { min: 2, max: 8 } }));
    let r = assessGrowUp(m, m.animals.get('c'));
    assert.equal(r.level, 'action');
    assert.equal(r.reasons[0].code, 'group');
    assert.match(r.reasons[0].text, /9 adults; the game allows 8/);
    m = buildKinModel(snap([...adults(7), cub('c', F, { contra: true })], { social: { min: 2, max: 8 } }));
    r = assessGrowUp(m, m.animals.get('c'));
    assert.equal(r.level, 'heads');
    assert.equal(r.reasons[0].code, 'groupFull');
    // two cubs growing together count twice
    m = buildKinModel(snap([...adults(7), cub('c', F, { contra: true }), cub('d', F, { contra: true })], { social: { min: 2, max: 8 } }));
    const growing = [m.animals.get('c'), m.animals.get('d')];
    assert.equal(assessGrowUp(m, growing[0], { growing }).level, 'action');
});

test('maturation: a matrilineal male cub needs you even on contraception', () => {
    const m = buildKinModel(snap([...adults(3), cub('c', M, { contra: true }), cub('d', F, { contra: true })], { social: { min: 2, max: 10 }, maturation: 'males' }));
    const r = assessGrowUp(m, m.animals.get('c'));
    assert.equal(r.level, 'action');
    assert.equal(r.reasons[0].code, 'maturation');
    assert.match(r.reasons[0].text, /pushed out of the group/);
    assert.equal(assessGrowUp(m, m.animals.get('d')).level, 'info', 'the female cub stays');
    // alone in the habitat: nobody pushes it out
    const lone = buildKinModel(snap([cub('c', M, { hab: '2' })], { maturation: 'males' }));
    assert.equal(assessGrowUp(lone, lone.animals.get('c')).reasons.filter(x => x.code === 'maturation').length, 0);
});

test('a future pair (a cub and its relative) needs you, with contraception offered for the cub', () => {
    const dad = adult('dad', M);
    const kid = cub('kid', F, { par: ['gdad', 'gmom'] });
    const m = buildKinModel(snap([dad, adult('mom', F), kid], { social: { min: 2, max: 10 }, maturation: 'none' }));
    assert.ok(m.pairs.some(p => p.severity === 'future'));
    const r = assessGrowUp(m, m.animals.get('kid'));
    assert.equal(r.level, 'action');
    const k = r.reasons.find(x => x.code === 'kin');
    assert.match(k.text, /DAD is KID's father/);
    assert.equal(k.contra.id, 'kid');
});

test('a fertile cub joining a full group with an unrelated partner: heads-up', () => {
    const m = buildKinModel(snap([...adults(7), cub('c', F)], { social: { min: 2, max: 8 }, maturation: 'none' }));
    const r = assessGrowUp(m, m.animals.get('c'));
    assert.equal(r.level, 'heads');
    assert.ok(r.reasons.some(x => x.code === 'breedFull' && x.contra.id === 'c'));
});

test('no social limit and no maturation rule: nothing to judge by, info', () => {
    const m = buildKinModel(snap([...adults(12), cub('c', M)]));
    const r = assessGrowUp(m, m.animals.get('c'));
    assert.equal(r.level, 'info');
    assert.deepEqual(r.skipped, ['social', 'maturation']);
});

test('events: birth vs arrival, once per animal, settle on the first scan', () => {
    const facts = { social: { min: 2, max: 8 }, maturation: 'none' };
    const state = createLifeState();
    const s0 = buildKinModel(snap([...adults(7), cub('c', F, { contra: true })], facts));
    // first scan: only remembered (settle), flagged
    const first = lifeEvents(null, s0, { state, now: 1000 });
    assert.equal(first.length, 1);
    assert.equal(first[0].kind, 'soon');
    assert.equal(first[0].settle, true);
    assert.equal(first[0].level, 'heads');
    // same again: nothing (once per animal)
    assert.deepEqual(lifeEvents(s0, s0, { state, now: 2000 }), []);
    // a newborn and an older arrival
    const s1 = buildKinModel(snap([...adults(7), cub('c', F, { contra: true }),
        cub('nb', M, { age: 0.05, adultIn: 1.95 }), cub('old', M, { age: 1.0, adultIn: 1.0 })], facts));
    const ev = lifeEvents(s0, s1, { state, now: 3000 });
    const births = ev.filter(e => e.kind === 'birth');
    assert.equal(births.length, 1);
    assert.deepEqual(births[0].animals.map(a => a.id), ['nb']);
    assert.equal(births[0].level, 'info');
    assert.equal(ev.filter(e => e.kind === 'soon').length, 0, 'not within the horizon');
});

test('events: grew up, then pushed out at maturation within 3 scans needs you', () => {
    const facts = { social: { min: 2, max: 10 }, maturation: 'none' };
    const state = createLifeState();
    const s0 = buildKinModel(snap([...adults(3), cub('c', M, { contra: true, adultIn: 2 })], facts));
    lifeEvents(null, s0, { state, now: 0 });
    const s1 = buildKinModel(snap([...adults(3), adult('c', M, { contra: true })], facts));
    const e1 = lifeEvents(s0, s1, { state, now: 1 });
    assert.equal(e1.length, 1);
    assert.equal(e1[0].kind, 'adult');
    assert.equal(e1[0].level, 'info');
    const s2 = buildKinModel(snap([...adults(3), adult('c', M, { contra: true, out: 'mat' })], { social: { min: 2, max: 10 }, maturation: 'males' }));
    const e2 = lifeEvents(s1, s2, { state, now: 2 });
    assert.equal(e2.length, 1);
    assert.equal(e2[0].kind, 'out');
    assert.equal(e2[0].level, 'action');
    assert.match(describeEvent(e2[0], { place: 'Savannah Habitat', species: 'Lion' }).text, /C was pushed out of the group: its group drives out grown males \(maturation\)/);
    assert.deepEqual(lifeEvents(s2, s2, { state, now: 3 }), [], 'said once');
    // a maturation outsider long after growing up is not news; a new overpopulation outsider is
    const s3 = buildKinModel(snap([...adults(3).map((a, i) => i === 1 ? Object.assign(a, { out: 'pop' }) : a), adult('c', M, { contra: true, out: 'mat' })], facts));
    const e3 = lifeEvents(s2, s3, { state, now: 4 });
    assert.equal(e3.length, 1);
    assert.equal(e3[0].animals[0].id, 'a1');
});

test('events: grouped per habitat and species, worst level wins', () => {
    const facts = { social: { min: 2, max: 8 }, maturation: 'males' };
    const s0 = buildKinModel(snap([...adults(6), cub('c', M, { contra: true }), cub('d', F, { contra: true })], facts));
    const ev = lifeEvents(s0, s0, { state: createLifeState(), now: 0 });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].animals.length, 2);
    assert.equal(ev[0].level, 'action');
    const d = describeEvent(ev[0], { place: 'Savannah Habitat', species: 'Lion', rate: null });
    assert.match(d.title, /^Savannah Habitat · Lion: 2 young grow up soon/);
});

test('ageRate: median game years per real minute; whenText', () => {
    const s0 = buildKinModel(snap([adult('a', M, { age: 5 }), adult('b', F, { age: 6 }), adult('c', F, { age: 7 }), adult('d', F, { age: 8 })]));
    const s1 = buildKinModel(snap([adult('a', M, { age: 5.1 }), adult('b', F, { age: 6.1 }), adult('c', F, { age: 7.1 }), adult('d', F, { age: 9 })]));
    assert.ok(Math.abs(ageRate(s0, s1, 60000) - 0.1) < 1e-9);
    assert.equal(ageRate(s0, s0, 60000), null, 'paused: no rate');
    assert.equal(ageRate(s0, s1, 0), null);
    assert.equal(stableRate([0.1, 0.11, 0.1]), 0.1);
    assert.equal(stableRate([0.1, 0.3, 0.1]), null);
    assert.equal(whenText(0.3, 0.1), 'in about 3 min');
    assert.equal(whenText(0.3, null), 'in about 0.3 years');
});
