// Client-side filtering and sorting of game lists (Animal Storage, and the
// zoo management Animals list).
//
// The lists are fed by DataStoreCollection instances bound to the list
// contexts; ManagementListComponent reads `collection.source`. We patch
// that getter so collections bound to a registered list return the
// filtered/sorted rows, and re-dispatch a "reset" when filters change.
import { DataStoreCollection } from '/js/common/data/DataStoreCollection.js';
import { applyStorageFilters, DEFAULT_STORAGE_FILTERS, storageFiltersActive } from '/js/mods/pz2qol/scores.js';
import { contextKey, readAnimal, STORAGE_LIST_KEY } from '/js/mods/pz2qol/game.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';

// key -> { filter(contexts) -> contexts, active() -> bool, selectAll: {...} }
const registry = new Map();
const liveCollections = new Map(); // key -> Set<collection>

// A list's select-all must only pick the rows the player can see while a
// filter is active, or a bulk action would include hidden animals.
//   selectAll: { event, matches(args) -> bool, clear(trigger), select(trigger, ctx) }
export function registerListFilter(key, spec) {
    registry.set(key, spec);
}

export function refreshList(key) {
    for (const col of liveCollections.get(key) || []) {
        try {
            col._onChange.dispatch({ target: col, changeKind: 'reset', index: -1, item: col.source, replacedItem: [] });
        }
        catch (e) {
            reportError('ui', 'List filter refresh failed', e);
        }
    }
}

// Unfiltered rows (contexts) of a registered list, from any live collection.
export function getListSource(key) {
    for (const col of liveCollections.get(key) || []) {
        return col._source;
    }
    return [];
}

function filtered(key, source) {
    const spec = registry.get(key);
    if (!spec || !spec.active() || source.length == 0) return source;
    return spec.filter(source);
}

// ------------------------------------------------------------- storage

let storageFilters = Object.assign({}, DEFAULT_STORAGE_FILTERS);
const listeners = new Set();

// Filters other modules contribute (Kin: `related`): key -> predicate(animal)
// on readAnimal() objects. Each applies while storageFilters[key] is on.
const storagePredicates = {};

export function addStorageFilter(key, predicate) {
    storagePredicates[key] = predicate;
    return () => {
        if (storagePredicates[key] === predicate) delete storagePredicates[key];
    };
}

export function getStoragePredicates() {
    return storagePredicates;
}

export function getStorageFilters() {
    return storageFilters;
}

export function setStorageFilters(patch) {
    storageFilters = Object.assign({}, storageFilters, patch);
    breadcrumb('storage_filter');
    // Hidden rows must never stay selected for a bulk action.
    try {
        engine.trigger('AnimalStorage_SelectAllToggled', false);
    }
    catch (e) {
        reportError('ui', 'Could not clear storage selection', e);
    }
    refreshList(STORAGE_LIST_KEY);
    listeners.forEach(fn => fn(storageFilters));
}

export function resetStorageFilters() {
    setStorageFilters(DEFAULT_STORAGE_FILTERS);
}

export function onStorageFiltersChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function getStorageSource() {
    return getListSource(STORAGE_LIST_KEY);
}

registerListFilter(STORAGE_LIST_KEY, {
    active: () => storageFiltersActive(storageFilters),
    filter: source => {
        const animals = source.map(ctx => Object.assign(readAnimal(ctx), { _ctx: ctx }));
        return applyStorageFilters(animals, storageFilters, storagePredicates).map(a => a._ctx);
    },
    selectAll: {
        matches: (name, args) => name === 'AnimalStorage_SelectAllToggled' && args[0] === true,
        clear: trigger => trigger('AnimalStorage_SelectAllToggled', false),
        select: (trigger, ctx) => {
            const id = readAnimal(ctx).id;
            if (id != undefined) trigger('AnimalStorage_ItemCheckboxToggled', id, true);
        },
    },
});

// ---------------------------------------------------------------- hooks

export function installSelectAllGuard() {
    if (typeof engine === 'undefined' || engine.__pz2qolGuard) {
        return false;
    }
    engine.__pz2qolGuard = true;
    const trigger = engine.trigger.bind(engine);
    engine.trigger = function (name, ...args) {
        for (const [key, spec] of registry) {
            const sa = spec.selectAll;
            if (!sa || !sa.matches(name, args) || !spec.active()) continue;
            try {
                breadcrumb('selectall_filtered');
                const visible = filtered(key, getListSource(key));
                sa.clear(trigger);
                for (const ctx of visible) sa.select(trigger, ctx);
                return;
            }
            catch (e) {
                reportError('ui', 'Filtered select-all failed; selection cleared for safety', e);
                return sa.clear(trigger);
            }
        }
        return trigger(name, ...args);
    };
    return true;
}

export function installListFilter() {
    const proto = DataStoreCollection.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'source');
    if (!desc || !desc.get || proto.__pz2qolPatched) {
        return false;
    }
    proto.__pz2qolPatched = true;
    Object.defineProperty(proto, 'source', {
        configurable: true,
        get() {
            const source = desc.get.call(this);
            const key = this._context ? contextKey(this._context) : null;
            if (key && registry.has(key)) {
                try {
                    return filtered(key, source);
                }
                catch (e) {
                    reportError('ui', 'List filter failed', e);
                }
            }
            return source;
        },
    });
    const bind = proto.bindToContext;
    proto.bindToContext = function (context, ...rest) {
        const ret = bind.call(this, context, ...rest);
        for (const set of liveCollections.values()) set.delete(this);
        const key = context ? contextKey(context) : null;
        if (key && registry.has(key)) {
            if (!liveCollections.has(key)) liveCollections.set(key, new Set());
            liveCollections.get(key).add(this);
        }
        return ret;
    };
    return true;
}
