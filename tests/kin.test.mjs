// node --test tests/kin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildKinModel, normalizeSnapshot, Pedigree, predictOffspring, ownGrades, offspringScore, relationWord,
    animalSeverity, animalPairs, explainRelation, habitatSummary, habitatByName, habitatsAtRisk, mateCandidates,
    newRisks, relatedAmong, relativesOf, percent, Sex, pairSeverity, describeRelation, worstSeverity, kinClusters, canLocate,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';

const M = Sex.Male, F = Sex.Female;
const an = (id, sex, par, over = {}) => Object.assign({
    id, key: `animal_${id}`, guid: 'g' + id, name: id.toUpperCase(), species: 'Lion', sex, juv: false, contra: false,
    infertile: false, preg: false, hab: '1', loc: 'Savannah Habitat', par: par.map(p => p ? 'g' + p : ''), mates: [],
}, over);

// Savannah (habitat 1), lions:
//   a (father of k1, k2, h1), b (dead), e (dead)
//   k1 x k2 full siblings; h1 their half-sister (mother e), on contraception
// Jungle (habitat 2), tigers:
//   gp (grandfather of y), x and y first cousins (their parents p1, p2 are
//   full siblings, children of gp and gm), z a juvenile half-sister of x
const tiger = (id, sex, par, over = {}) => an(id, sex, par, Object.assign({ species: 'Tiger', hab: '2', loc: 'Jungle Habitat' }, over));
function zoo(extra = []) {
    return {
        v: 1, seq: 3, scope: 'park',
        habitats: [{ id: '1', name: 'Savannah Habitat' }, { id: '2', name: 'Jungle Habitat' }, { id: '3', name: 'Plains Habitat' }],
        animals: [
            an('a', M, ['', '']),
            an('k1', M, ['a', 'b']),
            an('k2', F, ['a', 'b']),
            an('h1', F, ['a', 'e'], { contra: true }),
            an('u', F, ['', ''], { hab: '3', loc: 'Plains Habitat' }),
            tiger('gp', M, ['', '']),
            tiger('x', M, ['p1', 'q1']),
            tiger('y', F, ['p2', 'q2']),
            tiger('z', F, ['q1', 'r'], { juv: true, infertile: true }),
            ...extra,
        ],
        anc: { gp1: ['ggp', 'ggm'], gp2: ['ggp', 'ggm'], gb: [], ge: [], gq1: [], gq2: [], gr: [] },
    };
}

test('normalize: defaults, strings, unknown parents dropped', () => {
    const s = normalizeSnapshot({ animals: [{ id: 5, guid: 0, par: ['', 0, 'g1'], sex: 1 }], anc: { '': ['x'], g1: ['', 'g2'] } });
    assert.equal(s.animals[0].id, '5');
    assert.equal(s.animals[0].guid, '');
    assert.deepEqual(s.animals[0].par, ['g1']);
    assert.equal(s.animals[0].key, 'animal_5');
    assert.deepEqual(s.anc, { g1: ['g2'] });
    assert.equal(s.scope, 'park');
});

test('kinship coefficients follow the textbook values', () => {
    const ped = new Pedigree(normalizeSnapshot(zoo()));
    assert.equal(ped.kinship('ga', 'gk1'), 0.25);         // parent / child
    assert.equal(ped.kinship('gk1', 'gk2'), 0.25);        // full siblings
    assert.equal(ped.kinship('gk1', 'gh1'), 0.125);       // half siblings
    assert.equal(ped.kinship('gx', 'gy'), 0.0625);        // first cousins
    assert.equal(ped.kinship('ggp', 'gy'), 0.125);        // grandparent
    assert.equal(ped.kinship('gx', 'gz'), 0.125);         // half siblings via q1
    assert.equal(ped.kinship('ga', 'gu'), 0);
    assert.equal(ped.kinship('ga', 'ga'), 0.5);
});

test('game rule: parent/child and shared parent only', () => {
    const ped = new Pedigree(normalizeSnapshot(zoo()));
    assert.equal(ped.gameInbred('ga', 'gk2'), true);
    assert.equal(ped.gameInbred('gk1', 'gk2'), true);
    assert.equal(ped.gameInbred('gk1', 'gh1'), true);
    assert.equal(ped.gameInbred('gx', 'gy'), false);      // cousins: not flagged by the game
    assert.equal(ped.gameInbred('ggp', 'gy'), false);     // grandparent: not flagged
});

test('relations and words', () => {
    const ped = new Pedigree(normalizeSnapshot(zoo()));
    const r = (x, y) => ped.relation('g' + x, 'g' + y);
    assert.equal(r('k1', 'a').code, 'parent');
    assert.equal(relationWord(r('k1', 'a'), M), 'father');
    assert.equal(relationWord(r('a', 'k2'), F), 'daughter');
    assert.equal(relationWord(r('k1', 'k2'), F), 'sister');
    assert.equal(relationWord(r('k2', 'h1'), F), 'half-sister');
    assert.equal(relationWord(r('y', 'gp'), M), 'grandfather');
    assert.equal(relationWord(r('gp', 'y'), F), 'granddaughter');
    assert.equal(relationWord(r('x', 'y'), F), 'cousin');
    assert.equal(r('x', 'y').full, true);
    assert.equal(r('a', 'u'), null);
});

test('aunt/uncle and niece/nephew', () => {
    // n's mother is k2; k1 is k2's full brother, so k1 is n's uncle
    const ped = new Pedigree(normalizeSnapshot(zoo([an('n', F, ['k2', 'u'])])));
    const r = ped.relation('gn', 'gk1');
    assert.equal(r.code, 'auntUncle');
    assert.equal(relationWord(r, M), 'uncle');
    assert.equal(relationWord(ped.relation('gk1', 'gn'), F), 'niece');
    assert.equal(ped.kinship('gn', 'gk1'), 0.125);
    assert.equal(ped.gameInbred('gn', 'gk1'), false);
});

test('model: pairs, severities and per-animal badges', () => {
    const m = buildKinModel(zoo());
    const sev = (x, y) => m.pairs.find(p => (p.a.id == x && p.b.id == y) || (p.a.id == y && p.b.id == x))?.severity;
    assert.equal(sev('a', 'k2'), 'risk');
    assert.equal(sev('k1', 'k2'), 'risk');
    assert.equal(sev('a', 'h1'), 'covered');
    assert.equal(sev('k1', 'h1'), 'covered');
    assert.equal(sev('x', 'y'), 'kin');
    assert.equal(sev('gp', 'y'), 'kin');
    assert.equal(sev('x', 'z'), 'future');                 // juvenile counts as later, not covered
    assert.equal(sev('a', 'k1'), undefined);               // same sex
    assert.equal(sev('k2', 'u'), undefined);               // different habitat
    assert.equal(animalSeverity(m, 'k2'), 'risk');
    assert.equal(animalSeverity(m, 'h1'), 'covered');
    assert.equal(animalSeverity(m, 'y'), 'kin');
    assert.equal(animalSeverity(m, 'u'), null);
    assert.deepEqual(m.counts, { risk: 2, kin: 2, future: 1, held: 0, covered: 2, distant: 0 });
    // male first in every pair
    for (const p of m.pairs) assert.notEqual(p.a.sex, F);
    assert.equal(describeRelation(m, m.animals.get('k1'), m.animals.get('k2')), 'sister');
});

test('model: habitat summaries and lookups', () => {
    const m = buildKinModel(zoo());
    const s = habitatSummary(m, '1');
    assert.equal(s.name, 'Savannah Habitat');
    assert.deepEqual(s.counts, { risk: 2, kin: 0, future: 0, held: 0, covered: 2 });
    assert.equal(s.species[0].species, 'Lion');
    assert.equal(s.species[0].males.length, 2);
    assert.equal(habitatByName(m, 'Jungle Habitat').id, '2');
    assert.deepEqual(habitatsAtRisk(m).map(h => h.id), ['1', '2']);
});

test('explanations name the link', () => {
    const m = buildKinModel(zoo());
    const g = id => m.animals.get(id);
    assert.match(explainRelation(m, g('k1'), g('k2')), /full siblings/);
    assert.match(explainRelation(m, g('k2'), g('h1')), /half-siblings: they share A\./);
    assert.match(explainRelation(m, g('x'), g('y')), /first cousins/);
    assert.match(explainRelation(m, g('a'), g('u')), /not related/);
});

test('close-kin threshold moves cousins to distant', () => {
    const m = buildKinModel(zoo(), { closeKinship: 0.1 });
    const p = m.pairs.find(q => q.a.id == 'x' && q.b.id == 'y');
    assert.equal(p.severity, 'distant');
    assert.equal(animalSeverity(m, 'y'), 'kin');           // still kin through grandfather gp (1/8)
    assert.equal(animalPairs(m, 'x').length, 1);           // only the half-sister z
    assert.equal(animalPairs(m, 'x', { includeDistant: true }).length, 2);
});

test('mated relatives sort first', () => {
    const snap = zoo();
    snap.animals.find(a => a.id == 'k1').mates = ['k2'];
    const m = buildKinModel(snap);
    assert.equal(m.pairs[0].a.id, 'k1');
    assert.equal(m.pairs[0].mated, true);
});

test('offspring prediction matches the game formula', () => {
    const homo = { F: 'AAAAAABBBBBB', I: 'AAAAAABBBBBB' };
    const p = predictOffspring(homo, homo);
    assert.deepEqual(p.fertility, { min: 0, max: 1, mean: 0.5 });
    const q = predictOffspring({ F: 'CCCCCCDDDDDD' }, { F: 'EEEEEEFFFFFF' });
    assert.deepEqual(q.fertility, { min: 1, max: 1, mean: 1 });
    const s = predictOffspring({ S: 'AAAAAACCCCCC' }, { S: 'BBBBBBBBBBBB' });
    assert.deepEqual(s.size, { min: 0.5, max: 1, mean: 0.75 });
    assert.equal(predictOffspring(null, homo), null);
    assert.equal(predictOffspring({ F: 'short' }, homo), null);
    assert.deepEqual(ownGrades({ F: 'AAAAAABBBBBB', S: 'AAAAAACCCCCC' }), { fertility: 1, size: 0.5 });
    assert.equal(offspringScore(p), 50);
    // dotted form for multi-letter alleles
    assert.deepEqual(predictOffspring({ F: 'A1.A1.A1.A1.A1.A1.B2.B2.B2.B2.B2.B2' }, { F: 'A1.A1.A1.A1.A1.A1.B2.B2.B2.B2.B2.B2' }).fertility, { min: 0, max: 1, mean: 0.5 });
});

test('mate finder: unrelated first, game-flagged last', () => {
    const snap = zoo();
    for (const a of snap.animals) a.genes = { F: 'CCCCCCDDDDDD', I: 'CCCCCCDDDDDD' };
    snap.animals.find(a => a.id == 'u').genes = { F: 'EEEEEEFFFFFF', I: 'EEEEEEFFFFFF' };
    const m = buildKinModel(snap);
    const list = mateCandidates(m, 'k1');
    assert.deepEqual(list.map(c => c.animal.id), ['u', 'h1', 'k2']); // h1 half-sister (1/8) after... both game; k2 full
    assert.equal(list[0].tier, 'none');
    assert.equal(list[0].score, 100);
    assert.equal(list[0].sameHabitat, false);
    assert.equal(list[2].game, true);
    assert.equal(mateCandidates(m, 'nope').length, 0);
});

test('new risks: only pairs that became risky', () => {
    const before = buildKinModel(zoo());
    const snap = zoo();
    snap.animals.find(a => a.id == 'h1').contra = false;    // contraception lifted
    const after = buildKinModel(snap);
    const fresh = newRisks(before, after);
    assert.deepEqual(fresh.map(p => [p.a.id, p.b.id]).sort(), [['a', 'h1'], ['k1', 'h1']]);
    assert.equal(newRisks(after, after).length, 0);
    assert.equal(newRisks(null, after).length, 4);
    assert.equal(newRisks(before, after, { includeKin: true }).length, 2);
});

test('storage: related among a set, relatives of one', () => {
    const m = buildKinModel(zoo());
    const rel = relatedAmong(m, ['k1', 'k2', 'u', 'a']);
    assert.equal(rel.length, 3);                            // a-k1, a-k2, k1-k2
    assert.equal(rel.every(p => p.tier == 'game'), true);
    assert.equal(rel.find(p => [p.a.id, p.b.id].sort().join() == 'a,k1').breeding, false);
    const of = relativesOf(m, 'k1');
    assert.deepEqual(of.map(r => r.animal.id).sort(), ['a', 'h1', 'k2']);
});

test('helpers', () => {
    assert.equal(percent(0.25), '25%');
    assert.equal(percent(0.0625), '6.25%');
    assert.equal(percent(0.125), '12.5%');
    assert.equal(percent(0), '0%');
    assert.equal(worstSeverity(['covered', 'risk', 'kin']), 'risk');
    assert.equal(pairSeverity({ juv: true }, { contra: false }, 'game'), 'future');
    assert.equal(pairSeverity({ infertile: true }, {}, 'game'), 'covered');
});

test('malformed pedigree (cycle) does not hang', () => {
    const snap = { animals: [an('c1', M, ['c2']), an('c2', F, ['c1'])], anc: {}, habitats: [] };
    const m = buildKinModel(snap);
    assert.ok(m.pairs.length <= 1);
});

test('large zoo builds quickly', () => {
    const animals = [];
    for (let i = 0; i < 800; i++) {
        const par = i < 40 ? ['', ''] : [String(i - 40 + (i % 3)), String(i - 20)];
        animals.push(an(String(i), i % 2 ? F : M, par, { hab: String(i % 3), species: 'S', loc: 'H' + (i % 3) }));
    }
    const t = Date.now();
    const m = buildKinModel({ animals, anc: {}, habitats: [] });
    console.log('800 animals, 3 habitats:', Date.now() - t, 'ms'); assert.ok(Date.now() - t < 4000, `took ${Date.now() - t} ms`);
    assert.ok(m.pairs.length > 0);
});

test('clusters keep relatives together', () => {
    const m = buildKinModel(zoo());
    const c = kinClusters(m);
    assert.equal(c.get('a'), c.get('k2'));
    assert.equal(c.get('k1'), c.get('h1'));
    assert.equal(c.get('a'), c.get('k1'));                  // joined through k2 / h1
    assert.notEqual(c.get('x'), c.get('a'));
    assert.equal(c.has('u'), false);
});

test('locate only for animals out in a habitat', () => {
    assert.equal(canLocate({ id: '12', hab: '9' }), true);
    assert.equal(canLocate({ id: '12', hab: '' }), false);         // trade centre, transit
    assert.equal(canLocate({ id: 'x7', hab: 'xe:3', exhibit: true }), false);
    assert.equal(canLocate(null), false);
});

test('new risks: a pair that moves habitat together is not new', () => {
    const before = buildKinModel(zoo());
    const snap = zoo();
    for (const a of snap.animals) if (a.hab === '1') a.hab = '3';
    const after = buildKinModel(snap);
    assert.equal(newRisks(before, after).length, 0);
});

test('shoals and colonies are left out: no pairs, no habitat counts', () => {
    const fish = (id, sex, par) => an(id, sex, par, { species: 'Clownfish', hab: '4', loc: 'Reef' });
    const snap = zoo([fish('f1', M, ['', '']), fish('f2', F, ['f1', '']), fish('f3', M, ['f1', ''])]);
    snap.habitats.push({ id: '4', name: 'Reef' });
    snap.speciesFacts = { Clownfish: { collective: true } };
    const model = buildKinModel(snap);
    assert.equal(model.pairs.filter(p => p.species === 'Clownfish').length, 0);
    assert.equal(animalSeverity(model, 'f2'), null);
    assert.equal(habitatSummary(model, '4'), null);
    assert.equal(model.habitats.get('4').name, 'Reef');
    snap.speciesFacts = {};
    assert.ok(buildKinModel(snap).pairs.some(p => p.species === 'Clownfish'), 'counted when the species is not collective');
});
