// Kin on the in-park HUD: zoo Animals list badges, the Kin filter and sort,
// the kin card, the Habitats list, the habitat and animal info panels, and
// the "new inbreeding risk" alert. Runs after the zoo scenario, with the
// management Animals screen open.
import { seedZooKin, applySnapshot } from './kin_fixture.mjs';

export const name = 'hud';

const wait = (page, ms) => page.waitForTimeout(ms);

async function zooListLength(page) {
    return page.evaluate(async () => {
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const c = new DataStoreCollection(['management', 'animals', 'animals', 'list']);
        await new Promise(r => setTimeout(r, 200));
        const n = c.source.length;
        c.dispose();
        return n;
    });
}

// Children keys of a DataStore context (dummy data in the harness).
async function childKeys(page, ctx) {
    return page.evaluate(async ctx => {
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const c = new DataStoreCollection(ctx);
        await new Promise(r => setTimeout(r, 100));
        const keys = c._source.map(x => x[x.length - 1]);
        c.dispose();
        return keys;
    }, ctx);
}

function remap(snapshot, map) {
    const s = JSON.parse(JSON.stringify(snapshot));
    for (const a of s.animals) {
        if (map[a.id]) {
            a.id = map[a.id];
            a.key = 'animal_' + a.id;
        }
        a.mates = a.mates.map(m => map[m] || m);
    }
    return s;
}

export async function hud(page, ctx) {
    const facts = ctx.facts && typeof ctx.facts === 'object' ? ctx.facts : {}; // kept by run.mjs even on failure
    const problems = [];
    await page.evaluate(() => engine.trigger('World_ShowHUD'));
    await wait(page, 600);
    await page.evaluate(() => engine.trigger('Management_SetManagementIndex', 7));
    await page.waitForSelector('.ManagementAnimals_root', { state: 'visible', timeout: 10000 });
    const { snapshot, layout } = await seedZooKin(page);
    await wait(page, 1200);

    // ---- zoo Animals list: badges on the rows
    facts.rowBadges = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.AnimalListItem_root')];
        return { rows: rows.length, badges: rows.filter(r => r.querySelector('.PZ2QoL_kin')).length, risk: document.querySelectorAll('.AnimalListItem_root .PZ2QoL_kin.sev_risk').length };
    });
    if (!(facts.rowBadges.badges > 0 && facts.rowBadges.risk > 0)) problems.push('no kin badges on zoo rows: ' + JSON.stringify(facts.rowBadges));
    facts.expected = await page.evaluate(async () => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const core = await import('/js/mods/pz2qol/kincore.js');
        const m = kin.getKinModel();
        const sev = [...m.animals.values()].map(a => core.animalSeverity(m, a.id));
        return { animals: m.animals.size, risk: sev.filter(s => s === 'risk').length, any: sev.filter(s => s === 'risk' || s === 'kin' || s === 'future').length, counts: m.counts };
    });
    await ctx.shot(page, 'kh_1_zoo_badges');

    // ---- kin card: hover peeks, click pins with actions
    const badge = page.locator('.AnimalListItem_root .PZ2QoL_kin.sev_risk').first();
    await page.evaluate(() => {
        window.__kinEv = [];
        const log = e => window.__kinEv.push(`${e.type}:${(e.target.className || e.target.nodeName || '').toString().slice(0, 30)}<-${e.relatedTarget ? (e.relatedTarget.className || e.relatedTarget.nodeName || '').toString().slice(0, 30) : 'null'}`);
        document.addEventListener('mouseover', log, true);
        document.addEventListener('mouseout', log, true);
        const card = document.querySelector('.PZ2QoL_kinCard');
        if (card) new MutationObserver(() => window.__kinEv.push('card:' + card.className)).observe(card, { attributes: true });
    });
    // a player's pointer crosses the row first; the row's own hover state
    // shifts its layout, so settle that before pointing at the badge
    await page.locator('.AnimalListItem_root', { has: page.locator('.PZ2QoL_kin.sev_risk') }).first().hover({ position: { x: 30, y: 20 } });
    await wait(page, 400);
    await badge.hover();
    await wait(page, 300);
    facts.cardOnHover = await page.evaluate(() => {
        const c = document.querySelector('.PZ2QoL_kinCard');
        return c && !c.classList.contains('hidden') ? c.innerText.slice(0, 200) : null;
    });
    if (!facts.cardOnHover) {
        facts.hoverDebug = await page.evaluate(() => {
            const b = document.querySelector('.AnimalListItem_root .PZ2QoL_kin.sev_risk');
            const r = b.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
            const c = document.querySelector('.PZ2QoL_kinCard');
            return { events: (window.__kinEv || []).slice(0, 30), rect: [r.left, r.top, r.width, r.height], topAtCenter: top && top.className, listeners: Object.keys(b._listeners || {}), afterSynthetic: !!(c && !c.classList.contains('hidden')) };
        });
        problems.push('kin card did not show on hover: ' + JSON.stringify(facts.hoverDebug));
    }
    await badge.click();
    await wait(page, 300);
    facts.cardPinned = await page.evaluate(() => {
        const c = document.querySelector('.PZ2QoL_kinCard.pinned:not(.hidden)');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { actions: c.querySelectorAll('.PZ2QoL_kinAction').length, text: c.innerText.slice(0, 300), inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
    });
    if (!facts.cardPinned || !facts.cardPinned.actions) problems.push('pinned kin card has no actions: ' + JSON.stringify(facts.cardPinned));
    else if (!facts.cardPinned.inView) problems.push('kin card outside the screen');
    await ctx.shot(page, 'kh_2_kin_card');
    await page.mouse.click(960, 40);
    await wait(page, 200);
    facts.cardClosed = await page.evaluate(() => !document.querySelector('.PZ2QoL_kinCard.pinned:not(.hidden)'));
    if (!facts.cardClosed) problems.push('pinned card did not close on an outside click');

    // ---- toolbar: Kin filter (risk, then all) and sort
    const kinChip = page.locator('.PZ2QoL_bar.zoo .PZ2QoL_chip.kin');
    facts.kinChipText = await kinChip.innerText();
    await kinChip.click();
    await wait(page, 800);
    facts.listRisk = await zooListLength(page);
    if (facts.listRisk !== facts.expected.risk) problems.push(`Kin risk filter shows ${facts.listRisk}, expected ${facts.expected.risk}`);
    await ctx.shot(page, 'kh_3_zoo_kin_risk');
    await kinChip.click();
    await wait(page, 800);
    facts.listAny = await zooListLength(page);
    if (facts.listAny !== facts.expected.any) problems.push(`Kin all filter shows ${facts.listAny}, expected ${facts.expected.any}`);
    await kinChip.click(); // off
    await wait(page, 500);
    const sortChip = page.locator('.PZ2QoL_bar.zoo .PZ2QoL_chip', { hasText: /^Sort:/ });
    for (let i = 0; i < 6; i++) {
        if (/Kin/.test(await sortChip.innerText())) break;
        await sortChip.click();
        await wait(page, 300);
    }
    await wait(page, 600);
    facts.sortLabel = await sortChip.innerText();
    facts.sortedTop = await page.evaluate(async () => {
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const DS = await import('/js/common/core/DataStore.js');
        const kin = await import('/js/mods/pz2qol/kin.js');
        const core = await import('/js/mods/pz2qol/kincore.js');
        const c = new DataStoreCollection(['management', 'animals', 'animals', 'list']);
        await new Promise(r => setTimeout(r, 200));
        const m = kin.getKinModel();
        const out = c.source.slice(0, 6).map(x => {
            const a = m.byKey.get(DS.getValue(x, 'id'));
            return a ? core.animalSeverity(m, a.id) : null;
        });
        c.dispose();
        return out;
    });
    if (facts.sortedTop[0] !== 'risk') problems.push('Kin sort does not put the risks first: ' + facts.sortedTop);
    await ctx.shot(page, 'kh_4_zoo_kin_sort');
    facts.barHeight = await page.evaluate(() => Math.round(document.querySelector('.PZ2QoL_bar.zoo').getBoundingClientRect().height));
    if (facts.barHeight > 120) problems.push('zoo toolbar too tall with Kin: ' + facts.barHeight);
    await page.locator('.PZ2QoL_bar.zoo .PZ2QoL_chip', { hasText: /^Clear/ }).click();
    await wait(page, 500);

    // ---- Habitats list
    await page.evaluate(() => engine.trigger('Management_SetManagementIndex', 8));
    await wait(page, 1500);
    facts.habitatRows = await page.evaluate(async () => {
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const DS = await import('/js/common/core/DataStore.js');
        const c = new DataStoreCollection(['management', 'animals', 'habitats', 'list']);
        for (let i = 0; i < 30 && c._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        const names = ['Savannah Habitat', 'Jungle Habitat', 'Arctic Habitat'];
        c._source.slice(0, 3).forEach((ctx, i) => {
            DS.setValue(ctx, 'id', 'habitat_' + (9000 + i));
            DS.setValue(ctx, 'name', names[i]);
        });
        const n = c._source.length;
        c.dispose();
        await new Promise(r => setTimeout(r, 800));
        return { rows: n, badges: document.querySelectorAll('.HabitatListItem_root .PZ2QoL_kin').length };
    });
    if (!facts.habitatRows.rows) problems.push('harness could not show the Habitats list');
    else if (!facts.habitatRows.badges) problems.push('no kin badges in the Habitats list: ' + JSON.stringify(facts.habitatRows));
    await ctx.shot(page, 'kh_5_habitats_tab');
    await page.evaluate(() => engine.trigger('Management_SetManagementIndex', 0));
    await wait(page, 800);

    // ---- habitat info panel, Animals tab
    const habPanels = await childKeys(page, ['infopanel', 'habitatGateInfoPanel']);
    facts.habitatPanel = { dummyPanels: habPanels.length };
    if (!habPanels.length) problems.push('harness has no habitat info panel data');
    if (habPanels.length) {
        const habId = habPanels[0];
        const panelCtx = ['infopanel', 'habitatGateInfoPanel', habId];
        const group = layout.filter(l => l.hab === '9000');
        const setup = await page.evaluate(async ({ panelCtx, group }) => {
            const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
            const DS = await import('/js/common/core/DataStore.js');
            const tabCtx = panelCtx.concat(['tabs', 'tab_habitatAnimals']);
            const sp = new DataStoreCollection(tabCtx.concat('speciesList'));
            await new Promise(r => setTimeout(r, 150));
            if (!sp._source.length) return { species: 0 };
            const spCtx = sp._source[0];
            DS.setValue(spCtx, 'id', 'Lion');
            DS.setValue(spCtx, 'name', '[Animal_Lion]');
            const rows = new DataStoreCollection(spCtx.concat('animalsList'));
            await new Promise(r => setTimeout(r, 150));
            const ids = [];
            rows._source.forEach((ctx, i) => {
                const l = group[i % group.length];
                DS.setValue(ctx, 'id', l.id);
                DS.setValue(ctx, 'gender', l.sex);
                ids.push(l.id);
            });
            const tabs = new DataStoreCollection(panelCtx.concat('tabs'));
            await new Promise(r => setTimeout(r, 100));
            const tabIndex = tabs._source.findIndex(c => c[c.length - 1] === 'tab_habitatAnimals');
            sp.dispose(); rows.dispose(); tabs.dispose();
            return { species: 1, rows: ids.length, tabIndex };
        }, { panelCtx, group });
        facts.habitatPanel.setup = setup;
        await applySnapshot(page, Object.assign({}, snapshot, {
            habitats: snapshot.habitats.map(h => h.id === '9000' ? Object.assign({}, h, { id: habId }) : h),
            animals: snapshot.animals.map(a => a.hab === '9000' ? Object.assign({}, a, { hab: habId }) : a),
        }));
        await page.evaluate(panelCtx => {
            engine.trigger('InfoPanel_SetContext', panelCtx);
            engine.trigger('InfoPanel_Show');
        }, panelCtx);
        await wait(page, 1000);
        // the panel resets to its first tab when the context arrives
        await page.evaluate(tabIndex => { if (tabIndex >= 0) engine.trigger('InfoPanel_SetSelectedTabIndex', tabIndex); }, setup.tabIndex);
        await wait(page, 1200);
        // open the "Animals in habitat" list
        await page.evaluate(() => {
            const t = document.querySelector('.HabitatAnimals_root .ExpandableListItem_root');
            if (t) t.click();
        });
        await wait(page, 800);
        facts.habitatPanel.tabsInDom = await page.evaluate(() => [...document.querySelectorAll('[class*="InfoPanel"][class*="tab"], [class*="Tab_root"]')].slice(0, 12).map(e => e.className.slice(0, 60)));
        facts.habitatPanel.panelRoots = await page.evaluate(() => [...document.querySelectorAll('.InfoPanelModule_root *')].map(e => e.className).filter(c => typeof c === 'string' && /_root/.test(c)).map(c => c.split(' ')[0]).filter((c, i, a) => a.indexOf(c) === i).slice(0, 40));
        // expand the animal list if the panel has a toggle for it
        facts.habitatPanel.dom = await page.evaluate(() => ({
            root: !!document.querySelector('.HabitatAnimals_root'),
            line: (document.querySelector('.HabitatAnimals_root .PZ2QoL_kinLine') || {}).innerText || null,
            rows: document.querySelectorAll('.HabitatAnimals_root .AnimalStatusItem_root').length,
            rowBadges: document.querySelectorAll('.HabitatAnimals_root .AnimalStatusItem_root .PZ2QoL_kin').length,
        }));
        if (facts.habitatPanel.dom.rows > 0 && !facts.habitatPanel.dom.rowBadges) problems.push('habitat panel rows have no kin badges');
        // The harness keeps the panel's animal list collapsed, so render one
        // of its rows on its own (the game's AnimalStatusItem, same context)
        facts.habitatPanel.directRow = await page.evaluate(async ({ panelCtx }) => {
            const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
            const DS = await import('/js/common/core/DataStore.js');
            const preact = await import('/js/common/lib/preact.js');
            const { AnimalStatusItem } = await import('/js/project/modules/InfoPanel/Components/Flex/Renderer/AnimalStatusItem.js');
            const sp = new DataStoreCollection(panelCtx.concat(['tabs', 'tab_habitatAnimals', 'speciesList']));
            await new Promise(r => setTimeout(r, 100));
            const rows = new DataStoreCollection(sp._source[0].concat('animalsList'));
            await new Promise(r => setTimeout(r, 100));
            const host = document.createElement('div');
            host.style.cssText = 'position:fixed;left:0;top:0;width:30rem;';
            document.body.appendChild(host);
            const out = [];
            for (const ctx of rows._source.slice(0, 6)) {
                const box = document.createElement('div');
                host.appendChild(box);
                preact.render(preact.h(AnimalStatusItem, { context: ctx }), box);
            }
            await new Promise(r => setTimeout(r, 400));
            const hooks = await import('/js/mods/pz2qol/kinhooks.js');
            window.__kinDirect = { patches: hooks.patchStatus(), html: host.children[0] ? host.children[0].innerHTML.slice(0, 600) : '', ids: rows._source.slice(0, 6).map(c => DS.getValue(c, 'id')), ctx: rows._source[0] };
            for (const box of host.children) out.push(box.querySelector('.PZ2QoL_kin') ? box.querySelector('.PZ2QoL_kin').className : null);
            host.remove();
            sp.dispose(); rows.dispose();
            return out;
        }, { panelCtx });
        if (!facts.habitatPanel.directRow.some(c => c && /sev_risk/.test(c))) facts.habitatPanel.directDebug = await page.evaluate(() => window.__kinDirect);
        if (!facts.habitatPanel.directRow.some(c => c && /sev_risk/.test(c))) problems.push('a habitat panel row rendered on its own has no risk badge: ' + JSON.stringify(facts.habitatPanel.directRow));
        await ctx.shot(page, 'kh_6_habitat_panel');
        if (facts.habitatPanel.dom.root && !facts.habitatPanel.dom.line) problems.push('habitat panel has no kin line');
        if (!facts.habitatPanel.dom.root) problems.push('harness could not open the habitat panel Animals tab');
        if (facts.habitatPanel.dom.root && !facts.habitatPanel.dom.line) problems.push('habitat panel kin line missing');
        await page.evaluate(() => engine.trigger('InfoPanel_Hide'));
        await wait(page, 500);
    }

    // ---- animal info panel, Overview card
    const animalPanels = await childKeys(page, ['infopanel', 'animalInfoPanel']);
    facts.animalPanel = { dummyPanels: animalPanels.length };
    if (!animalPanels.length) problems.push('harness has no animal info panel data');
    if (animalPanels.length) {
        const dummyId = String(animalPanels[0]);
        const r2 = layout.find(l => l.hab === '9000' && l.n === 2);
        await applySnapshot(page, remap(snapshot, { [r2.id]: dummyId }));
        await page.evaluate(ctx => {
            engine.trigger('InfoPanel_SetContext', ctx);
            engine.trigger('InfoPanel_Show');
            engine.trigger('InfoPanel_SetSelectedTabIndex', 0);
        }, ['infopanel', 'animalInfoPanel', dummyId, 'normal']);
        await wait(page, 1500);
        facts.animalPanel.dom = await page.evaluate(() => ({
            card: !!document.querySelector('.AnimalOverviewCard_root'),
            line: (document.querySelector('.PZ2QoL_kinLine.overview') || {}).innerText || null,
        }));
        await ctx.shot(page, 'kh_7_animal_overview');
        if (!facts.animalPanel.dom.card) problems.push('harness could not open the animal Overview card');
        else if (!/Inbreeding risk/.test(facts.animalPanel.dom.line || '')) problems.push('animal overview kin line missing or wrong: ' + facts.animalPanel.dom.line);
        await page.evaluate(() => engine.trigger('InfoPanel_Hide'));
        await wait(page, 400);
    }

    // ---- alerts: contraception lifted on the half-sister -> new risks
    await applySnapshot(page, snapshot);
    await wait(page, 300);
    const lifted = JSON.parse(JSON.stringify(snapshot));
    for (const a of lifted.animals) if (a.contra) a.contra = false;
    lifted.seq = 2;
    await applySnapshot(page, lifted);
    await wait(page, 600);
    facts.alerts = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kinToast')].map(t => t.innerText.replace(/\s+/g, ' ').slice(0, 160)));
    if (!facts.alerts.some(t => /New inbreeding risk|new related pairs/i.test(t))) problems.push('no alert for the new risk: ' + JSON.stringify(facts.alerts));
    await ctx.shot(page, 'kh_8_alerts');
    await applySnapshot(page, snapshot);

    facts.problems = problems;
    if (problems.length) throw new Error('kin hud: ' + problems.join('; '));
    return facts;
}
