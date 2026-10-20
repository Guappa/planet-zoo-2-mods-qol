// Trade shortcuts (tradejump.js): Species board / Kin planner -> the hub's
// Animal Storage or Market for one species.
//  HUD (park): a fake Lua answers PZ2QoL_TradeCounts (Lion 2 ♂ 3 ♀) and
//  PZ2QoL_TradeOpen. Checks the board's count line and buttons, that one
//  click sends exactly one TradeOpen and closes the board, the disabled
//  states (no trade centre, hub disabled) with a visible reason and no event,
//  a refusal from Lua (board stays, notice), the 'nohud' fallback (the game's
//  own HUD_OpenHubAnimalMarket), the head layout, and the Kin planner's
//  Find a mate row (Market for the animal's species, planner closes).
//  Frontend (hub): a fake Lua hands over the storage filter on the page's
//  hello (PZ2QoL_TradeFilter); checks only that species' rows are listed,
//  the "Lion only" chip, one PZ2QoL_TradeAck, the chip clearing it, a repeated
//  filter only re-confirmed, and the storage bar height.
import { seedZooKin } from './kin_fixture.mjs';
import { seedStorageKin } from './kin_storage.mjs';
import { layoutFacts as boardLayout, layoutProblems as boardProblems } from './kin_board.mjs';
import { layoutFacts as plannerLayout, layoutProblems as plannerProblems } from './kin_planner.mjs';

export const name = 'tradejump';

const BOARD = '/js/mods/pz2qol/kinboard.js';
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

const setHud = (page, building, hubDisabled) => page.evaluate(async ([b, d]) => {
    const DS = await import('/js/common/core/DataStore.js');
    DS.setValue(['park'], 'hasBuildingForAnimalStorage', b);
    DS.setValue(['ui', 'HUD'], 'hubDisabled', d);
}, [building, hubDisabled]);

const boardOpen = page => page.evaluate(async url => (await import(url)).isSpeciesBoardOpen(), BOARD);
const openBoard = page => page.evaluate(async url => (await import(url)).openSpeciesBoard({ species: 'Lion' }), BOARD);
const tradeFacts = (page, root) => page.evaluate(r => {
    const row = document.querySelector(`${r}`);
    if (!row) return null;
    const btns = [...row.querySelectorAll('.PZ2QoL_tradeBtn')];
    const note = row.querySelector('.PZ2QoL_tradeNote');
    const shown = el => !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none';
    return {
        buttons: btns.map(b => ({ kind: b.getAttribute('data-trade'), text: b.innerText.trim(), disabled: b.classList.contains('disabled'), shown: shown(b) })),
        note: note && shown(note) ? note.innerText.trim() : '',
        noteWarn: !!(note && note.classList.contains('warn')),
        display: getComputedStyle(row).display,
        dir: getComputedStyle(row).flexDirection,
    };
}, root);

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
    await setHud(page, true, false);
    await page.evaluate(() => {
        window.__tj = { active: true, opens: [], counts: [], fallback: 0, answer: 'ok' };
        if (!window.__tjHooked) {
            window.__tjHooked = true;
            engine.on('PZ2QoL_TradeCounts', (req, csv) => {
                if (!window.__tj.active) return;
                window.__tj.counts.push(String(csv));
                engine.trigger('PZ2QoL_TradeCountsResult', req, JSON.stringify({ ok: true, mode: 'franchise', bySpecies: { Lion: { m: 2, f: 3 }, Tiger: { m: 0, f: 0 } } }));
            });
            engine.on('PZ2QoL_TradeOpen', (req, kind, species) => {
                const tj = window.__tj;
                if (!tj.active) return;
                tj.opens.push([String(kind), String(species)]);
                engine.trigger('PZ2QoL_TradeOpenResult', req, tj.answer === 'ok', tj.answer === 'ok' ? '' : tj.answer);
            });
            engine.on('HUD_OpenHubAnimalMarket', () => { if (window.__tj.active) window.__tj.fallback++; });
        }
    });
    const tj = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__tj)));
    const resetTj = (answer = 'ok') => page.evaluate(a => Object.assign(window.__tj, { opens: [], counts: [], fallback: 0, answer: a }), answer);

    try {
        // 1. the board on Lion: counts line and the two buttons in the head
        await openBoard(page);
        await page.waitForSelector('.PZ2QoL_kb:not(.hidden) .PZ2QoL_kbTrade', { timeout: 4000 });
        await page.waitForTimeout(400);
        facts.board = await tradeFacts(page, '.PZ2QoL_kb .PZ2QoL_kbTrade');
        facts.countRequests = (await tj()).counts;
        await ctx.shot(page, 'tj_1_board_head');
        facts.layout = await boardLayout(page);
        boardProblems('board', facts.layout, problems);
        facts.headRect = await page.evaluate(() => {
            const head = document.querySelector('.PZ2QoL_kb .PZ2QoL_kpMainHead');
            const row = document.querySelector('.PZ2QoL_kb .PZ2QoL_kbTrade');
            const r = row.getBoundingClientRect(), hr = head.getBoundingClientRect();
            return { row: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], head: [Math.round(hr.left), Math.round(hr.top), Math.round(hr.right), Math.round(hr.bottom)] };
        });
        const b = facts.board;
        if (!b) problems.push('no trade row in the board head');
        else {
            if (b.note !== '2♂ 3♀ adults in storage') problems.push(`count line "${b.note}"`);
            if (b.buttons.map(x => x.kind).join(',') !== 'storage,market') problems.push(`buttons ${JSON.stringify(b.buttons)}`);
            if (b.buttons.some(x => x.disabled || !x.shown)) problems.push('a button is disabled or hidden with a trade centre');
            if (b.display !== 'flex' || b.dir !== 'row') problems.push(`trade row is ${b.display}/${b.dir}`);
        }
        if (!facts.countRequests.some(c => /(^|,)Lion(,|$)/.test(c))) problems.push(`no storage count asked for Lion: ${JSON.stringify(facts.countRequests)}`);
        if (facts.countRequests.length > 1) problems.push(`counts asked ${facts.countRequests.length} times on one open`);

        // 2. Storage: exactly one TradeOpen, the board closes
        await resetTj();
        await click(page.locator('.PZ2QoL_kb .PZ2QoL_kbTrade .PZ2QoL_tradeBtn[data-trade="storage"]'));
        await page.waitForTimeout(400);
        facts.storageClick = await tj();
        facts.closedAfterStorage = !(await boardOpen(page));
        if (JSON.stringify(facts.storageClick.opens) !== JSON.stringify([['storage', 'Lion']])) problems.push(`Storage sent ${JSON.stringify(facts.storageClick.opens)}`);
        if (!facts.closedAfterStorage) problems.push('board did not close after the hub opened');

        // 3. a refusal from Lua: the board stays, the reason shows
        await resetTj('nobuilding');
        await openBoard(page);
        await page.waitForTimeout(300);
        await click(page.locator('.PZ2QoL_kb .PZ2QoL_kbTrade .PZ2QoL_tradeBtn[data-trade="market"]'));
        await page.waitForTimeout(400);
        facts.refused = { sent: (await tj()).opens, open: await boardOpen(page), note: (await tradeFacts(page, '.PZ2QoL_kb .PZ2QoL_kbTrade')).note, notice: await text(page, '.PZ2QoL_kb .PZ2QoL_kpNotice') };
        await ctx.shot(page, 'tj_2_refused');
        if (facts.refused.sent.length !== 1 || facts.refused.sent[0][0] !== 'market') problems.push(`refused: sent ${JSON.stringify(facts.refused.sent)}`);
        if (!facts.refused.open) problems.push('board closed although the hub did not open');
        if (!/Build a trade centre/.test(facts.refused.note)) problems.push(`refusal not shown: "${facts.refused.note}"`);

        // 4. no trade centre (the HUD flag): disabled, visible reason, nothing sent
        await resetTj();
        await setHud(page, false, false);
        await page.evaluate(async url => { const m = await import(url); m.closeSpeciesBoard(); m.openSpeciesBoard({ species: 'Lion' }); }, BOARD);
        await page.waitForTimeout(400);
        facts.noBuilding = await tradeFacts(page, '.PZ2QoL_kb .PZ2QoL_kbTrade');
        await click(page.locator('.PZ2QoL_kb .PZ2QoL_kbTrade .PZ2QoL_tradeBtn[data-trade="storage"]'));
        await page.waitForTimeout(300);
        facts.noBuildingSent = (await tj()).opens.length;
        await ctx.shot(page, 'tj_3_no_trade_centre');
        if (!facts.noBuilding || !facts.noBuilding.buttons.every(x => x.disabled)) problems.push('buttons not disabled without a trade centre');
        if (!facts.noBuilding || !/Build a trade centre/.test(facts.noBuilding.note) || !facts.noBuilding.noteWarn) problems.push(`no visible reason without a trade centre: ${JSON.stringify(facts.noBuilding)}`);
        if (facts.noBuildingSent) problems.push('a disabled button sent an event');

        // 5. the hub disabled by the game
        await setHud(page, true, true);
        await page.evaluate(async url => { const m = await import(url); m.closeSpeciesBoard(); m.openSpeciesBoard({ species: 'Lion' }); }, BOARD);
        await page.waitForTimeout(300);
        facts.hubDisabled = await tradeFacts(page, '.PZ2QoL_kb .PZ2QoL_kbTrade');
        if (!facts.hubDisabled || !facts.hubDisabled.buttons.every(x => x.disabled) || !/hub can't be opened/.test(facts.hubDisabled.note)) problems.push(`hub disabled: ${JSON.stringify(facts.hubDisabled)}`);
        await setHud(page, true, false);

        // 6. Lua can't reach the HUD: the game's own Market & Storage button
        await resetTj('nohud');
        await page.evaluate(async url => { const m = await import(url); m.closeSpeciesBoard(); m.openSpeciesBoard({ species: 'Lion' }); }, BOARD);
        await page.waitForTimeout(300);
        await click(page.locator('.PZ2QoL_kb .PZ2QoL_kbTrade .PZ2QoL_tradeBtn[data-trade="storage"]'));
        await page.waitForTimeout(400);
        facts.fallback = await tj();
        facts.closedAfterFallback = !(await boardOpen(page));
        if (facts.fallback.fallback !== 1 || facts.fallback.opens.length !== 1) problems.push(`nohud fallback: ${JSON.stringify(facts.fallback)}`);
        if (!facts.closedAfterFallback) problems.push('board did not close after the fallback');

        // 7. Kin planner, Find a mate: the row (no count line), Market
        await resetTj();
        const lion = seeded.layout.find(l => l.species === 'Lion' && l.n === 0);
        await page.evaluate(async ([url, id]) => (await import(url)).openKinPlanner({ animalId: id }), [PLANNER, lion.id]);
        await page.waitForSelector('.PZ2QoL_kp:not(.hidden) .PZ2QoL_kpDet.mates .PZ2QoL_kpTradeRow', { timeout: 4000 });
        await page.waitForTimeout(400);
        facts.planner = await tradeFacts(page, '.PZ2QoL_kp .PZ2QoL_kpDet.mates .PZ2QoL_kpTradeRow');
        facts.plannerCounts = (await tj()).counts.length;
        facts.plannerLayout = await plannerLayout(page);
        plannerProblems('planner', facts.plannerLayout, problems);
        facts.plannerRowBox = await page.evaluate(() => {
            const row = document.querySelector('.PZ2QoL_kp .PZ2QoL_kpDet.mates .PZ2QoL_kpTradeRow');
            const det = row.closest('.PZ2QoL_kpDet');
            const r = row.getBoundingClientRect(), d = det.getBoundingClientRect();
            const btns = [...row.querySelectorAll('.PZ2QoL_tradeBtn')].map(b => b.getBoundingClientRect());
            return { inside: r.left >= d.left - 1 && r.right <= d.right + 1, oneLine: btns.length === 2 && Math.abs(btns[0].top - btns[1].top) < 2, h: Math.round(r.height) };
        });
        await ctx.shot(page, 'tj_4_planner_mates');
        const p = facts.planner;
        if (!p || p.buttons.map(x => x.kind).join(',') !== 'storage,market' || p.buttons.some(x => x.disabled)) problems.push(`planner row ${JSON.stringify(p)}`);
        if (p && p.note) problems.push(`planner row shows a line: "${p.note}"`);
        if (facts.plannerCounts) problems.push('the planner asked for storage counts');
        if (!facts.plannerRowBox.inside || !facts.plannerRowBox.oneLine) problems.push(`planner row layout ${JSON.stringify(facts.plannerRowBox)}`);
        await click(page.locator('.PZ2QoL_kp .PZ2QoL_kpTradeRow .PZ2QoL_tradeBtn[data-trade="market"]'));
        await page.waitForTimeout(400);
        facts.plannerClick = (await tj()).opens;
        facts.plannerClosed = !(await page.evaluate(async url => (await import(url)).isKinPlannerOpen(), PLANNER));
        if (JSON.stringify(facts.plannerClick) !== JSON.stringify([['market', 'Lion']])) problems.push(`planner Market sent ${JSON.stringify(facts.plannerClick)}`);
        if (!facts.plannerClosed) problems.push('planner did not close after the hub opened');
    }
    finally {
        await page.evaluate(async ([b, p]) => {
            if (window.__tj) window.__tj.active = false;
            (await import(b)).closeSpeciesBoard();
            (await import(p)).closeKinPlanner();
            const DS = await import('/js/common/core/DataStore.js');
            DS.setValue(['ui', 'HUD'], 'hubDisabled', false);
            const kin = await import('/js/mods/pz2qol/kin.js');
            if (window.__kinFixture) kin.applyKinSnapshot(window.__kinFixture.snapshot);
        }, [BOARD, PLANNER]).catch(() => {});
    }
    if (problems.length) throw new Error('trade shortcuts (HUD): ' + problems.join('; '));
    return facts;
}

const listInfo = page => page.evaluate(async () => {
    const DS = await import('/js/common/core/DataStore.js');
    const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
    const c = new DataStoreCollection(['hubAnimalsData', 'animalStorageData', 'list']);
    await new Promise(r => setTimeout(r, 150));
    const norm = s => String(s || '').replace(/^\[/, '').replace(/\]$/, '').replace(/^Animal_/, '').toLowerCase();
    const shown = c.source.map(ctx => norm(DS.getValue(ctx, 'species')));
    const all = c._source.map(ctx => norm(DS.getValue(ctx, 'species')));
    c.dispose();
    return { shown: shown.length, shownSpecies: [...new Set(shown)], all: all.length, lions: all.filter(s => s === 'lion').length };
});

export async function frontend(page, ctx) {
    const facts = ctx.facts || {};
    const problems = [];
    facts.problems = problems;
    // the fake Lua: hands the filter over on hello until it is confirmed
    await page.evaluate(() => {
        window.__tjf = { active: true, pending: null, hellos: 0, acks: [] };
        if (!window.__tjfHooked) {
            window.__tjfHooked = true;
            engine.on('PZ2QoL_TradeHello', () => {
                const f = window.__tjf;
                if (!f.active) return;
                f.hellos++;
                if (f.pending) engine.trigger('PZ2QoL_TradeFilter', f.pending.seq, 'storage', f.pending.species);
            });
            engine.on('PZ2QoL_TradeAck', seq => {
                const f = window.__tjf;
                if (!f.active) return;
                f.acks.push(seq);
                if (f.pending && f.pending.seq === seq) f.pending = null;
            });
        }
    });
    const tjf = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__tjf)));
    try {
        await ctx.gotoMarketTab(page, 1);
        await seedStorageKin(page);
        await page.waitForTimeout(400);
        facts.before = await listInfo(page);
        // the player clicked Storage on the board: Lua holds Lion for the hub
        await page.evaluate(() => { window.__tjf.pending = { seq: 7, species: 'Lion' }; });
        // the page says hello when Storage comes on screen
        await ctx.gotoMarketTab(page, 0);
        await ctx.gotoMarketTab(page, 1);
        await page.waitForTimeout(1200);
        facts.after = await listInfo(page);
        facts.lua = await tjf();
        facts.chip = await page.evaluate(() => {
            const c = document.querySelector('.PZ2QoL_bar.storage .PZ2QoL_speciesChip');
            if (!c) return null;
            return { text: c.innerText.replace(/\s+/g, ' ').trim(), on: c.classList.contains('on'), shown: c.getBoundingClientRect().width > 0 && getComputedStyle(c).display !== 'none' };
        });
        facts.barHeight = await page.evaluate(() => Math.round(document.querySelector('.PZ2QoL_bar.storage').getBoundingClientRect().height));
        await ctx.shot(page, 'tj_5_storage_filtered');
        if (facts.lua.hellos < 1) problems.push('the hub page never said hello');
        if (JSON.stringify(facts.lua.acks) !== '[7]') problems.push(`acks ${JSON.stringify(facts.lua.acks)}, expected [7]`);
        if (!(facts.before.lions >= 8)) problems.push(`fixture: only ${facts.before.lions} lions in storage`);
        if (facts.after.shown !== facts.before.lions || facts.after.shownSpecies.join(',') !== 'lion') problems.push(`filtered list: ${JSON.stringify(facts.after)} (expected ${facts.before.lions} lions only)`);
        if (!facts.chip || !facts.chip.shown || !facts.chip.on || !/Lion only/.test(facts.chip.text)) problems.push(`species chip ${JSON.stringify(facts.chip)}`);
        if (facts.barHeight > 90) problems.push(`storage bar ${facts.barHeight} px high (> 90)`);

        // the chip clears it: every row is back
        await click(page.locator('.PZ2QoL_bar.storage .PZ2QoL_speciesChip'));
        await page.waitForTimeout(600);
        facts.cleared = await listInfo(page);
        facts.chipAfter = await page.evaluate(() => getComputedStyle(document.querySelector('.PZ2QoL_bar.storage .PZ2QoL_speciesChip')).display);
        if (facts.cleared.shown !== facts.before.all) problems.push(`after the chip: ${facts.cleared.shown} rows of ${facts.before.all}`);
        if (facts.chipAfter !== 'none') problems.push('species chip still shown after clearing');

        // the same filter again (a late answer to a second hello): only confirmed
        await page.evaluate(() => engine.trigger('PZ2QoL_TradeFilter', 7, 'storage', 'Lion'));
        await page.waitForTimeout(1200);
        facts.repeat = { list: await listInfo(page), acks: (await tjf()).acks };
        if (facts.repeat.list.shown !== facts.before.all) problems.push('a repeated filter was applied again after the player cleared it');
        if (facts.repeat.acks.length !== 2) problems.push(`repeated filter acks ${JSON.stringify(facts.repeat.acks)}`);
        await ctx.shot(page, 'tj_6_storage_cleared');
    }
    finally {
        await page.evaluate(async () => {
            if (window.__tjf) window.__tjf.active = false;
            (await import('/js/mods/pz2qol/listfilter.js')).resetStorageFilters();
        }).catch(() => {});
    }
    if (problems.length) throw new Error('trade shortcuts (Frontend): ' + problems.join('; '));
    return facts;
}
