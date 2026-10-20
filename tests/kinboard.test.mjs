// node --test tests/kinboard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinModel, normalizeStored, Sex } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';
import {
    TRADE, boardColumns, storedCards, breedingPairs, canMove, normalizeAssignments, assignedHabitatsOf, habitatAllowedFor, moveText,
    habitatPrints, resolveAssignments, rekeyAssignments, assignmentsFromSection, fullHabitatList, planImpact, planProblems, prunePlan, setMove, simulatePlan, speciesList, suggestPlan,
    isPinned,
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

test('species list: muted species are flagged and listed last', () => {
    const list = speciesList(buildKinModel(zoo()), { muted: new Set(['Lion']) });
    assert.deepEqual(list.map(s => [s.species, s.muted]), [['Tiger', false], ['Lion', true]]);
    assert.equal(list[1].counts.risk, 2, 'counts stay (badges are not muted)');
    assert.equal(speciesList(buildKinModel(zoo()))[0].muted, false);
});

test('speed: a simulated plan reuses the pedigree and gives the same model as a fresh build', () => {
    const m = buildKinModel(zoo());
    const plan = [{ id: 'k2', to: '3' }, { id: 'h1', to: TRADE }];
    const after = simulatePlan(m, plan, null);
    assert.equal(after.ped.reused, true, 'parentage unchanged: caches carried over');
    const fresh = buildKinModel(Object.assign({}, after.snapshot), m.opts);
    assert.equal(fresh.ped.reused, false);
    const facts = x => x.pairs.map(p => [p.key, p.hab, p.severity, p.tier, p.kinship, JSON.stringify(p.rel), p.mated]);
    assert.deepEqual(facts(after), facts(fresh));
    assert.deepEqual(after.counts, fresh.counts);
    // boardColumns with the simulation handed in = building it itself
    const strip = cols => cols.map(c => [c.id, c.kind, c.animals.map(x => [x.a.id, x.severity, x.planned]), c.leaving.map(x => x.a.id), c.risk]);
    assert.deepEqual(strip(boardColumns(m, 'Lion', plan, null, { after })), strip(boardColumns(m, 'Lion', plan, null)));
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

test('saved assignments: no miss is counted when the scan has no full habitat list', () => {
    // an empty habitat is only in snapshot.habs; without that list it looks gone
    const noHabs = buildKinModel({ habitats: [{ id: '1', name: 'Savannah' }], animals: [] });
    const withHabs = buildKinModel({ habitats: [{ id: '1', name: 'Savannah' }], habs: [{ id: '1', name: 'Savannah' }, { id: '2', name: 'Empty Pen' }], animals: [] });
    assert.equal(fullHabitatList(noHabs), false);
    assert.equal(fullHabitatList(withHabs), true);
    assert.equal(fullHabitatList(null), false);
    const saved = { '9': { species: ['Lion'], name: 'Empty Pen' }, '8': { species: ['Lion'], name: 'Savannah' } };
    let s = saved;
    for (const t of ['L.1', 'L.2', 'L.3', 'L.4']) s = rekeyAssignments(s, habitatPrints(noHabs), t, { countMisses: fullHabitatList(noHabs) });
    const empty = Object.values(s).find(e => e.name === 'Empty Pen');
    assert.ok(empty, 'kept: four loads without a habitat list never drop it');
    assert.equal(empty.miss, undefined);
    assert.ok(s['1'] && s['1'].name === 'Savannah', 'the habitat it can see is still re-keyed');
    // with the full list it is found again
    const back = rekeyAssignments(s, habitatPrints(withHabs), 'L.5', { countMisses: true });
    assert.deepEqual(Object.keys(back).sort(), ['1', '2']);
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

// Stored adults (Franchise) in the pinned trade column: s1 is the in-park
// trade-centre lion 'tc' (same guid: the park scan already has it), s2 a full
// sister of k1 (daughter of a), s3 a half-brother of k2 and h1, s4 unrelated,
// s5 a too-old sister. Lion 'tc2' shares the id of nothing in the park.
function storedLions() {
    return normalizeStored({
        species: 'Lion',
        animals: [
            { id: 'sgtc', guid: 'gtc', name: 'Tc again', species: 'Lion', sex: M, maturity: 2, par: [] },
            { id: 'sgS2', guid: 'gS2', name: 'Sis', species: 'Lion', sex: F, maturity: 2, par: ['ga', 'gb'] },
            { id: 'sgS3', guid: 'gS3', name: 'Half', species: 'Lion', sex: M, maturity: 1, par: ['ga', 'gx'] },
            { id: 'sgS4', guid: 'gS4', name: 'Stranger', species: 'Lion', sex: F, maturity: 2, par: [] },
            { id: 'sgS5', guid: 'gS5', name: 'Old sis', species: 'Lion', sex: F, maturity: 6, par: ['ga', 'gb'] },
            { id: 'sgT1', guid: 'gT1', name: 'Tigress', species: 'Tiger', sex: F, maturity: 2, par: [] },
        ],
        anc: {},
    });
}

test('board columns: stored adults in the trade column skip park animals, counts and risk unchanged', () => {
    const m = buildKinModel(zoo());
    const plan = [{ id: 'k2', to: '3' }];
    const plain = boardColumns(m, 'Lion', plan, DEST);
    const stored = storedLions();
    const cols = boardColumns(m, 'Lion', plan, DEST, { stored });
    assert.deepEqual(cols.map(c => c.id), plain.map(c => c.id), 'same columns, same order');
    for (let i = 0; i < cols.length; i++) {
        assert.deepEqual(cols[i].counts, plain[i].counts, `${cols[i].id} counts`);
        assert.deepEqual(cols[i].risk, plain[i].risk, `${cols[i].id} risk`);
        assert.deepEqual(cols[i].animals.map(x => x.a.id), plain[i].animals.map(x => x.a.id), `${cols[i].id} animals`);
    }
    const trade = cols.find(c => c.kind === 'trade');
    assert.deepEqual(trade.animals.map(x => x.a.id), ['tc'], 'the in-park trade animal stays a normal card');
    const ids = trade.stored.map(x => x.a.id);
    assert.equal(ids.length, 4);
    assert.ok(!ids.includes('sgtc'), 'the stored record of the in-park animal is skipped');
    assert.ok(!ids.includes('sgT1'), 'other species are left out');
    assert.equal(m.animals.size, zoo().animals.length, 'model.animals untouched');
    for (const c of cols) if (c.kind !== 'trade') assert.equal(c.stored, undefined);
    // kin badges from the merged pedigree
    const by = new Map(trade.stored.map(x => [x.a.id, x]));
    assert.equal(by.get('sgS2').severity, 'risk');
    assert.deepEqual(by.get('sgS2').pairs.map(p => p.other.id).sort(), ['a', 'k1']);
    assert.ok(by.get('sgS3').pairs.some(p => p.other.id === 'k2'));
    assert.ok(by.get('sgS3').pairs.every(p => p.other.sex === F), 'only partners of a compatible sex');
    assert.equal(by.get('sgS4').severity, null);
    assert.equal(by.get('sgS5').severity, 'covered', 'too old: covered');
    assert.equal(ids[ids.length - 1], 'sgS4', 'worst first, unrelated last');
    assert.equal(storedCards(m, 'Lion', stored), storedCards(m, 'Lion', stored), 'cached per model and answer');
    // no answer, an error, an empty list: an empty list, nothing else changes
    for (const s of [null, normalizeStored({ species: 'Lion', error: 'notfranchise' }), normalizeStored({ species: 'Lion', animals: [] })]) {
        const c2 = boardColumns(m, 'Lion', plan, DEST, { stored: s });
        assert.deepEqual(c2.find(c => c.kind === 'trade').stored, []);
    }
    // an id the park already has is skipped too
    const sameId = normalizeStored({ species: 'Lion', animals: [{ id: 'tc', guid: 'gNEW', name: 'Same id', species: 'Lion', sex: M, maturity: 2 }] });
    assert.deepEqual(storedCards(m, 'Lion', sameId), []);
});

// ------------------------------------------------ pregnant animals stay

test('suggest fixes never moves a pregnant animal', () => {
    // the siblings again: f1 pregnant. Without her pregnancy a sister may move;
    // with it the fixes move others, never her.
    const snap = siblings();
    snap.animals = snap.animals.map(a => (a.id === 'f1' ? Object.assign({}, a, { preg: true }) : a));
    const m = buildKinModel(snap);
    assert.equal(isPinned(m.animals.get('f1')), true);
    assert.equal(isPinned(m.animals.get('f2')), false);
    const plan = suggestPlan(m, 'Lion', DEST4);
    assert.ok(plan.length > 0);
    assert.ok(!plan.some(mv => mv.id === 'f1'), JSON.stringify(plan));
    // both sisters pregnant: neither moves
    snap.animals = snap.animals.map(a => (a.id === 'f2' ? Object.assign({}, a, { preg: true }) : a));
    const m2 = buildKinModel(snap);
    assert.ok(!suggestPlan(m2, 'Lion', DEST4).some(mv => mv.id === 'f1' || mv.id === 'f2'));
});

test('a pregnant animal in a plan: by hand a warning, from a plan a problem', () => {
    const z = zoo();
    z.animals = z.animals.map(a => (a.id === 'k2' ? Object.assign({}, a, { preg: true }) : a));
    const m = buildKinModel(z);
    // planned by hand (drag, Move N here): kept with byPlayer, a warning only
    const hand = setMove(m, [], 'k2', '3', { byPlayer: true });
    assert.deepEqual(hand, [{ id: 'k2', to: '3', byPlayer: true }]);
    const pw = planProblems(m, hand, DEST).filter(p => p.id === 'k2');
    assert.equal(pw.length, 1);
    assert.equal(pw[0].warn, true);
    assert.match(pw[0].text, /pregnant: the game lets you move her/);
    // from a generated plan: a problem that says the run skips it
    const gen = setMove(m, [], 'k2', '3');
    assert.deepEqual(gen, [{ id: 'k2', to: '3' }]);
    const pp = planProblems(m, gen, DEST).filter(p => p.id === 'k2');
    assert.equal(pp.length, 1);
    assert.ok(!pp[0].warn);
    assert.match(pp[0].text, /Run skips this move/);
    // prunePlan keeps it (the run says why it skips it)
    assert.equal(prunePlan(m, gen).length, 1);
});
