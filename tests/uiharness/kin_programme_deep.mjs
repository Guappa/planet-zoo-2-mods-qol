// Browser-harness scenario: the breeding programme's Deep optimiser.
// Okapi: 14 breeders in three habitats (a guided search, not every layout);
// Tapir: 12 breeders in three habitats; Bongo: 2 (Classic scores every layout). Fakes the Lua side (PZ2QoL_KinSpecies,
// PZ2QoL_KinDestinations, PZ2QoL_KinMove) while window.__kpd.active.
// Checks:
// - the Optimiser chip opens the options row; Deep + Quick starts by itself;
//   the result shows as "Deep · N starts";
// - closing and reopening the panel keeps it;
// - Extreme starts by itself too; Stop gives "stopped" with Continue;
// - another species' panel doesn't stop a running job ("stops the … search");
// - a juvenile born leaves the result, a breeder's move marks it stale;
// - Execute of that species stops the job; PZ2QoL_StoreReset drops it all.
import { seedZooKin } from './kin_fixture.mjs';

export const name = 'programme_deep';

const BOARD = '/js/mods/pz2qol/kinboard.js';

async function click(locator) {
    try {
        await locator.first().click({ timeout: 2500 });
    }
    catch (e) {
        await locator.first().dispatchEvent('click');
    }
}

const job = page => page.evaluate(async () => {
    const d = await import('/js/mods/pz2qol/kinprogdeep.js');
    const j = d.deepJob();
    return j ? { species: j.species, done: j.done, planned: j.planned, stop: j.stopRequested } : null;
});

async function openProgramme(page, species) {
    await page.evaluate(async ([url, sp]) => (await import(url)).openSpeciesBoard({ species: sp }), [BOARD, species]);
    await page.waitForTimeout(250);
    await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Breeding programme' }));
    await page.waitForSelector('.PZ2QoL_kbStats', { timeout: 8000 });
}

const deepRow = async page => {
    const n = page.locator('.PZ2QoL_kbDeep');
    if (!(await n.count())) return null;
    return { cls: await n.first().getAttribute('class'), text: (await n.first().innerText()).replace(/\s+/g, ' ').trim() };
};

export async function hud(page, ctx) {
    const facts = {};
    const problems = [];
    await seedZooKin(page);
    await page.evaluate(async () => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const snap = JSON.parse(JSON.stringify(window.__kinFixture.snapshot));
        snap.mode = 'offline';
        snap.tradeCentre = { id: '501', name: 'Trade Centre' };
        for (const [id, nm] of [['9031', 'Okapi North'], ['9032', 'Okapi South'], ['9033', 'Okapi East'], ['9041', 'Tapir Pool'], ['9042', 'Tapir Marsh'], ['9043', 'Tapir Bank'], ['9051', 'Bongo Glade']]) snap.habitats.push({ id, name: nm, kind: 'habitat' });
        const L = 'ABCDEFGH';
        const g = s => ({ F: L[s % 8].repeat(3) + L[(s + 3) % 8].repeat(3) + L[(s + 5) % 8].repeat(3) + L[(s * 7) % 8].repeat(3), I: L[(s + 1) % 8].repeat(6) + L[(s + 4) % 8].repeat(6), S: 'AAAAAACCCCCC', L: 'AABBAACCCCCC' });
        const add = (sp, id, name, sex, hab, s, par = []) => snap.animals.push({
            id, key: 'animal_' + id, guid: 'dp' + id, name, species: sp, sex, juv: false, contra: false, infertile: false, preg: false,
            hab, loc: hab, lt: 'habitat', par: par.map(p => 'dp' + p), mates: [], genes: g(s), age: 5, ageQ: 2,
        });
        const habs = ['9031', '9032', '9033'];
        for (let i = 0; i < 14; i++) add('Okapi', String(8100 + i), 'Oka' + i, i % 2, habs[i % 3], i, i >= 8 ? [String(8100 + (i % 4)), String(8101 + (i % 4))] : []);
        for (let i = 0; i < 12; i++) add('Tapir', String(8200 + i), 'Tap' + i, i % 2, ['9041', '9042', '9043'][i % 3], 20 + i);
        // Bongo: two breeders, one habitat: Classic scores every layout
        for (let i = 0; i < 2; i++) add('Bongo', String(8300 + i), 'Bon' + i, i % 2, '9051', 40 + i);
        snap.speciesFacts = Object.assign({}, snap.speciesFacts, { Okapi: { maturity: 2, infertility: 20, life: 30 }, Tapir: { maturity: 2, infertility: 20, life: 30 }, Bongo: { maturity: 2, infertility: 20, life: 30 } });
        for (const a of snap.animals) if (!a.lt) a.lt = a.hab ? 'habitat' : 'other';
        window.__kpdSnap = snap;
        kin.applyKinSnapshot(snap);
        window.__kpdMoves = await import('/js/mods/pz2qol/kinmoves.js');
        const DEST = { bySpecies: { Okapi: { 9031: { ok: true }, 9032: { ok: true }, 9033: { ok: true } }, Tapir: { 9041: { ok: true }, 9042: { ok: true }, 9043: { ok: true } }, Bongo: { 9051: { ok: true } } }, habitats: [], tradeCentre: { id: '501', name: 'Trade Centre' } };
        const INFO = { social: { min: 1, max: 6 }, fertilityAges: { maturity: 2, infertility: 20 }, mating: 'monogamy', habitats: { 9031: { available: { land: 6000 }, required: { land: 1000 }, adults: 5 }, 9032: { available: { land: 6000 }, required: { land: 1000 }, adults: 5 }, 9033: { available: { land: 6000 }, required: { land: 1000 }, adults: 4 }, 9041: { available: { land: 6000 }, required: { land: 1000 }, adults: 4 }, 9042: { available: { land: 6000 }, required: { land: 1000 }, adults: 4 }, 9043: { available: { land: 6000 }, required: { land: 1000 }, adults: 4 }, 9051: { available: { land: 6000 }, required: { land: 1000 }, adults: 2 } } };
        window.__kpd = { active: true, moves: [] };
        if (engine.events) for (const n of ['PZ2QoL_KinDestinations', 'PZ2QoL_KinSpecies', 'PZ2QoL_KinMove']) engine.events[n] = [];
        engine.on('PZ2QoL_KinDestinations', reqId => window.__kpd.active && engine.trigger('PZ2QoL_KinDestinationsResult', reqId, JSON.stringify(DEST)));
        engine.on('PZ2QoL_KinSpecies', reqId => window.__kpd.active && setTimeout(() => engine.trigger('PZ2QoL_KinSpeciesResult', reqId, JSON.stringify(INFO)), 100));
        engine.on('PZ2QoL_KinMove', (reqId, id, to) => {
            if (!window.__kpd.active) return;
            window.__kpd.moves.push([String(id), String(to)]);
            engine.trigger('PZ2QoL_KinMoveResult', reqId, true, '');
        });
        // a fresh start: Classic, no kept results
        const prefs = await import('/js/mods/pz2qol/prefs.js');
        prefs.setPref('progOpt', undefined);
        (await import('/js/mods/pz2qol/kinprogdeep.js'))._resetDeepForTests();
    });
    const apply = fn => page.evaluate(async src => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        // eslint-disable-next-line no-new-func
        new Function('snap', src)(window.__kpdSnap);
        window.__kpdSnap.seq++;
        kin.applyKinSnapshot(JSON.parse(JSON.stringify(window.__kpdSnap)));
    }, fn);
    try {
        await openProgramme(page, 'Okapi');
        facts.chip = await page.locator('.PZ2QoL_kbOptChip').innerText();
        if (!/Classic/.test(facts.chip)) problems.push(`chip: ${facts.chip}`);
        if (await deepRow(page)) problems.push('a deep row with Classic chosen');
        // the slider's last position is kept for the next opening
        await click(page.locator('.PZ2QoL_kbStep[data-step="1"]'));
        await page.waitForTimeout(150);
        await click(page.locator('.PZ2QoL_kbProg .PZ2QoL_kpBtn', { hasText: 'Cancel' }));
        await page.waitForTimeout(150);
        await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Breeding programme' }));
        await page.waitForSelector('.PZ2QoL_kbStats', { timeout: 8000 });
        facts.stepKept = await page.locator('.PZ2QoL_kbStep.on').getAttribute('data-step');
        if (facts.stepKept !== '1') problems.push(`slider not kept: ${facts.stepKept}`);
        facts.stepPref = await page.evaluate(async () => (await import('/js/mods/pz2qol/prefs.js')).getPref('progStep'));
        if (facts.stepPref !== 1) problems.push(`progStep pref: ${facts.stepPref}`);
        await click(page.locator('.PZ2QoL_kbStep[data-step="3"]'));
        await page.waitForTimeout(300);
        // the options row; Deep, then Quick (starts by itself)
        await click(page.locator('.PZ2QoL_kbOptChip'));
        await page.waitForSelector('.PZ2QoL_kbOptRow', { timeout: 2000 });
        await click(page.locator('.PZ2QoL_kbOptPick', { hasText: 'Deep' }));
        await page.waitForTimeout(150);
        await click(page.locator('.PZ2QoL_kbOptPick', { hasText: 'Quick' }));
        await page.waitForTimeout(150);
        await ctx.shot(page, 'kpd_1_options');
        facts.pref = await page.evaluate(async () => (await import('/js/mods/pz2qol/prefs.js')).getPref('progOpt'));
        if (!facts.pref || facts.pref.engine !== 'deep' || facts.pref.preset !== 'quick') problems.push(`default not saved: ${JSON.stringify(facts.pref)}`);
        await page.waitForSelector('.PZ2QoL_kbDeep.running', { timeout: 4000 }).catch(() => problems.push('Quick did not start by itself'));
        await ctx.shot(page, 'kpd_2_running');
        facts.running = await deepRow(page);
        await page.waitForSelector('.PZ2QoL_kbDeep.done', { timeout: 90000 });
        facts.done = await deepRow(page);
        await ctx.shot(page, 'kpd_3_done');
        if (!/Deep · 4 starts/.test(facts.done.text)) problems.push(`done row: ${facts.done.text}`);
        // close and reopen: kept
        await click(page.locator('.PZ2QoL_kbProg .PZ2QoL_kpBtn', { hasText: 'Cancel' }));
        await page.waitForTimeout(200);
        await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Breeding programme' }));
        await page.waitForSelector('.PZ2QoL_kbStats', { timeout: 8000 });
        await page.waitForTimeout(300);
        facts.reopened = await deepRow(page);
        if (!facts.reopened || !/done/.test(facts.reopened.cls)) problems.push(`not kept after reopening: ${JSON.stringify(facts.reopened)}`);
        // a juvenile born: still the same result
        await apply("snap.animals.push({ id: '8199', key: 'animal_8199', guid: 'dp8199', name: 'Baby', species: 'Okapi', sex: 0, juv: true, contra: false, infertile: false, hab: '9031', loc: '9031', lt: 'habitat', par: ['dp8100', 'dp8101'], mates: [], genes: snap.animals.find(a => a.id === '8100').genes, age: 0, ageQ: 0 });");
        await page.waitForTimeout(400);
        facts.afterBirth = await deepRow(page);
        if (!facts.afterBirth || !/done/.test(facts.afterBirth.cls)) problems.push(`a birth made it stale: ${JSON.stringify(facts.afterBirth)}`);
        // Thorough: waits for Run; Stop; Continue
        if (!(await page.locator('.PZ2QoL_kbOptRow').count())) await click(page.locator('.PZ2QoL_kbOptChip'));
        await click(page.locator('.PZ2QoL_kbOptPick', { hasText: 'Extreme' }));
        await page.waitForTimeout(1500);
        facts.thorough = await deepRow(page);
        // every preset starts by itself (developer, 2026-10-18)
        await page.waitForSelector('.PZ2QoL_kbDeep.running', { timeout: 4000 }).catch(() => problems.push(`Extreme did not start by itself: ${JSON.stringify(facts.thorough)}`));
        await page.waitForFunction(async () => {
            const d = await import('/js/mods/pz2qol/kinprogdeep.js');
            const j = d.deepJob();
            return !!j && j.done >= 1;
        }, null, { timeout: 60000 });
        facts.btn = await page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Breeding programme' }).innerText();
        if (!/deep \d+ %/.test(facts.btn)) problems.push(`board button: ${facts.btn}`);
        await click(page.locator('.PZ2QoL_kbDeep .PZ2QoL_kpBtn', { hasText: 'Stop' }));
        await page.waitForSelector('.PZ2QoL_kbDeep.stopped', { timeout: 30000 });
        facts.stopped = await deepRow(page);
        await ctx.shot(page, 'kpd_4_stopped');
        if (!/Continue/.test(facts.stopped.text)) problems.push(`stopped row: ${facts.stopped.text}`);
        await click(page.locator('.PZ2QoL_kbDeep .PZ2QoL_kpBtn', { hasText: 'Continue' }));
        await page.waitForSelector('.PZ2QoL_kbDeep.running', { timeout: 4000 });
        facts.continued = await job(page);
        if (!facts.continued || facts.continued.species !== 'Okapi') problems.push(`continue: ${JSON.stringify(facts.continued)}`);
        // another species: the Okapi job keeps running
        await click(page.locator('.PZ2QoL_kbProg .PZ2QoL_kpBtn', { hasText: 'Cancel' }));
        await page.waitForTimeout(200);
        await page.evaluate(async url => (await import(url)).openSpeciesBoard({ species: 'Tapir' }), BOARD);
        await page.waitForTimeout(300);
        await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Breeding programme' }));
        await page.waitForSelector('.PZ2QoL_kbStats', { timeout: 8000 });
        await page.waitForTimeout(1500);
        facts.tapir = await deepRow(page);
        facts.tapirJob = await job(page);
        await ctx.shot(page, 'kpd_5_other_species');
        if (!facts.tapirJob || facts.tapirJob.species !== 'Okapi' || facts.tapirJob.stop) problems.push(`the Okapi job did not keep running: ${JSON.stringify(facts.tapirJob)}`);
        if (!facts.tapir || !/stops the/.test(facts.tapir.text)) problems.push(`Tapir row: ${JSON.stringify(facts.tapir)}`);
        // a species Classic solves exactly: no deep search, and it says why
        await click(page.locator('.PZ2QoL_kbProg .PZ2QoL_kpBtn', { hasText: 'Cancel' }));
        await openProgramme(page, 'Bongo');
        await page.waitForTimeout(1500);
        facts.bongo = await deepRow(page);
        await ctx.shot(page, 'kpd_7_exact');
        if (!facts.bongo || !/exact/.test(facts.bongo.cls) || !/every possible layout/.test(facts.bongo.text)) problems.push(`Bongo row: ${JSON.stringify(facts.bongo)}`);
        // back to Okapi; a breeder's move: stale
        await click(page.locator('.PZ2QoL_kbProg .PZ2QoL_kpBtn', { hasText: 'Cancel' }));
        await page.evaluate(async () => (await import('/js/mods/pz2qol/kinprogdeep.js')).stopDeep());
        await page.waitForFunction(async () => !(await import('/js/mods/pz2qol/kinprogdeep.js')).deepJob(), null, { timeout: 30000 });
        await openProgramme(page, 'Okapi');
        await page.waitForTimeout(300);
        await apply("snap.animals.find(a => a.id === '8100').hab = '9033';");
        await page.waitForTimeout(600);
        facts.stale = await deepRow(page);
        await ctx.shot(page, 'kpd_6_stale');
        if (!facts.stale || !/stale/.test(facts.stale.cls)) problems.push(`a breeder's move did not mark it stale: ${JSON.stringify(facts.stale)}`);
        // Execute of that species stops a running job
        await click(page.locator('.PZ2QoL_kbDeep .PZ2QoL_kpBtn', { hasText: 'Run deep search' }));
        await page.waitForSelector('.PZ2QoL_kbDeep.running', { timeout: 6000 });
        await click(page.locator('.PZ2QoL_kbProg .PZ2QoL_kpBtn', { hasText: 'Use this plan' }));
        await page.waitForTimeout(300);
        const planned = await page.locator('.PZ2QoL_kbMove').count();
        if (planned) {
            await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Execute plan' }));
            await page.waitForTimeout(300);
            facts.afterExecute = await job(page);
            if (facts.afterExecute && !facts.afterExecute.stop) problems.push('Execute did not stop the deep search');
            await page.evaluate(() => window.__kpdMoves.stopPlan());
        }
        else facts.afterExecute = 'no moves to execute';
        // a park end: everything dropped
        await page.evaluate(async () => {
            const d = await import('/js/mods/pz2qol/kinprogdeep.js');
            d.startDeep && null;
            engine.trigger('PZ2QoL_StoreReset');
        });
        await page.waitForTimeout(300);
        facts.afterReset = await page.evaluate(async () => {
            const d = await import('/js/mods/pz2qol/kinprogdeep.js');
            return { job: !!d.deepJob() };
        });
        if (facts.afterReset.job) problems.push('PZ2QoL_StoreReset left a job running');
    }
    finally {
        await page.evaluate(async url => {
            if (window.__kpd) window.__kpd.active = false;
            const d = await import('/js/mods/pz2qol/kinprogdeep.js');
            d._resetDeepForTests();
            (await import('/js/mods/pz2qol/prefs.js')).setPref('progOpt', undefined);
            (await import('/js/mods/pz2qol/prefs.js')).setPref('progStep', undefined);
            const m = await import(url);
            m.closeSpeciesBoard();
            const kin = await import('/js/mods/pz2qol/kin.js');
            kin.applyKinSnapshot(window.__kinFixture.snapshot);
        }, BOARD).catch(() => {});
    }
    facts.problems = problems;
    if (problems.length) throw new Error('programme_deep: ' + problems.join('; '));
    return facts;
}
