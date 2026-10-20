// "Bring to the trade centre": every stored animal of one species, from the
// hub's Animal Storage to this zoo's trade centre. The developer's idea
// (2026-10-18); design in docs/PLAN-storage-to-trade-centre.md.
//
// Park (HUD page): fetchRow(model, species, opts) is the Species board's
//   button (pinned trade column). One click asks Lua (PZ2QoL_FetchStart) to
//   open Animal Storage the way the game's own buttons do, with the park's
//   own animals of the species (never sent again). The board closes.
// Hub (Frontend page): Lua hands the request over (PZ2QoL_FetchPending,
//   fresh only the first time). With Animal Storage on screen the page
//   narrows it to the species, clears the game's own filters if they hide
//   rows, ticks the species' animals (adults first, up to the trade
//   centre's room) and, after a 3 s countdown (fresh) or the card's Send
//   (any later visit), checks the selection once more and presses the
//   game's own Send to Zoo once, armed for 'trade' (storagesend.js
//   armAndSend). Back in the zoo storagesend.js sends each arrival to the
//   trade centre, one at a time.
// "Bring all" (fetchAllRow, the developer 2026-10-19): the same with every
//   species at once (species ALL_SPECIES): no species chip, every stored
//   animal not already in this zoo is ticked, up to the room.
// Nothing new is sent to Frontier: the game's own Send to Zoo, then the game's
// own Move-screen trade-centre sequence per animal.
import { loadCSS } from '/js/common/util/CSSUtil.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { childKey, childrenOf, get, locationName, STORAGE_ACTIONS, STORAGE_DATA, STORAGE_LIST } from '/js/mods/pz2qol/game.js';
import { getStorageKinModel, isBreedingHeatmapOn, setBreedingHeatmap } from '/js/mods/pz2qol/kin.js';
import { isFrontendPage, isHudPage } from '/js/mods/pz2qol/kinhooks.js';
import { nativeFiltersOn } from '/js/mods/pz2qol/listercore.js';
import { deskFilters } from '/js/mods/pz2qol/listerlua.js';
import { getStorageFilters, setStorageFilters } from '/js/mods/pz2qol/listfilter.js';
import { speciesName } from '/js/mods/pz2qol/speciesnames.js';
import { armAndSend } from '/js/mods/pz2qol/storagesend.js';
import { canOpenTrade, getStorageCounts, getTradeCentreInfo, requestStorageCounts } from '/js/mods/pz2qol/tradejump.js';
import { h, icon } from '/js/mods/pz2qol/ui.js';
import {
    ALL_SPECIES, COUNTDOWN_MS, excludeList, fetchName, isAllSpecies, sameSpecies, fetchBlockReason, fetchNote, leftLines, parseExclude, pickedText, pickRows, sameKeys, START_ERRORS, TICK_WAIT_MS,
} from '/js/mods/pz2qol/storagefetchcore.js';

const ANSWER_TIMEOUT_MS = 6000;
const ROWS_WAIT_MS = 3000;
const GUID_WAIT_MS = 3000;
const HUB_TICK_MS = 500;
const ERROR_SHOW_MS = 9000;

const wait = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------ park: button

let reqSeq = 0;
const waiting = new Map();
let listening = false;

function listen() {
    if (listening || typeof engine === 'undefined') return;
    listening = true;
    engine.on('PZ2QoL_FetchStartResult', (reqId, ok, detail, room) => {
        const done = waiting.get(String(reqId));
        if (!done) return;
        waiting.delete(String(reqId));
        done({ ok: ok === true, detail: detail ? String(detail) : '', room: Number(room) });
    });
}

function askStart(species, exclude) {
    listen();
    if (typeof engine === 'undefined') return Promise.resolve({ ok: false, detail: 'noanswer' });
    const reqId = 'f' + (++reqSeq);
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            if (waiting.delete(reqId)) resolve({ ok: false, detail: 'noanswer' });
        }, ANSWER_TIMEOUT_MS);
        waiting.set(reqId, v => {
            clearTimeout(timer);
            resolve(v);
        });
        try {
            engine.trigger('PZ2QoL_FetchStart', reqId, String(species), exclude);
        }
        catch (e) {
            waiting.delete(reqId);
            clearTimeout(timer);
            resolve({ ok: false, detail: 'noanswer' });
        }
    });
}

let starting = false;
let lastError = null; // { species, text, until }

async function start(model, species, opts) {
    if (starting) return { ok: false, text: START_ERRORS.busy };
    starting = true;
    try {
        // the game won't open the hub while a heat map panel is open
        if (isBreedingHeatmapOn()) {
            try {
                await setBreedingHeatmap(false);
            }
            catch (e) {
                // Lua closes heat maps on the way out anyway
            }
        }
        const animals = model && model.animals ? Array.from(model.animals.values()) : [];
        breadcrumb('fetch_click');
        const r = await askStart(species, excludeList(animals, species));
        if (r.ok) return { ok: true, text: '' };
        breadcrumb('fetch_click_failed');
        return { ok: false, text: START_ERRORS[r.detail] || `The hub did not open (${r.detail})` };
    }
    finally {
        starting = false;
    }
}

// The Species board's "Bring <species> to the trade centre" row (pinned trade
// column). opts: { onOpened(), onError(text) }. null outside the park page.
export function fetchRow(model, species, opts = {}) {
    if (!species || !isHudPage()) return null;
    return buildRow(model, species, opts);
}

// "Bring all stored animals to the trade centre": every species at once, in
// the same place (any species picked on the board asks for the room).
export function fetchAllRow(model, opts = {}) {
    if (!isHudPage()) return null;
    return buildRow(model, ALL_SPECIES, opts);
}

function buildRow(model, species, opts) {
    const { onOpened = () => {}, onError = () => {}, countsFor = null } = opts;
    const all = isAllSpecies(species);
    requestStorageCounts([all ? countsFor : species].filter(Boolean));
    const name = fetchName(species, speciesName);
    const c = all ? null : getStorageCounts(species);
    const tc = getTradeCentreInfo() || {};
    const hasTradeCentre = model && model.tradeCentre ? true : tc.tc === false ? false : undefined;
    const state = { tradeBlock: canOpenTrade(), hasTradeCentre, tcNow: tc.tcNow, tcMax: tc.tcMax, adults: c ? c.m + c.f : null, speciesName: name, mode: model && model.mode, all };
    const why = fetchBlockReason(state);
    const err = lastError && lastError.species === species && Date.now() < lastError.until ? lastError.text : '';
    const note = h(`div.PZ2QoL_kbFetchNote${why || err ? '.warn' : ''}`, { text: why || err || fetchNote(state) });
    const btn = h(`div.PZ2QoL_kbFetchBtn${why ? '.disabled' : ''}${all ? '.all' : ''}`, {
        'data-fetch': species,
        title: all
            ? "Opens Animal Storage, ticks every stored animal of every species that isn't already in this zoo and sends them with the game's own Send to Zoo. Back in the zoo each one goes to the trade centre, one at a time. Adults first; young too if there is room."
            : `Opens Animal Storage, ticks every stored ${name} and sends them with the game's own Send to Zoo. Back in the zoo each one goes to the trade centre, one at a time. Adults first; young too if there is room.`,
        onClick: () => {
            if (btn.classList.contains('disabled')) return;
            btn.classList.add('disabled');
            start(model, species, opts).then(r => {
                btn.classList.remove('disabled');
                if (r.ok) {
                    lastError = null;
                    try {
                        onOpened();
                    }
                    catch (e) {
                        reportError('ui', 'Bring to the trade centre: closing the board failed', e, { silent: true });
                    }
                    return;
                }
                lastError = { species, text: r.text, until: Date.now() + ERROR_SHOW_MS };
                note.textContent = r.text;
                note.classList.add('warn');
                try {
                    onError(r.text);
                }
                catch (e) {
                    // the note shows it anyway
                }
            }, e => reportError('mod', 'Bring to the trade centre failed', e));
        },
    }, icon('Icon_Animal_Trading', all ? 'brown' : 'white', 'sm'), h('span', { text: all ? 'Bring all stored animals to the trade centre' : `Bring ${name} to the trade centre` }));
    return h(`div.PZ2QoL_kbFetch${all ? '.all' : ''}`, null, btn, note);
}

// ------------------------------------------------------------------- hub

let pending = null;       // { seq, species, room, exclude, fresh }
let job = null;           // the request being worked on
const done = new Set();   // seqs sent or cancelled
let card = null;
let visibleSince = 0;

function isVisible(sel) {
    const node = document.querySelector(sel);
    if (!node) return false;
    const r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    for (let n = node; n && n !== document.body; n = n.parentNode) {
        if (n.classList && n.classList.contains('hidden')) return false;
    }
    return true;
}

function trigger(name, ...args) {
    try {
        engine.trigger(name, ...args);
        return true;
    }
    catch (e) {
        return false;
    }
}

function selected() {
    const v = get(STORAGE_DATA, 'selectedAnimalIDs');
    return Array.isArray(v) ? v.map(String) : [];
}

function storageRows() {
    const model = getStorageKinModel();
    return childrenOf(STORAGE_LIST).map(ctx => {
        const id = get(ctx, 'id');
        const a = model && id != null ? model.animals.get(String(id)) : null;
        return {
            id: id == null ? null : String(id),
            key: childKey(ctx),
            name: locationName(get(ctx, 'name')) || '',
            species: get(ctx, 'species'),
            sex: get(ctx, 'gender'),
            maturity: get(ctx, 'maturity'),
            isShoal: !!get(ctx, 'isShoal'),
            isMoving: !!get(ctx, 'isMoving'),
            auctionTimerSeconds: get(ctx, 'auctionTimerSeconds'),
            guid: a && a.guid ? String(a.guid) : null,
        };
    });
}

function closeCard() {
    if (curtain) curtain.remove();
    curtain = null;
    card = null;
}

// The species chip was only the job's means: take it off again (unless the
// player has picked something else meanwhile).
function dropChip(j) {
    try {
        if (j && j.chip && sameSpecies((getStorageFilters() || {}).species, j.species)) setStorageFilters({ species: '' });
    }
    catch (e) {
        // the chip stays; one click clears it
    }
}

// The job is over (sent, stopped, cancelled or Storage left): curtain off.
function endJob() {
    const j = job;
    if (!j) return closeCard();
    clearInterval(j.timer);
    job = null;
    closeCard();
    // after a send the selection no longer matters (the game has the ids)
    dropChip(j);
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

// A curtain over Animal Storage while the mod works there (the developer:
// the player shouldn't watch the list being filtered and ticked), with the
// card in the middle. It also stops stray clicks changing the selection.
let curtain = null;
let waitingSince = 0; // a request is in, Storage is not on screen yet
const WAITING_MAX_MS = 10000;
const SENT_SHOW_MS = 8000;

function openCurtain() {
    if (curtain) return;
    card = h('div.PZ2QoL_ssCard.PZ2QoL_sfCard');
    curtain = h('div.PZ2QoL_sfCurtain', null, card);
    document.body.appendChild(curtain);
}

function panel(title, lines, { busy = false, buttons = [] } = {}) {
    openCurtain();
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(h('div.PZ2QoL_ssHead', null,
        busy ? h('div.PZ2QoL_sfSpinner') : null,
        h('div.PZ2QoL_ssTitle', { text: title })));
    for (const l of lines) if (l) card.appendChild(l);
    if (buttons.length) card.appendChild(h('div.PZ2QoL_ssButtons', null, ...buttons));
}

function renderWaiting(p) {
    panel(`Bringing your ${fetchName(p.species, speciesName)} to the trade centre`, [h('div.PZ2QoL_ssLine', { text: 'Opening your Animal Storage…' })], { busy: true });
}

function render() {
    if (!job) return closeCard();
    const j = job;
    const lines = [];
    if (j.pick) lines.push(h('div.PZ2QoL_ssLine', { text: pickedText(j.pick, j.room) }));
    for (const line of j.notes) lines.push(h('div.PZ2QoL_ssItem.skip', { text: line }));
    const title = `Bringing your ${j.name} to the trade centre`;
    if (j.phase === 'prepare') {
        lines.push(h('div.PZ2QoL_ssLine', { text: 'Finding them in your storage…' }));
        panel(title, lines, { busy: true, buttons: [cardButton('Cancel', () => cancel())] });
    }
    else if (j.phase === 'countdown') {
        const s = Math.max(1, Math.ceil((j.deadline - Date.now()) / 1000));
        lines.push(h('div.PZ2QoL_ssLine.done', { text: `Sending in ${s}…` }));
        panel(title, lines, { busy: true, buttons: [cardButton('Send now', () => send()), cardButton('Cancel', () => cancel(), 'stop')] });
    }
    else if (j.phase === 'ready') {
        lines.push(h('div.PZ2QoL_ssLine.done', { text: 'Send them to the zoo? Each one then waits in its trade centre.' }));
        panel(`Bring your ${j.name} to the trade centre`, lines, { buttons: [cardButton('Send', () => send()), cardButton('Cancel', () => cancel(), 'stop')] });
    }
    else if (j.phase === 'sent') {
        lines.push(h('div.PZ2QoL_ssLine.done', { text: 'Sent with the game\'s Send to Zoo. Back to your zoo…' }));
        panel(title, lines, { busy: true });
    }
    else {
        lines.push(h('div.PZ2QoL_ssLine.done', { text: j.stop || 'Stopped.' }));
        panel(`Bring your ${j.name} to the trade centre`, lines, { buttons: [cardButton('Close', () => endJob())] });
    }
}

function ack(seq) {
    done.add(seq);
    trigger('PZ2QoL_FetchAck', seq);
}

// The end of a job that sent nothing: ticks cleared, the reason shown.
function stop(text, { keep = false } = {}) {
    if (!job) return;
    if (!keep) ack(job.seq);
    trigger('AnimalStorage_SelectAllToggled', false);
    clearInterval(job.timer);
    job.phase = 'stopped';
    job.stop = text;
    breadcrumb('fetch_hub_stop');
    render();
}

function cancel() {
    if (!job || job.phase === 'sent') return;
    breadcrumb('fetch_hub_cancel');
    ack(job.seq);
    trigger('AnimalStorage_SelectAllToggled', false);
    endJob();
}

function send() {
    const j = job;
    if (!j || (j.phase !== 'countdown' && j.phase !== 'ready')) return;
    clearInterval(j.timer);
    // exactly the animals ticked for this: nothing else, nothing missing
    const now = selected();
    if (!sameKeys(now, j.keys)) return stop('The selection changed; nothing was sent.');
    if (get(STORAGE_ACTIONS, 'sendToZooAllowed') === false) return stop("The game won't send this selection to the zoo right now.");
    ack(j.seq);
    j.phase = 'sent';
    render();
    if (!armAndSend(now, 'trade')) return stop('The game could not be asked; nothing was sent.');
    breadcrumb('fetch_hub_sent');
    // the hub page outlives the switch to the zoo and is drawn over it: the
    // curtain must go even if Storage still reads as visible (proven 2026-10-18)
    setTimeout(() => {
        if (job === j && j.phase === 'sent') endJob();
    }, SENT_SHOW_MS);
}

async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (test()) return true;
        await wait(150);
    }
    return test();
}

async function runJob(p) {
    const all = isAllSpecies(p.species);
    const j = job = { seq: p.seq, species: p.species, name: fetchName(p.species, speciesName), room: p.room, fresh: p.fresh, phase: 'prepare', notes: [], keys: [], pick: null, timer: null };
    render();
    breadcrumb(p.fresh ? 'fetch_hub_start' : 'fetch_hub_again');
    const alive = () => job === j && j.phase === 'prepare';
    // all species: no chip, and none left from an earlier species jump
    if (all) {
        if ((getStorageFilters() || {}).species) setStorageFilters({ species: '' });
    }
    else {
        setStorageFilters({ species: p.species });
        j.chip = true;
    }
    // the game's own filters may hide some of them: clear them as the Market
    // desk does (put back when Storage closes)
    const active = nativeFiltersOn(k => get(STORAGE_DATA.concat('filters'), k));
    if (active.length) {
        const a = await deskFilters('clear');
        if (!alive()) return;
        if (!a || !a.ok) j.notes.push('Your storage filters hide some animals; only the ones shown can be sent.');
        await wait(700);
    }
    await waitFor(() => storageRows().some(r => all || sameSpecies(r.species, p.species)), ROWS_WAIT_MS);
    if (!alive()) return;
    const exclude = parseExclude(p.exclude);
    // the park's animals are matched by GUID when the storage lineage is in
    if (exclude.guids.size) await waitFor(() => !!getStorageKinModel(), GUID_WAIT_MS);
    if (!alive()) return;
    const pick = pickRows(storageRows(), { species: p.species, room: p.room, exclude });
    j.pick = pick;
    j.notes.push(...leftLines(pick));
    if (!pick.picked.length) return stop(all ? 'Nothing in storage to bring.' : `No ${j.name} in storage to bring.`);
    j.keys = pick.picked.map(r => String(r.key));
    trigger('AnimalStorage_SelectAllToggled', false);
    for (const r of pick.picked) trigger('AnimalStorage_ItemCheckboxToggled', r.id, true);
    const ticked = await waitFor(() => sameKeys(selected(), j.keys), TICK_WAIT_MS);
    if (!alive()) return;
    if (!ticked) return stop('The game did not tick the animals; nothing was sent.');
    // the panel's own Send to Zoo state follows the selection a moment later
    await waitFor(() => get(STORAGE_ACTIONS, 'sendToZooAllowed') !== false, 1000);
    if (!alive()) return;
    if (get(STORAGE_ACTIONS, 'sendToZooAllowed') === false) return stop("The game won't send this selection to the zoo right now.");
    if (p.fresh) {
        j.phase = 'countdown';
        j.deadline = Date.now() + COUNTDOWN_MS;
        j.timer = setInterval(() => {
            if (job !== j || j.phase !== 'countdown') return clearInterval(j.timer);
            if (Date.now() >= j.deadline) send();
            else render();
        }, 250);
    }
    else {
        j.phase = 'ready';
    }
    render();
}

function hello() {
    trigger('PZ2QoL_FetchHello');
}

function hubTick() {
    try {
        const vis = isVisible('.AnimalMarketStorage_header');
        if (vis && !visibleSince) {
            visibleSince = Date.now();
            hello();
        }
        if (!vis) {
            visibleSince = 0;
            if (job) {
                // Storage left (or the zoo loaded after the send): the curtain
                // goes. Left before sending: nothing is sent; Lua keeps the
                // request, and the next visit asks for a click
                if (job.phase !== 'sent' && job.phase !== 'stopped') breadcrumb('fetch_hub_left');
                endJob();
            }
            // a request is in and Storage is on its way: cover it from the
            // first frame (at most WAITING_MAX_MS, then the request waits)
            if (pending) {
                if (!waitingSince) waitingSince = Date.now();
                if (Date.now() - waitingSince < WAITING_MAX_MS) renderWaiting(pending);
                else closeCard();
            }
            else if (waitingSince) {
                waitingSince = 0;
                closeCard();
            }
            return;
        }
        waitingSince = 0;
        // a finished job never blocks the next request
        if (pending && job && (job.phase === 'sent' || job.phase === 'stopped')) endJob();
        if (!pending || job) return;
        const p = pending;
        pending = null;
        runJob(p).catch(e => {
            reportError('mod', 'Bring to the trade centre (storage) failed', e);
            if (job) stop('Something went wrong; nothing was sent.', { keep: true });
        });
    }
    catch (e) {
        reportError('ui', 'Bring to the trade centre: the storage step failed', e, { silent: true });
    }
}

function installHub() {
    engine.on('PZ2QoL_FetchPending', (seq, species, room, exclude, fresh) => {
        if (!species || done.has(seq)) {
            if (done.has(seq)) trigger('PZ2QoL_FetchAck', seq);
            return;
        }
        if (job && job.seq === seq) return;
        pending = { seq, species: String(species), room: Number.isFinite(Number(room)) ? Number(room) : -1, exclude: String(exclude || ''), fresh: fresh === true };
        breadcrumb(fresh === true ? 'fetch_pending_fresh' : 'fetch_pending_again');
    });
    setInterval(hubTick, HUB_TICK_MS);
    hello();
}

// --------------------------------------------------------------- install

let installed = false;

export function installStorageFetch() {
    if (installed) return true;
    if (typeof engine === 'undefined') return false;
    installed = true;
    loadCSS('mods/pz2qol_storagefetch');
    listen();
    if (isFrontendPage()) installHub();
    return true;
}

// Harness only.
export function _resetFetch() {
    if (job) clearInterval(job.timer);
    job = null;
    pending = null;
    waitingSince = 0;
    closeCard();
}

export function _fetchState() {
    return { pending, job: job ? { seq: job.seq, phase: job.phase, keys: job.keys.slice(), notes: job.notes.slice(), stop: job.stop || '' } : null, done: Array.from(done) };
}
