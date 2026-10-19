// Auto mode on screen: its button and panel on the Species board (per
// species: on/off, how often, the Breeding programme's settings, Thin out,
// the last runs with Undo), its tags and the "hands off" menu item on the
// cards, and its notices (off unless the player turns them on). Design:
// docs/DESIGN-autopilot.md section 16.
import {
    getAutopilotLedger, getAutopilotState, getSpeciesAuto, installAutopilot, isAutoHeld, isAutoPinned, onAutopilot,
    resumeSpeciesAuto, runSpeciesNow, setAutopilotToastHook, setSpeciesAuto, speciesChoicesChanged,
    toggleAutoPin, undoEntries,
} from '/js/mods/pz2qol/kinauto.js';
import { EVERY_CHOICES, SPECIES_DEFAULTS, dueText, everyText, everyWords, realTimeText, sexMark } from '/js/mods/pz2qol/kinautocore.js';
import { refusedMoves } from '/js/mods/pz2qol/kinautoledger.js';
import { PROGRAMME_STEPS, RATIO_CHOICES } from '/js/mods/pz2qol/kinprogramme.js';
import { FILL_STEPS } from '/js/mods/pz2qol/kincull.js';
import { TRADE } from '/js/mods/pz2qol/kinboardcore.js';
import { getKinModel } from '/js/mods/pz2qol/kin.js';
import { getPref, setPref } from '/js/mods/pz2qol/prefs.js';
import { getUserData, updateUserData } from '/js/mods/pz2qol/userstore.js';
import { h, setClass } from '/js/mods/pz2qol/ui.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { speciesName, trunc } from '/js/mods/pz2qol/kinpanel.js';

const TOAST_MS = 14000;
// Notices when Auto mode moved animals (or stopped for a species): off
// unless the player turns them on in the panel (player-wide, prefs.js)
const NOTICE_PREF = 'autoNotices';
const RATIO_STORE = 'kinRatio';     // the board's group make-up per species (kinboard.js)
const RATIO_WORDS = {
    auto: "auto (the game's)", '1:1': 'pairs', '1:2': '1 ♂ : 2 ♀', '1:3': '1 ♂ : 3 ♀', '1:4': '1 ♂ : 4 ♀', '1:5': '1 ♂ : 5 ♀',
    '1:*': 'harem', '2:1': '2 ♂ : 1 ♀', '3:1': '3 ♂ : 1 ♀', '*:1': 'one ♀ per habitat', mixed: 'mixed groups',
};

const U = { toasts: null, board: null };

function guarded(what, fn) {
    return (...args) => {
        try {
            return fn(...args);
        }
        catch (e) {
            reportError('ui', `Auto mode: ${what} failed`, e);
            return undefined;
        }
    };
}

// ------------------------------------------------------------ settings

function ratioChoice(species) {
    const all = getUserData(RATIO_STORE);
    const v = all && typeof all === 'object' && !Array.isArray(all) ? all[species] : null;
    return RATIO_CHOICES.includes(v) ? v : 'auto';
}

// The same store the Breeding programme's Make-up arrows use (one choice
// per species for this zoo).
function setRatioChoice(species, choice) {
    updateUserData(RATIO_STORE, old => {
        const all = Object.assign({}, old && typeof old === 'object' && !Array.isArray(old) ? old : {});
        if (choice === 'auto') delete all[species];
        else all[species] = choice;
        return Object.keys(all).length ? all : undefined;
    });
}

function prefStep() {
    const v = getPref('progStep');
    return Number.isInteger(v) && v >= 0 && v < PROGRAMME_STEPS.length ? v : SPECIES_DEFAULTS.step;
}

function noticesOn() {
    return getPref(NOTICE_PREF) === true;
}

// Where it stands in the queue ("next in line", "3rd in line")
function queueText(n) {
    if (n === 1) return 'next in line';
    const suffix = n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
    return `${n}${suffix} in line`;
}

// "in 2 months (about 6 min at this speed)", "in 2 months (paused)"
function nextText(sa) {
    if (sa.left == null) return 'once the park\'s date is read';
    const real = realTimeText(sa.left, sa.rate);
    return `${dueText(sa.left)}${real ? ` (${real} at this speed)` : sa.rate === 0 ? ' (the game is paused)' : ''}`;
}

function statusLine(sa) {
    const s = sa.settings;
    if (!s.on) return 'Off: nothing runs by itself';
    const every = everyText(s.every);
    switch (sa.status) {
        case 'acting': return `Running now · ${every}`;
        case 'planning': return `Working out the plan… · ${every}`;
        case 'queued': return `Due: ${queueText(sa.queued)}${sa.why ? ` (${sa.why})` : ''} · ${every}`;
        case 'waiting': return `On · next run ${nextText(sa)} · ${every}`;
        case 'paused': return `Paused for ${Math.max(1, Math.round(sa.pausedMs / 60000))} min: ${sa.why}`;
        case 'stopped': return `Stopped: ${sa.why}`;
        default: return `On · due now${sa.why ? ` (waiting: ${sa.why})` : ''} · ${every}`;
    }
}

function shortStatus(sa) {
    if (!sa.settings.on) return 'Auto mode';
    switch (sa.status) {
        case 'acting': return 'Auto · running';
        case 'planning': return 'Auto · planning';
        case 'queued': return 'Auto · in line';
        case 'waiting': return `Auto · next ${dueText(sa.left).replace(/^in /, '')}`;
        case 'paused': return 'Auto · paused';
        case 'stopped': return 'Auto · stopped';
        default: return 'Auto · due';
    }
}

// --------------------------------------------------------------- panel

function seg(items, current, onPick, attr) {
    return h('div.PZ2QoL_kbSeg.PZ2QoL_apSeg', null, items.map(it => h(`div.PZ2QoL_kbSegItem${it.id === current ? '.on' : ''}`, {
        [`data-${attr}`]: String(it.id),
        title: it.title || '',
        onClick: guarded(attr, () => onPick(it.id)),
    }, h('span', { text: it.label }))));
}

function section(title, ...kids) {
    return h('div.PZ2QoL_apSection', null,
        h('div.PZ2QoL_apSectionTitle', { text: title }),
        h('div.PZ2QoL_apSectionBody', null, ...kids));
}

function para(text, cls = '') {
    return h(`div.PZ2QoL_apText${cls ? '.' + cls : ''}`, { text });
}

function entryText(model, e) {
    const sym = e.sex === 0 ? '♂' : e.sex === 1 ? '♀' : '';
    const to = e.a === 'trade' ? 'Trade centre' : e.to || 'another habitat';
    return `${e.n} ${sym}: ${e.f || 'elsewhere'} → ${to}`;
}

// The last runs of the species, newest first, each with Undo.
function runsEl(sa, H) {
    const byRun = new Map();
    for (const e of sa.log) {
        if (!byRun.has(e.c)) byRun.set(e.c, []);
        byRun.get(e.c).push(e);
    }
    const runs = Array.from(byRun.entries()).sort((x, y) => y[0] - x[0]).slice(0, 6);
    if (!runs.length) return para(sa.last && sa.last.note ? `Last run: ${sa.last.note}.` : 'Nothing moved yet.', 'soft');
    const model = getKinModel();
    const box = h('div.PZ2QoL_apRuns');
    if (sa.last && !sa.last.moves && sa.last.note) box.appendChild(para(`Last run: ${sa.last.note}.`, 'soft'));
    for (const [run, list] of runs) {
        const when = list[0].real ? new Date(list[0].real) : null;
        const ok = list.filter(e => e.o === 'ok' && !e.u);
        const head = h('div.PZ2QoL_apRunHead', null,
            h('span', { text: `Run ${run}${when ? ` · ${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}` : ''} · ${list.filter(e => e.o === 'ok').length} moved${list.some(e => e.o === 'skip') ? `, ${list.filter(e => e.o === 'skip').length} skipped` : ''}` }),
            h('div.PZ2QoL_kpFlex'),
            ok.length ? H.btn(`Undo run (${ok.length})`, null, () => doUndo(ok, H), { cls: 'small', title: 'Put these animals back where they came from, one at a time (Auto mode then leaves them there for a while)' }) : null);
        box.appendChild(head);
        for (const e of list) {
            box.appendChild(h(`div.PZ2QoL_apLog.${e.o}${e.u ? '.undone' : ''}`, { 'data-entry': String(e.i) },
                h('div.PZ2QoL_apLogMark', { text: e.u ? '↶' : e.o === 'ok' ? '✓' : e.o === 'skip' ? '✗' : '…' }),
                h('div.PZ2QoL_apLogText', null,
                    h('div.PZ2QoL_apLogMain', { text: entryText(model, e) }),
                    h('div.PZ2QoL_apLogWhy', { text: e.o === 'skip' ? `skipped: ${e.why || 'refused'}` : e.r || '' })),
                e.o === 'ok' && !e.u ? H.btn('Undo', null, () => doUndo([e], H), { cls: 'small' }) : null));
        }
    }
    return box;
}

function doUndo(entries, H) {
    breadcrumb('auto_undo');
    undoEntries(entries).then(r => {
        if (r && !r.ok) H.notice(r.detail, 'warn');
        else if (r && r.skipped && r.skipped.length) H.notice(`Not undone: ${r.skipped.join('; ')}`, 'warn');
        else H.notice(`Undo: ${r.done} animal${r.done === 1 ? '' : 's'} going back.`, 'ok');
        H.queueRender();
    }, e => reportError('ui', 'Auto mode: Undo failed', e));
}

function panelEl(model, species, H) {
    const sa = Object.assign(getSpeciesAuto(species), { species });
    sa.settings = Object.assign({}, sa.settings);
    const st = getAutopilotState();
    const s = sa.settings;
    const name = speciesName(species);
    const kept = st.storage === 'file';
    // a species not set up yet starts from the player's own programme
    // slider (the board's last position, prefs.js)
    const fresh = !(getAutopilotLedger() && getAutopilotLedger().sp[species]);
    if (fresh) s.step = prefStep();
    const set = patch => {
        if (fresh && patch.step == null) patch = Object.assign({ step: s.step }, patch);
        if (!setSpeciesAuto(species, patch)) H.notice('Auto mode can only be changed once the game\'s player profile can keep its settings for this zoo. Try again in a moment.', 'warn');
        H.renderAll();
    };
    const wrap = h(`div.PZ2QoL_kbProg.PZ2QoL_kbAuto.state_${s.on ? 'on' : 'off'}`, { 'data-species': species, 'data-status': sa.status });
    const head = [];
    if (s.on) {
        head.push(H.btn('Run now', null, () => {
            const r = runSpeciesNow(species);
            if (r === 'now') H.notice(`Auto mode: working out ${name}'s plan, then moving the animals one at a time.`, 'ok');
            else if (r === 'queued') H.notice(`Auto mode: ${name} is next in line; it runs as soon as the run before it is done.`, 'ok');
            else H.notice(`Auto mode can't run now: ${r}.`, 'warn');
            H.renderAll();
        }, { cls: sa.status === 'acting' || sa.status === 'planning' ? 'disabled' : '', title: 'Run it now, without waiting for its turn (first in line if another run is going); the schedule carries on from here' }));
        head.push(H.btn('Turn off', null, () => set({ on: false }), { title: `Stop Auto mode for ${name}. A move already sent finishes; nothing else changes.` }));
    }
    else {
        head.push(H.btn('Turn on', null, () => {
            if (!kept) return;
            set({ on: true });
            breadcrumb('kin_board_auto_on');
        }, { cls: kept ? 'primary' : 'primary.disabled', title: `Run ${name}'s Breeding programme ${everyText(s.every)} and move the animals to match` }));
    }
    // the Breeding window has its own tabs and close button
    if (!H.compact) head.push(H.btn('Close', null, H.close, { title: 'Back to the board (Esc)' }));
    wrap.appendChild(h('div.PZ2QoL_kbProgHead', null,
        h('div.PZ2QoL_kbProgTitles', null,
            h('div.PZ2QoL_kbProgTitle', { text: `Auto mode · ${trunc(name, 24)}` }),
            h('div.PZ2QoL_kbProgSub', { text: statusLine(sa), title: statusLine(sa) })),
        h('div.PZ2QoL_kpFlex'),
        ...head));
    const box = H.makeScroll('kbAutoBody', { onScroll: (x, y) => H.scroll(y) });
    H.box(box);
    const c = box.content;
    if (!kept) c.appendChild(h('div.PZ2QoL_kbProgWarn', { text: st.storage === 'loading' ? 'Reading this zoo\'s data…' : 'Auto mode keeps its settings with this zoo in the game\'s player profile, which can\'t be used right now. Try again in a moment, or after reloading the zoo.' }));
    if (sa.status === 'stopped') {
        c.appendChild(h('div.PZ2QoL_apBanner.warn', null,
            h('span', { text: `Auto mode stopped for ${name}: ${sa.why}. Have a look at the board, then hand it back.` }),
            h('div.PZ2QoL_kpFlex'),
            H.btn('Hand it back', null, () => { resumeSpeciesAuto(species); H.renderAll(); }, { cls: 'small' })));
    }
    // what it does
    const steps = s.thin ? 'thins out full habitats, then moves the animals into the Breeding programme\'s groups' : 'moves the animals into the Breeding programme\'s groups';
    c.appendChild(para(`${everyText(s.every).replace(/^e/, 'E')} of game time, Auto mode ${steps}, by itself (Franchise too), one move at a time. When several species are due they take turns.`));
    // how often
    // the park's calendar: 12 months, 3 a season; how long a month lasts at 1x
    const atOne = st.monthSec ? realTimeText(1, 1 / (st.monthSec * 1000)) : '';
    c.appendChild(section('How often (game time)',
        seg(EVERY_CHOICES.map(m => ({ id: m, label: everyWords(m), title: `A run ${everyText(m)} of the park's calendar: it waits while the game is paused and comes sooner at 2x and 5x` })), s.every, v => set({ every: v }), 'every'),
        para(`The park's calendar: 12 months a year, 3 a season.${atOne ? ` A month lasts ${atOne.replace(/^about /, 'about ')} at 1x speed.` : ''}`, 'soft')));
    // the programme's settings
    const ratio = ratioChoice(species);
    const i = RATIO_CHOICES.indexOf(ratio);
    const cycle = d => {
        setRatioChoice(species, RATIO_CHOICES[(i + d + RATIO_CHOICES.length) % RATIO_CHOICES.length]);
        speciesChoicesChanged(species);
        H.renderAll();
    };
    c.appendChild(section('Breeding programme',
        h('div.PZ2QoL_apRow', null,
            h('div.PZ2QoL_kbRatio.PZ2QoL_apRatio', { 'data-ratio': ratio, title: 'Group make-up: the same choice as the arrows in the Breeding programme (kept for this species in this zoo)' },
                h('div.PZ2QoL_kbRatioArrow.prev', { onClick: guarded('make-up', () => cycle(-1)) }, h('span', { text: '‹' })),
                h('div.PZ2QoL_kbRatioText', null,
                    h('span.PZ2QoL_kbRatioLabel', { text: 'Make-up' }),
                    h('span.PZ2QoL_kbRatioValue', { text: RATIO_WORDS[ratio] || ratio })),
                h('div.PZ2QoL_kbRatioArrow.next', { onClick: guarded('make-up', () => cycle(1)) }, h('span', { text: '›' }))),
            H.switchEl('Bring breeders from the trade centre', s.trade, () => set({ trade: !s.trade }), 'Breeders waiting at the trade centre may join a group (never the ones Auto mode sent there)')),
        // the segments name the steps themselves (the programme's dot
        // slider needs its two end labels; these would repeat them)
        h('div.PZ2QoL_apRow', null,
            seg(PROGRAMME_STEPS.map((p, k) => ({ id: k, label: p.label, title: p.cost ? `Each move costs ${p.cost} (in expected-young units)` : 'Moves cost nothing; only the young count' })), s.step, v => set({ step: v }), 'step')),
        para('Classic optimiser, the same plan the Breeding programme shows for these settings. Pregnant females, animals on the move, and the ones you mark "hands off" stay where they are.', 'soft')));
    // thin out
    c.appendChild(section('Thin out',
        h('div.PZ2QoL_apRow', null,
            H.switchEl('First thin out habitats over their room', s.thin, () => set({ thin: !s.thin }), 'Before the programme: adults beyond the fill level (the old and infertile first), and animals with a 0% fertility gene, go to the trade centre'),
            s.thin ? seg(FILL_STEPS.map(f => ({ id: f.id, label: f.label, title: f.fill ? `Keep up to ${Math.round(f.fill * 100)}% of each habitat's room` : 'Keep only the breeding core of each habitat' })), s.fill, v => set({ fill: v }), 'fill') : null),
        para('Young, pregnant females and each habitat\'s breeding core stay. From the trade centre you sell, trade or release them as before: Auto mode never sells.', 'soft')));
    // hands off
    const l = getAutopilotLedger();
    if (model) {
        const mine = Array.from(model.animals.values()).filter(a => a.species === species);
        const pinned = mine.filter(a => isAutoPinned(a.id));
        const held = mine.filter(a => !isAutoPinned(a.id) && isAutoHeld(a.id));
        const refused = l ? refusedMoves(l, model, species) : [];
        const bits = [];
        bits.push(para(pinned.length ? `Hands off (${pinned.length}): ${pinned.slice(0, 8).map(a => `${a.name} ${sexMark(a)}`).join(', ')}${pinned.length > 8 ? '…' : ''}.` : 'No animal is marked "hands off". Use an animal card\'s menu on the board to mark one.'));
        if (held.length) bits.push(para(`Moved by you lately, left where you put them for 2 game years: ${held.slice(0, 8).map(a => `${a.name} ${sexMark(a)}`).join(', ')}${held.length > 8 ? '…' : ''}.`, 'soft'));
        if (refused.length) bits.push(para(`The game refused ${refused.length} move${refused.length === 1 ? '' : 's'} three times; Auto mode no longer tries ${refused.length === 1 ? 'it' : 'them'}: ${refused.slice(0, 5).map(r => { const a = model.animals.get(r.id); return `${a ? a.name : r.id} → ${r.to === TRADE ? 'trade centre' : H.placeName(model, r.to)}`; }).join(', ')}.`, 'warn'));
        c.appendChild(section('Left alone', ...bits));
    }
    const notes = sa.last && Array.isArray(sa.last.notes) ? sa.last.notes : [];
    c.appendChild(section('Notices',
        h('div.PZ2QoL_apRow', null,
            H.switchEl('Show a notice when Auto mode moves animals', noticesOn(), () => {
                setPref(NOTICE_PREF, noticesOn() ? undefined : true);
                H.renderAll();
            }, 'A small notice after each run that moved animals, and if Auto mode stops for a species. Off: it works quietly; the panel and the log show everything. For all zoos.')),
        para('Off by default. Either way nothing waits for a click.', 'soft')));
    c.appendChild(section('Last runs', ...notes.map(t => para(t, 'warn')), runsEl(sa, H)));
    wrap.appendChild(box.wrap);
    H.restoreScroll(box, 0, H.scroll());
    return wrap;
}

// ------------------------------------------------- the Species board

function lastEntry(guid) {
    const l = getAutopilotLedger();
    if (!l || !guid) return null;
    for (let i = l.log.length - 1; i >= 0; i--) if (l.log[i].g === guid) return l.log[i];
    return null;
}

const boardExtension = {
    button(species) {
        const sa = getSpeciesAuto(species);
        return { text: shortStatus(sa), on: sa.settings.on, title: `Auto mode for ${speciesName(species)}: ${statusLine(sa)}. Click for its settings.` };
    },
    panelEl,
    railTag(species) {
        const sa = getSpeciesAuto(species);
        if (!sa.settings.on) return null;
        return sa.status === 'stopped' ? 'auto: stopped' : 'auto';
    },
    cardTag(a) {
        const on = getSpeciesAuto(a.species).settings.on;
        if (isAutoPinned(a.id)) return { text: 'hands off', title: 'Auto mode never moves this animal' };
        if (!on) return null;
        if (isAutoHeld(a.id)) return { text: 'moved by you', title: 'You moved it: Auto mode leaves it here for 2 game years' };
        const e = lastEntry(a.guid);
        if (e && e.o === 'ok' && !e.u && Date.now() - (e.real || 0) < 2 * 3600 * 1000) return { text: 'auto', title: `Auto mode: ${e.r}` };
        return null;
    },
    menuItems(a) {
        const pinned = isAutoPinned(a.id);
        if (!pinned && !getSpeciesAuto(a.species).settings.on) return [];
        return [{
            label: pinned ? 'Auto mode may move it again' : 'Auto mode: hands off',
            title: pinned ? 'Auto mode may move this animal again' : 'Auto mode never moves this animal or sends it away',
            run: () => toggleAutoPin(a.id),
        }];
    },
};

// The Breeding window (breedwin.js) draws the same panel and button text
// with its own helpers (H: the board's autoHelpers() shape).
export function autoPanelEl(model, species, H) {
    return panelEl(model, species, H);
}

export function autoButtonInfo(species) {
    return boardExtension.button(species);
}

function board() {
    if (U.board) return Promise.resolve(U.board);
    return import('/js/mods/pz2qol/kinboard.js').then(m => (U.board = m));
}

function linkBoard() {
    board().then(m => m.setBoardExtension(boardExtension)).catch(e => reportError('ui', 'Auto mode: Species board link failed', e, { silent: true }));
}

function openBoard(species) {
    board().then(m => m.openAutoPanel(species)).catch(e => reportError('ui', 'Auto mode: could not open the board', e));
}

// --------------------------------------------------------------- notices

function toastRoot() {
    if (!U.toasts || !U.toasts.parentNode) {
        U.toasts = h('div.PZ2QoL_kinToasts.PZ2QoL_apToasts');
        document.body.appendChild(U.toasts);
    }
    return U.toasts;
}

function toastNow({ tone = 'info', title, text, actions = [], ms = TOAST_MS, key = '' }) {
    const root = toastRoot();
    if (key) for (const n of Array.from(root.childNodes)) if (n.__key === key) n.remove();
    while (root.childNodes.length >= 3) root.removeChild(root.firstChild);
    let timer = null;
    const close = () => {
        clearTimeout(timer);
        setClass(node, 'leaving', true);
        setTimeout(() => node.parentNode && node.parentNode.removeChild(node), 250);
    };
    const node = h(`div.PZ2QoL_kinToast.PZ2QoL_apToast.tone_${tone}`, { 'data-key': key },
        h('div.PZ2QoL_kinToastStripe'),
        h('div.PZ2QoL_kinToastBody', null,
            h('div.PZ2QoL_kinToastHead', null, h('div.PZ2QoL_apToastIcon'), h('div.PZ2QoL_kinToastTitle', { text: title }),
                h('div.PZ2QoL_kinToastClose', { text: '✕', title: 'Dismiss', onClick: close })),
            h('div.PZ2QoL_kinToastText', { text }),
            actions.length ? h('div.PZ2QoL_kinActions', null, actions.map(a => h(`div.PZ2QoL_kinAction${a.primary ? '.primary' : ''}`, {
                onClick: () => {
                    try {
                        a.run();
                    }
                    catch (e) {
                        reportError('ui', `"${a.label}" failed`, e);
                    }
                    close();
                },
            }, h('span', { text: a.label })))) : null));
    node.__key = key;
    node.addEventListener('mouseenter', () => clearTimeout(timer));
    node.addEventListener('mouseleave', () => {
        clearTimeout(timer);
        timer = setTimeout(close, Math.min(ms, TOAST_MS) / 2);
    });
    timer = setTimeout(close, ms);
    root.appendChild(node);
    return node;
}

// Notices only when the player turned them on; nothing ever waits for a click.
function onToast(kind, d) {
    if (!noticesOn()) return;
    if (kind === 'done') {
        const parts = [`${d.moves} moved`];
        if (d.skipped) parts.push(`${d.skipped} skipped`);
        toastNow({ key: `done_${d.species}`, tone: d.skipped ? 'warn' : 'ok', title: `Auto mode · ${speciesName(d.species)}`, text: `${parts.join(', ')}.`, actions: [{ label: 'Show', run: () => openBoard(d.species) }] });
    }
    else if (kind === 'stopped') {
        toastNow({ key: `stopped_${d.species}`, tone: 'warn', ms: 25000, title: `Auto mode stopped for ${speciesName(d.species)}`, text: 'It was about to move some of them back where they just came from. Have a look; you can hand it back in its panel.', actions: [{ label: 'Show', run: () => openBoard(d.species) }] });
    }
}

// --------------------------------------------------------------- install

let installed = false;
export function installAutopilotUI() {
    if (installed) return true;
    // the park HUD page only
    if (!/PZ2QoLHUD/i.test(String(window.location && window.location.pathname))) return true;
    installed = true;
    setAutopilotToastHook(onToast);
    onAutopilot(() => {
        if (U.board) U.board.refreshAutoPanel();
    });
    installAutopilot();
    linkBoard();
    return true;
}
