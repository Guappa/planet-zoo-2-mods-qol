// Browser-harness scenario: pregnant animals in the breeding programme.
// A harem species (quaggas) on top of the kin fixture: in Quagga Flats the
// father Zuri lives with his pregnant daughter Nia and an unrelated Lulu; in
// Quagga Downs Baraka and Imani; in Quagga Hollow (room for one) the pregnant Penda alone.
// Checks: the programme never moves Nia or Penda (they stay, tagged
// "pregnant · stays"), Penda gets the contraception advice ("no male here"),
// one click on Contraception sends exactly one PZ2QoL_KinContracept and a
// second click while it waits sends nothing; Execute skips a pregnant move
// that came from a plan, and runs one the player planned by hand (the game
// allows moving her). Fake Lua handlers are gated by window.__kpp.active.
import { seedZooKin } from './kin_fixture.mjs';
import { layoutFacts, layoutProblems } from './kin_board.mjs';

export const name = 'programme_preg';

const BOARD = '/js/mods/pz2qol/kinboard.js';

async function click(locator) {
    try {
        await locator.first().click({ timeout: 2500 });
    }
    catch (e) {
        await locator.first().dispatchEvent('click');
    }
}

const ready = (page, timeout = 8000) => page.waitForSelector('.PZ2QoL_kbProg:not(.busy) .PZ2QoL_kbStats', { timeout });

async function seed(page) {
    await page.evaluate(async () => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const snap = JSON.parse(JSON.stringify(window.__kinFixture.snapshot));
        snap.mode = 'offline';
        snap.tradeCentre = { id: '501', name: 'Trade Centre' };
        snap.habitats.push(
            { id: '9030', name: 'Quagga Flats', kind: 'habitat' },
            { id: '9031', name: 'Quagga Downs', kind: 'habitat' },
            { id: '9032', name: 'Quagga Hollow', kind: 'habitat' });
        const genes = s => {
            const L = 'ABCDEFGH';
            const st = o => Array.from({ length: 6 }, (_, i) => L[(s * 5 + (i + o) * 3) % 8]).join('');
            return { F: st(0) + st(4), I: st(1) + st(7), S: st(2) + st(3), L: st(3) + st(6) };
        };
        const loc = { 9030: 'Quagga Flats', 9031: 'Quagga Downs', 9032: 'Quagga Hollow' };
        const add = (id, name, sex, hab, par = [], over = {}) => snap.animals.push(Object.assign({
            id, key: 'animal_' + id, guid: 'zb' + id, name, species: 'Quagga', sex, juv: false, contra: false, infertile: false, preg: false,
            hab, loc: loc[hab] || '', lt: 'habitat', par, mates: [], genes: genes(+id),
        }, over));
        add('7101', 'Zuri', 0, '9030');
        add('7102', 'Nia', 1, '9030', ['zb7101', 'zbMama'], { preg: true });
        add('7103', 'Lulu', 1, '9030');
        add('7104', 'Baraka', 0, '9031');
        add('7105', 'Imani', 1, '9031');
        add('7106', 'Penda', 1, '9032', [], { preg: true });
        snap.anc.zbMama = [];
        for (const a of snap.animals) if (!a.lt) a.lt = a.hab ? 'habitat' : 'other';
        window.__kppSnap = snap;
        kin.applyKinSnapshot(snap);
        window.__kppMoves = await import('/js/mods/pz2qol/kinmoves.js');
        const ok = { ok: true };
        const DEST = {
            bySpecies: { Quagga: { 9030: ok, 9031: ok, 9032: ok } },
            habitats: [],
            tradeCentre: { id: '501', name: 'Trade Centre' },
        };
        const table = Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (_, j) => Math.round(Math.max(0.1, (i + j) / 12) * 100) / 100));
        const INFO = {
            social: { min: 2, max: 4 },
            fertilityAges: { maturity: 0, infertility: 999 },
            mating: 'polygyny',
            conception: table,
            habitats: {
                9030: { available: { land: 4000 }, required: { land: 3000 }, adults: 3 },
                9031: { available: { land: 3000 }, required: { land: 2000 }, adults: 2 },
                9032: { available: { land: 1000 }, required: { land: 1000 }, adults: 1 },     // room for her alone: no male can join
            },
        };
        window.__kpp = { active: true, moves: [], contra: [] };
        if (engine.events) for (const n of ['PZ2QoL_KinDestinations', 'PZ2QoL_KinSpecies', 'PZ2QoL_KinMove', 'PZ2QoL_KinContracept']) engine.events[n] = [];
        engine.on('PZ2QoL_KinDestinations', reqId => {
            if (!window.__kpp.active) return;
            engine.trigger('PZ2QoL_KinDestinationsResult', reqId, JSON.stringify(DEST));
        });
        engine.on('PZ2QoL_KinSpecies', (reqId, species) => {
            if (!window.__kpp.active || String(species) !== 'Quagga') return;
            setTimeout(() => engine.trigger('PZ2QoL_KinSpeciesResult', reqId, JSON.stringify(INFO)), 300);
        });
        engine.on('PZ2QoL_KinMove', (reqId, id, to) => {
            const k = window.__kpp;
            if (!k.active) return;
            k.moves.push([String(id), String(to)]);
            engine.trigger('PZ2QoL_KinMoveResult', reqId, true, '');
            setTimeout(() => {
                const a = window.__kppSnap.animals.find(x => String(x.id) === String(id));
                if (a) a.moving = true;
                window.__kppSnap.seq++;
                kin.applyKinSnapshot(JSON.parse(JSON.stringify(window.__kppSnap)));
            }, 250);
        });
        // the game's contraception: recorded only (the page then waits for a scan)
        engine.on('PZ2QoL_KinContracept', (id, on) => {
            if (!window.__kpp.active) return;
            window.__kpp.contra.push([String(id), on]);
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
    await seed(page);
    const progBtn = page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Breeding programme' });
    try {
        await page.evaluate(async url => (await import(url)).openSpeciesBoard({ species: 'Quagga' }), BOARD);
        await page.waitForSelector('.PZ2QoL_kb:not(.hidden) .PZ2QoL_kbCol[data-col="9030"]', { timeout: 4000 });
        await page.waitForTimeout(400);
        // the board card says she stays
        facts.cardTag = await page.evaluate(() => {
            const card = document.querySelector('.PZ2QoL_kbCard[data-id="7102"]') || [...document.querySelectorAll('[data-id="7102"]')][0];
            const tag = card && card.querySelector('.PZ2QoL_kbTag.preg');
            return tag ? { text: tag.innerText, title: tag.title } : null;
        });
        if (!facts.cardTag || !/plans never move her/.test(facts.cardTag.title)) problems.push(`board card tag: ${JSON.stringify(facts.cardTag)}`);

        // 1. the programme: Nia and Penda stay, Penda gets the advice
        await click(progBtn);
        await ready(page);
        await page.waitForTimeout(300);
        await ctx.shot(page, 'kpp_1_programme');
        facts.prog = await page.evaluate(() => ({
            moves: +(document.querySelector('.PZ2QoL_kbStats') || { getAttribute: () => -1 }).getAttribute('data-moves'),
            stays: [...document.querySelectorAll('.PZ2QoL_kbGroupAnimal .PZ2QoL_kbTag.preg')].map(t => t.closest('.PZ2QoL_kbGroupAnimal').getAttribute('data-id')),
            incoming: [...document.querySelectorAll('.PZ2QoL_kbGroupAnimal.in')].map(n => n.getAttribute('data-id')),
            leaving: [...document.querySelectorAll('.PZ2QoL_kbGroupAnimal.out')].map(n => n.innerText),
            advice: [...document.querySelectorAll('.PZ2QoL_kbContra')].map(n => ({ id: n.getAttribute('data-id'), kind: n.getAttribute('data-kind'), text: n.innerText.replace(/\s+/g, ' ').trim(), hab: n.closest('.PZ2QoL_kbGroup').getAttribute('data-hab') })),
        }));
        facts.layoutProg = await layoutFacts(page);
        layoutProblems('programme', facts.layoutProg, problems);
        const p = facts.prog;
        if (!p.stays.includes('7102') || !p.stays.includes('7106')) problems.push(`pregnant not tagged as staying: ${JSON.stringify(p.stays)}`);
        if (p.incoming.includes('7102') || p.incoming.includes('7106') || p.leaving.some(t => /Nia|Penda/.test(t))) problems.push(`a pregnant female moves: ${JSON.stringify(p)}`);
        const penda = p.advice.find(a => a.id === '7106');
        if (!penda || penda.kind !== 'nomate' || penda.hab !== '9032' || !/Contraception after birth: no male here/.test(penda.text)) problems.push(`Penda's advice: ${JSON.stringify(p.advice)}`);

        // 2. one click, one game action; a second click while it waits sends nothing
        await click(page.locator('.PZ2QoL_kbContra[data-id="7106"] .PZ2QoL_kbContraBtn'));
        await page.waitForTimeout(250);
        await click(page.locator('.PZ2QoL_kbContra[data-id="7106"] .PZ2QoL_kbContraBtn'));
        await page.waitForTimeout(250);
        facts.contra = await page.evaluate(() => window.__kpp.contra.slice());
        facts.contraBtn = await page.evaluate(() => { const b = document.querySelector('.PZ2QoL_kbContra[data-id="7106"] .PZ2QoL_kbContraBtn'); return b ? { text: b.innerText, disabled: b.classList.contains('disabled') } : null; });
        await ctx.shot(page, 'kpp_2_contra_clicked');
        if (facts.contra.length !== 1 || facts.contra[0][0] !== '7106' || facts.contra[0][1] !== true) problems.push(`contraception events: ${JSON.stringify(facts.contra)}`);
        if (!facts.contraBtn || !facts.contraBtn.disabled) problems.push(`contraception button while waiting: ${JSON.stringify(facts.contraBtn)}`);
        // the game's answer: the next scan shows her on contraception, the advice goes
        await page.evaluate(async () => {
            const kin = await import('/js/mods/pz2qol/kin.js');
            window.__kppSnap.animals.find(a => a.id === '7106').contra = true;
            window.__kppSnap.seq++;
            kin.applyKinSnapshot(JSON.parse(JSON.stringify(window.__kppSnap)));
        });
        await page.waitForTimeout(400);
        await ready(page);
        await page.waitForTimeout(200);
        facts.adviceAfter = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbContra')].map(n => n.getAttribute('data-id')));
        if (facts.adviceAfter.includes('7106')) problems.push('the advice stays after contraception');

        // 3. Use this plan: no pregnant move in it
        await click(page.locator('.PZ2QoL_kbProg .PZ2QoL_kpBtn', { hasText: 'Use this plan' }));
        await page.waitForTimeout(400);
        facts.plan = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbMove')].map(n => n.getAttribute('data-move')));
        if (facts.plan.includes('7102') || facts.plan.includes('7106')) problems.push(`the plan moves a pregnant female: ${JSON.stringify(facts.plan)}`);

        // 4. Execute: a pregnant move from a plan is skipped with the reason;
        //    one the player planned by hand runs (the game allows it)
        await page.evaluate(() => { window.__kpp.moves.length = 0; });
        const runOne = byPlayer => page.evaluate(async bp => {
            const r = await window.__kppMoves.runPlan([bp ? { id: '7102', to: '9031', byPlayer: true } : { id: '7102', to: '9031' }], {});
            const st = window.__kppMoves.getPlanRun();
            return { ok: r.ok, detail: r.detail, log: st.log.map(l => l.detail || 'ok'), sent: window.__kpp.moves.slice() };
        }, byPlayer);
        facts.runPlanned = await runOne(false);
        if (facts.runPlanned.sent.length || !facts.runPlanned.log.some(l => /skipped: pregnant/.test(l))) problems.push(`a pregnant move from a plan ran: ${JSON.stringify(facts.runPlanned)}`);
        facts.runByHand = await runOne(true);
        if (facts.runByHand.sent.length !== 1 || facts.runByHand.sent[0][0] !== '7102') problems.push(`a pregnant move planned by hand did not run: ${JSON.stringify(facts.runByHand)}`);
        await page.waitForTimeout(400);
        await ctx.shot(page, 'kpp_3_board_after');
    }
    finally {
        await page.evaluate(async url => {
            if (window.__kpp) window.__kpp.active = false;
            (await import(url)).closeSpeciesBoard();
            const kin = await import('/js/mods/pz2qol/kin.js');
            kin.applyKinSnapshot(window.__kinFixture.snapshot);
        }, BOARD).catch(() => {});
    }
    if (problems.length) throw new Error('pregnant in the programme: ' + problems.join('; '));
    return facts;
}
