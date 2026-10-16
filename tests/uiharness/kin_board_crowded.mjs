// Species board with a crowded habitat: 40 lions in one place. The column
// must stay inside the board and scroll its cards (in game the column grew
// to fit every card and the rest was cut off, with nothing to scroll).
import { applySnapshot } from './kin_fixture.mjs';

export const name = 'board_crowded';

const BOARD = '/js/mods/pz2qol/kinboard.js';

function crowdedZoo() {
    const animals = [];
    for (let i = 0; i < 40; i++) {
        animals.push({
            id: String(5000 + i), key: 'animal_' + (5000 + i), guid: 'gc' + i, name: 'Lion ' + (i + 1),
            species: 'Lion', sex: i % 2, juv: i % 7 === 0, contra: false, infertile: false, hab: '7000', loc: 'Big Savannah',
            lt: 'habitat', moving: false,
            // a few families so there are badges
            par: i >= 10 ? ['gc' + (i % 5), 'gc' + (5 + (i % 5))] : [], mates: [],
        });
    }
    animals.push({ id: '6000', key: 'animal_6000', guid: 'gz', name: 'Lone Lion', species: 'Lion', sex: 1, hab: '7001', loc: 'Small Plains', lt: 'habitat', par: [], mates: [] });
    return {
        v: 1, seq: 50, scope: 'park', mode: 'offline', tradeCentre: { id: '9900', name: 'Trade Centre' },
        habitats: [{ id: '7000', name: 'Big Savannah' }, { id: '7001', name: 'Small Plains' }],
        animals, anc: {},
    };
}

export async function hud(page, ctx) {
    const facts = ctx.facts && typeof ctx.facts === 'object' ? ctx.facts : {};
    const problems = [];
    await page.evaluate(() => engine.trigger('World_ShowHUD'));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        engine.on('PZ2QoL_KinDestinations', (reqId) => engine.trigger('PZ2QoL_KinDestinationsResult', reqId, JSON.stringify({
            bySpecies: { Lion: { '7000': { ok: true }, '7001': { ok: true } } },
            habitats: [{ id: '7000', name: 'Big Savannah' }, { id: '7001', name: 'Small Plains' }],
            tradeCentre: { id: '9900', name: 'Trade Centre' },
        })));
    });
    await applySnapshot(page, crowdedZoo());
    await page.evaluate(async url => (await import(url)).openSpeciesBoard({ species: 'Lion' }), BOARD);
    await page.waitForTimeout(1500);
    const measure = () => page.evaluate(() => {
        const board = document.querySelector('.PZ2QoL_kpScroll.kbCols');
        const col = [...document.querySelectorAll('.PZ2QoL_kbCol')].find(c => /Big Savannah/.test(c.textContent));
        if (!board || !col) return null;
        const vp = col.querySelector('.PZ2QoL_kpScroll.kbColBody .PZ2QoL_kpViewport');
        const br = board.getBoundingClientRect(), cr = col.getBoundingClientRect(), vr = vp.getBoundingClientRect();
        return {
            cards: col.querySelectorAll('.PZ2QoL_kbCard').length,
            colBottom: Math.round(cr.bottom), boardBottom: Math.round(br.bottom),
            vpHeight: Math.round(vr.height), scrollHeight: vp.scrollHeight, scrollTop: vp.scrollTop,
            center: [Math.round(vr.left + vr.width / 2), Math.round(vr.top + vr.height / 2)],
            bar: !!col.querySelector('.PZ2QoL_kpBar.v.show'),
        };
    });
    facts.before = await measure();
    if (!facts.before) throw new Error('board_crowded: the crowded column was not drawn');
    if (facts.before.colBottom > facts.before.boardBottom + 2) problems.push(`column runs past the board (${facts.before.colBottom} > ${facts.before.boardBottom})`);
    if (!(facts.before.scrollHeight > facts.before.vpHeight + 20)) problems.push(`column has nothing to scroll (${facts.before.scrollHeight} vs ${facts.before.vpHeight})`);
    if (!facts.before.bar) problems.push('no scroll bar on the crowded column');
    await ctx.shot(page, 'kbc_1_crowded');
    await page.mouse.move(facts.before.center[0], facts.before.center[1]);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 120);
    await page.waitForTimeout(400);
    facts.after = await measure();
    if (!(facts.after.scrollTop > 0)) problems.push('the wheel did not scroll the column');
    await ctx.shot(page, 'kbc_2_scrolled');
    // the scroll position survives the next kin update
    const snap = crowdedZoo();
    snap.seq = 51;
    snap.animals[3].contra = true;
    await applySnapshot(page, snap);
    await page.waitForTimeout(600);
    facts.afterUpdate = await measure();
    if (!(facts.afterUpdate.scrollTop > 0)) problems.push('the scroll position was lost on a kin update');
    // Move now: "Send to Trade Centre" is offered and sends one trade move
    await page.evaluate(() => {
        window.__kbcMoves = [];
        engine.on('PZ2QoL_KinMove', (reqId, id, to) => {
            window.__kbcMoves.push([id, to]);
            engine.trigger('PZ2QoL_KinMoveResult', reqId, true, '');
        });
    });
    await page.locator('.PZ2QoL_kbCol', { hasText: 'Small Plains' }).locator('.PZ2QoL_kbCardMenu').first().click();
    await page.waitForTimeout(300);
    facts.menu = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kbMenu .PZ2QoL_kbMenuItem')].map(e => e.textContent.trim()));
    if (!facts.menu.some(t => /^Send to Trade Centre/.test(t))) problems.push('Move now has no trade centre option: ' + JSON.stringify(facts.menu));
    await ctx.shot(page, 'kbc_3_menu');
    await page.locator('.PZ2QoL_kbMenu .PZ2QoL_kbMenuItem', { hasText: 'Send to Trade Centre' }).click();
    await page.waitForTimeout(600);
    facts.moves = await page.evaluate(() => window.__kbcMoves.slice());
    if (!(facts.moves.length === 1 && facts.moves[0][0] === '6000' && /^trade:/.test(facts.moves[0][1]))) problems.push('trade centre move not sent as one move: ' + JSON.stringify(facts.moves));
    await page.evaluate(async url => (await import(url)).closeSpeciesBoard(), BOARD);
    facts.problems = problems;
    if (problems.length) throw new Error('board_crowded: ' + problems.join('; '));
    return facts;
}
