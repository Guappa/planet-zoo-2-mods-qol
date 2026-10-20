// "Bring to the trade centre": the pure parts, no DOM and no engine, so node
// tests can run them (tests/storagefetch.test.mjs). See storagefetch.js for
// the runtime, pz2qol.storagefetch.lua / pz2qol.storagesend.lua for Lua and
// docs/PLAN-storage-to-trade-centre.md for the design.
//
//  1. Species board (park): one click asks Lua to open Animal Storage for the
//     species (PZ2QoL_FetchStart), with the park's own animals of it so the
//     hub never sends one that is already here.
//  2. Animal Storage (hub): the species' rows are picked (pickRows), ticked
//     and sent with the game's own Send to Zoo, once.
//  3. Back in the zoo: each arrival goes to the trade centre, ONE at a time
//     (runTradeArrivals), confirmed by the game, with the player's pause.
//     An animal already in the trade centre costs nothing. Failures are
//     skipped and the run carries on; only Stop ends it.
import { normSpecies } from './scores.js';

const CONFIRM_TIMEOUT_MS = 12000;
const CONFIRM_POLL_MS = 600;
const BUSY_WAIT_MS = 10000;
const BUSY_POLL_MS = 500;
export const ERROR_PAUSE_MS = 8000; // after a refused or unconfirmed request online
export const COUNTDOWN_MS = 3000;   // the hub card's last chance to cancel
export const TICK_WAIT_MS = 3000;   // the game ticks the rows within this
// "Bring all": every species in storage at once (the developer, 2026-10-19).
// Carried as the species through Lua and the hub page.
export const ALL_SPECIES = '*';

export function isAllSpecies(species) {
    return String(species == null ? '' : species) === ALL_SPECIES;
}

// What the cards call the animals: "Okapi" or "stored animals".
export function fetchName(species, nameOf = x => x) {
    return isAllSpecies(species) ? 'stored animals' : nameOf(species);
}

// ------------------------------------------------------------- exclusion

// A name as both sides compare it (Lua keeps only these characters too).
export function cleanName(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 _.-]/g, '').replace(/\s+/g, ' ').trim();
}

// The park's own animals of the species (every species for ALL_SPECIES) as
// the exclude list Lua carries to the hub: "g:<guid>" and "n:<sex>:<name>"
// items, comma separated.
export function excludeList(animals, species) {
    const all = isAllSpecies(species);
    const want = normSpecies(species);
    const out = [];
    for (const a of animals || []) {
        if (!a || (!all && normSpecies(a.species) !== want)) continue;
        if (a.guid != null && /^[\w.-]+$/.test(String(a.guid))) out.push('g:' + String(a.guid));
        const n = cleanName(a.name);
        if (n) out.push(`n:${Number(a.sex) || 0}:${n}`);
    }
    return Array.from(new Set(out)).join(',');
}

export function parseExclude(csv) {
    const guids = new Set();
    const names = new Set();
    for (const raw of String(csv == null ? '' : csv).split(',')) {
        const s = raw.trim();
        if (s.startsWith('g:') && s.length > 2) guids.add(s.slice(2));
        else if (/^n:\d+:./.test(s)) names.add(s.slice(2));
    }
    return { guids, names };
}

// ------------------------------------------------------------ hub: rows

// Adults first (fertile ones, then old), then young; then by name.
function rank(r) {
    const m = Number(r.maturity);
    if (m === 0) return 2;
    if (m >= 4 && m <= 6) return 1;
    return 0;
}

// rows: [{ id, key, name, species, sex, maturity, isShoal, isMoving,
//   auctionTimerSeconds, guid? }] (the storage list, any species).
// o: { species (ALL_SPECIES: every one), room (-1 or null: unknown), exclude: parseExclude() }.
// -> { picked, left (no room), shoals, moving, listed, here }
export function pickRows(rows, o = {}) {
    const all = isAllSpecies(o.species);
    const want = normSpecies(o.species);
    const ex = o.exclude || { guids: new Set(), names: new Set() };
    const out = { picked: [], left: [], shoals: [], moving: [], listed: [], here: [] };
    const ok = [];
    for (const r of rows || []) {
        if (!r || r.id == null || r.key == null || (!all && normSpecies(r.species) !== want)) continue;
        if (r.isShoal) out.shoals.push(r);
        else if (r.isMoving) out.moving.push(r);
        else if (r.auctionTimerSeconds != undefined && r.auctionTimerSeconds > 0) out.listed.push(r);
        else if ((r.guid != null && ex.guids.has(String(r.guid))) || ex.names.has(`${Number(r.sex) || 0}:${cleanName(r.name)}`)) out.here.push(r);
        else ok.push(r);
    }
    ok.sort((a, b) => rank(a) - rank(b) || cleanName(a.name).localeCompare(cleanName(b.name)) || String(a.id).localeCompare(String(b.id)));
    // null / undefined / -1: room unknown, no cap
    const room = o.room == null || o.room === '' ? NaN : Number(o.room);
    const cap = Number.isFinite(room) && room >= 0 ? room : Infinity;
    out.picked = ok.slice(0, cap);
    out.left = ok.slice(cap);
    return out;
}

export function sameSpecies(a, b) {
    const x = normSpecies(a);
    return !!x && x === normSpecies(b);
}

export function sameKeys(a, b) {
    const x = new Set((a || []).map(String));
    const y = new Set((b || []).map(String));
    if (x.size !== y.size) return false;
    for (const k of x) if (!y.has(k)) return false;
    return true;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The hub card's second line: "7 animals: 5 adults, 2 young · room for 9".
export function pickedText(p, room) {
    const n = p.picked.length;
    const young = p.picked.filter(r => Number(r.maturity) === 0).length;
    const parts = [`${plural(n, 'animal', 'animals')}${young && young < n ? `: ${n - young} adult${n - young === 1 ? '' : 's'}, ${young} young` : young ? ', all young' : ''}`];
    if (Number.isFinite(Number(room)) && Number(room) >= 0) parts.push(`room for ${room}`);
    return parts.join(' · ');
}

// Lines about the rows that stay (empty when none).
export function leftLines(p) {
    const out = [];
    if (p.left.length) {
        const names = p.left.slice(0, 4).map(r => r.name || 'an animal').join(', ');
        out.push(`No room for ${p.left.length} (adults went first): ${names}${p.left.length > 4 ? ', …' : ''} ${p.left.length === 1 ? 'stays' : 'stay'} in storage.`);
    }
    if (p.here.length) out.push(`${plural(p.here.length, 'is', 'are')} already in this zoo.`);
    if (p.listed.length) out.push(`${plural(p.listed.length, 'is', 'are')} on the market.`);
    if (p.moving.length) out.push(`${plural(p.moving.length, 'is', 'are')} already on the way somewhere.`);
    if (p.shoals.length) out.push(`${plural(p.shoals.length, 'shoal stays', 'shoals stay')} (send those yourself).`);
    return out;
}

// ------------------------------------------------------------ park: button

// '' when the button can be used, else why not.
// s: { tradeBlock (canOpenTrade() text), hasTradeCentre, tcNow, tcMax, adults (null: unknown) }
export function fetchBlockReason(s = {}) {
    if (s.tradeBlock) return s.tradeBlock;
    if (s.hasTradeCentre === false) return 'Build a trade centre first';
    if (Number.isFinite(s.tcNow) && Number.isFinite(s.tcMax) && s.tcNow >= s.tcMax) {
        return s.mode === 'franchise' ? `Your storage is full (all zoos, ${s.tcNow}/${s.tcMax})` : `The trade centre is full (${s.tcNow}/${s.tcMax})`;
    }
    return '';
}

// The note under the button.
export function fetchNote(s = {}) {
    const sp = s.speciesName || 'this species';
    if (s.all) {
        const where = s.mode === 'franchise' ? 'Storage, all zoos' : 'Trade centre';
        return Number.isFinite(s.tcNow) && Number.isFinite(s.tcMax) ? `Every species · ${where} ${s.tcNow}/${s.tcMax}` : 'Every species in your Animal Storage';
    }
    // Franchise: the trade centre's count is the whole account's storage (all
    // zoos; the developer saw 90/250, 2026-10-18)
    const where = s.mode === 'franchise' ? 'storage, all zoos' : 'trade centre';
    const tc = Number.isFinite(s.tcNow) && Number.isFinite(s.tcMax) ? ` · ${where} ${s.tcNow}/${s.tcMax}` : '';
    if (s.adults == null) return `${sp} in storage: count unknown here${tc}`;
    if (s.adults === 0) return `No adult ${sp} in storage (young may be)${tc}`;
    return `${plural(s.adults, 'adult', 'adults')} in storage (+ any young)${tc}`;
}

export const START_ERRORS = Object.freeze({
    notradecentre: 'Build a trade centre first',
    full: 'The trade centre is full',
    nobuilding: 'Build a trade centre to use Market & Storage',
    nopark: 'Only while a zoo is running',
    nohub: "The game's hub could not be reached",
    nohud: "The game's hub could not be opened from here",
    badspecies: 'This species has no name the hub knows',
    noanswer: 'The game did not answer',
    busy: 'Already opening the hub…',
});

// --------------------------------------------------------- park: arrivals

// Is the animal in the trade centre, or on its way (the game confirmed it)?
export function tradeConfirmed(f) {
    return !!f && !f.error && !f.gone && (f.lt === 'trade' || f.moving === true);
}

// Why an arrival can't be sent ('' when it can). Already in the trade
// centre is not a skip (see runTradeArrivals).
export function arrivalSkip(f) {
    if (!f) return 'the game did not answer';
    if (f.error) return f.error === 'nopark' ? 'no park is running' : String(f.error);
    if (f.gone) return 'no longer in the zoo';
    if (f.alive === false) return 'no longer alive';
    if (f.moving) return 'already on its way somewhere';
    if (f.tc === '') return 'this zoo has no trade centre';
    if (Number.isFinite(f.tcNow) && Number.isFinite(f.tcMax) && f.tcNow >= f.tcMax) return 'the trade centre is full';
    return '';
}

// The run. deps:
//   facts(id)       -> Promise<facts|null>   (PZ2QoL_SendFacts)
//   move(id)        -> Promise<{ ok, detail }> (ONE request: "trade:arrival")
//   sleep(ms)       -> Promise (should end early on Stop)
//   paceMs()        -> pause after each request (the player's 'moves' pace)
//   online          -> true in a Franchise (or unknown-mode) zoo
//   isStopped()     -> the player pressed Stop
//   onUpdate(state) -> progress
// Log entries: { id, name, ok, already?, reason?, left? } (left: the game's
// own Move screen can still take it).
export async function runTradeArrivals(ids, deps) {
    const d = Object.assign({ online: false, isStopped: () => false, onUpdate: () => {}, paceMs: () => 1500, now: () => Date.now() }, deps);
    const state = { running: true, total: ids.length, index: 0, current: null, log: [], finished: false, stopped: false };
    const update = patch => {
        Object.assign(state, patch);
        try {
            d.onUpdate(Object.assign({}, state, { log: state.log.slice() }));
        }
        catch (e) {
            // progress display must never stop the run
        }
    };
    const skip = (id, f, reason, left) => state.log.push({ id, name: f && f.name || '', ok: false, reason, left: !!left });
    update({});
    for (let i = 0; i < ids.length; i++) {
        if (d.isStopped()) {
            state.stopped = true;
            break;
        }
        const id = String(ids[i]);
        update({ index: i + 1, current: { id, name: '' } });
        let f = await d.facts(id);
        if (f && !f.error && !f.gone && f.lt === 'trade') {
            // already waiting there: nothing to send, no pause
            state.log.push({ id, name: f.name || '', ok: true, already: true });
            update({});
            continue;
        }
        // the game is still busy with a server request: wait for it first
        const busySince = d.now();
        while (f && f.busy && d.now() - busySince < BUSY_WAIT_MS && !d.isStopped()) {
            await d.sleep(BUSY_POLL_MS);
            f = await d.facts(id);
        }
        if (d.isStopped()) {
            state.stopped = true;
            break;
        }
        const reason = arrivalSkip(f);
        if (reason) {
            // nothing was sent to the game: no pause needed
            skip(id, f, reason, reason === 'the trade centre is full' || reason === 'the game did not answer');
            update({});
            continue;
        }
        update({ current: { id, name: f.name || '' } });
        let r;
        try {
            r = await d.move(id);
        }
        catch (e) {
            r = { ok: false, detail: String(e && e.message || e) };
        }
        if (!r || !r.ok) {
            const detail = String((r && r.detail) || 'the game refused').replace(/\.$/, '');
            skip(id, f, /refus/i.test(detail) ? detail.charAt(0).toLowerCase() + detail.slice(1) : `refused: ${detail}`, true);
            update({});
            await d.sleep(d.online ? Math.max(ERROR_PAUSE_MS, d.paceMs()) : d.paceMs());
            continue;
        }
        const since = d.now();
        let ok = false;
        while (d.now() - since < CONFIRM_TIMEOUT_MS) {
            if (tradeConfirmed(await d.facts(id))) {
                ok = true;
                break;
            }
            await d.sleep(CONFIRM_POLL_MS);
        }
        if (!ok) {
            skip(id, f, 'not confirmed by the game in time', true);
            update({});
            await d.sleep(d.online ? Math.max(ERROR_PAUSE_MS, d.paceMs()) : d.paceMs());
            continue;
        }
        state.log.push({ id, name: f.name || '', ok: true });
        update({});
        await d.sleep(d.paceMs());
    }
    if (d.isStopped()) state.stopped = true;
    update({ running: false, finished: true, current: null });
    return Object.assign({}, state, { log: state.log.slice() });
}

// The end of a run: { total, already, sent, skipped, reasons, leftIds }.
// leftIds: animals the game's own Move screen can still place (refused,
// unconfirmed, no room, and the ones a Stop left untried).
export function tradeSummary(st, ids) {
    const log = (st && st.log) || [];
    const reasons = new Map();
    let already = 0, sent = 0;
    const tried = new Set();
    const left = [];
    for (const e of log) {
        tried.add(String(e.id));
        if (e.ok) {
            if (e.already) already++;
            else sent++;
        }
        else {
            reasons.set(e.reason, (reasons.get(e.reason) || 0) + 1);
            if (e.left) left.push(String(e.id));
        }
    }
    for (const id of ids || []) if (!tried.has(String(id))) left.push(String(id));
    const total = st && Number.isFinite(st.total) ? st.total : log.length;
    return {
        total, already, sent, skipped: log.length - already - sent, untried: total - log.length,
        reasons: Array.from(reasons, ([text, n]) => ({ text, n })).sort((a, b) => b.n - a.n || a.text.localeCompare(b.text)),
        leftIds: left,
    };
}

export function tradeSummaryText(s) {
    const parts = [`${s.already + s.sent} of ${s.total} in or on the way to the trade centre`];
    if (s.skipped) parts.push(`skipped ${s.skipped}`);
    if (s.untried) parts.push(`${s.untried} not tried (stopped)`);
    return parts.join(' · ');
}
