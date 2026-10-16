// Browser-harness scenario: the Species board (kinboard.js).
// Runs on the in-park HUD page. Extends the kin fixture with a second lion
// habitat, an empty suitable one, an unsuitable one, the trade centre, a
// lion in transit and another species sharing a habitat, and fakes the Lua
// side of moves (PZ2QoL_KinDestinations / PZ2QoL_KinMove), including one
// refusal. Walks: species rail -> columns -> hover relatives -> drag to plan
// -> refused drop -> select + "Move N here" -> Suggest fixes -> Execute (one
// move at a time, stops at the refusal) -> Franchise block -> Move now -> Esc.
import { seedZooKin } from './kin_fixture.mjs';

export const name = 'board';

const BOARD = '/js/mods/pz2qol/kinboard.js';

async function click(locator) {
    try {
        await locator.first().click({ timeout: 2500 });
    }
    catch (e) {
        await locator.first().dispatchEvent('click');
    }
}

async function centre(locator) {
    const b = await locator.first().boundingBox();
    if (!b) throw new Error('not on screen');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// Pointer drag from one element to another (the board's own mouse drag).
async function drag(page, from, to) {
    const a = await centre(from);
    const b = await centre(to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 12, a.y + 6, { steps: 3 });
    await page.mouse.move(b.x, b.y, { steps: 14 });
    await page.waitForTimeout(150);
    return {
        up: async () => {
            await page.mouse.up();
            await page.waitForTimeout(300);
        },
    };
}

const text = (page, sel) => page.evaluate(s => {
    const n = document.querySelector(s);
    return n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
}, sel);

const impact = page => page.evaluate(() => {
    const n = document.querySelector('.PZ2QoL_kbImpact');
    if (!n) return null;
    const g = k => n.getAttribute(k);
    return { moves: +g('data-moves'), fixed: +g('data-fixed'), created: +g('data-created'), afterRisk: +g('data-after-risk'), afterKin: +g('data-after-kin'), text: n.innerText.replace(/\s+/g, ' ').trim() };
});

const planIds = page => page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbMove')].map(n => n.getAttribute('data-move')));

export const layoutFacts = page => page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const out = { outside: [], overlaps: [], textOverflow: [], spill: [] };
    const roots = [...document.querySelectorAll('.PZ2QoL_kb, .PZ2QoL_kbDrag')].filter(r => r.getBoundingClientRect().width > 0);
    const clipped = el => {
        const r = el.getBoundingClientRect();
        let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
                const q = n.getBoundingClientRect();
                x0 = Math.max(x0, q.left);
                y0 = Math.max(y0, q.top);
                x1 = Math.min(x1, q.right);
                y1 = Math.min(y1, q.bottom);
            }
        }
        return { x0, y0, x1, y1 };
    };
    for (const root of roots) {
        for (const el of [root, ...root.querySelectorAll('*')]) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const c = clipped(el);
            if (c.x1 <= c.x0 || c.y1 <= c.y0) continue;
            if (c.x0 < -0.5 || c.y0 < -0.5 || c.x1 > vw + 0.5 || c.y1 > vh + 0.5) out.outside.push(`${el.className} [${Math.round(c.x0)},${Math.round(c.y0)}..${Math.round(c.x1)},${Math.round(c.y1)}]`);
        }
    }
    const rect = el => el.getBoundingClientRect();
    const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    // spacers and popovers (the card menu floats over the board on purpose)
    const flex = e => !e.classList.contains('PZ2QoL_kpFlex') && !e.classList.contains('PZ2QoL_kbMenu');
    // nothing may spill out of these boxes (their overflow is visible)
    for (const box of document.querySelectorAll('.PZ2QoL_kbActions, .PZ2QoL_kbPlanList, .PZ2QoL_kbImpact, .PZ2QoL_kbPlan, .PZ2QoL_kbColHead, .PZ2QoL_kbCard, .PZ2QoL_kbSpecies, .PZ2QoL_kbMenu')) {
        const br = box.getBoundingClientRect();
        if (!br.width || !br.height) continue;
        for (const el of box.querySelectorAll('*')) {
            const cs = getComputedStyle(el);
            if (cs.position === 'absolute' || cs.position === 'fixed') continue;
            const c = clipped(el);
            if (c.x1 <= c.x0 || c.y1 <= c.y0) continue;
            if (c.x0 < br.left - 1 || c.y0 < br.top - 1 || c.x1 > br.right + 1 || c.y1 > br.bottom + 1) {
                out.spill.push(`${el.className || el.tagName} spills out of ${box.className}`);
                break;
            }
        }
    }
    const groups = ['.PZ2QoL_kb > *', '.PZ2QoL_kb .PZ2QoL_kpHead > *', '.PZ2QoL_kb .PZ2QoL_kpFoot > *', '.PZ2QoL_kbPlan > *', '.PZ2QoL_kbBody > *', '.PZ2QoL_kb .PZ2QoL_kpMainHead > *', '.PZ2QoL_kbColRow > *', '.PZ2QoL_kbActRow > *']
        .map(s => [...document.querySelectorAll(s)].filter(flex));
    for (const g of groups) {
        for (let i = 0; i < g.length; i++) {
            for (let j = i + 1; j < g.length; j++) {
                if (rect(g[i]).width && rect(g[j]).width && hit(rect(g[i]), rect(g[j]))) out.overlaps.push(`${g[i].className} x ${g[j].className}`);
            }
        }
    }
    for (const el of document.querySelectorAll('.PZ2QoL_kb .PZ2QoL_kpBtn, .PZ2QoL_kbMoveHere, .PZ2QoL_kbMenuItem, .PZ2QoL_kbMini, .PZ2QoL_kb .PZ2QoL_kpTitle')) {
        if (el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 1) out.textOverflow.push(`${el.className}: ${el.innerText.trim().slice(0, 40)}`);
    }
    return out;
});

export function layoutProblems(tag, l, problems) {
    if (l.outside.length) problems.push(`${tag}: ${l.outside.length} element(s) outside the view, e.g. ${l.outside.slice(0, 3).join('; ')}`);
    if (l.overlaps.length) problems.push(`${tag}: overlapping ${l.overlaps.slice(0, 3).join('; ')}`);
    if (l.textOverflow.length) problems.push(`${tag}: text overflows ${l.textOverflow.slice(0, 3).join('; ')}`);
    if (l.spill.length) problems.push(`${tag}: ${l.spill.slice(0, 3).join('; ')}`);
}

// The fixture plus what the board needs; the fake Lua side for moves.
async function seedBoard(page) {
    await page.evaluate(async () => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const snap = JSON.parse(JSON.stringify(window.__kinFixture.snapshot));
        snap.mode = 'offline';
        snap.tradeCentre = { id: '501', name: 'Trade Centre' };
        snap.habitats.push({ id: '9003', name: 'Plains Habitat', kind: 'habitat' }, { id: '9004', name: 'Grassland Habitat', kind: 'habitat' });
        const genes = s => {
            const L = 'ABCDEFGH';
            const st = o => Array.from({ length: 6 }, (_, i) => L[(s * 5 + (i + o) * 3) % 8]).join('');
            return { F: st(0) + st(4), I: st(1) + st(7), S: st(2) + st(3), L: st(3) + st(6) };
        };
        const add = (id, name, species, sex, hab, extra = {}) => snap.animals.push(Object.assign({
            id, key: 'animal_' + id, guid: 'gx' + id, name, species, sex, juv: false, contra: false, infertile: false, preg: false,
            hab, loc: hab === '9003' ? 'Plains Habitat' : hab === '9001' ? 'Jungle Habitat' : '', par: [], mates: [], genes: genes(+id),
        }, extra));
        add('8001', 'Bako', 'Lion', 0, '9003');
        add('8002', 'Nala', 'Lion', 1, '9003');
        add('8003', 'Tamu', 'Lion', 0, '9003');
        add('8004', 'Imara', 'Lion', 1, '9003', { preg: true });
        add('8010', 'Oskar', 'Ostrich', 0, '9003');
        add('8020', 'Sefu', 'Lion', 0, '', { lt: 'transit' });
        add('8021', 'Zawadi', 'Lion', 1, '', { lt: 'trade', loc: 'Trade Centre' });
        add('8022', 'Kesi', 'Lion', 1, '9001');
        for (const a of snap.animals) if (!a.lt) a.lt = a.hab ? 'habitat' : 'other';
        window.__kbSnap = snap;
        kin.applyKinSnapshot(snap);
        const ok = { ok: true };
        const DEST = {
            bySpecies: {
                Lion: { 9000: ok, 9003: ok, 9004: ok, 9001: { ok: false, reason: 'Too humid for lions' }, 9002: { ok: false, reason: 'Too cold for lions' } },
                Tiger: { 9001: ok, 9000: { ok: false, reason: 'Too dry' }, 9002: { ok: false, reason: 'Too cold' }, 9003: { ok: false, reason: 'Too dry' }, 9004: ok },
                Zebra: { 9002: ok, 9000: ok, 9003: ok, 9004: ok, 9001: { ok: false, reason: 'Too humid' } },
                Ostrich: { 9003: ok, 9000: ok, 9004: ok },
            },
            habitats: [{ id: '9004', name: 'Grassland Habitat' }, { id: '9003', name: 'Plains Habitat' }],
            tradeCentre: { id: '501', name: 'Trade Centre' },
        };
        window.__kb = { active: true, dest: [], moves: [], refuse: null, inFlight: false, overlap: false };
        window.__kbMoves = await import('/js/mods/pz2qol/kinmoves.js');
        window.__kbMoves.onPlanRun(r => {
            if (r.stopping && !window.__kbStopStack) window.__kbStopStack = new Error('stop').stack;
            (window.__kbRuns = window.__kbRuns || []).push(JSON.stringify({ t: Date.now() % 100000, running: r.running, done: r.done, total: r.total, cur: (r.current || '').slice(0, 20), fin: r.finished, err: r.error, log: r.log.length }));
        });
        engine.on('PZ2QoL_KinDestinations', (reqId, ids) => {
            if (!window.__kb.active) return;
            window.__kb.dest.push(String(ids));
            engine.trigger('PZ2QoL_KinDestinationsResult', reqId, JSON.stringify(DEST));
        });
        engine.on('PZ2QoL_KinMove', (reqId, id, to) => {
            const kb = window.__kb;
            if (!kb.active) return;
            const rec = { id: String(id), to: String(to), start: Date.now(), end: null, ok: true };
            if (kb.inFlight) kb.overlap = true;
            kb.moves.push(rec);
            if (String(id) === kb.refuse) {
                rec.ok = false;
                rec.end = Date.now();
                engine.trigger('PZ2QoL_KinMoveResult', reqId, false, 'The keepers cannot reach that habitat.');
                return;
            }
            kb.inFlight = true;
            engine.trigger('PZ2QoL_KinMoveResult', reqId, true, '');
            // the game gives the animal a transport job a moment later
            setTimeout(() => {
                const a = window.__kbSnap.animals.find(x => String(x.id) === String(id));
                if (a) a.moving = true;
                window.__kbSnap.seq++;
                kin.applyKinSnapshot(JSON.parse(JSON.stringify(window.__kbSnap)));
                rec.end = Date.now();
                kb.inFlight = false;
            }, 300);
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
    const seeded = await seedZooKin(page);
    await seedBoard(page);
    await page.evaluate(async () => (await import('/js/mods/pz2qol/kin.js')).setKinSettings({ allowPlansOnline: false }));
    const lion = n => seeded.layout.find(l => l.hab === '9000' && l.n === n).id;
    const card = (id, planned) => page.locator(`.PZ2QoL_kbCard[data-id="${id}"]${planned == null ? '' : `[data-planned="${planned ? 1 : 0}"]`}`);
    const col = id => page.locator(`.PZ2QoL_kbCol[data-col="${id}"]`);

    try {
        // 1. the board, species rail
        facts.opened = await page.evaluate(async url => (await import(url)).openSpeciesBoard({}), BOARD);
        await page.waitForSelector('.PZ2QoL_kb:not(.hidden) .PZ2QoL_kbCol', { timeout: 4000 });
        await page.waitForTimeout(500);
        await ctx.shot(page, 'kb_1_board');
        facts.rail = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbSpecies')].map(n => ({
            species: n.getAttribute('data-species'),
            risk: +(((n.querySelector('.PZ2QoL_kpCount.sev_risk .PZ2QoL_kpCountN') || {}).textContent) || 0),
            on: n.classList.contains('on'),
        })));
        facts.destRequests = await page.evaluate(() => window.__kb.dest.length);
        facts.columns = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbCol')].map(n => ({
            id: n.getAttribute('data-col'), kind: n.getAttribute('data-kind'), cls: n.className.replace(/PZ2QoL_kbCol\s*/, ''),
            cards: n.querySelectorAll('.PZ2QoL_kbCard').length, head: n.querySelector('.PZ2QoL_kbColHead').innerText.replace(/\s+/g, ' ').trim(),
        })));
        facts.layoutBoard = await layoutFacts(page);
        layoutProblems('board', facts.layoutBoard, problems);
        if (facts.rail[0].species !== 'Lion' || !facts.rail[0].on) problems.push(`rail starts with ${JSON.stringify(facts.rail[0])}, expected Lion focused`);
        if (facts.rail[facts.rail.length - 1].species !== 'Ostrich') problems.push(`rail does not end with the problem-free Ostrich: ${facts.rail.map(r => r.species)}`);
        for (let i = 1; i < facts.rail.length; i++) if (facts.rail[i].risk > facts.rail[i - 1].risk) problems.push('rail is not worst first');
        if (!facts.destRequests) problems.push('no destinations were asked for');
        const byId = Object.fromEntries(facts.columns.map(c => [c.id, c]));
        for (const id of ['9000', '9003', '9001', '9004', 'trade', 'away']) if (!byId[id]) problems.push(`no column ${id}`);
        if (byId['9001'] && !/unsuitable/.test(byId['9001'].cls)) problems.push('Jungle is not marked unsuitable for lions');
        if (byId['9001'] && !/Too humid/.test(byId['9001'].head)) problems.push('the unsuitable column does not give the reason');
        if (byId['9004'] && !(/empty/.test(byId['9004'].cls) && /suitable/i.test(byId['9004'].head))) problems.push('Grassland is not shown as empty and suitable');
        if (byId['9003'] && !/Ostrich 1/.test(byId['9003'].head)) problems.push('Plains does not show the ostrich sharing it');
        if (byId['away'] && byId['away'].cards !== 1) problems.push('the lion in transit is not under Elsewhere');

        // 2. hover: every relative lights up with how it is related
        await page.mouse.move(0, 0);
        const daughter = lion(3);
        await card(daughter).first().hover();
        await page.waitForTimeout(250);
        facts.hover = await page.evaluate(() => ({
            hot: [...document.querySelectorAll('.PZ2QoL_kbCard.relHot')].map(n => ({ id: n.getAttribute('data-id'), word: n.querySelector('.PZ2QoL_kbRelLabel').textContent, risk: n.classList.contains('rel_risk') })),
            dim: document.querySelectorAll('.PZ2QoL_kbCard.dim').length,
            colRel: [...document.querySelectorAll('.PZ2QoL_kbColRel.show')].map(n => n.textContent),
        }));
        await ctx.shot(page, 'kb_2_hover');
        const words = facts.hover.hot.map(x => x.word).join(' ');
        if (facts.hover.hot.length < 3) problems.push(`only ${facts.hover.hot.length} relatives lit on hover`);
        if (!/brother/.test(words) || !/father/.test(words)) problems.push(`hover words: ${words}`);
        if (!facts.hover.hot.some(x => x.risk)) problems.push('no relative marked as an inbreeding risk on hover');
        if (!facts.hover.dim) problems.push('unrelated cards are not faded on hover');
        if (!facts.hover.colRel.length) problems.push('column heads do not count the relatives');
        await page.mouse.move(5, 5);
        await page.waitForTimeout(150);

        // 3. drag the daughter to the empty Grassland: planned, with its effect
        let d = await drag(page, card(daughter), col('9004'));
        facts.dropPreview = await text(page, '.PZ2QoL_kbCol[data-col="9004"] .PZ2QoL_kbColDrop');
        await d.up();
        await ctx.shot(page, 'kb_3_planned');
        facts.afterDrag = {
            planned: await page.locator(`.PZ2QoL_kbCol[data-col="9004"] .PZ2QoL_kbCard[data-id="${daughter}"][data-planned="1"]`).count(),
            ghost: await page.locator(`.PZ2QoL_kbCol[data-col="9000"] [data-ghost="${daughter}"]`).count(),
            impact: await impact(page),
        };
        if (!/Fixes/.test(facts.dropPreview)) problems.push(`drop preview: "${facts.dropPreview}"`);
        if (facts.afterDrag.planned !== 1) problems.push('the dragged card is not planned in Grassland');
        if (facts.afterDrag.ghost !== 1) problems.push('no ghost left behind in Savannah');
        if (!facts.afterDrag.impact || facts.afterDrag.impact.moves !== 1 || facts.afterDrag.impact.fixed < 2) problems.push(`impact after the drag: ${JSON.stringify(facts.afterDrag.impact)}`);
        if (!/fixed/.test((facts.afterDrag.impact || {}).text || '')) problems.push('impact text does not say what is fixed');

        // a refused drop: Jungle is too humid
        d = await drag(page, card(lion(0)), col('9001'));
        facts.refusedPreview = await text(page, '.PZ2QoL_kbCol[data-col="9001"] .PZ2QoL_kbColDrop');
        facts.refusedClass = await page.evaluate(() => document.querySelector('.PZ2QoL_kbCol[data-col="9001"]').className);
        await ctx.shot(page, 'kb_3b_refused_drop');
        await d.up();
        facts.refusedNotice = await text(page, '.PZ2QoL_kbNotice');
        facts.afterRefused = (await impact(page)).moves;
        if (!/dropNo/.test(facts.refusedClass) || !/Too humid/.test(facts.refusedPreview)) problems.push(`refused drop not shown: ${facts.refusedClass} / ${facts.refusedPreview}`);
        if (!/Too humid/.test(facts.refusedNotice)) problems.push(`no reason after a refused drop: "${facts.refusedNotice}"`);
        if (facts.afterRefused !== 1) problems.push('a refused drop changed the plan');

        // 4. the click way: select the father, "Move 1 here" on Plains, then ✕
        await click(card(lion(0)));
        await page.waitForTimeout(200);
        facts.moveHere = await page.locator('.PZ2QoL_kbCol[data-col="9003"] .PZ2QoL_kbMoveHere').innerText().catch(() => '');
        facts.moveHereOnJungle = await page.locator('.PZ2QoL_kbCol[data-col="9001"] .PZ2QoL_kbMoveHere').count();
        await click(page.locator('.PZ2QoL_kbCol[data-col="9003"] .PZ2QoL_kbMoveHere'));
        await page.waitForTimeout(250);
        facts.afterMoveHere = (await impact(page)).moves;
        await click(card(lion(0), true).locator('.PZ2QoL_kbCardX'));
        await page.waitForTimeout(250);
        facts.afterRemove = (await impact(page)).moves;
        if (!/Move 1 here/.test(facts.moveHere)) problems.push(`no "Move 1 here" on Plains: "${facts.moveHere}"`);
        if (facts.moveHereOnJungle) problems.push('"Move here" offered on an unsuitable habitat');
        if (facts.afterMoveHere !== 2 || facts.afterRemove !== 1) problems.push(`select + move here / remove: ${facts.afterMoveHere} / ${facts.afterRemove}`);

        // 5. Suggest fixes clears the lions' risks
        await click(page.locator('.PZ2QoL_kbPlan .PZ2QoL_kbClearPlan'));
        await page.waitForTimeout(200);
        await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Suggest fixes' }));
        await page.waitForTimeout(400);
        await ctx.shot(page, 'kb_4_suggested');
        facts.suggested = await impact(page);
        facts.suggestedRows = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbMove')].map(n => n.innerText.replace(/\s+/g, ' ').trim()));
        facts.layoutSuggested = await layoutFacts(page);
        layoutProblems('suggested', facts.layoutSuggested, problems);
        if (!(facts.suggested.moves >= 1)) problems.push('Suggest fixes planned nothing');
        if (facts.suggested.afterRisk !== 0) problems.push(`lions still have ${facts.suggested.afterRisk} inbreeding risks after Suggest fixes`);
        if (facts.suggested.created !== 0) problems.push('Suggest fixes creates risks');
        if (!facts.suggestedRows.every(r => /Suggested:/.test(r))) problems.push('a suggested move has no reason');

        // make sure there are at least 3 moves (the run test needs 2 good ones before the refusal)
        let ids = await planIds(page);
        const spare = [lion(8), lion(10), lion(12)].filter(id => !ids.includes(id));
        for (const id of spare) {
            if (ids.length >= 3) break;
            await click(card(id));
            await click(page.locator('.PZ2QoL_kbCol[data-col="9004"] .PZ2QoL_kbMoveHere'));
            await page.waitForTimeout(200);
            ids = await planIds(page);
        }
        facts.planForRun = ids;

        // 6. Franchise: whole plans are off until allowed
        await page.evaluate(async () => {
            const kin = await import('/js/mods/pz2qol/kin.js');
            window.__kbSnap.mode = 'franchise';
            window.__kbSnap.seq++;
            kin.applyKinSnapshot(JSON.parse(JSON.stringify(window.__kbSnap)));
        });
        await page.waitForTimeout(300);
        await ctx.shot(page, 'kb_5_franchise_blocked');
        facts.layoutFranchise = await layoutFacts(page);
        layoutProblems('franchise', facts.layoutFranchise, problems);
        facts.franchise = {
            execDisabled: await page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn.disabled', { hasText: 'Execute plan' }).count(),
            blocked: await text(page, '.PZ2QoL_kbBlocked'),
            switch: await page.locator('.PZ2QoL_kbActions .PZ2QoL_kpSwitch', { hasText: 'Allow running plans in Franchise' }).count(),
        };
        await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpSwitch', { hasText: 'Allow running plans in Franchise' }));
        await page.waitForTimeout(250);
        facts.franchise.execAfterAllow = await page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn.disabled', { hasText: 'Execute plan' }).count();
        facts.franchise.setting = await page.evaluate(async () => (await import('/js/mods/pz2qol/kin.js')).getKinSettings().allowPlansOnline);
        if (facts.franchise.execDisabled !== 1 || !/Franchise/.test(facts.franchise.blocked) || facts.franchise.switch !== 1) problems.push(`Franchise block: ${JSON.stringify(facts.franchise)}`);
        if (facts.franchise.execAfterAllow !== 0 || facts.franchise.setting !== true) problems.push('allowing plans in Franchise did not enable Execute');
        await page.evaluate(async () => {
            const kin = await import('/js/mods/pz2qol/kin.js');
            kin.setKinSettings({ allowPlansOnline: false });
            window.__kbSnap.mode = 'offline';
            window.__kbSnap.seq++;
            kin.applyKinSnapshot(JSON.parse(JSON.stringify(window.__kbSnap)));
        });
        await page.waitForTimeout(300);

        // 7. Execute: one move at a time, in order, stops at the refusal
        ids = await planIds(page);
        const refuseAt = Math.min(2, ids.length - 1);
        await page.evaluate(id => { window.__kb.refuse = id; window.__kb.moves.length = 0; }, ids[refuseAt]);
        await click(page.locator('.PZ2QoL_kbActions .PZ2QoL_kpBtn', { hasText: 'Execute plan' }));
        await page.waitForTimeout(900);
        await ctx.shot(page, 'kb_6_running');
        facts.running = await text(page, '.PZ2QoL_kbActions');
        // a synchronous check (an async one returns a promise, which counts as true)
        await page.waitForFunction(() => window.__kbMoves.getPlanRun().finished === true, null, { timeout: 30000 });
        await page.waitForTimeout(400);
        await ctx.shot(page, 'kb_7_stopped');
        facts.run = await page.evaluate(async () => {
            const r = (await import('/js/mods/pz2qol/kinmoves.js')).getPlanRun();
            return { done: r.done, total: r.total, error: r.error, log: r.log.map(l => `${l.ok ? 'ok' : 'x'} ${l.text}`), moves: window.__kb.moves, overlap: window.__kb.overlap, stopStack: window.__kbStopStack || null, runs: window.__kbRuns || [] };
        });
        facts.runTabs = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbTab')].map(n => n.innerText));
        facts.runLogRows = await page.locator('.PZ2QoL_kbLogRow').count();
        await click(page.locator('.PZ2QoL_kbTab', { hasText: /plan/i }));
        await page.waitForTimeout(200);
        facts.afterRunPlan = await planIds(page);
        facts.runResult = await text(page, '.PZ2QoL_kbRunResult');
        const sent = facts.run.moves.map(m => m.id);
        if (sent.join() !== ids.slice(0, refuseAt + 1).join()) problems.push(`moves sent ${sent} for plan ${ids} (refusal at ${refuseAt})`);
        if (facts.run.overlap) problems.push('two moves were in flight at once');
        for (let i = 1; i < facts.run.moves.length; i++) {
            const prev = facts.run.moves[i - 1], cur = facts.run.moves[i];
            if (cur.start - prev.start < 1500) problems.push(`moves ${i} and ${i + 1} only ${cur.start - prev.start} ms apart`);
            if (prev.end == null || cur.start < prev.end) problems.push(`move ${i + 1} was sent before move ${i} was confirmed`);
        }
        if (facts.run.done !== refuseAt || !/cannot reach/.test(facts.run.error || '')) problems.push(`run result: ${JSON.stringify({ done: facts.run.done, error: facts.run.error })}`);
        if (!/stopped/.test(facts.runResult)) problems.push(`no "Stopped" result shown: "${facts.runResult}"`);
        if (facts.runLogRows !== refuseAt + 1) problems.push(`the run log shows ${facts.runLogRows} rows`);
        if (facts.afterRunPlan.join() !== ids.slice(refuseAt).join()) problems.push(`plan after the run ${facts.afterRunPlan}, expected the refused and later moves ${ids.slice(refuseAt)}`);
        facts.layoutStopped = await layoutFacts(page);
        layoutProblems('stopped', facts.layoutStopped, problems);

        // 8. Move now from a card menu: one click, one move
        await page.evaluate(() => { window.__kb.refuse = null; window.__kb.moves.length = 0; });
        const mover = lion(1);
        await click(card(mover).locator('.PZ2QoL_kbCardMenu'));
        await page.waitForTimeout(200);
        facts.menu = await text(page, '.PZ2QoL_kbMenu');
        await ctx.shot(page, 'kb_8_menu');
        facts.layoutMenu = await layoutFacts(page);
        layoutProblems('menu', facts.layoutMenu, problems);
        await click(page.locator('.PZ2QoL_kbMenu .PZ2QoL_kbMenuItem', { hasText: 'Plains Habitat' }));
        await page.waitForTimeout(800);
        facts.moveNow = await page.evaluate(() => window.__kb.moves.map(m => [m.id, m.to]));
        facts.moverMoving = await page.locator(`.PZ2QoL_kbCard[data-id="${mover}"] .PZ2QoL_kbTag.moving`).count();
        if (!/move now to/i.test(facts.menu) || /Jungle/.test(facts.menu)) problems.push(`card menu: "${facts.menu}"`);
        if (facts.moveNow.length !== 1 || facts.moveNow[0][0] !== mover || facts.moveNow[0][1] !== '9003') problems.push(`Move now sent ${JSON.stringify(facts.moveNow)}`);
        if (facts.moverMoving !== 1) problems.push('the moved animal is not shown on the move');

        // 9. Esc closes
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        facts.openAfterEsc = await page.evaluate(async url => (await import(url)).isSpeciesBoardOpen(), BOARD);
        if (facts.openAfterEsc) problems.push('Esc did not close the board');
    }
    finally {
        // leave the page as the other scenarios expect it
        await page.mouse.up().catch(() => {});
        await page.evaluate(async url => {
            if (window.__kb) window.__kb.active = false;
            (await import(url)).closeSpeciesBoard();
            const kin = await import('/js/mods/pz2qol/kin.js');
            kin.setKinSettings({ allowPlansOnline: false });
            kin.applyKinSnapshot(window.__kinFixture.snapshot);
            // the refused move raised the "Kin plan stopped" banner on purpose
            const dismiss = [...document.querySelectorAll('.PZ2QoL_errorBanner .PZ2QoL_errorButton')].find(b => /Dismiss/.test(b.textContent));
            if (dismiss) dismiss.click();
        }, BOARD).catch(() => {});
    }
    if (problems.length) throw new Error('species board: ' + problems.join('; '));
    return facts;
}
