// Offline browser harness for Planet Zoo 2's Gameface UI + the PZ2QoL UI mod.
//
// Serves the game's unpacked UIGameface with the mod's UI/UIGameface overlaid
// (virtual merge, nothing copied or changed), opens the Frontend in headless
// Edge in Gameface "detached" mode (DataStore filled with the game's own
// schema-generated dummy data), drives the hub to Animal Market -> Market and
// -> Storage with the same listeners the game/Lua use, and saves screenshots,
// console output and DOM facts.
//
// Setup once (work dir defaults to the session scratchpad, override with
// PZ2H_WORK):   cd <work> && npm i playwright-core@1.48.2
// Run:          node tests/uiharness/run.mjs [--no-vanilla] [--seed N] [--headed]
//
// Exit codes: 0 ok; 1 uncaught page error from /js/mods/pz2qol/;
//             2 harness could not reach a screen / expected DOM missing.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DEFAULT_WORK = "C:\\Users\\'admin'\\AppData\\Local\\Temp\\claude\\C--Github-Planet-Zoo-2-Mods\\a5756abe-49da-4666-a235-008cb1e4b99f\\scratchpad\\harness";

const argv = process.argv.slice(2);
const flag = k => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const WORK = path.resolve(opt('--work', process.env.PZ2H_WORK || DEFAULT_WORK));
const GAME = path.resolve(opt('--game', process.env.PZ2H_GAME || path.join(WORK, '..', 'ui', 'UIGameface')));
const OVERLAY = path.resolve(opt('--overlay', process.env.PZ2H_OVERLAY || path.join(REPO, 'mods', 'PZ2QoL', 'UI', 'UIGameface')));
const OUT = path.resolve(opt('--out', path.join(WORK, 'out')));
const EDGE = opt('--edge', process.env.PZ2H_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const SEED = Number(opt('--seed', 12345));
const HEADED = flag('--headed');
const KIN_ONLY = flag('--kin-only'); // only the kin_*.mjs scenarios (faster)
const VANILLA = !flag('--no-vanilla') && !KIN_ONLY;

let chromium;
try {
    ({ chromium } = createRequire(path.join(WORK, 'package.json'))('playwright-core'));
}
catch (e) {
    console.error(`playwright-core not found under ${WORK}\\node_modules.\nRun: cd "${WORK}" && npm init -y && npm i playwright-core@1.48.2`);
    process.exit(2);
}
for (const [name, p] of [['game UI', GAME], ['mod overlay', OVERLAY], ['Edge', EDGE]]) {
    if (!fs.existsSync(p)) { console.error(`${name} not found: ${p}`); process.exit(2); }
}
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------ page shims
// Runs before any page script. Each shim papers over a difference between
// Coherent Gameface and Chromium so the UI runs as it would in the game's
// own debug player; none of them touches game or mod files.
const GAMEFACE_COMPAT_CSS = `
:where(body, body *) { display: flex; box-sizing: border-box; }
:where([class*="PZ2QoL_"], [class*="PZ2QoL_"] *) { display: block; }
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
`;
function pageShims({ seed, css }) {
    // 1. Deterministic dummy data: the DataStore generator uses Math.random.
    let s = seed >>> 0;
    Math.random = function () {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // 2. Gameface lets setRequestHeader run before open(); Chromium throws.
    const X = XMLHttpRequest.prototype, xOpen = X.open, xSet = X.setRequestHeader;
    X.setRequestHeader = function (k, v) {
        if (this.readyState === 0) { (this.__pz2hHeaders ||= []).push([k, v]); return; }
        return xSet.call(this, k, v);
    };
    X.open = function (...a) {
        const r = xOpen.apply(this, a);
        for (const [k, v] of this.__pz2hHeaders || []) xSet.call(this, k, v);
        this.__pz2hHeaders = null;
        return r;
    };
    // 3. Gameface accepts empty / space-separated tokens in classList.*.
    const T = DOMTokenList.prototype;
    const norm = a => a.flatMap(t => String(t).split(/\s+/)).filter(Boolean);
    for (const m of ['add', 'remove']) { const o = T[m]; T[m] = function (...a) { return o.apply(this, norm(a)); }; }
    const tToggle = T.toggle;
    T.toggle = function (t, f) { const n = norm([t]); if (!n.length) return false; return f === undefined ? tToggle.call(this, n[0]) : tToggle.call(this, n[0], f); };
    const tContains = T.contains;
    T.contains = function (t) { const n = norm([t]); return n.length ? tContains.call(this, n[0]) : false; };
    // 4. Detached cohtml: engine.call() for an unmocked name never settles in
    //    a browser, so Engine.js never learns it is in the "Coherent Player"
    //    and never fires whenReady. The real player rejects unknown calls;
    //    do the same via engine._Reject (which also honours engine.mockCall).
    let eng;
    Object.defineProperty(window, 'engine', {
        configurable: true,
        get() { return eng; },
        set(v) {
            eng = v;
            if (v && v.isAttached === false && v.SendMessage && !v.__pz2hPatched) {
                v.__pz2hPatched = true;
                const send = v.SendMessage;
                v.SendMessage = function (name, id, ...args) {
                    if (v._mocks[name] === undefined) { setTimeout(() => v._Reject(id, name), 16); return; }
                    return send.call(this, name, id, ...args);
                };
            }
        },
    });
    // 5. Layout defaults at zero specificity. The game's own elements get
    //    flex here only because its CSS sets display:flex on them explicitly
    //    (about 2,300 times); Gameface does not default to flex. The mod's
    //    elements are left as block, exactly like in-game, so a missing
    //    display:flex in the mod's CSS shows up here (it broke the in-game
    //    layout once while this shim made everything flex).
    const addStyle = () => {
        const st = document.createElement('style');
        st.id = 'pz2h-gameface-compat';
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
    };
    if (document.documentElement) addStyle();
    else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); addStyle(); } }).observe(document, { childList: true });
}

// --------------------------------------------------------------- helpers
const NOISE = [
    /^Failed to load resource/, /^Failed to debug-load localisation/, /^Loaded font/, /^Debug Action/,
    /^Initialising System/, /^System initialised/, /^Engine\.sendEvent\(\)/, /Loaded\. Press/,
];
const isModText = t => /PZ2QoL/i.test(t) || /\/js\/mods\/pz2qol\//.test(t);

function attachCollectors(page, label) {
    const rec = { label, console: [], pageErrors: [] };
    page.on('console', m => {
        const loc = m.location();
        rec.console.push({ type: m.type(), text: m.text(), url: loc.url ? `${loc.url.replace(/^https?:\/\/[^/]+/, '')}:${loc.lineNumber + 1}` : '' });
    });
    page.on('pageerror', e => {
        rec.pageErrors.push({ message: e.message, stack: e.stack || '' });
    });
    return rec;
}

async function shot(page, name) {
    const file = path.join(OUT, `${name}.png`);
    // fullPage would resize the viewport and make UIScaleUtil re-scale the UI; the
    // page is a fixed 1920x1080 view (body overflow hidden), so the viewport IS the page.
    await page.screenshot({ path: file, fullPage: false });
    return file;
}

async function openFrontend(browser, url, label) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const rec = attachCollectors(page, label);
    await page.addInitScript(pageShims, { seed: SEED, css: GAMEFACE_COMPAT_CSS });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('.FrontendModule_root', { timeout: 30000 });
    await page.waitForTimeout(1500);
    return { page, rec };
}

// Same listeners the game (Lua -> engine.trigger) and the game's own debug
// tools (FrontendModule "ShowHUB", DebugHUBViewer "SetHubScreen") use.
async function gotoMarketTab(page, tab) {
    await page.evaluate(() => engine.trigger('World_ShowHUB'));
    await page.waitForSelector('.HUBModule_root', { timeout: 15000 });
    await page.waitForTimeout(800);
    await page.evaluate(t => engine.trigger('SetHubScreen', 2 /* HUBModuleSubMenu.AnimalMarket */, t), tab);
    await page.waitForTimeout(500);
    // AnimalMarketModule listens for this in the Coherent player (tab index).
    await page.evaluate(t => engine.trigger('SetAnimalMarketScreen', t), tab);
    const header = tab === 0 ? '.AnimalMarketMarket_header' : '.AnimalMarketStorage_header';
    await page.waitForSelector(header, { state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.MarketAnimalListItem_root').length > 0, null, { timeout: 15000 });
    await page.waitForTimeout(1200); // badges refresh every 500 ms, bars every 250 ms
}

const domFacts = page => page.evaluate(async () => {
    const DS = await import('/js/common/core/DataStore.js'); // same module instance as the game's
    const vis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const shown = el => { for (let n = el; n && n !== document.body; n = n.parentNode) { if (n.classList && n.classList.contains('hidden')) return false; } const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const allRows = [...document.querySelectorAll('.MarketAnimalListItem_root')];
    const rows = allRows.filter(shown); // rows of the screen on display (hidden tabs stay mounted)
    const inView = rows.filter(r => { const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; });
    const badges = rows.map(r => [...r.children].find(c => c.classList.contains('PZ2QoL_badge'))).filter(Boolean);
    // The list is a recycling Repeater, so DOM rows != list length. Read the
    // length of the collection(s) feeding the visible list from preact props.
    const listLengths = [];
    for (let n = rows[0], d = 0; n && d < 15; n = n.parentNode, d++) {
        for (let c = n._component; c; c = c._component) {
            for (const [k, v] of [...Object.entries(c.props || {}).map(([k, v]) => ['props.' + k, v]), ...Object.entries(c)]) {
                let src;
                try { src = v && typeof v === 'object' && !(v instanceof Node) ? v.source : undefined; } catch { src = undefined; }
                if (Array.isArray(src) && Array.isArray(v._context) && v._context[v._context.length - 1] === 'list' && !listLengths.some(x => x.length === src.length && x.context === (Array.isArray(v._context) ? v._context.join('/') : undefined))) {
                    listLengths.push({ component: c.constructor.name, field: k, length: src.length, context: Array.isArray(v._context) ? v._context.join('/') : undefined });
                }
            }
        }
    }
    const rowCtx = el => { for (let n = el, d = 0; n && d < 5; n = n.parentNode, d++) for (let c = n._component; c; c = c._component) if (Array.isArray(c.props?.context)) return c.props.context; return null; };
    const rowData = rows.slice(0, 8).map(r => { const ctx = rowCtx(r); if (!ctx) return null; const g = k => { try { return DS.getValue(ctx, k); } catch { return undefined; } }; return { id: g('id'), species: g('species'), gender: g('gender'), pregnant: g('isPregnant') }; });
    const bar = sel => { const b = document.querySelector(sel); return b ? { present: true, visible: vis(b), chips: [...b.querySelectorAll('.PZ2QoL_chip')].map(c => c.textContent + (c.classList.contains('on') ? ' [on]' : '')), summary: b.querySelector('.PZ2QoL_summary')?.textContent ?? null } : { present: false }; };
    const banner = document.querySelector('.PZ2QoL_errorBanner');
    return {
        rowsInDomAllTabs: allRows.length,
        rows: rows.length,
        rowsInViewport: inView.length,
        badgesInDomAllTabs: document.querySelectorAll('.PZ2QoL_badge').length,
        firstRowSpecies: rows.slice(0, 6).map(r => (r.textContent.match(/\[Animal_[^\]]+\]/) || [''])[0]),
        listLengths,
        storageRowsInDataStore: (() => { try { return DS.__getChildrenOfContext(['hubAnimalsData', 'animalStorageData', 'list']).length; } catch { return null; } })(),
        marketRowsInDataStore: (() => { try { return DS.__getChildrenOfContext(['hubAnimalsData', 'animalMarketData', 'list']).length; } catch { return null; } })(),
        visibleRowData: rowData,
        badges: badges.length,
        badgeTexts: badges.slice(0, 6).map(b => `${b.textContent} {${b.className.replace('PZ2QoL_badge ', '')}}`),
        marketBar: bar('.PZ2QoL_bar.market'),
        storageBar: bar('.PZ2QoL_bar.storage'),
        errorBanner: banner ? { visible: vis(banner) && !banner.classList.contains('hidden'), text: banner.querySelector('.PZ2QoL_errorCount')?.textContent ?? '' } : null,
        modCssLoaded: [...document.querySelectorAll('link[rel=stylesheet]')].some(l => /pz2qol/i.test(l.href)),
    };
});

async function clickChip(page, barSel, startsWith) {
    const chip = page.locator(`${barSel} .PZ2QoL_chip`).filter({ hasText: new RegExp('^' + startsWith.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
    await chip.click({ timeout: 5000 });
    await page.waitForTimeout(1200);
}

// ------------------------------------------------------- market lister
// Fakes the native side of selecting and listing a storage animal (the
// game's Lua/C++ is absent in the browser) and checks the lister's rules:
// off by default, recommended price used, one at a time, cap per click,
// stop on the first server error.
async function installFakeNative(page) {
    await page.evaluate(async () => {
        const DS = await import('/js/common/core/DataStore.js');
        const LIST = ['hubAnimalsData', 'animalStorageData', 'list'];
        const DATA = ['hubAnimalsData', 'animalStorageData'];
        const ACTIONS = ['hubAnimalsData', 'animalStorageData', 'actions'];
        const TRADE = ['animalTradeListingData'];
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const col = new DataStoreCollection(LIST);
        const keys = () => col._source.map(c => c[c.length - 1]);
        // a new collection fills asynchronously
        for (let i = 0; i < 50 && keys().length == 0; i++) await new Promise(r => setTimeout(r, 100));
        window.__fake = { calls: [], failOnCall: 0, keys, clears: [] };
        // records who clears the storage selection (diagnostics for flaky runs)
        for (const k of keys()) {
            DS.setValue(LIST.concat(k), 'auctionTimerSeconds', 0);
            DS.setValue(LIST.concat(k), 'isMoving', false);
        }
        DS.setValue(ACTIONS, 'tradeAllowed', true);
        DS.setValue(TRADE, 'tradePriceDefault', 800);
        DS.setValue(TRADE, 'tradePriceMin', 10);
        DS.setValue(TRADE, 'tradePriceMax', 10000);
        DS.setValue(TRADE, 'tradeDurationDefault', 6);
        DS.setValue(TRADE, 'tradeDurationMin', 1);
        DS.setValue(TRADE, 'tradeDurationMax', 12);
        engine.on('AnimalStorage_SelectAllToggled', on => {
            if (!on) {
                window.__fake.clears.push('SelectAllToggled(false): ' + new Error('x').stack.split(String.fromCharCode(10)).slice(2, 7).join(' | '));
                DS.setValue(DATA, 'selectedAnimalIDs', []);
            }
        });
        engine.on('AnimalStorage_ItemSelected', id => {
            const key = keys().find(k => DS.getValue(LIST.concat(k), 'id') == id);
            DS.setValue(DATA, 'selectedAnimalIDs', key ? [key] : []);
            // The browser debug panel randomises some fields on selection; undo that
            // so the animal looks like a normal, tradeable storage animal.
            const settle = () => {
                if (!key) return;
                DS.setValue(LIST.concat(key), 'isMoving', false);
                const pin = (window.__fake.pinned || {})[key];
                if (pin) for (const [prop, v] of Object.entries(pin)) DS.setValue(LIST.concat(key), prop, v);
                if (!(window.__fake.listed || []).includes(key)) DS.setValue(LIST.concat(key), 'auctionTimerSeconds', 0);
                DS.setValue(ACTIONS, 'tradeAllowed', true);
            };
            settle();
            setTimeout(settle, 50);
            setTimeout(settle, 300);
        });
        // like the mod's Lua: the game's "a franchise request is running"
        // flag, true from a listing request until its answer
        window.__fake.dbQueries = 0;
        engine.on('PZ2QoL_DbQuery', () => {
            window.__fake.dbQueries++;
            const busy = Date.now() < (window.__fake.busyUntil || 0);
            setTimeout(() => engine.trigger('PZ2QoL_DbState', true, busy, busy ? 42 : -1), 20);
        });
        engine.on('AnimalStorage_AddToMarket', (key, price, hours) => {
            window.__fake.calls.push({ key, id: DS.getValue(LIST.concat(key), 'id'), price, hours, selected: DS.getValue(DATA, 'selectedAnimalIDs'), t: Date.now(), busy: Date.now() < (window.__fake.busyUntil || 0) });
            window.__fake.busyUntil = Date.now() + 450;
            if (window.__fake.calls.length == window.__fake.noiseOnCall) {
                // background traffic failing (request type 28 in game) while
                // this listing is pending: not about the listing
                setTimeout(() => engine.trigger('PZ2QoL_Error', 'server', 'Server error: code 5', '(request #28)'), 150);
            }
            if (window.__fake.calls.length == window.__fake.timeoutOnCall) {
                // the game's request times out (a silent copy, as the hub
                // page gets it), but the listing still goes through later
                setTimeout(() => engine.trigger('PZ2QoL_Error', 'server', 'Server error: DidNotGetResponse', 'fake timeout', true), 300);
                setTimeout(() => {
                    (window.__fake.listed = window.__fake.listed || []).push(key);
                    DS.setValue(LIST.concat(key), 'auctionTimerSeconds', hours * 3600);
                    DS.setValue(LIST.concat(key), 'auctionPrice', price);
                }, 2500);
                return;
            }
            if (window.__fake.calls.length == window.__fake.failOnCall) {
                // as the game reports it: an unnamed code for request type 42;
                // the game stays busy a while (the lister must wait for it)
                window.__fake.busyUntil = Date.now() + 9000;
                setTimeout(() => engine.trigger('PZ2QoL_Error', 'server', window.__fake.failMessage || 'Server error: code 255', '(request #42)'), 400);
                return;
            }
            setTimeout(() => {
                (window.__fake.listed = window.__fake.listed || []).push(key);
                DS.setValue(LIST.concat(key), 'auctionTimerSeconds', hours * 3600);
                DS.setValue(LIST.concat(key), 'auctionPrice', price);
                DS.setValue(DATA, 'selectedAnimalIDs', []);
            }, 600);
        });
    });
}

async function runListerScenario(page) {
    const facts = {};
    facts.panelVisibleByDefault = await page.locator('.PZ2QoL_lister').isVisible().catch(() => false);
    facts.listerOnByDefault = await page.locator('.PZ2QoL_bar.storage .PZ2QoL_switch.on').count() > 0;
    await page.evaluate(() => { window.__PZ2QOL_TEST_FRANCHISE = true; });
    await installFakeNative(page);
    // Seed the price book with market listings for the first two species in storage.
    const target = await page.evaluate(async () => {
        const DS = await import('/js/common/core/DataStore.js');
        const LIST = ['hubAnimalsData', 'animalStorageData', 'list'];
        const keys = window.__fake.keys();
        const withGenes = keys.filter(k => typeof DS.getValue(LIST.concat(k, 'genetics', 'fertility'), 'value') === 'number'
            && !DS.getValue(LIST.concat(k), 'isShoal'));
        if (!withGenes.length) throw new Error('no storage animal with genes in the dummy data');
        const k = withGenes[0];
        // a Silver adult (the medal is the row's `ratings`, as in the game's
        // Rating column); the fake debug panel must not randomise it away
        const pin = { ratings: 'silver', maturity: 2 };
        window.__fake.pinned = { [k]: pin };
        for (const [prop, v] of Object.entries(pin)) DS.setValue(LIST.concat(k), prop, v);
        const a = { id: DS.getValue(LIST.concat(k), 'id'), key: k, species: DS.getValue(LIST.concat(k), 'species'), gender: DS.getValue(LIST.concat(k), 'gender') };
        const { mergeIntoPriceBook } = await import('/js/mods/pz2qol/pricebook.js');
        const fake = [];
        [40, 50, 55, 60, 65, 70, 80].forEach((s, i) => fake.push({ id: 'fake' + i, species: a.species, gender: a.gender, maturity: 2, isShoal: false, score: s, medal: 'silver', price: 400 + 10 * s, isCC: true, source: 'market' }));
        // gold listings of the same sex cost more and must not be compared
        [82, 88].forEach((s, i) => fake.push({ id: 'fakeG' + i, species: a.species, gender: a.gender, maturity: 2, isShoal: false, score: s, medal: 'gold', price: 3000 + 100 * i, isCC: true, source: 'market' }));
        fake.push({ id: 'fakeF', species: a.species, gender: a.gender == 0 ? 1 : 0, maturity: 2, isShoal: false, score: 60, medal: 'silver', price: 1500, isCC: true, source: 'market' });
        mergeIntoPriceBook(fake);
        return { ...a, withGenes };
    });
    facts.target = { key: target.key, species: target.species };
    await page.locator('.PZ2QoL_bar.storage .PZ2QoL_switch').click();
    await page.waitForTimeout(800);
    facts.listerOnAfterClick = await page.locator('.PZ2QoL_bar.storage .PZ2QoL_switch.on').count() > 0;
    await page.evaluate(id => engine.trigger('AnimalStorage_ItemSelected', id), target.id);
    try {
        await page.waitForSelector('.PZ2QoL_listerRecPrice', { timeout: 5000 });
    }
    catch (e) {
        // the browser debug panel sometimes resets the selection right after; select again
        await page.evaluate(id => engine.trigger('AnimalStorage_ItemSelected', id), target.id);
        try {
            await page.waitForSelector('.PZ2QoL_listerRecPrice', { timeout: 10000 });
        }
        catch (e2) {
            const diag = await page.evaluate(async () => {
                const DS = await import('/js/common/core/DataStore.js');
                const p = document.querySelector('.PZ2QoL_lister');
                return {
                    panelExists: !!p, display: p && p.style.display, text: p && p.innerText,
                    selected: DS.getValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs'),
                    clears: window.__fake.clears,
                    storageHeader: !!document.querySelector('.AnimalMarketStorage_header'),
                    bodyClass: document.body.className,
                };
            });
            throw new Error('panel did not show a recommendation: target=' + JSON.stringify({ id: target.id, key: target.key }) + ' ' + JSON.stringify(diag).slice(0, 1200));
        }
    }
    await page.waitForTimeout(600);
    facts.panelText = (await page.locator('.PZ2QoL_lister').innerText()).replace(/\s+/g, ' ').slice(0, 900);
    facts.medal = await page.evaluate(() => ({
        pill: document.querySelector('.PZ2QoL_lister .PZ2QoL_medalPill')?.className || null,
        why: document.querySelector('.PZ2QoL_lister .PZ2QoL_recWhy')?.textContent || '',
        chips: Array.from(document.querySelectorAll('.PZ2QoL_lister .PZ2QoL_medalChip')).map(e => e.textContent),
    }));
    const recText = await page.locator('.PZ2QoL_listerRecPrice').textContent();
    facts.recommended = Number((recText.replace(/,/g, '').match(/(\d+)/) || [])[1]);
    await shot(page, '8_lister_single');

    // Background market check: a fake of the mod's Lua (PZ2QoL.MarketPeek)
    // fills the market list for the species while the screen stays on
    // Animal Storage; the page must record the prices and release.
    await page.evaluate(async species => {
        const DS = await import('/js/common/core/DataStore.js');
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const MARKET = ['hubAnimalsData', 'animalMarketData', 'list'];
        const col = new DataStoreCollection(MARKET);
        for (let i = 0; i < 50 && col._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        window.__peek = { starts: [], startTimes: [], pages: [], releases: 0, marketRows: col._source.length };
        const speciesCol = new DataStoreCollection(['hubAnimalsData', 'species']);
        let current = species;
        const speciesForUid = uid => {
            for (const ctx of speciesCol._source) {
                if (DS.getValue(ctx, 'speciesUID') == uid) return DS.getValue(ctx, 'speciesName');
            }
            return species;
        };
        // three pages that reuse the same row slots (as the game does)
        const DATA = ['hubAnimalsData', 'animalMarketData'];
        const showPage = n => {
            col._source.slice(0, 3).forEach((ctx, i) => {
                DS.setValue(ctx, 'species', current);
                DS.setValue(ctx, 'auctionIsConservationCredits', true);
                DS.setValue(ctx, 'auctionPrice', 2000 + 111 * i + 1000 * n);
                DS.setValue(ctx, 'ratings', ['gold', 'silver', 'bronze'][i]);
            });
            DS.setValue(DATA, 'pages', 3);
            DS.setValue(DATA, 'pageIndex', n);
        };
        // like the Lua side: one check at a time ('busy' until released),
        // and its answers arrive a little later (the next frame or two),
        // so a late 'done' must not be taken for the next check's answer
        let active = false;
        engine.on('PZ2QoL_MarketPeek', uid => {
            if (active) {
                window.__peek.busy = (window.__peek.busy || 0) + 1;
                setTimeout(() => engine.trigger('PZ2QoL_MarketPeekState', 'busy', 'A market check is already running.'), 30);
                return;
            }
            active = true;
            window.__peek.starts.push(uid);
            window.__peek.startTimes.push(Date.now());
            current = speciesForUid(uid);
            engine.trigger('PZ2QoL_MarketPeekState', 'loading', '');
            setTimeout(() => {
                showPage(0);
                engine.trigger('PZ2QoL_MarketPeekState', 'ready', '');
            }, window.__peekLoadMs || 400);
        });
        engine.on('PZ2QoL_MarketPeekPage', n => {
            window.__peek.pages.push(n);
            engine.trigger('PZ2QoL_MarketPeekState', 'loading', String(n));
            setTimeout(() => {
                showPage(n);
                engine.trigger('PZ2QoL_MarketPeekState', 'ready', '');
            }, 300);
        });
        engine.on('PZ2QoL_MarketPeekRelease', () => {
            window.__peek.releases++;
            if (!active) return;
            active = false;
            setTimeout(() => engine.trigger('PZ2QoL_MarketPeekState', 'done', 'ok'), 150);
        });
    }, target.species);
    const knownBefore = await page.evaluate(async s => (await import('/js/mods/pz2qol/pricebook.js')).countForSpecies(s), target.species);
    await page.locator('.PZ2QoL_lister .PZ2QoL_btn', { hasText: /Check market prices|Refresh prices/ }).click();
    try {
        await page.waitForSelector('.PZ2QoL_peekStatus.done', { timeout: 15000 });
    }
    catch (e) {
        const st = await page.evaluate(() => ({ peek: window.__peek, status: document.querySelector('.PZ2QoL_peekStatus')?.textContent }));
        throw new Error('background market check did not finish: ' + JSON.stringify(st));
    }
    facts.peek = await page.evaluate(async s => ({
        ...window.__peek,
        known: (await import('/js/mods/pz2qol/pricebook.js')).countForSpecies(s),
        status: document.querySelector('.PZ2QoL_peekStatus')?.textContent,
        storageVisible: !!document.querySelector('.AnimalMarketStorage_header')?.getBoundingClientRect().height,
        marketVisible: !!document.querySelector('.AnimalMarketMarket_header')?.getBoundingClientRect().height,
    }), target.species);
    facts.peek.knownBefore = knownBefore;
    await shot(page, '8b_lister_market_checked');

    // Global price offset: -10% applies to the shown price and the listing
    const recPrice = async () => Number(((await page.locator('.PZ2QoL_listerRecPrice').textContent()).replace(/,/g, '').match(/(\d+)/) || [])[1]);
    // the new listings changed the recommendation
    const recBefore = await recPrice();
    const minus = page.locator('.PZ2QoL_lister .PZ2QoL_offset .PZ2QoL_segItem').first();
    await minus.click();
    await minus.click();
    await page.waitForTimeout(600);
    facts.offsetLabel = (await page.locator('.PZ2QoL_lister .PZ2QoL_offsetValue').textContent()).trim();
    facts.recommended = await recPrice();
    facts.offsetBase = Number(((await page.locator('.PZ2QoL_recBase').textContent().catch(() => '')).replace(/,/g, '').match(/(\d+)/) || [])[1]);
    facts.recBeforeOffset = recBefore;
    await shot(page, '8c_lister_offset');

    // Single sell
    await page.locator('.PZ2QoL_lister .PZ2QoL_btn', { hasText: /^Sell at recommended price$/ }).click();
    try {
        await page.waitForFunction(() => /Done: listed 1 of 1/.test(document.querySelector('.PZ2QoL_listerStatus')?.textContent || ''), null, { timeout: 15000 });
    }
    catch (e) {
        const diag = await page.evaluate(async () => {
            const { getErrorLog } = await import('/js/mods/pz2qol/errors.js');
            const DS = await import('/js/common/core/DataStore.js');
            return {
                status: document.querySelector('.PZ2QoL_listerStatus')?.textContent,
                panel: document.querySelector('.PZ2QoL_lister')?.innerText,
                calls: window.__fake.calls,
                selected: DS.getValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs'),
                tradeAllowed: DS.getValue(['hubAnimalsData', 'animalStorageData', 'actions'], 'tradeAllowed'),
                log: getErrorLog().map(x => `${x.source}: ${x.title} ${x.detail}`),
            };
        });
        throw new Error('single sell did not finish: ' + JSON.stringify(diag).slice(0, 1500));
    }
    facts.singleCalls = await page.evaluate(() => window.__fake.calls.slice());
    await shot(page, '9_lister_single_done');
    // back to no offset for the runs below
    await page.locator('.PZ2QoL_lister .PZ2QoL_offsetValue').click();
    await page.waitForTimeout(300);
    facts.offsetAfterReset = (await page.locator('.PZ2QoL_lister .PZ2QoL_offsetValue').textContent()).trim();

    // Batch: 7 selected, cap 5, the 3rd listing is rejected by the "server"
    const batchKeys = target.withGenes.filter(k => k != target.key).slice(0, 7);
    await page.evaluate(async keys => {
        const DS = await import('/js/common/core/DataStore.js');
        window.__fake.calls = [];
        window.__fake.failOnCall = 3;
        window.__fake.failMessage = 'Server error: NotAllowed'; // named: skip it, carry on
        window.__fake.noiseOnCall = 5;
        window.__fake.dbQueries = 0;
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', keys);
    }, batchKeys);
    await page.waitForTimeout(800);
    await page.evaluate(async keys => {
        const DS = await import('/js/common/core/DataStore.js');
        for (const k of keys) {
            DS.setValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'isMoving', false);
            DS.setValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'auctionTimerSeconds', 0);
        }
    }, batchKeys);
    facts.batchButton = (await page.locator('.PZ2QoL_lister .PZ2QoL_btn.positive').textContent()).trim();
    facts.batchSelected = batchKeys.length;
    await page.locator('.PZ2QoL_lister .PZ2QoL_btn.positive').click();
    await page.waitForFunction(() => /Stopped|Done:/.test(document.querySelector('.PZ2QoL_listerStatus')?.textContent || ''), null, { timeout: 60000 });
    facts.batchStatus = (await page.locator('.PZ2QoL_listerStatus').first().textContent()).trim();
    facts.batchCalls = await page.evaluate(() => window.__fake.calls.map(c => ({ key: c.key, price: c.price, hours: c.hours, selected: c.selected, t: c.t, busy: c.busy })));
    facts.batchDbQueries = await page.evaluate(() => { window.__fake.noiseOnCall = 0; return window.__fake.dbQueries; });
    const shortListings = facts.batchCalls.filter(c => c.hours !== 12);
    if (shortListings.length) throw new Error('lister must list for the maximum 12h, got: ' + shortListings.map(c => c.hours).join(', '));
    facts.batchGapsMs = facts.batchCalls.slice(1).map((c, i) => c.t - facts.batchCalls[i].t);
    facts.bannerAfterBatch = (await domFacts(page)).errorBanner;
    await shot(page, '10_lister_batch_stopped');

    // A fatal server error (not enough CC) must stop the run, not skip; so
    // must an unnamed code (255 / 5 in game): listing on after one crashed
    // the game twice (2026-10-15).
    const fatalKeys = batchKeys.slice(0, 3);
    facts.fatal = [];
    for (const message of ['Server error: NotEnoughCC', 'Server error: code 255']) {
        await page.evaluate(async ({ keys, message }) => {
            const DS = await import('/js/common/core/DataStore.js');
            window.__fake.calls = [];
            window.__fake.listed = [];
            window.__fake.failOnCall = 1;
            window.__fake.failMessage = message;
            for (const k of keys) {
                DS.setValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'auctionTimerSeconds', 0);
                DS.setValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'isMoving', false);
            }
            DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', keys);
        }, { keys: fatalKeys, message });
        await page.waitForTimeout(800);
        await page.locator('.PZ2QoL_lister .PZ2QoL_btn.positive').click();
        await page.waitForFunction(() => /Stopped|Done:/.test(document.querySelector('.PZ2QoL_listerStatus')?.textContent || ''), null, { timeout: 40000 });
        facts.fatal.push({
            message,
            status: (await page.locator('.PZ2QoL_listerStatus').first().textContent()).trim(),
            calls: await page.evaluate(() => window.__fake.calls.length),
        });
    }
    await page.evaluate(() => { window.__fake.failMessage = ''; window.__fake.busyUntil = 0; });
    await shot(page, '11_lister_fatal_stop');

    // A large selection (every stored animal) stays compact
    await page.evaluate(async () => {
        const DS = await import('/js/common/core/DataStore.js');
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', window.__fake.keys());
    });
    await page.waitForTimeout(1000);
    facts.bigSelection = await page.evaluate(() => window.__fake.keys().length);
    facts.bigPanelHeight = await page.evaluate(() => Math.round(document.querySelector('.PZ2QoL_lister').getBoundingClientRect().height));
    facts.bigGroups = await page.locator('.PZ2QoL_lister .PZ2QoL_groupChip').count();
    await shot(page, '11b_lister_big_selection');

    // Several species selected: one click checks them one after another,
    // every page of each, with the cooldown between species
    const multi = await page.evaluate(async () => {
        const DS = await import('/js/common/core/DataStore.js');
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const { translate } = await import('/js/common/core/Localisation.js');
        const spCol = new DataStoreCollection(['hubAnimalsData', 'species']);
        for (let i = 0; i < 50 && spCol._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        const tr = x => { try { return translate(x); } catch (e) { return x; } };
        const known = new Set(spCol._source.map(ctx => tr(DS.getValue(ctx, 'speciesName'))));
        const bySpecies = new Map();
        for (const k of window.__fake.keys()) {
            const sp = DS.getValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'species');
            if (known.has(tr(sp)) && !bySpecies.has(sp)) bySpecies.set(sp, k);
        }
        const keys = Array.from(bySpecies.values()).slice(0, 3);
        window.__peek.starts = [];
        window.__peek.startTimes = [];
        window.__peek.pages = [];
        window.__peek.releases = 0;
        // a slow first page (as in game) so each species takes longer than
        // the gap between species and the next check starts at once
        window.__peekLoadMs = 3000;
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', keys);
        return { keys, species: Array.from(bySpecies.keys()).slice(0, 3) };
    });
    if (multi.species.length < 2) throw new Error('fake storage has fewer than 2 species the species list knows: ' + JSON.stringify(multi));
    await page.waitForTimeout(800);
    facts.multiSpecies = multi.species;
    facts.multiButton = (await page.locator('.PZ2QoL_lister .PZ2QoL_btn', { hasText: /species\)/ }).textContent()).trim();
    await page.locator('.PZ2QoL_lister .PZ2QoL_btn', { hasText: /species\)/ }).click();
    await page.waitForTimeout(500);
    facts.multiSellDisabled = await page.evaluate(() => document.querySelector('.PZ2QoL_lister .PZ2QoL_btn.positive')?.classList.contains('disabled'));
    facts.multiStopShown = await page.locator('.PZ2QoL_lister .PZ2QoL_btn', { hasText: 'Stop checking' }).count();
    await shot(page, '11c_lister_multi_check_running');
    try {
        await page.waitForFunction(() => /^(Done|Stopped):/.test(document.querySelector('.PZ2QoL_peekStatus')?.textContent || ''), null, { timeout: 60000 });
    }
    catch (e) {
        throw new Error('multi-species market check did not finish: ' + await page.evaluate(() => document.querySelector('.PZ2QoL_peekStatus')?.textContent));
    }
    facts.multiPeek = await page.evaluate(() => ({
        starts: window.__peek.starts.length,
        busy: window.__peek.busy || 0,
        gaps: window.__peek.startTimes.slice(1).map((t, i) => t - window.__peek.startTimes[i]),
        pages: window.__peek.pages.join(','),
        releases: window.__peek.releases,
        status: document.querySelector('.PZ2QoL_peekStatus')?.textContent,
    }));
    await shot(page, '11d_lister_multi_check_done');

    // A long run keeps going past the 6th animal (reported stall in game)
    const longKeys = await page.evaluate(async () => {
        const DS = await import('/js/common/core/DataStore.js');
        const keys = window.__fake.keys().slice(0, 9);
        window.__fake.calls = [];
        window.__fake.listed = [];
        window.__fake.failOnCall = 0;
        window.__fake.timeoutOnCall = 7; // a server timeout must not end the run
        for (const k of keys) {
            DS.setValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'auctionTimerSeconds', 0);
            DS.setValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'isMoving', false);
        }
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', keys);
        return keys;
    });
    await page.waitForTimeout(800);
    await page.locator('.PZ2QoL_lister .PZ2QoL_btn.positive').click();
    await page.waitForFunction(() => /Stopped|Done:/.test(document.querySelector('.PZ2QoL_listerStatus')?.textContent || ''), null, { timeout: 120000 });
    facts.longStatus = (await page.locator('.PZ2QoL_listerStatus').first().textContent()).trim();
    facts.longCalls = await page.evaluate(() => window.__fake.calls.length);
    await page.evaluate(() => { window.__fake.timeoutOnCall = 0; });
    if (!/^Done/.test(facts.longStatus) || facts.longCalls < longKeys.length || /skipped/.test(facts.longStatus)) {
        throw new Error(`long run (${longKeys.length} animals, server timeout on the 7th) did not list them all: ${facts.longCalls} sent, status "${facts.longStatus}"`);
    }

    // Selected animals already on the market are left out up front (not
    // counted as skips): 2 unlisted + 2 listed selected -> "Sell 2".
    const mixKeys = longKeys.slice(0, 4);
    await page.evaluate(async keys => {
        const DS = await import('/js/common/core/DataStore.js');
        window.__fake.calls = [];
        for (const k of keys.slice(0, 2)) {
            DS.setValue(['hubAnimalsData', 'animalStorageData', 'list', k], 'auctionTimerSeconds', 0);
            window.__fake.listed = (window.__fake.listed || []).filter(x => x != k);
        }
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', keys);
    }, mixKeys);
    await page.waitForTimeout(800);
    facts.mixButton = (await page.locator('.PZ2QoL_lister .PZ2QoL_btn.positive').textContent()).trim();
    await page.locator('.PZ2QoL_lister .PZ2QoL_btn.positive').click();
    await page.waitForFunction(() => /Stopped|Done:/.test(document.querySelector('.PZ2QoL_listerStatus')?.textContent || ''), null, { timeout: 60000 });
    facts.mixStatus = (await page.locator('.PZ2QoL_listerStatus').first().textContent()).trim();
    facts.mixCalls = await page.evaluate(() => window.__fake.calls.map(c => c.key));
    if (!/Sell 2 at/.test(facts.mixButton) || facts.mixCalls.length != 2 || !/^Done: listed 2 of 2; 2 already on the market left out/.test(facts.mixStatus)) {
        throw new Error(`already-listed animals not left out: button "${facts.mixButton}", ${facts.mixCalls.length} sent, status "${facts.mixStatus}"`);
    }

    // "Not listed" hides the animals now on the market (the 9 just listed)
    const storageCount = () => page.evaluate(async () => {
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const c = new DataStoreCollection(['hubAnimalsData', 'animalStorageData', 'list']);
        await new Promise(r => setTimeout(r, 200));
        const DS = await import('/js/common/core/DataStore.js');
        const all = c._source.length, shown = c.source.length;
        const listed = c._source.filter(x => (DS.getValue(x, 'auctionTimerSeconds') ?? -1) > 0).length;
        c.dispose();
        return { all, shown, listed };
    });
    const beforeHide = await storageCount();
    await page.locator('.PZ2QoL_bar.storage .PZ2QoL_chip', { hasText: /^Not listed/ }).click();
    await page.waitForTimeout(800);
    const afterHide = await storageCount();
    facts.notListed = { beforeHide, afterHide, chip: (await page.locator('.PZ2QoL_bar.storage .PZ2QoL_chip', { hasText: /^Not listed/ }).textContent()).trim() };
    await shot(page, '11c_storage_not_listed');
    facts.storageBarHeight = await page.evaluate(() => Math.round(document.querySelector('.PZ2QoL_bar.storage').getBoundingClientRect().height));
    await page.locator('.PZ2QoL_bar.storage .PZ2QoL_chip', { hasText: /^Not listed/ }).click();
    await page.waitForTimeout(500);
    if (!(beforeHide.listed >= longKeys.length) || afterHide.shown != beforeHide.shown - beforeHide.listed) {
        throw new Error(`"Not listed" should hide exactly the ${beforeHide.listed} listed animals: ${JSON.stringify(facts.notListed)}`);
    }
    if (facts.storageBarHeight > 90) throw new Error(`storage toolbar too tall: ${facts.storageBarHeight}px`);

    // The game rebuilds the storage list when something sells, so list keys
    // can point at other animals mid-run. Swap a selected animal's row with
    // an unselected one after the first listing: the run must list exactly
    // the selected animals, never the outsider.
    const shuffle = await page.evaluate(async () => {
        const DS = await import('/js/common/core/DataStore.js');
        const LIST = ['hubAnimalsData', 'animalStorageData', 'list'];
        const free = window.__fake.keys().filter(k => !(DS.getValue(LIST.concat(k), 'auctionTimerSeconds') > 0));
        const sel = free.slice(0, 4), outsider = free[4];
        if (!outsider) return { skipped: 'not enough unlisted animals' };
        const idOf = k => DS.getValue(LIST.concat(k), 'id');
        const swap = (a, b) => {
            const props = [[[], 'id'], [[], 'name'], [[], 'species'], [[], 'gender'], [[], 'maturity'],
                ...['size', 'longevity', 'fertility', 'immunity'].map(g => [['genetics', g], 'value'])];
            for (const [path, prop] of props) {
                const ca = LIST.concat(a, path), cb = LIST.concat(b, path);
                const va = DS.getValue(ca, prop), vb = DS.getValue(cb, prop);
                DS.setValue(ca, prop, vb);
                DS.setValue(cb, prop, va);
            }
        };
        const want = sel.map(idOf), outsiderId = idOf(outsider);
        window.__fake.calls = [];
        window.__fake.listed = [];
        window.__fake.failOnCall = 0;
        window.__fake.timeoutOnCall = 0;
        let done = false;
        engine.on('AnimalStorage_AddToMarket', () => {
            if (done) return;
            done = true;
            setTimeout(() => swap(sel[1], outsider), 100);
        });
        DS.setValue(['hubAnimalsData', 'animalStorageData'], 'selectedAnimalIDs', sel);
        return { want, outsiderId };
    });
    if (!shuffle.skipped) {
        await page.waitForTimeout(800);
        await page.locator('.PZ2QoL_lister .PZ2QoL_btn.positive').click();
        await page.waitForFunction(() => /Stopped|Done:/.test(document.querySelector('.PZ2QoL_listerStatus')?.textContent || ''), null, { timeout: 60000 });
        const got = await page.evaluate(() => window.__fake.calls.map(c => c.id));
        const status = (await page.locator('.PZ2QoL_listerStatus').first().textContent()).trim();
        facts.shuffle = { ...shuffle, got, status };
        if (got.includes(shuffle.outsiderId)) throw new Error(`list rebuilt mid-run: the lister listed an animal that was not selected: ${JSON.stringify(facts.shuffle)}`);
        if (got.slice().sort().join() != shuffle.want.slice().sort().join()) throw new Error(`list rebuilt mid-run: listed ${got}, expected ${shuffle.want}: ${status}`);
    }

    // Turning it off hides the panel again
    await page.locator('.PZ2QoL_bar.storage .PZ2QoL_switch').click();
    await page.waitForTimeout(800);
    facts.panelVisibleAfterOff = await page.locator('.PZ2QoL_lister').isVisible().catch(() => false);

    // Assertions
    const problems = [];
    if (facts.panelVisibleByDefault) problems.push('panel visible while lister is off by default');
    if (facts.listerOnByDefault) problems.push('lister switch on by default');
    if (!facts.listerOnAfterClick) problems.push('lister switch did not turn on');
    if (facts.singleCalls.length != 1) problems.push(`single sell made ${facts.singleCalls.length} calls`);
    else {
        const c = facts.singleCalls[0];
        if (c.key != target.key) problems.push(`single sell listed ${c.key}, expected ${target.key}`);
        if (c.price != facts.recommended) problems.push(`single sell price ${c.price} != shown recommendation ${facts.recommended}`);
        if (c.hours != 12) problems.push(`duration ${c.hours} != game maximum 12`);
        if (!(Array.isArray(c.selected) && c.selected.length == 1 && c.selected[0] == target.key)) problems.push('animal was not the sole selection when listed');
    }
    if (!/silver/.test(facts.medal.pill || '')) problems.push(`no Silver medal on the selected animal: ${facts.medal.pill}`);
    if (!/^\d+ Silver adult (males|females|animals): median [\d,]+ CC/.test(facts.medal.why)) problems.push(`recommendation does not use the Silver listings: ${facts.medal.why}`);
    if (!(facts.medal.chips.some(c => /Gold ×2/.test(c)) && facts.medal.chips.some(c => /Silver ×\d/.test(c)))) problems.push(`no per-medal summary: ${facts.medal.chips}`);
    const p = facts.peek;
    if (p.starts.length != 1) problems.push(`market check sent ${p.starts.length} requests`);
    if (p.pages.join(',') != '1,2') problems.push(`market check paged ${p.pages.join(',')}, expected 1,2`);
    if (p.releases != 1) problems.push(`market check released ${p.releases} times`);
    if (!p.storageVisible || p.marketVisible) problems.push('market check changed the screen');
    if (!(p.known >= p.knownBefore + 9)) problems.push(`market check recorded ${p.known - p.knownBefore} new prices, expected 9 (3 pages of 3)`);
    if (!/^Checked: 9 .* on 3 market pages/.test(p.status || '')) problems.push(`market check status: ${p.status}`);
    const mp = facts.multiPeek, ns = facts.multiSpecies.length;
    if (ns < 2) problems.push(`multi-species check needs 2+ species in the fake storage, found ${ns}`);
    if (!new RegExp(`Refresh prices \\(${ns} species\\)`).test(facts.multiButton)) problems.push(`multi check button: ${facts.multiButton}`);
    if (!facts.multiSellDisabled) problems.push('sell button not disabled during the market check');
    if (facts.multiStopShown != 1) problems.push('no Stop button during the multi-species check');
    if (mp.starts != ns) problems.push(`multi check started ${mp.starts} species checks, expected ${ns}`);
    if (mp.busy) problems.push(`multi check hit 'busy' ${mp.busy} times (a late answer was taken for the next check)`);
    if (mp.releases != ns) problems.push(`multi check released ${mp.releases} times, expected ${ns}`);
    if (mp.pages != Array(ns).fill('1,2').join(',')) problems.push(`multi check pages ${mp.pages}`);
    if (mp.gaps.some(g => g < 3000)) problems.push(`species checks closer than the 3 s cooldown: ${mp.gaps}`);
    const found = Number(((mp.status || '').match(/^Done: checked \d+ of \d+ species, (\d+) listings/) || [])[1]);
    if (!new RegExp(`^Done: checked ${ns} of ${ns} species`).test(mp.status || '') || !(found >= ns * 9)) problems.push(`multi check status: ${mp.status}`);
    if (facts.offsetLabel != '−10%') problems.push(`offset label ${facts.offsetLabel} after two clicks on minus`);
    if (facts.offsetBase != facts.recBeforeOffset) problems.push(`price before offset ${facts.offsetBase} != earlier recommendation ${facts.recBeforeOffset}`);
    if (!(Math.abs(facts.recommended - facts.recBeforeOffset * 0.9) <= Math.max(50, facts.recBeforeOffset * 0.02))) problems.push(`offset price ${facts.recommended} is not about 90% of ${facts.recBeforeOffset}`);
    if (facts.offsetAfterReset != '±0%') problems.push(`offset did not reset: ${facts.offsetAfterReset}`);
    if (facts.batchCalls.length != 7) problems.push(`batch made ${facts.batchCalls.length} calls, expected 7 (the rejected 3rd is skipped, the rest continue)`);
    if (!/Done: listed 6, skipped 1 \(1 refused by the server\) of 7/.test(facts.batchStatus)) problems.push(`batch status: ${facts.batchStatus}`);
    // pacing after every request, and a longer pause after the rejected 3rd
    // (in game, requests sent right after a rejection failed and crashed)
    if (facts.batchGapsMs.some(g => g < 3000)) problems.push(`listings closer than 3s: ${facts.batchGapsMs}`);
    if (!(facts.batchGapsMs[2] >= 8000)) problems.push(`no back-off after the rejected listing: ${facts.batchGapsMs}`);
    if (facts.batchCalls.some(c => c.busy)) problems.push('a listing was sent while the previous request was still running');
    if (!(facts.batchDbQueries >= facts.batchCalls.length)) problems.push(`the lister asked whether the server was idle ${facts.batchDbQueries} times for ${facts.batchCalls.length} listings`);
    if (facts.batchCalls.some((c, i) => c.key != batchKeys[i])) problems.push('batch listed animals out of order');
    if (!facts.bannerAfterBatch.visible) problems.push('no error banner after the failed listing');
    for (const f of facts.fatal) {
        if (f.calls != 1 || !/^Stopped/.test(f.status)) problems.push(`"${f.message}" did not stop the run: ${f.calls} calls, ${f.status}`);
    }
    if (facts.panelVisibleAfterOff) problems.push('panel still visible after turning the lister off');
    // worst case: a finished run block with a 3-line status plus Sell and Refresh
    if (facts.bigPanelHeight > 380) problems.push(`lister panel too tall for ${facts.bigSelection} selected: ${facts.bigPanelHeight}px`);
    if (!(facts.bigGroups > 0)) problems.push('no per-species summary for a big selection');
    facts.problems = problems;
    if (problems.length) throw new Error('lister scenario: ' + problems.join('; '));
    return facts;
}

// ------------------------------------------------------- zoo management
async function openHud(browser, url, label) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const rec = attachCollectors(page, label);
    await page.addInitScript(pageShims, { seed: SEED, css: GAMEFACE_COMPAT_CSS });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(4000);
    return { page, rec };
}

const zooListLength = page => page.evaluate(async () => {
    const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
    const c = new DataStoreCollection(['management', 'animals', 'animals', 'list']);
    await new Promise(r => setTimeout(r, 200));
    const n = c.source.length;
    c.dispose();
    return n;
});

async function runZooScenario(page) {
    const facts = {};
    await page.evaluate(() => { engine.trigger('World_ShowHUD'); });
    await page.waitForTimeout(800);
    await page.evaluate(() => engine.trigger('Management_SetManagementIndex', 7 /* ManagementSectionID.Animals */));
    await page.waitForSelector('.ManagementAnimals_root', { state: 'visible', timeout: 15000 });
    await page.waitForSelector('.PZ2QoL_bar.zoo', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(1200);
    // Give the dummy rows real-looking locations and genes.
    await page.evaluate(async () => {
        const DS = await import('/js/common/core/DataStore.js');
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const col = new DataStoreCollection(['management', 'animals', 'animals', 'list']);
        for (let i = 0; i < 50 && col._source.length == 0; i++) await new Promise(r => setTimeout(r, 100));
        const habitats = ['Savannah Habitat', 'Jungle Habitat', 'Arctic Habitat'];
        col._source.forEach((ctx, i) => {
            DS.setValue(ctx, 'location', '[STRING_LITERAL:Value=|' + habitats[i % 3] + '|]');
            const genes = [['Size', 0.3 + (i % 5) * 0.15], ['Longevity', 0.5], ['Fertility', 0.2 + (i % 4) * 0.2], ['Immunity', 0.6]];
            for (const [g, v] of genes) DS.setValue(ctx.concat(['geneticsTooltip', 'list', g]), 'value', v);
        });
        window.__zooRows = col._source.length;
        window.__zooSelect = [];
        engine.on('Management_SelectAllCheckboxToggled', (id, on) => window.__zooSelect.push(['all', id, on]));
        engine.on('Management_ItemCheckboxToggled', (id, on) => window.__zooSelect.push(['item', id, on]));
    });
    facts.rows = await page.evaluate(() => window.__zooRows);
    facts.listBefore = await zooListLength(page);
    await shot(page, '12_zoo_animals');

    await page.locator('.PZ2QoL_bar.zoo .PZ2QoL_chip.picker').click();
    await page.waitForTimeout(300);
    facts.habitatMenu = await page.locator('.PZ2QoL_menu.open .PZ2QoL_menuItem').allInnerTexts();
    await shot(page, '13_zoo_habitat_menu');
    await page.locator('.PZ2QoL_menu.open .PZ2QoL_menuItem', { hasText: 'Jungle Habitat' }).click();
    await page.waitForTimeout(1000);
    facts.listJungle = await zooListLength(page);
    facts.locationsShown = await page.evaluate(async () => {
        const { DataStoreCollection } = await import('/js/common/data/DataStoreCollection.js');
        const DS = await import('/js/common/core/DataStore.js');
        const c = new DataStoreCollection(['management', 'animals', 'animals', 'list']);
        await new Promise(r => setTimeout(r, 200));
        const locs = [...new Set(c.source.map(x => DS.getValue(x, 'location')))];
        c.dispose();
        return locs;
    });
    await shot(page, '14_zoo_jungle');

    // select-all with a filter active only picks visible animals
    await page.evaluate(() => engine.trigger('Management_SelectAllCheckboxToggled', 'selectAllAnimals', true));
    await page.waitForTimeout(300);
    facts.selectEvents = await page.evaluate(() => window.__zooSelect.slice());

    await page.locator('.PZ2QoL_bar.zoo .PZ2QoL_chip', { hasText: /^Sort:/ }).click();
    await page.waitForTimeout(800);
    await shot(page, '15_zoo_sorted');
    facts.barHeight = await page.evaluate(() => Math.round(document.querySelector('.PZ2QoL_bar.zoo').getBoundingClientRect().height));
    await page.locator('.PZ2QoL_bar.zoo .PZ2QoL_chip', { hasText: /^Clear/ }).click();
    await page.waitForTimeout(800);
    facts.listAfterClear = await zooListLength(page);

    const problems = [];
    if (!(facts.rows > 3)) problems.push('too few dummy rows: ' + facts.rows);
    if (facts.listBefore != facts.rows) problems.push('list changed before filtering: ' + facts.listBefore + ' vs ' + facts.rows);
    if (!facts.habitatMenu.some(t => /Jungle Habitat/.test(t))) problems.push('habitat menu missing habitats: ' + facts.habitatMenu);
    if (!(facts.listJungle > 0 && facts.listJungle < facts.rows)) problems.push('habitat filter did not narrow: ' + facts.listJungle + '/' + facts.rows);
    if (facts.locationsShown.length != 1 || !/Jungle/.test(facts.locationsShown[0])) problems.push('other habitats visible: ' + facts.locationsShown);
    const items = facts.selectEvents.filter(e => e[0] == 'item' && e[2] === true).length;
    if (items != facts.listJungle) problems.push('select-all selected ' + items + ', expected the ' + facts.listJungle + ' visible');
    if (facts.selectEvents.some(e => e[0] == 'all' && e[2] === true)) problems.push('select-all reached the game unfiltered');
    if (facts.listAfterClear != facts.rows) problems.push('clear did not restore the list: ' + facts.listAfterClear);
    // three lines since 1.3 (the Kin chips); more means wrapping went wrong
    if (facts.barHeight > 120) problems.push('zoo toolbar too tall: ' + facts.barHeight + 'px');
    facts.problems = problems;
    if (problems.length) throw new Error('zoo scenario: ' + problems.join('; '));
    return facts;
}

// ------------------------------------------------------------------ kin
// Each tests/uiharness/kin_*.mjs exports { name, hud?(page, ctx), frontend?(page, ctx) }.
// They run after the built-in scenarios; a thrown Error is a harness failure.
const KIN_SCENARIOS = [];
for (const f of fs.readdirSync(HERE).filter(n => /^kin_.*\.mjs$/.test(n) && n !== 'kin_fixture.mjs').sort()) {
    const mod = await import('./' + f);
    KIN_SCENARIOS.push(Object.assign({ name: f.replace(/^kin_|\.mjs$/g, '') }, mod));
}
const kinCtx = { shot, OUT, gotoMarketTab, facts: results => results };

// ------------------------------------------------------------------ main
const srv = await startServer({ roots: [OVERLAY, GAME] });
const browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
const results = { screenshots: {}, facts: {}, records: [], harnessErrors: [] };
const step = async (name, fn) => {
    try { return await fn(); }
    catch (e) { results.harnessErrors.push(`${name}: ${e.message.split('\n')[0]}`); return undefined; }
};

try {
    if (VANILLA) {
        const { page, rec } = await openFrontend(browser, `${srv.url}/Frontend.html`, 'vanilla');
        results.records.push(rec);
        await step('vanilla market', async () => {
            await gotoMarketTab(page, 0);
            results.screenshots.vanillaMarket = await shot(page, '1_vanilla_market');
            results.facts.vanillaMarket = await domFacts(page);
        });
        await page.close();
    }

    const { page, rec } = KIN_ONLY ? { page: null, rec: null } : await openFrontend(browser, `${srv.url}/PZ2QoLFrontend.html`, 'modded');
    if (!KIN_ONLY) {
    results.records.push(rec);
    await step('modded market', async () => {
        await gotoMarketTab(page, 0);
        results.screenshots.moddedMarket = await shot(page, '2_modded_market');
        results.facts.moddedMarket = await domFacts(page);
    });
    await step('row layout untouched', async () => {
        // The game's Repeater positions rows; the mod must never restyle them
        // (setting position on row roots broke the in-game list layout).
        const touched = await page.evaluate(() => Array.from(document.querySelectorAll('.MarketAnimalListItem_root'))
            .filter(r => r.style.position == 'relative').length);
        const badgeParents = await page.evaluate(() => Array.from(document.querySelectorAll('.PZ2QoL_badge'))
            .filter(b => !b.parentNode.classList.contains('MarketAnimalListItem_listRoot')).length);
        results.facts.rowLayout = { rowsWithModInlineStyle: touched, badgesOutsideListRoot: badgeParents };
        if (touched || badgeParents) throw new Error(`row layout touched: ${JSON.stringify(results.facts.rowLayout)}`);
    });
    await step('modded storage', async () => {
        await page.evaluate(() => engine.trigger('SetAnimalMarketScreen', 1 /* EAnimalMarketScreenID.Storage */));
        await page.waitForSelector('.AnimalMarketStorage_header', { state: 'visible', timeout: 15000 });
        await page.waitForSelector('.PZ2QoL_bar.storage', { state: 'visible', timeout: 5000 });
        await page.waitForTimeout(1500);
        results.screenshots.moddedStorage = await shot(page, '3_modded_storage');
        await page.locator('.PZ2QoL_bar.storage .PZ2QoL_collapse').click();
        await page.waitForTimeout(500);
        results.screenshots.moddedStorageCollapsed = await shot(page, '3b_modded_storage_collapsed');
        results.facts.collapsedBarHeight = await page.evaluate(() => Math.round(document.querySelector('.PZ2QoL_bar.storage').getBoundingClientRect().height));
        await page.locator('.PZ2QoL_bar.storage .PZ2QoL_collapse').click();
        await page.waitForTimeout(500);
        results.facts.moddedStorage = await domFacts(page);
    });
    await step('storage filter Pregnant', async () => {
        await clickChip(page, '.PZ2QoL_bar.storage', 'Pregnant');
        results.screenshots.moddedStoragePregnant = await shot(page, '4_modded_storage_pregnant');
        results.facts.moddedStoragePregnant = await domFacts(page);
    });
    await step('storage sort', async () => {
        await clickChip(page, '.PZ2QoL_bar.storage', 'Pregnant'); // off again
        await page.locator('.PZ2QoL_bar.storage .PZ2QoL_chip', { hasText: /^Sort:/ }).click(); // Game -> Gene
        await page.waitForTimeout(1200);
        results.screenshots.moddedStorageSortGene = await shot(page, '5_modded_storage_sort_gene');
        results.facts.moddedStorageSortGene = await domFacts(page);
        await clickChip(page, '.PZ2QoL_bar.storage', 'Clear');
    });
    await step('error banner', async () => {
        results.facts.errorRouting = await page.evaluate(() => ({
            handlersForPZ2QoL_Error: (engine.events['PZ2QoL_Error'] || []).length,
            triggerPatchedBySelectAllGuard: !!engine.__pz2qolGuard,
        }));
        await page.evaluate(() => engine.trigger('PZ2QoL_Error', 'server', 'Server error: NotEnoughCC', 'test detail'));
        await page.waitForSelector('.PZ2QoL_errorBanner:not(.hidden)', { timeout: 3000 });
        results.screenshots.errorBanner = await shot(page, '6_modded_error_banner');
        await page.locator('.PZ2QoL_errorBanner .PZ2QoL_errorButton', { hasText: 'Details' }).click();
        await page.waitForTimeout(300);
        results.screenshots.errorBannerExpanded = await shot(page, '7_modded_error_banner_expanded');
        results.facts.errorBanner = (await domFacts(page)).errorBanner;
        await page.locator('.PZ2QoL_errorBanner .PZ2QoL_errorButton', { hasText: 'Dismiss' }).click();
    });
    await step('market lister', async () => {
        results.facts.lister = await runListerScenario(page);
    });
    await page.close();
    }

    // In-park HUD: zoo management Animals list filters
    const hud = await openHud(browser, srv.url + '/PZ2QoLHUD.html', 'hud');
    results.records.push(hud.rec);
    if (!KIN_ONLY) await step('zoo animal filters', async () => {
        results.facts.zoo = await runZooScenario(hud.page);
    });
    for (const mod of KIN_SCENARIOS) {
        if (typeof mod.hud !== 'function') continue;
        await step(`kin ${mod.name} (HUD)`, async () => {
            const sink = {};
            try {
                results.facts['kin_' + mod.name + '_hud'] = await mod.hud(hud.page, Object.assign({}, kinCtx, { facts: sink }));
            }
            finally {
                if (!results.facts['kin_' + mod.name + '_hud']) results.facts['kin_' + mod.name + '_hud'] = sink;
            }
        });
    }
    await hud.page.close();

    // Kin on the hub page (Animal Storage, Compare Mates): a fresh page
    if (KIN_SCENARIOS.some(m => typeof m.frontend === 'function')) {
        const fe = await openFrontend(browser, `${srv.url}/PZ2QoLFrontend.html`, 'kin_frontend');
        results.records.push(fe.rec);
        for (const mod of KIN_SCENARIOS) {
            if (typeof mod.frontend !== 'function') continue;
            await step(`kin ${mod.name} (Frontend)`, async () => {
                const sink = {};
                try {
                    results.facts['kin_' + mod.name + '_frontend'] = await mod.frontend(fe.page, Object.assign({}, kinCtx, { facts: sink }));
                }
                finally {
                    if (!results.facts['kin_' + mod.name + '_frontend']) results.facts['kin_' + mod.name + '_frontend'] = sink;
                }
            });
        }
        await fe.page.close();
    }
}
finally {
    await browser.close();
    srv.server.close();
}

// ---------------------------------------------------------------- report
const lines = [];
const log = (...a) => lines.push(a.join(' '));
let modUncaught = 0;
const INTENTIONAL = /Server error: NotEnoughCC/;
for (const rec of results.records) {
    const all = rec.console;
    const interesting = all.filter(m => (m.type === 'error' || m.type === 'warning' || isModText(m.text)) && !NOISE.some(r => r.test(m.text)));
    const noiseCount = all.length - interesting.length;
    log(`\n=== ${rec.label}: ${all.length} console messages (${noiseCount} routine/noise hidden; full log in ${path.join(OUT, `console_${rec.label}.log`)}) ===`);
    for (const m of interesting) {
        const tag = isModText(m.text) || /\/js\/mods\/pz2qol\//.test(m.url) ? 'MOD ' : 'GAME';
        log(`  [${tag}][${m.type}] ${m.text.split('\n')[0].slice(0, 400)}${m.url ? `  @${m.url}` : ''}${INTENTIONAL.test(m.text) ? '  (intentional test)' : ''}`);
    }
    log(`--- ${rec.label}: ${rec.pageErrors.length} uncaught page errors ---`);
    for (const e of rec.pageErrors) {
        const fromMod = /\/js\/mods\/pz2qol\//.test(e.stack);
        if (fromMod) modUncaught++;
        log(`  [${fromMod ? 'MOD ' : 'GAME'}] ${e.message}\n      ${e.stack.split('\n').slice(1, 4).map(s => s.trim()).join('\n      ')}`);
    }
    fs.writeFileSync(path.join(OUT, `console_${rec.label}.log`),
        all.map(m => `[${m.type}] ${m.text}${m.url ? `  @${m.url}` : ''}`).join('\n') + '\n\n--- page errors ---\n' +
        rec.pageErrors.map(e => e.stack || e.message).join('\n\n'));
}
const missing = srv.misses.filter(u => !/favicon|\.locxml/i.test(u));
log(`\n=== server: ${srv.misses.length} 404s (${srv.misses.filter(u => /\.locxml/i.test(u)).length} .locxml loc files, ${missing.filter(u => u.startsWith('/img')).length} /img textures not in the unpacked UI; other: ${JSON.stringify([...new Set(missing.filter(u => !u.startsWith('/img')))])})`);
log('\n=== DOM facts ===');
log(JSON.stringify(results.facts, null, 2));
log('\n=== screenshots ===');
for (const [k, v] of Object.entries(results.screenshots)) log(`  ${k}: ${v}`);
if (results.harnessErrors.length) log('\n=== HARNESS ERRORS ===\n  ' + results.harnessErrors.join('\n  '));
const report = lines.join('\n');
console.log(report);
fs.writeFileSync(path.join(OUT, 'report.txt'), report);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));

// A feature that fails to start is reported by the mod itself (not thrown),
// so look for its own log line too.
const modStartFailures = results.records.flatMap(r => r.console)
    .filter(m => /\[PZ2QoL\] mod: .*(failed to start|not installed)/.test(m.text));
if (modStartFailures.length) {
    const firstLines = modStartFailures.map(m => m.text.split(/\r?\n/)[0]);
    console.log(`\nFAIL: mod features did not start:\n  ${firstLines.join('\n  ')}`);
    process.exit(1);
}
if (modUncaught > 0) {
    console.log(`\nFAIL: ${modUncaught} uncaught page error(s) from /js/mods/pz2qol/`);
    process.exit(1);
}
if (results.harnessErrors.length) {
    console.log('\nFAIL: harness could not complete all steps');
    process.exit(2);
}
console.log('\nOK');
