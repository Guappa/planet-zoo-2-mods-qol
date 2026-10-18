// Browser-harness scenario: pair bonds (docs/PLAN-pair-bonds.md).
// Runs on the in-park HUD page. Plants the related families (kin_fixture.mjs),
// then bonds the Savannah father to an unrelated female the way the Lua bond
// pass reports it: his daughter and his niece become "Bonded elsewhere"
// instead of a risk / close kin. Checks the planner (matrix, pair card,
// legend, the switch) and the Species board card, then restores the fixture.
import { seedZooKin } from './kin_fixture.mjs';

export const name = 'bonds';

const PLANNER = '/js/mods/pz2qol/kinplanner.js';

async function click(locator) {
    try {
        await locator.first().click({ timeout: 2500 });
    }
    catch (e) {
        await locator.first().dispatchEvent('click');
    }
}

const text = (page, sel) => page.evaluate(s => {
    const n = document.querySelector(s);
    return n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
}, sel);

const cells = page => page.evaluate(() => {
    const count = s => document.querySelectorAll(s).length;
    return { held: count('.PZ2QoL_kpCell.sev_held'), risk: count('.PZ2QoL_kpCell.sev_risk'), kin: count('.PZ2QoL_kpCell.sev_kin') };
});

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
    // Savannah: r0 the father, r3 his daughter (risk), r5 his niece (close kin);
    // his mate: the last unrelated founder of the habitat
    const sav = seeded.layout.filter(l => l.hab === '9000');
    const r0 = sav.find(l => l.n === 0), r3 = sav.find(l => l.n === 3), r5 = sav.find(l => l.n === 5);
    const mate = sav.filter(l => l.n >= 7 && l.sex === 1 && !l.juv).pop();
    facts.ids = { father: r0 && r0.id, daughter: r3 && r3.id, niece: r5 && r5.id, mate: mate && mate.id };
    if (!r0 || !r3 || !r5 || !mate) {
        problems.push(`fixture has no Savannah father/daughter/niece/mate: ${JSON.stringify(facts.ids)}`);
        throw new Error('kin bonds: ' + problems.join('; '));
    }
    await page.evaluate(async ({ f, d, n, m }) => {
        const snap = JSON.parse(JSON.stringify(window.__kinFixture.snapshot));
        const lock = snap.animals.filter(a => a.hab === '9000' && a.sex === 1 && !a.juv && a.id !== m).map(a => a.id);
        for (const a of snap.animals) {
            if (a.id === f) Object.assign(a, { mates: [m], bond: { mate: m, ring: true, lock } });
            if (a.id === m) Object.assign(a, { mates: [f], bond: { mate: f, ring: true, lock: [] } });
        }
        snap.bondsOk = true;
        snap.seq = 50;
        window.__kinBondSnap = snap;
        const kin = await import('/js/mods/pz2qol/kin.js');
        kin.setKinSettings({ bondHolds: true });
        kin.applyKinSnapshot(snap);
    }, { f: r0.id, d: r3.id, n: r5.id, m: mate.id });
    facts.model = await page.evaluate(async ({ f, d, n }) => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const m = kin.getKinModel();
        const sev = (x, y) => (m.pairs.find(p => (p.a.id === x && p.b.id === y) || (p.a.id === y && p.b.id === x)) || {}).severity;
        return { daughter: sev(f, d), niece: sev(f, n), held: m.counts.held };
    }, { f: r0.id, d: r3.id, n: r5.id });
    if (facts.model.daughter !== 'held') problems.push(`father x daughter is ${facts.model.daughter}, not held`);
    if (facts.model.niece !== 'held') problems.push(`father x niece is ${facts.model.niece}, not held`);

    // planner: matrix squares, the pair card, the legend
    await page.evaluate(async url => (await import(url)).openKinPlanner({ habitatId: '9000' }), PLANNER);
    await page.waitForSelector('.PZ2QoL_kpMatrix', { timeout: 3000 });
    await page.waitForTimeout(400);
    await ctx.shot(page, 'kb_bonds_1_matrix');
    facts.cellsOn = await cells(page);
    facts.summary = await text(page, '.PZ2QoL_kpSummary');
    facts.legend = await text(page, '.PZ2QoL_kp .PZ2QoL_kpLegend');
    if (!(facts.cellsOn.held >= 2)) problems.push(`only ${facts.cellsOn.held} "Bonded elsewhere" squares`);
    if (!/bonded elsewhere/i.test(facts.summary)) problems.push(`summary does not count bonded pairs: "${facts.summary}"`);
    if (!/Bonded elsewhere/i.test(facts.legend)) problems.push('legend has no "Bonded elsewhere"');
    await click(page.locator('.PZ2QoL_kpCell.sev_held'));
    await page.waitForSelector('.PZ2QoL_kpDet.pair', { timeout: 3000 });
    await page.waitForTimeout(300);
    await ctx.shot(page, 'kb_bonds_2_pair');
    facts.pairDetail = await text(page, '.PZ2QoL_kpDet.pair');
    if (!/Bonded elsewhere/i.test(facts.pairDetail)) problems.push(`pair card has no tag: "${facts.pairDetail.slice(0, 120)}"`);
    if (!/is bonded to .+\(monogamy\)/.test(facts.pairDetail)) problems.push(`pair card does not explain the bond: "${facts.pairDetail.slice(0, 200)}"`);

    // the switch: off turns every held pair back into what it was
    await click(page.locator('.PZ2QoL_kpBtn', { hasText: 'Settings' }));
    await page.waitForTimeout(250);
    await ctx.shot(page, 'kb_bonds_3_settings');
    await click(page.locator('.PZ2QoL_kpPopover .PZ2QoL_kpSwitch', { hasText: 'Pair bonds' }));
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await click(page.locator('.PZ2QoL_kpHab', { hasText: 'Savannah Habitat' }));
    await page.waitForTimeout(400);
    facts.cellsOff = await cells(page);
    facts.settingOff = await page.evaluate(async () => (await import('/js/mods/pz2qol/kin.js')).getKinSettings().bondHolds);
    if (facts.settingOff !== false) problems.push('the switch did not turn bondHolds off');
    if (facts.cellsOff.held !== 0) problems.push(`switch off still shows ${facts.cellsOff.held} bonded squares`);
    if (!(facts.cellsOff.risk > facts.cellsOn.risk)) problems.push(`switch off: risk squares ${facts.cellsOn.risk} -> ${facts.cellsOff.risk}`);
    await page.evaluate(async () => (await import('/js/mods/pz2qol/kin.js')).setKinSettings({ bondHolds: true }));
    await page.waitForTimeout(300);
    facts.cellsBack = await cells(page);
    if (facts.cellsBack.held !== facts.cellsOn.held) problems.push(`switch back on: ${facts.cellsBack.held} bonded squares, expected ${facts.cellsOn.held}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // restore the plain fixture for the scenarios after this one
    await page.evaluate(async () => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        kin.setKinSettings({ bondHolds: true });
        kin.applyKinSnapshot(window.__kinFixture.snapshot);
    });
    if (problems.length) throw new Error('kin bonds: ' + problems.join('; '));
    return facts;
}
