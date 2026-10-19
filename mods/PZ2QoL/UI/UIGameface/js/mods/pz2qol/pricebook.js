// Price book: remembers the CC listings you have seen on the Animal Market
// and your own trade history, so the storage lister can compare prices.
//
// Purely passive: it reads the DataStore lists the game already filled for
// the screen you are looking at. It never requests data itself.
import { listingKey, medalOf, mergeListings } from '/js/mods/pz2qol/pricing.js';
import { geneScore } from '/js/mods/pz2qol/scores.js';
import { childrenOf, HISTORY_LIST, MARKET_LIST, readAnimal } from '/js/mods/pz2qol/game.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { dlog } from '/js/mods/pz2qol/debuglog.js';

// v2: keyed by listingKey(). v1 keyed by row id (a screen slot) and is dropped.
const STORAGE_KEY = 'PZ2QoL.priceBook.v2';
const OLD_STORAGE_KEYS = ['PZ2QoL.priceBook.v1'];
const MAX_ENTRIES = 3000;
let book = [];
const listeners = new Set();

function load() {
    try {
        if (window.localStorage) OLD_STORAGE_KEYS.forEach(k => window.localStorage.removeItem(k));
        const raw = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) book = mergeListings(parsed, [], Date.now());
        }
    }
    catch (e) {
        // storage unavailable: keep the book in memory for this session
    }
}

function save() {
    try {
        if (window.localStorage) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(book));
    }
    catch (e) {
        // ignore; in-memory book still works
    }
}

function toListing(ctx, source) {
    const a = readAnimal(ctx);
    return {
        id: listingKey(a),
        species: a.species,
        gender: a.gender,
        maturity: a.maturity,
        isShoal: a.isShoal,
        isExhibit: a.isExhibit,
        score: geneScore(a),
        // not part of the id: one animal always shows the same medal, and
        // keeping the v2 key lets older entries pick it up when seen again
        medal: medalOf(a),
        // the colour morph label as the row shows it; not in the id either
        colormorph: typeof a.colormorph === 'string' && a.colormorph.trim() ? a.colormorph.trim() : undefined,
        price: a.price,
        isCC: a.isCC,
        source,
    };
}

let lastSignature = '';
let morphSeen = false;
// debug trace, once: what a colour morph label looks like in game (unproven)
function traceMorph(valid) {
    if (morphSeen) return;
    const l = valid.find(x => x.colormorph);
    if (!l) return;
    morphSeen = true;
    breadcrumb(/^\[.*\]$/.test(l.colormorph) ? 'price_morph_token' : 'price_morph_text');
}

export function recordVisibleListings() {
    const observed = [];
    for (const ctx of childrenOf(MARKET_LIST)) observed.push(toListing(ctx, 'market'));
    for (const ctx of childrenOf(HISTORY_LIST)) observed.push(toListing(ctx, 'history'));
    const valid = observed.filter(l => l.id != undefined && l.price > 0 && l.species);
    const signature = valid.map(l => `${l.source}:${l.id}:${l.price}:${l.medal}:${l.colormorph || ''}`).join('|');
    if (signature == lastSignature) {
        return 0;
    }
    lastSignature = signature;
    traceMorph(valid);
    book = mergeListings(book, valid, Date.now());
    if (book.length > MAX_ENTRIES) {
        book.sort((x, y) => y.seenAt - x.seenAt);
        book.length = MAX_ENTRIES;
    }
    save();
    // the debug log: what was recorded (only when the visible listings changed)
    try {
        const per = {};
        for (const l of valid) {
            const k = `${l.species}:${l.source}${l.isCC ? '' : ':nocc'}`;
            per[k] = (per[k] || 0) + 1;
        }
        dlog('pricing', 'book_recorded', { observed: observed.length, valid: valid.length, book: book.length, per });
    }
    catch (e) {
        // never stops recording
    }
    listeners.forEach(fn => fn(book));
    return valid.length;
}

export function getPriceBook() {
    return book;
}

export function countForSpecies(species) {
    return book.filter(l => l.species == species && l.isCC).length;
}

export function onPriceBookChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// Adds listings from elsewhere (e.g. an import or a test fixture).
export function mergeIntoPriceBook(listings) {
    book = mergeListings(book, listings, Date.now());
    save();
    listeners.forEach(fn => fn(book));
}

export function clearPriceBook() {
    book = [];
    lastSignature = '';
    save();
    listeners.forEach(fn => fn(book));
}

export function installPriceBook() {
    load();
    // Reads only what is already on screen; cheap when nothing changed.
    setInterval(() => {
        try {
            recordVisibleListings();
        }
        catch (e) {
            reportError('ui', 'Price recording failed', e, { silent: true });
        }
    }, 1500);
}
