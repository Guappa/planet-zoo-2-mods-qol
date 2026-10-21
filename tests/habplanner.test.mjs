import test from 'node:test';
import assert from 'node:assert/strict';
import * as HabCore from '../apps/habitat-planner/public/core.js';

// The Mixed Habitat Planner's rules (apps/habitat-planner/public/core.js). The
// fixture is made up: the real species data is Frontier's and never enters the repo.

function species(id, over = {}) {
    return Object.assign({
        id, kind: 'animal', name: id, pack: 'BaseGame', enclosure: 'aquarium', roofed: false, climbProof: false,
        tier: [0, 0], cohab: [], flourish: [], terrain: [], plants: [], biomes: ['Reef'], continents: [],
        space: { land: [0, 0], water: [0, 0], deep: [100, 25], climb: [0, 0], fly: [0, 0], shelter: 0 },
        group: { min: 1, max: 4 }, sal: [0, 1, 1], temp: [22, 30], tol: [17, 35], plant: [0, 1], appeal: 0.5,
    }, over);
}

const DATA = {
    game: 'test',
    groups: { Reef: 'Reef', Shoals: 'Reef shoals', Plains: 'Plains' },
    terrain: { Sand: 'Sand', Sand_Fine: 'Fine sand', Rock: 'Rock', Grass: 'Grass' },
    terrainParent: { Sand_Fine: 'Sand' },
    biomes: {}, continents: {},
    overrides: [['Shark', 'Turtle']],
    species: [
        species('Turtle', { cohab: ['Shoals'], flourish: [['Shoals', 1]], terrain: [['Sand_Fine', 0.5, 1, null]] }),
        species('Shark', { cohab: ['Reef'], tier: [1, 3], terrain: [['Sand', 0.3, 1, null], ['Rock', 0.2, 0.6, null]] }),
        species('Ray', { cohab: ['Reef', 'Shoals'], terrain: [['Sand', 0.9, 1, null]] }),
        species('Sardine', { kind: 'shoal', cohab: ['Shoals'], plant: [0, 0.1], space: { land: [0, 0], water: [0, 0], deep: [50, 15], climb: [0, 0], fly: [0, 0], shelter: 0 } }),
        species('Koi', { cohab: ['Shoals'], sal: [1, 0, 0] }),
        species('Cod', { cohab: ['Shoals'], temp: [5, 12], tol: [2, 16] }),
        species('Puffer', { cohab: ['Shoals'], temp: [26, 32], tol: [21, 36], pack: 'Deluxe' }),
        species('Hammerhead'),
        species('Zebra', { enclosure: 'habitat', sal: null, cohab: ['Plains'], space: { land: [460, 140], water: [0, 0], deep: [0, 0], climb: [0, 0], fly: [0, 0], shelter: 10 }, group: { min: 3, max: 12 } }),
    ],
};
const H = HabCore.create(DATA);
const mix = (...ids) => ids.map(id => ({ id, n: 1 }));

test('compat: a shared group or a listed exception, used both ways', () => {
    assert.deepEqual(H.compat('Turtle', 'Sardine'), { ok: true, via: 'group', groups: ['Shoals'] });
    assert.equal(H.compat('Turtle', 'Shark').via, 'exception');
    assert.equal(H.compat('Shark', 'Turtle').via, 'exception');
    assert.equal(H.compat('Turtle', 'Hammerhead').ok, false);
    assert.equal(H.compat('Shark', 'Sardine').ok, false);
});

test('partners only count the same kind of enclosure', () => {
    assert.deepEqual(H.partners('Hammerhead'), []);
    assert.ok(!H.partners('Turtle').includes('Zebra'));
    assert.ok(H.partners('Turtle').includes('Shark'));
});

test('evaluate: every member must allow the newcomer', () => {
    const r = H.evaluate(mix('Turtle', 'Shark'), 'Sardine');
    assert.equal(r.status, 'blocked');
    assert.deepEqual(r.reasons.map(x => x.with), ['Shark']);
    assert.equal(H.evaluate(mix('Turtle'), 'Sardine').status, 'fits');
});

test('evaluate: salinity and temperature', () => {
    const koi = H.evaluate(mix('Turtle'), 'Koi');
    assert.equal(koi.status, 'blocked');
    assert.equal(koi.reasons[0].code, 'salinity');
    assert.equal(H.evaluate(mix('Turtle'), 'Cod').reasons[0].code, 'temp');
    assert.equal(H.evaluate(mix('Turtle'), 'Cod').status, 'blocked');
    const puffer = H.evaluate(mix('Turtle', 'Sardine'), 'Puffer');
    assert.equal(puffer.status, 'fits'); // 26-30 overlaps
});

test('evaluate: a plant-cover or terrain clash is a trade-off, not a block', () => {
    const r = H.evaluate([{ id: 'Turtle', n: 1 }, { id: 'Shark', n: 1 }], 'Ray');
    assert.equal(r.status, 'tradeoff');
    assert.ok(r.reasons.some(x => x.code === 'terrain'));
    assert.equal(H.evaluate([{ id: 'Turtle', n: 1 }, { id: 'Sardine', n: 1 }], 'Ray').status, 'fits');
});

test('evaluate: a different enclosure is left out, and flourishing links show', () => {
    assert.equal(H.evaluate(mix('Turtle'), 'Zebra').status, 'other');
    const r = H.evaluate(mix('Turtle'), 'Sardine');
    assert.deepEqual(r.links, [{ from: 'Turtle', to: 'Sardine', group: 'Shoals' }]);
});

test('terrain: children count towards their parent, minimums add up', () => {
    const t = H.terrainPlan(['Turtle', 'Shark'].map(H.sp));
    const sand = t.kinds.find(k => k.tag === 'Sand');
    assert.equal(sand.need, 0.5); // fine sand 50% covers the shark's 30% sand
    assert.equal(Math.round(t.total * 100), 70);
    assert.deepEqual(t.conflicts, []);
    const over = H.terrainPlan(['Turtle', 'Shark', 'Ray'].map(H.sp));
    assert.ok(over.conflicts.some(c => c.tag === '*')); // sand 90% + rock 20% > 100%
});

test('space: minimum plus per extra animal; the mix needs the largest', () => {
    assert.deepEqual(H.spaceNeed(H.sp('Turtle'), 4).deep, 175);
    assert.equal(H.spaceNeed(H.sp('Zebra'), 4).land, 880);
    assert.equal(H.spaceNeed(H.sp('Zebra'), 4).shelter, 40);
    const n = H.needs([{ id: 'Turtle', n: 4 }, { id: 'Sardine', n: 3 }]);
    assert.equal(n.space.deep.max, 175);
    assert.equal(n.space.deep.sum, 175 + 80);
    assert.deepEqual(n.temp, [22, 30]);
    assert.deepEqual(n.sal, [0, 1, 1]);
});

test('fitCount: the tightest space type limits, capped by the group', () => {
    assert.deepEqual(H.fitCount(H.sp('Turtle'), { deep: 175 }), { n: 4, by: 'group' });
    assert.deepEqual(H.fitCount(H.sp('Turtle'), { deep: 160 }), { n: 3, by: 'deep' });
    assert.deepEqual(H.fitCount(H.sp('Turtle'), { deep: 90 }), { n: 0, by: 'deep' });
    assert.deepEqual(H.fitCount(H.sp('Zebra'), { land: 1000 }), { n: 4, by: 'land' });
    assert.deepEqual(H.fitCount(H.sp('Zebra'), {}), { n: 12, by: 'group' });
});

test('locks: tier by game mode, and packs', () => {
    assert.equal(H.lockReason(H.sp('Shark'), { tierMode: 'franchise', tier: 2 }).code, 'tier');
    assert.equal(H.lockReason(H.sp('Shark'), { tierMode: 'career', tier: 2 }), null);
    assert.equal(H.lockReason(H.sp('Puffer'), { tier: 4, packs: { Deluxe: false } }).code, 'pack');
    const s = H.survey(mix('Turtle'), { tierMode: 'franchise', tier: 2 });
    assert.equal(s.count.locked, 1);
    assert.equal(H.survey(mix('Turtle'), { shoals: false }).rows.some(r => r.id === 'Sardine'), false);
});

test('suggest: the biggest group that all get along, unlocked only', () => {
    const all = H.suggest(mix('Turtle'), { tier: 4 });
    assert.equal(all.complete, true);
    // Shark and Sardine can't share, Koi and Cod are blocked, Ray brings a terrain trade-off with Shark
    for (const id of all.ids) {
        for (const other of ['Turtle', ...all.ids]) {
            if (other !== id) assert.ok(H.compat(id, other).ok, id + ' / ' + other);
        }
    }
    assert.ok(!all.ids.includes('Koi') && !all.ids.includes('Cod'));
    assert.ok(all.ids.length >= 2);
    const locked = H.suggest(mix('Turtle'), { tier: 4, packs: { Deluxe: false } });
    assert.ok(!locked.ids.includes('Puffer'));
});

test('mixIssues: clashes inside the mix and group sizes', () => {
    const issues = H.mixIssues([{ id: 'Turtle', n: 9 }, { id: 'Shark', n: 1 }, { id: 'Sardine', n: 1 }]);
    assert.ok(issues.some(i => i.code === 'cohab' && i.level === 'block'));
    assert.ok(issues.some(i => i.code === 'group'));
    assert.deepEqual(H.mixIssues([{ id: 'Turtle', n: 2 }, { id: 'Sardine', n: 1 }]), []);
});
