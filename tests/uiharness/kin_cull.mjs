// Browser-harness scenario: Thin out on the Species board.
// Five lemur habitats of 12 animals each (adults + young), polygyny, social
// maximum 8. Two are over their room: Lemur Grove (room 6, 9 adults: 3 males
// and 2 elderly infertile females) and Lemur Ridge (room 6, 10 adults).
// Fakes the Lua side (species facts, destinations, moves; guarded by
// window.__kc.active, earlier fakes cleared). Checks: preview numbers, the
// old ones and the extra males leave, the best stays, the fill control,
// click to keep / send away, "Too old" from habitats that are not full,
// a 0% fertility gene leaves a habitat with room (and its switch), the
// poor-gene levels and Core only send more away,
// "Send N to the trade centre" fills the plan, Execute sends them to the
// trade centre one at a time.
import { seedZooKin } from './kin_fixture.mjs';
import { layoutFacts, layoutProblems } from './kin_board.mjs';

export const name = 'cull';

const BOARD = '/js/mods/pz2qol/kinboard.js';

async function click(locator) {
    try {
        await locator.first().click({ timeout: 2500 });
    }
    catch (e) {
        await locator.first().dispatchEvent('click');
    }
}

const preview = page => page.evaluate(() => {
    const box = document.querySelector('.PZ2QoL_kbCull .PZ2QoL_kbStats');
    if (!box) return null;
    const out = { moves: +box.getAttribute('data-moves') };
    for (const n of box.querySelectorAll('.PZ2QoL_kbStat[data-key]')) {
        const k = n.getAttribute('data-key');
        if (k === 'moves') continue;
        out[k] = [n.getAttribute('data-before'), n.getAttribute('data-after')].map(v => (v === '' ? null : +v));
    }
    out.habs = [...document.querySelectorAll('.PZ2QoL_kbCullHab')].map(c => c.getAttribute('data-hab'));
    out.rows = {};
    for (const r of document.querySelectorAll('.PZ2QoL_kbCullRow')) out.rows[r.getAttribute('data-id')] = { state: r.getAttribute('data-state'), why: r.getAttribute('data-why') };
    return out;
});

async function seedLemurs(page) {
    await page.evaluate(async () => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const snap = JSON.parse(JSON.stringify(window.__kinFixture.snapshot));
        snap.mode = 'offline';
        snap.tradeCentre = { id: '501', name: 'Trade Centre' };
        const habs = [['9030', 'Lemur Grove'], ['9031', 'Lemur Ridge'], ['9032', 'Lemur Valley'], ['9033', 'Lemur Woods'], ['9034', 'Lemur Rocks']];
        for (const [id, name] of habs) snap.habitats.push({ id, name, kind: 'habitat' });
        const nameOf = Object.fromEntries(habs);
        const L = 'CDEFGH';
        const genes = s => {
            const st = o => Array.from({ length: 6 }, (_, i) => L[(s * 5 + (i + o) * 3) % 6]).join('');
            // the second strand differs from the first at k loci: fertility k/6
            // (1..6, never 0 by accident), immunity 2..5 of 6
            const vary = (x, k) => x.split('').map((c, i) => (i < k ? L[(L.indexOf(c) + 1) % 6] : c)).join('');
            return { F: st(0) + vary(st(0), 1 + (s * 7) % 6), I: st(1) + vary(st(1), 2 + (s * 5) % 4), S: 'AACCCC' + st(2), L: 'ACCCCC' + st(3) };
        };
        const best = { F: 'ABCDEFBCDEFA', I: 'ABCDEFBCDEFA', S: 'AABBAABBAABB', L: 'AABBAABBAABB' };
        let n = 0;
        const add = (hab, name, sex, extra = {}) => {
            n++;
            const id = String(6000 + n);
            snap.animals.push(Object.assign({
                id, key: 'animal_' + id, guid: 'lm' + id, name, species: 'Lemur', sex, juv: false, contra: false, infertile: false, preg: false,
                hab, loc: nameOf[hab], lt: 'habitat', par: [], mates: [], genes: genes(n), age: 5, ageQ: 2,
            }, extra));
            return id;
        };
        const young = (hab, k) => {
            for (let i = 0; i < k; i++) add(hab, `Kid ${hab.slice(-1)}${i + 1}`, i % 2, { juv: true, infertile: true, age: 1, ageQ: 1 });
        };
        const ids = {};
        // Lemur Grove: room 6, 9 adults (3 males, 2 elderly infertile females), 3 young
        ids.best = add('9030', 'Rafiki', 0, { genes: best });
        ids.male2 = add('9030', 'Kaka', 0);
        ids.male3 = add('9030', 'Tatu', 0);
        ids.old1 = add('9030', 'Bibi', 1, { age: 18, ageQ: 3, infertile: true });
        ids.old2 = add('9030', 'Nyanya', 1, { age: 19, ageQ: 3, infertile: true });
        ids.zuri = add('9030', 'Zuri', 1);
        for (const nm of ['Ama', 'Penda', 'Lulu']) add('9030', nm, 1);
        young('9030', 3);
        // Lemur Ridge: room 6, 10 adults, 2 young
        add('9031', 'Jengo', 0);
        for (let i = 1; i <= 9; i++) add('9031', `Ridge ${i}`, 1);
        young('9031', 2);
        // Lemur Valley: room 8, 6 adults (one elderly), 6 young
        add('9032', 'Moto', 0);
        ids.oldValley = add('9032', 'Mzee', 1, { age: 17, ageQ: 3, infertile: true });
        for (let i = 1; i <= 3; i++) add('9032', `Valley ${i}`, 1);
        // 0% fertility gene (both strands the same), in a habitat with room
        ids.zeroFert = add('9032', 'Tasa', 1, { genes: { F: 'CDEFGHCDEFGH', I: 'ABCDEFBCDEFA', S: 'AABBAABBAABB', L: 'AABBAABBAABB' } });
        young('9032', 6);
        // Lemur Woods: room 8, 8 adults, 4 young
        add('9033', 'Shujaa', 0);
        for (let i = 1; i <= 7; i++) add('9033', `Woods ${i}`, 1);
        young('9033', 4);
        // Lemur Rocks: room 8, 7 adults, 5 young
        add('9034', 'Baraka', 0);
        for (let i = 1; i <= 6; i++) add('9034', `Rocks ${i}`, 1);
        young('9034', 5);
        snap.speciesFacts = Object.assign({}, snap.speciesFacts, { Lemur: { maturity: 2, infertility: 15, life: 25 } });
        for (const a of snap.animals) if (!a.lt) a.lt = a.hab ? 'habitat' : 'other';
        window.__kcSnap = snap;
        window.__kcIds = ids;
        kin.applyKinSnapshot(snap);
        window.__kcMoves = await import('/js/mods/pz2qol/kinmoves.js');
        const ok = { ok: true };
        const DEST = { bySpecies: { Lemur: Object.fromEntries(habs.map(([id]) => [id, ok])) }, habitats: [], tradeCentre: { id: '501', name: 'Trade Centre' } };
        // 500 land per animal (the game's requirement covers the young too):
        // Grove and Ridge have room for 6 adults, the rest 10 (social max 8)
        const adults = { 9030: 9, 9031: 10, 9032: 6, 9033: 8, 9034: 7 };
        const youngIn = { 9030: 3, 9031: 2, 9032: 6, 9033: 4, 9034: 5 };
        const INFO = {
            social: { min: 2, max: 8 },
            fertilityAges: { maturity: 2, infertility: 15 },
            mating: 'polygyny',
            habitats: Object.fromEntries(habs.map(([id]) => [id, {
                available: { land: id === '9030' || id === '9031' ? 3000 : 5000 },
                required: { land: 500 * (adults[id] + youngIn[id]) },
                adults: adults[id],
            }])),
        };
        window.__kc = { active: true, species: 0, moves: [], inFlight: false, overlap: false };
        if (engine.events) for (const nm of ['PZ2QoL_KinDestinations', 'PZ2QoL_KinSpecies', 'PZ2QoL_KinMove']) engine.events[nm] = [];
        engine.on('PZ2QoL_KinDestinations', reqId => window.__kc.active && engine.trigger('PZ2QoL_KinDestinationsResult', reqId, JSON.stringify(DEST)));
        engine.on('PZ2QoL_KinSpecies', reqId => {
            if (!window.__kc.active) return;
            window.__kc.species++;
            setTimeout(() => engine.trigger('PZ2QoL_KinSpeciesResult', reqId, JSON.stringify(INFO)), 400);
        });
        engine.on('PZ2QoL_KinMove', (reqId, id, to) => {
            const k = window.__kc;
            if (!k.active) return;
            const rec = { id: String(id), to: String(to), start: Date.now(), end: null };
            if (k.inFlight) k.overlap = true;
            k.moves.push(rec);
            k.inFlight = true;
            engine.trigger('PZ2QoL_KinMoveResult', reqId, true, '');
            setTimeout(() => {
                const a = window.__kcSnap.animals.find(x => String(x.id) === String(id));
                if (a) a.moving = true;
                window.__kcSnap.seq++;
                kin.applyKinSnapshot(JSON.parse(JSON.stringify(window.__kcSnap)));
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
    await seedLemurs(page);
    const ids = await page.evaluate(() => window.__kcIds);
    const thinOut = page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Thin out' });
    const row = id => page.locator(`.PZ2QoL_kbCullRow[data-id="${id}"]`);

    try {
        await page.evaluate(async url => (await import(url)).openSpeciesBoard({ species: 'Lemur' }), BOARD);
        await page.waitForSelector('.PZ2QoL_kb:not(.hidden) .PZ2QoL_kbCol[data-col="9030"]', { timeout: 4000 });
        await page.waitForTimeout(300);

        // 1. ask the game, then the preview
        await click(thinOut);
        await page.waitForTimeout(150);
        facts.loading = await page.locator('.PZ2QoL_kbCull.state_loading').count();
        await page.waitForSelector('.PZ2QoL_kbCull .PZ2QoL_kbStats', { timeout: 6000 });
        await page.waitForTimeout(400);
        await ctx.shot(page, 'kc_1_preview');
        const p = await preview(page);
        facts.balanced = { moves: p.moves, animals: p.animals, adults: p.adults, gene: p.gene, old: p.old, habs: p.habs };
        facts.grove = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, p.rows[id]]));
        facts.sub = await page.locator('.PZ2QoL_kbCull .PZ2QoL_kbProgSub').innerText();
        facts.hint = await page.locator('.PZ2QoL_kbCullHint').innerText();
        facts.warnings = await page.locator('.PZ2QoL_kbCull .PZ2QoL_kbProgWarn').allInnerTexts();
        facts.groveCap = await page.locator('.PZ2QoL_kbCullHab[data-hab="9030"] .PZ2QoL_kbGroupCap').innerText();
        facts.rail = await page.locator('.PZ2QoL_kbSpecies[data-species="Lemur"] .PZ2QoL_kbSpeciesMeta').innerText();
        facts.layoutPreview = await layoutFacts(page);
        layoutProblems('preview', facts.layoutPreview, problems);
        if (facts.loading !== 1) problems.push('no "Asking the game" state');
        facts.zeroFert = { row: p.rows[ids.zeroFert], tile: p.zeroFert };
        if (!facts.zeroFert.row || facts.zeroFert.row.state !== 'cull' || !/0% fertility/.test(facts.zeroFert.row.why)) problems.push(`0% fertility gene: ${JSON.stringify(facts.zeroFert)}`);
        if (!p.zeroFert || p.zeroFert[0] !== 1 || p.zeroFert[1] !== 0) problems.push(`0% fertility tile: ${p.zeroFert}`);
        if (!(p.moves >= 6)) problems.push(`only ${p.moves} to the trade centre`);
        if (p.animals[0] !== 60 || p.animals[1] !== 60 - p.moves) problems.push(`animals ${p.animals} with ${p.moves} leaving`);
        if (p.old[0] !== 3 || p.old[1] !== 1) problems.push(`too-old ${p.old}: expected 3 → 1 (the one in a habitat with room stays)`);
        if (!(p.gene[1] >= p.gene[0])) problems.push(`average genes fall: ${p.gene}`);
        if (p.habs.length !== 5 || p.habs[0] !== '9031') problems.push(`cards not most over-full first: ${p.habs}`);
        const g = facts.grove;
        if (!g.old1 || g.old1.state !== 'cull' || !/too old/.test(g.old1.why) || g.old2.state !== 'cull') problems.push(`elderly animals: ${JSON.stringify([g.old1, g.old2])}`);
        if (g.male2.state !== 'cull' || g.male3.state !== 'cull' || !/extra male/.test(g.male2.why + g.male3.why)) problems.push(`extra males: ${JSON.stringify([g.male2, g.male3])}`);
        if (g.best.state !== 'keep') problems.push('the best male would leave');
        if (!/9 adults · room for 6 → keep 5/.test(facts.groveCap)) problems.push(`Grove line: "${facts.groveCap}"`);
        if (facts.warnings.length) problems.push(`warnings with full data: ${facts.warnings}`);
        if (!/sell them/.test(facts.hint)) problems.push('no hint about selling from the trade centre');
        if (!/over/.test(facts.rail)) problems.push(`the rail does not say how many are over: "${facts.rail}"`);

        // 2. the fill level recomputes
        facts.fill = {};
        for (const f of ['core', 'strict', 'lean', 'full', 'balanced']) {
            await click(page.locator(`.PZ2QoL_kbCull .PZ2QoL_kbSegItem[data-fill="${f}"]`));
            await page.waitForTimeout(200);
            facts.fill[f] = (await preview(page)).moves;
            if (f === 'lean') await ctx.shot(page, 'kc_2_lean');
        }
        if (!(facts.fill.core > facts.fill.strict && facts.fill.strict > facts.fill.lean && facts.fill.lean > facts.fill.balanced && facts.fill.balanced > facts.fill.full)) problems.push(`fill does not change the count: ${JSON.stringify(facts.fill)}`);

        // 3. click to send away / keep
        await click(row(ids.zuri));
        await page.waitForTimeout(200);
        const t1 = await preview(page);
        await click(row(ids.male2));
        await page.waitForTimeout(200);
        const t2 = await preview(page);
        await ctx.shot(page, 'kc_3_toggled');
        facts.toggles = { zuri: t1.rows[ids.zuri], movesAfterZuri: t1.moves, kaka: t2.rows[ids.male2], movesAfterKaka: t2.moves };
        if (facts.toggles.zuri.state !== 'cull' || facts.toggles.zuri.why !== 'your choice') problems.push(`clicking a kept animal: ${JSON.stringify(facts.toggles.zuri)}`);
        if (facts.toggles.kaka.state !== 'keep' || facts.toggles.kaka.why !== 'your choice') problems.push(`clicking a leaving animal: ${JSON.stringify(facts.toggles.kaka)}`);
        // undo both
        await click(row(ids.zuri));
        await page.waitForTimeout(150);
        await click(row(ids.male2));
        await page.waitForTimeout(150);
        if ((await preview(page)).moves !== facts.fill.balanced) problems.push('toggling twice does not restore the plan');

        // 3b. the 0% fertility switch, then the poor-gene levels
        const zeroSw = page.locator('.PZ2QoL_kbCull .PZ2QoL_kpSwitch[data-opt="zeroFertility"]');
        await click(zeroSw);
        await page.waitForTimeout(200);
        const z = await preview(page);
        facts.zeroOff = { row: z.rows[ids.zeroFert], moves: z.moves };
        if (z.rows[ids.zeroFert].state !== 'keep' || z.moves !== facts.fill.balanced - 1) problems.push(`0% fertility switch off: ${JSON.stringify(facts.zeroOff)}`);
        await click(zeroSw);
        await page.waitForTimeout(150);
        facts.genes = {};
        for (const g of ['weak', 'below', 'best', 'off']) {
            await click(page.locator(`.PZ2QoL_kbCull .PZ2QoL_kbSegItem[data-genes="${g}"]`));
            await page.waitForTimeout(200);
            const q = await preview(page);
            facts.genes[g] = { moves: q.moves, gene: q.gene };
            if (g === 'best') await ctx.shot(page, 'kc_3b_best_only');
        }
        const gl = facts.genes;
        if (!(gl.best.moves >= gl.below.moves && gl.below.moves > gl.weak.moves && gl.weak.moves > gl.off.moves && gl.off.moves === facts.fill.balanced)) problems.push(`poor-gene levels: ${JSON.stringify(gl)}`);
        if (!(gl.best.gene[1] >= gl.below.gene[1])) problems.push(`best only does not raise the genes: ${JSON.stringify(gl)}`);

        // 4. too old from a habitat with room
        await click(page.locator('.PZ2QoL_kbCull .PZ2QoL_kpSwitch[data-opt="oldAlways"]'));
        await page.waitForTimeout(200);
        const o = await preview(page);
        facts.oldAlways = { mzee: o.rows[ids.oldValley], moves: o.moves, old: o.old };
        if (facts.oldAlways.mzee.state !== 'cull' || o.old[1] !== 0) problems.push(`"also too-old animals": ${JSON.stringify(facts.oldAlways)}`);
        await click(page.locator('.PZ2QoL_kbCull .PZ2QoL_kpSwitch[data-opt="oldAlways"]'));
        await page.waitForTimeout(150);

        // 5. a shorter list for the run: Full, then send
        await click(page.locator('.PZ2QoL_kbCull .PZ2QoL_kbSegItem[data-fill="full"]'));
        await page.waitForTimeout(200);
        const sendN = (await preview(page)).moves;
        await click(page.locator('.PZ2QoL_kbCull .PZ2QoL_kpBtn', { hasText: /^Send \d+ to the trade centre/ }));
        await page.waitForTimeout(400);
        await ctx.shot(page, 'kc_4_plan');
        facts.plan = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbMove')].map(n => ({ id: n.getAttribute('data-move'), text: n.innerText.replace(/\s+/g, ' ').trim() })));
        facts.layoutPlan = await layoutFacts(page);
        layoutProblems('plan', facts.layoutPlan, problems);
        if (facts.plan.length !== sendN) problems.push(`plan has ${facts.plan.length} moves, Thin out sent ${sendN}`);
        if (!facts.plan.every(x => /Trade Centre/.test(x.text) && /Suggested: Thin out: /.test(x.text))) problems.push(`plan rows: ${facts.plan.map(x => x.text).slice(0, 3)}`);
        if (await page.locator('.PZ2QoL_kbCull').count()) problems.push('the preview stayed open');

        // 6. Execute: one move at a time, to the trade centre
        await page.evaluate(() => { window.__kc.moves.length = 0; });
        await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Execute plan' }));
        await page.waitForTimeout(800);
        await ctx.shot(page, 'kc_5_running');
        await page.waitForFunction(() => window.__kcMoves.getPlanRun().finished === true && !window.__kcMoves.getPlanRun().running, null, { timeout: 60000 });
        facts.run = await page.evaluate(() => {
            const r = window.__kcMoves.getPlanRun();
            return { done: r.done, error: r.error, moves: window.__kc.moves.map(m => [m.id, m.to]), starts: window.__kc.moves.map(m => m.start), overlap: window.__kc.overlap };
        });
        if (facts.run.error || facts.run.done !== sendN) problems.push(`run: done ${facts.run.done} of ${sendN}, ${facts.run.error}`);
        if (!facts.run.moves.every(m => m[1] === 'trade:501' || m[1] === 'tradeq:501')) problems.push(`targets: ${facts.run.moves.map(m => m[1])}`);
        if (facts.run.moves.map(m => m[0]).join() !== facts.plan.map(x => x.id).join()) problems.push('not sent in plan order');
        if (facts.run.overlap) problems.push('two moves in flight at once');
        for (let i = 1; i < facts.run.starts.length; i++) if (facts.run.starts[i] - facts.run.starts[i - 1] < 450) problems.push('moves less than the 0.5 s pause apart');

        // 7. Esc closes a preview first
        await click(thinOut);
        await page.waitForSelector('.PZ2QoL_kbCull .PZ2QoL_kbStats', { timeout: 6000 });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        facts.afterEsc = { cull: await page.locator('.PZ2QoL_kbCull').count(), cols: await page.locator('.PZ2QoL_kbCol').count() };
        if (facts.afterEsc.cull || !facts.afterEsc.cols) problems.push(`Esc: ${JSON.stringify(facts.afterEsc)}`);
    }
    finally {
        await page.evaluate(async url => {
            if (window.__kc) window.__kc.active = false;
            (await import(url)).closeSpeciesBoard();
            const kin = await import('/js/mods/pz2qol/kin.js');
            kin.applyKinSnapshot(window.__kinFixture.snapshot);
        }, BOARD).catch(() => {});
    }
    if (problems.length) throw new Error('thin out: ' + problems.join('; '));
    return facts;
}
