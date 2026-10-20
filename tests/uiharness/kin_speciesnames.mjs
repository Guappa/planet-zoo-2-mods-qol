// Browser-harness scenario: species names in the game's language
// (speciesnames.js, Kin setting gameSpeciesNames). The harness has no loc
// files, so a fake localiser stands in for the game's Localisation.js:
// Lion -> "Löwe", a long Zebra name and a CJK Ostrich name. Checks the
// Species board title, rail and shared-habitat chip, the planner's species
// tabs, that data-species stays the internal id, the layout with long and
// CJK names, and that the planner's switch puts the internal names back.
import { seedZooKin, applySnapshot } from './kin_fixture.mjs';
import { layoutFacts, layoutProblems } from './kin_board.mjs';

export const name = 'speciesnames';

const BOARD = '/js/mods/pz2qol/kinboard.js';
const PLANNER = '/js/mods/pz2qol/kinplanner.js';
const NAMES = '/js/mods/pz2qol/speciesnames.js';
const D = {
    Animal_Lion: 'Löwe',
    Animal_Zebra: 'Steppenzebra mit sehr langem Namen',
    Animal_Ostrich: '鸵鸟鸵鸟鸵鸟鸵鸟鸵鸟鸵鸟鸵鸟鸵鸟',
};

async function click(locator) {
    try {
        await locator.first().click({ timeout: 2500 });
    }
    catch (e) {
        await locator.first().dispatchEvent('click');
    }
}

const boardFacts = page => page.evaluate(() => ({
    title: (document.querySelector('.PZ2QoL_kb .PZ2QoL_kpMainTitle') || {}).innerText || '',
    rail: [...document.querySelectorAll('.PZ2QoL_kb .PZ2QoL_kbSpecies')].map(n => ({
        species: n.getAttribute('data-species'),
        name: ((n.querySelector('.PZ2QoL_kpHabName') || {}).innerText || '').trim(),
        title: n.getAttribute('title') || '',
    })),
    other: [...document.querySelectorAll('.PZ2QoL_kb .PZ2QoL_kbOther')].map(n => n.innerText.trim()),
    // rail names must stay inside their card
    railOverflow: [...document.querySelectorAll('.PZ2QoL_kb .PZ2QoL_kbSpecies')].filter(n => {
        const c = n.getBoundingClientRect();
        const t = n.querySelector('.PZ2QoL_kpHabName');
        if (!t || !c.width) return false;
        const r = t.getBoundingClientRect();
        return r.left < c.left - 1 || r.right > c.right + 1;
    }).map(n => n.getAttribute('data-species')),
}));

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
    // an ostrich sharing the lions' habitat (a chip on the Savannah column)
    const snap = JSON.parse(JSON.stringify(seeded.snapshot));
    snap.seq = (snap.seq || 0) + 1;
    snap.animals.push({ id: '8810', key: 'animal_8810', guid: 'gsn8810', name: 'Oskar', species: 'Ostrich', sex: 0, juv: false, contra: false, infertile: false, preg: false, hab: '9000', loc: 'Savannah Habitat', lt: 'habitat', par: [], mates: [] });
    await applySnapshot(page, snap);

    try {
        await page.evaluate(async ({ url, D }) => {
            window.__snActive = true;
            engine.on('PZ2QoL_KinDestinations', (reqId) => window.__snActive && engine.trigger('PZ2QoL_KinDestinationsResult', reqId, JSON.stringify({
                bySpecies: { Lion: { 9000: { ok: true } }, Tiger: { 9001: { ok: true } }, Zebra: { 9002: { ok: true } }, Ostrich: { 9000: { ok: true } } },
                habitats: [], tradeCentre: null,
            })));
            const m = await import(url);
            window.__snCalls = { exists: [], translate: [] };
            m._setSpeciesLocaliserForTests({
                exists: id => { window.__snCalls.exists.push(id); return Object.prototype.hasOwnProperty.call(D, id); },
                translate: s => { window.__snCalls.translate.push(s); const k = s.replace(/^\[|\]$/g, ''); return Object.prototype.hasOwnProperty.call(D, k) ? D[k] : s; },
            });
            (await import('/js/mods/pz2qol/kin.js')).setKinSettings({ gameSpeciesNames: true });
        }, { url: NAMES, D });

        // 1. the Species board on lions, localised
        await page.evaluate(async url => (await import(url)).openSpeciesBoard({ species: 'Lion' }), BOARD);
        await page.waitForSelector('.PZ2QoL_kb:not(.hidden) .PZ2QoL_kbCol', { timeout: 4000 });
        await page.waitForTimeout(500);
        await ctx.shot(page, 'sn_1_board_localised');
        facts.board = await boardFacts(page);
        facts.calls = await page.evaluate(() => ({ exists: window.__snCalls.exists.slice(0, 10), translate: window.__snCalls.translate.slice(0, 10) }));
        facts.layoutBoard = await layoutFacts(page);
        layoutProblems('board', facts.layoutBoard, problems);
        const rail = Object.fromEntries(facts.board.rail.map(r => [r.species, r]));
        if (facts.board.title !== 'Löwe') problems.push(`board title "${facts.board.title}", expected Löwe`);
        if (!rail.Lion) problems.push(`no rail card with data-species="Lion" (ids must stay internal): ${facts.board.rail.map(r => r.species)}`);
        else if (rail.Lion.name !== 'Löwe') problems.push(`Lion rail card shows "${rail.Lion.name}"`);
        if (!rail.Zebra || !/^Steppenzebra/.test(rail.Zebra.name)) problems.push(`Zebra rail card: ${JSON.stringify(rail.Zebra)}`);
        if (!rail.Ostrich || !/^鸵鸟/.test(rail.Ostrich.name)) problems.push(`Ostrich rail card: ${JSON.stringify(rail.Ostrich)}`);
        if (!facts.board.other.some(t => /^鸵鸟/.test(t))) problems.push(`shared-habitat chip not localised: ${facts.board.other}`);
        if (facts.board.railOverflow.length) problems.push(`rail names spill out of their card: ${facts.board.railOverflow}`);
        if (facts.calls.exists.some(id => /[[\]]/.test(id))) problems.push(`exists() got brackets: ${facts.calls.exists}`);
        if (facts.calls.translate.some(s => !/^\[.*\]$/.test(s))) problems.push(`translate() got no brackets: ${facts.calls.translate}`);

        // 2. the planner: species tabs, then the switch off
        await page.evaluate(async url => (await import(url)).openKinPlanner({ habitatId: '9000' }), PLANNER);
        await page.waitForSelector('.PZ2QoL_kp:not(.hidden)', { timeout: 4000 });
        await page.waitForTimeout(500);
        facts.plannerText = await page.evaluate(() => (document.querySelector('.PZ2QoL_kp') || {}).innerText || '');
        facts.tabs = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kp .PZ2QoL_kpTabName')].map(n => n.innerText.trim()));
        await ctx.shot(page, 'sn_2_planner_localised');
        if (!/Löwe/.test(facts.plannerText)) problems.push('the planner shows no localised lion name');
        if (facts.tabs.length && !facts.tabs.some(t => /Löwe|鸵鸟/.test(t))) problems.push(`planner tabs not localised: ${facts.tabs}`);
        await click(page.locator('.PZ2QoL_kp .PZ2QoL_kpBtn', { hasText: 'Settings' }));
        await page.waitForTimeout(250);
        const sw = page.locator('.PZ2QoL_kpPopover.open .PZ2QoL_kpSwitch', { hasText: "Species names in the game's language" });
        facts.switchOnBefore = await sw.evaluate(n => n.classList.contains('on')).catch(() => null);
        await ctx.shot(page, 'sn_3_settings');
        if (facts.switchOnBefore !== true) problems.push(`the names switch is not on by default: ${facts.switchOnBefore}`);
        facts.popoverSpill = await page.evaluate(() => {
            const p = document.querySelector('.PZ2QoL_kpPopover.open');
            if (!p) return ['no popover'];
            const r = p.getBoundingClientRect();
            return [...p.querySelectorAll('.PZ2QoL_kpSwitchLabel')].filter(n => n.getBoundingClientRect().right > r.right - 4).map(n => n.innerText);
        });
        if (facts.popoverSpill.length) problems.push(`settings labels spill out of the popover: ${facts.popoverSpill}`);
        await click(sw);
        await page.waitForTimeout(300);
        facts.switchOnAfter = await sw.evaluate(n => n.classList.contains('on')).catch(() => null);
        facts.setting = await page.evaluate(async () => (await import('/js/mods/pz2qol/kin.js')).getKinSettings().gameSpeciesNames);
        facts.plannerTextOff = await page.evaluate(() => (document.querySelector('.PZ2QoL_kp') || {}).innerText || '');
        if (facts.switchOnAfter !== false || facts.setting !== false) problems.push(`switch off: on=${facts.switchOnAfter}, setting=${facts.setting}`);
        if (/Löwe/.test(facts.plannerTextOff)) problems.push('the planner still shows "Löwe" with the switch off');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        await page.evaluate(async url => (await import(url)).closeKinPlanner(), PLANNER);

        // 3. the board again: internal names
        await page.evaluate(async url => (await import(url)).openSpeciesBoard({ species: 'Lion' }), BOARD);
        await page.waitForSelector('.PZ2QoL_kb:not(.hidden) .PZ2QoL_kbCol', { timeout: 4000 });
        await page.waitForTimeout(400);
        facts.boardOff = await boardFacts(page);
        await ctx.shot(page, 'sn_4_board_internal');
        const railOff = Object.fromEntries(facts.boardOff.rail.map(r => [r.species, r]));
        if (facts.boardOff.title !== 'Lion') problems.push(`board title with the switch off: "${facts.boardOff.title}"`);
        if (!railOff.Zebra || railOff.Zebra.name !== 'Zebra') problems.push(`Zebra rail card with the switch off: ${JSON.stringify(railOff.Zebra)}`);
    }
    finally {
        await page.evaluate(async ({ names, board, planner }) => {
            window.__snActive = false;
            (await import(names))._setSpeciesLocaliserForTests(null);
            const kin = await import('/js/mods/pz2qol/kin.js');
            kin.setKinSettings({ gameSpeciesNames: true });
            (await import(board)).closeSpeciesBoard();
            (await import(planner)).closeKinPlanner();
            if (window.__kinFixture) kin.applyKinSnapshot(window.__kinFixture.snapshot);
        }, { names: NAMES, board: BOARD, planner: PLANNER }).catch(() => {});
    }
    if (problems.length) throw new Error('species names: ' + problems.join('; '));
    return facts;
}
