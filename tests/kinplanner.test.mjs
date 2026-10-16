// node --test tests/kinplanner.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinModel, Sex } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';
import {
    buildMatrix, kinshipFraction, mateSections, overviewGroups, pickSpecies, plannerHabitats, resolveState, shortRelation,
    speciesTabs, stateFromOpen, tierNote, visibleCounts, worstOf, zooCounts,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kinplannercore.js';
import { mateCandidates } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';

const M = Sex.Male, F = Sex.Female;
const G = 'AABBCCDDEEFF';
const an = (id, sex, par, over = {}) => Object.assign({
    id, key: `animal_${id}`, guid: 'g' + id, name: id.toUpperCase(), species: 'Lion', sex, juv: false, contra: false,
    infertile: false, preg: false, hab: '1', loc: 'Savannah Habitat', par: par.map(p => p ? 'g' + p : ''), mates: [],
    genes: { F: G, I: G, S: G, L: G },
}, over);

// Savannah (1): lions a (father), k1 x k2 full siblings (mates), h1 half-sister
// on contraception, j juvenile daughter of k1, u unrelated female; one zebra
// pair (unrelated). Plains (3): a lone unrelated lioness. Empty (4): nobody.
function zoo() {
    return {
        v: 1, seq: 1, scope: 'park',
        habitats: [{ id: '1', name: 'Savannah Habitat' }, { id: '3', name: 'Plains Habitat' }, { id: '4', name: 'Empty Habitat' }],
        animals: [
            an('a', M, ['', '']),
            an('k1', M, ['a', 'b'], { mates: ['k2'] }),
            an('k2', F, ['a', 'b']),
            an('h1', F, ['a', 'e'], { contra: true }),
            an('j', F, ['k1', 'x'], { juv: true, infertile: true }),
            an('u', F, ['', '']),
            an('zm', M, ['', ''], { species: 'Zebra' }),
            an('zf', F, ['', ''], { species: 'Zebra' }),
            an('p', F, ['', ''], { hab: '3', loc: 'Plains Habitat' }),
        ],
        anc: {},
    };
}

test('sidebar: habitats with problems first, the rest by name, empty ones dropped', () => {
    const model = buildKinModel(zoo());
    const list = plannerHabitats(model);
    assert.deepEqual(list.map(h => h.id), ['1', '3']);
    assert.equal(list[0].worst, 'risk');
    assert.equal(list[0].animals, 8);
    assert.equal(list[1].worst, null);
    // hiding covered pairs drops them from the counts
    const covered = list[0].counts.covered;
    assert.ok(covered > 0);
    assert.equal(plannerHabitats(model, { showCovered: false })[0].counts.covered, 0);
    assert.deepEqual(plannerHabitats(null), []);
});

test('overview: counted pairs grouped by habitat, worst first', () => {
    const model = buildKinModel(zoo());
    const groups = overviewGroups(model);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, 'Savannah Habitat');
    const sev = groups[0].pairs.map(p => p.severity);
    assert.equal(sev[0], 'risk');
    assert.ok(sev.includes('covered'));
    assert.ok(sev.includes('future'));
    // mated siblings come first among the risks
    assert.ok(groups[0].pairs[0].mated);
    const noCovered = overviewGroups(model, { showCovered: false });
    assert.ok(!noCovered[0].pairs.some(p => p.severity === 'covered'));
    assert.deepEqual(zooCounts(model, false).covered, 0);
});

test('species tabs: worst first; pickSpecies keeps a valid wish', () => {
    const model = buildKinModel(zoo());
    const sum = model.habitatSummaries.get('1');
    const tabs = speciesTabs(sum);
    assert.deepEqual(tabs.map(t => t.species), ['Lion', 'Zebra']);
    assert.equal(tabs[0].males, 2);
    assert.equal(pickSpecies(sum, 'Zebra'), 'Zebra');
    assert.equal(pickSpecies(sum, 'Okapi'), 'Lion');
    assert.equal(pickSpecies(null, 'Lion'), null);
});

test('matrix: males x females, relation words, severities, mates, scores', () => {
    const model = buildKinModel(zoo());
    const m = buildMatrix(model, '1', 'Lion');
    assert.deepEqual(m.rows.map(a => a.id), ['a', 'k1']);
    // adults by name, then the juvenile
    assert.deepEqual(m.cols.map(a => a.id), ['h1', 'k2', 'u', 'j']);
    const cell = (r, c) => m.cells[m.rows.findIndex(a => a.id === r)][m.cols.findIndex(a => a.id === c)];
    assert.equal(cell('k1', 'k2').severity, 'risk');
    assert.equal(cell('k1', 'k2').word, 'sister');
    assert.equal(cell('k1', 'k2').mated, true);
    assert.equal(cell('a', 'k2').word, 'daughter');
    assert.equal(cell('k1', 'h1').severity, 'covered');
    assert.equal(cell('k1', 'h1').word, 'half-sister');
    assert.equal(cell('k1', 'j').severity, 'future');
    assert.equal(cell('a', 'j').word, 'granddaughter');
    assert.equal(cell('k1', 'u').severity, 'none');
    assert.equal(cell('k1', 'u').word, '');
    assert.equal(typeof cell('k1', 'u').score, 'number');
    assert.equal(m.worst.get('k1'), 'risk');
    assert.equal(m.worst.get('u'), undefined);
    // without the young
    const adults = buildMatrix(model, '1', 'Lion', { includeYoung: false });
    assert.equal(adults.cols.length, 3);
    assert.equal(adults.hiddenYoung, 1);
    assert.equal(buildMatrix(model, '9', 'Lion'), null);
});

test('matrix: unisex species are one square matrix with a blank diagonal', () => {
    const snap = zoo();
    snap.animals.push(an('s1', Sex.Unisex, ['', ''], { species: 'Snail', hab: '3' }), an('s2', Sex.Unisex, ['s1', ''], { species: 'Snail', hab: '3' }));
    const model = buildKinModel(snap);
    const m = buildMatrix(model, '3', 'Snail');
    assert.ok(m.unisex);
    assert.equal(m.rows, m.cols);
    assert.equal(m.cells[0][0].self, true);
    const i = m.rows.findIndex(a => a.id === 's1'), j = m.rows.findIndex(a => a.id === 's2');
    assert.equal(m.cells[i][j].word, 'offspring');
    assert.equal(m.cells[j][i].word, 'parent');
});

test('words and notes', () => {
    assert.equal(kinshipFraction(0.25), '1/4');
    assert.equal(kinshipFraction(1 / 16), '1/16');
    assert.equal(kinshipFraction(0.3), '');
    assert.equal(kinshipFraction(0), '');
    assert.equal(shortRelation({ code: 'greatGrandchild', full: false }, F), 'gt-granddaughter');
    assert.equal(shortRelation({ code: 'auntUncle', full: true }, Sex.Unisex), 'aunt/uncle');
    assert.equal(shortRelation(null, F), '');
    assert.match(tierNote('game'), /inbred/);
    assert.match(tierNote('distant', 1 / 16), /1\/16/);
    assert.match(tierNote('none'), /Not related/);
    assert.deepEqual(visibleCounts({ risk: 1, covered: 2 }, false), { risk: 1, kin: 0, future: 0, covered: 0 });
    assert.equal(worstOf({ risk: 0, kin: 0, future: 2, covered: 1 }), 'future');
    assert.equal(worstOf(null), null);
});

test('mate sections keep the ranking order and drop empty sections', () => {
    const model = buildKinModel(zoo());
    const secs = mateSections(mateCandidates(model, 'k1'));
    assert.deepEqual(secs.map(s => s.tier), ['none', 'game']);
    // equal genes: the one in the same habitat first; the juvenile is left out
    assert.deepEqual(secs[0].cands.map(c => c.animal.id), ['u', 'p']);
    assert.deepEqual(secs[1].cands.map(c => c.animal.id).sort(), ['h1', 'k2']);
    assert.equal(mateSections([]).length, 0);
});

test('open options: pair key, then animal, then habitat', () => {
    const model = buildKinModel(zoo());
    const risk = model.pairs.find(p => p.severity === 'risk' && p.mated);
    let st = stateFromOpen(model, { habitatId: '1', animalId: 'k2', pairKey: risk.key }, { includeYoung: false });
    assert.deepEqual(st.pair, { a: risk.a.id, b: risk.b.id });
    assert.equal(st.habId, '1');
    assert.equal(st.species, 'Lion');
    assert.equal(st.animal, null);
    // a pair with a juvenile turns the young back on
    const fut = model.pairs.find(p => p.severity === 'future');
    st = stateFromOpen(model, { pairKey: fut.key }, { includeYoung: false });
    assert.equal(st.includeYoung, true);
    st = stateFromOpen(model, { animalId: 'animal_p' }, { includeYoung: true });
    assert.equal(st.animal, 'p');
    assert.equal(st.habId, '3');
    st = stateFromOpen(model, { habitatId: 1, species: 'Zebra' }, {});
    assert.equal(st.habId, '1');
    assert.equal(st.species, 'Zebra');
    st = stateFromOpen(model, { pairKey: 'nope~nope', habitatId: '3' }, {});
    assert.equal(st.habId, '3');
    assert.equal(st.pair, null);
    // no model yet: the habitat is kept for later
    st = stateFromOpen(null, { habitatId: '1', pairKey: risk.key }, {});
    assert.equal(st.habId, '1');
});

test('resolveState drops what left the model and keeps the rest', () => {
    const model = buildKinModel(zoo());
    const base = { habId: '1', species: 'Lion', pair: { a: 'k1', b: 'k2' }, animal: 'u', includeYoung: true };
    assert.deepEqual(resolveState(model, base), base);
    assert.equal(resolveState(model, Object.assign({}, base, { habId: '4' })).habId, null);
    assert.equal(resolveState(model, Object.assign({}, base, { species: 'Okapi' })).species, 'Lion');
    assert.equal(resolveState(model, Object.assign({}, base, { animal: 'gone' })).animal, null);
    // a juvenile pair disappears when the young are hidden
    assert.equal(resolveState(model, Object.assign({}, base, { pair: { a: 'k1', b: 'j' }, includeYoung: false })).pair, null);
    // a pair from another habitat is dropped
    assert.equal(resolveState(model, Object.assign({}, base, { pair: { a: 'k1', b: 'p' } })).pair, null);
    // waiting for data: nothing changes
    assert.deepEqual(resolveState(null, base), base);
});
