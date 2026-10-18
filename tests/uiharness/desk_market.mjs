// Browser-harness scenario: the Market desk (marketdesk.js) and the price
// panel's Sell, both through a fake Lua listing engine in the page
// (PZ2QoL_ListerHello / _Resolve / _Start / _Stop answered like
// pz2qol.lister.lua would). Checks: the desk opens from the price panel's button,
// the engine pill, species rail, rows and their states, ticking, the job
// text the engine gets (GUIDs, keys, prices, hours, pace), progress and
// results per row, a refusal and Retry, Stop, the old click path is never
// used while the engine answers, the fallback pill when it does not,
// layout, Esc.

export const name = 'market desk';

async function click(locator) {
    try {
        await locator.first().click({ timeout: 2500 });
    }
    catch (e) {
        await locator.first().dispatchEvent('click');
    }
}

const layout = page => page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const out = { outside: [], overlaps: [], textOverflow: [] };
    const root = document.querySelector('.PZ2QoL_md');
    if (!root || !root.getBoundingClientRect().width) return out;
    const clipped = el => {
        const r = el.getBoundingClientRect();
        let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
                const q = n.getBoundingClientRect();
                x0 = Math.max(x0, q.left); y0 = Math.max(y0, q.top); x1 = Math.min(x1, q.right); y1 = Math.min(y1, q.bottom);
            }
        }
        return { x0, y0, x1, y1 };
    };
    for (const el of [root, ...root.querySelectorAll('*')]) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const c = clipped(el);
        if (c.x1 <= c.x0 || c.y1 <= c.y0) continue;
        if (c.x0 < -0.5 || c.y0 < -0.5 || c.x1 > vw + 0.5 || c.y1 > vh + 0.5) out.outside.push(String(el.className));
    }
    const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    for (const sel of ['.PZ2QoL_md > *', '.PZ2QoL_md .PZ2QoL_kpHead > *', '.PZ2QoL_mdBody > *', '.PZ2QoL_mdSide > *', '.PZ2QoL_mdRow.head > *']) {
        const g = [...document.querySelectorAll(sel)].filter(e => !e.classList.contains('PZ2QoL_kpFlex') && e.getBoundingClientRect().width);
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (hit(g[i].getBoundingClientRect(), g[j].getBoundingClientRect())) out.overlaps.push(`${g[i].className} x ${g[j].className}`);
    }
    for (const el of root.querySelectorAll('.PZ2QoL_kpBtn, .PZ2QoL_kpTitle, .PZ2QoL_mdSegItem, .PZ2QoL_mdEnginePill')) {
        if (el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 1) out.textOverflow.push(`${el.className}: ${el.innerText.trim().slice(0, 40)}`);
    }
    return out;
});

function layoutProblems(tag, l, problems) {
    if (l.outside.length) problems.push(`${tag}: ${l.outside.length} element(s) outside the view, e.g. ${l.outside.slice(0, 3).join('; ')}`);
    if (l.overlaps.length) problems.push(`${tag}: overlapping ${l.overlaps.slice(0, 3).join('; ')}`);
    if (l.textOverflow.length) problems.push(`${tag}: text overflows ${l.textOverflow.slice(0, 3).join('; ')}`);
}

// The fake engine: GUIDs from the row ids, a run that walks the steps on
// timers, lists into the DataStore, refuses one animal.
async function installFakeEngine(page) {
    await page.evaluate(async () => {
        const DS = await import('/js/common/core/DataStore.js');
        const LIST = ['hubAnimalsData', 'animalStorageData', 'list'];
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const col = new DataStoreCollection(LIST);
        for (let i = 0; i < 50 && col._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        const keysNow = () => col._source.map(c => c[c.length - 1]);
        const f = window.__md = { active: true, hellos: 0, resolves: 0, jobs: [], stops: 0, adds: 0, refuseNth: 2, stepMs: 120, keys: keysNow };
        for (const n of ['PZ2QoL_ListerHello', 'PZ2QoL_ListerResolve', 'PZ2QoL_ListerStart', 'PZ2QoL_ListerStop', 'PZ2QoL_ListerPace']) if (engine.events) engine.events[n] = [];
        if (!window.__mdAddHook) {
            window.__mdAddHook = true;
            engine.on('AnimalStorage_AddToMarket', () => { if (window.__md) window.__md.adds++; });
        }
        const guidOf = key => {
            const id = DS.getValue(LIST.concat(key), 'id');
            return id == undefined ? null : String(900000000000000000n + BigInt(String(id).replace(/\D/g, '') || 0));
        };
        window.__mdGuid = guidOf;
        engine.on('PZ2QoL_ListerHello', req => {
            if (!f.active) return;
            f.hellos++;
            const rows = document.querySelectorAll('.MarketAnimalListItem_root').length;
            setTimeout(() => engine.trigger('PZ2QoL_ListerCaps', req, JSON.stringify({ ok: true, missing: [], storage: true, online: true, rows: Math.max(1, rows), running: !!f.running, version: 1 })), 20);
        });
        engine.on('PZ2QoL_ListerResolve', (req, csv) => {
            if (!f.active) return;
            f.resolves++;
            const ids = {}, rows = {};
            for (const k of String(csv).split(',')) {
                const g = guidOf(k);
                if (!g) continue;
                ids[k] = g;
                // what the row holds, read with the GUID (as the engine does)
                const at = p => DS.getValue(LIST.concat(k), p);
                rows[k] = { name: at('name'), species: at('species'), gender: at('gender') };
            }
            setTimeout(() => engine.trigger('PZ2QoL_ListerIds', req, JSON.stringify({ ids, rows, failed: [] })), 20);
        });
        // the market check (Lua's MarketPeek): every species answers at once,
        // one page, then 'done' on release; no cooldown between species here
        window.__PZ2QOL_TEST_PEEK_GAP_MS = 50;
        engine.__harness = true;
        f.peeks = [];
        if (!window.__mdPeekHook) {
            window.__mdPeekHook = true;
            engine.on('PZ2QoL_MarketPeek', uid => {
                if (!window.__md || !window.__md.active) return;
                window.__md.peeks.push(uid);
                DS.setValue(['hubAnimalsData', 'animalMarketData'], 'pages', 1);
                DS.setValue(['hubAnimalsData', 'animalMarketData'], 'pageIndex', 0);
                setTimeout(() => engine.trigger('PZ2QoL_MarketPeekState', 'loading', ''), 20);
                setTimeout(() => engine.trigger('PZ2QoL_MarketPeekState', 'ready', ''), 80);
            });
            engine.on('PZ2QoL_MarketPeekRelease', () => {
                if (!window.__md || !window.__md.active) return;
                setTimeout(() => engine.trigger('PZ2QoL_MarketPeekState', 'done', 'ok'), 30);
            });
        }
        f.seen = [];
        if (!window.__mdSeenHook) {
            window.__mdSeenHook = true;
            engine.on('PZ2QoL_ListerSeen', (req, text) => { if (window.__md) window.__md.seen.push([req, String(text)]); });
        }
        engine.on('PZ2QoL_ListerStop', () => {
            f.stops++;
            f.stopRequested = true;
        });
        engine.on('PZ2QoL_ListerStart', (req, text) => {
            if (!f.active) return;
            const lines = String(text).split('\n');
            const items = lines.slice(1).map(l => {
                const [guid, key, price, hours] = l.split(' ');
                return { guid, key, price, hours };
            });
            f.jobs.push({ req, header: lines[0], items });
            f.running = true;
            f.stopRequested = false;
            const st = { run: f.jobs.length, req, phase: 'running', total: items.length, index: 0, step: 'server', waited: 0, paceMs: +lines[0].split(' ')[1], message: '',
                results: items.map(i => ({ guid: i.guid, status: 'pending', kind: '', price: null, hours: null, capped: null, usedDefault: false, detail: '' })) };
            const send = () => engine.trigger('PZ2QoL_ListerState', JSON.stringify(st));
            const steps = ['server', 'resolve', 'select', 'selected', 'send', 'confirm'];
            let i = 0, s = 0;
            const tick = () => {
                if (i >= items.length) {
                    st.phase = 'done';
                    st.step = '';
                    f.running = false;
                    send();
                    return;
                }
                if (f.stopRequested) {
                    st.phase = 'stopped';
                    st.step = '';
                    f.running = false;
                    send();
                    return;
                }
                st.index = i;
                const r = st.results[i];
                r.status = 'working';
                st.step = steps[s];
                send();
                // like the engine: once selected, ask the page what it sees
                if (steps[s] === 'select' && i === 0) {
                    const key = keysNow().find(k => guidOf(k) === items[i].guid);
                    if (key) {
                        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', [key]);
                        f.watchKey = key;
                        engine.trigger('PZ2QoL_ListerWatch', 'w1_1', key);
                    }
                }
                if (steps[s] === 'send' && i === 0) engine.trigger('PZ2QoL_ListerWatch', '', '');
                s++;
                if (s < steps.length) return setTimeout(tick, f.stepMs);
                // the outcome of this animal
                s = 0;
                const it = items[i];
                const price = it.price === '-' ? 500 : Math.min(+it.price, 4000);
                if (i + 1 === f.refuseNth) {
                    Object.assign(r, { status: 'refused', kind: 'refused', detail: 'NotAllowed' });
                }
                else {
                    Object.assign(r, { status: 'listed', kind: '', price, hours: it.hours === 'max' ? 12 : 6, capped: +it.price > 4000 ? 'max' : null, usedDefault: it.price === '-' });
                    const key = keysNow().find(k => guidOf(k) === it.guid);
                    if (key) {
                        DS.setValue(LIST.concat(key), 'auctionTimerSeconds', (it.hours === 'max' ? 12 : 6) * 3600);
                        DS.setValue(LIST.concat(key), 'auctionPrice', price);
                    }
                }
                i++;
                st.step = 'pause';
                send();
                setTimeout(tick, f.stepMs);
            };
            setTimeout(tick, 30);
        });
    });
}

export async function frontend(page, ctx) {
    const facts = ctx.facts || {};
    const problems = [];
    facts.problems = problems;
    await ctx.gotoMarketTab(page, 1);
    await page.evaluate(async () => {
        window.__PZ2QOL_TEST_FRANCHISE = true;
        const DS = await import('/js/common/core/DataStore.js');
        const LIST = ['hubAnimalsData', 'animalStorageData', 'list'];
        // known, sellable adults; one already listed; one juvenile
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const col = new DataStoreCollection(LIST);
        for (let i = 0; i < 50 && col._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        const keys = col._source.map(c => c[c.length - 1]);
        col.dispose();
        // two species, so the rail and a species with several sellable animals are tested
        const first = DS.getValue(LIST.concat(keys[0]), 'species');
        keys.forEach((k, i) => {
            if (i > 0 && i < 6) DS.setValue(LIST.concat(k), 'species', first);
            DS.setValue(LIST.concat(k), 'isMoving', false);
            DS.setValue(LIST.concat(k), 'isPregnant', false);
            DS.setValue(LIST.concat(k), 'isShoal', false);
            DS.setValue(LIST.concat(k), 'auctionTimerSeconds', i === 1 ? 5 * 3600 : -1);
            DS.setValue(LIST.concat(k), 'maturity', i === 2 ? 0 : 2);
        });
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', []);
    });
    await installFakeEngine(page);
    try {
        // 1. open from the price panel's button (the panel registry when the lister is off)
        await page.waitForSelector('.PZ2QoL_lister .PZ2QoL_deskBtn', { timeout: 6000 }).catch(() => {});
        if (await page.locator('.PZ2QoL_lister .PZ2QoL_deskBtn').count()) await click(page.locator('.PZ2QoL_lister .PZ2QoL_deskBtn'));
        else await page.evaluate(async () => (await import('/js/mods/pz2qol/kinpanel.js')).panelApi('desk').open());
        // the engine answers within a read or two; then every row has its GUID
        await page.waitForSelector('.PZ2QoL_md:not(.hidden) .PZ2QoL_mdRow[data-id^="g"]', { timeout: 8000 });
        await page.waitForTimeout(800);
        await ctx.shot(page, 'md_1_open');
        facts.open = await page.evaluate(() => ({
            pill: (document.querySelector('.PZ2QoL_mdEnginePill') || {}).innerText || '',
            species: [...document.querySelectorAll('.PZ2QoL_mdSpecies')].map(n => n.getAttribute('data-species')),
            rows: document.querySelectorAll('.PZ2QoL_mdRow[data-id]').length,
            guidRows: document.querySelectorAll('.PZ2QoL_mdRow[data-id^="g"]').length,
            storageRows: document.querySelectorAll('.MarketAnimalListItem_root').length,
            listedState: [...document.querySelectorAll('.PZ2QoL_mdCell.state.listed')].map(n => n.innerText),
            blocked: document.querySelectorAll('.PZ2QoL_mdRow.blocked').length,
            hellos: window.__md.hellos,
        }));
        if (!/Direct/.test(facts.open.pill)) problems.push(`engine pill: "${facts.open.pill}"`);
        if (facts.open.species[0] !== '' || facts.open.species.length < 2) problems.push(`species rail: ${JSON.stringify(facts.open.species)}`);
        if (!facts.open.rows || facts.open.guidRows !== facts.open.rows) problems.push(`rows ${facts.open.rows}, with a GUID ${facts.open.guidRows}`);
        if (!facts.open.listedState.some(t => /On market.*left/.test(t))) problems.push(`no "On market … left" state: ${JSON.stringify(facts.open.listedState)}`);
        if (facts.open.blocked < 2) problems.push(`blocked rows ${facts.open.blocked} (expected the listed one and the juvenile)`);
        facts.layoutOpen = await layout(page);
        layoutProblems('open', facts.layoutOpen, problems);

        // 1a. the price check sits above List; with nothing ticked on All species it says what to do
        facts.priceCard = await page.evaluate(() => (document.querySelector('.PZ2QoL_mdPriceCheck') || {}).innerText || '');
        if (!/Tick animals, then check/.test(facts.priceCard)) problems.push(`price check card with nothing ticked: "${facts.priceCard}"`);

        // 1b. filters: the dim layer, a gene range, More filters, Reset
        facts.scrim = await page.evaluate(() => {
            const n = document.querySelector('.PZ2QoL_mdScrim');
            const r = n && n.getBoundingClientRect();
            return n ? { shown: !n.classList.contains('hidden'), w: Math.round(r.width), h: Math.round(r.height) } : null;
        });
        if (!facts.scrim || !facts.scrim.shown || facts.scrim.w < 1000) problems.push(`scrim: ${JSON.stringify(facts.scrim)}`);
        const geneVals = () => page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_mdRow[data-id] .PZ2QoL_mdCell.genes')].map(n => n.innerText));
        const allRows = await page.evaluate(() => document.querySelectorAll('.PZ2QoL_mdRow[data-id]').length);
        await click(page.locator('.PZ2QoL_mdSeg.genes .PZ2QoL_mdSegItem', { hasText: '≤ 50' }));
        await page.waitForTimeout(300);
        facts.lowGenes = await geneVals();
        if (facts.lowGenes.some(v => !(+v <= 50))) problems.push(`genes ≤ 50 shows ${JSON.stringify(facts.lowGenes)}`);
        facts.shownText = await page.evaluate(() => (document.querySelector('.PZ2QoL_mdShown') || {}).innerText || '');
        if (!/^\d+ of \d+ shown$/.test(facts.shownText)) problems.push(`shown count: "${facts.shownText}"`);
        // sort by genes, worst first
        await click(page.locator('.PZ2QoL_mdRow.head .PZ2QoL_mdCell.genes'));
        await page.waitForTimeout(250);
        const worst = (await geneVals()).filter(v => v !== '–').map(Number);
        facts.worstFirst = worst;
        await click(page.locator('.PZ2QoL_md .PZ2QoL_kpBtn', { hasText: 'More filters' }));
        await page.waitForTimeout(300);
        facts.more = await page.evaluate(() => ({
            open: !!document.querySelector('.PZ2QoL_mdMore'),
            sliders: document.querySelectorAll('.PZ2QoL_mdMore .PZ2QoL_rng').length,
            text: !!document.querySelector('.PZ2QoL_mdMore input.PZ2QoL_mdText'),
            titles: [...document.querySelectorAll('.PZ2QoL_mdMoreTitle')].map(n => n.innerText),
        }));
        if (!facts.more.open || facts.more.sliders !== 5 || !facts.more.text) problems.push(`More filters: ${JSON.stringify(facts.more)}`);
        facts.layoutMore = await layout(page);
        layoutProblems('more', facts.layoutMore, problems);
        await ctx.shot(page, 'md_1b_filters');
        await click(page.locator('.PZ2QoL_md .PZ2QoL_kpBtn', { hasText: /^Reset/ }));
        await click(page.locator('.PZ2QoL_md .PZ2QoL_kpBtn', { hasText: 'More filters' }));
        await click(page.locator('.PZ2QoL_mdRow.head .PZ2QoL_mdCell.genes'));
        await page.waitForTimeout(300);
        facts.afterReset = await page.evaluate(() => document.querySelectorAll('.PZ2QoL_mdRow[data-id]').length);
        if (facts.afterReset !== allRows) problems.push(`after Reset ${facts.afterReset} rows, before ${allRows}`);
        if (worst.some((v, i) => i && v < worst[i - 1])) problems.push(`worst first not ascending: ${JSON.stringify(worst)}`);

        // 1c. ticks follow the view: ticks of one species go when another is picked
        const sps = facts.open.species.filter(s => s);
        await click(page.locator(`.PZ2QoL_mdSpecies[data-species="${sps[0]}"]`));
        await click(page.locator('.PZ2QoL_mdTools .PZ2QoL_kpBtn', { hasText: 'Tick all shown' }));
        await page.waitForTimeout(200);
        const tickedA = await page.evaluate(() => +(document.querySelector('.PZ2QoL_mdBig .n') || {}).innerText);
        await click(page.locator(`.PZ2QoL_mdSpecies[data-species="${sps[1]}"]`));
        await page.waitForTimeout(250);
        facts.ticksAfterSwitch = { before: tickedA, after: await page.evaluate(() => +(document.querySelector('.PZ2QoL_mdBig .n') || {}).innerText) };
        if (!(tickedA > 0) || facts.ticksAfterSwitch.after !== 0) problems.push(`ticks kept after switching species: ${JSON.stringify(facts.ticksAfterSwitch)}`);
        facts.toolOrder = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_mdTools.second > *')].map(n => n.innerText.trim().replace(/\s*\(\d+\)$/, '')));
        if (facts.toolOrder.slice(0, 4).join('|') !== 'Tick all shown|Untick shown|Reset|More filters') problems.push(`button order: ${JSON.stringify(facts.toolOrder)}`);

        // 2. a species, tick all sellable, list
        const sp = facts.open.species.find(s => s);
        await click(page.locator(`.PZ2QoL_mdSpecies[data-species="${sp}"]`));
        await page.waitForTimeout(300);
        await click(page.locator('.PZ2QoL_mdTools .PZ2QoL_kpBtn', { hasText: 'Tick all shown' }));
        await page.waitForTimeout(300);
        facts.ticked = await page.evaluate(() => ({
            on: document.querySelectorAll('.PZ2QoL_mdRow.on').length,
            sellableShown: [...document.querySelectorAll('.PZ2QoL_mdRow[data-id]')].filter(n => !n.classList.contains('blocked')).length,
            big: (document.querySelector('.PZ2QoL_mdBig .n') || {}).innerText,
            list: [...document.querySelectorAll('.PZ2QoL_mdSide .PZ2QoL_kpBtn')].map(n => n.innerText),
        }));
        if (!facts.ticked.on || facts.ticked.on !== facts.ticked.sellableShown) problems.push(`ticked ${facts.ticked.on} of ${facts.ticked.sellableShown} sellable`);
        await ctx.shot(page, 'md_2_ticked');
        // List waits for this species' price check (the button right above it)
        facts.gate = await page.evaluate(() => ({
            listDisabled: !!document.querySelector('.PZ2QoL_mdSide .PZ2QoL_kpBtn.primary.disabled'),
            check: (document.querySelector('.PZ2QoL_mdPriceCheck .PZ2QoL_kpBtn') || {}).innerText || '',
            status: (document.querySelector('.PZ2QoL_mdPriceStatus') || {}).innerText || '',
            order: [...document.querySelectorAll('.PZ2QoL_mdSide > *')].map(n => n.className.replace(/PZ2QoL_/g, '').split(' ')[0]),
        }));
        if (!facts.gate.listDisabled || !/^Check market prices/.test(facts.gate.check) || !/Needed before listing/.test(facts.gate.status)) problems.push(`List not waiting for the price check: ${JSON.stringify(facts.gate)}`);
        const io = facts.gate.order;
        if (!(io.indexOf('mdPriceCheck') >= 0 && io.indexOf('mdPriceCheck') === io.indexOf('kpBtn') - 1)) problems.push(`price check not right above List: ${JSON.stringify(io)}`);
        await click(page.locator('.PZ2QoL_mdPriceCheck .PZ2QoL_kpBtn', { hasText: /^Check market prices/ }));
        await page.waitForSelector('.PZ2QoL_mdSide .PZ2QoL_kpBtn.primary:not(.disabled)', { timeout: 8000 }).catch(() => {});
        facts.afterCheck = await page.evaluate(() => ({
            listDisabled: !!document.querySelector('.PZ2QoL_mdSide .PZ2QoL_kpBtn.primary.disabled'),
            status: (document.querySelector('.PZ2QoL_mdPriceStatus') || {}).innerText || '',
            peeks: window.__md.peeks.length,
        }));
        if (facts.afterCheck.listDisabled || !/Prices checked/.test(facts.afterCheck.status)) problems.push(`after the price check: ${JSON.stringify(facts.afterCheck)}`);
        await ctx.shot(page, 'md_2b_checked');
        await page.evaluate(() => { window.__md.stepMs = 90; });
        await click(page.locator('.PZ2QoL_mdSide .PZ2QoL_kpBtn', { hasText: /^List \d+/ }));
        await page.waitForSelector('.PZ2QoL_mdRun.running', { timeout: 4000 });
        await page.waitForTimeout(250);
        await ctx.shot(page, 'md_3_running');
        facts.solidScrim = await page.evaluate(() => !!document.querySelector('.PZ2QoL_mdScrim.solid'));
        if (!facts.solidScrim) problems.push('the background is not hidden during a run');
        facts.running = await page.evaluate(() => ({
            now: (document.querySelector('.PZ2QoL_mdRunNow') || {}).innerText || '',
            step: (document.querySelector('.PZ2QoL_mdRunStep') || {}).innerText || '',
            stop: !!document.querySelector('.PZ2QoL_mdSide .PZ2QoL_kpBtn.stop'),
            working: document.querySelectorAll('.PZ2QoL_mdCell.state.working').length,
        }));
        if (!facts.running.now || !facts.running.step || !facts.running.stop) problems.push(`running card: ${JSON.stringify(facts.running)}`);
        await page.waitForSelector('.PZ2QoL_mdRun.done', { timeout: 20000 });
        await page.waitForTimeout(400);
        await ctx.shot(page, 'md_4_done');
        facts.job = await page.evaluate(() => window.__md.jobs[0]);
        // the page answered the engine's watch with what it saw selected
        facts.seen = await page.evaluate(() => ({ key: window.__md.watchKey, n: window.__md.seen.length, first: (window.__md.seen[0] || [])[1] || '' }));
        if (!facts.seen.n || !facts.seen.first.startsWith(`v1|${facts.seen.key}|${facts.seen.key}|`)) problems.push(`page did not report the selection: ${JSON.stringify(facts.seen)}`);
        facts.done = await page.evaluate(() => ({
            summary: (document.querySelector('.PZ2QoL_mdRunStep') || {}).innerText || '',
            listed: [...document.querySelectorAll('.PZ2QoL_mdCell.state.done')].map(n => n.innerText),
            refused: [...document.querySelectorAll('.PZ2QoL_mdCell.state.refused')].map(n => n.innerText),
            retry: [...document.querySelectorAll('.PZ2QoL_mdRun .PZ2QoL_kpBtn')].map(n => n.innerText),
            adds: window.__md.adds,
            guidOk: window.__md.jobs[0].items.every(it => Object.keys(window.__md).length && /^\d{18}$/.test(it.guid)),
        }));
        if (!facts.job || !/^v1 \d+$/.test(facts.job.header) || +facts.job.header.split(' ')[1] < 1000) problems.push(`job header: ${facts.job && facts.job.header}`);
        if (!facts.job || facts.job.items.length !== facts.ticked.on) problems.push(`job has ${facts.job && facts.job.items.length} animals, ticked ${facts.ticked.on}`);
        if (facts.job && !facts.job.items.every(it => /^\d+$/.test(it.guid) && /^[A-Za-z0-9_]+$/.test(it.key) && (/^\d+$/.test(it.price) || it.price === '-') && it.hours === 'max')) problems.push(`job lines: ${JSON.stringify(facts.job.items.slice(0, 3))}`);
        if (!facts.done.guidOk) problems.push('job GUIDs are not exact 18-digit strings');
        if (facts.done.adds) problems.push(`the old click path fired AnimalStorage_AddToMarket ${facts.done.adds} times`);
        if (facts.done.refused.length !== 1 || !/refused/.test(facts.done.refused[0])) problems.push(`refused rows: ${JSON.stringify(facts.done.refused)}`);
        if (facts.done.listed.length !== facts.ticked.on - 1 || !facts.done.listed.every(t => /Listed \d/.test(t))) problems.push(`listed rows: ${JSON.stringify(facts.done.listed)}`);
        if (!/^Listed \d+ of \d+/.test(facts.done.summary)) problems.push(`summary: "${facts.done.summary}"`);
        if (!facts.done.retry.some(t => /retry/.test(t))) problems.push('no Retry after a refusal');
        facts.layoutDone = await layout(page);
        layoutProblems('done', facts.layoutDone, problems);

        // 3. Retry ticks exactly the refused one
        await click(page.locator('.PZ2QoL_mdRun .PZ2QoL_kpBtn', { hasText: 'retry' }));
        await page.waitForTimeout(300);
        facts.retryTicked = await page.evaluate(() => document.querySelectorAll('.PZ2QoL_mdRow.on').length);
        if (facts.retryTicked !== 1) problems.push(`Retry ticked ${facts.retryTicked}`);

        // 4. Stop during a run
        await page.evaluate(() => { window.__md.stepMs = 400; window.__md.refuseNth = 0; });
        await click(page.locator('.PZ2QoL_mdSpecies[data-species=""]'));
        await page.waitForTimeout(250);
        await click(page.locator('.PZ2QoL_mdTools .PZ2QoL_kpBtn', { hasText: 'Tick all shown' }));
        await page.waitForTimeout(250);
        facts.multiCheck = await page.evaluate(() => (document.querySelector('.PZ2QoL_mdPriceCheck .PZ2QoL_kpBtn') || {}).innerText || '');
        if (!/^Check market prices \(\d+ species\)$/.test(facts.multiCheck)) problems.push(`All species: no multi-species price check: "${facts.multiCheck}"`);
        await click(page.locator('.PZ2QoL_mdPriceCheck .PZ2QoL_kpBtn', { hasText: /^Check market prices/ }));
        await page.waitForSelector('.PZ2QoL_mdSide .PZ2QoL_kpBtn.primary:not(.disabled)', { timeout: 30000 }).catch(() => {});
        const before = await page.evaluate(() => window.__md.jobs.length);
        await click(page.locator('.PZ2QoL_mdSide .PZ2QoL_kpBtn', { hasText: /^List \d+/ }));
        await page.waitForSelector('.PZ2QoL_mdRun.running', { timeout: 4000 });
        await click(page.locator('.PZ2QoL_mdSide .PZ2QoL_kpBtn.stop'));
        await page.waitForSelector('.PZ2QoL_mdRun.stopped', { timeout: 6000 });
        facts.stop = await page.evaluate(b => ({ stops: window.__md.stops, jobs: window.__md.jobs.length - b, summary: (document.querySelector('.PZ2QoL_mdRunStep') || {}).innerText }), before);
        if (facts.stop.stops < 1 || facts.stop.jobs !== 1) problems.push(`stop: ${JSON.stringify(facts.stop)}`);
        await ctx.shot(page, 'md_5_stopped');

        // 5. no engine: the fallback pill (no listing here; the lister scenario covers the old path)
        await page.evaluate(() => { window.__md.active = false; });
        await click(page.locator('.PZ2QoL_md .PZ2QoL_kpBtn', { hasText: 'Read storage again' }));
        await page.waitForTimeout(3500);
        facts.fallbackPill = await page.evaluate(() => (document.querySelector('.PZ2QoL_mdEnginePill') || {}).innerText || '');
        if (!/Fallback/.test(facts.fallbackPill)) problems.push(`no-engine pill: "${facts.fallbackPill}"`);
        await ctx.shot(page, 'md_6_fallback');

        // 6. Esc closes
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        facts.afterEsc = await page.locator('.PZ2QoL_md:not(.hidden)').count();
        if (facts.afterEsc) problems.push('Esc did not close the desk');
        if (await page.locator('.PZ2QoL_mdScrim:not(.hidden)').count()) problems.push('the dim layer stayed after closing');
    }
    finally {
        await page.evaluate(() => { delete window.__PZ2QOL_TEST_PEEK_GAP_MS; if (typeof engine !== 'undefined') delete engine.__harness; }).catch(() => {});
        await page.evaluate(async () => {
            if (window.__md) window.__md.active = false;
            window.__PZ2QOL_TEST_FRANCHISE = undefined;
            const d = (await import('/js/mods/pz2qol/kinpanel.js')).panelApi('desk');
            if (d && d.isOpen()) d.close();
        }).catch(() => {});
    }
    if (problems.length) throw new Error('market desk: ' + problems.join('; '));
    return facts;
}
