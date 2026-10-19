// Helpers shared by the two stores that keep the player's data in the
// game's player save through the Lua side: userstore.js (one set per zoo)
// and prefs.js (one set for the player, across zoos). No state here.

// JSON with every non-ASCII character as \uXXXX (the Lua side keeps it as is)
export function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

// the session's copy in localStorage (Gameface keeps it in memory only), or {}
export function readMirror(key) {
    try {
        const raw = window.localStorage && window.localStorage.getItem(key);
        const v = raw ? JSON.parse(raw) : {};
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    }
    catch (e) {
        return {};
    }
}

export function writeMirror(key, data) {
    try {
        if (window.localStorage) window.localStorage.setItem(key, JSON.stringify(data));
    }
    catch (e) {
        // the file is the real store
    }
}

// the stored text as an object ({} when empty); throws on bad JSON
export function parseStored(text) {
    const v = text ? JSON.parse(text) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// Applies changes made before the file was read ([key, fn] pairs, fn(old)
// -> new, undefined removes) on top of the file's data, in order. One bad
// change never loses the file.
export function replayChanges(base, pending) {
    const merged = Object.assign({}, base);
    for (const [k, fn] of pending) {
        try {
            const v = fn(merged[k]);
            if (v === undefined) delete merged[k];
            else merged[k] = v;
        }
        catch (e) {
            // skipped
        }
    }
    return merged;
}

// calls every listener; a listener never breaks the store
export function callAll(listeners, ...args) {
    listeners.forEach(fn => {
        try {
            fn(...args);
        }
        catch (e) {
            // ignored
        }
    });
}
