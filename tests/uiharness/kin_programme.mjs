// Browser-harness scenario: the Species board's breeding programme.
// Adds a polygynous species (gazelles) to the kin fixture: a father living
// with his three daughters and an unrelated female, an unrelated male alone
// in a second habitat, and an empty suitable third habitat. Fakes the Lua
// side: PZ2QoL_KinSpecies (group size, mating system, conception table,
// space), PZ2QoL_KinDestinations and PZ2QoL_KinMove. Walks: Breeding
// programme -> preview numbers -> the moves slider -> Use this plan ->
// Execute (the existing one-move-at-a-time path) -> a species the game does
// not describe (estimates, with a warning). The optimiser runs in slices in
// the background, so every step waits for the panel to leave its busy state.
// Also: the group make-up arrows (auto -> 1:1 -> back), the per-habitat
// target line, and that the choice is kept in the player store.
import { seedZooKin } from './kin_fixture.mjs';
import { layoutFacts, layoutProblems } from './kin_board.mjs';

export const name = 'programme';

const BOARD = '/js/mods/pz2qol/kinboard.js';

async function click(locator) {
    try {
        await locator.first().click({ timeout: 2500 });
    }
    catch (e) {
        await locator.first().dispatchEvent('click');
    }
}

const stats = page => page.evaluate(() => {
    const box = document.querySelector('.PZ2QoL_kbStats');
    if (!box) return null;
    const out = { moves: +box.getAttribute('data-moves'), system: box.getAttribute('data-system') };
    for (const n of box.querySelectorAll('.PZ2QoL_kbStat[data-key]')) {
        const k = n.getAttribute('data-key');
        if (k === 'moves') continue;
        const num = v => (v === '' || v == null ? null : +v);
        out[k] = [num(n.getAttribute('data-before')), num(n.getAttribute('data-after'))];
    }
    return out;
});

// the panel with numbers that are not being worked out again
const ready = (page, timeout = 8000) => page.waitForSelector('.PZ2QoL_kbProg:not(.busy) .PZ2QoL_kbStats', { timeout });

async function seedProgramme(page) {
    await page.evaluate(async () => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const snap = JSON.parse(JSON.stringify(window.__kinFixture.snapshot));
        snap.mode = 'offline';
        snap.tradeCentre = { id: '501', name: 'Trade Centre' };
        snap.habitats.push(
            { id: '9010', name: 'Gazelle Plains', kind: 'habitat' },
            { id: '9011', name: 'Gazelle Meadow', kind: 'habitat' },
            { id: '9012', name: 'Gazelle Hill', kind: 'habitat' },
            { id: '9013', name: 'Gazelle Ridge', kind: 'habitat' },
            { id: '9014', name: 'Gazelle Valley', kind: 'habitat' });
        const genes = s => {
            const L = 'ABCDEFGH';
            const st = o => Array.from({ length: 6 }, (_, i) => L[(s * 5 + (i + o) * 3) % 8]).join('');
            return { F: st(0) + st(4), I: st(1) + st(7), S: st(2) + st(3), L: st(3) + st(6) };
        };
        const loc = { 9010: 'Gazelle Plains', 9011: 'Gazelle Meadow', 9013: 'Gazelle Ridge', 9014: 'Gazelle Valley' };
        const add = (id, name, sex, hab, par = [], g = +id) => snap.animals.push({
            id, key: 'animal_' + id, guid: 'gz' + id, name, species: 'Gazelle', sex, juv: false, contra: false, infertile: false, preg: false,
            hab, loc: loc[hab] || '', lt: 'habitat', par, mates: [], genes: genes(g),
        });
        add('7001', 'Duma', 0, '9010');
        add('7002', 'Asha', 1, '9010', ['gz7001', 'gzMama']);
        add('7003', 'Binti', 1, '9010', ['gz7001', 'gzMama']);
        add('7004', 'Chui', 1, '9010', ['gz7001', 'gzMama']);
        add('7005', 'Furaha', 1, '9010');
        add('7006', 'Jabari', 0, '9011');
        // two settled unrelated pairs: swapping the females is a small gain, so
        // only "Best genetics" pays for it (genes picked with the real optimiser)
        add('7010', 'Kito', 0, '9013', [], 1);
        add('7011', 'Eshe', 1, '9013', [], 7);
        add('7012', 'Tano', 0, '9014', [], 8);
        add('7013', 'Zola', 1, '9014', [], 18);
        snap.anc.gzMama = [];
        for (const a of snap.animals) if (!a.lt) a.lt = a.hab ? 'habitat' : 'other';
        window.__kpgSnap = snap;
        kin.applyKinSnapshot(snap);
        window.__kpgMoves = await import('/js/mods/pz2qol/kinmoves.js');
        const ok = { ok: true };
        const DEST = {
            bySpecies: {
                Gazelle: { 9010: ok, 9011: ok, 9012: ok, 9013: ok, 9014: ok, 9000: { ok: false, reason: 'Wrong biome' } },
                Lion: { 9000: ok, 9001: { ok: false, reason: 'Too humid' } },
            },
            habitats: [{ id: '9012', name: 'Gazelle Hill' }],
            tradeCentre: { id: '501', name: 'Trade Centre' },
        };
        const table = Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (_, j) => Math.round(Math.max(0.1, (i + j) / 12) * 100) / 100));
        const INFO = {
            social: { min: 2, max: 4 },
            fertilityAges: { maturity: 0, infertility: 999 },
            mating: 'polygyny',
            conception: table,
            habitats: {
                9010: { available: { land: 4000 }, required: { land: 2500 }, adults: 5 },
                9011: { available: { land: 3000 }, required: { land: 500 }, adults: 1 },
                9012: { available: { land: 2200 } },
                9013: { available: { land: 2000 } },
                9014: { available: { land: 2000 } },
            },
        };
        window.__kpg = { active: true, species: [], moves: [], inFlight: false, overlap: false };
        // fakes left by earlier scenarios must not answer first (kinmoves takes the first answer)
        if (engine.events) for (const n of ['PZ2QoL_KinDestinations', 'PZ2QoL_KinSpecies', 'PZ2QoL_KinMove']) engine.events[n] = [];
        engine.on('PZ2QoL_KinDestinations', (reqId) => {
            if (!window.__kpg.active) return;
            engine.trigger('PZ2QoL_KinDestinationsResult', reqId, JSON.stringify(DEST));
        });
        engine.on('PZ2QoL_KinSpecies', (reqId, species, habs) => {
            const k = window.__kpg;
            if (!k.active) return;
            k.species.push([String(species), String(habs)]);
            if (String(species) !== 'Gazelle') return;      // the game "does not answer" for others
            setTimeout(() => engine.trigger('PZ2QoL_KinSpeciesResult', reqId, JSON.stringify(INFO)), 500);
        });
        engine.on('PZ2QoL_KinMove', (reqId, id) => {
            const k = window.__kpg;
            if (!k.active) return;
            const rec = { id: String(id), start: Date.now(), end: null };
            if (k.inFlight) k.overlap = true;
            k.moves.push(rec);
            k.inFlight = true;
            engine.trigger('PZ2QoL_KinMoveResult', reqId, true, '');
            setTimeout(() => {
                const a = window.__kpgSnap.animals.find(x => String(x.id) === String(id));
                if (a) a.moving = true;
                window.__kpgSnap.seq++;
                kin.applyKinSnapshot(JSON.parse(JSON.stringify(window.__kpgSnap)));
                rec.end = Date.now();
                k.inFlight = false;
            }, 250);
        });
    });
}

export async function hud(page, ctx) {
    const facts = ctx.facts || {};
    const problems = [];
    facts.problems = problems;
    const onAnimals = await page.evaluate(() => {
        const r = document.querySelector('.ManagementAnimals_root');
        return !!r && r.getBoundingClientRect().width > 0;
    });
    if (!onAnimals) {
        await page.evaluate(() => engine.trigger('World_ShowHUD'));
        await page.waitForTimeout(800);
        await page.evaluate(() => engine.trigger('Management_SetManagementIndex', 7 /* ManagementSectionID.Animals */));
        await page.waitForSelector('.ManagementAnimals_root', { state: 'visible', timeout: 15000 });
        await page.waitForTimeout(1200);
    }
    await seedZooKin(page);
    await seedProgramme(page);
    const progBtn = page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Breeding programme' });

    try {
        await page.evaluate(async url => (await import(url)).openSpeciesBoard({ species: 'Gazelle' }), BOARD);
        await page.waitForSelector('.PZ2QoL_kb:not(.hidden) .PZ2QoL_kbCol[data-col="9010"]', { timeout: 4000 });
        await page.waitForTimeout(400);

        // 1. ask the game, then the preview
        await click(progBtn);
        await page.waitForTimeout(150);
        facts.loading = await page.locator('.PZ2QoL_kbProg.state_loading').count();
        await ctx.shot(page, 'kp_prog_1_asking');
        await ready(page);
        await page.waitForTimeout(300);
        await ctx.shot(page, 'kp_prog_2_preview');
        facts.asked = await page.evaluate(() => window.__kpg.species.slice());
        facts.balanced = await stats(page);
        facts.sub = await page.locator('.PZ2QoL_kbProgSub').innerText();
        facts.warnings = await page.locator('.PZ2QoL_kbProgWarn').allInnerTexts();
        facts.groups = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbGroup')].map(n => ({
            hab: n.getAttribute('data-hab'), text: n.innerText.replace(/\s+/g, ' ').trim(), incoming: n.querySelectorAll('.PZ2QoL_kbGroupAnimal.in').length,
        })));
        facts.layoutPreview = await layoutFacts(page);
        layoutProblems('preview', facts.layoutPreview, problems);
        const s = facts.balanced;
        if (facts.loading !== 1) problems.push('no "Asking the game" state while waiting');
        if (!facts.asked.length || !/9010/.test(facts.asked[0][1]) || !/9011/.test(facts.asked[0][1]) || !/9012/.test(facts.asked[0][1])) problems.push(`species facts asked for ${JSON.stringify(facts.asked)}`);
        if (!s) problems.push('no programme numbers');
        else {
            if (s.system !== 'polygyny' || !/Harem/.test(facts.sub)) problems.push(`mating system shown: ${s.system} / "${facts.sub}"`);
            if (!(s.related[0] >= 3) || s.related[1] !== 0) problems.push(`related pairs ${s.related}, expected 3+ → 0`);
            if (!(s.pairs[1] > s.pairs[0])) problems.push(`breeding pairs ${s.pairs} do not improve`);
            if (!(s.moves >= 1)) problems.push('the programme has no moves');
            if (s.conception[1] == null || s.quality[1] == null) problems.push('no expected young / conception after');
        }
        if (facts.warnings.length) problems.push(`warnings with full game data: ${facts.warnings}`);
        for (const hab of ['9010', '9011', '9012']) if (!facts.groups.some(g => g.hab === hab)) problems.push(`no group card for ${hab}`);
        if (!facts.groups.some(g => g.incoming > 0)) problems.push('no animal marked as coming in');
        if (!facts.groups.some(g => /room for 4/.test(g.text))) problems.push('capacity (room for 4 adults) not shown');

        // 2. the moves slider recomputes
        facts.byStep = {};
        for (const step of [0, 1, 3, 2]) {
            await click(page.locator(`.PZ2QoL_kbStep[data-step="${step}"]`));
            await page.waitForTimeout(100);
            await ready(page);
            const st = await stats(page);
            facts.byStep[step] = st ? { moves: st.moves, pairs: st.pairs[1], related: st.related[1], quality: st.quality[1] } : null;
            if (step === 0) await ctx.shot(page, 'kp_prog_3_fewest_moves');
        }
        const m = Object.values(facts.byStep).map(x => x && x.moves);
        if (new Set(m).size < 2) problems.push(`the slider never changes the moves: ${JSON.stringify(facts.byStep)}`);
        if (!(facts.byStep[0].moves <= facts.byStep[3].moves)) problems.push('"Fewer moves" plans more moves than "Best genetics"');
        for (const [k, v] of Object.entries(facts.byStep)) if (v && v.related !== 0) problems.push(`step ${k} keeps ${v.related} related pairs`);

        // 2b. Recompute: the game is asked again, the slider choice stays
        const askedBefore = await page.evaluate(() => window.__kpg.species.length);
        await click(page.locator('.PZ2QoL_kbProg .PZ2QoL_kpBtn', { hasText: 'Recompute' }));
        await page.waitForTimeout(150);
        facts.recomputeLoading = await page.locator('.PZ2QoL_kbProg.state_loading').count();
        await ready(page);
        await page.waitForTimeout(300);
        facts.recomputeAsked = (await page.evaluate(() => window.__kpg.species.length)) - askedBefore;
        facts.recomputeStep = await page.locator('.PZ2QoL_kbStep.on').getAttribute('data-step');
        await ctx.shot(page, 'kp_prog_3b_recomputed');
        if (facts.recomputeLoading !== 1) problems.push('Recompute: no "Asking the game" state');
        if (facts.recomputeAsked !== 1) problems.push(`Recompute: the game's facts asked ${facts.recomputeAsked} times, expected 1`);
        if (facts.recomputeStep !== '2') problems.push(`Recompute: the slider moved to ${facts.recomputeStep}`);

        // 2c. the group make-up: auto from the mating system, the arrows, the target line
        const makeup = () => page.evaluate(() => {
            const n = document.querySelector('.PZ2QoL_kbRatio');
            const st = document.querySelector('.PZ2QoL_kbStats');
            return n ? {
                ratio: n.getAttribute('data-ratio'), rule: n.getAttribute('data-rule'), source: n.getAttribute('data-source'),
                mine: n.classList.contains('mine'), text: n.innerText.replace(/\s+/g, ' ').trim(),
                statsRule: st && st.getAttribute('data-rule'), sub: (document.querySelector('.PZ2QoL_kbProgSub') || {}).innerText || '',
                targets: [...document.querySelectorAll('.PZ2QoL_kbGroupTarget')].map(t => t.innerText),
            } : null;
        });
        facts.makeupAuto = await makeup();
        if (!facts.makeupAuto) problems.push('no group make-up control');
        else {
            if (facts.makeupAuto.ratio !== 'auto' || facts.makeupAuto.rule !== '1:*' || facts.makeupAuto.source !== 'mating') problems.push(`make-up auto: ${JSON.stringify(facts.makeupAuto)}`);
            if (!facts.makeupAuto.targets.length || !facts.makeupAuto.targets.every(t => /Make-up \d+ ♂ \d+ ♀/.test(t))) problems.push(`target lines: ${JSON.stringify(facts.makeupAuto.targets)}`);
        }
        await click(page.locator('.PZ2QoL_kbRatioArrow.next'));
        await page.waitForTimeout(100);
        await ready(page);
        facts.makeupPairs = await makeup();
        facts.makeupStored = await page.evaluate(async () => (await import('/js/mods/pz2qol/userstore.js')).getUserData('kinRatio'));
        await ctx.shot(page, 'kp_prog_3c_makeup_pairs');
        if (!facts.makeupPairs || facts.makeupPairs.ratio !== '1:1' || !facts.makeupPairs.mine || facts.makeupPairs.statsRule !== '1:1' || !/Pairs/.test(facts.makeupPairs.sub)) problems.push(`make-up 1:1: ${JSON.stringify(facts.makeupPairs)}`);
        if (!facts.makeupStored || facts.makeupStored.Gazelle !== '1:1') problems.push(`make-up not kept: ${JSON.stringify(facts.makeupStored)}`);
        facts.layoutMakeup = await layoutFacts(page);
        layoutProblems('make-up', facts.layoutMakeup, problems);
        await click(page.locator('.PZ2QoL_kbRatioArrow.prev'));
        await page.waitForTimeout(100);
        await ready(page);
        facts.makeupBack = await makeup();
        facts.makeupStoredBack = await page.evaluate(async () => (await import('/js/mods/pz2qol/userstore.js')).getUserData('kinRatio'));
        if (!facts.makeupBack || facts.makeupBack.ratio !== 'auto' || facts.makeupBack.rule !== '1:*') problems.push(`make-up back to auto: ${JSON.stringify(facts.makeupBack)}`);
        if (facts.makeupStoredBack && facts.makeupStoredBack.Gazelle) problems.push(`auto still stored: ${JSON.stringify(facts.makeupStoredBack)}`);
        const back = await stats(page);
        if (!back || back.moves !== facts.byStep[2].moves) problems.push(`back to auto gives ${back && back.moves} moves, expected ${facts.byStep[2].moves}`);

        // 3. Use this plan: the plan, its reasons, the board again
        const chosen = facts.byStep[2].moves;
        await click(page.locator('.PZ2QoL_kbProg .PZ2QoL_kpBtn', { hasText: 'Use this plan' }));
        await page.waitForTimeout(400);
        await ctx.shot(page, 'kp_prog_4_plan');
        facts.plan = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbMove')].map(n => ({ id: n.getAttribute('data-move'), text: n.innerText.replace(/\s+/g, ' ').trim() })));
        facts.boardBack = await page.locator('.PZ2QoL_kbCol').count();
        facts.impact = await page.evaluate(() => {
            const n = document.querySelector('.PZ2QoL_kbImpact');
            return n ? { afterRisk: +n.getAttribute('data-after-risk'), afterKin: +n.getAttribute('data-after-kin'), moves: +n.getAttribute('data-moves') } : null;
        });
        facts.layoutPlan = await layoutFacts(page);
        layoutProblems('plan', facts.layoutPlan, problems);
        if (facts.plan.length !== chosen) problems.push(`plan has ${facts.plan.length} moves, the programme ${chosen}`);
        if (!facts.plan.every(p => /Suggested: (breeds with|no place)/.test(p.text))) problems.push(`plan reasons: ${facts.plan.map(p => p.text)}`);
        if (!facts.boardBack) problems.push('the board did not come back after Use this plan');
        if (!facts.impact || facts.impact.afterRisk !== 0) problems.push(`gazelle risks after the plan: ${JSON.stringify(facts.impact)}`);

        // 4. Execute: the existing path, one move at a time
        await page.evaluate(() => { window.__kpg.moves.length = 0; });
        await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Execute plan' }));
        await page.waitForFunction(() => window.__kpgMoves.getPlanRun().finished === true && !window.__kpgMoves.getPlanRun().running, null, { timeout: 30000 });
        await page.waitForTimeout(300);
        facts.run = await page.evaluate(() => {
            const r = window.__kpgMoves.getPlanRun();
            return { done: r.done, total: r.total, error: r.error, moves: window.__kpg.moves.map(x => x.id), overlap: window.__kpg.overlap, starts: window.__kpg.moves.map(x => x.start) };
        });
        await ctx.shot(page, 'kp_prog_5_executed');
        if (facts.run.error || facts.run.done !== chosen) problems.push(`run: ${JSON.stringify(facts.run)}`);
        if (facts.run.moves.join() !== facts.plan.map(p => p.id).join()) problems.push('moves were not sent in plan order');
        if (facts.run.overlap) problems.push('two moves in flight at once');
        for (let i = 1; i < facts.run.starts.length; i++) if (facts.run.starts[i] - facts.run.starts[i - 1] < 1500) problems.push('moves less than 1.5 s apart');

        // 5. a species the game does not describe: estimates, said so
        await click(page.locator('.PZ2QoL_kbSpecies[data-species="Lion"]'));
        await page.waitForTimeout(300);
        await click(progBtn);
        await ready(page, 12000);
        await page.waitForTimeout(200);
        facts.noAnswer = { warnings: await page.locator('.PZ2QoL_kbProgWarn').allInnerTexts(), sub: await page.locator('.PZ2QoL_kbProgSub').innerText(), stats: await stats(page) };
        await ctx.shot(page, 'kp_prog_6_no_answer');
        facts.layoutNoAnswer = await layoutFacts(page);
        layoutProblems('no answer', facts.layoutNoAnswer, problems);
        if (!facts.noAnswer.warnings.some(w => /did not answer/.test(w))) problems.push(`no warning when the game does not answer: ${facts.noAnswer.warnings}`);
        if (!/Unknown: mixed groups/.test(facts.noAnswer.sub)) problems.push(`system without data: "${facts.noAnswer.sub}"`);
        if (!facts.noAnswer.stats || facts.noAnswer.stats.related[1] !== 0) problems.push(`lion programme keeps related pairs: ${JSON.stringify(facts.noAnswer.stats)}`);
        // Esc closes the preview first, then the board
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        facts.afterEsc = { prog: await page.locator('.PZ2QoL_kbProg').count(), cols: await page.locator('.PZ2QoL_kbCol').count() };
        if (facts.afterEsc.prog || !facts.afterEsc.cols) problems.push(`Esc did not close just the preview: ${JSON.stringify(facts.afterEsc)}`);
    }
    finally {
        await page.evaluate(async url => {
            if (window.__kpg) window.__kpg.active = false;
            (await import(url)).closeSpeciesBoard();
            const kin = await import('/js/mods/pz2qol/kin.js');
            kin.applyKinSnapshot(window.__kinFixture.snapshot);
        }, BOARD).catch(() => {});
    }
    if (problems.length) throw new Error('breeding programme: ' + problems.join('; '));
    return facts;
}
