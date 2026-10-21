// A reprice run (the Market desk's My listings, docs/DESIGN-reprice.md):
// the game has no "change price", so a listing is taken off the market and
// listed again at the new price.
//
//   1 off       every chosen listing taken off, one at a time, each
//               confirmed by its storage row (the engine's "unlist" job)
//   2 settle    a short wait, so the game has every one back in storage
//   3 relist    the ones that came off, listed again at their new prices
//               (the engine's normal listing job: select, the game's
//               limits, the same-tick checks, confirmed by the row)
//
// Only ever started by the player's click (Reprice, or Relist the ones
// left); one action at a time with the player's pause; a failure skips that
// listing and the run goes on; Stop ends it. A Stop (or anything else that
// ends the run early) never lists anything by itself: the listings already
// off are kept in the run and shown with a "List them again" button. The run
// is kept in localStorage (the session) so a reload or reopened desk shows
// what is still off the market.
import { ACTIONS, encodeRelistJob, encodeUnlistJob, ledgerPrune, ledgerTake, normalizeAction, runCounts, strandedItems } from '/js/mods/pz2qol/repricecore.js';
import { encodeQuickJob, QUICK_MODES } from '/js/mods/pz2qol/listercore.js';
import { engineCaps, engineRunning, getEngineState, onEngineState, resolveGuids, startEngineRun, stopEngineRun } from '/js/mods/pz2qol/listerlua.js';
import { identityOf, isListingBusy, storageRows } from '/js/mods/pz2qol/lister.js';
import { getPaceMs } from '/js/mods/pz2qol/pace.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { dlog } from '/js/mods/pz2qol/debuglog.js';

const RUN_KEY = 'PZ2QoL.reprice.v1';
const LEDGER_KEY = 'PZ2QoL.listingLedger.v1';
// the wait between taking them off and listing them again (developer: "there
// will be a little delay"); the engine checks each one again anyway
export const SETTLE_MS = 5000;

let run = null;         // { id, phase, items, hours, unlistReq, relistReq, message, stopAsked, startedAt }
let ledger = {};
const listeners = new Set();
let installed = false;

function save() {
    try {
        if (window.localStorage) {
            if (run) window.localStorage.setItem(RUN_KEY, JSON.stringify(run));
            else window.localStorage.removeItem(RUN_KEY);
        }
    }
    catch (e) {
        // session only
    }
}

function saveLedger() {
    try {
        if (window.localStorage) window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
    }
    catch (e) {
        // session only
    }
}

function notify() {
    save();
    listeners.forEach(fn => {
        try {
            fn(run);
        }
        catch (e) {
            // a listener never stops the run
        }
    });
}

export function onRepriceChanged(fn) {
    install();
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function getReprice() {
    install();
    return run;
}

export function getLedger() {
    install();
    return ledger;
}

// The engine requests of the reprice (the desk's Sell view leaves them alone).
export function isRepriceReq(req) {
    return !!run && req != undefined && (String(req) === run.unlistReq || String(req) === run.relistReq);
}

export function repriceActive() {
    return !!run && (run.phase === 'off' || run.phase === 'settle' || run.phase === 'relist' || run.phase === 'quick' || run.phase === 'starting');
}

function install() {
    if (installed) return;
    installed = true;
    try {
        const raw = window.localStorage && window.localStorage.getItem(RUN_KEY);
        if (raw) {
            const r = JSON.parse(raw);
            if (r && Array.isArray(r.items)) {
                run = r;
                // a page that reloaded mid-run: the engine may still be going
                // (its state settles it); a settle or start is not resumed
                if (run.phase === 'settle' || run.phase === 'starting') {
                    run.phase = 'stopped';
                    run.message = 'The page reloaded before the listings were put back.';
                }
            }
        }
        const led = window.localStorage && JSON.parse(window.localStorage.getItem(LEDGER_KEY) || 'null');
        if (led && typeof led === 'object') ledger = ledgerPrune(led);
    }
    catch (e) {
        run = run || null;
    }
    try {
        onEngineState(s => {
            try {
                if (ledgerTake(ledger, s)) {
                    ledgerPrune(ledger);
                    saveLedger();
                }
                takeState(s);
            }
            catch (e) {
                reportError('ui', 'My listings: reading the engine failed', e, { silent: true });
            }
        });
    }
    catch (e) {
        // no engine: nothing to follow
    }
}

// What the engine says about our two jobs.
function takeState(s) {
    if (!run || !s || s.refused) return;
    const req = String(s.req);
    const byGuid = new Map((s.results || []).map(r => [String(r.guid), r]));
    if (req === run.unlistReq && (run.phase === 'off' || run.phase === 'stopped' || run.phase === 'done')) {
        let changed = false;
        for (const i of run.items) {
            const r = byGuid.get(i.guid);
            if (!r) continue;
            const off = r.status;
            const why = r.detail || r.kind || '';
            if (i.off !== off || i.offWhy !== why) {
                i.off = off;
                i.offWhy = why;
                if (off === 'unlisted') {
                    if (r.price > 0) i.old = r.price;
                    i.offAt = Date.now();
                }
                changed = true;
            }
        }
        run.engine = { phase: s.phase, index: s.index, step: s.step, waited: s.waited, total: s.total, mode: s.mode };
        if (run.phase === 'off' && s.phase !== 'running') {
            const c = runCounts(run);
            dlog('reprice', 'off_end', { phase: s.phase, off: c.off, failed: c.offFailed, stop: run.stopAsked || undefined });
            if (run.stopAsked || s.phase !== 'done') {
                run.phase = 'stopped';
                run.message = s.phase === 'closed' ? 'Stopped: Animal Storage was closed.' : run.stopAsked ? 'Stopped by you.' : (s.message || 'Stopped.');
            }
            else if (!c.off) {
                run.phase = 'done';
                run.message = `None came off the market: nothing to ${run.action === 'reprice' || !ACTIONS[run.action] ? 'list again' : ACTIONS[run.action].label.toLowerCase()}.`;
            }
            else settleThenRelist();
            changed = true;
        }
        if (changed || run.phase === 'off') notify();
        return;
    }
    if (req === run.relistReq) {
        let changed = false;
        for (const i of run.items) {
            const r = byGuid.get(i.guid);
            if (!r) continue;
            const why = r.detail || r.kind || '';
            if (i.on !== r.status || i.onWhy !== why) {
                i.on = r.status;
                i.onWhy = why;
                if (r.status === 'listed') {
                    i.listedPrice = r.price > 0 ? r.price : i.next;
                    i.capped = r.capped || null;
                }
                if (r.status === 'traded' || r.status === 'released') i.soldFor = r.price > 0 ? r.price : null;
                changed = true;
            }
        }
        run.engine = { phase: s.phase, index: s.index, step: s.step, waited: s.waited, total: s.total, mode: s.mode };
        if ((run.phase === 'relist' || run.phase === 'quick') && s.phase !== 'running') {
            const c = runCounts(run);
            run.phase = run.stopAsked || s.phase !== 'done' ? 'stopped' : 'done';
            const left = strandedItems(run).length;
            // a quick run stops by itself at anything unexpected: its own reason
            run.message = left ? (run.stopAsked ? 'Stopped by you.' : s.phase === 'closed' ? 'Stopped: Animal Storage was closed.' : s.phase === 'stopped' ? (s.message || 'Stopped.') : '') : '';
            dlog('reprice', 'relist_end', { phase: s.phase, action: run.action, relisted: c.relisted, sold: c.sold, left });
            breadcrumb(left ? 'reprice_left' : 'reprice_done');
            changed = true;
        }
        if (changed || run.phase === 'relist' || run.phase === 'quick') notify();
    }
}

function settleThenRelist() {
    run.phase = 'settle';
    run.settleUntil = Date.now() + SETTLE_MS;
    run.message = 'Letting the game put them back in storage…';
    const id = run.id;
    const go = () => {
        if (!run || run.id !== id || run.phase !== 'settle') return;
        if (run.stopAsked) {
            run.phase = 'stopped';
            run.message = 'Stopped by you.';
            notify();
            return;
        }
        // a market check or other run going: wait for it
        if (isListingBusy() || Date.now() < run.settleUntil) {
            setTimeout(go, 500);
            return;
        }
        if (QUICK_MODES[run.action]) quick(strandedItems(run), { auto: true });
        else relist(strandedItems(run), { auto: true });
    };
    setTimeout(go, 500);
}

// The storage rows of these GUIDs now, by asking the engine about every row
// (keys move when the list is rebuilt).
async function keysFor(guids) {
    const rows = storageRows().filter(a => a && a.id != undefined);
    const ids = await resolveGuids(rows.map(identityOf), { retry: true });
    const want = new Set(guids.map(String));
    const out = new Map();
    for (const [key, g] of ids) if (want.has(String(g))) out.set(String(g), key);
    return out;
}

async function relist(items, { auto = false } = {}) {
    if (!run) return { ok: false, message: 'Nothing to list again.' };
    const id = run.id;
    run.phase = 'relist';
    run.message = '';
    for (const i of items) {
        i.on = 'pending';
        i.onWhy = '';
    }
    notify();
    let keys;
    try {
        keys = await keysFor(items.map(i => i.guid));
    }
    catch (e) {
        keys = new Map();
    }
    if (!run || run.id !== id) return { ok: false };
    const job = encodeRelistJob(items.map(i => Object.assign({}, i, { key: keys.get(i.guid) || i.key })), { paceMs: getPaceMs('lister'), hours: run.hours });
    dlog('reprice', 'relist_start', { auto: auto || undefined, n: job.items.length, asked: items.length, found: keys.size });
    if (!job.items.length) {
        run.phase = 'stopped';
        run.message = "Couldn't find them in Animal Storage to list them again: press Read storage again, then List them again.";
        for (const i of items) {
            i.on = 'skipped';
            i.onWhy = 'not found in storage';
        }
        notify();
        return { ok: false, message: run.message };
    }
    const r = await startEngineRun(job.text);
    if (!run || run.id !== id) return r;
    if (r.ok || r.pending) {
        run.relistReq = String(r.req);
        if (r.pending) run.message = r.message;
    }
    else {
        run.phase = 'stopped';
        run.message = `Listing them again did not start: ${r.message || 'the engine refused'}. They are off the market: List them again.`;
        for (const i of items) {
            i.on = 'skipped';
            i.onWhy = r.message || 'not started';
        }
    }
    notify();
    return r;
}

// Quick trade / Quick release the ones that came off: the desk's own quick
// job (pz2qol.lister.lua: one at a time, the game's flag for the action
// checked on each, confirmed by the row leaving storage; it stops at
// anything unexpected, as every quick run does).
async function quick(items, { auto = false } = {}) {
    if (!run || !QUICK_MODES[run.action]) return { ok: false, message: 'Nothing to send.' };
    const id = run.id;
    const mode = run.action;
    run.phase = 'quick';
    run.message = '';
    for (const i of items) {
        i.on = 'pending';
        i.onWhy = '';
    }
    notify();
    let keys;
    try {
        keys = await keysFor(items.map(i => i.guid));
    }
    catch (e) {
        keys = new Map();
    }
    if (!run || run.id !== id) return { ok: false };
    const job = encodeQuickJob(items.filter(i => keys.has(i.guid)).map(i => ({ guid: i.guid, key: keys.get(i.guid) })), { mode, paceMs: getPaceMs('lister') });
    dlog('reprice', 'quick_start', { auto: auto || undefined, mode, n: job.items.length, asked: items.length, found: keys.size });
    for (const i of items) {
        if (keys.has(i.guid)) continue;
        i.on = 'skipped';
        i.onWhy = 'not found in storage';
    }
    if (!job.items.length) {
        run.phase = 'stopped';
        run.message = "Couldn't find them in Animal Storage: press Read storage again, then try again.";
        notify();
        return { ok: false, message: run.message };
    }
    const r = await startEngineRun(job.text);
    if (!run || run.id !== id) return r;
    if (r.ok || r.pending) {
        run.relistReq = String(r.req);
        if (r.pending) run.message = r.message;
    }
    else {
        run.phase = 'stopped';
        run.message = `${QUICK_MODES[mode].label} did not start: ${r.message || 'the engine refused'}. They are off the market.`;
        for (const i of items) {
            if (i.on !== 'pending') continue;
            i.on = 'skipped';
            i.onWhy = r.message || 'not started';
        }
    }
    notify();
    return r;
}

// Starts a run on the player's listings: items { guid, key, label, species,
// old, next } (next: the new price; for a quick action the price to list it
// again at should it not go, the old one by default). hours 'max' |
// 'default'. action 'reprice' | 'quicktrade' | 'release'.
export async function startReprice(items, { hours = 'max', action = 'reprice' } = {}) {
    install();
    if (repriceActive()) return { ok: false, message: 'A reprice is already going.' };
    if (isListingBusy() || engineRunning()) return { ok: false, message: 'A listing, check or market check is running; reprice when it is done.' };
    const left = run ? strandedItems(run) : [];
    if (left.length) return { ok: false, message: `${left.length} listing${left.length === 1 ? ' is' : 's are'} still off the market from the last reprice: list them again first.` };
    const caps = await engineCaps({ force: true });
    if (!caps || !caps.ok) return { ok: false, message: 'The game-side engine is not available (open Animal Storage).' };
    if (!caps.unlist) return { ok: false, message: "This game's engine can't take listings off the market (an older Main.ovl, or the game's Cancel call is missing)." };
    const job = encodeUnlistJob(items, { paceMs: getPaceMs('lister') });
    if (!job.items.length) return { ok: false, message: 'None of them can be identified in Animal Storage.' };
    run = {
        id: Date.now(),
        phase: 'starting',
        hours: hours === 'default' ? 'default' : 'max',
        action: normalizeAction(action),
        startedAt: Date.now(),
        items: job.items.map(i => ({ guid: String(i.guid), key: i.key, label: i.label || '', species: i.species || '', old: i.old, next: i.next, left: i.left || 0, off: 'pending', offWhy: '', on: '', onWhy: '' })),
        unlistReq: '', relistReq: '', message: '', stopAsked: false,
    };
    breadcrumb('reprice_start');
    dlog('reprice', 'start', { action: run.action, n: run.items.length, hours: run.hours, total: run.items.reduce((n, i) => n + (i.next || 0), 0) });
    notify();
    const r = await startEngineRun(job.text);
    if (r.ok || r.pending) {
        run.unlistReq = String(r.req);
        run.phase = 'off';
        if (r.pending) run.message = r.message;
        notify();
        // an answer that came before the request id was known
        const s = getEngineState();
        if (s && String(s.req) === run.unlistReq) takeState(s);
        return { ok: true, pending: !!r.pending, count: run.items.length, message: r.message };
    }
    run.phase = 'done';
    run.message = r.message || 'The engine refused the run.';
    for (const i of run.items) {
        i.off = 'skipped';
        i.offWhy = 'not started';
    }
    notify();
    return { ok: false, message: run.message };
}

// The ones still off the market: listed again at their new prices (a click).
export async function relistLeft() {
    install();
    if (!run) return { ok: false, message: 'Nothing to list again.' };
    if (repriceActive()) return { ok: false, message: 'The reprice is still going.' };
    if (isListingBusy() || engineRunning()) return { ok: false, message: 'A listing or market check is running; try again when it is done.' };
    const left = strandedItems(run);
    if (!left.length) return { ok: false, message: 'Nothing left to list again.' };
    run.stopAsked = false;
    breadcrumb('reprice_relist_left');
    return relist(left);
}

// Listings the run left off the market that are on the market again (the
// player listed them another way): no longer waiting. listed: guid ->
// { price, left }. Only a new listing counts (more time left than the old
// one had, seen a while after it came off): a storage read from before the
// take-off still shows the old listing.
export function reconcileListed(listed) {
    if (!run || repriceActive()) return false;
    let changed = false;
    const now = Date.now();
    for (const i of strandedItems(run)) {
        const l = listed.get(i.guid);
        if (!l || !(i.offAt > 0) || now - i.offAt < 3000 || !(l.left > (i.left || 0) + 60)) continue;
        i.on = 'listed';
        i.onWhy = 'listed again from the desk';
        i.listedPrice = l.price || i.next;
        changed = true;
    }
    if (changed) notify();
    return changed;
}

// The ones still off the market after a quick run: the quick action again
// (a click), e.g. after the run stopped at something unexpected.
export async function quickLeft() {
    install();
    if (!run || !QUICK_MODES[run.action]) return { ok: false, message: 'Nothing to send.' };
    if (repriceActive()) return { ok: false, message: 'The run is still going.' };
    if (isListingBusy() || engineRunning()) return { ok: false, message: 'A listing or market check is running; try again when it is done.' };
    const left = strandedItems(run);
    if (!left.length) return { ok: false, message: 'Nothing left.' };
    run.stopAsked = false;
    breadcrumb('reprice_quick_left');
    return quick(left);
}

// Changes a stranded listing's new price before it is listed again.
export function setLeftPrice(guid, price) {
    if (!run || repriceActive()) return false;
    const i = run.items.find(x => x.guid === String(guid));
    if (!i || !(price > 0)) return false;
    i.next = Math.round(price);
    notify();
    return true;
}

export function stopReprice() {
    if (!run) return;
    run.stopAsked = true;
    dlog('reprice', 'stop', { phase: run.phase });
    breadcrumb('reprice_stop');
    if (engineRunning()) stopEngineRun();
    if (run.phase === 'settle') {
        run.phase = 'stopped';
        run.message = 'Stopped by you.';
    }
    notify();
}

// Clears a finished run (nothing left off the market).
export function dismissReprice() {
    if (!run || repriceActive() || strandedItems(run).length) return false;
    run = null;
    notify();
    return true;
}

// test hook
export function _resetRepriceForTests() {
    run = null;
    ledger = {};
    save();
    saveLedger();
}
