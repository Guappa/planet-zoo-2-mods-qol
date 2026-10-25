import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { sleep, stopPageTimers, triggered } from './fakepage.js';
import { autoPark, moves, sentSince } from './autopark.js';
import { HIPPO, Sex, animal, juvenile } from './zoo.js';
import { loadPages } from './pageloader.js';

loadPages();

after(stopPageTimers);

const { auto, loadPark } = await autoPark();
const A = auto._autopilotInternals();

let park = [
    animal('Cow', Sex.Female, 'H1'), Object.assign(animal('Due', Sex.Female, 'H1'), { preg: true }), animal('Bull', Sex.Male, 'H1'),
];

function change(id, patch) {
    park = park.map(a => (a.id === id ? Object.assign({}, a, patch) : a));
}

// each move the game takes lands at the trade centre on the next scan
moves.answer = id => {
    setTimeout(() => {
        change(id, { lt: 'trade', hab: '' });
        loadPark(park);
    }, 20);
    return { ok: true, detail: '' };
};

// past the minute after a load and Clean up's gap between looks
function lookNow() {
    A.loadAt = Date.now() - 120000;
    A.scans = 10;
    A.cleanAt.clear();
}

async function until(fn, what) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        lookNow();
        if (fn()) return;
        await sleep(100);
    }
    throw new Error(`${what} did not happen within 15 s`);
}

const sentIds = from => sentSince(from, 'PZ2QoL_KinMove').map(call => call[2]);

test('one button stops breeding everywhere and empties the zoo, the young and pregnant as they can go', async () => {
    loadPark(park);
    auto.setSpeciesAuto(HIPPO, { on: true });
    assert.equal(auto.setCleanUp(true), true);
    assert.equal(auto.getAutopilotLedger().sp[HIPPO].on, false, 'breeding is off');
    assert.equal(auto.isCleaningUp(), true);
    const from = triggered.length;
    loadPark(park);
    await until(() => sentIds(from).length >= 2, 'the adults leaving');
    assert.deepEqual(sentIds(from), ['Bull', 'Cow'], 'the male first; the pregnant one stays');

    // she gives birth: she goes, her calf stays until it grows up
    change('Due', { preg: false });
    park = park.concat([juvenile('Calf', Sex.Male, 'H1', { par: ['Due', 'Bull'] })]);
    loadPark(park);
    await until(() => sentIds(from).includes('Due'), 'the mother leaving after the birth');
    assert.ok(!sentIds(from).includes('Calf'));

    change('Calf', { juv: false, age: 8 });
    loadPark(park);
    await until(() => sentIds(from).includes('Calf'), 'the grown calf leaving');
    await until(() => !auto.isCleaningUp(), 'Clean up ending by itself');
    assert.equal(auto.getAutopilotLedger().clean, false);
});
