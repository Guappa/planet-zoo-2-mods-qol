// Kin in Compare Mates (park and hub) and the Genealogy popup (park).
//
// HUD: the park fixture (kin_fixture.mjs) plants a family in the first
// habitat; the Compare Mates and Genealogy DataStore rows are rewritten to
// point at those animals (Lua's row ids: 'animal_<entityID>_0', relatives
// by GUID), and the popups are opened with the game's own listeners
// (PopupAction_SetDataCompareMates / PopupAction_ShowGeneaologyPopup).
// Frontend: the hub's Compare Mates with stored animals ('animal_<guid>_2')
// against the storage kin model (kin_storage.mjs seeds it).
import { seedZooKin } from './kin_fixture.mjs';
import { seedStorageKin } from './kin_storage.mjs';

const lit = s => '[STRING_LITERAL:Value=|' + s + '|]';

// Writes Compare Mates rows: list -> [{ id, name, gender }]. Rows beyond
// the given ones become market listings (no lineage).
async function fillCompareMates(page, lists) {
    return page.evaluate(async lists => {
        const DS = await import('/js/common/core/DataStore.js');
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const keys = {};
        for (const list of ['mothers', 'fathers']) {
            const col = new DataStoreCollection(['compareMates', list]);
            await new Promise(r => setTimeout(r, 100));
            keys[list] = [];
            col._source.forEach((ctx, i) => {
                const a = lists[list][i] || { id: `animal_${900 + i}_7`, name: 'Listing ' + i, gender: list === 'mothers' ? 1 : 0 };
                DS.setValue(ctx, 'id', a.id);
                DS.setValue(ctx, 'name', a.name);
                DS.setValue(ctx, 'gender', a.gender);
                keys[list].push({ key: ctx[ctx.length - 1], id: a.id, name: a.name });
            });
            col.dispose();
        }
        return keys;
    }, lists);
}

// Candidate rows on screen for one side: [{ name, rel, sev }]
const candidateRows = (page, side) => page.evaluate(side => {
    return [...document.querySelectorAll(`.ParentDisplay_root.${side} .AnimalListButton_root`)].map(r => {
        const b = r.querySelector('.PZ2QoL_kmRel');
        const name = r.querySelector('.ParentListItem_leftChildren');
        return {
            name: name ? name.childNodes[0] && name.childNodes[0].textContent : null,
            rel: b ? b.textContent : null,
            sev: b ? (b.className.match(/sev_(\w+)/) || [])[1] : null,
            top: Math.round(r.getBoundingClientRect().top),
        };
    }).sort((a, b) => a.top - b.top);
}, side);

async function openMates(page, mother, father) {
    await page.evaluate(() => engine.trigger('PopupAction_SetDataCompareMates', null));
    await page.waitForTimeout(250);
    await page.evaluate(d => engine.trigger('PopupAction_SetDataCompareMates', d), { mother: mother || '', father: father || '' });
    await page.waitForTimeout(900);
}

const offspringLine = page => page.evaluate(() => {
    const o = document.querySelector('.PZ2QoL_kmOffspring');
    if (!o) return null;
    const box = o.getBoundingClientRect();
    const host = document.querySelector('.OffspringDisplay_root').getBoundingClientRect();
    return { text: o.textContent, sev: (o.className.match(/sev_(\w+)/) || [])[1], below: box.top >= host.bottom - 1, bottom: Math.round(box.bottom) };
});

async function hoverCenter(page, selector) {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) return false;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 25);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
    await page.waitForTimeout(400);
    return true;
}

const cardText = page => page.evaluate(() => { const c = document.querySelector('.PZ2QoL_kinCard:not(.hidden)'); return c ? c.textContent : null; });

export async function hud(page, ctx) {
    const facts = ctx.facts || {};
    const problems = [];
    // the fixture reads the zoo management Animals list
    await page.evaluate(() => engine.trigger('World_ShowHUD'));
    await page.waitForTimeout(600);
    await page.evaluate(() => engine.trigger('Management_SetManagementIndex', 7));
    await page.waitForSelector('.ManagementAnimals_root', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);
    const { snapshot, layout } = await seedZooKin(page);
    // Compare Mates hides the HUD in game; close management so its toolbar is not on top
    await page.evaluate(() => engine.trigger('Management_SetManagementIndex', -1));
    await page.waitForTimeout(500);

    const hab = layout.filter(l => l.hab === '9000');
    const byN = n => hab.find(l => l.n === n);
    const animal = l => snapshot.animals.find(a => a.id === l.id);
    const row = (n, sex) => ({ id: `animal_${byN(n).id}_0`, name: animal(byN(n)).name, gender: sex });
    // r0 father, r1 mother, r2 son, r3 daughter, r4 half-sister of r2,
    // r5 cousin of r2, r7 unrelated female, r8 unrelated male
    const names = Object.fromEntries([0, 1, 2, 3, 4, 5, 7, 8].map(n => [n, animal(byN(n)).name]));
    facts.names = names;
    const keys = await fillCompareMates(page, {
        mothers: [row(1, 1), row(3, 1), row(4, 1), row(5, 1), row(7, 1)],
        fathers: [row(0, 0), row(2, 0), row(8, 0)],
    });

    // 1. father = r2 chosen, mothers list: badges against r2
    await openMates(page, '', keys.fathers[1].key);
    let rows = await candidateRows(page, 'mother');
    facts.mothersVsR2 = rows.map(r => `${r.name}: ${r.rel || '-'}${r.sev ? ' (' + r.sev + ')' : ''}`);
    const want = { [names[1]]: ['Mother', 'risk'], [names[3]]: ['Sister', 'risk'], [names[4]]: ['Half-sister', 'risk'], [names[5]]: ['Cousin', 'kin'], [names[7]]: [null, null] };
    for (const [name, [rel, sev]] of Object.entries(want)) {
        const r = rows.find(x => x.name === name);
        if (!r) problems.push(`mother row ${name} not shown`);
        else if (r.rel !== rel || r.sev !== sev) problems.push(`${name}: ${r.rel}/${r.sev}, want ${rel}/${sev}`);
    }
    await ctx.shot(page, 'km_candidates');
    // card on hover
    await hoverCenter(page, '.ParentDisplay_root.mother .PZ2QoL_kmRel.sev_kin');
    facts.cousinCard = await cardText(page);
    if (!facts.cousinCard || !/does NOT warn/.test(facts.cousinCard)) problems.push('cousin card: ' + facts.cousinCard);
    await ctx.shot(page, 'km_card');
    await page.mouse.move(960, 1070);
    await page.waitForTimeout(300);

    // 2. "Unrelated first"
    await page.locator('.ParentDisplay_root.mother .PZ2QoL_kmSort').click();
    await page.waitForTimeout(700);
    rows = await candidateRows(page, 'mother');
    facts.sorted = rows.map(r => r.name);
    if (rows[0] && rows[0].name !== names[7]) problems.push('unrelated first: first row is ' + rows[0].name);
    if (rows[1] && rows[1].name !== names[5]) problems.push('unrelated first: second row should be the cousin, is ' + rows[1].name);
    await ctx.shot(page, 'km_sorted');
    await page.locator('.ParentDisplay_root.mother .PZ2QoL_kmSort').click();
    await page.waitForTimeout(700);
    rows = await candidateRows(page, 'mother');
    if (rows[0] && rows[0].name !== names[1]) problems.push('sort off: game order not restored, first is ' + rows[0].name);

    // 3. pick the cousin: the offspring box gets the kin line
    const cousinRow = page.locator('.ParentDisplay_root.mother .AnimalListButton_root', { hasText: names[5] }).first();
    await cousinRow.click({ position: { x: 120, y: 20 } });
    await page.waitForTimeout(900);
    facts.cousinPair = await offspringLine(page);
    facts.state = await page.evaluate(async () => (await import('/js/mods/pz2qol/kinmates.js'))._matesState());
    if (!facts.cousinPair || !/First cousins/.test(facts.cousinPair.text) || !/NOT warn/.test(facts.cousinPair.text)) problems.push('cousin offspring line: ' + JSON.stringify(facts.cousinPair));
    else if (!facts.cousinPair.below) problems.push('offspring line overlaps the box');
    await ctx.shot(page, 'km_offspring_cousins');

    // 4. full siblings, then an unrelated pair
    await openMates(page, keys.mothers[1].key, keys.fathers[1].key);
    facts.siblingPair = await offspringLine(page);
    if (!facts.siblingPair || !/Full siblings/.test(facts.siblingPair.text) || facts.siblingPair.sev !== 'risk') problems.push('sibling line: ' + JSON.stringify(facts.siblingPair));
    await ctx.shot(page, 'km_offspring_siblings');
    await openMates(page, keys.mothers[4].key, keys.fathers[1].key);
    facts.unrelatedPair = await offspringLine(page);
    if (!facts.unrelatedPair || !/Not related/.test(facts.unrelatedPair.text)) problems.push('unrelated line: ' + JSON.stringify(facts.unrelatedPair));
    await page.evaluate(() => engine.trigger('PopupAction_SetDataCompareMates', null));
    await page.waitForTimeout(400);

    // 5. Genealogy of r2: parents r0 r1, siblings r3 r4 + unknown + gone, mate r3, young r6
    const g = n => 'g' + byN(n).id;
    await page.evaluate(async ({ status, lists, lit }) => {
        const DS = await import('/js/common/core/DataStore.js');
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        DS.setValue(['genealogy', 'animalStatus'], 'name', status);
        for (const [list, items] of Object.entries(lists)) {
            const col = new DataStoreCollection(['genealogy', list, 'dataProvider']);
            await new Promise(r => setTimeout(r, 80));
            const src = col._source.slice();
            src.forEach((ctx, i) => {
                if (i >= items.length) return DS.deleteContext(ctx);
                DS.setValue(ctx, 'id', items[i].id);
                DS.setValue(ctx, 'name', items[i].name);
                DS.setValue(ctx, 'gender', items[i].gender);
            });
            col.dispose();
        }
    }, {
        status: lit(names[2]),
        lit: null,
        lists: {
            parents: [{ id: g(0), name: lit(names[0]), gender: 0 }, { id: g(1), name: lit(names[1]), gender: 1 }],
            siblings: [{ id: g(3), name: lit(names[3]), gender: 1 }, { id: g(4), name: lit(names[4]), gender: 1 }, { id: 'unknown', name: '[InfoPanel_Animal_UnknownMother]', gender: 1 }, { id: 'g424242', name: lit('Gone'), gender: 0 }],
            mates: [{ id: g(3), name: lit(names[3]), gender: 1 }],
            offsprings: [{ id: g(6), name: lit(animal(byN(6)).name), gender: 1 }],
        },
    });
    await page.evaluate(() => engine.trigger('PopupAction_ShowGeneaologyPopup', true));
    await page.waitForTimeout(1200);
    const genRows = () => page.evaluate(ids => ids.map(id => {
        const r = document.getElementById(id);
        if (!r) return { id, shown: false };
        const place = r.querySelector('.PZ2QoL_kmPlace');
        const kin = r.querySelector('.PZ2QoL_kin');
        return { id, place: place ? place.textContent : null, sev: kin ? (kin.className.match(/sev_(\w+)/) || [])[1] : null };
    }), [g(0), g(1), g(3), g(4), 'g424242', g(6)]);
    let gen = await genRows();
    facts.genealogyR2 = gen;
    const gwant = { [g(0)]: ['Savannah Habitat', null], [g(1)]: ['Savannah Habitat', 'risk'], [g(3)]: ['Savannah Habitat', 'risk'], [g(4)]: ['Savannah Habitat', 'covered'], g424242: ['Not in the zoo', null], [g(6)]: ['Savannah Habitat', 'future'] };
    for (const r of gen) {
        const [place, sev] = gwant[r.id];
        if (r.shown === false) problems.push(`genealogy row ${r.id} missing`);
        else if (r.place !== place || r.sev !== sev) problems.push(`genealogy ${r.id}: ${r.place}/${r.sev}, want ${place}/${sev}`);
    }
    facts.summary = await page.evaluate(() => { const l = document.querySelector('.GenealogyPopup_left .PZ2QoL_kmGenLine'); return l ? l.textContent : null; });
    if (!facts.summary || !/inbreeding risk/.test(facts.summary)) problems.push('genealogy summary line: ' + facts.summary);
    await ctx.shot(page, 'km_genealogy');
    if (await hoverCenter(page, '.GenealogyPopup_left .PZ2QoL_kmGenLine')) {
        facts.summaryCard = (await cardText(page) || '').slice(0, 200);
        await ctx.shot(page, 'km_genealogy_card');
        await page.mouse.move(960, 1070);
    }

    // 6. re-centre on the sister (as Lua would: new name, then the event), then Back
    await page.evaluate(n => import('/js/common/core/DataStore.js').then(DS => DS.setValue(['genealogy', 'animalStatus'], 'name', n)), lit(names[3]));
    await page.evaluate(id => engine.trigger('Genealogy_UI_Select', id), g(3));
    await page.waitForTimeout(600);
    gen = await genRows();
    facts.genealogyR3 = gen.map(r => `${r.id}:${r.sev}`);
    // r3's pairs: father r0 and brother r2 (r2 is not listed here)
    if ((gen.find(r => r.id === g(0)) || {}).sev !== 'risk') problems.push('re-centred on the sister: father should be a risk');
    if ((gen.find(r => r.id === g(1)) || {}).sev) problems.push('re-centred on the sister: mother (same sex) should have no badge');
    await page.evaluate(n => import('/js/common/core/DataStore.js').then(DS => DS.setValue(['genealogy', 'animalStatus'], 'name', n)), lit(names[2]));
    await page.evaluate(() => engine.trigger('Genealogy_UI_Back'));
    await page.waitForTimeout(600);
    facts.back = await page.evaluate(async () => (await import('/js/mods/pz2qol/kinmates.js'))._matesState());
    gen = await genRows();
    if ((gen.find(r => r.id === g(1)) || {}).sev !== 'risk') problems.push('after Back: mother should be a risk again');
    await page.evaluate(() => engine.trigger('PopupAction_ShowGeneaologyPopup', false));
    await page.waitForTimeout(300);

    facts.problems = problems;
    if (problems.length) throw new Error('kin mates (HUD): ' + problems.join('; '));
    return facts;
}

export async function frontend(page, ctx) {
    const facts = ctx.facts || {};
    const problems = [];
    await ctx.gotoMarketTab(page, 1);
    const seeded = await seedStorageKin(page);
    const s = i => seeded[i];
    const row = (i, gender) => ({ id: `animal_${s(i).guid}_2`, name: s(i).name, gender });
    // mothers: Ama (mother), Zuri (sister), Nia (half-sister), Lulu (cousin), a market listing
    const keys = await fillCompareMates(page, {
        mothers: [row(1, 1), row(3, 1), row(4, 1), row(5, 1)],
        fathers: [row(0, 0), row(2, 0), row(6, 0)],
    });
    await openMates(page, '', keys.fathers[1].key); // Tau chosen
    const rows = await candidateRows(page, 'mother');
    facts.mothersVsTau = rows.map(r => `${r.name}: ${r.rel || '-'}`);
    const want = { Ama: 'Mother', Zuri: 'Sister', Nia: 'Half-sister', Lulu: 'Cousin' };
    for (const [name, rel] of Object.entries(want)) {
        const r = rows.find(x => x.name === name);
        if (!r || r.rel !== rel) problems.push(`hub ${name}: ${r && r.rel}, want ${rel}`);
    }
    if (rows.some(r => /^Listing/.test(r.name || '') && r.rel)) problems.push('a market listing got a kin badge');
    await ctx.shot(page, 'km_hub_candidates');
    await openMates(page, keys.mothers[1].key, keys.fathers[1].key); // Zuri x Tau
    facts.hubPair = await offspringLine(page);
    if (!facts.hubPair || !/Full siblings/.test(facts.hubPair.text)) problems.push('hub offspring line: ' + JSON.stringify(facts.hubPair));
    await ctx.shot(page, 'km_hub_offspring');
    await page.evaluate(() => engine.trigger('PopupAction_SetDataCompareMates', null));
    await page.waitForTimeout(400);
    facts.problems = problems;
    if (problems.length) throw new Error('kin mates (hub): ' + problems.join('; '));
    return facts;
}
