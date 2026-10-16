// The player's own PZ2QoL data that must outlast the game session (habitat
// assignments...). Gameface keeps localStorage in memory only: it is gone
// when the game closes. So the data lives in one file in the mod's folder
// (Win64\ovldata\PZ2QoL\userdata.json), read and written by the Lua side
// (PZ2QoL_StoreLoad / PZ2QoL_StoreSave). Never in the save or the profile.
//
// localStorage stays a mirror for the session, and the fallback when the
// file cannot be used (status 'memory'). Changes made before the file was
// read are kept as operations and applied again on top of the file.
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';

const MIRROR_KEY = 'PZ2QoL.userdata.v1';
const ANSWER_TIMEOUT_MS = 6000;
const SAVE_DELAY_MS = 400;

let data = readMirror();
let status = 'loading'; // 'loading' | 'file' | 'memory'
let installed = false;
let reqSeq = 0;
let loadReq = null;
let loadParts = [];
let loadTimer = null;
let saveTimer = null;
let pending = []; // [key, fn] changes made before the file was read
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
    if (!ok) {
        setStatus('memory');
        return;
    }
    let fromFile = {};
    try {
        const v = text ? JSON.parse(text) : {};
        if (v && typeof v === 'object' && !Array.isArray(v)) fromFile = v;
    }
    catch (e) {
        reportError('mod', 'PZ2QoL data file could not be read; starting from this session\'s data', e, { silent: true });
    }
    const merged = Object.assign({}, fromFile);
    let needSave = pending.length > 0;
    for (const [k, v] of Object.entries(data)) {
        // not in the file yet (e.g. kept by an earlier build in localStorage)
        if (!(k in fromFile)) {
            merged[k] = v;
            needSave = true;
        }
    }
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
        if (ok !== true) return finishLoad(false);
        loadParts[Number(i) - 1] = String(text || '');
        const parts = Number(n) || 1;
        let have = 0;
        for (let k = 0; k < parts; k++) if (typeof loadParts[k] === 'string') have++;
        if (have >= parts) finishLoad(true, loadParts.slice(0, parts).join(''));
    });
    engine.on('PZ2QoL_StoreSaved', (reqId, ok) => {
        if (ok !== true) {
            reportError('mod', 'PZ2QoL could not save its data file; changes are kept until the game closes', 'Win64\\ovldata\\PZ2QoL\\userdata.json', { silent: true });
            setStatus('memory');
        }
    });
    // the Lua side (re)connected: read the file if we could not before
    engine.on('PZ2QoL_Hello', () => {
        if (status === 'file') return;
        loadReq = null; // a request sent before the Lua side was there is never answered
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
            if (status === 'loading') setStatus('memory');
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

// 'loading' | 'file' (kept across restarts) | 'memory' (until the game closes)
export function userDataStatus() {
    return status;
}

export function onUserData(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// test hook
export function _resetUserStoreForTests(value = {}) {
    data = value;
    status = 'loading';
    pending = [];
    loadReq = null;
}
