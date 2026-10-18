// node --test tests/kinboard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinModel, Sex } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';
import {
    TRADE, boardColumns, breedingPairs, canMove, normalizeAssignments, assignedHabitatsOf, habitatAllowedFor, moveText,
    habitatPrints, resolveAssignments, rekeyAssignments, assignmentsFromSection, planImpact, planProblems, prunePlan, setMove, simulatePlan, speciesList, suggestPlan,
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

test('species list: no shoals or colonies', () => {
    const snap = zoo();
    snap.speciesFacts = { Tiger: { collective: true } };
    assert.deepEqual(speciesList(buildKinModel(snap)).map(s => s.species), ['Lion']);
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
    assert.match(plan[0].reason, /first breeding pair \(an unrelated fertile male\)/);
});

test('assignments: suggestions only into the species own habitats, never into others', () => {
    const m = buildKinModel(zoo());
    // Grassland (4) is assigned to lions: the only place a lion is suggested into
    let plan = suggestPlan(m, 'Lion', DEST, { assignments: { '4': ['Lion'] } });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].to, '4');
    // Plains (3) and Grassland (4) belong to zebras: nowhere left for the lion
    plan = suggestPlan(m, 'Lion', DEST, { assignments: { '3': ['Zebra'], '4': ['Zebra'] } });
    assert.deepEqual(plan, []);
    // Plains (3) for zebras only: the lion goes to the free Grassland
    plan = suggestPlan(m, 'Lion', DEST, { assignments: { '3': ['Zebra'] } });
    assert.equal(plan[0].to, '4');
    assert.deepEqual(assignedHabitatsOf({ '4': ['Lion'], '3': ['Zebra', 'Lion'] }, 'Lion').sort(), ['3', '4']);
    assert.equal(habitatAllowedFor({ '3': ['Zebra'] }, '3', 'Lion'), false);
    assert.equal(habitatAllowedFor({ '3': ['Zebra'] }, '1', 'Lion'), true);
    assert.equal(normalizeAssignments(new Map([['1', new Set(['Lion'])]])).get('1').has('Lion'), true);
});

test('assignments on the board: own, reserved, intruders, plan warnings', () => {
    const m = buildKinModel(zoo());
    const assignments = { '1': ['Lion'], '3': ['Zebra'], '9': ['Lion'] };
    const cols = boardColumns(m, 'Lion', [], DEST, { assignments });
    const byId = new Map(cols.map(c => [c.id, c]));
    assert.equal(byId.get('1').mine, true);
    assert.equal(byId.get('3').reservedOther, true);
    assert.deepEqual(byId.get('3').intruders, [{ species: 'Lion', count: 2 }]);   // lions in a zebra habitat
    assert.ok(byId.has('9'));                                                     // assigned: shown even when empty
    assert.equal(cols[0].mine, true);                                             // own habitats first
    const probs = planProblems(m, [{ id: 'k2', to: '3' }], DEST, { assignments });
    assert.ok(probs.some(p => p.warn && /assigned to Zebra/.test(p.text)));
});

// Four full siblings in one habitat, one unrelated female and one unrelated
// male in two others, and an empty habitat. The old suggestions parked all
// the males in one habitat and the females in another; now every move must
// make or keep breeding pairs.
function siblings() {
    const g = { F: 'CCCCCCDDDDDD', I: 'CCCCCCDDDDDD' };
    return {
        v: 1, seq: 1, scope: 'park', mode: 'offline',
        habitats: [{ id: '1', name: 'Home' }, { id: '3', name: 'East' }, { id: '4', name: 'West' }],
        animals: [
            an('m1', M, ['p', 'q'], { genes: g }), an('m2', M, ['p', 'q'], { genes: g }),
            an('f1', F, ['p', 'q'], { genes: g }), an('f2', F, ['p', 'q'], { genes: g }),
            an('u', F, ['', ''], { hab: '3', loc: 'East' }),
            an('v', M, ['', ''], { hab: '4', loc: 'West' }),
        ],
        anc: {},
    };
}
const DEST4 = { bySpecies: { Lion: { '1': { ok: true }, '3': { ok: true }, '4': { ok: true }, '5': { ok: true } } }, habitats: [{ id: '5', name: 'Empty' }] };

test('suggestions keep habitats mixed and breeding', () => {
    const m = buildKinModel(siblings());
    const plan = suggestPlan(m, 'Lion', DEST4);
    const after = simulatePlan(m, plan, DEST4);
    assert.equal(after.pairs.filter(p => p.severity === 'risk').length, 0);
    for (const hab of ['1', '3', '4', '5']) {
        const b = breedingPairs(after, hab, 'Lion');
        // no habitat with two or more adults of one sex and none of the other
        assert.ok(!(b.males + b.females >= 2 && (b.males === 0 || b.females === 0)), `habitat ${hab}: ${b.males} males, ${b.females} females`);
    }
    // the moved animals found partners
    assert.ok(breedingPairs(after, '3', 'Lion').pairs >= 1);
    assert.ok(breedingPairs(after, '4', 'Lion').pairs >= 1);
    assert.ok(plan.every(mv => /breeding pair/.test(mv.reason)), JSON.stringify(plan));
});

test('suggestions never break the only breeding pair', () => {
    // x and y breed (unrelated); z is x's sister: move z, not x
    const m = buildKinModel({
        v: 1, seq: 1, scope: 'park', mode: 'offline', habitats: [{ id: '1', name: 'Home' }],
        animals: [an('x', M, ['p', 'q']), an('y', F, ['', '']), an('z', F, ['p', 'q'])],
        anc: {},
    });
    const plan = suggestPlan(m, 'Lion', DEST4);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].id, 'z');
    assert.equal(breedingPairs(simulatePlan(m, plan, DEST4), '1', 'Lion').pairs, 1);
});

test('breeding pairs count only fertile, unrelated adults', () => {
    const m = buildKinModel(zoo());
    // Savannah: a (father) with k2 (daughter), k1 with k2 (siblings), h1 on contraception
    assert.equal(breedingPairs(m, '1', 'Lion').pairs, 0);
    // Plains: u (female) and m (male), unrelated
    assert.equal(breedingPairs(m, '3', 'Lion').pairs, 1);
});

// ----------------------------------------- saved assignments across a reload
// Habitat entity ids are handed out afresh when a zoo loads. Saved
// assignments must follow their habitat (name, residents, the game's habitat
// id), never a stale entity id: that made ghost columns on the Species board.

const P = (id, name, guids = [], hid = null) => ({ id, name, names: new Set([name.toLowerCase()]), hid, guids });

test('saved assignments: the habitats got new entity ids, assignments follow them', () => {
    const saved = {
        '101': { species: ['Lion'], name: 'Savannah', guids: ['g1', 'g2'], hid: '7', seen: 'old.1' },
        '102': { species: ['Zebra'], name: 'Plains', guids: [], hid: '8', seen: 'old.1' },
    };
    // after the reload: Savannah is 512, Plains 513, and 101 is now another habitat
    const now = [P('512', 'Savannah', ['g1', 'g2'], '7'), P('513', 'Plains', [], '8'), P('101', 'Pond', [], '9')];
    const got = assignmentsFromSection(saved, now, 'new.1');
    assert.deepEqual(Array.from(got.keys()).sort(), ['512', '513']);
    assert.ok(!got.has('101') && !got.has('102'), 'no stale id, no ghost');
    assert.deepEqual(Array.from(got.get('512')), ['Lion']);
});

test('saved assignments: a stale id alone is never enough', () => {
    const saved = { '101': { species: ['Lion'], name: 'Old Name' } };
    const got = assignmentsFromSection(saved, [P('101', 'Something Else')], 'new.1');
    assert.equal(got.size, 0);
});

test('saved assignments: found by residents after a rename, by name when empty', () => {
    const saved = {
        '1': { species: ['Lion'], name: 'Lion Den', guids: ['g1', 'g2', 'g3'] },
        '2': { species: ['Zebra'], name: 'Zebra Field', guids: [] },
    };
    const now = [P('40', 'Big Cats', ['g2', 'g3']), P('41', 'Zebra Field'), P('42', 'Lion Pen', ['g9'])];
    const res = resolveAssignments(saved, now, 'new.1');
    assert.equal(res.byHab.get('40'), '1');
    assert.equal(res.byHab.get('41'), '2');
    assert.deepEqual(res.orphans, []);
});

test('saved assignments: two habitats with the same name are told apart by the game habitat id', () => {
    const saved = {
        '1': { species: ['Lion'], name: 'Habitat', hid: '20' },
        '2': { species: ['Zebra'], name: 'Habitat', hid: '21' },
    };
    const now = [P('90', 'Habitat', [], '21'), P('91', 'Habitat', [], '20')];
    const got = assignmentsFromSection(saved, now, 'new.1');
    assert.deepEqual(Array.from(got.get('91')), ['Lion']);
    assert.deepEqual(Array.from(got.get('90')), ['Zebra']);
});

test('saved assignments: an id the player clicked in this load wins over names', () => {
    const saved = { '5': { species: ['Lion'], name: 'Pen', seen: 'this.1' } };
    const now = [P('5', 'Pen B'), P('6', 'Pen')];
    assert.deepEqual(Array.from(assignmentsFromSection(saved, now, 'this.1').keys()), ['5']);
    // in a later load the same id means nothing
    assert.deepEqual(Array.from(assignmentsFromSection(saved, now, 'next.1').keys()), ['6']);
});

test("saved assignments: re-keyed to today's ids; a habitat not found is kept a few loads, then dropped", () => {
    const saved = {
        '101': { species: ['Lion'], name: 'Savannah', guids: ['g1'] },
        '102': { species: ['Zebra'], name: 'Gone' },
    };
    const now = [P('512', 'Savannah', ['g1', 'g4'], '7'), P('102', 'Pond')];
    let s = rekeyAssignments(saved, now, 'L.1');
    assert.deepEqual(s['512'], { species: ['Lion'], name: 'Savannah', hid: '7', guids: ['g1', 'g4'] });
    const orphanKey = Object.keys(s).find(k => s[k].name === 'Gone');
    assert.notEqual(orphanKey, '102', 'the orphan does not take an id that is a real habitat now');
    assert.equal(s[orphanKey].miss, 1);
    assert.deepEqual(rekeyAssignments(s, now, 'L.1'), s, 'the same load: nothing changes (no save loop)');
    s = rekeyAssignments(s, now, 'L.2');
    assert.equal(Object.values(s).find(e => e.name === 'Gone').miss, 2);
    s = rekeyAssignments(s, now, 'L.3');
    assert.deepEqual(Object.keys(s), ['512'], 'dropped after three loads without its habitat');
    // no habitat list (not scanned yet): nothing is touched
    assert.deepEqual(rekeyAssignments(saved, [], 'L.4'), saved);
});

test('habitat prints: every habitat from the scan, empty ones too, with residents', () => {
    const m = buildKinModel({
        habitats: [{ id: '1', name: 'Savannah Habitat' }],
        habs: [{ id: '1', name: 'Savannah', hid: '70' }, { id: '2', name: 'Empty Pen', hid: '71' }],
        animals: [an('a', M, ['', '']), an('b', F, ['', ''])],
    });
    const prints = habitatPrints(m);
    assert.deepEqual(prints.map(p => [p.id, p.name, p.hid, p.guids]), [['1', 'Savannah', '70', ['ga', 'gb']], ['2', 'Empty Pen', '71', []]]);
    assert.ok(prints[0].names.has('savannah habitat'), "both of the game's names for it");
});
