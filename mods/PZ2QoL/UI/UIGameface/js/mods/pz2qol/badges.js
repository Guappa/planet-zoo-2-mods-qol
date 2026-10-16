// Score badges on market and storage rows.
//
// Rows are recycled by the game's Repeater and re-rendered by preact, which
// drops foreign DOM children. So badges are (re)applied from two places:
// preact's afterUpdate hook (same tick as the game's render, so no flicker)
// and a slow interval for freshly mounted rows.
import { options } from '/js/common/lib/preact.js';
import { breederScore, geneScore, isBestValueCandidate, relevantGenes, scoreTier, valueIndex } from '/js/mods/pz2qol/scores.js';
import { GENES, geneBars, h } from '/js/mods/pz2qol/ui.js';
import { contextKey, MARKET_LIST_KEY, readAnimal, STORAGE_LIST_KEY } from '/js/mods/pz2qol/game.js';
import { reportError } from '/js/mods/pz2qol/errors.js';

const ROW_SELECTOR = '.MarketAnimalListItem_root';
let marketDimBelow = 0;
let enabled = true;
let failures = 0;

export function setMarketDimBelow(score) {
    marketDimBelow = score;
    refreshBadges();
}

export function getMarketDimBelow() {
    return marketDimBelow;
}

export function setBadgesEnabled(on) {
    enabled = on;
    if (!on) {
        document.querySelectorAll('.PZ2QoL_badge, .PZ2QoL_dim').forEach(e => e.parentNode && e.parentNode.removeChild(e));
    }
    refreshBadges();
}

// Finds the DataStore context a row DOM element was rendered for.
function rowContext(rowEl) {
    for (let node = rowEl, depth = 0; node && depth < 5; node = node.parentNode, depth++) {
        let c = node._component;
        while (c) {
            const ctx = c.props && c.props.context;
            if (Array.isArray(ctx)) {
                return ctx;
            }
            c = c._component;
        }
    }
    return null;
}

function screenOf(ctx) {
    const key = contextKey(ctx);
    if (key.startsWith(MARKET_LIST_KEY + '/')) return 'market';
    if (key.startsWith(STORAGE_LIST_KEY + '/')) return 'storage';
    return null;
}

function fmt(v) {
    return v == null ? '–' : String(v);
}

// Badges live inside the row's ListItem element, which the game's CSS
// already makes position: relative. Never change the row root's own
// styles: the game's Repeater positions rows itself, and touching them
// breaks the list layout (rows wrap into a grid).
function badgeHost(rowEl) {
    return rowEl.querySelector('.MarketAnimalListItem_listRoot');
}

function badgeFor(host) {
    let badge = null;
    let dim = null;
    for (const child of host.childNodes) {
        if (child.className == 'PZ2QoL_dim') dim = child;
        else if (child.className && child.className.indexOf && child.className.indexOf('PZ2QoL_badge') == 0) badge = child;
    }
    return { badge, dim };
}

function applyToRow(rowEl, bestId) {
    const host = badgeHost(rowEl);
    if (!host) return null;
    const ctx = rowContext(rowEl);
    const screen = ctx && screenOf(ctx);
    let { badge, dim } = badgeFor(host);
    if (!screen || !enabled) {
        if (badge) host.removeChild(badge);
        if (dim) host.removeChild(dim);
        return null;
    }
    const a = readAnimal(ctx);
    const g = geneScore(a);
    const b = breederScore(a);
    const v = screen == 'market' ? valueIndex(a) : null;
    const isBest = screen == 'market' && bestId != undefined && a.id == bestId;
    // Rebuild only when something visible changed (rows re-render often).
    const key = [screen, g, b, v, isBest, ...GENES.map(x => a.genes[x.id])].join('|');
    if (!badge || badge.__key != key) {
        const fresh = buildBadge(a, screen, g, b, v, isBest);
        fresh.__key = key;
        if (badge) host.replaceChild(fresh, badge);
        else host.appendChild(fresh);
        badge = fresh;
    }
    const shouldDim = screen == 'market' && marketDimBelow > 0 && (g == null || g < marketDimBelow);
    if (shouldDim && !dim) {
        dim = document.createElement('div');
        dim.className = 'PZ2QoL_dim';
        host.appendChild(dim);
    }
    else if (!shouldDim && dim) {
        host.removeChild(dim);
    }
    return a;
}

function buildBadge(a, screen, g, b, v, isBest) {
    const tips = [`Gene score ${fmt(g)} (average of ${relevantGenes(a).join(', ') || 'no genes'})`, `Breeder score ${fmt(b)} (fertility-weighted)`];
    if (v != null) tips.push(`Value ${v}: gene score per ${a.isCC ? '100 CC' : '1,000 cash'}`);
    if (isBest) tips.push('Best value on this page');
    return h(`div.PZ2QoL_badge.${scoreTier(g) == 'none' ? 'tier_none' : 'tier_' + scoreTier(g)}.${screen}${isBest ? '.best' : ''}`, { title: tips.join(String.fromCharCode(10)) },
        h('div.PZ2QoL_badgeScore', { text: fmt(g) }),
        geneBars(a.genes, relevantGenes(a)),
        h('div.PZ2QoL_badgeStat', null, h('span.PZ2QoL_badgeKey', { text: 'B' }), h('span', { text: fmt(b) })),
        v != null && h('div.PZ2QoL_badgeStat.value', null, h('span.PZ2QoL_badgeKey', { text: 'V' }), h('span', { text: String(v) })),
        isBest && h('div.PZ2QoL_badgeStar', { text: '★' }));
}

function bestValueId(rows) {
    let best = null;
    let bestValue = -1;
    for (const rowEl of rows) {
        const ctx = rowContext(rowEl);
        if (!ctx || screenOf(ctx) != 'market') continue;
        const a = readAnimal(ctx);
        if (!isBestValueCandidate(a)) continue;
        const v = valueIndex(a);
        if (v > bestValue) {
            bestValue = v;
            best = a.id;
        }
    }
    return best;
}

let cachedBestId = null;
export function refreshBadges() {
    try {
        const rows = Array.from(document.querySelectorAll(ROW_SELECTOR));
        cachedBestId = bestValueId(rows);
        for (const rowEl of rows) {
            applyToRow(rowEl, cachedBestId);
        }
        failures = 0;
    }
    catch (e) {
        if (++failures == 3) {
            reportError('ui', 'Score badges failed repeatedly and were turned off', e);
            enabled = false;
        }
    }
}

// Rows affected by a component update: rows inside it, or the row that
// contains it (e.g. when only the row's ListItem re-rendered).
function rowsUnder(component) {
    const base = component && component.base;
    if (!base || !base.querySelectorAll) return [];
    for (let n = base, i = 0; n && i < 8; n = n.parentNode, i++) {
        if (n.classList && n.classList.contains('MarketAnimalListItem_root')) return [n];
    }
    return base.querySelectorAll(ROW_SELECTOR);
}

export function installBadges() {
    const previous = options.afterUpdate;
    options.afterUpdate = function (component, ...rest) {
        if (previous) previous.call(this, component, ...rest);
        if (!enabled) return;
        try {
            for (const rowEl of rowsUnder(component)) {
                applyToRow(rowEl, cachedBestId);
            }
        }
        catch (e) {
            // the interval pass reports persistent failures
        }
    };
    setInterval(refreshBadges, 500);
}
