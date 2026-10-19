// Auto mode's memory for one zoo: each species' settings and schedule, the
// animals to leave alone, what it did and why. Pure, no game imports (Node
// tests). Kept in the zoo's PZ2QoL data in the player save (userstore.js,
// key 'kinAuto'), created the first time the player turns Auto mode on for
// a species.
//
// Entity ids change every time a zoo loads, so everything here is keyed by
// animal GUID, and habitats by name and the game's habitat id.
// ledgerView() turns it into this load's ids for planAutoRun().
//
//   { v: 2,
//     sp: { species: { on, every, step, trade, thin, fill,   settings (every: months)
//                      next,                                 the park calendar month of the next run
//                      last: { real, run, moves, skipped, note } } },
//     pins: { guid: 1 },             hands off (the card menu)
//     manual: { guid: until },       the player moved it (calendar years: months / 12)
//     leave: { guid: 1 },            Auto sent it to the trade centre
//     hist: { guid: [[name, hid, t], ...] }, habitats it left (newest last)
//     fails: { 'guid>dest': [n, realMs, t] },
//     rev: { species: [t, ...] }, stopped: { species: why },
//     log: [entry], run, clock, seq }
// entry: { i, t, real, c (run), sp, g, n, sex, a ('move'|'trade'), f, fh,
//          to, toh, r, st, o ('ok'|'skip'|'wait'), why, u (undone) }
import { TRADE } from './kinboardcore.js';
import { AUTO_LIMITS, normalizeSpecies } from './kinautocore.js';

export const LEDGER_VERSION = 2;
export const LOG_MAX = 120;
// characters of the saved (ASCII) JSON; the player store holds 64 KB for
// every zoo together (habitat assignments included)
export const SAVE_BUDGET = 12000;
export const MAP_MAX = 150;         // animals kept per memory (history, refusals...)

export function emptyLedger() {
    return { v: LEDGER_VERSION, sp: {}, pins: {}, manual: {}, leave: {}, hist: {}, fails: {}, rev: {}, stopped: {}, log: [], run: 0, clock: 0, seq: 0 };
}

const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// A saved ledger, checked. Another version starts afresh (never misread;
// version 1 was the unreleased zoo-wide Autopilot).
export function normalizeLedger(raw) {
    const e = emptyLedger();
    if (!raw || typeof raw !== 'object' || raw.v !== LEDGER_VERSION) return e;
    for (const [sp, s] of Object.entries(obj(raw.sp))) {
        const n = normalizeSpecies(s);
        const next = Number(s && s.next);
        n.next = Number.isFinite(next) && next > 0 ? next : 0;
        if (s && s.last && typeof s.last === 'object') n.last = Object.assign({}, s.last);
        e.sp[sp] = n;
    }
    for (const k of ['pins', 'manual', 'leave', 'hist', 'fails', 'rev', 'stopped']) e[k] = Object.assign({}, obj(raw[k]));
    e.log = Array.isArray(raw.log) ? raw.log.filter(x => x && typeof x === 'object').slice(-LOG_MAX) : [];
    e.run = Number(raw.run) || 0;
    e.clock = Number(raw.clock) || 0;
    e.seq = Number(raw.seq) || 0;
    return e;
}

// ------------------------------------------------------------- settings

export function speciesSettings(l, species) {
    return l && l.sp[species] ? l.sp[species] : Object.assign(normalizeSpecies(null), { next: 0 });
}

// Changes a species' settings. Turning it on starts the schedule at once
// (the first run comes as soon as the zoo is settled); a shorter interval
// counts from now (nowMonths: the park calendar, null if not known yet).
export function setSpeciesSettings(l, species, patch, nowMonths = null) {
    const old = l.sp[species] || Object.assign(normalizeSpecies(null), { next: 0 });
    const n = normalizeSpecies(Object.assign({}, old, patch));
    n.next = old.next || 0;
    if (old.last) n.last = old.last;
    if (patch.on === true && !old.on) {
        n.next = 0;
        delete l.stopped[species];
        delete l.rev[species];
    }
    else if (patch.every != null && n.every !== old.every && nowMonths != null) n.next = Math.min(n.next, nowMonths + n.every);
    l.sp[species] = n;
    return n;
}

// Auto mode stopped itself for the species; the player hands it back.
export function resumeSpecies(l, species) {
    delete l.stopped[species];
    delete l.rev[species];
    if (l.sp[species]) l.sp[species].next = 0;
}

export function speciesOn(l) {
    return l ? Object.keys(l.sp).filter(sp => l.sp[sp].on && !l.stopped[sp]) : [];
}

// ------------------------------------------------------------- habitats

// A habitat as it is kept: its name and the game's habitat id.
export function habRef(model, habId) {
    if (habId == null || habId === '' || habId === 'away') return { n: '', h: '' };
    if (habId === TRADE) return { n: 'Trade centre', h: TRADE };
    const s = model && model.snapshot && Array.isArray(model.snapshot.habs) ? model.snapshot.habs.find(x => String(x.id) === String(habId)) : null;
    const h = model && model.habitats ? model.habitats.get(String(habId)) : null;
    return { n: (s && s.name) || (h && h.name) || '', h: s && s.hid != null ? String(s.hid) : '' };
}

// Today's id of a kept habitat (by habitat id, then by a unique name).
export function resolveHab(model, n, hid) {
    if (hid === TRADE) return TRADE;
    const habs = model && model.snapshot && Array.isArray(model.snapshot.habs) ? model.snapshot.habs : [];
    if (hid) {
        const byHid = habs.filter(x => x.hid != null && String(x.hid) === String(hid));
        if (byHid.length === 1) return String(byHid[0].id);
    }
    if (n) {
        const key = String(n).trim().toLowerCase();
        const byName = habs.filter(x => String(x.name || '').trim().toLowerCase() === key);
        if (byName.length === 1) return String(byName[0].id);
        if (!habs.length && model && model.habitats) {
            const list = Array.from(model.habitats.values()).filter(x => String(x.name || '').trim().toLowerCase() === key);
            if (list.length === 1) return String(list[0].id);
        }
    }
    return '';
}

function guidMap(model) {
    const byGuid = new Map();
    for (const a of model ? model.animals.values() : []) if (a.guid) byGuid.set(a.guid, a);
    return byGuid;
}

// ----------------------------------------------------------------- view

// This load's view for planAutoRun(). clock: years of the park's calendar; realNow: ms.
export function ledgerView(l, model, clock, realNow) {
    const byGuid = guidMap(model);
    const ids = (o, test) => {
        const out = new Set();
        for (const [g, v] of Object.entries(o || {})) {
            const a = byGuid.get(g);
            if (a && (!test || test(v))) out.add(a.id);
        }
        return out;
    };
    const recentFrom = new Map();
    const cooled = new Set();
    for (const [g, list] of Object.entries(l.hist)) {
        const a = byGuid.get(g);
        if (!a || !Array.isArray(list)) continue;
        // moved by Auto mode lately: it stays put for a while
        // (the same window as a reversal, so no move back counts as one)
        if (list.some(h => clock - Number(h[2]) <= AUTO_LIMITS.cooldownYears)) cooled.add(a.id);
        const set = new Set();
        for (const [n, hid, t] of list) {
            if (clock - Number(t) > AUTO_LIMITS.reversalYears) continue;
            const hab = resolveHab(model, n, hid);
            if (hab) set.add(hab);
        }
        if (set.size) recentFrom.set(a.id, set);
    }
    const blocked = new Set();
    for (const [k, v] of Object.entries(l.fails)) {
        const [g, dest] = k.split('>');
        const a = byGuid.get(g);
        if (!a || !Array.isArray(v)) continue;
        const to = dest === TRADE ? TRADE : resolveHab(model, dest, '');
        if (!to) continue;
        // 10 minutes after a refusal; for good after the third
        if (v[0] >= 3 || realNow - v[1] < 10 * 60 * 1000) blocked.add(`${a.id}>${to}`);
    }
    return {
        pinned: ids(l.pins),
        manual: ids(l.manual, until => clock < Number(until)),
        cooled,
        leaving: ids(l.leave),
        recentFrom,
        blocked,
    };
}

// Moves the game refused three times (Auto mode no longer tries them), for
// the panel: [{ id, to }]
export function refusedMoves(l, model, species) {
    const byGuid = guidMap(model);
    const out = [];
    for (const [k, v] of Object.entries(l.fails)) {
        if (!Array.isArray(v) || v[0] < 3) continue;
        const [g, dest] = k.split('>');
        const a = byGuid.get(g);
        if (a && a.species === species) out.push({ id: a.id, to: dest === TRADE ? TRADE : resolveHab(model, dest, '') || dest });
    }
    return out;
}

// --------------------------------------------------------------- record

function guidOf(model, id) {
    const a = model && model.animals.get(String(id));
    return a ? (a.guid || '') : '';
}

function cut(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// One log entry for a move about to run (outcome 'wait').
export function logAction(l, model, x, { run, clock, realNow, species }) {
    const a = model.animals.get(String(x.id));
    const from = a ? (a.hab || (a.lt === 'trade' ? TRADE : '')) : '';
    const f = habRef(model, from), to = habRef(model, x.to);
    l.seq = (l.seq || 0) + 1;
    const e = {
        i: l.seq, t: Math.round(clock * 1000) / 1000, real: realNow, c: run, sp: species || (a && a.species) || '',
        g: guidOf(model, x.id), n: a ? cut(a.name, 24) : String(x.id), sex: a ? a.sex : 2,
        a: x.to === TRADE ? 'trade' : 'move',
        f: f.n, fh: f.h, to: to.n, toh: to.h, r: cut(x.reason, 110), st: x.stage || '', o: 'wait',
    };
    l.log.push(e);
    if (l.log.length > LOG_MAX) l.log = l.log.slice(-LOG_MAX);
    return e;
}

// The game confirmed it (ok) or not (skip): update what Auto mode remembers.
export function settleAction(l, e, x, ok, { clock, realNow, why = '', noFail = false } = {}) {
    e.o = ok ? 'ok' : 'skip';
    if (!ok) {
        e.why = cut(why, 80);
        // only the game's own refusal counts against the move (not a busy
        // gate or a run that never started)
        if (e.g && !noFail) {
            const key = `${e.g}>${x.to === TRADE ? TRADE : e.to}`;
            const prev = l.fails[key];
            l.fails[key] = [(Array.isArray(prev) ? prev[0] : 0) + 1, realNow, clock];
        }
        return;
    }
    if (!e.g) return;
    delete l.fails[`${e.g}>${x.to === TRADE ? TRADE : e.to}`];
    const h = Array.isArray(l.hist[e.g]) ? l.hist[e.g] : [];
    if (e.f) h.push([e.f, e.fh, clock]);
    l.hist[e.g] = h.slice(-4);
    if (x.to === TRADE) l.leave[e.g] = 1;
    else delete l.leave[e.g];
}

// The player (or the game) moved these animals: hands off for a while.
export function noteManualMoves(l, model, ids, clock) {
    for (const id of ids) {
        const g = guidOf(model, id);
        if (!g) continue;
        l.manual[g] = Math.round((clock + AUTO_LIMITS.manualYears) * 1000) / 1000;
        delete l.leave[g];
    }
}

// A move back to a habitat left within the window: two of them for one
// species and Auto mode stops for it (the player looks).
export function noteReversal(l, species, clock) {
    const list = (Array.isArray(l.rev[species]) ? l.rev[species] : []).filter(t => clock - t <= AUTO_LIMITS.reversalYears);
    list.push(clock);
    l.rev[species] = list;
    if (list.length >= AUTO_LIMITS.reversalsToStop) {
        l.stopped[species] = 'it moved some of them back and forth';
        return true;
    }
    return false;
}

// ---------------------------------------------------------------- pins

export function togglePinAnimal(l, model, id) {
    const g = guidOf(model, id);
    if (!g) return false;
    if (l.pins[g]) delete l.pins[g];
    else l.pins[g] = 1;
    return !!l.pins[g];
}

export function isPinnedAnimal(l, model, id) {
    const g = guidOf(model, id);
    return !!(g && l && l.pins[g]);
}

export function isManualAnimal(l, model, id, clock) {
    const g = guidOf(model, id);
    return !!(g && l && l.manual[g] != null && clock < Number(l.manual[g]));
}

// ---------------------------------------------------------------- undo

// The move that undoes a log entry, if it is still possible: back to where
// it came from (Return to habitat for an animal waiting at the trade
// centre). -> { action: { id, to } } or { why }
export function undoOf(l, model, e) {
    if (!e || e.u) return { why: 'already undone' };
    if (e.o !== 'ok') return { why: 'it did not happen' };
    const a = Array.from(model ? model.animals.values() : []).find(x => x.guid && x.guid === e.g);
    if (!a) return { why: `${e.n} is no longer in the zoo` };
    if (a.moving) return { why: `${e.n} is on the move` };
    const back = resolveHab(model, e.f, e.fh);
    if (!back) return { why: `${e.f || 'its old habitat'} is not found` };
    const here = a.hab || (a.lt === 'trade' ? TRADE : '');
    if (here === back) return { why: 'already back' };
    return { action: { id: a.id, to: back } };
}

// The player undid it: Auto mode must not do it again for a while.
export function noteUndone(l, model, e, clock) {
    e.u = 1;
    const a = Array.from(model ? model.animals.values() : []).find(x => x.guid && x.guid === e.g);
    if (a) noteManualMoves(l, model, [a.id], clock);
}

// --------------------------------------------------------------- tidy

// Drops what refers to animals that are gone (sold, released, dead) and
// what has run its course (the player's holds, old history and refusals).
export function pruneLedger(l, model, clock) {
    const present = new Set();
    for (const a of model ? model.animals.values() : []) if (a.guid) present.add(a.guid);
    if (!present.size) return l;
    for (const key of ['pins', 'manual', 'leave', 'hist']) {
        for (const g of Object.keys(l[key])) if (!present.has(g)) delete l[key][g];
    }
    for (const k of Object.keys(l.fails)) if (!present.has(k.split('>')[0])) delete l.fails[k];
    for (const [g, until] of Object.entries(l.manual)) if (clock >= Number(until)) delete l.manual[g];
    for (const [g, list] of Object.entries(l.hist)) {
        const keep = Array.isArray(list) ? list.filter(h => clock - Number(h[2]) <= AUTO_LIMITS.reversalYears) : [];
        if (keep.length) l.hist[g] = keep;
        else delete l.hist[g];
    }
    for (const [k, v] of Object.entries(l.fails)) {
        if (!Array.isArray(v) || (v[0] < 3 && clock - Number(v[2] || 0) > AUTO_LIMITS.reversalYears)) delete l.fails[k];
    }
    for (const [sp, list] of Object.entries(l.rev)) {
        const keep = Array.isArray(list) ? list.filter(t => clock - t <= AUTO_LIMITS.reversalYears) : [];
        if (keep.length) l.rev[sp] = keep;
        else delete l.rev[sp];
    }
    return l;
}

// The size as the store writes it: every non-ASCII character as \uXXXX.
export function savedSize(l) {
    const text = JSON.stringify(l);
    let extra = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 126) extra += 5;
    return text.length + extra;
}

// Keeps the saved size in budget: old log entries first, then the oldest
// histories and refusals (they only stop repeats), never pins or settings.
export function fitBudget(l, budget = SAVE_BUDGET) {
    const trimMap = (key, age) => {
        const keys = Object.keys(l[key]);
        if (keys.length <= MAP_MAX) return;
        keys.sort((a, b) => age(l[key][a]) - age(l[key][b]));
        for (const k of keys.slice(0, keys.length - MAP_MAX)) delete l[key][k];
    };
    trimMap('hist', v => (Array.isArray(v) && v.length ? Number(v[v.length - 1][2]) : 0));
    trimMap('fails', v => (Array.isArray(v) ? Number(v[1]) : 0));
    let size = savedSize(l);
    while (size > budget && l.log.length) {
        l.log = l.log.slice(Math.max(1, Math.ceil(l.log.length / 8)));
        size = savedSize(l);
    }
    for (const key of ['hist', 'fails', 'leave']) {
        while (size > budget && Object.keys(l[key]).length) {
            const keys = Object.keys(l[key]);
            for (const k of keys.slice(0, Math.max(1, Math.ceil(keys.length / 4)))) delete l[key][k];
            size = savedSize(l);
        }
    }
    return l;
}
