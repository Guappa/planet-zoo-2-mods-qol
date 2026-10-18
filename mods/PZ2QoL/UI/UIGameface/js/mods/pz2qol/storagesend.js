// "Find a habitat": Animal Storage -> the zoo -> a habitat for each animal.
//
// Hub page (Animal Storage, storage tab): a button under the game's own
// Send to Zoo, for the current selection (works with select all and the
// mod's Juveniles filter). One click:
//   1. tells Lua how many animals are coming (PZ2QoL_SendArm);
//   2. presses the game's own Send to Zoo for the selection (the panel's own
//      handler, so exactly the game's action: one Send to Zoo, then the game
//      loads the zoo).
// In the park the game would now open its Move screen for all of them with
// one destination. Lua (pz2qol.storagesend.lua) hands the animals to this
// page instead (PZ2QoL_SendArrived), and the HUD page places them ONE at a
// time (storagesendcore.js runPlacement): the game's facts for one animal,
// the best habitat it allows, the game's own Move for that one animal, wait
// for the game's confirmation, pause (the player's 'moves' pace), next.
// Failures are skipped and the run carries on; only Stop ends it. In a
// Franchise zoo it only runs when the player allowed it (off by default).
import { loadCSS } from '/js/common/util/CSSUtil.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { findVNode, gameModule, h as vh, isFrontendPage, isHudPage, unwrapUntil } from '/js/mods/pz2qol/kinhooks.js';
import { isFranchise } from '/js/mods/pz2qol/lister.js';
import { getPaceMs } from '/js/mods/pz2qol/pace.js';
import { h, setClass, setText } from '/js/mods/pz2qol/ui.js';
import { blockedReason, parseIdList, runPlacement, sendButtonLabel, summarize, summaryText } from '/js/mods/pz2qol/storagesendcore.js';

const MOD_PANEL = '/js/project/modules/AnimalMarket/Components/AnimalStorageInfoPanel.js';
const SEND_LABEL = '[AnimalExchange_SendToZoo]';
const ALLOW_KEY = 'PZ2QoL.storageSend.allowOnline';
const ANSWER_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------- setting

// Franchise too: the "Find a habitat" click is the opt-in (the developer's
// decision, 2026-10-16). Still one confirmed move at a time, paced.
let allowOnline = true;

export function isSendAllowedOnline() {
    return allowOnline;
}

export function setSendAllowedOnline(on) {
    allowOnline = !!on;
    try {
        if (window.localStorage) window.localStorage.setItem(ALLOW_KEY, allowOnline ? 'true' : 'false');
    }
    catch (e) {
        // session only
    }
}

function isFranchiseHub() {
    try {
        // the hub's own game mode test (the Market lister's)
        return !!isFranchise();
    }
    catch (e) {
        return false;
    }
}

// ------------------------------------------------------- hub: the button

let ourSendAt = 0;

function startSend(inst, keys) {
    if (typeof engine === 'undefined' || !keys.length) return;
    breadcrumb('send_start');
    // the count first, so Lua knows these animals before the game sends them
    engine.trigger('PZ2QoL_SendArm', keys.length, allowOnline === true);
    ourSendAt = Date.now();
    // the game's own Send to Zoo button handler for this selection
    if (inst && typeof inst.onSelectSendToZoo === 'function') inst.onSelectSendToZoo();
    else engine.trigger('AnimalStorage_SendToZoo', keys);
}

function rerender(inst) {
    try {
        if (inst && typeof inst.forceUpdate === 'function') inst.forceUpdate();
    }
    catch (e) {
        // next render picks it up
    }
}

let Button = null;
let stringLiteral = s => s;

function sendRowVNode(inst, state) {
    const keys = state && Array.isArray(state.selectedAnimalIDs) ? state.selectedAnimalIDs.slice() : [];
    const franchise = isFranchiseHub();
    const reason = blockedReason({ count: keys.length, sendAllowed: !state || state.sendToZooAllowed !== false, franchise, allowOnline, moving: !!(state && state.isMovingAnAnimal) });
    const label = sendButtonLabel(keys.length);
    const button = Button
        ? vh(Button, { modifiers: 'stretch', icon: 'img/icons/IconHabitatPin.svg', label: stringLiteral(label), disabled: !!reason, tooltip: reason ? stringLiteral(reason) : stringLiteral('Sends the selection to the zoo, then puts each animal in the best habitat the game allows for it, one at a time.'), onSelect: () => startSend(inst, keys) })
        : vh('div', { className: `PZ2QoL_ssBtn${reason ? ' disabled' : ''}`, onClick: () => { if (!reason) startSend(inst, keys); } }, label);
    const kids = [button];
    if (reason && keys.length) kids.push(vh('div', { className: 'PZ2QoL_ssNote' }, reason));
    return vh('div', { className: 'PZ2QoL_ssRow' }, kids);
}

// Where the Send to Zoo row sits in the panel's actions: { arr, index }.
function findSendRow(arr, depth = 0) {
    if (!Array.isArray(arr) || depth > 4) return null;
    for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (Array.isArray(item)) {
            const hit = findSendRow(item, depth + 1);
            if (hit) return hit;
        }
        else if (item && typeof item === 'object' && findVNode(item, v => v.attributes && v.attributes.label === SEND_LABEL, 4)) {
            return { arr, index: i };
        }
    }
    return null;
}

const panelPatch = { failures: 0, off: false };

function wrapActions(inst) {
    const original = inst.onGetActionsContent;
    if (typeof original !== 'function' || original.__pz2qolSend) return;
    const wrapped = function (state) {
        const out = original.apply(this, arguments);
        if (panelPatch.off) return out;
        try {
            const hit = findSendRow(out);
            if (hit) hit.arr.splice(hit.index + 1, 0, sendRowVNode(inst, state || inst.state));
            panelPatch.failures = 0;
        }
        catch (e) {
            if (++panelPatch.failures >= 3) {
                panelPatch.off = true;
                reportError('mod', '"Find a habitat" turned off', e, { silent: true });
            }
        }
        return out;
    };
    wrapped.__pz2qolSend = true;
    inst.onGetActionsContent = wrapped;
}

function patchPanel(mod) {
    const Panel = mod && mod.AnimalStorageInfoPanel;
    const Inner = unwrapUntil(Panel, c => /onGetActionsContent/.test(Function.prototype.toString.call(c)) && c !== Panel);
    if (!Inner || !Inner.prototype) return false;
    if (Inner.prototype.__pz2qolSendPanel) return true;
    const mount = Inner.prototype.componentWillMount;
    Inner.prototype.componentWillMount = function (...args) {
        const ret = mount ? mount.apply(this, args) : undefined;
        try {
            wrapActions(this);
        }
        catch (e) {
            reportError('mod', '"Find a habitat" panel hook failed', e, { silent: true });
        }
        return ret;
    };
    Inner.prototype.__pz2qolSendPanel = true;
    return true;
}

function installHub() {
    // the game's own Send to Zoo / Return pressed without us: never let an
    // earlier arm take those animals
    engine.on('AnimalStorage_SendToZoo', () => {
        if (Date.now() - ourSendAt > 1000) engine.trigger('PZ2QoL_SendDisarm');
    });
    engine.on('AnimalStorage_ReturnToZoo', () => engine.trigger('PZ2QoL_SendDisarm'));
    (async () => {
        try {
            Button = (await import('/js/project/components/Button.js')).Button || null;
            stringLiteral = (await import('/js/common/util/LocalisationUtil.js')).stringLiteral || stringLiteral;
        }
        catch (e) {
            reportError('mod', '"Find a habitat": game button not found', e, { silent: true });
        }
        if (!patchPanel(await gameModule(MOD_PANEL))) reportError('mod', '"Find a habitat" not installed', 'storage info panel', { silent: true });
    })().catch(e => reportError('mod', '"Find a habitat" failed to start', e, { silent: true }));
}

// ---------------------------------------------------------- park: the run

let reqSeq = 0;
const waiting = new Map();

function ask(event, timeoutValue, ...args) {
    const reqId = 'ss' + (++reqSeq);
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            if (waiting.delete(reqId)) resolve(timeoutValue);
        }, ANSWER_TIMEOUT_MS);
        waiting.set(reqId, v => {
            clearTimeout(timer);
            resolve(v);
        });
        try {
            engine.trigger(event, reqId, ...args);
        }
        catch (e) {
            waiting.delete(reqId);
            clearTimeout(timer);
            resolve(timeoutValue);
        }
    });
}

function answer(reqId, value) {
    const done = waiting.get(String(reqId));
    if (!done) return;
    waiting.delete(String(reqId));
    done(value);
}

export function askFacts(id) {
    return ask('PZ2QoL_SendFacts', null, String(id));
}

export function askMove(id, habId) {
    return ask('PZ2QoL_SendMove', { ok: false, detail: 'the game did not answer' }, String(id), String(habId));
}

let run = null; // { seq, state, stopping }
let lastSeq = null;
let card = null;

export function getSendRun() {
    return run ? Object.assign({}, run.state, { stopping: run.stopping }) : null;
}

export function stopSendRun() {
    if (run && run.state.running) {
        run.stopping = true;
        breadcrumb('send_stop');
        render();
    }
}

function sleepUnlessStopped(ms) {
    return new Promise(resolve => {
        const end = Date.now() + ms;
        const tick = () => {
            if ((run && run.stopping) || Date.now() >= end) return resolve();
            setTimeout(tick, Math.min(100, Math.max(0, end - Date.now())));
        };
        tick();
    });
}

function cardButton(text, onClick, cls = '') {
    return h(`div.PZ2QoL_ssCardBtn${cls ? '.' + cls : ''}`, { text, onClick: () => {
        try {
            onClick();
        }
        catch (e) {
            reportError('ui', `"${text}" failed`, e);
        }
    } });
}

function closeCard() {
    if (card) card.remove();
    card = null;
    if (run && !run.state.running) run = null;
}

function openBoard() {
    import('/js/mods/pz2qol/kinboard.js')
        .then(m => m.openSpeciesBoard && m.openSpeciesBoard({}))
        .catch(e => reportError('ui', 'Species board could not open', e));
}

function render() {
    if (!run) return;
    if (!card) {
        card = h('div.PZ2QoL_ssCard');
        document.body.appendChild(card);
    }
    const s = run.state;
    while (card.firstChild) card.removeChild(card.firstChild);
    const sum = summarize(s.log, s.total);
    card.appendChild(h('div.PZ2QoL_ssHead', null,
        h('div.PZ2QoL_ssTitle', { text: 'Find a habitat' }),
        h('div.PZ2QoL_ssSub', { text: s.blocked ? 'Animals from storage' : `${s.total} animal${s.total === 1 ? '' : 's'} from storage` })));
    if (s.blocked) {
        card.appendChild(h('div.PZ2QoL_ssLine', { text: s.blocked }));
        card.appendChild(h('div.PZ2QoL_ssButtons', null, cardButton('Close', closeCard)));
        return;
    }
    const pct = s.total ? Math.round(((sum.sent + sum.skipped) / s.total) * 100) : 0;
    const fill = h('div.PZ2QoL_ssFill');
    fill.style.width = `${pct}%`;
    card.appendChild(h('div.PZ2QoL_ssBar', null, fill));
    card.appendChild(h('div.PZ2QoL_ssCounts', null,
        h('div.PZ2QoL_ssCount.ok', { text: `Sent ${sum.sent}` }),
        h('div.PZ2QoL_ssCount.skip', { text: `Skipped ${sum.skipped}` }),
        h('div.PZ2QoL_ssCount', { text: `${sum.sent + sum.skipped} / ${s.total}` })));
    if (s.running) {
        const c = s.current;
        const text = run.stopping ? 'Stopping after this animal…'
            : c && c.habitat ? `${c.name || 'Animal ' + c.id}${c.species ? ' (' + c.species + ')' : ''} → ${c.habitat}, ${c.why}`
                : `Checking animal ${s.index} of ${s.total}…`;
        card.appendChild(h('div.PZ2QoL_ssLine', { text }));
        card.appendChild(h('div.PZ2QoL_ssButtons', null, cardButton(run.stopping ? 'Stopping…' : 'Stop', stopSendRun, 'stop')));
        return;
    }
    card.appendChild(h('div.PZ2QoL_ssLine.done', { text: summaryText(sum) + '.' }));
    const list = h('div.PZ2QoL_ssList');
    sum.habitats.slice(0, 5).forEach(x => list.appendChild(h('div.PZ2QoL_ssItem.ok', { text: `${x.n} → ${x.name}` })));
    sum.reasons.slice(0, 5).forEach(x => list.appendChild(h('div.PZ2QoL_ssItem.skip', { text: `${x.n} skipped: ${x.text}` })));
    if (list.firstChild) card.appendChild(list);
    card.appendChild(h('div.PZ2QoL_ssButtons', null, cardButton('Species board', openBoard), cardButton('Close', closeCard)));
}

async function startRun(seq, csv, allowed) {
    const ids = parseIdList(csv);
    if (!ids.length) return;
    if (run && run.state.running) return; // one run at a time
    if (card) closeCard();
    run = { seq, stopping: false, state: { running: true, total: ids.length, index: 0, current: null, log: [], finished: false } };
    render();
    breadcrumb('send_run_start');
    const first = await askFacts(ids[0]);
    const online = !first || first.mode !== 'offline';
    if (online && !allowed) {
        // Lua only hands animals over when allowed; never run online without it
        run.state = Object.assign({}, run.state, { running: false, finished: true, blocked: 'This is a Franchise zoo and "Find a habitat" is not allowed there. The animals are in the zoo; place them with the Species board or the game\'s own Move.' });
        render();
        return;
    }
    const final = await runPlacement(ids, {
        facts: askFacts,
        move: askMove,
        sleep: sleepUnlessStopped,
        paceMs: () => getPaceMs('moves'),
        online,
        isStopped: () => !!(run && run.stopping),
        onUpdate: st => {
            if (!run) return;
            run.state = st;
            render();
        },
    });
    if (run) {
        run.state = final;
        run.stopping = false;
    }
    render();
    breadcrumb('send_run_end');
    // the Species board and kin surfaces: read the zoo again
    import('/js/mods/pz2qol/kin.js').then(m => m.requestKinScan && m.requestKinScan('move', { force: true, delay: 500 })).catch(() => {});
}

function installPark() {
    engine.on('PZ2QoL_SendFactsResult', (reqId, json) => {
        let v = null;
        try {
            v = JSON.parse(json);
        }
        catch (e) {
            v = null;
        }
        answer(reqId, v);
    });
    engine.on('PZ2QoL_SendMoveResult', (reqId, ok, detail) => answer(reqId, { ok: ok === true, detail: detail ? String(detail) : '' }));
    engine.on('PZ2QoL_SendArrived', (seq, csv, allowed) => {
        try {
            engine.trigger('PZ2QoL_SendAck', seq);
        }
        catch (e) {
            // Lua re-sends on the next hello
        }
        if (seq === lastSeq) return;
        lastSeq = seq;
        startRun(seq, csv, allowed === true).catch(e => reportError('mod', '"Find a habitat" run failed', e));
    });
    // a reloaded page picks up animals that arrived meanwhile
    try {
        engine.trigger('PZ2QoL_SendHello');
    }
    catch (e) {
        // no Lua (harness)
    }
}

// ------------------------------------------------------------------ install

let installed = false;

export function installStorageSend() {
    if (installed) return true;
    if (typeof engine === 'undefined') return false;
    installed = true;
    loadCSS('mods/pz2qol_storagesend');
    if (isFrontendPage()) installHub();
    if (isHudPage()) installPark();
    return true;
}
