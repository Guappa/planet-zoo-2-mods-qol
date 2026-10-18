// The player's own PZ2QoL data that must outlast the game session (habitat
// assignments...), one set per zoo. Gameface keeps localStorage in memory
// only, and the game's file calls are retail stubs, so the Lua side keeps
// the data on this device in the game's player save (the mod's own PZ2QoL
// entry, keyed by zoo), in every zoo, Franchise included: that save is not
// the zoo's online save (PZ2QoL_StoreLoad / PZ2QoL_StoreSave;
// PZ2QoL_StoreReset when the zoo's data can be read, or a park starts or ends).
//
// localStorage stays a mirror for the session, and the fallback when the
// store cannot be used (status 'memory', reason from the Lua side; 'wait'
// means the zoo or the player profile is not known yet, and a
// PZ2QoL_StoreReset follows). The store is the truth once read: changes
// made before that are kept as operations and applied again on top of it.
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';

const MIRROR_KEY = 'PZ2QoL.userdata.v1';
const ANSWER_TIMEOUT_MS = 6000;
const SAVE_DELAY_MS = 400;

let data = readMirror();
let status = 'loading'; // 'loading' | 'file' (kept on this device) | 'memory'
let reason = ''; // why 'memory': wait | noplayer | nopark | failed | nolua
let installed = false;
let reqSeq = 0;
let loadReq = null;
let loadParts = [];
let loadTimer = null;
let saveTimer = null;
let pending = []; // [key, fn] changes made before the file was read
let epoch = 0; // counts reads of the store: a new zoo load gives a new one
const listeners = new Set();

function readMirror() {
    try {
        const raw = window.localStorage && window.localStorage.getItem(MIRROR_KEY);
        const v = raw ? JSON.parse(raw) : {};
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    }
    catch (e) {
        return {};
    }
}

function writeMirror() {
    try {
        if (window.localStorage) window.localStorage.setItem(MIRROR_KEY, JSON.stringify(data));
    }
    catch (e) {
        // the file is the real store
    }
}

// JSON with every non-ASCII character as \uXXXX (the Lua side keeps it as is)
export function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

function notify() {
    listeners.forEach(fn => {
        try {
            fn(status);
        }
        catch (e) {
            // a listener never breaks the store
        }
    });
}

function setStatus(s) {
    if (status === s) return;
    status = s;
    breadcrumb('store_' + s);
    notify();
}

function finishLoad(ok, text) {
    clearTimeout(loadTimer);
    loadReq = null;
    epoch++;
    if (!ok) {
        reason = String(text || 'nopark');
        setStatus('memory');
        notify();
        return;
    }
    reason = '';
    let fromFile = {};
    try {
        const v = text ? JSON.parse(text) : {};
        if (v && typeof v === 'object' && !Array.isArray(v)) fromFile = v;
    }
    catch (e) {
        reportError('mod', 'PZ2QoL park data could not be read; starting from this session\'s data', e, { silent: true });
    }
    // the store is this zoo's truth: what the session held before (another
    // zoo's data, a mirror) is not carried over, only this view's changes
    const merged = Object.assign({}, fromFile);
    const needSave = pending.length > 0;
    // this session's changes, again on top of the file
    for (const [k, fn] of pending) {
        try {
            const v = fn(merged[k]);
            if (v === undefined) delete merged[k];
            else merged[k] = v;
        }
        catch (e) {
            // one bad change never loses the file
        }
    }
    pending = [];
    data = merged;
    writeMirror();
    setStatus('file');
    notify();
    if (needSave) scheduleSave(0);
}

function install() {
    if (installed || typeof engine === 'undefined') return;
    installed = true;
    engine.on('PZ2QoL_StoreData', (reqId, ok, i, n, text) => {
        if (String(reqId) !== loadReq) return;
        if (ok !== true) return finishLoad(false, text);
        loadParts[Number(i) - 1] = String(text || '');
        const parts = Number(n) || 1;
        let have = 0;
        for (let k = 0; k < parts; k++) if (typeof loadParts[k] === 'string') have++;
        if (have >= parts) finishLoad(true, loadParts.slice(0, parts).join(''));
    });
    engine.on('PZ2QoL_StoreSaved', (reqId, ok) => {
        if (ok !== true) {
            reportError('mod', 'PZ2QoL could not keep its data; changes last until the game closes', 'PZ2QoL_StoreSave', { silent: true });
            reason = reason || 'failed';
            setStatus('memory');
        }
    });
    // the Lua side (re)connected: read the store if we could not before
    engine.on('PZ2QoL_Hello', () => {
        if (status === 'file') return;
        loadReq = null; // a request sent before the Lua side was there is never answered
        loadUserData();
    });
    // a park started or ended, or its save was loaded: read the store again
    engine.on('PZ2QoL_StoreReset', () => {
        clearTimeout(saveTimer);
        epoch++;
        if (status === 'file') status = 'loading';
        loadReq = null;
        loadUserData();
    });
}

// Reads the file (again). Resolves when it is read or given up on.
export function loadUserData() {
    install();
    if (typeof engine === 'undefined') {
        setStatus('memory');
        return;
    }
    if (loadReq) return;
    loadReq = 'L' + (++reqSeq);
    loadParts = [];
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
        if (loadReq) {
            loadReq = null;
            // no answer: the Lua side is not there (yet); PZ2QoL_Hello retries
            if (status === 'loading') {
                reason = 'nolua';
                setStatus('memory');
            }
        }
    }, ANSWER_TIMEOUT_MS);
    try {
        engine.trigger('PZ2QoL_StoreLoad', loadReq);
    }
    catch (e) {
        clearTimeout(loadTimer);
        loadReq = null;
        setStatus('memory');
    }
}

function scheduleSave(delay = SAVE_DELAY_MS) {
    if (status !== 'file') {
        return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            engine.trigger('PZ2QoL_StoreSave', 'S' + (++reqSeq), asciiJson(data));
        }
        catch (e) {
            reportError('mod', 'PZ2QoL data could not be saved', e, { silent: true });
        }
    }, delay);
}

export function getUserData(key) {
    return data[key];
}

// fn(old value) -> new value (undefined removes it). It must give the right
// result when applied again to newer data: a change made before the file
// was read is replayed on top of the file.
export function updateUserData(key, fn) {
    const v = fn(data[key]);
    if (v === undefined) delete data[key];
    else data[key] = v;
    if (status !== 'file') pending.push([key, fn]);
    writeMirror();
    scheduleSave();
}

export function setUserData(key, value) {
    updateUserData(key, () => value);
}

// 'loading' | 'file' (kept on this device) | 'memory' (until the game closes)
export function userDataStatus() {
    return status;
}

// why the status is 'memory': wait, noplayer, nopark, failed, nolua ('' otherwise)
export function userDataReason() {
    return status === 'memory' ? reason : '';
}

// Changes each time the store is read again (a park started, ended or was
// loaded): entity ids seen under an older epoch may belong to another load.
export function userDataEpoch() {
    return epoch;
}

export function onUserData(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// test hook
export function _resetUserStoreForTests(value = {}) {
    data = value;
    status = 'loading';
    reason = '';
    pending = [];
    loadReq = null;
    epoch++;
}
