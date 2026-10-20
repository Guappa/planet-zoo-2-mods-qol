// Browser-harness scenario: Quick trade / Quick release from the Market desk
// (docs/PLAN-desk-quick-release.md 4, Phase 2), through a fake Lua engine in
// the page that answers 'check', 'quicktrade' and 'release' jobs the way
// pz2qol.lister.lua does (one animal at a time; a confirmed one leaves the
// storage list; an unconfirmed one or a reload stops the run).
// Checks: the storage-list pre-classification and its note; the mode switch
// and the red quick panel with its header; only the mode's own rows tick;
// the live acceptance (one animal until one was confirmed gone, kept in
// prefs; Quick trade is proven, so only Quick release keeps it); the sheet
// (title, go list, warning, Confirm); Cancel, Esc, a double click and the
// gamepad's A as it opens send nothing; Confirm sends exactly the frozen job
// and does nothing while a run is active; the run card ("Quick-traded
// 1 of 1 · $1,200", a stopped run's reason and per-animal lines, "Stopped:
// page reloaded."); Quick release; the mode is never remembered; no
// listing or vanilla quick event; layout. Screenshots mqt_*.

export const name = 'market desk quick trade run';

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
    for (const sel of ['.PZ2QoL_mdSide > *', '.PZ2QoL_mdSheetCard > *', '.PZ2QoL_mdSheetButtons > *']) {
        const g = [...document.querySelectorAll(sel)].filter(e => e.getBoundingClientRect().width);
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (hit(g[i].getBoundingClientRect(), g[j].getBoundingClientRect())) out.overlaps.push(`${g[i].className} x ${g[j].className}`);
    }
    for (const el of root.querySelectorAll('.PZ2QoL_kpBtn, .PZ2QoL_mdSegItem, .PZ2QoL_mdHold')) {
        if (el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 1) out.textOverflow.push(`${el.className}: ${el.innerText.trim().slice(0, 40)}`);
    }
    return out;
});

function layoutProblems(tag, l, problems) {
    if (l.outside.length) problems.push(`${tag}: ${l.outside.length} element(s) outside the view, e.g. ${l.outside.slice(0, 3).join('; ')}`);
    if (l.overlaps.length) problems.push(`${tag}: overlapping ${l.overlaps.slice(0, 3).join('; ')}`);
    if (l.textOverflow.length) problems.push(`${tag}: text overflows ${l.textOverflow.slice(0, 3).join('; ')}`);
}

const FZ = '[AnimalExchange_Source_Description:Value=|Frontier Zoo|]';

async function installFakeEngine(page) {
    await page.evaluate(async () => {
        const DS = await import('/js/common/core/DataStore.js');
        const LIST = ['hubAnimalsData', 'animalStorageData', 'list'];
        const DATA = ['hubAnimalsData', 'animalStorageData'];
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const col = new DataStoreCollection(LIST);
        for (let i = 0; i < 50 && col._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        const keysNow = () => col._source.map(c => c[c.length - 1]);
        for (const k of ['__md', '__mdf', '__mq']) if (window[k]) window[k].active = false;
        const f = window.__mqt = { active: true, jobs: [], stops: 0, stepMs: 120, runSeq: 300, plan: new Map(), events: [], outcome: () => 'gone', stopMsg: null };
        const guidOf = key => {
            const id = DS.getValue(LIST.concat(key), 'id');
            return id == undefined ? null : String(900000000000000000n + BigInt(String(id).replace(/\D/g, '') || 0));
        };
        window.__mqtGuid = guidOf;
        if (!window.__mqtHooks) {
            window.__mqtHooks = true;
            for (const ev of ['AnimalStorage_AddToMarket', 'AnimalStorage_QuickTrade_Cash', 'AnimalStorage_QuickTrade_Credits', 'AnimalStorage_Rehome']) {
                engine.on(ev, () => { if (window.__mqt) window.__mqt.events.push(ev); });
            }
        }
        engine.on('PZ2QoL_ListerHello', req => {
            if (!f.active) return;
            const rows = document.querySelectorAll('.MarketAnimalListItem_root').length;
            setTimeout(() => engine.trigger('PZ2QoL_ListerCaps', req, JSON.stringify({ ok: true, missing: [], storage: true, online: true, rows: Math.max(1, rows), running: !!f.running, version: 1, check: true })), 20);
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
            setTimeout(() => engine.trigger('PZ2QoL_ListerIds', req, JSON.stringify({ ids, rows, failed })), 20);
        });
        engine.on('PZ2QoL_ListerStop', () => {
            if (!f.active) return;
            f.stops++;
            f.stopRequested = true;
        });
        engine.on('PZ2QoL_ListerStart', (req, text) => {
            if (!f.active) return;
            const lines = String(text).split('\n');
            const head = lines[0];
            const mode = head.split(' ')[2] || 'list';
            const items = lines.slice(1).map(l => {
                const [guid, key] = l.split(' ');
                return { guid, key };
            });
            f.jobs.push({ req, head, mode, items });
            if (!['check', 'quicktrade', 'release'].includes(mode)) {
                setTimeout(() => engine.trigger('PZ2QoL_ListerState', JSON.stringify({ run: 0, req, phase: 'done', refused: true, total: 0, index: 0, step: '', waited: 0, message: 'not here', results: [] })), 20);
                return;
            }
            f.running = true;
            f.stopRequested = false;
            f.runSeq++;
            const st = { run: f.runSeq, req, mode, phase: 'running', total: items.length, index: 0, step: 'server', waited: 0, paceMs: +head.split(' ')[1], message: '',
                results: items.map(i => ({ guid: i.guid, status: 'pending', kind: '', price: null, hours: null, capped: null, usedDefault: false, detail: '', verdict: null })) };
            const send = () => engine.trigger('PZ2QoL_ListerState', JSON.stringify(st));
            let i = 0;
            const end = (phase, msg) => {
                st.phase = phase;
                st.step = '';
                st.message = msg;
                f.running = false;
                DS.setValue(DATA, 'selectedAnimalIDs', []);
                send();
            };
            const verb = { check: 'Checked', quicktrade: 'Quick-traded', release: 'Released' }[mode];
            const done = { check: 'checked', quicktrade: 'traded', release: 'released' }[mode];
            const tick = () => {
                if (f.stopRequested) return end('stopped', 'Stopped by you.');
                if (i >= items.length) return end('done', `${verb} ${st.results.filter(r => r.status === done).length} of ${items.length}.`);
                st.index = i;
                const it = items[i];
                const v = f.plan.get(it.guid);
                st.results[i].status = 'working';
                st.step = mode === 'check' ? 'select' : 'gone';
                send();
                setTimeout(() => {
                    const r = st.results[i];
                    r.verdict = v || null;
                    if (mode === 'check') {
                        r.status = 'checked';
                    }
                    else {
                        const o = f.outcome(it.guid, i, mode);
                        if (o === 'reload') {
                            r.status = 'pending';
                            i++;
                            return end('stopped', 'Stopped: page reloaded.');
                        }
                        if (o === 'stay') {
                            Object.assign(r, { status: 'unconfirmed', kind: 'unconfirmed', detail: 'Not confirmed: check storage.' });
                            i++;
                            return end('stopped', 'Stopped: an animal was still in storage 10 s after sending; check storage.');
                        }
                        r.status = done;
                        r.price = v ? (mode === 'quicktrade' ? v.quickTradePrice : v.quickReleasePrice) : null;
                        // the native takes the row out of storage
                        const key = keysNow().find(k => guidOf(k) === it.guid);
                        if (key) DS.deleteContext(LIST.concat(key));
                    }
                    i++;
                    st.step = 'pause';
                    send();
                    setTimeout(tick, f.stepMs);
                }, f.stepMs);
            };
            // f.delayStart: the engine answers late (the page must not say "did not start")
            setTimeout(tick, 30 + (f.delayStart || 0));
        });
    });
}

export async function frontend(page, ctx) {
    const facts = ctx.facts || {};
    const problems = [];
    facts.problems = problems;
    await ctx.gotoMarketTab(page, 1);
    facts.setup = await page.evaluate(async fz => {
        window.__PZ2QOL_TEST_FRANCHISE = true;
        (await import('/js/mods/pz2qol/prefs.js')).setPref('quickAccepted', undefined);
        const DS = await import('/js/common/core/DataStore.js');
        const LIST = ['hubAnimalsData', 'animalStorageData', 'list'];
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const col = new DataStoreCollection(LIST);
        for (let i = 0; i < 50 && col._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        const keys = col._source.map(c => c[c.length - 1]);
        col.dispose();
        const sp = DS.getValue(LIST.concat(keys[0]), 'species');
        keys.forEach((k, i) => {
            if (i < 7) DS.setValue(LIST.concat(k), 'species', sp);
            for (const [p, v] of [['isMoving', false], ['isPregnant', false], ['isShoal', false], ['auctionTimerSeconds', -1], ['maturity', 2], ['storageTag', 0]]) DS.setValue(LIST.concat(k), p, v);
            DS.setValue(LIST.concat(k), 'source', i === 4 ? fz : '[AnimalExchange_Source_Description:Value=|Simmons Zoo|]');
        });
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', []);
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'animalsInStorage', keys.length);
        return { species: sp, keys: keys.slice(0, 7) };
    }, FZ);
    await installFakeEngine(page);
    // the verdicts a Check storage finds: 0, 2, 4 quick (trade and release), 1 quick trade only, 3, 5, 6 market
    await page.evaluate(s => {
        const f = window.__mqt;
        const g = s.keys.map(k => window.__mqtGuid(k));
        const q = (qt, qr, pt, pr) => ({ trade: false, quickTrade: qt, quickRelease: qr, rehome: false, tradeWhy: '[AnimalList_Problem_NoBirthZoo]', quickTradeWhy: qt ? '' : '[AnimalList_Problem_Infertile_Sell]',
            quickReleaseWhy: qr ? '' : '[AnimalList_Problem_CashSeeded]', quickTradeValue: `[COST:Value={${pt}}]`, quickReleaseValue: `[INT_VALUE:Value={${pr}}]`, quickTradePrice: pt, quickReleasePrice: pr, src: 'page', v: 2 });
        const market = { trade: true, quickTrade: true, quickRelease: true, rehome: false, tradeWhy: '', quickTradeWhy: '', quickReleaseWhy: '', quickTradeValue: '[COST:Value={700}]', quickReleaseValue: '[INT_VALUE:Value={30}]', quickTradePrice: 700, quickReleasePrice: 30, src: 'page', v: 2 };
        f.plan.set(g[0], q(true, true, 1200, 85));
        f.plan.set(g[1], q(true, false, 800, 40));
        f.plan.set(g[2], q(true, true, 1500, 90));
        f.plan.set(g[3], market);
        f.plan.set(g[4], q(true, true, 1100, 70));
        f.plan.set(g[5], market);
        // a market animal the game won't quick-trade
        f.plan.set(g[6], Object.assign({}, market, { quickTrade: false, quickTradeWhy: '[AnimalList_Problem_Infertile_Sell]' }));
        f.g = g;
    }, facts.setup);
    const sp = facts.setup.species;
    const keys = facts.setup.keys;
    const openDesk = () => page.evaluate(async () => (await import('/js/mods/pz2qol/kinpanel.js')).panelApi('desk').open());
    const modeSeg = v => page.locator(`.PZ2QoL_mdSide .PZ2QoL_mdSeg.mode .PZ2QoL_mdSegItem[data-value="${v}"]`);
    const rowInfo = key => page.evaluate(k => {
        const row = document.querySelector(`.PZ2QoL_mdRow[data-key="${k}"]`);
        const st = row && row.querySelector('.PZ2QoL_mdCell.state');
        return row ? { on: row.classList.contains('on'), off: row.classList.contains('blocked'), ok: row.classList.contains('quickok'), state: st.innerText, title: row.title || st.title } : null;
    }, key);
    const side = () => page.evaluate(() => {
        const s = document.querySelector('.PZ2QoL_mdSide');
        return {
            quick: s.classList.contains('quick'), head: (s.querySelector('.PZ2QoL_mdQuickHead') || {}).innerText || '', first: (s.querySelector('.PZ2QoL_mdQuickFirst') || {}).innerText || '',
            big: +(s.querySelector('.PZ2QoL_mdBig .n') || {}).innerText, total: (s.querySelector('.PZ2QoL_mdTotal') || {}).innerText || '',
            button: ((s.querySelector('.PZ2QoL_kpBtn.quick') || {}).innerText || '').trim(), stop: !!s.querySelector('.PZ2QoL_kpBtn.stop'),
            card: (s.querySelector('.PZ2QoL_mdRun') || {}).innerText || '',
            lines: [...s.querySelectorAll('.PZ2QoL_mdRun .PZ2QoL_mdRunLine')].map(n => n.innerText),
        };
    });
    const sheetOpen = () => page.evaluate(() => { const s = document.querySelector('.PZ2QoL_mdSheet'); return !!s && !s.classList.contains('hidden'); });
    const jobs = () => page.evaluate(() => window.__mqt.jobs.length);
    const pad = (down, up) => page.evaluate(async ([d, u]) => (await import('/js/common/core/Input.js')).__simulateButtonInput('UI_Select', d, u), [down, up]);
    try {
        await openDesk();
        await page.waitForSelector('.PZ2QoL_md:not(.hidden) .PZ2QoL_mdRow[data-id^="g"]', { timeout: 8000 });
        await page.waitForTimeout(800);
        await click(page.locator(`.PZ2QoL_mdSpecies[data-species="${sp.replace(/"/g, '\\"')}"]`));
        await page.waitForTimeout(400);
        // 0. the Frontier Zoo animal: Quick trade from the storage list, before any check
        facts.pre = { row: await rowInfo(keys[4]), note: await page.evaluate(() => (document.querySelector('.PZ2QoL_mdPreNote') || {}).innerText || '') };
        if (!facts.pre.row || facts.pre.row.state !== 'Quick trade (from the storage list)' || !facts.pre.row.off) problems.push(`pre-classified row: ${JSON.stringify(facts.pre.row)}`);
        if (!/checked again before it goes/.test(facts.pre.note)) problems.push(`no pre-classification note: "${facts.pre.note}"`);
        await ctx.shot(page, 'mqt_0_pre');
        // Check storage gives every animal its verdict
        const t0 = Date.now();
        await click(page.locator('.PZ2QoL_md .PZ2QoL_mdCheck .PZ2QoL_kpBtn'));
        // (a finished check card from an earlier scenario may still show: wait for this job)
        await page.waitForFunction(() => window.__mqt.jobs.length >= 1 && !window.__mqt.running, null, { timeout: 30000 }).catch(() => {});
        facts.checkMs = Date.now() - t0;
        facts.checkJob = await page.evaluate(() => window.__mqt.jobs.map(j => [j.head, j.items.length]));
        await page.waitForTimeout(500);

        // 1. Quick trade mode: red, its header, only its rows; proven in game,
        // so no one-animal limit (Quick release keeps it, step 5)
        await click(modeSeg('quicktrade'));
        await page.waitForTimeout(300);
        facts.mode = await side();
        if (!facts.mode.quick || facts.mode.head !== "QUICK TRADE · sells for cash at once · can't be undone") problems.push(`quick panel: ${JSON.stringify(facts.mode)}`);
        if (facts.mode.first) problems.push(`a first-run note for Quick trade: "${facts.mode.first}"`);
        // every animal the game allows Quick trade for, market ones included; not one it refuses
        facts.rowsQuick = { quick: await rowInfo(keys[0]), market: await rowInfo(keys[3]), notAllowed: await rowInfo(keys[6]) };
        if (!facts.rowsQuick.quick.ok || facts.rowsQuick.quick.off || !facts.rowsQuick.market.ok || facts.rowsQuick.market.off || !/Quick trade · \$700/.test(facts.rowsQuick.market.state)) problems.push(`quick-mode rows: ${JSON.stringify(facts.rowsQuick)}`);
        if (!facts.rowsQuick.notAllowed.off || !/doesn't allow Quick trade/.test(facts.rowsQuick.notAllowed.title)) problems.push(`a row the game won't quick-trade: ${JSON.stringify(facts.rowsQuick.notAllowed)}`);
        await click(page.locator(`.PZ2QoL_mdRow[data-key="${keys[6]}"]`));
        await page.waitForTimeout(200);
        if ((await rowInfo(keys[6])).on) problems.push('a row the game will not quick-trade got ticked');
        await click(page.locator('.PZ2QoL_mdTools .PZ2QoL_kpBtn', { hasText: 'Tick all shown' }));
        await page.waitForTimeout(300);
        facts.allTick = (await side()).big;
        if (facts.allTick !== 6) problems.push(`Quick trade: Tick all ticked ${facts.allTick} (6 allowed, no limit expected)`);
        await ctx.shot(page, 'mqt_1_mode');
        layoutProblems('mode', await layout(page), problems);
        // the server refused two market animals in a listing run: one click quick-trades them
        await click(modeSeg('list'));
        await page.waitForTimeout(200);
        await page.evaluate(g => engine.trigger('PZ2QoL_ListerState', JSON.stringify({ run: 398, req: 'listrun', mode: 'list', phase: 'done', total: 3, index: 3, step: '', waited: 0, message: 'Listed 1 of 3.',
            results: [{ guid: g[3], status: 'refused', kind: 'refused', detail: 'Refused by the server (Unknown).' }, { guid: g[5], status: 'refused', kind: 'refused', detail: 'Refused by the server (Unknown).' }, { guid: g[6], status: 'listed', price: 500 }] })), await page.evaluate(() => window.__mqt.g));
        await page.waitForTimeout(400);
        facts.refusedBtn = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_mdRun .PZ2QoL_kpBtn')].map(n => n.innerText.trim()));
        await click(page.locator('.PZ2QoL_mdRun .PZ2QoL_kpBtn', { hasText: 'Quick trade the 2 refused' }));
        await page.waitForTimeout(400);
        facts.refused = { side: await side(), r3: await rowInfo(keys[3]), r5: await rowInfo(keys[5]) };
        await ctx.shot(page, 'mqt_1b_refused');
        if (!facts.refusedBtn.includes('Quick trade the 2 refused') || !facts.refused.side.quick || facts.refused.side.big !== 2 || !facts.refused.r3.on || !facts.refused.r5.on) problems.push(`refused -> Quick trade: ${JSON.stringify(facts.refusedBtn)} ${JSON.stringify(facts.refused)}`);
        layoutProblems('refused', await layout(page), problems);
        // one animal for the sheet checks and the first run
        await click(page.locator('.PZ2QoL_mdTools .PZ2QoL_kpBtn', { hasText: 'Untick shown' }));
        await page.waitForTimeout(200);
        await click(page.locator(`.PZ2QoL_mdRow[data-key="${keys[0]}"]`));
        await page.waitForTimeout(200);

        // 2. the sheet: Cancel, Esc, a double click and Confirm during a run send nothing
        const openSheet = () => click(page.locator('.PZ2QoL_mdSide .PZ2QoL_kpBtn.quick'));
        const confirmBtn = () => page.locator('.PZ2QoL_mdSheetButtons .PZ2QoL_kpBtn.confirm');
        await openSheet();
        await page.waitForTimeout(400);
        facts.sheet = await page.evaluate(() => ({
            title: (document.querySelector('.PZ2QoL_mdSheetTitle') || {}).innerText || '',
            go: [...document.querySelectorAll('.PZ2QoL_mdSheetList.go .PZ2QoL_mdSheetLine')].map(n => n.innerText),
            warn: (document.querySelector('.PZ2QoL_mdSheetWarn') || {}).innerText || '',
            confirm: ((document.querySelector('.PZ2QoL_mdSheetButtons .PZ2QoL_kpBtn.confirm') || {}).innerText || '').trim(),
            hold: !!document.querySelector('.PZ2QoL_mdHold'),
        }));
        await ctx.shot(page, 'mqt_2_sheet');
        layoutProblems('sheet', await layout(page), problems);
        if (!/^Quick trade 1 animal for \$[\d,]+\?$/.test(facts.sheet.title) || facts.sheet.go.length !== 1 || facts.sheet.warn !== "These animals leave your storage for good. This can't be undone." || facts.sheet.confirm !== 'Quick trade now (1)' || facts.sheet.hold) problems.push(`sheet: ${JSON.stringify(facts.sheet)}`);
        await click(page.locator('.PZ2QoL_mdSheetButtons .PZ2QoL_kpBtn', { hasText: 'Cancel' }));
        await page.waitForTimeout(200);
        facts.cancel = { open: await sheetOpen(), jobs: await jobs() };
        await openSheet();
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        facts.esc = { open: await sheetOpen(), desk: await page.locator('.PZ2QoL_md:not(.hidden)').count(), jobs: await jobs() };
        // a double click: the second click lands on Confirm within 300 ms of the opening
        await openSheet();
        await confirmBtn().first().dispatchEvent('click');
        await page.waitForTimeout(200);
        facts.dbl = { open: await sheetOpen(), jobs: await jobs() };
        if (facts.cancel.open || facts.cancel.jobs !== 1) problems.push(`Cancel: ${JSON.stringify(facts.cancel)}`);
        if (facts.esc.open || facts.esc.desk !== 1 || facts.esc.jobs !== 1) problems.push(`Esc: ${JSON.stringify(facts.esc)}`);
        if (!facts.dbl.open || facts.dbl.jobs !== 1) problems.push(`a double click confirmed: ${JSON.stringify(facts.dbl)}`);
        // Confirm does nothing while a run is active
        await page.evaluate(() => engine.trigger('PZ2QoL_ListerState', JSON.stringify({ run: 399, req: 'other', mode: 'check', phase: 'running', total: 1, index: 0, step: 'select', waited: 0, message: '', results: [{ guid: '1', status: 'working' }] })));
        await page.waitForTimeout(400);
        await click(confirmBtn());
        await page.waitForTimeout(200);
        facts.busyConfirm = { jobs: await jobs() };
        await page.evaluate(() => engine.trigger('PZ2QoL_ListerState', JSON.stringify({ run: 399, req: 'other', mode: 'check', phase: 'done', total: 1, index: 1, step: '', waited: 0, message: 'Checked 0 of 1.', results: [{ guid: '1', status: 'pending' }] })));
        await page.waitForTimeout(200);
        if (facts.busyConfirm.jobs !== 1) problems.push(`Confirm sent a job while a run was active (${facts.busyConfirm.jobs})`);

        // 3. Confirm: exactly the frozen job
        if (!(await sheetOpen())) await openSheet();
        await page.waitForTimeout(400);
        await page.evaluate(() => { window.__mqt.stepMs = 400; });
        await click(confirmBtn());
        await page.waitForTimeout(150);
        const job1 = await page.evaluate(() => window.__mqt.jobs[1]);
        facts.job1 = job1 && { head: job1.head, n: job1.items.length };
        if (!job1 || !/^v1 \d+ quicktrade$/.test(job1.head) || +job1.head.split(' ')[1] < 1000 || job1.items.length !== 1) problems.push(`quick job: ${JSON.stringify(facts.job1)}`);
        facts.running = await side();
        await ctx.shot(page, 'mqt_3_running');
        if (!facts.running.stop || facts.running.button || !facts.running.quick) problems.push(`while running: ${JSON.stringify(facts.running)}`);
        await page.waitForSelector('.PZ2QoL_mdRun.quick.done', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(400);
        facts.done = await side();
        await ctx.shot(page, 'mqt_4_done');
        if (!/Quick-traded 1 of 1 · \$[\d,]+/.test(facts.done.card) || !facts.done.lines.some(l => l.startsWith('✓ '))) problems.push(`done card: ${JSON.stringify(facts.done)}`);

        // 4. several at once; the run stops when one stays in storage
        await click(page.locator('.PZ2QoL_mdTools .PZ2QoL_kpBtn', { hasText: 'Tick all shown' }));
        await page.waitForTimeout(300);
        facts.many = await side();
        if (!(facts.many.big >= 2) || !/^Quick trade \d+ animals \(\$[\d,]+( \+ \d+ priced when checked)?\)…$/.test(facts.many.button)) problems.push(`several: ${JSON.stringify(facts.many)}`);
        await page.evaluate(() => { window.__mqt.stepMs = 120; window.__mqt.outcome = (g, i) => (i === 1 ? 'stay' : 'gone'); });
        await openSheet();
        await page.waitForTimeout(400);
        await click(confirmBtn());
        await page.waitForSelector('.PZ2QoL_mdRun.quick.stopped', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(400);
        facts.stopped = await side();
        await ctx.shot(page, 'mqt_5_stopped');
        const job2 = await page.evaluate(() => window.__mqt.jobs[2]);
        if (!job2 || job2.items.length !== facts.many.big) problems.push(`second job: ${job2 && job2.items.length} animals, ${facts.many.big} ticked`);
        if (!/Stopped/.test(facts.stopped.card) || !/still in storage/.test(facts.stopped.card) || !facts.stopped.lines.some(l => /not confirmed: check storage/.test(l))) problems.push(`stopped card: ${JSON.stringify(facts.stopped)}`);
        layoutProblems('stopped', await layout(page), problems);

        // 5. Quick release: one animal until its first confirmed run; the gamepad's A; a reload stops it
        await click(modeSeg('release'));
        await page.waitForTimeout(300);
        facts.release = await side();
        if (facts.release.head !== "QUICK RELEASE · releases to the wild for CC at once · can't be undone" || !/First quick release/.test(facts.release.first)) problems.push(`release panel: ${JSON.stringify(facts.release)}`);
        await click(page.locator('.PZ2QoL_mdTools .PZ2QoL_kpBtn', { hasText: 'Tick all shown' }));
        await page.waitForTimeout(300);
        facts.releaseTick = (await side()).big;
        const jobsBefore = await jobs();
        await openSheet();
        // A pressed as the sheet opens: ignored
        await pad(true, false);
        await pad(false, true);
        await page.waitForTimeout(400);
        facts.padEarly = { jobs: (await jobs()) - jobsBefore, open: await sheetOpen() };
        await page.evaluate(() => { window.__mqt.outcome = () => 'reload'; });
        await pad(true, false);
        await pad(false, true);
        await page.waitForSelector('.PZ2QoL_mdRun.quick.stopped', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(400);
        facts.padConfirm = { jobs: (await jobs()) - jobsBefore, job: await page.evaluate(() => window.__mqt.jobs[window.__mqt.jobs.length - 1].head) };
        facts.reloaded = await side();
        facts.acceptedAfterReload = await page.evaluate(async () => (await import('/js/mods/pz2qol/prefs.js')).getPref('quickAccepted'));
        await ctx.shot(page, 'mqt_6_reloaded');
        if (facts.releaseTick !== 1) problems.push(`release before acceptance ticked ${facts.releaseTick}`);
        if (facts.padEarly.jobs !== 0 || !facts.padEarly.open) problems.push(`gamepad A as the sheet opened: ${JSON.stringify(facts.padEarly)}`);
        if (facts.padConfirm.jobs !== 1 || !/^v1 \d+ release$/.test(facts.padConfirm.job)) problems.push(`gamepad A: ${JSON.stringify(facts.padConfirm)}`);
        if (!/Stopped: page reloaded\./.test(facts.reloaded.card) || !facts.reloaded.lines.length) problems.push(`reload card: ${JSON.stringify(facts.reloaded)}`);
        if (facts.acceptedAfterReload && facts.acceptedAfterReload.release) problems.push('release accepted although it was not confirmed');

        // 6. a quick mode is never remembered
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await openDesk();
        await page.waitForTimeout(600);
        facts.reopened = await page.evaluate(() => ({ on: (document.querySelector('.PZ2QoL_mdSide .PZ2QoL_mdSeg.mode .PZ2QoL_mdSegItem.on') || {}).getAttribute ? document.querySelector('.PZ2QoL_mdSide .PZ2QoL_mdSeg.mode .PZ2QoL_mdSegItem.on').getAttribute('data-value') : null, quick: document.querySelector('.PZ2QoL_mdSide').classList.contains('quick') }));
        if (facts.reopened.on !== 'list' || facts.reopened.quick) problems.push(`reopened in ${JSON.stringify(facts.reopened)}`);
        // 7. a start the engine answers late: "not answered yet", then the run shows
        await click(page.locator('.PZ2QoL_md .PZ2QoL_kpBtn', { hasText: 'Read storage again' }));
        await page.waitForTimeout(1200);
        await page.evaluate(() => { window.__mqt.delayStart = 6500; window.__mqt.stepMs = 60; });
        const jl = await jobs();
        await click(page.locator('.PZ2QoL_md .PZ2QoL_mdCheck .PZ2QoL_kpBtn'));
        await page.waitForTimeout(5800);
        facts.late = { notice: await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_md .PZ2QoL_mdNotice')].filter(n => !n.classList.contains('hidden')).map(n => n.innerText).join(' | ')), jobs: (await jobs()) - jl };
        await page.waitForFunction(() => !window.__mqt.running && document.querySelector('.PZ2QoL_mdRun.check.done'), null, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(500);
        facts.late.card = await page.evaluate(() => (document.querySelector('.PZ2QoL_mdRun.check') || {}).innerText || '');
        facts.late.log = await page.evaluate(() => (window.__dlog || []).filter(l => / engine_started_late /.test(l)).slice(-1));
        await page.evaluate(() => { window.__mqt.delayStart = 0; });
        if (facts.late.jobs !== 1 || !/not answered yet; it may still start/.test(facts.late.notice) || /did not start/.test(facts.late.notice)) problems.push(`late answer, notice: ${JSON.stringify(facts.late)}`);
        if (!/Storage checked/.test(facts.late.card)) problems.push(`late answer: the run did not show: ${JSON.stringify(facts.late)}`);
        if (!facts.late.log.length || !/ok=true/.test(facts.late.log[0])) problems.push(`late answer not reconciled in the log: ${JSON.stringify(facts.late.log)}`);
        await ctx.shot(page, 'mqt_7_late');

        facts.events = await page.evaluate(() => window.__mqt.events.slice());
        if (facts.events.length) problems.push(`vanilla events fired: ${JSON.stringify(facts.events)}`);
    }
    finally {
        await page.evaluate(async () => {
            if (window.__mqt) window.__mqt.active = false;
            window.__PZ2QOL_TEST_FRANCHISE = undefined;
            (await import('/js/mods/pz2qol/prefs.js')).setPref('quickAccepted', undefined);
            const d = (await import('/js/mods/pz2qol/kinpanel.js')).panelApi('desk');
            if (d && d.isOpen()) d.close();
        }).catch(() => {});
    }
    if (problems.length) throw new Error('market desk quick trade run: ' + problems.join('; '));
    return facts;
}
