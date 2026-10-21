// Browser-harness scenario: the Market desk's My listings (marketreprice.js,
// docs/DESIGN-reprice.md) through a fake Lua engine that runs "unlist" jobs
// (each listing's timer to -1) and listing jobs (timer 12 h, auctionPrice).
// Checks: the view tab and its stale badge, the rail, verdicts (a stale, a
// healthy and an underpriced listing against a seeded price book), the
// working drawer (ladder dots, reasons, own price), Tick stale, the rule
// (Undercut 5%) and the preview totals, the confirmation sheet (Esc closes,
// Confirm starts), the two jobs in order (unlist, then list at the new
// prices), the run card; a Stop after the first take-off leaves it off the
// market with "List the 1 again", which lists it; layout. Screenshots mrp_*.

export const name = 'market desk my listings';

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
    for (const el of [root, ...root.querySelectorAll('*')]) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
                const q = n.getBoundingClientRect();
                x0 = Math.max(x0, q.left); y0 = Math.max(y0, q.top); x1 = Math.min(x1, q.right); y1 = Math.min(y1, q.bottom);
            }
        }
        if (x1 <= x0 || y1 <= y0) continue;
        if (x0 < -0.5 || y0 < -0.5 || x1 > vw + 0.5 || y1 > vh + 0.5) out.outside.push(String(el.className));
    }
    const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    for (const sel of ['.PZ2QoL_md .PZ2QoL_kpHead > *', '.PZ2QoL_mdBody > *', '.PZ2QoL_mdSide > *', '.PZ2QoL_mdRow.head > *', '.PZ2QoL_rpRow:not(.head) > *', '.PZ2QoL_mdTabs > *']) {
        const g = [...document.querySelectorAll(sel)].filter(e => !e.classList.contains('PZ2QoL_kpFlex') && e.getBoundingClientRect().width);
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (hit(g[i].getBoundingClientRect(), g[j].getBoundingClientRect())) out.overlaps.push(`${g[i].className} x ${g[j].className}`);
    }
    for (const el of root.querySelectorAll('.PZ2QoL_kpBtn, .PZ2QoL_mdSegItem, .PZ2QoL_mdTab, .PZ2QoL_rpStrat, .PZ2QoL_rpPhase')) {
        if (el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 1) out.textOverflow.push(`${el.className}: ${el.innerText.trim().slice(0, 40)}`);
    }
    return out;
});

function layoutProblems(tag, l, problems) {
    if (l.outside.length) problems.push(`${tag}: ${l.outside.length} element(s) outside the view, e.g. ${l.outside.slice(0, 3).join('; ')}`);
    if (l.overlaps.length) problems.push(`${tag}: overlapping ${l.overlaps.slice(0, 3).join('; ')}`);
    if (l.textOverflow.length) problems.push(`${tag}: text overflows ${l.textOverflow.slice(0, 3).join('; ')}`);
}

async function installFakeEngine(page) {
    await page.evaluate(async () => {
        const DS = await import('/js/common/core/DataStore.js');
        const LIST = ['hubAnimalsData', 'animalStorageData', 'list'];
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const col = new DataStoreCollection(LIST);
        for (let i = 0; i < 50 && col._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        const keysNow = () => col._source.map(c => c[c.length - 1]);
        for (const k of ['__md', '__mdf', '__mq', '__mqt', '__mqr']) if (window[k]) window[k].active = false;
        for (const n of ['PZ2QoL_ListerHello', 'PZ2QoL_ListerResolve', 'PZ2QoL_ListerStart', 'PZ2QoL_ListerStop', 'PZ2QoL_ListerPace']) if (engine.events) engine.events[n] = [];
        const f = window.__mrp = { active: true, jobs: [], stepMs: 70, runSeq: 800, stopAfter: null, stop: false, events: [], cancels: 0, quick: 0, quickPrice: {}, quickStopAfter: null, stopWhy: null };
        const guidOf = key => {
            const id = DS.getValue(LIST.concat(key), 'id');
            return id == undefined ? null : String(910000000000000000n + BigInt(String(id).replace(/\D/g, '') || 0));
        };
        window.__mrpGuid = guidOf;
        engine.__harness = true;
        if (!window.__mrpHooks) {
            window.__mrpHooks = true;
            for (const ev of ['AnimalStorage_AddToMarket', 'AnimalStorage_Cancel']) engine.on(ev, () => { if (window.__mrp) window.__mrp.events.push(ev); });
        }
        engine.on('PZ2QoL_ListerHello', req => {
            if (!f.active) return;
            setTimeout(() => engine.trigger('PZ2QoL_ListerCaps', req, JSON.stringify({ ok: true, missing: [], storage: true, online: true, rows: Math.max(1, keysNow().length), running: !!f.running, version: 1, check: true, unlist: true })), 15);
        });
        engine.on('PZ2QoL_ListerResolve', (req, csv) => {
            if (!f.active) return;
            const ids = {}, rows = {}, failed = [];
            for (const k of String(csv).split(',')) {
                const g = guidOf(k);
                if (!g) {
                    failed.push(k);
                    continue;
                }
                ids[k] = g;
                const at = p => DS.getValue(LIST.concat(k), p);
                rows[k] = { name: at('name'), species: at('species'), gender: at('gender') };
            }
            setTimeout(() => engine.trigger('PZ2QoL_ListerIds', req, JSON.stringify({ ids, rows, failed })), 15);
        });
        engine.on('PZ2QoL_ListerStop', () => {
            if (f.active) f.stop = true;
        });
        engine.on('PZ2QoL_ListerStart', (req, text) => {
            if (!f.active) return;
            const lines = String(text).split('\n');
            const head = lines[0];
            const mode = head.split(' ')[2] || 'list';
            const items = lines.slice(1).map(l => {
                const [guid, key, price, hours] = l.split(' ');
                return { guid, key, price, hours };
            });
            f.jobs.push({ req, head, mode, items });
            f.running = true;
            f.stop = false;
            f.runSeq++;
            const st = { run: f.runSeq, req, mode, phase: 'running', total: items.length, index: 0, step: 'server', waited: 0, paceMs: +head.split(' ')[1], message: '',
                results: items.map(i => ({ guid: i.guid, status: 'pending', kind: '', price: null, hours: null, capped: null, usedDefault: false, detail: '' })) };
            const send = () => engine.trigger('PZ2QoL_ListerState', JSON.stringify(st));
            let i = 0;
            const tick = () => {
                if (f.stop || i >= items.length) {
                    st.phase = f.stop ? 'stopped' : 'done';
                    st.step = '';
                    st.message = f.stop ? (f.stopWhy || 'Stopped by you.') : '';
                    f.stopWhy = null;
                    f.running = false;
                    send();
                    return;
                }
                st.index = i;
                st.results[i].status = 'working';
                st.step = mode === 'unlist' ? 'unconfirm' : 'confirm';
                send();
                setTimeout(() => {
                    const r = st.results[i];
                    const it = items[i];
                    const key = keysNow().find(k => guidOf(k) === it.guid);
                    if (mode === 'unlist') {
                        f.cancels++;
                        const was = key ? DS.getValue(LIST.concat(key), 'auctionPrice') : null;
                        if (key) DS.setValue(LIST.concat(key), 'auctionTimerSeconds', -1);
                        Object.assign(r, { status: 'unlisted', price: was });
                    }
                    else if (mode === 'quicktrade' || mode === 'release') {
                        // a listed animal is never quick-traded (the engine stops: kind listed)
                        const listed = key && DS.getValue(LIST.concat(key), 'auctionTimerSeconds') > 0;
                        if (listed) {
                            Object.assign(r, { status: 'skipped', kind: 'listed', detail: 'Already on the market.' });
                            f.stop = true;
                        }
                        else {
                            f.quick++;
                            if (key) DS.deleteContext(LIST.concat(key));
                            Object.assign(r, { status: mode === 'release' ? 'released' : 'traded', price: f.quickPrice[it.guid] || 650 });
                        }
                    }
                    else {
                        if (key) {
                            DS.setValue(LIST.concat(key), 'auctionTimerSeconds', (it.hours === 'default' ? 6 : 12) * 3600);
                            DS.setValue(LIST.concat(key), 'auctionPrice', +it.price);
                        }
                        // what the game allows for it, as the engine sends with each result
                        Object.assign(r, { status: 'listed', price: +it.price, hours: it.hours === 'default' ? 6 : 12,
                            verdict: { trade: true, quickTrade: true, quickRelease: true, rehome: false, tradeWhy: '', quickTradeWhy: '', quickReleaseWhy: '', quickTradeValue: '', quickReleaseValue: '', quickTradePrice: 700, quickReleasePrice: 45, src: 'page', v: 2 } });
                    }
                    i++;
                    if (f.stopAfter != null && i >= f.stopAfter && mode === 'unlist') f.stop = true;
                    if (f.quickStopAfter != null && i >= f.quickStopAfter && (mode === 'quicktrade' || mode === 'release')) {
                        f.stop = true;
                        f.stopWhy = 'Stopped: the game did not allow it now; nothing more was sent.';
                        f.quickStopAfter = null;
                    }
                    st.step = 'pause';
                    send();
                    setTimeout(tick, f.stepMs);
                }, f.stepMs);
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
    facts.setup = await page.evaluate(async () => {
        window.__PZ2QOL_TEST_FRANCHISE = true;
        try {
            localStorage.removeItem('PZ2QoL.reprice.v1');
            localStorage.removeItem('PZ2QoL.repriceView');
        }
        catch (e) {
            // none
        }
        (await import('/js/mods/pz2qol/repricerun.js'))._resetRepriceForTests();
        const DS = await import('/js/common/core/DataStore.js');
        const LIST = ['hubAnimalsData', 'animalStorageData', 'list'];
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const col = new DataStoreCollection(LIST);
        for (let i = 0; i < 50 && col._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        const keys = col._source.map(c => c[c.length - 1]);
        col.dispose();
        const sp = DS.getValue(LIST.concat(keys[0]), 'species');
        keys.forEach((k, i) => {
            for (const [p, v] of [['isMoving', false], ['isPregnant', false], ['isShoal', false], ['auctionTimerSeconds', -1], ['maturity', 2], ['storageTag', 0]]) DS.setValue(LIST.concat(k), p, v);
            DS.setValue(LIST.concat(k), 'source', '[AnimalExchange_Source_Description:Value=|Simmons Zoo|]');
        });
        // four of mine on the market: overpriced and old (stale), at the
        // market (healthy), far under it (underpriced), overpriced and fresh
        const listed = [[2400, 1.5], [1000, 3], [500, 8], [1250, 11.9]];
        const mine = [];
        listed.forEach(([price, left], i) => {
            const k = keys[i];
            DS.setValue(LIST.concat(k), 'species', sp);
            DS.setValue(LIST.concat(k), 'gender', 1);
            DS.setValue(LIST.concat(k), 'ratings', 'silver');
            // a normal animal (the dummy data gives every row a random morph label)
            DS.setValue(LIST.concat(k), 'colormorphLabel', '');
            DS.setValue(LIST.concat(k), 'auctionPrice', price);
            DS.setValue(LIST.concat(k), 'auctionTimerSeconds', Math.round(left * 3600));
            for (const g of ['size', 'longevity', 'fertility', 'immunity']) DS.setValue(LIST.concat(k).concat(['genetics', g]), 'value', 0.6);
            mine.push(k);
        });
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', []);
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'animalsInStorage', keys.length);
        // the market: 10 comparable Silver adult males, 1,000-1,180 CC
        const pb = await import('/js/mods/pz2qol/pricebook.js');
        pb.clearPriceBook();
        pb.mergeIntoPriceBook(Array.from({ length: 10 }, (_, i) => ({
            id: `harness_comp_${i}`, species: sp, gender: 1, maturity: 2, isShoal: false, isExhibit: false, score: 60, medal: 'silver', price: 1000 + i * 20, isCC: true, source: 'market',
        })));
        return { species: sp, mine };
    });
    await installFakeEngine(page);
    const panel = () => page.evaluate(() => {
        const s = document.querySelector('.PZ2QoL_mdSide');
        const q = (sel, root = document) => root.querySelector(sel);
        return {
            tabs: [...document.querySelectorAll('.PZ2QoL_mdTab')].map(n => [n.getAttribute('data-view'), n.innerText.replace(/\s+/g, ' ').trim(), n.classList.contains('on')]),
            rows: [...document.querySelectorAll('.PZ2QoL_rpRow[data-guid]')].map(n => ({ guid: n.getAttribute('data-guid'), verdict: n.getAttribute('data-verdict'), on: n.classList.contains('on'), text: n.innerText.replace(/\s+/g, ' ').trim() })),
            chips: [...document.querySelectorAll('.PZ2QoL_rpVerdicts .PZ2QoL_mdSegItem')].map(n => n.innerText),
            preview: (q('.PZ2QoL_rpPreview') || {}).innerText || '',
            button: ((s && [...s.querySelectorAll('.PZ2QoL_kpBtn.primary')].map(b => b.innerText.trim() + (b.classList.contains('disabled') ? ' [off]' : ''))) || []).join(' | '),
            run: (q('.PZ2QoL_rpRun') || {}).innerText || '',
            quickPanel: (q('.PZ2QoL_mdSide.quick') || {}).innerText || '',
            newCells: [...document.querySelectorAll('.PZ2QoL_rpRow[data-guid] .PZ2QoL_mdCell.rpNew')].map(n => [n.closest('.PZ2QoL_rpRow').getAttribute('data-guid'), n.innerText.trim()]),
            last: (q('.PZ2QoL_rpLast') || {}).innerText || '',
            rules: (q('.PZ2QoL_mdRules') || {}).innerText || '',
            checkBtn: !!q('.PZ2QoL_mdCheck .PZ2QoL_kpBtn'),
            sheet: (q('.PZ2QoL_rpSheet:not(.hidden)') || {}).innerText || '',
            detail: (q('.PZ2QoL_rpDetail') || {}).innerText || '',
            dots: document.querySelectorAll('.PZ2QoL_rpDetail .PZ2QoL_rpDot').length,
            marks: [...document.querySelectorAll('.PZ2QoL_rpDetail .PZ2QoL_rpMark')].map(n => n.className.split(' ').pop()),
        };
    });
    const rowOf = (p, i) => p.rows.find(r => r.guid === facts.guids[i]);
    try {
        await page.evaluate(async () => (await import('/js/mods/pz2qol/kinpanel.js')).panelApi('desk').open());
        await page.waitForSelector('.PZ2QoL_md:not(.hidden) .PZ2QoL_mdRow[data-id^="g"]', { timeout: 8000 });
        await page.waitForTimeout(600);
        facts.guids = await page.evaluate(keys => keys.map(k => window.__mrpGuid(k)), facts.setup.mine);
        // the desk has read the four listings and their GUIDs (after other desk scenarios on this page it may take a read or two)
        await page.evaluate(async () => (await import('/js/mods/pz2qol/kinpanel.js')).panelApi('desk').close());
        await page.waitForTimeout(300);
        await page.evaluate(async () => (await import('/js/mods/pz2qol/kinpanel.js')).panelApi('desk').open({ view: 'sell' }));
        await page.waitForFunction(() => /My listings · 4/.test((document.querySelector('.PZ2QoL_mdTab[data-view="listings"]') || {}).innerText || ''), null, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1200);

        // 1. the tab, with its stale badge; the view
        facts.tabs = (await panel()).tabs;
        if (!facts.tabs.some(t => t[0] === 'listings' && /My listings · 4/.test(t[1]) && /stale/.test(t[1]))) problems.push(`tab: ${JSON.stringify(facts.tabs)}`);
        await click(page.locator('.PZ2QoL_mdTab[data-view="listings"]'));
        await page.waitForSelector('.PZ2QoL_rpRow[data-guid]', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(400);
        let p = await panel();
        facts.view = { rows: p.rows.map(r => [r.verdict, r.text.slice(0, 90)]), chips: p.chips };
        facts.debug = await page.evaluate(async keys => {
            const game = await import('/js/mods/pz2qol/game.js');
            const rc = await import('/js/mods/pz2qol/repricecore.js');
            const pb = await import('/js/mods/pz2qol/pricebook.js');
            const a = game.readAnimal(['hubAnimalsData', 'animalStorageData', 'list', keys[1]]);
            const s = rc.assessListing(a, { book: pb.getPriceBook(), mine: [a] });
            return { a: JSON.stringify(a).slice(0, 400), book: JSON.stringify(pb.getPriceBook()[0]), fair: s.fair, n: s.n, reason: s.rec && s.rec.reason };
        }, facts.setup.mine);
        await ctx.shot(page, 'mrp_0_listings');
        layoutProblems('listings', await layout(page), problems);
        const v = i => (rowOf(p, i) || {}).verdict;
        if (v(0) !== 'stale' || v(1) !== 'ok' || v(2) !== 'under' || v(3) !== 'watch') problems.push(`verdicts: ${JSON.stringify(p.rows.map(r => r.verdict))} (want stale, ok, under, watch in that set)`);
        if (p.rows[0] && p.rows[0].guid !== facts.guids[0]) problems.push(`most stale first: ${p.rows[0].guid}`);

        // 2. the working of the stale one
        await click(page.locator(`.PZ2QoL_rpRow[data-guid="${facts.guids[0]}"] .PZ2QoL_mdCell.rpMore`));
        await page.waitForTimeout(300);
        p = await panel();
        facts.detail = { dots: p.dots, marks: p.marks, text: p.detail.slice(0, 400) };
        await ctx.shot(page, 'mrp_1_working');
        if (/Check storage/.test(String(p.checkBtn)) || p.checkBtn || !/Nothing changes until you confirm a reprice/.test(p.rules)) problems.push(`listings head/foot: check ${p.checkBtn}, rules ${p.rules}`);
        if (p.dots !== 10 || !p.marks.includes('mine') || !p.marks.includes('fair')) problems.push(`ladder: ${JSON.stringify(facts.detail)}`);
        if (!/Place in line\s*11 of 11/.test(p.detail) || !/Staleness/.test(p.detail) || !/Fair price/.test(p.detail)) problems.push(`reasons: ${p.detail.slice(0, 300)}`);
        if (rowOf(p, 0) && rowOf(p, 0).on) problems.push('opening the working ticked the row');
        layoutProblems('working', await layout(page), problems);
        // own price for it: 1,100 (it ticks it)
        await page.locator('.PZ2QoL_rpInput').first().fill('1100');
        await page.waitForTimeout(500);
        p = await panel();
        facts.own = { row: (rowOf(p, 0) || {}).text, on: (rowOf(p, 0) || {}).on };
        // the box only sets the price; the row is ticked by a click
        await click(page.locator(`.PZ2QoL_rpRow[data-guid="${facts.guids[0]}"] .PZ2QoL_mdCell.rpMore`));
        await page.waitForTimeout(200);

        // 3. Tick stale + the rule, the preview
        await click(page.locator('.PZ2QoL_mdTools .PZ2QoL_kpBtn', { hasText: 'Tick stale' }));
        await page.waitForTimeout(200);
        // the watch one too (overpriced, fresh)
        await click(page.locator(`.PZ2QoL_rpRow[data-guid="${facts.guids[3]}"] .PZ2QoL_mdCell.name`));
        await click(page.locator('.PZ2QoL_rpStrat[data-value="undercut"]'));
        await page.waitForTimeout(300);
        p = await panel();
        facts.preview = p.preview;
        facts.button = p.button;
        await ctx.shot(page, 'mrp_2_preview');
        layoutProblems('preview', await layout(page), problems);
        // stale one: own 1,100; the other: 5% under 1,000 = 950
        if (!/3,650\s*→\s*2,050 CC/.test(p.preview)) problems.push(`preview: ${JSON.stringify(p.preview)}`);
        if (!/^Reprice 2 listings$/.test(p.button)) problems.push(`button: ${p.button}`);

        // 4. the sheet: Esc closes it, then Confirm
        await click(page.locator('.PZ2QoL_mdSide .PZ2QoL_kpBtn.primary'));
        await page.waitForTimeout(400);
        p = await panel();
        facts.sheet = p.sheet.slice(0, 500);
        await ctx.shot(page, 'mrp_3_sheet');
        if (!/Reprice 2 listings/.test(p.sheet) || !/Take all 2 off the market/.test(p.sheet) || !/1,100 CC/.test(p.sheet) || !/950 CC/.test(p.sheet)) problems.push(`sheet: ${facts.sheet}`);
        layoutProblems('sheet', await layout(page), problems);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        facts.afterEsc = { sheet: !!(await panel()).sheet, desk: await page.evaluate(() => !document.querySelector('.PZ2QoL_md').classList.contains('hidden')) };
        if (facts.afterEsc.sheet || !facts.afterEsc.desk) problems.push(`Esc: ${JSON.stringify(facts.afterEsc)}`);
        if ((await page.evaluate(() => window.__mrp.jobs.length)) !== 0) problems.push('a job before Confirm');
        await click(page.locator('.PZ2QoL_mdSide .PZ2QoL_kpBtn.primary'));
        await page.waitForTimeout(450);
        await click(page.locator('.PZ2QoL_rpSheet .PZ2QoL_kpBtn.primary'));
        // 5. the two jobs, in order
        await page.waitForFunction(() => window.__mrp.jobs.length >= 1, null, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(80);
        await ctx.shot(page, 'mrp_4_running');
        await page.waitForFunction(() => window.__mrp.jobs.length >= 2 && !window.__mrp.running, null, { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(600);
        const jobs = await page.evaluate(() => window.__mrp.jobs.map(j => ({ head: j.head, mode: j.mode, items: j.items })));
        facts.jobs = jobs.map(j => `${j.head} :: ${j.items.map(i => `${i.guid.slice(-3)} ${i.price} ${i.hours}`).join(', ')}`);
        if (jobs.length !== 2 || !/^v1 \d+ unlist$/.test(jobs[0].head) || jobs[0].items.length !== 2 || !/^v1 \d+$/.test(jobs[1].head)) problems.push(`jobs: ${JSON.stringify(facts.jobs)}`);
        else {
            const price = g => (jobs[1].items.find(i => i.guid === g) || {}).price;
            if (price(facts.guids[0]) !== '1100' || price(facts.guids[3]) !== '950' || jobs[1].items.some(i => i.hours !== 'max')) problems.push(`relist prices: ${JSON.stringify(jobs[1].items)}`);
        }
        p = await panel();
        facts.done = p.last;
        await ctx.shot(page, 'mrp_5_done');
        layoutProblems('done', await layout(page), problems);
        if (p.run || !/Repriced 2 of 2/.test(p.last)) problems.push(`done: run card ${JSON.stringify(p.run.slice(0, 100))}, last ${JSON.stringify(p.last)}`);
        facts.prices = await page.evaluate(async keys => {
            const DS = await import('/js/common/core/DataStore.js');
            return keys.map(k => [DS.getValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'auctionPrice'), DS.getValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'auctionTimerSeconds')]);
        }, facts.setup.mine);
        if (facts.prices[0][0] !== 1100 || facts.prices[3][0] !== 950 || facts.prices[1][0] !== 1000) problems.push(`storage prices after: ${JSON.stringify(facts.prices)}`);

        // 6. a Stop after the first take-off: it stays off, one click lists it again
        await click(page.locator('.PZ2QoL_rpDismiss'));
        await page.waitForTimeout(300);
        await page.evaluate(() => { window.__mrp.stopAfter = 1; window.__mrp.jobs = []; });
        await click(page.locator('.PZ2QoL_mdTools .PZ2QoL_kpBtn', { hasText: 'Untick shown' }));
        await click(page.locator(`.PZ2QoL_rpRow[data-guid="${facts.guids[1]}"] .PZ2QoL_mdCell.name`));
        await click(page.locator(`.PZ2QoL_rpRow[data-guid="${facts.guids[2]}"] .PZ2QoL_mdCell.name`));
        await click(page.locator('.PZ2QoL_rpStrat[data-value="fair"]'));
        await page.waitForTimeout(250);
        await click(page.locator('.PZ2QoL_mdSide .PZ2QoL_kpBtn.primary'));
        await page.waitForTimeout(450);
        await click(page.locator('.PZ2QoL_rpSheet .PZ2QoL_kpBtn.primary'));
        await page.waitForFunction(() => window.__mrp.jobs.length >= 1 && !window.__mrp.running, null, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(800);
        p = await panel();
        facts.stopped = { run: p.run.slice(0, 400), jobs: await page.evaluate(() => window.__mrp.jobs.length), tabs: p.tabs };
        await ctx.shot(page, 'mrp_6_left');
        layoutProblems('left', await layout(page), problems);
        if (facts.stopped.jobs !== 1 || !/Reprice stopped/.test(p.run) || !/1 off the market, waiting in storage/.test(p.run)) problems.push(`stopped: ${JSON.stringify(facts.stopped)}`);
        if (!p.tabs.some(t => t[0] === 'listings' && /1 off/.test(t[1]))) problems.push(`tab badge after stop: ${JSON.stringify(p.tabs)}`);
        await page.evaluate(() => { window.__mrp.stopAfter = null; });
        await click(page.locator('.PZ2QoL_rpRun .PZ2QoL_kpBtn.primary', { hasText: 'List the 1 again' }));
        await page.waitForFunction(() => window.__mrp.jobs.length >= 2 && !window.__mrp.running, null, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(600);
        const j2 = await page.evaluate(() => window.__mrp.jobs.map(j => ({ head: j.head, items: j.items })));
        p = await panel();
        facts.relistLeft = { jobs: j2.map(j => j.head), run: p.run.slice(0, 300) };
        if (j2.length !== 2 || !/^v1 \d+$/.test(j2[1].head) || j2[1].items.length !== 1 || j2[1].items[0].guid !== facts.guids[1]) problems.push(`list again: ${JSON.stringify(facts.relistLeft)}`);
        if (/waiting in storage/.test(p.run)) problems.push(`still left after listing again: ${p.run.slice(0, 200)}`);
        facts.events = await page.evaluate(() => window.__mrp.events.slice());
        if (facts.events.length) problems.push(`vanilla events fired: ${JSON.stringify(facts.events)}`);
        // 7. Quick trade two listings: take off, then quick trade; the game's
        // price known for one (its listing run's verdict), not the other; a
        // stop after the first leaves one, which "Quick trade the 1 again" sends
        await page.evaluate(g => { window.__mrp.jobs = []; window.__mrp.quickPrice = { [g]: 700 }; window.__mrp.quickStopAfter = 1; }, facts.guids[0]);
        await click(page.locator('.PZ2QoL_mdTools .PZ2QoL_kpBtn', { hasText: 'Untick shown' }));
        await click(page.locator(`.PZ2QoL_rpRow[data-guid="${facts.guids[0]}"] .PZ2QoL_mdCell.name`));
        await click(page.locator(`.PZ2QoL_rpRow[data-guid="${facts.guids[2]}"] .PZ2QoL_mdCell.name`));
        await click(page.locator('.PZ2QoL_mdSide .PZ2QoL_mdSeg.mode .PZ2QoL_mdSegItem[data-value="quicktrade"]'));
        await page.waitForTimeout(400);
        p = await panel();
        facts.quick = { panel: p.quickPanel.slice(0, 500), cells: p.newCells, button: p.button };
        await ctx.shot(page, 'mrp_7_quick');
        layoutProblems('quick panel', await layout(page), problems);
        if (!/Asking now\s*1,600 CC/i.test(p.quickPanel) || !/\$700 \+ 1 priced when checked/.test(p.quickPanel)) problems.push(`quick panel: ${JSON.stringify(facts.quick.panel)}`);
        const cell = g => (p.newCells.find(c => c[0] === g) || [])[1];
        if (cell(facts.guids[0]) !== '$700' || cell(facts.guids[2]) !== 'when off') problems.push(`quick cells: ${JSON.stringify(p.newCells)}`);
        await click(page.locator('.PZ2QoL_mdSide .PZ2QoL_kpBtn.quick'));
        await page.waitForTimeout(450);
        p = await panel();
        facts.quickSheet = p.sheet.slice(0, 600);
        await ctx.shot(page, 'mrp_8_quick_sheet');
        layoutProblems('quick sheet', await layout(page), problems);
        if (!/Quick trade 2 listings for \$700 \+ 1 priced when checked\?/.test(p.sheet) || !/can't be undone/.test(p.sheet)) problems.push(`quick sheet: ${facts.quickSheet}`);
        await click(page.locator('.PZ2QoL_rpSheet .PZ2QoL_kpBtn.quick'));
        await page.waitForFunction(() => window.__mrp.jobs.length >= 2 && !window.__mrp.running, null, { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(800);
        p = await panel();
        const qj = await page.evaluate(() => window.__mrp.jobs.map(j => ({ head: j.head, n: j.items.length })));
        facts.quickRun = { jobs: qj, run: p.run.slice(0, 500) };
        await ctx.shot(page, 'mrp_9_quick_left');
        layoutProblems('quick left', await layout(page), problems);
        if (qj.length !== 2 || !/^v1 \d+ unlist$/.test(qj[0].head) || qj[0].n !== 2 || !/^v1 \d+ quicktrade$/.test(qj[1].head) || qj[1].n !== 2) problems.push(`quick jobs: ${JSON.stringify(qj)}`);
        if (!/Quick trade stopped/.test(p.run) || !/1 off the market, not sold, waiting in storage/.test(p.run) || !/quick-traded · \$700/.test(p.run)) problems.push(`quick run card: ${facts.quickRun.run}`);
        await click(page.locator('.PZ2QoL_rpRun .PZ2QoL_kpBtn.quick', { hasText: 'Quick trade the 1 again' }));
        await page.waitForFunction(() => window.__mrp.jobs.length >= 3 && !window.__mrp.running, null, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(700);
        p = await panel();
        const qj2 = await page.evaluate(() => window.__mrp.jobs.map(j => ({ head: j.head, guids: j.items.map(i => i.guid) })));
        facts.quickAgain = { jobs: qj2.map(j => j.head), last: p.last, quick: await page.evaluate(() => window.__mrp.quick) };
        if (qj2.length !== 3 || !/quicktrade$/.test(qj2[2].head) || qj2[2].guids.join() !== facts.guids[2] || facts.quickAgain.quick !== 2) problems.push(`quick again: ${JSON.stringify(facts.quickAgain)}`);
        if (!/Quick-traded 2 of 2 · \$1,350/.test(p.last)) problems.push(`quick last line: ${p.last}`);
        // back to Sell from storage: the view comes back as it was
        await click(page.locator('.PZ2QoL_mdTab[data-view="sell"]'));
        await page.waitForTimeout(300);
        if (!(await page.locator('.PZ2QoL_mdSide .PZ2QoL_mdSeg.mode').count())) problems.push('Sell view did not come back');
    }
    finally {
        await page.evaluate(async () => {
            if (window.__mrp) window.__mrp.active = false;
            window.__PZ2QOL_TEST_FRANCHISE = undefined;
            if (typeof engine !== 'undefined') delete engine.__harness;
            try {
                (await import('/js/mods/pz2qol/repricerun.js'))._resetRepriceForTests();
                (await import('/js/mods/pz2qol/pricebook.js')).clearPriceBook();
            }
            catch (e) {
                // best effort
            }
            const d = (await import('/js/mods/pz2qol/kinpanel.js')).panelApi('desk');
            if (d && d.isOpen()) d.close();
        }).catch(() => {});
    }
    if (problems.length) throw new Error('market desk my listings: ' + problems.join('; '));
    return facts;
}
