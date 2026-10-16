// Market lister: price advice for animals in storage and a one-click
// "Sell at recommended price" that lists them through the game's own
// AddToMarket path.
//
// Safety rules (do not relax without thinking about the player's account):
//  - off by default; Franchise only; only ever started by a click
//  - one listing at a time, each confirmed by the game before the next
//  - stops on the first error or on Stop
//  - selects each animal through the game's own select event and checks
//    the selection really is that animal before listing it
import * as DS from '/js/common/core/DataStore.js';
import { translate } from '/js/common/core/Localisation.js';
import { GameMode } from '/js/project/data/GameTypes.js';
import { currentGamemodeIs } from '/js/project/data/SimulationDataModel.js';
import { offsetLabel, recommendPrice, speciesMarketSummary } from '/js/mods/pz2qol/pricing.js';
import { Gender, geneScore, relevantGenes } from '/js/mods/pz2qol/scores.js';
import { clear, fmtInt, GENES, h, icon, setClass, setText, tierOf } from '/js/mods/pz2qol/ui.js';
import {
    childrenOf, get, MARKET_LIST, readAnimal, SPECIES_LIST, STORAGE_ACTIONS, STORAGE_DATA, STORAGE_LIST, TRADE_LISTING,
} from '/js/mods/pz2qol/game.js';
import { countForSpecies, getPriceBook, onPriceBookChanged, recordVisibleListings } from '/js/mods/pz2qol/pricebook.js';
import { breadcrumb, onErrorReported, reportError } from '/js/mods/pz2qol/errors.js';

// Pause after every listing request that reached the server, accepted or
// not. In game (2026-10-15) the requests sent 0.5 s after a rejection were
// rejected again three times out of four, and one of them crashed the game.
const GAP_BETWEEN_LISTINGS_MS = 3000;
// ... and a longer one after the server refused or failed a listing.
const ERROR_BACKOFF_MS = 8000;
// The game's listing request (AnimalStorage_AddToMarket) is franchise
// request type 42 (seen in game). Errors for other request types are
// background traffic (type 28 fails every few minutes on its own) and say
// nothing about the listing being waited on.
const LISTING_REQUEST_TYPE = 42;
// Before each listing, how long to wait for the game's previous franchise
// request to finish.
const SERVER_IDLE_TIMEOUT_MS = 10000;
const SELECT_TIMEOUT_MS = 5000;
const CONFIRM_TIMEOUT_MS = 30000;
const SETTING_KEY = 'PZ2QoL.listerEnabled';
const OFFSET_KEY = 'PZ2QoL.priceOffset';
// Global adjustment to every recommended price, in 5% steps.
export const OFFSET_STEP = 0.05;
export const OFFSET_LIMIT = 0.5;

// ------------------------------------------------------------- settings

let enabled = false;
try {
    enabled = window.localStorage && window.localStorage.getItem(SETTING_KEY) === 'true';
}
catch (e) {
    enabled = false;
}
const settingListeners = new Set();

export function isListerEnabled() {
    return enabled;
}

export function setListerEnabled(on) {
    enabled = !!on;
    try {
        if (window.localStorage) window.localStorage.setItem(SETTING_KEY, enabled ? 'true' : 'false');
    }
    catch (e) {
        // not persisted; stays for this session
    }
    document.body.classList.toggle('PZ2QoL_listerOn', enabled);
    settingListeners.forEach(fn => fn(enabled));
}

export function onListerSettingChanged(fn) {
    settingListeners.add(fn);
    return () => settingListeners.delete(fn);
}

// Price offset: one setting, applied wherever a recommended price is used
// (the panel, the multi-select totals and every listing the lister sends).
export function clampOffset(v) {
    const n = Number(v);
    if (!isFinite(n)) return 0;
    const stepped = Math.round(n / OFFSET_STEP) * OFFSET_STEP;
    return Math.round(Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, stepped)) * 100) / 100;
}

let priceOffset = 0;
try {
    priceOffset = clampOffset(window.localStorage && window.localStorage.getItem(OFFSET_KEY));
}
catch (e) {
    priceOffset = 0;
}

export function getPriceOffset() {
    return priceOffset;
}

export function setPriceOffset(v) {
    priceOffset = clampOffset(v);
    try {
        if (window.localStorage) window.localStorage.setItem(OFFSET_KEY, String(priceOffset));
    }
    catch (e) {
        // not persisted; stays for this session
    }
    settingListeners.forEach(fn => fn(enabled));
}

export function isFranchise() {
    if (window.__PZ2QOL_TEST_FRANCHISE !== undefined) return !!window.__PZ2QOL_TEST_FRANCHISE;
    try {
        return currentGamemodeIs(GameMode.Franchise);
    }
    catch (e) {
        return false;
    }
}

// -------------------------------------------------------------- helpers

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// While waiting, the run status shows a live counter so a slow game or
// server never looks like a frozen lister.
async function waitFor(predicate, timeoutMs, intervalMs = 200) {
    const start = Date.now();
    const base = run ? run.status : '';
    let shown = 0;
    try {
        while (Date.now() - start < timeoutMs) {
            if (predicate()) return true;
            await sleep(intervalMs);
            if (run && run.stopRequested) return false;
            const secs = Math.floor((Date.now() - start) / 1000);
            if (run && secs >= 2 && secs != shown) {
                shown = secs;
                if (secs == 2) breadcrumb('lister_waiting');
                run.status = `${base} (waiting ${secs}s of ${Math.round(timeoutMs / 1000)}s)`;
                notifyRun();
            }
        }
        return predicate();
    }
    finally {
        if (run && shown) {
            run.status = base;
            notifyRun();
        }
    }
}

function selectedKeys() {
    const v = get(STORAGE_DATA, 'selectedAnimalIDs');
    return Array.isArray(v) ? v.slice() : [];
}

function tradeLimits() {
    return {
        defaultPrice: get(TRADE_LISTING, 'tradePriceDefault'),
        min: get(TRADE_LISTING, 'tradePriceMin'),
        max: get(TRADE_LISTING, 'tradePriceMax'),
        duration: get(TRADE_LISTING, 'tradeDurationDefault'),
        durationMin: get(TRADE_LISTING, 'tradeDurationMin'),
        durationMax: get(TRADE_LISTING, 'tradeDurationMax'),
    };
}

function animalForKey(key) {
    return readAnimal(STORAGE_LIST.concat(key));
}

// Storage list keys ("animal_12") are positions: when an animal sells or the
// list is re-sorted the game rebuilds it and a key can point at another
// animal. A run therefore remembers each animal by its id plus what it is,
// and finds its current key again before every step.
function fingerprint(a) {
    const g = a.genes || {};
    return [a.species, a.name, a.gender, g.size, g.longevity, g.fertility, g.immunity].join('|');
}

function targetForKey(key) {
    const a = animalForKey(key);
    return { id: a.id, fp: fingerprint(a), key };
}

// The animal's current { key, a }, or null if it is no longer in storage
// (sold, moved) or cannot be told apart.
function findTarget(target) {
    let byFp = null, fpCount = 0;
    for (const ctx of childrenOf(STORAGE_LIST)) {
        const a = readAnimal(ctx);
        const fp = fingerprint(a);
        if (target.id != undefined && a.id == target.id) {
            return fp == target.fp ? { key: a.key, a } : null;
        }
        if (fp == target.fp) {
            byFp = { key: a.key, a };
            fpCount++;
        }
    }
    // ids not shown at all: fall back to an unambiguous fingerprint
    return target.id == undefined && fpCount == 1 ? byFp : null;
}

function t(s) {
    if (typeof s !== 'string') return s == undefined ? '' : String(s);
    try {
        return translate(s);
    }
    catch (e) {
        return s;
    }
}

const SEX = { [Gender.Male]: '♂', [Gender.Female]: '♀' };
const CONFIDENCE = {
    high: 'high confidence',
    medium: 'medium confidence',
    low: 'low confidence (few listings)',
    none: "no market data: using the game's own price",
};

// Advice for one storage animal, using the game's limits if it is the
// currently selected animal (the game only fills them for the selection).
export function adviceFor(animal, limits) {
    return recommendPrice(animal, getPriceBook(), limits || {}, { offset: priceOffset });
}

// ---------------------------------------------------------- check market

function speciesUid(species) {
    for (const ctx of childrenOf(SPECIES_LIST)) {
        const name = get(ctx, 'speciesName');
        if (name == species || t(name) == t(species)) {
            return get(ctx, 'speciesUID');
        }
    }
    return undefined;
}

// Background check: the mod's Lua (PZ2QoL.MarketPeek) runs the Market's
// own species filter and data request while Animal Storage stays on
// screen, says "ready" once the server answered, and puts the market back
// when we release it. The price book records the listings in between.
// (The game's SetAnimalMarketScreen tab switch only exists in the Coherent
// debug player, so switching tabs from here never worked in game.)
const PEEK_ANSWER_TIMEOUT_MS = 3000;
const PEEK_TOTAL_TIMEOUT_MS = 30000;
// The Market's own paginator shows at most 20 pages (0-based pageIndex).
export const PEEK_MAX_PAGES = 20;
const PEEK_PAGE_GAP_MS = 400; // pause between pages, like a player paging
const MARKET_DATA = ['hubAnimalsData', 'animalMarketData'];
let peek = null; // { species, uid, state: 'starting'|'loading'|'reading'|'done'|'failed', message }
let peekWaiter = null;
const peekListeners = new Set();

export function getMarketCheck() {
    return peek;
}

export function onMarketCheckChanged(fn) {
    peekListeners.add(fn);
    return () => peekListeners.delete(fn);
}

function setPeek(changes) {
    peek = Object.assign({}, peek, changes);
    peekListeners.forEach(fn => {
        try {
            fn(peek);
        }
        catch (e) {
            // ignore
        }
    });
}

function isPeekBusy() {
    return !!peek && (peek.state == 'starting' || peek.state == 'loading' || peek.state == 'reading');
}

// Lua -> page: 'loading' | 'ready' | 'busy' | 'failed' | 'done'
function onPeekState(state, detail) {
    if (peekWaiter) peekWaiter(state, detail);
    else if (state == 'failed' && isPeekBusy()) setPeek({ state: 'failed', message: `Market check failed: ${detail}` });
}

// Lua's answers arrive a frame later (TriggerEventAtNextAdvance), so a
// late 'done' from the previous check can reach the next one's waiter.
// accept: the states this wait is for; anything else is ignored.
const START_STATES = ['loading', 'ready', 'busy', 'failed'];
const LOAD_STATES = ['ready', 'failed', 'nopaging', 'busy'];
function nextPeekState(timeoutMs, accept) {
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            peekWaiter = null;
            resolve({ state: 'timeout' });
        }, timeoutMs);
        peekWaiter = (state, detail) => {
            if (accept && !accept.includes(state)) return;
            clearTimeout(timer);
            peekWaiter = null;
            resolve({ state, detail });
        };
    });
}

// Lets Lua put the market back and waits for its 'done', so the answer
// cannot be mistaken for the next check's.
async function releasePeek() {
    const done = nextPeekState(2000, ['done', 'failed']);
    engine.trigger('PZ2QoL_MarketPeekRelease');
    await done;
}

function marketListingsFor(species) {
    return childrenOf(MARKET_LIST).filter(ctx => get(ctx, 'species') == species);
}

// What the visible market page shows. Row ids are screen slots, reused on
// every page, so a page change is detected by content.
function pageSignature() {
    return childrenOf(MARKET_LIST).map(ctx => {
        const a = readAnimal(ctx);
        return [a.name, a.price, a.genes.size, a.genes.longevity].join(',');
    }).join('|');
}

// Waits for Lua's 'loading' -> 'ready' after a request or page change.
async function awaitPeekReady() {
    let reply = await nextPeekState(PEEK_ANSWER_TIMEOUT_MS, START_STATES.concat(['nopaging']));
    if (reply.state == 'loading') reply = await nextPeekState(PEEK_TOTAL_TIMEOUT_MS, LOAD_STATES);
    return reply;
}

// Reads the visible page once the DataStore has caught up with Lua.
// fresh: false if the page never changed (nothing new to record).
async function readPeekPage(species, isFresh) {
    let rows = [], fresh = false;
    for (let i = 0; i < 10; i++) {
        rows = marketListingsFor(species);
        fresh = isFresh();
        if (rows.length && fresh) break;
        await sleep(150);
    }
    if (fresh) recordVisibleListings();
    return { rows, fresh };
}

// Fetches the current Market listings for one species without leaving
// Animal Storage. Click-started only; one at a time.
// Returns { ok, total, fatal }; fatal means checking other species is
// pointless too (no game-side script, storage closed).
// opts.quiet: no error toast (the multi-species check sums them up).
export async function checkMarketFor(species, opts = {}) {
    if (isPeekBusy()) return { ok: false, total: 0, fatal: false, busy: true, message: 'A market check is already running.' };
    setPeek({ species, uid: undefined, state: 'starting', message: 'Asking the market…' });
    const fail = (title, detail, fatal = false) => {
        setPeek({ state: 'failed', message: detail ? `${title}: ${detail}` : title });
        if (!opts.quiet) reportError('lister', title, detail);
        return { ok: false, total: 0, fatal: fatal || /Animal Storage/.test(String(detail || '')), busy: title == 'Market check is busy', message: detail || title };
    };
    // a freshly bound collection fills asynchronously; give it a moment
    let uid = speciesUid(species);
    for (let i = 0; uid == undefined && i < 10; i++) {
        await sleep(100);
        uid = speciesUid(species);
    }
    if (uid == undefined) {
        return fail('Cannot check the market for this species', `The game's species list has no id for ${t(species)}.`);
    }
    setPeek({ uid });
    breadcrumb('peek_start');
    const answer = nextPeekState(PEEK_ANSWER_TIMEOUT_MS, START_STATES);
    engine.trigger('PZ2QoL_MarketPeek', uid);
    let reply = await answer;
    if (reply.state == 'timeout') {
        return fail('Market check got no answer', "The mod's game-side script did not reply. Install a matching PZ2QoL build (Main.ovl and UI together), then reopen Animal Storage.", true);
    }
    if (reply.state == 'loading') {
        setPeek({ state: 'loading', message: `Loading ${t(species)} listings…` });
        reply = await nextPeekState(PEEK_TOTAL_TIMEOUT_MS, LOAD_STATES);
    }
    if (reply.state != 'ready') {
        // Lua still holds the market after a timeout: let it put it back
        if (reply.state == 'timeout') await releasePeek();
        const title = reply.state == 'busy' ? 'Market check is busy' : 'Market check failed';
        return fail(title, reply.state == 'timeout' ? 'The game never reported the market data as loaded.' : reply.detail);
    }
    // the DataStore reaches the page a frame or two after Lua sees the answer
    const before = countForSpecies(species);
    let total = 0, cc = 0, pagesRead = 0, pages = 1, pagesKnown = false, stopNote = '', lastSig = null, luaFinished = false;
    try {
        for (let page = 0; ; page++) {
            setPeek({ state: 'reading', message: page == 0 ? 'Recording prices…' : `Recording prices, page ${page + 1}${pagesKnown ? ` of ${pages}` : ''}…` });
            const prevSig = lastSig;
            const { rows, fresh } = await readPeekPage(species, () => {
                if (page == 0) return true;
                const index = get(MARKET_DATA, 'pageIndex');
                return (typeof index !== 'number' || index == page) && pageSignature() != prevSig;
            });
            if (!fresh) {
                // the page did not change: past the end, or paging is not
                // shown to the page while the market is hidden
                if (pagesKnown) stopNote = ` (page ${page + 1} did not show)`;
                break;
            }
            lastSig = pageSignature();
            pagesRead++;
            total += rows.length;
            cc += rows.filter(ctx => get(ctx, 'auctionIsConservationCredits')).length;
            // the game's page count; without it keep going until a page
            // comes back unchanged
            const known = get(MARKET_DATA, 'pages');
            pagesKnown = typeof known === 'number' && known > 0;
            pages = Math.min(PEEK_MAX_PAGES, pagesKnown ? known : PEEK_MAX_PAGES);
            if (page + 1 >= pages) break;
            await sleep(PEEK_PAGE_GAP_MS);
            breadcrumb('peek_page');
            const next = awaitPeekReady();
            engine.trigger('PZ2QoL_MarketPeekPage', page + 1);
            const r = await next;
            if (r.state == 'failed') luaFinished = true; // Lua already put the market back
            if (r.state != 'ready') {
                // keep what was read; say why the rest is missing
                stopNote = r.state == 'nopaging' ? ' (this game version cannot change pages here)'
                    : ` (page ${page + 2} did not load${r.detail ? `: ${r.detail}` : ''})`;
                break;
            }
        }
    }
    finally {
        if (!luaFinished) await releasePeek();
    }
    breadcrumb('peek_done');
    const added = countForSpecies(species) - before;
    const where = pagesRead == 1 ? '1 market page' : `${pagesRead} market pages`;
    setPeek({
        state: 'done',
        message: total
            ? `Checked: ${total} ${t(species)} listing${total == 1 ? '' : 's'} on ${where} (${cc} for CC)${added > 0 ? `, ${added} new` : ''}${stopNote}.`
            : `Checked: no ${t(species)} listings for Conservation Credits on the market right now${stopNote}.`,
    });
    return { ok: true, total, fatal: false };
}

// Several species, one after another (each with all its pages). Only
// started by a click; one market check at a time, with the game-side
// cooldown between species; Stop ends it after the current species.
const PEEK_SPECIES_GAP_MS = 3200; // the Lua side refuses checks < 3 s apart
let peekAll = null; // { list, index, done, failed, listings, stopRequested, finished, message }

export function getMultiMarketCheck() {
    return peekAll;
}

function setPeekAll(changes) {
    peekAll = Object.assign({}, peekAll, changes);
    peekListeners.forEach(fn => {
        try {
            fn(peek);
        }
        catch (e) {
            // ignore
        }
    });
}

export function isMultiCheckBusy() {
    return !!peekAll && !peekAll.finished;
}

export function stopMultiCheck() {
    if (isMultiCheckBusy() && !peekAll.stopRequested) setPeekAll({ stopRequested: true, message: `${peekAll.message} Stopping after this species…` });
}

export async function checkMarketForAll(speciesList) {
    if (isMultiCheckBusy() || isPeekBusy() || (run && !run.finished)) return false;
    const list = Array.from(new Set(speciesList.filter(Boolean)));
    if (!list.length) return false;
    breadcrumb('peek_all_start');
    setPeekAll({ list, index: 0, done: 0, failed: [], listings: 0, stopRequested: false, finished: false, message: '' });
    let lastStart = 0;
    for (let i = 0; i < list.length; i++) {
        if (peekAll.stopRequested) break;
        const species = list[i];
        const wait = PEEK_SPECIES_GAP_MS - (Date.now() - lastStart);
        setPeekAll({ index: i, message: `Checking ${t(species)} (${i + 1} of ${list.length})…` });
        if (wait > 0) await sleep(wait);
        if (peekAll.stopRequested) break;
        lastStart = Date.now();
        let r = await checkMarketFor(species, { quiet: true });
        if (!r.ok && r.busy && !peekAll.stopRequested) {
            await sleep(PEEK_SPECIES_GAP_MS);
            lastStart = Date.now();
            r = await checkMarketFor(species, { quiet: true });
        }
        if (r.ok) setPeekAll({ done: peekAll.done + 1, listings: peekAll.listings + r.total });
        else setPeekAll({ failed: peekAll.failed.concat(`${t(species)}: ${r.message || 'failed'}`) });
        if (r.fatal) break;
    }
    const f = peekAll.failed;
    const stopped = peekAll.done + f.length < list.length;
    const message = `${stopped ? 'Stopped' : 'Done'}: checked ${peekAll.done} of ${list.length} species, ${peekAll.listings} listing${peekAll.listings == 1 ? '' : 's'} found`
        + (f.length ? `; ${f.length} failed (${f[0]}${f.length > 1 ? ', …' : ''})` : '') + '.';
    if (f.length) reportError('lister', `Market check failed for ${f.length} species`, f.join('\n'));
    breadcrumb('peek_all_end');
    setPeekAll({ finished: true, message });
    return true;
}

// --------------------------------------------------------------- selling

let run = null; // { total, done, current, stopRequested, log: [] }
const runListeners = new Set();

export function getRun() {
    return run;
}

export function onRunChanged(fn) {
    runListeners.add(fn);
    return () => runListeners.delete(fn);
}

function notifyRun() {
    runListeners.forEach(fn => {
        try {
            fn(run);
        }
        catch (e) {
            // ignore
        }
    });
}

export function stopRun() {
    if (run) {
        run.stopRequested = true;
        run.status = 'Stopping after the current step…';
        notifyRun();
    }
}

class StopError extends Error {
}
// A problem with this one animal: skip it and carry on with the next.
class SkipError extends Error {
    constructor(message, kind) {
        super(message);
        this.kind = kind || 'other';
    }
}
// How each kind of skip reads in the summary ("skipped 3: 2 not tradeable, ...").
const SKIP_KINDS = {
    gone: 'no longer in storage',
    listed: 'already on the market',
    moving: 'being moved',
    noid: 'no id',
    unselectable: 'could not be selected',
    untradeable: "the game doesn't allow trading",
    changed: 'the list changed',
    noprice: 'no price',
    busy: 'server busy',
    stopped: 'stopped while waiting',
    timeout: 'server timeout',
    refused: 'refused by the server',
    other: 'other',
};

function stop(title, detail) {
    throw new StopError(`${title}${detail ? ': ' + detail : ''}`);
}

function skip(reason, kind) {
    throw new SkipError(reason, kind);
}

// Server errors that would hit every following listing too: stop instead of skipping.
const FATAL_SERVER_ERRORS = /NotAuthorised|MaintainanceMode|Maintenance|PlayerBanned|NotEnoughCC|CouldNotParseResponse|InternalServerError/;
// The game's requests time out now and then (a known game issue): the
// listing may still go through, so wait a little longer, then move on.
const TIMEOUT_SERVER_ERRORS = /DidNotGetResponse/;
const LATE_CONFIRM_MS = 8000;
// The game shows unnamed codes ("code 255"), so even a "rejection" may
// still go through: look once more before calling it rejected.
const REJECT_GRACE_MS = 3000;
// "Server error: code N": no DatabaseError_* name matched (255 and 5 seen).
// "Unknown" is just as unspecific (names resolve since 2026-10-15 20:13).
const UNNAMED_SERVER_ERROR = /Server error: (code -?\d+|Unknown)\b/;
const MAX_CONSECUTIVE_REJECTIONS = 3;

// Whether a reported error can be about the listing being waited on.
function isAboutListing(entry) {
    if (entry.source != 'server') return true;
    const detail = String(entry.detail || '');
    if (/\((CloseZooDryRun|CommunityChallenge\w*)\)/.test(detail)) return false;
    const m = /request #(\d+)/.exec(detail);
    return !m || Number(m[1]) == LISTING_REQUEST_TYPE;
}

// The game's own "a franchise request is still running" flag
// (IsDatabaseOperationInProgress, asked through the mod's Lua). Resolves
// { known, busy, request }; known is false when the Lua side cannot tell
// (or is an older build that does not answer).
let serverStateWaiter = null;
let serverStateListening = false;
function queryServerState(timeoutMs = 1000) {
    if (!serverStateListening) {
        serverStateListening = true;
        engine.on('PZ2QoL_DbState', (known, busy, request) => {
            if (serverStateWaiter) serverStateWaiter({ known: known === true, busy: busy === true, request });
        });
    }
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            serverStateWaiter = null;
            resolve({ known: false, busy: false });
        }, timeoutMs);
        serverStateWaiter = state => {
            clearTimeout(timer);
            serverStateWaiter = null;
            resolve(state);
        };
        engine.trigger('PZ2QoL_DbQuery');
    });
}

// Waits until the game has no franchise request running. true when idle
// (or unknown), false when still busy after timeoutMs or stopped.
async function waitForIdleServer(timeoutMs) {
    const start = Date.now();
    let state = await queryServerState();
    if (state.busy) breadcrumb('lister_server_busy');
    while (state.known && state.busy) {
        if (run.stopRequested || Date.now() - start > timeoutMs) return false;
        await sleep(300);
        state = await queryServerState();
    }
    return true;
}

async function listOne(target, index) {
    run.attempt = { sent: false, error: false };
    const found = findTarget(target);
    const label = target.label;
    run.current = { key: found ? found.key : target.key, label, index };
    run.status = `Selecting ${index + 1}/${run.total}: ${label}`;
    notifyRun();
    if (!found) skip(`${label}: no longer in storage (sold, moved, or the list changed)`, 'gone');
    const before = found.a;
    if (before.auctionTimerSeconds > 0) skip(`${label}: already on the market`, 'listed');
    if (before.isMoving) skip(`${label}: being moved`, 'moving');
    if (before.id == undefined) skip(`${label}: no id`, 'noid');

    // 1. select exactly this animal, the way a click on its row does
    breadcrumb('lister_select');
    engine.trigger('AnimalStorage_SelectAllToggled', false);
    engine.trigger('AnimalStorage_ItemSelected', before.id);
    const isSelected = () => {
        const f = findTarget(target);
        const keys = selectedKeys();
        return !!f && keys.length == 1 && keys[0] == f.key;
    };
    const selected = await waitFor(isSelected, SELECT_TIMEOUT_MS);
    if (run.stopRequested) throw new StopError('Stopped by you');
    if (!selected) skip(`${label}: could not be selected (game selection [${selectedKeys().join(', ')}])`, 'unselectable');
    breadcrumb('lister_selected');

    // 2. the game must allow trading it (e.g. juveniles can't be traded)
    const allowed = await waitFor(() => get(STORAGE_ACTIONS, 'tradeAllowed') === true, 3000);
    if (!allowed) skip(`${label}: ${t(get(STORAGE_ACTIONS, 'tradeDisallowedReason')) || 'the game does not allow trading it'}`, 'untradeable');

    // 3. price from the game's limits for this animal plus the price book
    await sleep(300);
    const now = findTarget(target);
    if (!now) skip(`${label}: the list changed while listing; not listed`, 'changed');
    const limits = tradeLimits();
    const advice = adviceFor(now.a, limits);
    if (!(advice.price > 0)) skip(`${label}: no price (${advice.reason})`, 'noprice');
    // longest listing the game allows (12h today) instead of its default (6h)
    const duration = limits.durationMax > 0 ? limits.durationMax
        : limits.duration > 0 ? limits.duration : (limits.durationMin > 0 ? limits.durationMin : 1);

    // 4. list it, exactly as the game's Trade → Confirm does
    run.status = `Listing ${index + 1}/${run.total}: ${label} at ${advice.price} CC for ${duration}h`;
    notifyRun();
    // never while the game is still waiting on its previous request
    if (!(await waitForIdleServer(SERVER_IDLE_TIMEOUT_MS))) {
        if (run.stopRequested) throw new StopError('Stopped by you');
        run.attempt.error = true;
        skip(`${label}: the game was still busy with another server request; not listed`, 'busy');
    }
    const errorsBefore = run.errors.length;
    // the key the game uses must point at this animal right now, and it
    // must still be the only selection
    const atSend = findTarget(target);
    if (!atSend || !isSelected()) {
        breadcrumb('lister_moved');
        skip(`${label}: the list changed just before listing; not listed`, 'changed');
    }
    breadcrumb('lister_add');
    run.attempt.sent = true;
    engine.trigger('AnimalStorage_AddToMarket', atSend.key, advice.price, duration);

    // 5. wait until the game shows it on the market, or an error arrives
    const isListed = () => {
        const f = findTarget(target);
        return !!f && f.a.auctionTimerSeconds > 0;
    };
    let confirmed = await waitFor(() => run.errors.length > errorsBefore || isListed(), CONFIRM_TIMEOUT_MS, 250);
    if (!isListed() && run.stopRequested) {
        skip(`${label}: stopped while waiting for the server; it may still appear on the market`, 'stopped');
    }
    if (!isListed() && run.errors.length > errorsBefore) {
        run.attempt.error = true;
        const err = run.errors[run.errors.length - 1];
        if (TIMEOUT_SERVER_ERRORS.test(err)) {
            // timed out: it may still arrive
            run.status = `Listing ${index + 1}/${run.total}: ${label}: the server timed out, checking whether it was listed…`;
            notifyRun();
            confirmed = await waitFor(isListed, LATE_CONFIRM_MS, 250);
            if (!confirmed) {
                breadcrumb('lister_unconfirmed');
                skip(`${label}: the server timed out; it may still appear on the market (${err})`, 'timeout');
            }
        }
        else if (!FATAL_SERVER_ERRORS.test(err) && await waitFor(isListed, REJECT_GRACE_MS, 250)) {
            // an unnamed code, but the listing went through after all
            breadcrumb('lister_listed_after_error');
        }
        else {
            if (FATAL_SERVER_ERRORS.test(err)) stop(`Listing ${label} failed`, err);
            // Unnamed codes: both in-game crashes (2026-10-15, 0xFDEAD) came
            // right after the server answered a listing with code 5, each a
            // few seconds after a code 255 refusal earlier in the same run.
            // Stop at the first one; listing more is not worth the game.
            if (UNNAMED_SERVER_ERROR.test(err)) {
                breadcrumb('lister_stop_unnamed');
                stop(`The server refused ${label}`, `${err}. Stopped to be safe: listing more right after a refusal has crashed the game. Wait a minute before selling again.`);
            }
            run.rejections++;
            if (run.rejections >= MAX_CONSECUTIVE_REJECTIONS) stop(`${MAX_CONSECUTIVE_REJECTIONS} listings in a row were rejected`, err);
            skip(`${label}: rejected by the server (${err})`, 'refused');
        }
    }
    // No answer at all: the game's request timed out; move on, but say so.
    if (!confirmed) {
        run.attempt.error = true;
        breadcrumb('lister_unconfirmed');
        skip(`${label}: no confirmation after ${CONFIRM_TIMEOUT_MS / 1000}s; it may still appear on the market`, 'timeout');
    }
    breadcrumb('lister_confirmed');
    run.rejections = 0;
    run.listed.push({ label, price: advice.price, confidence: advice.confidence });
    run.log.push(`Listed ${label} at ${advice.price} CC`);
    run.done++;
    notifyRun();
}

function skipCounts() {
    const counts = {};
    for (const k of run.skipKinds || []) counts[k] = (counts[k] || 0) + 1;
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map(k => `${counts[k]} ${SKIP_KINDS[k] || k}`).join(', ');
}

function summary() {
    const parts = [`listed ${run.done}`];
    if (run.skipped.length) parts.push(`skipped ${run.skipped.length} (${skipCounts()})`);
    let text = `${parts.join(', ')} of ${run.total}`;
    if (run.leftOut) text += `; ${run.leftOut} already on the market left out`;
    return text;
}

// Selected animals a run would list: not those already on the market.
export function sellableKeys(keys) {
    return keys.filter(k => !(animalForKey(k).auctionTimerSeconds > 0));
}

// Lists the given storage animals (child keys) at their recommended prices.
export async function sellAtRecommendedPrice(keys) {
    if (run && !run.finished) return;
    if (isMultiCheckBusy() || isPeekBusy()) return; // one market action at a time
    if (!enabled) {
        reportError('lister', 'The market lister is turned off', 'Turn it on in the storage toolbar first.');
        return;
    }
    if (!isFranchise()) {
        reportError('lister', 'Listing is only available in Franchise mode');
        return;
    }
    // animals already on the market are left out up front, not "skipped"
    const allKeys = keys;
    keys = sellableKeys(keys);
    // remember the animals, not the list positions (see findTarget)
    const queue = keys.map(k => {
        const target = targetForKey(k);
        const a = animalForKey(k);
        target.label = `${t(a.species) || 'animal'} ${SEX[a.gender] || ''} "${t(a.name)}"`.replace(/\s+/g, ' ');
        return target;
    });
    breadcrumb('lister_start');
    run = {
        total: queue.length, done: 0, current: null, stopRequested: false, finished: false, stopped: false,
        status: '', log: [], errors: [], listed: [], skipped: [], skipKinds: [], rejections: 0, startedAt: Date.now(),
        leftOut: allKeys.length - keys.length,
    };
    const unsubscribe = onErrorReported(entry => {
        if (entry.source == 'server' || entry.source == 'lua' || entry.source == 'debug') {
            if (!isAboutListing(entry)) {
                breadcrumb('lister_error_ignored');
                return;
            }
            run.errors.push(`${entry.title}${entry.detail ? ' — ' + entry.detail : ''}`);
        }
    });
    notifyRun();
    try {
        for (let i = 0; i < queue.length; i++) {
            if (run.stopRequested) throw new StopError('Stopped by you');
            try {
                await listOne(queue[i], i);
            }
            catch (e) {
                if (!(e instanceof SkipError)) throw e;
                breadcrumb('lister_skip');
                breadcrumb(`lister_skip_${e.kind}`);
                run.skipped.push(e.message);
                run.skipKinds.push(e.kind);
                run.log.push(`Skipped ${e.message}`);
                notifyRun();
            }
            // pace after every request the server saw (listed or not), longer
            // after an error; skips that sent nothing move straight on
            const attempt = run.attempt || {};
            if ((attempt.sent || attempt.error) && i < queue.length - 1) {
                const pause = attempt.error ? ERROR_BACKOFF_MS : GAP_BETWEEN_LISTINGS_MS;
                run.status = attempt.error
                    ? `Listed ${run.done}/${run.total}. The server had a problem; next in ${pause / 1000}s…`
                    : `Listed ${run.done}/${run.total}. Next in ${pause / 1000}s…`;
                notifyRun();
                await sleep(pause);
            }
        }
        run.status = `Done: ${summary()}.`;
        if (run.skipped.length) {
            reportError('lister', `Listed ${run.done} of ${run.total}; skipped ${run.skipped.length} (${skipCounts()})`, run.skipped.join(' · '), { silent: true });
        }
    }
    catch (e) {
        const msg = e instanceof StopError ? e.message : `Unexpected error: ${e && e.message}`;
        breadcrumb('lister_stop');
        run.stopped = true;
        run.status = `Stopped (${summary()}): ${msg}`;
        if (!(e instanceof StopError && /^Stopped by you/.test(e.message))) {
            reportError('lister', `Market lister stopped (${summary()})`, msg);
        }
    }
    finally {
        unsubscribe();
        breadcrumb('lister_end');
        run.finished = true;
        run.current = null;
        notifyRun();
    }
}

// ------------------------------------------------------------------ panel

function visibleElement(selector) {
    const node = document.querySelector(selector);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    for (let n = node; n && n != document.body; n = n.parentNode) {
        if (n.classList && n.classList.contains('hidden')) return null;
    }
    return node;
}

// ---- panel rendering (redesigned: cards, stat tiles, price strip chart)

const SEX_CLASS = { [Gender.Male]: 'male', [Gender.Female]: 'female' };
const CONF_LEVEL = { none: 0, low: 1, medium: 2, high: 3 };

let panel = null;
let body = null;
let countPill = null;
let offsetControl = null;
let lastRender = '';

// "Price vs recommended  [-]  -10%  [+]": one global offset in 5% steps;
// click the value to go back to 0.
function buildOffsetControl() {
    const value = h('div.PZ2QoL_segItem.PZ2QoL_offsetValue', { title: 'Reset to the recommended price', onClick: () => setPriceOffset(0) });
    const less = h('div.PZ2QoL_segItem', { text: '−', title: `${Math.round(OFFSET_STEP * 100)}% lower`, onClick: () => setPriceOffset(priceOffset - OFFSET_STEP) });
    const more = h('div.PZ2QoL_segItem', { text: '+', title: `${Math.round(OFFSET_STEP * 100)}% higher`, onClick: () => setPriceOffset(priceOffset + OFFSET_STEP) });
    const node = h('div.PZ2QoL_segmented.PZ2QoL_offset', { title: 'Applied to every recommended price, including the prices the lister lists at. Under sells faster, over earns more.' },
        h('div.PZ2QoL_segLabel', { text: 'Price vs recommended' }), less, value, more);
    node.__update = () => {
        setText(value, offsetLabel(priceOffset) || '±0%');
        setClass(value, 'on', true);
        setClass(value, 'under', priceOffset < 0);
        setClass(value, 'over', priceOffset > 0);
        setClass(less, 'disabled', priceOffset <= -OFFSET_LIMIT);
        setClass(more, 'disabled', priceOffset >= OFFSET_LIMIT);
    };
    node.__update();
    return node;
}

function buildPanel() {
    countPill = h('div.PZ2QoL_pill.subtle');
    offsetControl = buildOffsetControl();
    body = h('div.PZ2QoL_listerBody');
    panel = h('div.PZ2QoL_card.PZ2QoL_lister', null,
        h('div.PZ2QoL_cardHeader', null,
            icon('IconTrade', 'brown', 'lg'),
            h('div.PZ2QoL_cardTitles', null,
                h('div.PZ2QoL_cardTitle', { text: 'Market lister' }),
                h('div.PZ2QoL_cardSubtitle', { text: 'Prices from Conservation Credit listings you have seen on the Market and in your History' })),
            h('div.PZ2QoL_flex1'),
            offsetControl,
            countPill),
        body);
    document.body.appendChild(panel);
}

function statTile(sexLabel, cls, g) {
    const has = g && g.count;
    return h(`div.PZ2QoL_statTile.${cls}${has ? '' : '.empty'}`, null,
        h('div.PZ2QoL_statTileHead', null, h(`div.PZ2QoL_sexDot.${cls}`, { text: sexLabel }), h('div.PZ2QoL_statTileLabel', { text: has ? `${g.count} listed` : 'none listed' })),
        h('div.PZ2QoL_statTileValue', { text: has ? fmtInt(g.median) : '–' }),
        h('div.PZ2QoL_statTileSub', { text: has ? `${fmtInt(g.min)}–${fmtInt(g.max)} CC · gene ${g.medianScore ?? '–'}` : 'no data yet' }));
}

// Horizontal strip: every listing of the species as a dot by price, plus
// the game's own value and our recommendation.
function priceStrip(species, book, advice) {
    const live = book.filter(l => l.species == species && l.isCC && l.price > 0 && l.source != 'history');
    const values = live.map(l => l.price);
    if (advice.price > 0) values.push(advice.price);
    // the game's value only joins the scale when it is near the market;
    // an outlier would squash every dot into one corner
    const lo0 = Math.min(...values);
    const hi0 = Math.max(...values);
    const gameOnScale = advice.gameValue > 0 && (values.length == 0 || (advice.gameValue >= lo0 * 0.5 && advice.gameValue <= hi0 * 1.5));
    if (gameOnScale) values.push(advice.gameValue);
    if (values.length < 2) return null;
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi - lo < 1) { lo *= 0.9; hi *= 1.1; }
    const pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;
    const x = p => `${((p - lo) / (hi - lo) * 100).toFixed(2)}%`;
    const compIds = new Set(advice.comps.list.map(l => l.id));
    const track = h('div.PZ2QoL_stripTrack');
    for (const l of live) {
        track.appendChild(h(`div.PZ2QoL_stripDot.${SEX_CLASS[l.gender] || 'other'}${compIds.has(l.id) ? '.comp' : ''}`, {
            style: { left: x(l.price) },
            title: `${SEX[l.gender] || ''} gene ${l.score ?? '–'} · ${fmtInt(l.price)} CC`,
        }));
    }
    if (gameOnScale) {
        track.appendChild(h('div.PZ2QoL_stripMark.game', { style: { left: x(advice.gameValue) }, title: `Game value ${fmtInt(advice.gameValue)} CC` }));
    }
    if (advice.price > 0) {
        track.appendChild(h('div.PZ2QoL_stripMark.rec', { style: { left: x(advice.price) }, title: `Recommended ${fmtInt(advice.price)} CC` },
            h('div.PZ2QoL_stripFlag', { text: fmtInt(advice.price) })));
    }
    return h('div.PZ2QoL_strip', null,
        track,
        h('div.PZ2QoL_stripAxis', null,
            h('div', { text: `${fmtInt(lo)} CC` }),
            h('div.PZ2QoL_stripLegend', null,
                h('div.PZ2QoL_legendItem.male', { text: '♂' }),
                h('div.PZ2QoL_legendItem.female', { text: '♀' }),
                h('div.PZ2QoL_legendItem.game', { text: gameOnScale || !(advice.gameValue > 0) ? 'game value' : `game value ${fmtInt(advice.gameValue)} (off scale)` }),
                h('div.PZ2QoL_legendItem.rec', { text: 'recommended' })),
            h('div', { text: `${fmtInt(hi)} CC` })));
}

function confidenceMeter(conf) {
    const level = CONF_LEVEL[conf] ?? 0;
    return h('div.PZ2QoL_confMeter', { title: CONFIDENCE[conf] },
        [1, 2, 3].map(i => h(`div.PZ2QoL_confSeg.lvl${level}${i <= level ? '.on' : ''}`)),
        h('div.PZ2QoL_confLabel', { text: CONFIDENCE[conf] }));
}

function animalColumn(a) {
    const g = geneScore(a);
    return h('div.PZ2QoL_col.animal', null,
        h('div.PZ2QoL_colLabel', { text: 'Selected animal' }),
        h('div.PZ2QoL_animalName', null,
            h(`div.PZ2QoL_sexDot.${SEX_CLASS[a.gender] || 'other'}`, { text: SEX[a.gender] || '·' }),
            h('div.PZ2QoL_animalSpecies', { text: t(a.species) || 'Animal' })),
        h('div.PZ2QoL_animalNick', { text: t(a.name) }),
        h('div.PZ2QoL_geneRow', null,
            h(`div.PZ2QoL_bigScore.${tierOf(g)}`, { text: g == null ? '–' : String(g), title: 'Gene score' }),
            h('div.PZ2QoL_geneList', null, GENES.filter(x => relevantGenes(a).includes(x.id)).map(x => {
                const v = a.genes[x.id];
                const pct = typeof v === 'number' ? Math.round(v * 100) : null;
                return h('div.PZ2QoL_geneLine', { title: `${x.label} ${pct ?? '–'}%` },
                    icon(x.icon, 'brown', 'xs'),
                    h('div.PZ2QoL_geneTrack', null, h(`div.PZ2QoL_geneFill.${tierOf(pct)}`, { style: { width: `${pct ?? 0}%` } })),
                    h('div.PZ2QoL_geneVal', { text: pct == null ? '–' : String(pct) }));
            }))));
}

function marketColumn(a, book, advice) {
    const s = speciesMarketSummary(a.species, book);
    const closest = advice.comps.list.slice()
        .sort((x, y) => Math.abs((x.score ?? 0) - (advice.score ?? 0)) - Math.abs((y.score ?? 0) - (advice.score ?? 0)))
        .slice(0, 6);
    return h('div.PZ2QoL_col.market', null,
        h('div.PZ2QoL_colLabel', { text: `Live market · ${t(a.species)}` }),
        h('div.PZ2QoL_tiles', null,
            statTile('♂', 'male', s.male),
            statTile('♀', 'female', s.female),
            s.juvenile.count ? statTile('juv', 'juvenile', s.juvenile) : null,
            s.history.count ? statTile('you', 'history', s.history) : null),
        priceStrip(a.species, book, advice) || h('div.PZ2QoL_emptyNote', { text: 'No prices recorded for this species yet. Use “Check market prices”.' }),
        closest.length ? h('div.PZ2QoL_compRow', null,
            h('div.PZ2QoL_compLabel', { text: 'Closest' }),
            closest.map(c => h(`div.PZ2QoL_compChip.${SEX_CLASS[c.gender] || 'other'}`, { title: `${SEX[c.gender] || ''} gene ${c.score ?? '–'}` },
                h('span.PZ2QoL_compGene', { text: `G${c.score ?? '–'}` }),
                h('span', { text: fmtInt(c.price) })))) : null);
}

function runBlock() {
    if (!run) return null;
    const processed = run.done + run.skipped.length;
    const pct = run.total ? Math.round(processed / run.total * 100) : 0;
    const state = !run.finished ? 'running' : run.stopped ? 'stopped' : 'done';
    return h(`div.PZ2QoL_run.${state}`, null,
        h('div.PZ2QoL_runHead', null,
            h('div.PZ2QoL_runTitle', { text: state == 'running' ? 'Listing…' : state == 'stopped' ? 'Stopped' : 'Finished' }),
            h('div.PZ2QoL_flex1'),
            h('div.PZ2QoL_pill.ok', { text: `${run.done} listed` }),
            run.skipped.length ? h('div.PZ2QoL_pill.warn', { text: `${run.skipped.length} skipped` }) : null),
        h('div.PZ2QoL_progress', null, h('div.PZ2QoL_progressFill', { style: { width: `${pct}%` } })),
        h('div.PZ2QoL_listerStatus.clamp', { text: run.status, title: run.status }),
        run.skipped.slice(-2).map(r => h('div.PZ2QoL_runSkip', { text: `Skipped · ${r}`, title: r })));
}

function recColumn(keys, single, advice) {
    const busy = run && !run.finished;
    const col = h('div.PZ2QoL_col.rec');
    if (single) {
        col.appendChild(h('div.PZ2QoL_colLabel', { text: advice.offset ? `Recommended price ${offsetLabel(advice.offset)}` : 'Recommended price' }));
        col.appendChild(h(`div.PZ2QoL_recPrice.conf_${advice.confidence}`, null,
            icon('Icon_ConservationCredits', 'none', 'md'),
            h('div.PZ2QoL_listerRecPrice', { text: advice.price > 0 ? `${fmtInt(advice.price)} CC` : 'No recommendation' }),
            advice.offset && advice.price > 0 && advice.basePrice != advice.price
                ? h('div.PZ2QoL_recBase', { text: `${fmtInt(advice.basePrice)} before ${offsetLabel(advice.offset)}`, title: 'Recommended price before your offset' }) : null));
        col.appendChild(confidenceMeter(advice.confidence));
        col.appendChild(h('div.PZ2QoL_recWhy', { text: advice.reason }));
    }
    else {
        const total = sellableKeys(keys).map(k => adviceFor(animalForKey(k), {})).reduce((sum, x) => sum + (x.price > 0 ? x.price : 0), 0);
        col.appendChild(h('div.PZ2QoL_colLabel', { text: `${keys.length} animals selected${priceOffset ? ` · prices ${offsetLabel(priceOffset)}` : ''}` }));
        col.appendChild(h('div.PZ2QoL_recPrice.total', null,
            icon('Icon_ConservationCredits', 'none', 'sm'),
            h('div.PZ2QoL_listerRecPrice', { text: `≈ ${fmtInt(total)} CC total` })));
        if (!run) col.appendChild(h('div.PZ2QoL_recWhy', { text: "Each animal is priced with the game's own limits when it is listed. Animals the game can't trade (e.g. juveniles) are skipped." }));
    }
    const actions = h('div.PZ2QoL_actions');
    if (busy) {
        actions.appendChild(h('div.PZ2QoL_btn.negative', { onClick: () => stopRun() }, icon('Icon_Close', 'white', 'sm'), h('span', { text: 'Stop' })));
    }
    else {
        const n = single ? keys.length : sellableKeys(keys).length;
        const onMarket = keys.length - (single ? keys.length : n);
        const label = !single ? `Sell ${n} at recommended prices`
            : (advice && advice.confidence == 'none' ? 'Sell at game price' : 'Sell at recommended price');
        const sell = h('div.PZ2QoL_btn.positive', { onClick: () => sellAtRecommendedPrice(keys) }, icon('IconTrade', 'white', 'sm'), h('span', { text: label }));
        if (single && single.auctionTimerSeconds > 0) {
            sell.classList.add('disabled');
            sell.title = 'Already on the market';
        }
        if (!single && onMarket > 0) sell.title = `${onMarket} of the selected animals are already on the market and are left out`;
        if (!single && n == 0) sell.classList.add('disabled');
        const checkingAll = isMultiCheckBusy();
        if (checkingAll || isPeekBusy()) {
            sell.classList.add('disabled');
            sell.title = 'Wait for the market check to finish';
        }
        actions.appendChild(sell);
        if (!single) actions.appendChild(multiCheckButton(keys));
        if (single) {
            const known = countForSpecies(single.species);
            const checking = isPeekBusy();
            const check = h('div.PZ2QoL_btn', { onClick: () => checkMarketFor(single.species), title: "Loads this species' current Market listings in the background; the screen stays on Animal Storage" },
                icon('IconSearch', 'brown', 'sm'),
                h('span', { text: checking ? 'Checking market…' : known ? `Refresh prices (${known} known)` : 'Check market prices' }));
            if (checking) check.classList.add('disabled');
            actions.appendChild(check);
        }
    }
    col.appendChild(actions);
    if (single && peek && peek.species == single.species && peek.message) {
        col.appendChild(h(`div.PZ2QoL_peekStatus.${peek.state}`, { text: peek.message, title: peek.message }));
    }
    if (!single) {
        const status = multiCheckStatus();
        if (status) col.appendChild(status);
    }

    const rb = runBlock();
    if (rb) col.appendChild(rb);
    return col;
}

// The selected species, most-selected first (the order they are checked in).
function speciesInOrder(keys) {
    const n = new Map();
    for (const k of keys) {
        const sp = animalForKey(k).species;
        if (sp) n.set(sp, (n.get(sp) || 0) + 1);
    }
    return Array.from(n.keys()).sort((x, y) => n.get(y) - n.get(x));
}

// "Refresh prices" for every selected species (under Sell), or Stop.
function multiCheckButton(keys) {
    if (isMultiCheckBusy()) {
        return h('div.PZ2QoL_btn.negative', { onClick: () => stopMultiCheck(), title: 'Stops after the species being checked now' },
            icon('Icon_Close', 'white', 'sm'), h('span', { text: 'Stop checking' }));
    }
    const species = speciesInOrder(keys);
    const button = h('div.PZ2QoL_btn', { onClick: () => checkMarketForAll(species), title: "Loads each selected species' Market listings (all pages) in the background, one species after another; the screen stays on Animal Storage" },
        icon('IconSearch', 'brown', 'sm'),
        h('span', { text: `Refresh prices (${species.length} species)` }));
    if (isPeekBusy() || (run && !run.finished)) button.classList.add('disabled');
    return button;
}

// How the multi-species check is going.
function multiCheckStatus() {
    if (!peekAll || !peekAll.message) return null;
    const state = !peekAll.finished ? 'reading' : peekAll.failed.length ? 'failed' : 'done';
    const detail = !peekAll.finished && peek && peek.message ? ` ${peek.message}` : '';
    return h(`div.PZ2QoL_peekStatus.${state}`, { text: peekAll.message + detail, title: peekAll.message + detail });
}

// Big selections (30+ animals) stay compact: a per-species summary on top,
// the individual animals in a scrolling table underneath, worst value
// (no price) last so nothing important hides below the fold.
function multiColumn(keys) {
    const rows = keys.map(k => {
        const a = animalForKey(k);
        return { a, adv: adviceFor(a, {}), g: geneScore(a) };
    });
    const groups = new Map();
    for (const r of rows) {
        const key = r.a.species || '?';
        let grp = groups.get(key);
        if (!grp) {
            grp = { species: key, n: 0, males: 0, females: 0, total: 0, scores: [] };
            groups.set(key, grp);
        }
        grp.n++;
        if (r.a.gender == Gender.Male) grp.males++;
        if (r.a.gender == Gender.Female) grp.females++;
        if (r.adv.price > 0) grp.total += r.adv.price;
        if (r.g != null) grp.scores.push(r.g);
    }
    const groupList = Array.from(groups.values()).sort((x, y) => y.n - x.n);
    const shownGroups = groupList.slice(0, 4);
    rows.sort((x, y) => (y.adv.price > 0) - (x.adv.price > 0) || (y.g ?? -1) - (x.g ?? -1));
    return h('div.PZ2QoL_col.multi', null,
        h('div.PZ2QoL_colLabel', { text: `Selection · ${keys.length} animals · ${groups.size} species` + (groupList.length > shownGroups.length ? ` (top ${shownGroups.length} shown)` : '') }),
        h('div.PZ2QoL_groupRow', null,
            shownGroups.map(grp => {
                const avg = grp.scores.length ? Math.round(grp.scores.reduce((s, v) => s + v, 0) / grp.scores.length) : null;
                return h('div.PZ2QoL_groupChip', { title: `${t(grp.species)}: ${grp.n} selected, average gene ${avg ?? '–'}, about ${fmtInt(grp.total)} CC` },
                    h('div.PZ2QoL_groupName', { text: t(grp.species) }),
                    h('div.PZ2QoL_groupMeta', null,
                        h('span.PZ2QoL_groupCount', { text: `×${grp.n}` }),
                        grp.males ? h('span.male', { text: `${grp.males}♂` }) : null,
                        grp.females ? h('span.female', { text: `${grp.females}♀` }) : null,
                        h(`span.PZ2QoL_miniScore.${tierOf(avg)}`, { text: avg == null ? '–' : String(avg) }),
                        h('span.PZ2QoL_groupTotal', { text: `≈${fmtInt(grp.total)}` })));
            }),
            null),
        h('div.PZ2QoL_tableScroll', null, rows.map(({ a, adv, g }) =>
            h('div.PZ2QoL_tableRow', null,
                h(`div.PZ2QoL_sexDot.${SEX_CLASS[a.gender] || 'other'}`, { text: SEX[a.gender] || '·' }),
                h('div.PZ2QoL_tableName', { text: `${t(a.species)} · ${t(a.name)}` }),
                h(`div.PZ2QoL_miniScore.${tierOf(g)}`, { text: g == null ? '–' : String(g) }),
                h(`div.PZ2QoL_tablePrice.conf_${adv.confidence}`, { text: adv.price > 0 ? `${fmtInt(adv.price)} CC` : '–', title: CONFIDENCE[adv.confidence] })))));
}

function renderPanel(force) {
    const keys = selectedKeys().filter(k => animalForKey(k).id != undefined);
    const book = getPriceBook();
    const signature = JSON.stringify([keys, book.length, run && [run.status, run.done, run.skipped.length, run.finished], enabled, isFranchise(), priceOffset, peek && [peek.state, peek.message], peekAll && [peekAll.message, peekAll.finished, peekAll.stopRequested]]);
    if (offsetControl) offsetControl.__update();
    if (!force && signature == lastRender) return;
    lastRender = signature;
    clear(body);
    setText(countPill, `${fmtInt(book.filter(l => l.isCC).length)} prices recorded`);

    if (!isFranchise()) {
        body.appendChild(h('div.PZ2QoL_empty', null, icon('IconInformation', 'brown', 'lg'), h('div.PZ2QoL_listerMsg', { text: 'Listing animals is only available in Franchise mode.' })));
        return;
    }
    if (keys.length == 0 && !(run && !run.finished)) {
        body.appendChild(h('div.PZ2QoL_empty', null, icon('IconInformation', 'brown', 'lg'),
            h('div.PZ2QoL_listerMsg', { text: 'Select an animal, or tick several, to see live market prices and a recommended price.' })));
        const rb = runBlock();
        if (rb) body.appendChild(rb);
        return;
    }
    const row = h('div.PZ2QoL_cols');
    if (keys.length == 1) {
        const a = animalForKey(keys[0]);
        const advice = adviceFor(a, tradeLimits());
        row.appendChild(animalColumn(a));
        row.appendChild(marketColumn(a, book, advice));
        row.appendChild(recColumn(keys, a, advice));
    }
    else {
        row.appendChild(multiColumn(keys));
        row.appendChild(recColumn(keys, null, null));
    }
    body.appendChild(row);
}

let prewarmed = false;
function place() {
    if (!prewarmed) {
        // bind the collections early so they are filled before the first
        // click (the DataStore is not ready while modules are loading)
        try {
            childrenOf(SPECIES_LIST);
            childrenOf(STORAGE_LIST);
            prewarmed = true;
        }
        catch (e) {
            // try again next tick
        }
    }
    const anchor = visibleElement('.AnimalMarketStorage_header');
    if (!enabled || !anchor) {
        if (panel) panel.style.display = 'none';
        return;
    }
    if (!panel) buildPanel();
    // sits directly under the storage toolbar, same width
    const bar = document.querySelector('.PZ2QoL_bar.storage');
    const barVisible = bar && bar.style.display != 'none';
    const r = barVisible ? bar.getBoundingClientRect() : anchor.getBoundingClientRect();
    panel.style.display = 'flex';
    panel.style.left = `${Math.round(r.left)}px`;
    panel.style.top = `${Math.round(r.bottom + 8)}px`;
    panel.style.width = `${Math.round(r.width)}px`;
    renderPanel(false);
}

export function installLister() {
    document.body.classList.toggle('PZ2QoL_listerOn', enabled);
    onRunChanged(() => panel && renderPanel(true));
    onPriceBookChanged(() => panel && renderPanel(true));
    onMarketCheckChanged(() => panel && renderPanel(true));
    if (typeof engine !== 'undefined') engine.on('PZ2QoL_MarketPeekState', (state, detail) => onPeekState(state, detail));
    onListerSettingChanged(() => {
        lastRender = '';
        place();
    });
    // Only positions and refreshes the panel; it never starts a listing.
    setInterval(() => {
        try {
            place();
        }
        catch (e) {
            reportError('ui', 'Lister panel failed', e, { silent: true });
        }
    }, 300);
}
