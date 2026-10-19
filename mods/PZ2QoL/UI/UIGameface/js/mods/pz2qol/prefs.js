// The player's own PZ2QoL settings that hold across zoos (the breeding
// programme's optimiser choice...), one set for the player. userstore.js is
// per zoo; this one is not. The Lua side keeps it on this device in the
// game's player save (the mod's own PZ2QoL entry, area Prefs, at most 4000
// characters of ASCII JSON), in every zoo and in the hub, Franchise
// included: that save is not the zoo's online save (PZ2QoL_PrefsLoad /
// PZ2QoL_PrefsSave). It needs only the player profile, not a zoo.
//
// Read once per page, on first use. localStorage stays a mirror for the
// session, and the fallback when the store cannot be used (status
// 'memory': no answer within 6 s, no player profile, no Lua side). The
// store is the truth once read: changes made before that are kept as
// operations and applied again on top of it. An answer that arrives after
// the 6 s is still taken, and PZ2QoL_Hello (the Lua side came up) asks again.
//
// The hub page and the park page each keep a copy, so a save first reads
// the store again and puts only this page's changes since its last save on
// top: one page never wipes what the other saved.
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { asciiJson, readMirror, writeMirror, parseStored, replayChanges, callAll } from '/js/mods/pz2qol/storecore.js';

const MIRROR_KEY = 'PZ2QoL.prefs.v1';
const ANSWER_TIMEOUT_MS = 6000;
const SAVE_DELAY_MS = 400;
const SYNC_TIMEOUT_MS = 1000;   // a save's read gets no answer: save this page's copy

let data = readMirror(MIRROR_KEY);
let status = 'loading'; // 'loading' | 'file' (kept on this device) | 'memory'
let reason = ''; // why 'memory': noplayer | unavailable | failed | nolua
let started = false;
let installed = false;
let reqSeq = 0;
let loadReq = null; // the read asked for; stays set after the timeout so a late answer counts
let loadTimer = null;
let saveTimer = null;
let pending = []; // [key, fn] changes made before the file was read
let unsaved = []; // [key, fn] changes not saved yet (re-applied on the store's latest)
let syncReq = null; // the read a save waits for
let syncAgain = false; // a change came in while a save was under way
let syncTimer = null;
const listeners = new Set();

// fn(status, key): key is the changed setting, undefined after a load
function notify(key) {
    callAll(listeners, status, key);
}

function setStatus(s) {
    if (status === s) return;
    status = s;
    breadcrumb('prefs_' + s);
}

function finishLoad(ok, text) {
    clearTimeout(loadTimer);
    loadReq = null;
    if (!ok) {
        reason = String(text || 'unavailable');
        setStatus('memory');
        notify();
        return;
    }
    reason = '';
    let fromFile = {};
    try {
        fromFile = parseStored(text);
    }
    catch (e) {
        reportError('mod', 'PZ2QoL settings could not be read; starting from this session\'s settings', e, { silent: true });
    }
    // the store is the player's truth: only this page's changes go on top
    const needSave = pending.length > 0;
    data = replayChanges(fromFile, pending);
    pending = [];
    writeMirror(MIRROR_KEY, data);
    setStatus('file');
    notify();
    if (needSave) scheduleSave(0);
}

function install() {
    if (installed || typeof engine === 'undefined') return;
    installed = true;
    engine.on('PZ2QoL_PrefsData', (reqId, ok, text) => {
        if (syncReq !== null && String(reqId) === syncReq) return finishSync(ok === true, text);
        if (loadReq === null || String(reqId) !== loadReq) return;
        finishLoad(ok === true, text);
    });
    engine.on('PZ2QoL_PrefsSaved', (reqId, ok) => {
        if (ok !== true) {
            reportError('mod', 'PZ2QoL could not keep its settings; changes last until the game closes', 'PZ2QoL_PrefsSave', { silent: true });
            reason = 'failed';
            setStatus('memory');
            notify();
        }
    });
    // the Lua side (re)connected: read the store if we could not before
    engine.on('PZ2QoL_Hello', () => {
        if (status === 'file' || !started) return;
        ask();
    });
}

function ask() {
    loadReq = 'P' + (++reqSeq);
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
        // no answer: the Lua side is not there (yet); a late answer or
        // PZ2QoL_Hello still reads the store
        if (status === 'loading') {
            reason = 'nolua';
            setStatus('memory');
            notify();
        }
    }, ANSWER_TIMEOUT_MS);
    try {
        engine.trigger('PZ2QoL_PrefsLoad', loadReq);
    }
    catch (e) {
        clearTimeout(loadTimer);
        loadReq = null;
        reason = 'nolua';
        setStatus('memory');
        notify();
    }
}

// Reads the store, once per page (later calls do nothing). Every other
// function here calls it, so a first use starts the read.
export function loadPrefs() {
    if (started) return;
    started = true;
    install();
    if (typeof engine === 'undefined') {
        reason = 'nolua';
        setStatus('memory');
        return;
    }
    ask();
}

function scheduleSave(delay = SAVE_DELAY_MS) {
    if (status !== 'file') return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(startSync, delay);
}

// A save: read the store's latest first (the other page may have saved).
function startSync() {
    if (syncReq !== null) {
        syncAgain = true;
        return;
    }
    syncReq = 'S' + (++reqSeq);
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        if (syncReq !== null) finishSync(false, '');
    }, SYNC_TIMEOUT_MS);
    try {
        engine.trigger('PZ2QoL_PrefsLoad', syncReq);
    }
    catch (e) {
        syncReq = null;
        reportError('mod', 'PZ2QoL settings could not be saved', e, { silent: true });
    }
}

// The latest from the store, this page's changes on top, written back.
// No answer from the store: this page's copy is written as it is.
function finishSync(ok, text) {
    syncReq = null;
    clearTimeout(syncTimer);
    let changed = false;
    if (ok) {
        try {
            const merged = replayChanges(parseStored(text), unsaved);
            changed = asciiJson(merged) !== asciiJson(data);
            data = merged;
            writeMirror(MIRROR_KEY, data);
        }
        catch (e) {
            // keep this page's copy
        }
    }
    unsaved = [];
    try {
        engine.trigger('PZ2QoL_PrefsSave', 'Q' + (++reqSeq), asciiJson(data));
    }
    catch (e) {
        reportError('mod', 'PZ2QoL settings could not be saved', e, { silent: true });
    }
    // the other page had saved something new: tell this page's views
    if (changed) notify();
    if (syncAgain) {
        syncAgain = false;
        scheduleSave(0);
    }
}

export function getPref(key) {
    loadPrefs();
    return data[key];
}

// fn(old value) -> new value (undefined removes it). It must give the right
// result when applied again to newer data: a change made before the store
// was read is replayed on top of it.
export function updatePref(key, fn) {
    loadPrefs();
    const v = fn(data[key]);
    if (v === undefined) delete data[key];
    else data[key] = v;
    if (status !== 'file') pending.push([key, fn]);
    unsaved.push([key, fn]);
    writeMirror(MIRROR_KEY, data);
    scheduleSave();
    notify(key);
}

// undefined removes the setting
export function setPref(key, value) {
    updatePref(key, () => value);
}

// 'loading' | 'file' (kept on this device) | 'memory' (until the game closes)
export function prefsStatus() {
    loadPrefs();
    return status;
}

// why the status is 'memory': noplayer, unavailable, failed, nolua ('' otherwise)
export function prefsReason() {
    return status === 'memory' ? reason : '';
}

// fn(status, key) after the store is read (key undefined) and on every
// change (key = the setting). Returns the unsubscribe.
export function onPrefs(fn) {
    loadPrefs();
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// test hook
export function _resetPrefsForTests(value = {}) {
    clearTimeout(loadTimer);
    clearTimeout(saveTimer);
    data = value;
    status = 'loading';
    reason = '';
    pending = [];
    unsaved = [];
    syncReq = null;
    syncAgain = false;
    clearTimeout(syncTimer);
    loadReq = null;
    started = false;
}
