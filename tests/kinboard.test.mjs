// node --test tests/kinboard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinModel, Sex } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';
import {
    TRADE, boardColumns, canMove, moveText, planImpact, planProblems, prunePlan, setMove, simulatePlan, speciesList, suggestPlan,
} from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kinboardcore.js';

const M = Sex.Male, F = Sex.Female;
const an = (id, sex, par, over = {}) => Object.assign({
    id, key: `animal_${id}`, guid: 'g' + id, name: id.toUpperCase(), species: 'Lion', sex, juv: false, contra: false,
    infertile: false, hab: '1', loc: 'Savannah Habitat', lt: 'habitat', par: par.map(p => p ? 'g' + p : ''), mates: [],
    genes: { F: 'AAAAAABBBBBB', I: 'CCCCCCDDDDDD' },
}, over);
// Savannah (1): a father of k1, k2; k1 x k2 siblings; h1 half-sister on contraception
// Plains (3): u, an unrelated female; m, an unrelated male
// Jungle (2): tigers. Grassland (4): empty, suitable for lions.
function zoo() {
    return {
        v: 1, seq: 1, scope: 'park', mode: 'offline', tradeCentre: { id: 77, name: 'Trade Centre' },
        habitats: [{ id: '1', name: 'Savannah Habitat' }, { id: '2', name: 'Jungle Habitat' }, { id: '3', name: 'Plains Habitat' }],
        animals: [
            an('a', M, ['', '']),
            an('k1', M, ['a', 'b']),
            an('k2', F, ['a', 'b']),
            an('h1', F, ['a', 'e'], { contra: true }),
            an('u', F, ['', ''], { hab: '3', loc: 'Plains Habitat' }),
            an('m', M, ['', ''], { hab: '3', loc: 'Plains Habitat', genes: { F: 'EEEEEEFFFFFF', I: 'EEEEEEFFFFFF' } }),
            an('t', F, ['', ''], { species: 'Tiger', hab: '2', loc: 'Jungle Habitat' }),
            an('away', F, ['a', 'b'], { hab: '', loc: '', lt: 'transit' }),
            an('tc', M, ['', ''], { hab: '', loc: 'Trade Centre', lt: 'trade' }),
        ],
        anc: {},
    };
}
const DEST = {
    bySpecies: { Lion: { '1': { ok: true }, '3': { ok: true }, '4': { ok: true }, '2': { ok: false, reason: 'Too cold' } } },
    habitats: [{ id: '4', name: 'Grassland Habitat' }],
    tradeCentre: { id: '77', name: 'Trade Centre' },
};

test('species list: problems first, with counts', () => {
    const list = speciesList(buildKinModel(zoo()));
    assert.equal(list[0].species, 'Lion');
    assert.equal(list[0].counts.risk, 2);
    assert.equal(list[0].animals, 8);
    assert.deepEqual(list[0].habitats.sort(), ['1', '3']);
    assert.equal(list[0].away, 2);
    assert.equal(list[1].species, 'Tiger');
});

test('simulation and impact: moving the sister fixes both risks', () => {
    const m = buildKinModel(zoo());
    const plan = [{ id: 'k2', to: '3' }];
    const after = simulatePlan(m, plan, DEST);
    const impact = planImpact(m, after, 'Lion');
    assert.equal(impact.risksFixed, 2);
    assert.equal(impact.risksCreated, 0);
    assert.equal(impact.after.risk, 0);
    assert.equal(after.animals.get('k2').hab, '3');
    assert.equal(after.animals.get('k2').loc, 'Plains Habitat');
    assert.equal(m.animals.get('k2').hab, '1');                    // the real model is untouched
});

test('impact: a pair moved together stays a risk (moved, not new)', () => {
    const m = buildKinModel(zoo());
    const after = simulatePlan(m, [{ id: 'k2', to: '3' }, { id: 'a', to: '3' }], DEST);
    const impact = planImpact(m, after, 'Lion');
    assert.equal(impact.risksFixed, 1);                            // k1 x k2
    assert.equal(impact.risksCreated, 0);
    assert.equal(impact.after.risk, 1);                            // a x k2, now in Plains
    assert.equal(impact.changed[0].hab, '3');
});

test('impact: moving the father in with an unrelated habitat is clean, with his son a new risk', () => {
    const m = buildKinModel(zoo());
    const after = simulatePlan(m, [{ id: 'k2', to: '4' }, { id: 'h1', to: '4' }], DEST);
    const impact = planImpact(m, after, 'Lion');
    assert.equal(impact.risksCreated, 0);                          // two sisters: same sex
    const after2 = simulatePlan(m, [{ id: 'k2', to: '4' }, { id: 'k1', to: '4' }], DEST);
    assert.equal(planImpact(m, after2, 'Lion').after.risk, 1);     // the siblings together again
});

test('board columns after a plan', () => {
    const m = buildKinModel(zoo());
    const cols = boardColumns(m, 'Lion', [{ id: 'k2', to: '3' }], DEST);
    const byId = new Map(cols.map(c => [c.id, c]));
    assert.deepEqual(byId.get('1').leaving.map(x => x.a.id), ['k2']);
    assert.equal(byId.get('1').leaving[0].toName, 'Plains Habitat');
    const plains = byId.get('3');
    assert.ok(plains.animals.some(x => x.a.id === 'k2' && x.planned === 'in'));
    assert.equal(plains.counts.females, 2);
    assert.equal(byId.get('4').animals.length, 0);                 // suitable, still empty
    assert.equal(byId.get('4').name, 'Grassland Habitat');
    assert.equal(byId.has('2'), false);                            // unsuitable and empty: not offered
    assert.equal(byId.get(TRADE).kind, 'trade');
    assert.deepEqual(byId.get(TRADE).animals.map(x => x.a.id), ['tc']);
    assert.deepEqual(byId.get('away').animals.map(x => x.a.id), ['away']);
    assert.ok(cols.slice(0, 2).every(c => c.animals.length > 0));  // occupied habitats first
    assert.equal(byId.get('1').risk.risk, 0);
});

test('plan editing: move, move back, prune', () => {
    const m = buildKinModel(zoo());
    let plan = setMove(m, [], 'k2', '3');
    plan = setMove(m, plan, 'k1', '4');
    assert.equal(plan.length, 2);
    plan = setMove(m, plan, 'k2', '1');                            // back home
    assert.deepEqual(plan, [{ id: 'k1', to: '4' }]);
    const snap = zoo();
    snap.animals.find(a => a.id === 'k1').moving = true;
    assert.equal(prunePlan(buildKinModel(snap), plan).length, 0);
    assert.equal(canMove(m.animals.get('away')), false);
    assert.equal(canMove(m.animals.get('tc')), true);
    assert.equal(moveText(m, { id: 'k1', to: '4' }, DEST), 'K1 ♂: Savannah Habitat → Grassland Habitat');
});

test('plan problems: unsuitable habitat, no trade centre', () => {
    const m = buildKinModel(zoo());
    const p = planProblems(m, [{ id: 'k2', to: '2' }, { id: 'away', to: '3' }], DEST);
    assert.equal(p.length, 2);
    assert.match(p[0].text, /Too cold/);
    assert.match(p[1].text, /cannot be moved/);
    // the trade centre is resolved when the move is made, so it is never a plan problem
    assert.equal(planProblems(m, [{ id: 'k2', to: TRADE }], Object.assign({}, DEST, { tradeCentre: null })).length, 0);
    const cols = boardColumns(m, 'Lion', [], Object.assign({}, DEST, { tradeCentre: null }));
    assert.ok(cols.some(c => c.id === TRADE && c.name === 'Trade Centre'));   // name from the kin snapshot
});

test('suggestions: the fewest moves that clear the risks', () => {
    const m = buildKinModel(zoo());
    const plan = suggestPlan(m, 'Lion', DEST);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].id, 'k2');                                // in both risk pairs
    assert.ok(['3', '4'].includes(plan[0].to));
    const after = simulatePlan(m, plan, DEST);
    assert.equal(after.pairs.filter(p => p.species === 'Lion' && p.severity === 'risk').length, 0);
    assert.match(plan[0].reason, /2 related pairs fewer/);
    assert.deepEqual(suggestPlan(m, 'Tiger', DEST), []);           // nothing to fix
    assert.deepEqual(suggestPlan(m, 'Lion', { bySpecies: {} }), []); // nowhere to go
});

test('suggestions prefer a habitat with an unrelated partner', () => {
    const snap = zoo();
    snap.animals.find(a => a.id === 'm').hab = '4';                // the unrelated male now in Grassland
    snap.animals.find(a => a.id === 'm').loc = 'Grassland Habitat';
    snap.habitats.push({ id: '4', name: 'Grassland Habitat' });
    const m = buildKinModel(snap);
    const plan = suggestPlan(m, 'Lion', DEST);
    assert.equal(plan[0].to, '4');
    assert.match(plan[0].reason, /unrelated male/);
});
