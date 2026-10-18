// node --test tests/kinbonds.test.mjs
// Pair bonds: a related pair the game keeps apart by monogamy ("IconLock")
// is 'held' (Bonded elsewhere), not a risk. docs/PLAN-pair-bonds.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKinModel, holdReason, newRisks, severityRank, Sex } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kincore.js';
import { planImpact, simulatePlan, speciesList, suggestPlan, boardColumns } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/kinboardcore.js';
import { applyZooFilters, DEFAULT_ZOO_FILTERS, Gender, Maturity } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/scores.js';

const M = Sex.Male, F = Sex.Female;
const bird = (id, sex, par, over = {}) => Object.assign({
    id, key: `animal_${id}`, guid: 'g' + id, name: id.charAt(0).toUpperCase() + id.slice(1), species: 'Flamingo', sex,
    juv: false, contra: false, infertile: false, preg: false, hab: '5', loc: 'Lagoon', lt: 'habitat',
    par: par.map(p => (p ? 'g' + p : '')), mates: [],
}, over);

// Lagoon (habitat 5), flamingos:
//   mum, her son leo (bonded to pip, unrelated), pip
//   granny and her grandson tom (bonded to ada, unrelated); tom's parent mid is not in the zoo
// The bond pass's answer: every bonded bird is locked against the other adults of the other sex.
function lagoon({ bonds = true, ok = true, over = {} } = {}) {
    const b = (id, mate, lock) => (bonds ? { bond: { mate, ring: true, lock } } : {});
    const animals = [
        bird('mum', F, ['', '']),
        bird('leo', M, ['dad', 'mum'], Object.assign({ mates: ['pip'] }, b('leo', 'pip', ['mum', 'granny', 'ada']))),
        bird('pip', F, ['', ''], Object.assign({ mates: ['leo'] }, b('pip', 'leo', ['tom']))),
        bird('granny', F, ['', '']),
        bird('tom', M, ['mid', ''], Object.assign({ mates: ['ada'] }, b('tom', 'ada', ['mum', 'granny', 'pip']))),
        bird('ada', F, ['', ''], Object.assign({ mates: ['tom'] }, b('ada', 'tom', ['leo']))),
    ].map(a => Object.assign(a, over[a.id] || {}));
    const snap = {
        v: 1, seq: 1, scope: 'park',
        habitats: [{ id: '5', name: 'Lagoon' }, { id: '6', name: 'Pond' }],
        animals,
        anc: { gmid: ['', 'ggranny'], gdad: [] },
    };
    if (ok !== null) snap.bondsOk = ok;
    return snap;
}

const pairOf = (m, x, y) => m.pairs.find(p => (p.a.id === x && p.b.id === y) || (p.a.id === y && p.b.id === x));
const sev = (m, x, y) => (pairOf(m, x, y) || {}).severity;
// everything a consumer reads, in order
const signature = m => ({
    pairs: m.pairs.map(p => `${p.key}:${p.severity}:${p.hab}`),
    counts: m.counts,
    habitats: Array.from(m.habitatSummaries.values()).map(h => [h.id, h.counts]),
});

test('held: a bonded son and his mother, a bonded grandson and his grandmother', () => {
    const m = buildKinModel(lagoon());
    assert.equal(sev(m, 'leo', 'mum'), 'held');
    assert.equal(pairOf(m, 'leo', 'mum').unheld, 'risk');
    assert.equal(sev(m, 'tom', 'granny'), 'held');
    assert.equal(pairOf(m, 'tom', 'granny').unheld, 'kin');
    assert.equal(m.counts.held, 2);
    assert.equal(m.counts.risk, 0);
    assert.equal(m.habitatSummaries.get('5').counts.held, 2);
    const why = holdReason(pairOf(m, 'leo', 'mum'));
    assert.match(why, /Leo is bonded to Pip/);
    assert.match(why, /won't pair Leo with Mum/);
    // the held pair that turns into a risk sorts before the one that turns into close kin
    assert.deepEqual(m.pairs.filter(p => p.severity === 'held').map(p => p.unheld), ['risk', 'kin']);
});

test('held sits between future and covered', () => {
    assert.ok(severityRank('future') > severityRank('held'));
    assert.ok(severityRank('held') > severityRank('covered'));
    assert.ok(severityRank('kin') > severityRank('future'));
});

test('golden: no bond data, the switch off, or a failed bond pass give exactly today\'s model', () => {
    const today = signature(buildKinModel(lagoon({ bonds: false, ok: null })));
    assert.equal(today.counts.held, 0);
    assert.equal(today.counts.risk, 1);
    assert.deepEqual(signature(buildKinModel(lagoon(), { bondHolds: false })), today);
    assert.deepEqual(signature(buildKinModel(lagoon({ ok: false }))), today);
    assert.deepEqual(signature(buildKinModel(lagoon({ ok: null }))), today);   // older Lua: no bondsOk
    assert.deepEqual(signature(buildKinModel(lagoon({ bonds: false }))), today);
});

test('a bond that does not hold: mate dead, moved, in the trade centre, or not in the zoo', () => {
    for (const pip of [{ alive: false }, { hab: '6', loc: 'Pond' }, { hab: '', lt: 'trade', loc: 'Trade centre' }]) {
        const m = buildKinModel(lagoon({ over: { pip } }));
        assert.equal(sev(m, 'leo', 'mum'), 'risk', JSON.stringify(pip));
    }
    const s = lagoon();
    s.animals = s.animals.filter(a => a.id !== 'pip');
    assert.equal(sev(buildKinModel(s), 'leo', 'mum'), 'risk');
});

test('a mate briefly away (vet, transport) still holds, only when the game says "same habitat"', () => {
    const away = { hab: '', lt: 'vet', loc: 'Vet surgery' };
    const here = b => ({ leo: { bond: { mate: 'pip', ring: true, here: b, lock: ['mum', 'granny', 'ada'] } }, pip: away });
    assert.equal(sev(buildKinModel(lagoon({ over: here(true) })), 'leo', 'mum'), 'held');
    assert.equal(sev(buildKinModel(lagoon({ over: here(false) })), 'leo', 'mum'), 'risk');
    // the trade centre is not "briefly away", whatever the assigned habitat
    const trade = here(true);
    trade.pip = { hab: '', lt: 'trade', loc: 'Trade centre' };
    assert.equal(sev(buildKinModel(lagoon({ over: trade })), 'leo', 'mum'), 'risk');
});

test('no lock from the game (polygynous species, failed call): still a risk', () => {
    const m = buildKinModel(lagoon({ over: { leo: { bond: { mate: 'pip', ring: true, lock: [] } } } }));
    assert.equal(sev(m, 'leo', 'mum'), 'risk');
});

test('relatives that are mates stay a risk, with the heart', () => {
    // leo is bonded to his sister sis: the game calls them mates ("ring"), never a lock
    const s = lagoon();
    s.animals.push(bird('sis', F, ['dad', 'mum'], { mates: ['leo'], bond: { mate: 'leo', ring: true, lock: [] } }));
    const leo = s.animals.find(a => a.id === 'leo');
    leo.mates = ['sis'];
    leo.bond = { mate: 'sis', ring: true, lock: ['mum', 'granny', 'ada', 'pip'] };
    const m = buildKinModel(s);
    const p = pairOf(m, 'leo', 'sis');
    assert.equal(p.severity, 'risk');
    assert.equal(p.mated, true);
    assert.equal(sev(m, 'leo', 'mum'), 'held');
});

test('covered and future come first, as before', () => {
    let m = buildKinModel(lagoon({ over: { mum: { contra: true } } }));
    assert.equal(sev(m, 'leo', 'mum'), 'covered');
    // a juvenile son has no bond data; even with one, a young pair stays 'future'
    const s = lagoon();
    s.animals.push(bird('kid', M, ['dad', 'mum'], { juv: true, infertile: true, bond: { mate: 'pip', ring: false, lock: ['mum'] } }));
    m = buildKinModel(s);
    assert.equal(sev(m, 'kid', 'mum'), 'future');
});

test('an elderly mate makes the bond fragile', () => {
    const m = buildKinModel(lagoon({ over: { pip: { ageQ: 3 } } }));
    const p = pairOf(m, 'leo', 'mum');
    assert.equal(p.held.fragile, true);
    assert.match(holdReason(p), /Pip is elderly: when the bond ends, this becomes an inbreeding risk/);
});

// ------------------------------------------------------------ the board

const dest = { bySpecies: { Flamingo: { 5: { ok: true }, 6: { ok: true } } }, habitats: [{ id: '6', name: 'Pond' }] };

test('board: moving the mate away breaks the bond and shows a new risk', () => {
    const m = buildKinModel(lagoon());
    const after = simulatePlan(m, [{ id: 'pip', to: '6' }], dest);
    assert.equal(sev(after, 'leo', 'mum'), 'risk');
    const imp = planImpact(m, after, 'Flamingo');
    assert.equal(imp.risksCreated, 1);
    assert.ok(imp.created.some(p => p.key === pairOf(m, 'leo', 'mum').key));
    // moving the bonded bird itself clears its bond too: back with mum it is a risk
    const away = simulatePlan(m, [{ id: 'leo', to: '6' }, { id: 'mum', to: '6' }], dest);
    assert.equal(sev(away, 'leo', 'mum'), 'risk');
});

test('board: a simulated model keeps the bond switch', () => {
    const off = buildKinModel(lagoon(), { bondHolds: false });
    const after = simulatePlan(off, [{ id: 'granny', to: '6' }], dest);
    assert.equal(sev(after, 'leo', 'mum'), 'risk');
    const on = simulatePlan(buildKinModel(lagoon()), [{ id: 'granny', to: '6' }], dest);
    assert.equal(sev(on, 'leo', 'mum'), 'held');
});

test('board: held pairs are listed, counted, and not "fixed" by moves', () => {
    const m = buildKinModel(lagoon());
    const list = speciesList(m);
    assert.equal(list[0].counts.held, 2);
    // only held pairs: nothing to fix
    assert.deepEqual(suggestPlan(m, 'Flamingo', dest), []);
    const cols = boardColumns(m, 'Flamingo', [], dest);
    const leo = cols.find(c => c.id === '5').animals.find(x => x.a.id === 'leo');
    assert.equal(leo.severity, 'held');
});

test('board: a fix never breaks a bond that would expose a relative', () => {
    // bro, leo's unbonded brother, is a real risk with mum
    const s = lagoon();
    s.animals.push(bird('bro', M, ['dad', 'mum']));
    const m = buildKinModel(s);
    assert.equal(sev(m, 'bro', 'mum'), 'risk');
    const plan = suggestPlan(m, 'Flamingo', dest);
    assert.ok(plan.length > 0);
    assert.ok(!plan.some(x => x.id === 'pip' || x.id === 'ada'), JSON.stringify(plan));
    const after = simulatePlan(m, plan, dest);
    assert.equal(planImpact(m, after, 'Flamingo').risksCreated, 0);
});

// ----------------------------------------------------------- alerts

test('alerts: a bond that ends is news, a failed bond pass or the switch is not', () => {
    const before = buildKinModel(lagoon());
    const ended = buildKinModel(lagoon({ over: { pip: { alive: false } } }));
    const fresh = newRisks(before, ended);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].bondEnded, true);
    assert.deepEqual(newRisks(before, buildKinModel(lagoon({ ok: false }))), []);
    assert.deepEqual(newRisks(before, buildKinModel(lagoon(), { bondHolds: false })), []);
    // the lock was not reported this scan but the bond is whole (same mate,
    // alive, with him): not news, no toast; the pair still shows as a risk
    const noLock = buildKinModel(lagoon({ over: { leo: { bond: { mate: 'pip', ring: true, lock: [] } } } }));
    assert.equal(sev(noLock, 'leo', 'mum'), 'risk');
    assert.deepEqual(newRisks(before, noLock), []);
    // a new risk that was never held is not a "bond ended"
    const s = lagoon();
    s.animals.push(bird('bro', M, ['dad', 'mum']));
    const plain = newRisks(before, buildKinModel(s));
    assert.equal(plain.length, 1);
    assert.equal(plain[0].bondEnded, undefined);
});

// ---------------------------------------------------------- zoo list

test('zoo list: held animals are not in the risk or "any" filters', () => {
    const z = (id, kinSeverity) => ({ id, species: 'Flamingo', gender: Gender.Male, maturity: Maturity.Adult, isPregnant: false,
        isAlpha: false, contracepted: false, welfare: 0.8, habitat: 'Lagoon', genes: null, kinSeverity });
    const list = [z('r', 'risk'), z('k', 'kin'), z('f', 'future'), z('h', 'held'), z('c', 'covered'), z('n', null)];
    const f = over => Object.assign({}, DEFAULT_ZOO_FILTERS, over);
    assert.deepEqual(applyZooFilters(list, f({ kin: 'risk' })).map(a => a.id), ['r']);
    assert.deepEqual(applyZooFilters(list, f({ kin: 'any' })).map(a => a.id), ['r', 'k', 'f']);
    assert.deepEqual(applyZooFilters(list, f({ sort: 'kin' })).map(a => a.id), ['r', 'k', 'f', 'h', 'c', 'n']);
});
