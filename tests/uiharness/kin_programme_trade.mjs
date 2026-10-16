// Browser-harness scenario: the breeding programme takes a breeder out of
// the trade centre. Okapi: two unrelated females in Okapi Forest and no
// male; an unrelated male (Bwana) waits at the trade centre. Fakes the Lua
// side (PZ2QoL_KinSpecies, PZ2QoL_KinDestinations, PZ2QoL_KinMove) while
// window.__kpt.active. Checks: the preview counts "1 from the trade
// centre" and offers "Use the trade centre (1 waiting)"; switching it off
// leaves Bwana there; Use this plan + Execute send Bwana to Okapi Forest.
import { seedZooKin } from './kin_fixture.mjs';

export const name = 'programme_trade';

const BOARD = '/js/mods/pz2qol/kinboard.js';

async function click(locator) {
    try {
        await locator.first().click({ timeout: 2500 });
    }
    catch (e) {
        await locator.first().dispatchEvent('click');
    }
}

export async function hud(page, ctx) {
    const facts = {};
    const problems = [];
    await seedZooKin(page);
    await page.evaluate(async () => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const snap = JSON.parse(JSON.stringify(window.__kinFixture.snapshot));
        snap.mode = 'offline';
        snap.tradeCentre = { id: '501', name: 'Trade Centre' };
        snap.habitats.push({ id: '9020', name: 'Okapi Forest', kind: 'habitat' });
        const g = s => ({ F: 'ABCDEFGHABCD'.slice(s % 4, s % 4 + 6) + 'HGFEDCBAHGFE'.slice(s % 3, s % 3 + 6), I: 'ABABABCDCDCD', S: 'AAAAAACCCCCC', L: 'AAAAAACCCCCC' });
        const add = (id, name, sex, hab, lt, s) => snap.animals.push({
            id, key: 'animal_' + id, guid: 'ok' + id, name, species: 'Okapi', sex, juv: false, contra: false, infertile: false, preg: false,
            hab, loc: hab ? 'Okapi Forest' : 'Trade Centre', lt, par: [], mates: [], genes: g(s), age: 5, ageQ: 2,
        });
        add('8001', 'Imani', 1, '9020', 'habitat', 1);
        add('8002', 'Nia', 1, '9020', 'habitat', 2);
        add('8003', 'Bwana', 0, '', 'trade', 3);
        snap.speciesFacts = Object.assign({}, snap.speciesFacts, { Okapi: { maturity: 2, infertility: 20, life: 30 } });
        for (const a of snap.animals) if (!a.lt) a.lt = a.hab ? 'habitat' : 'other';
        window.__kptSnap = snap;
        kin.applyKinSnapshot(snap);
        window.__kptMoves = await import('/js/mods/pz2qol/kinmoves.js');
        const DEST = { bySpecies: { Okapi: { 9020: { ok: true } } }, habitats: [], tradeCentre: { id: '501', name: 'Trade Centre' } };
        const INFO = { social: { min: 1, max: 4 }, fertilityAges: { maturity: 2, infertility: 20 }, mating: 'polygyny', habitats: { 9020: { available: { land: 3000 }, required: { land: 1000 }, adults: 2 } } };
        window.__kpt = { active: true, moves: [] };
        if (engine.events) for (const n of ['PZ2QoL_KinDestinations', 'PZ2QoL_KinSpecies', 'PZ2QoL_KinMove']) engine.events[n] = [];
        engine.on('PZ2QoL_KinDestinations', reqId => window.__kpt.active && engine.trigger('PZ2QoL_KinDestinationsResult', reqId, JSON.stringify(DEST)));
        engine.on('PZ2QoL_KinSpecies', reqId => window.__kpt.active && setTimeout(() => engine.trigger('PZ2QoL_KinSpeciesResult', reqId, JSON.stringify(INFO)), 200));
        engine.on('PZ2QoL_KinMove', (reqId, id, to) => {
            if (!window.__kpt.active) return;
            window.__kpt.moves.push([String(id), String(to)]);
            engine.trigger('PZ2QoL_KinMoveResult', reqId, true, '');
            setTimeout(() => {
                const a = window.__kptSnap.animals.find(x => String(x.id) === String(id));
                if (a) a.moving = true;
                window.__kptSnap.seq++;
                kin.applyKinSnapshot(JSON.parse(JSON.stringify(window.__kptSnap)));
            }, 250);
        });
    });
    try {
        await page.evaluate(async url => (await import(url)).openSpeciesBoard({ species: 'Okapi' }), BOARD);
        await page.waitForSelector('.PZ2QoL_kb:not(.hidden) .PZ2QoL_kbCol[data-col="9020"]', { timeout: 4000 });
        await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Breeding programme' }));
        await page.waitForSelector('.PZ2QoL_kbStats', { timeout: 5000 });
        await page.waitForTimeout(300);
        await ctx.shot(page, 'kpt_1_preview');
        facts.sub = await page.locator('.PZ2QoL_kbProgSub').innerText();
        facts.toggle = await page.locator('.PZ2QoL_kbTradeUse').allInnerTexts();
        facts.incoming = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbGroup[data-hab="9020"] .PZ2QoL_kbGroupAnimal.in')].map(n => n.innerText.replace(/\s+/g, ' ').trim()));
        if (!/1 from the trade centre/.test(facts.sub)) problems.push(`preview does not count the trade centre: "${facts.sub}"`);
        if (!facts.toggle.length || !/Use the trade centre \(1 waiting\)/.test(facts.toggle[0])) problems.push(`no trade centre toggle: ${JSON.stringify(facts.toggle)}`);
        if (!facts.incoming.some(t => /Bwana/.test(t))) problems.push(`Bwana not shown coming into Okapi Forest: ${JSON.stringify(facts.incoming)}`);
        // off: Bwana stays at the trade centre
        await click(page.locator('.PZ2QoL_kbTradeUse'));
        await page.waitForTimeout(250);
        facts.offMoves = +(await page.locator('.PZ2QoL_kbStats').getAttribute('data-moves'));
        await ctx.shot(page, 'kpt_2_off');
        if (facts.offMoves !== 0) problems.push(`with the trade centre off the programme still moves ${facts.offMoves}`);
        await click(page.locator('.PZ2QoL_kbTradeUse'));
        await page.waitForTimeout(250);
        // use it and run it
        await click(page.locator('.PZ2QoL_kbProg .PZ2QoL_kpBtn', { hasText: 'Use this plan' }));
        await page.waitForTimeout(400);
        facts.plan = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbMove')].map(n => n.innerText.replace(/\s+/g, ' ').trim()));
        if (facts.plan.length !== 1 || !/Bwana/.test(facts.plan[0]) || !/from the trade centre/.test(facts.plan[0])) problems.push(`plan: ${JSON.stringify(facts.plan)}`);
        await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Execute plan' }));
        await page.waitForFunction(() => window.__kptMoves.getPlanRun().finished === true && !window.__kptMoves.getPlanRun().running, null, { timeout: 20000 });
        facts.moves = await page.evaluate(() => window.__kpt.moves.slice());
        facts.run = await page.evaluate(() => { const r = window.__kptMoves.getPlanRun(); return { done: r.done, error: r.error }; });
        await ctx.shot(page, 'kpt_3_executed');
        if (JSON.stringify(facts.moves) !== JSON.stringify([['8003', '9020']]) || facts.run.error) problems.push(`moves sent: ${JSON.stringify(facts.moves)} run ${JSON.stringify(facts.run)}`);
    }
    finally {
        await page.evaluate(async url => {
            if (window.__kpt) window.__kpt.active = false;
            const m = await import(url);
            m.closeSpeciesBoard();
            const kin = await import('/js/mods/pz2qol/kin.js');
            kin.applyKinSnapshot(window.__kinFixture.snapshot);
        }, BOARD).catch(() => {});
    }
    facts.problems = problems;
    if (problems.length) throw new Error('programme_trade: ' + problems.join('; '));
    return facts;
}
