// Kin in Animal Storage (hub page): row badges, the "Related" toolbar chip,
// and the info panel warning before Send to Zoo.
//
// The storage rows' dummy data is rewritten into one lion family (plus an
// unrelated lion and a tiger), and a scope 'storage' kin snapshot keyed by
// the rows' ids is applied, as the Lua side (PZ2QoL_KinStorage) would.

// index -> family member. Guids 's<i>'; parents per the comments.
export const STORAGE_FAMILY = [
    { name: 'Kito', sex: 0, species: 'Lion', par: ['gGP', 'gGM'] },  // 0 father
    { name: 'Ama', sex: 1, species: 'Lion', par: [] },               // 1 mother
    { name: 'Tau', sex: 0, species: 'Lion', par: ['s0', 's1'] },     // 2 son
    { name: 'Zuri', sex: 1, species: 'Lion', par: ['s0', 's1'] },    // 3 daughter: full sister of Tau
    { name: 'Nia', sex: 1, species: 'Lion', par: ['s0', 'gX'] },     // 4 half-sister of Tau
    { name: 'Lulu', sex: 1, species: 'Lion', par: ['gP2', 'gQ'] },   // 5 cousin of Tau (gP2 = Kito's sister)
    { name: 'Bomu', sex: 0, species: 'Lion', par: [] },              // 6 unrelated
    { name: 'Kesi', sex: 1, species: 'Lion', par: ['s2', 'gQ'], juv: true }, // 7 Tau's young daughter
    { name: 'Rafi', sex: 0, species: 'Tiger', par: [] },             // 8 other species
];
export const RELATED_COUNT = 7; // all but Bomu and Rafi

// Rewrites the first storage rows and applies the matching snapshot.
// Returns [{ key, id, name, guid }].
export async function seedStorageKin(page) {
    return page.evaluate(async family => {
        const DS = await import('/js/common/core/DataStore.js');
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const col = new DataStoreCollection(['hubAnimalsData', 'animalStorageData', 'list']);
        for (let i = 0; i < 50 && col._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        const out = [];
        const animals = [];
        col._source.slice(0, family.length).forEach((ctx, i) => {
            const f = family[i];
            DS.setValue(ctx, 'name', '[STRING_LITERAL:Value=|' + f.name + '|]');
            DS.setValue(ctx, 'species', '[Animal_' + f.species + ']');
            DS.setValue(ctx, 'gender', f.sex);
            DS.setValue(ctx, 'maturity', f.juv ? 0 : 2);
            DS.setValue(ctx, 'isPregnant', false);
            DS.setValue(ctx, 'isShoal', false); // Kin leaves shoals out
            DS.setValue(ctx, 'auctionTimerSeconds', -1);
            const id = String(DS.getValue(ctx, 'id'));
            out.push({ key: ctx[ctx.length - 1], id, name: f.name, guid: 's' + i });
            animals.push({ id, key: id, guid: 's' + i, name: f.name, species: f.species, sex: f.sex, juv: !!f.juv, preg: false, par: f.par, hab: '' });
        });
        col.dispose();
        const kin = await import('/js/mods/pz2qol/kin.js');
        kin.setStorageRows(animals.map(a => ({ id: a.id, name: a.name, species: a.species, sex: a.sex, juv: a.juv, preg: false })));
        kin.applyKinSnapshot({ v: 1, seq: 7, scope: 'storage', habitats: [], animals, anc: { gGP: [], gGM: [], gP2: ['gGP', 'gGM'], gQ: [], gX: [] } });
        return out;
    }, STORAGE_FAMILY);
}

const visibleRows = page => page.evaluate(async () => {
    const DS = await import('/js/common/core/DataStore.js');
    const shown = el => { for (let n = el; n && n !== document.body; n = n.parentNode) { if (n.classList && n.classList.contains('hidden')) return false; } const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const rowCtx = el => {
        for (let n = el, d = 0; n && d < 5; n = n.parentNode, d++) {
            for (let c = n._component; c; c = c._component) if (c.props && Array.isArray(c.props.context)) return c.props.context;
        }
        return null;
    };
    return [...document.querySelectorAll('.MarketAnimalListItem_root')].filter(shown).map(r => {
        const ctx = rowCtx(r);
        const badge = r.querySelector('.PZ2QoL_ksRow');
        return {
            id: ctx ? String(DS.getValue(ctx, 'id')) : null,
            top: Math.round(r.getBoundingClientRect().top),
            kin: badge ? { text: badge.textContent, sev: (badge.className.match(/sev_(\w+)/) || [])[1] } : null,
            score: !!r.querySelector('.MarketAnimalListItem_listRoot > .PZ2QoL_badge'),
        };
    }).sort((a, b) => a.top - b.top);
});

const listLength = page => page.evaluate(async () => {
    const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
    const c = new DataStoreCollection(['hubAnimalsData', 'animalStorageData', 'list']);
    await new Promise(r => setTimeout(r, 150));
    const n = c.source.length;
    c.dispose();
    return n;
});

export async function frontend(page, ctx) {
    const facts = ctx.facts || {};
    const problems = [];
    await ctx.gotoMarketTab(page, 1);
    const seeded = await seedStorageKin(page);
    facts.seeded = seeded.map(s => s.id + '=' + s.name);
    await page.waitForTimeout(1500); // poller (1 s) + row re-render
    // the poller must have asked Lua for the stored animals' lineage
    facts.storageState = await page.evaluate(async () => (await import('/js/mods/pz2qol/kinstorage.js'))._storageState());
    if (!facts.storageState.lastIds) problems.push('storage poller never asked for lineage');
    // rows re-render on DS changes; nudge with a refresh in case
    await page.evaluate(async () => (await import('/js/mods/pz2qol/listfilter.js')).refreshList('hubAnimalsData/animalStorageData/list'));
    await page.waitForTimeout(600);

    // 1. row badges
    let rows = await visibleRows(page);
    const byId = new Map(rows.map(r => [r.id, r]));
    facts.rowBadges = seeded.map(s => ({ name: s.name, kin: byId.get(s.id) ? byId.get(s.id).kin : 'row not visible' }));
    const expect = { Kito: 'risk', Ama: 'risk', Tau: 'risk', Zuri: 'risk', Nia: 'risk', Lulu: 'kin', Kesi: 'future', Bomu: null, Rafi: null };
    for (const s of seeded) {
        const r = byId.get(s.id);
        if (!r) continue;
        const want = expect[s.name];
        const got = r.kin ? r.kin.sev : null;
        if (want !== got) problems.push(`${s.name}: badge ${got} (want ${want})`);
        if (!r.score) problems.push(`${s.name}: score badge missing`);
    }
    if (!byId.get(seeded[2].id) || !/Related\s*6/.test(byId.get(seeded[2].id).kin && byId.get(seeded[2].id).kin.text || '')) problems.push('Tau should read "Related 6": ' + JSON.stringify(byId.get(seeded[2].id)));
    await ctx.shot(page, 'ks_rows');

    // 2. card on hover
    const at = await page.evaluate(async id => {
        const DS = await import('/js/common/core/DataStore.js');
        for (const r of document.querySelectorAll('.MarketAnimalListItem_root')) {
            for (let c = r._component; c; c = c._component) {
                if (c.props && Array.isArray(c.props.context) && String(DS.getValue(c.props.context, 'id')) === id) {
                    const b = r.querySelector('.PZ2QoL_ksRow');
                    if (!b) return null;
                    const box = b.getBoundingClientRect();
                    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
                }
            }
        }
        return null;
    }, seeded[2].id);
    if (at) {
        await page.mouse.move(at.x, at.y + 30);
        await page.mouse.move(at.x, at.y, { steps: 3 });
    }
    await page.waitForTimeout(400);
    facts.card = await page.evaluate(() => { const c = document.querySelector('.PZ2QoL_kinCard:not(.hidden)'); return c ? c.textContent.slice(0, 400) : null; });
    if (!facts.card || !/Related to/.test(facts.card)) problems.push('row card did not open: ' + facts.card);
    await ctx.shot(page, 'ks_card');
    await page.mouse.move(960, 1060);
    await page.waitForTimeout(300);

    // 3. "Related" chip
    facts.listBefore = await listLength(page);
    const chip = page.locator('.PZ2QoL_bar.storage .PZ2QoL_chip', { hasText: /^Kin/ });
    facts.chipText = await chip.innerText().catch(() => null);
    if (!facts.chipText || !new RegExp(String(RELATED_COUNT)).test(facts.chipText)) problems.push('Kin chip count wrong: ' + facts.chipText);
    await chip.click();
    await page.waitForTimeout(900);
    facts.listRelated = await listLength(page);
    if (facts.listRelated !== RELATED_COUNT) problems.push(`Kin filter shows ${facts.listRelated}, want ${RELATED_COUNT}`);
    rows = await visibleRows(page);
    facts.relatedRowsWithoutBadge = rows.filter(r => !r.kin).map(r => r.id);
    if (facts.relatedRowsWithoutBadge.length) problems.push('rows without a relative shown under Kin: ' + facts.relatedRowsWithoutBadge);
    await ctx.shot(page, 'ks_related');
    await chip.click();
    await page.waitForTimeout(900);
    facts.listAfter = await listLength(page);
    if (facts.listAfter !== facts.listBefore) problems.push(`list not restored: ${facts.listAfter} vs ${facts.listBefore}`);

    // 4. info panel warning for a selection with a related pair
    const keys = [seeded[2].key, seeded[3].key, seeded[6].key]; // Tau, Zuri, Bomu
    await page.evaluate(async keys => {
        const DS = await import('/js/common/core/DataStore.js');
        for (const k of keys) {
            DS.setValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'multiSelected', true);
            // dummy data: a "moving" animal makes the panel show Cancel instead
            DS.setValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'isMoving', false);
        }
        DS.setValue(['hubAnimalsData', 'animalStorageData', 'actions'], 'sendToZooAllowed', true);
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', keys);
    }, keys);
    await page.waitForTimeout(900);
    facts.warning = await page.evaluate(() => {
        const w = document.querySelector('.AnimalStorageInfoPanel_root .PZ2QoL_ksWarn');
        if (!w) return null;
        // the warning must come right before the Send to Zoo row
        const next = w.nextElementSibling;
        return { text: w.textContent, sev: (w.className.match(/sev_(\w+)/) || [])[1], nextText: next ? next.textContent.slice(0, 80) : null, height: Math.round(w.getBoundingClientRect().height) };
    });
    if (!facts.warning) problems.push('no storage panel warning for Tau + Zuri');
    else {
        if (!/Tau ♂ and Zuri ♀ are full siblings/.test(facts.warning.text)) problems.push('warning text: ' + facts.warning.text);
        if (!/SendToZoo/.test(facts.warning.nextText || '')) problems.push('warning not before Send to Zoo: ' + facts.warning.nextText);
    }
    await ctx.shot(page, 'ks_warning');
    // only an unrelated pair: no warning
    await page.evaluate(async keys => {
        const DS = await import('/js/common/core/DataStore.js');
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', keys);
    }, [seeded[3].key, seeded[6].key]);
    await page.waitForTimeout(700);
    facts.warningUnrelated = await page.evaluate(() => !!document.querySelector('.AnimalStorageInfoPanel_root .PZ2QoL_ksWarn'));
    if (facts.warningUnrelated) problems.push('warning shown for an unrelated pair');
    await page.evaluate(async keys => {
        const DS = await import('/js/common/core/DataStore.js');
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', []);
        for (const k of keys) DS.setValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'multiSelected', false);
    }, keys);

    // 5. the toolbar steps aside for the game's own layers (Nexus report
    // 2026-10-20): the search box's suggestions and the Zoopedia modal
    const barShown = () => page.evaluate(() => {
        const b = document.querySelector('.PZ2QoL_bar.storage');
        return !!b && b.style.display !== 'none';
    });
    const addLayer = html => page.evaluate(html => {
        let lc = document.querySelector('.LayerCollection');
        if (!lc) {
            lc = document.createElement('div');
            lc.className = 'LayerCollection';
            lc.style.position = 'absolute';
            document.body.appendChild(lc);
        }
        const l = document.createElement('div');
        l.className = 'Layer_root PZ2QoL_testLayer';
        l.innerHTML = html;
        lc.appendChild(l);
    }, html);
    const dropLayers = () => page.evaluate(() => document.querySelectorAll('.PZ2QoL_testLayer').forEach(n => n.remove()));
    facts.barBefore = await barShown();
    if (!facts.barBefore) problems.push('storage toolbar not shown before the layer checks');
    await addLayer('<div class="Layer_background"></div><div class="InputField_resultsMenu" style="width:300px;height:200px">Lion</div>');
    await page.waitForTimeout(400);
    facts.barUnderSuggestions = await barShown();
    if (facts.barUnderSuggestions) problems.push('toolbar still over the search suggestions');
    await dropLayers();
    await page.waitForTimeout(400);
    if (!(await barShown())) problems.push('toolbar not back after the suggestions closed');
    await addLayer('<div class="Layer_background darken" style="width:100%;height:100%"></div><div class="ZoopediaModule_root" style="width:800px;height:600px"></div>');
    await page.waitForTimeout(400);
    facts.barUnderZoopedia = await barShown();
    if (facts.barUnderZoopedia) problems.push('toolbar still over the Zoopedia');
    await dropLayers();
    await page.waitForTimeout(400);
    if (!(await barShown())) problems.push('toolbar not back after the Zoopedia closed');

    facts.problems = problems;
    if (problems.length) throw new Error('kin storage: ' + problems.join('; '));
    return facts;
}
