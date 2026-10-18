// Toolbars for the Animal Market (Trading) and Animal Storage screens.
//
// Plain DOM in our own root under <body>, positioned under the screen's
// header each tick. Nothing is inserted into the game's preact tree; the
// list is pushed down with a stylesheet rule so nothing overlaps.
import { MARKET_PRESETS, storageFiltersActive, storageSummary, applyStorageFilters, speciesStats, surplusIds, isAdult, isFertileAdult, isOnMarket, isSellable, sellBlockers, SELL_BLOCKERS } from '/js/mods/pz2qol/scores.js';
import { MARKET_EVENT, readAnimal, sendScreenEvent } from '/js/mods/pz2qol/game.js';
import { getStorageFilters, getStoragePredicates, getStorageSource, onStorageFiltersChanged, resetStorageFilters, setStorageFilters } from '/js/mods/pz2qol/listfilter.js';
import { getMarketDimBelow, setMarketDimBelow } from '/js/mods/pz2qol/badges.js';
import { reportError } from '/js/mods/pz2qol/errors.js';
import { isListerEnabled, onListerSettingChanged, setListerEnabled } from '/js/mods/pz2qol/lister.js';
import { getPriceBook } from '/js/mods/pz2qol/pricebook.js';
import { fmtInt, h, icon, setClass, setText, tierOf } from '/js/mods/pz2qol/ui.js';

const SCORE_STEPS = [0, 50, 60, 70, 80, 90];
const KEEP_STEPS = [1, 2, 3, 4];

export function next(list, value) {
    const i = list.indexOf(value);
    return list[(i + 1) % list.length];
}

export function safe(label, fn) {
    return () => {
        try {
            fn();
        }
        catch (err) {
            reportError('ui', `"${label}" failed`, err);
        }
    };
}

// Pill button: optional icon, label, optional live count bubble.
export function chip(label, tooltip, onClick, iconName) {
    const text = h('span.PZ2QoL_chipText', { text: label });
    const count = h('span.PZ2QoL_chipCount');
    const c = h('div.PZ2QoL_chip', { title: tooltip, onClick: safe(label, () => onClick(c)) },
        iconName ? icon(iconName, 'brown', 'sm') : null, text, count);
    c.__text = text;
    c.__count = count;
    return c;
}

export function setChip(c, on, label, count) {
    setClass(c, 'on', on);
    if (label != undefined) setText(c.__text, label);
    const showCount = count != undefined && count !== '';
    setClass(c.__count, 'show', showCount);
    if (showCount) setText(c.__count, String(count));
}

// Segmented control: one option active.
export function segmented(label, options, onPick) {
    const items = options.map(o => {
        const item = h('div.PZ2QoL_segItem', { text: o.label, title: o.tooltip, onClick: safe(o.label, () => onPick(o.value)) });
        item.__value = o.value;
        return item;
    });
    const node = h('div.PZ2QoL_segmented', null, label ? h('div.PZ2QoL_segLabel', { text: label }) : null, items);
    node.__set = value => items.forEach(i => setClass(i, 'on', i.__value === value));
    return node;
}

function group(label, ...children) {
    return h('div.PZ2QoL_group', null, label ? h('div.PZ2QoL_groupLabel', { text: label }) : null, h('div.PZ2QoL_groupBody', null, children));
}

// Collapsible bars: a small toggle at the left; collapsed shows one line.
function collapsedKey(key) {
    return `PZ2QoL.collapsed.${key}`;
}
function loadCollapsed(key) {
    try {
        return window.localStorage && window.localStorage.getItem(collapsedKey(key)) === 'true';
    }
    catch (e) {
        return false;
    }
}
function saveCollapsed(key, on) {
    try {
        if (window.localStorage) window.localStorage.setItem(collapsedKey(key), on ? 'true' : 'false');
    }
    catch (e) {
        // session only
    }
}
export function collapser(bar, key, title) {
    const arrow = h('div.PZ2QoL_collapseArrow', { text: '▾' });
    const label = h('div.PZ2QoL_collapseLabel', { text: title });
    const toggle = h('div.PZ2QoL_collapse', { title: 'Show or hide the mod toolbar', onClick: () => set(!bar.classList.contains('collapsed')) }, arrow, label);
    function set(on) {
        setClass(bar, 'collapsed', on);
        setText(arrow, on ? '▸' : '▾');
        saveCollapsed(key, on);
    }
    set(loadCollapsed(key));
    return toggle;
}

// ---------------------------------------------------------------- market

function applyMarketPreset(preset) {
    for (const [suffix, value] of preset.events) {
        sendScreenEvent(MARKET_EVENT, suffix, value);
    }
    sendScreenEvent(MARKET_EVENT, 'FilterMenuConfirm');
}

const PRESET_ICONS = {
    topGenes: 'IconMedalStandard',
    breeders: 'IconFertility',
    longLived: 'IconLongevity',
    endingSoon: 'TimeRemaining',
    cash: 'Icon_Cash',
    cc: 'Icon_ConservationCredits',
};

function buildMarketBar() {
    const presets = MARKET_PRESETS.map(p => chip(p.label, `${p.tooltip}. Uses the game's own filters, so it covers every page.`, () => applyMarketPreset(p), PRESET_ICONS[p.id]));
    const reset = chip('Reset', 'Reset all market filters', () => sendScreenEvent(MARKET_EVENT, 'ResetAllFilters'), 'reset');
    reset.classList.add('ghost');
    const dim = segmented('Dim below', SCORE_STEPS.map(v => ({ value: v, label: v ? String(v) : 'Off', tooltip: v ? `Fade listings on this page with gene score below ${v}` : 'No dimming' })), v => {
        setMarketDimBelow(v);
        dim.__set(v);
    });
    dim.__set(getMarketDimBelow());
    const prices = h('div.PZ2QoL_pill.subtle.prices');
    const bar = h('div.PZ2QoL_bar.PZ2QoL_card.market');
    bar.appendChild(collapser(bar, 'market', 'Quick filters'));
    bar.appendChild(h('div.PZ2QoL_expandOnly', null, presets, reset, h('div.PZ2QoL_divider'), dim));
    bar.appendChild(h('div.PZ2QoL_flex1'));
    bar.appendChild(prices);
    let lastCount = -1;
    bar.__updateSummary = () => {
        const total = getPriceBook().filter(l => l.isCC).length;
        setText(prices, `${fmtInt(total)} prices recorded`);
        if (lastCount >= 0 && total > lastCount) {
            // brief pulse when new prices arrive
            prices.classList.remove('pulse');
            void prices.offsetWidth;
            prices.classList.add('pulse');
        }
        lastCount = total;
    };
    return bar;
}

// --------------------------------------------------------------- storage

function buildStorageBar() {
    const chips = {};
    const toggles = [
        ['pregnant', 'Pregnant', 'Only pregnant animals', 'IconFertility'],
        ['alpha', 'Alpha', 'Only alphas', 'IconStar'],
        ['adults', 'Adults', "Click to cycle: all adults (hides infants), then fertile adults only (also hides infertile adults, such as elderly animals past breeding age, which the market won't take), then juveniles only, then off", 'Icon_Maturation'],
        ['pairsOnly', 'Has pair', 'Only species where you hold at least one breeding-age male and female', 'IconGender'],
        ['hideListed', 'Not listed', 'Hide animals already listed on the market', 'IconTrade'],
        ['related', 'Kin', 'Kin: only animals with a close relative in storage (same species, from the family records the game keeps)', 'IconGenetics'],
    ];
    for (const [key, label, tip, ic] of toggles) {
        chips[key] = chip(label, tip, () => {
            const f = getStorageFilters();
            // Adults cycles: off -> all adults -> fertile adults -> juveniles -> off
            if (key == 'adults') {
                if (f.juveniles) setStorageFilters({ adults: false, fertileAdults: false, juveniles: false });
                else if (f.fertileAdults) setStorageFilters({ adults: false, fertileAdults: false, juveniles: true });
                else if (f.adults) setStorageFilters({ adults: false, fertileAdults: true, juveniles: false });
                else setStorageFilters({ adults: true, fertileAdults: false, juveniles: false });
                return;
            }
            setStorageFilters({ [key]: !f[key] });
        }, ic);
    }
    chips.surplus = chip('Surplus', 'Animals beyond your best N of each species and sex (by gene score): trade or release candidates. Click to step N; off after the last step.', () => {
        const f = getStorageFilters();
        if (!f.surplusOnly) setStorageFilters({ surplusOnly: true, surplusKeep: KEEP_STEPS[0] });
        else if (f.surplusKeep == KEEP_STEPS[KEEP_STEPS.length - 1]) setStorageFilters({ surplusOnly: false });
        else setStorageFilters({ surplusKeep: next(KEEP_STEPS, f.surplusKeep) });
    }, 'IconTrade');
    // Sellable cycles: off -> sellable -> not sellable -> off
    const SELLABLE_NEXT = { any: 'yes', yes: 'no', no: 'any' };
    const SELLABLE_LABEL = { any: 'Sellable', yes: 'Sellable', no: 'Not sellable' };
    const SELLABLE_TIP = "Click to cycle: animals the market would take, then animals it won't, then off. Not sellable: juveniles, infertile animals (including elderly past breeding age), pregnant animals, animals already listed and animals being moved. The game still checks each animal when you list it.";
    chips.sellable = chip('Sellable', SELLABLE_TIP, () => setStorageFilters({ sellable: SELLABLE_NEXT[getStorageFilters().sellable] || 'yes' }), 'IconTrade');
    chips.minScore = chip('Gene ≥ any', 'Minimum gene score; click to step', () => setStorageFilters({ minScore: next(SCORE_STEPS, getStorageFilters().minScore) }), 'IconMedalStandard');
    const clearChip = chip('Clear', "Clear the mod's storage filters", () => resetStorageFilters(), 'reset');
    clearChip.classList.add('ghost');
    // one chip that cycles, so the bar stays two rows high
    const SORTS = ['none', 'gene', 'breeder'];
    const SORT_LABEL = { none: 'Sort: Game', gene: 'Sort: Gene', breeder: 'Sort: Breeder' };
    const sort = chip('Sort: Game', "Click to cycle: the game's order, best gene score first, best breeder score first", () => setStorageFilters({ sort: next(SORTS, getStorageFilters().sort) }), 'IconMedalStandard');

    const knob = h('div.PZ2QoL_switchKnob');
    const listerSwitch = h('div.PZ2QoL_switch', {
        title: 'Market lister: live prices, a recommended price and "Sell at recommended price" (Franchise only). Listing only starts when you click Sell.',
        onClick: safe('Market lister', () => setListerEnabled(!isListerEnabled())),
    }, h('div.PZ2QoL_switchTrack', null, knob), h('div.PZ2QoL_switchLabel', { text: 'Market lister' }));
    const syncLister = () => setClass(listerSwitch, 'on', isListerEnabled());
    onListerSettingChanged(syncLister);
    syncLister();

    const stats = h('div.PZ2QoL_stats');
    const bar = h('div.PZ2QoL_bar.PZ2QoL_card.storage');
    bar.appendChild(collapser(bar, 'storage', 'Filters'));
    bar.appendChild(h('div.PZ2QoL_expandOnly', null,
        toggles.map(([key]) => chips[key]), chips.sellable, chips.surplus, chips.minScore, sort, clearChip));
    bar.appendChild(h('div.PZ2QoL_flex1'));
    bar.appendChild(stats);
    bar.appendChild(h('div.PZ2QoL_divider'));
    bar.appendChild(listerSwitch);

    const sync = () => {
        const f = getStorageFilters();
        for (const [key] of toggles) setClass(chips[key], 'on', !!f[key]);
        setChip(chips.adults, !!(f.adults || f.fertileAdults || f.juveniles), f.juveniles ? 'Juveniles' : f.fertileAdults ? 'Fertile adults' : 'Adults');
        setChip(chips.sellable, (f.sellable || 'any') != 'any', SELLABLE_LABEL[f.sellable] || 'Sellable');
        setChip(chips.surplus, f.surplusOnly, f.surplusOnly ? `Surplus · keep ${f.surplusKeep}` : 'Surplus');
        setChip(chips.minScore, f.minScore > 0, f.minScore > 0 ? `Gene ≥ ${f.minScore}` : 'Gene ≥ any');
        setChip(sort, f.sort != 'none', SORT_LABEL[f.sort]);
        setClass(clearChip, 'hiddenSoft', !storageFiltersActive(f));
    };
    onStorageFiltersChanged(() => {
        sync();
        bar.__updateSummary();
    });
    sync();

    const statPill = (label, value, cls) => h(`div.PZ2QoL_stat${cls ? '.' + cls : ''}`, { title: label }, h('div.PZ2QoL_statValue', { text: value }), h('div.PZ2QoL_statLabel', { text: label }));
    bar.__updateSummary = () => {
        const animals = getStorageSource().map(readAnimal);
        const s = storageSummary(animals);
        const f = getStorageFilters();
        const predicates = getStoragePredicates();
        const shown = storageFiltersActive(f) ? applyStorageFilters(animals, f, predicates).length : s.count;
        // live counts on the chips (what each filter alone would show)
        const st = speciesStats(animals);
        setChip(chips.pregnant, !!f.pregnant, undefined, animals.filter(a => a.isPregnant).length);
        setChip(chips.alpha, !!f.alpha, undefined, animals.filter(a => a.isAlpha).length);
        setChip(chips.adults, !!(f.adults || f.fertileAdults || f.juveniles), undefined, animals.filter(a => f.juveniles ? !isAdult(a) : f.fertileAdults ? isFertileAdult(a) : isAdult(a)).length);
        setChip(chips.pairsOnly, !!f.pairsOnly, undefined, animals.filter(a => (st.get(a.species || '?') || {}).pairs > 0).length);
        setChip(chips.surplus, f.surplusOnly, undefined, surplusIds(animals, f.surplusOnly ? f.surplusKeep : 2).size);
        setChip(chips.hideListed, !!f.hideListed, undefined, animals.filter(a => !isOnMarket(a)).length);
        // count for the state the chip is in (off: how many are sellable),
        // and why the rest aren't in the tooltip
        const reasons = {};
        for (const a of animals) for (const r of sellBlockers(a)) reasons[r] = (reasons[r] || 0) + 1;
        const sellableCount = animals.filter(isSellable).length;
        setChip(chips.sellable, (f.sellable || 'any') != 'any', undefined, f.sellable == 'no' ? animals.length - sellableCount : sellableCount);
        const why = Object.keys(SELL_BLOCKERS).filter(r => reasons[r]).map(r => `${reasons[r]} ${SELL_BLOCKERS[r].toLowerCase()}`);
        chips.sellable.title = `Sellable now: ${sellableCount} of ${animals.length}.${why.length ? ` Not sellable: ${why.join(', ')}.` : ''} ${SELLABLE_TIP}`;
        // Kin adds the `related` predicate when it has lineage for storage
        setChip(chips.related, !!f.related, undefined, predicates.related ? animals.filter(predicates.related).length : '');
        setClass(chips.related, 'disabled', !predicates.related && !f.related);
        const sig = JSON.stringify([s, shown, storageFiltersActive(f)]);
        if (stats.__sig == sig) return;
        stats.__sig = sig;
        while (stats.firstChild) stats.removeChild(stats.firstChild);
        stats.appendChild(statPill(storageFiltersActive(f) ? `of ${s.count}` : 'animals', storageFiltersActive(f) ? String(shown) : String(s.count), storageFiltersActive(f) ? 'accent' : ''));
        stats.appendChild(statPill('♂', String(s.males), 'male'));
        stats.appendChild(statPill('♀', String(s.females), 'female'));
        stats.appendChild(statPill('pairs', String(s.pairs)));
        stats.appendChild(statPill('avg gene', s.avgScore == null ? '–' : String(s.avgScore), tierOf(s.avgScore)));
    };
    return bar;
}

// ------------------------------------------------------------ placement

const screens = [
    { key: 'market', anchor: '.AnimalMarketMarket_header', content: '.AnimalMarketMarket_content', build: buildMarketBar, bar: null },
    { key: 'storage', anchor: '.AnimalMarketStorage_header', content: '.AnimalMarketStorage_content', build: buildStorageBar, bar: null },
];

function visibleRect(node) {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    for (let n = node; n && n != document.body; n = n.parentNode) {
        if (n.classList && n.classList.contains('hidden')) return null;
    }
    return r;
}

// Push the game's list down by exactly the height of our widgets, via a
// stylesheet rule (the game's elements are never restyled directly).
let reserveStyle = null;
const reserved = {};
function reserve(screen, px) {
    px = Math.max(0, Math.round(px));
    if (reserved[screen.key] === px) return;
    reserved[screen.key] = px;
    if (!reserveStyle) {
        reserveStyle = document.createElement('style');
        document.head.appendChild(reserveStyle);
    }
    reserveStyle.textContent = screens
        .filter(s => reserved[s.key] != undefined)
        .map(s => `.PZ2QoL ${s.content} { margin-top: ${reserved[s.key]}px; }`)
        .join('\n');
}

let tick = 0;
function place() {
    tick++;
    // a game popup (Compare Mates from storage...) covers the screen: our
    // fixed bars would float on top of it
    const popupOpen = !!document.querySelector('.PopupActionsModule_root.show');
    for (const s of screens) {
        try {
            const r = popupOpen ? null : visibleRect(document.querySelector(s.anchor));
            if (!r) {
                if (s.bar) {
                    s.bar.style.display = 'none';
                    s.bar.__shown = false;
                }
                continue;
            }
            if (!s.bar) {
                s.bar = s.build();
                document.body.appendChild(s.bar);
            }
            s.bar.style.display = 'flex';
            s.bar.style.left = `${Math.round(r.left + 8)}px`;
            s.bar.style.top = `${Math.round(r.bottom + 6)}px`;
            s.bar.style.width = `${Math.round(r.width - 16)}px`;
            // reading every stored animal is not free; once a second is plenty
            if (tick % 4 == 1 || !s.bar.__shown) s.bar.__updateSummary();
            s.bar.__shown = true;
            // reserve room for the bar plus the lister panel below it (storage)
            let bottom = s.bar.getBoundingClientRect().bottom;
            const lister = s.key == 'storage' ? document.querySelector('.PZ2QoL_lister') : null;
            if (lister && lister.style.display != 'none') bottom = Math.max(bottom, lister.getBoundingClientRect().bottom);
            reserve(s, bottom - r.bottom + 10);
        }
        catch (e) {
            reportError('ui', 'Toolbar placement failed', e, { silent: true });
        }
    }
}

export function installBars() {
    setInterval(place, 250);
}
