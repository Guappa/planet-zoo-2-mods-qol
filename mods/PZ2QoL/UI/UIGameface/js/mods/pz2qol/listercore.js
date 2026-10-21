// Market desk: the pure parts (Node tests). What each storage animal can
// do on the market, the desk's rows and counts, the job text the Lua
// listing engine reads, and what its results mean.
// See docs/DESIGN-market-desk.md.
import { Gender, Maturity, breederScore, geneScore, isOnMarket, relevantGenes } from './scores.js';
import { medalOf, MEDALS } from './pricing.js';

// Why the engine would not list an animal, from what its row shows. The
// game's own check (tradeAllowed, for the selected animal) still has the
// last word; these never reach the server.
export const BLOCK_WORDS = Object.freeze({
    listed: 'On the market',
    moving: 'Being moved',
    pregnant: 'Pregnant: not until she gives birth',
    juvenile: 'Juvenile',
    elderly: 'Elderly, no longer fertile',
    noid: 'No id from the game',
    untradeable: "The game won't trade it",
    // the game's market refuses it, but Quick trade or Quick release takes it
    // (docs/PLAN-desk-quick-release.md 3.1); never listed, never counted sellable
    quick: 'Quick trade',
    // the game offers only Rehome for it (no quick buttons, AnimalStorageInfoPanel.js:321)
    rehome: 'Rehome only',
});

// Why a row is blocked 'noid': the engine works by the animal's identity
// (StorageGetIDAndAIDType, else a fingerprint no other row shares) and the
// game gave neither (in game 2026-10-18: 59 of 63 rows).
export const NOID_TEXT = "The game gave no id for this animal; it can't be listed from the desk.";

// The skip reason for a pregnant animal (desk rows, the lister's summary,
// the debug log; the Lua engine has the same text).
export const PREGNANT_TEXT = "Pregnant: the market won't take it until she gives birth.";

// Shown but not blocked: the game may refuse these (its rule is native).
export const CAUTION_WORDS = Object.freeze({
    infertile: 'Infertile: the game may refuse',
});

// A pregnant animal is never listed (the game's own sell flow blocks it:
// RelocateAnimalsPopup g_tSellPreventers bPregnant; storage rows show
// isPregnant, AnimalMarketAndStorageSchema.js).
export function blockOf(a) {
    if (isOnMarket(a)) return 'listed';
    if (a.isMoving) return 'moving';
    if (a.isPregnant) return 'pregnant';
    if (a.maturity == Maturity.Infant) return 'juvenile';
    if (a.maturity == Maturity.ElderlyInfertile) return 'elderly';
    return null;
}

export function cautionOf(a) {
    if (a.maturity == Maturity.YoungAdultInfertile || a.maturity == Maturity.AdultInfertile) return 'infertile';
    return null;
}

// "7h 20m left", "45m left", "<1m left"
export function timeLeftText(seconds) {
    if (!(seconds > 0)) return '';
    const m = Math.floor(seconds / 60);
    if (m < 1) return '<1m left';
    const h = Math.floor(m / 60);
    return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''} left` : `${m}m left`;
}

// What the engine's result kinds mean on a row and in the summary.
export const RESULT_WORDS = Object.freeze({
    gone: 'no longer in storage',
    listed: 'already on the market',
    moving: 'being moved',
    pregnant: "pregnant: the market won't take it until she gives birth",
    elderly: 'elderly and no longer fertile',
    juvenile: 'juvenile',
    untradeable: "the game won't trade it",
    ambiguous: 'no id from the game and another animal looks the same',
    unselectable: "the game didn't select it",
    changed: 'the list changed just before sending',
    busy: 'the server stayed busy',
    noprice: 'no price',
    refused: 'refused by the server',
    timeout: 'no confirmation in time',
    stopped: 'stopped (it may still appear on the market)',
    error: 'an error in the mod',
    closed: 'Animal Storage was closed',
    // quick trade / release (docs/PLAN-desk-quick-release.md 4.3)
    notallowed: "the game doesn't allow it now",
    nopage: 'no fresh report from the page (nothing sent)',
    rehome: 'the game offers only Rehome for it',
    unconfirmed: 'not confirmed: check storage',
    // taking listings off the market (My listings, docs/DESIGN-reprice.md)
    notlisted: 'not on the market any more',
});

export const STEP_WORDS = Object.freeze({
    server: 'Waiting for the server to be free…',
    resolve: 'Finding it in storage…',
    select: 'Selecting it…',
    selected: "Reading the game's price limits…",
    send: 'Sending the listing…',
    confirm: 'Waiting for the game to confirm…',
    gone: 'Waiting for it to leave storage…',
    unconfirm: 'Waiting for it to come off the market…',
    pause: 'Pausing before the next one…',
});

// What a storage row holds (keys are positions: a rebuilt list gives a key
// another animal, and this tells them apart).
export function rowFingerprint(a) {
    const g = a.genes || {};
    return [a.species, a.name, a.gender, g.size, g.longevity, g.fertility, g.immunity].join('|');
}

// GUIDs as the engine prints them: decimal, or another plain token.
export const GUID_TOKEN = /^[A-Za-z0-9_.:-]+$/;

// A row of the desk: the storage animal plus its GUID (from Lua), price
// advice and state. Without a GUID the id also carries what the row holds,
// so a tick can never move to another animal when the list is rebuilt.
//   rows    readAnimal() objects from the storage list
//   guids   Map row key -> GUID string (Lua); missing: not resolved yet
//   advise  a => { price, confidence, reason } (pricing.js)
//   failed  Set of row keys the engine was asked about and could not
//           identify: those get block 'noid' (never ticked, never counted
//           in List N); keys not asked yet stay unblocked
// gameBlocked: guid -> the game's reason, for animals a run found it won't
// trade this session (infected, injured...): kept unticked until Read storage
// again checks them afresh.
// verdicts: guid -> what the game allows for it (verdictOf), from listing runs
// and Check storage; its category decides the block (quick, rehome, untradeable).
export function deskRows(rows, guids, advise, failed, gameBlocked = null, verdicts = null) {
    const out = [];
    for (const a of rows) {
        if (!a || a.id == undefined || a.isShoal) continue;
        const guid = guids && guids.get(a.key);
        const advice = advise ? advise(a) : { price: 0, confidence: 'none', reason: '' };
        const verdict = guid && verdicts ? verdicts.get(guid) || null : null;
        let vb = verdictBlock(verdict);
        // not checked yet, but the storage list says it came from a Frontier
        // zoo: Quick trade only (proven 4/4 = NoBirthZoo, Y: 2026-10-18);
        // labelled as such, and each animal is checked again before it goes
        const pre = !verdict && !blockOf(a) && isFrontierZoo(a);
        if (pre) vb = { cat: 'quick', block: 'quick', detail: '' };
        const row = {
            id: guid ? 'g' + guid : 'k' + a.key + '|' + rowFingerprint(a),
            guid: guid || null,
            key: a.key,
            a,
            species: a.species,
            score: geneScore(a),
            medal: medalOf(a),
            block: blockOf(a) || (!guid && failed && failed.has(a.key) ? 'noid' : null) || vb.block || (guid && !verdict && gameBlocked && gameBlocked.has(guid) ? 'untradeable' : null),
            blockDetail: undefined,
            cat: vb.cat,
            pre,
            verdict,
            caution: cautionOf(a),
            advice,
        };
        if (row.block === 'untradeable') row.blockDetail = vb.block === 'untradeable' ? vb.detail : gameBlocked.get(guid);
        else if (row.block && row.block === vb.block) row.blockDetail = vb.detail;
        out.push(row);
    }
    return out;
}

// Species with their counts: total, sellable now, Quick trade only, on the market.
// A quick-only animal is never sellable (it can't go on the market).
export function speciesCounts(rows) {
    const m = new Map();
    for (const r of rows) {
        const sp = r.species || '?';
        let c = m.get(sp);
        if (!c) m.set(sp, c = { species: sp, total: 0, sellable: 0, quick: 0, listed: 0 });
        c.total++;
        if (!r.block) c.sellable++;
        if (r.block === 'quick') c.quick++;
        if (r.block === 'listed') c.listed++;
    }
    return Array.from(m.values()).sort((x, y) => y.sellable - x.sellable || y.total - x.total || String(x.species).localeCompare(String(y.species)));
}

// ------------------------------------------------- categories (Quick trade)
// docs/PLAN-desk-quick-release.md 3.1. The game gives Trade, Quick trade,
// Quick release and Rehome only for the selected animal (actions context),
// so the desk knows them per animal once a listing run or Check storage has
// selected it: its verdict (Lua's verdictOf, sent with each run result).

// An engine result's verdict made safe to read, or null.
export function verdictOf(v, at = Date.now()) {
    if (!v || typeof v !== 'object' || typeof v.trade !== 'boolean') return null;
    const b = x => (typeof x === 'boolean' ? x : null);
    const n = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const s = x => (typeof x === 'string' ? x : '');
    return {
        trade: v.trade, quickTrade: b(v.quickTrade), quickRelease: b(v.quickRelease), rehome: b(v.rehome),
        reasons: { trade: s(v.tradeWhy), quickTrade: s(v.quickTradeWhy), quickRelease: s(v.quickReleaseWhy) },
        values: { quickTrade: s(v.quickTradeValue), quickRelease: s(v.quickReleaseValue) },
        prices: { quickTrade: n(v.quickTradePrice), quickRelease: n(v.quickReleasePrice) },
        src: s(v.src), at,
    };
}

// 'market' (Trade allowed), 'quick' (no market, no Rehome, Quick trade or
// Quick release allowed), 'blocked' (none of them, or Rehome only), or
// 'unknown' (not checked yet: listable as before, the run checks it).
export function categoryOf(v) {
    if (!v) return 'unknown';
    if (v.trade) return 'market';
    if (v.rehome === true) return 'blocked';
    if (v.quickTrade === true || v.quickRelease === true) return 'quick';
    return 'blocked';
}

// The desk row's block from a verdict: { cat, block, detail }.
export function verdictBlock(v) {
    const cat = categoryOf(v);
    if (cat === 'quick') return { cat, block: 'quick', detail: v.reasons.trade };
    if (cat === 'blocked') return v.rehome === true ? { cat, block: 'rehome', detail: v.reasons.trade } : { cat, block: 'untradeable', detail: v.reasons.trade };
    return { cat, block: null, detail: undefined };
}

// "$1,200" / "85 CC": the game's own value text when it reads as words,
// else the numeric price, else ''. tr: the game's translate (may throw).
export function quickValueText(v, kind, fmt = n => String(n), tr = s => s) {
    if (!v) return '';
    const text = String((v.values && v.values[kind]) || '').trim();
    let shown = '';
    if (text.startsWith('[')) {
        // a loc token ("[...:Value=1200]"): the game's words, if it has them
        try {
            const t = tr(text);
            shown = typeof t === 'string' && t && !t.startsWith('[') && !t.startsWith('!') ? t : '';
        }
        catch (e) {
            shown = '';
        }
    }
    else shown = text;
    const n = v.prices ? v.prices[kind] : null;
    if (!shown && typeof n === 'number') shown = kind === 'quickTrade' ? `$${fmt(n)}` : `${fmt(n)} CC`;
    else if (shown && kind === 'quickRelease' && /^\d[\d,.\s]*$/.test(shown)) shown = `${shown} CC`;
    else if (shown && kind === 'quickTrade' && /^\d[\d,.\s]*$/.test(shown)) shown = `$${shown}`;
    return shown;
}

// What a quick row allows, in words: ["Quick trade · $1,200", "Quick release · 85 CC"].
export function quickOffers(v, fmt, tr) {
    const out = [];
    if (!v) return out;
    for (const [kind, label] of [['quickTrade', 'Quick trade'], ['quickRelease', 'Quick release']]) {
        if (v[kind] !== true) continue;
        const val = quickValueText(v, kind, fmt, tr);
        out.push(val ? `${label} · ${val}` : label);
    }
    return out;
}

// ------------------------------------------------------- Check storage
// docs/PLAN-desk-quick-release.md 3.2: the engine's 'check' job selects each
// animal and records its verdict; it never sends anything. Its pace: 150 ms
// between selects unless Phase 0a shows that a select sends a server request
// (trace: lister select_net busy=true / lister_select_net_busy), then the
// desk's own pace. Set SELECT_SENDS_REQUEST from that trace.
export const CHECK_PACE_MS = 150;
export const SELECT_SENDS_REQUEST = false;
// about how long one animal takes (clear, select, the game's data, settle)
export const CHECK_ANIMAL_MS = 1800;

export function checkPaceMs(deskPaceMs = 3000) {
    return SELECT_SENDS_REQUEST ? Math.max(1000, Math.round(deskPaceMs)) : CHECK_PACE_MS;
}

// The animals Check storage takes: of the shown species (null: all), with an
// id, not blocked by their row, not checked yet.
export function uncheckedRows(rows, species = null) {
    return rows.filter(r => (!species || r.species === species) && r.guid && ((!r.block && r.cat === 'unknown') || r.pre));
}

// ------------------------------------------- Quick trade / Quick release
// docs/PLAN-desk-quick-release.md 4 (Phase 2). Proven on Y: 2026-10-18
// (Phase 0): the numeric prices equal the value texts (50/50), a select
// sends nothing, the row leaves storage ~0.33 s after the game's call.

// The row's source text says it came from a Frontier zoo (not a player's):
// "[AnimalExchange_Source_Description:Value=|Frontier Zoo|]".
export function isFrontierZoo(a) {
    return !!a && typeof a.source === 'string' && /\|\s*Frontier Zoo\s*\|/i.test(a.source);
}

// Phase 0a: quickTradePrice / quickReleasePrice matched the value texts, so
// the sheet's total is exact (else it would say ≈).
export const QUICK_PRICES_MATCH = true;

export const QUICK_MODES = Object.freeze({
    quicktrade: Object.freeze({ label: 'Quick trade', flag: 'quickTrade', done: 'traded', verb: 'Quick-traded', working: 'Quick trading…', cash: true,
        header: "QUICK TRADE · sells for cash at once · can't be undone", confirm: 'Quick trade now' }),
    release: Object.freeze({ label: 'Quick release', flag: 'quickRelease', done: 'released', verb: 'Released', working: 'Releasing…', cash: false,
        header: "QUICK RELEASE · releases to the wild for CC at once · can't be undone", confirm: 'Release now' }),
});

// The live acceptance (plan 5): until one run of exactly one animal has
// been confirmed gone in a mode, that mode takes one animal at a time.
export const FIRST_TEXT = Object.freeze({
    quicktrade: 'First quick trade: one animal, to check it works',
    release: 'First quick release: one animal, to check it works',
});
export const QUICK_WARNING = "These animals leave your storage for good. This can't be undone.";
// Proven in game without the one-animal limit: Quick trade (Y: 2026-10-18,
// animal_29 left storage, 91 -> 90 rows). Quick release keeps the limit
// until its own first confirmed run.
export const QUICK_PROVEN = Object.freeze({ quicktrade: true });

// Whether a mode takes more than one animal at a time: proven in game, or
// the player's own one-animal run confirmed (prefs quickAccepted).
export function quickAccepted(mode, pref) {
    if (QUICK_PROVEN[mode]) return true;
    return !!(pref && typeof pref === 'object' && pref[mode] === true);
}

export function quickMoney(mode, n, fmt = x => String(x)) {
    return mode === 'quicktrade' ? `$${fmt(n)}` : `${fmt(n)} CC`;
}

// Whether a desk row can be ticked in a quick mode: { ok, why, pre, market }.
// Every animal the game allows the action for (its verdict's quickTrade /
// quickRelease), market-listable ones included (developer, 2026-10-18: e.g.
// the ones the server refused to list); never one on the market, being
// moved, or offered only Rehome. A row classified from the storage list only
// (a Frontier zoo) is checked again before it goes; others need a check first.
export function quickEligible(r, mode) {
    const m = QUICK_MODES[mode];
    if (!m || !r) return { ok: false, why: '' };
    if (!r.guid) return { ok: false, why: "The game gave no id for it; it can't be sent from the desk." };
    if (r.block === 'listed') return { ok: false, why: 'On the market.' };
    if (r.block === 'moving') return { ok: false, why: 'Being moved.' };
    if (r.verdict) {
        if (r.verdict.rehome === true) return { ok: false, why: 'The game offers only Rehome for it.' };
        if (r.verdict[m.flag] !== true) {
            const why = r.verdict.reasons && r.verdict.reasons[m.flag];
            return { ok: false, why: `The game doesn't allow ${m.label} for it${why ? ` (${reasonText('untradeable', why)})` : ''}.` };
        }
        return { ok: true, why: '', market: r.verdict.trade === true };
    }
    if (r.pre) return { ok: true, why: '', pre: true };
    if (r.block === 'noid' || r.block === 'rehome') return { ok: false, why: `${BLOCK_WORDS[r.block]}.` };
    // not checked yet, sellable or not (the developer, 2026-10-19: "sometimes
    // you just want to get rid of animals quickly"): it can be ticked; the
    // engine selects it and sends only if the game allows the action right
    // then, else skips it (pz2qol.lister.lua, the quick job's flag check)
    return { ok: true, why: '', unchecked: true, market: !r.block };
}

// The animals a finished listing run had refused by the server (kind
// 'refused'): to quick-trade the leftovers.
export function refusedGuids(state) {
    if (!state || (state.mode && state.mode !== 'list') || !Array.isArray(state.results)) return [];
    return state.results.filter(r => r.kind === 'refused' && r.guid != undefined).map(r => String(r.guid));
}

// The confirmation sheet for the ticked rows: who goes, who is left out and
// why, the total. accepted: the mode's live acceptance is done.
//   -> { mode, go, skip: [{ r, why }], total, priced, exact, totalText, names, more, title, button }
export function quickSheet(rows, mode, { fmt = n => String(n), nameOf = r => String(r.a && r.a.name || 'animal'), accepted = true, matched = QUICK_PRICES_MATCH } = {}) {
    const m = QUICK_MODES[mode];
    const go = [];
    const skip = [];
    for (const r of rows || []) {
        const e = quickEligible(r, mode);
        if (e.ok) go.push(r);
        else skip.push({ r, why: e.why });
    }
    if (!accepted && go.length > 1) for (const r of go.splice(1)) skip.push({ r, why: `${FIRST_TEXT[mode]}.` });
    const prices = go.map(r => (r.verdict && r.verdict.prices ? r.verdict.prices[m.flag] : null));
    const known = prices.filter(n => typeof n === 'number' && Number.isFinite(n));
    const total = known.reduce((s, n) => s + n, 0);
    const exact = matched && known.length === go.length;
    const unpriced = go.length - known.length;
    let totalText = '';
    if (go.length) {
        if (!known.length) totalText = 'priced when checked';
        else totalText = `${matched ? '' : '≈ '}${quickMoney(mode, total, fmt)}${unpriced ? ` + ${unpriced} priced when checked` : ''}`;
    }
    const n = go.length;
    return {
        mode, go, skip, total, priced: known.length, exact, totalText,
        names: go.slice(0, 12).map(nameOf), more: Math.max(0, n - 12),
        title: n ? `${m.label} ${n} animal${n === 1 ? '' : 's'} for ${totalText}?` : `Nothing to ${m.label.toLowerCase()}`,
        button: n ? `${m.label} ${n} animal${n === 1 ? '' : 's'} (${totalText})…` : `${m.label} 0 animals`,
    };
}

// The engine's quick job: "v1 <paceMs> quicktrade|release", then
// "<guid> <key> - default" per animal, exactly the rows given (frozen).
export function encodeQuickJob(rows, { mode = 'quicktrade', paceMs = 3000 } = {}) {
    if (!QUICK_MODES[mode]) return { text: '', items: [] };
    const lines = [`v1 ${Math.max(1000, Math.round(paceMs))} ${mode}`];
    const items = [];
    for (const r of rows) {
        if (!r.guid || !GUID_TOKEN.test(r.guid) || !/^[A-Za-z0-9_]+$/.test(String(r.key))) continue;
        lines.push(`${r.guid} ${r.key} - default`);
        items.push(r);
    }
    return { text: lines.join('\n'), items };
}

// "Quick-traded 6 of 7 · $7,200"
export function quickRunSummary(state, fmt = n => String(n)) {
    const m = state && QUICK_MODES[state.mode];
    if (!m) return '';
    const done = state.results.filter(r => r.status === m.done);
    const sum = done.reduce((s, r) => s + (r.price > 0 ? r.price : 0), 0);
    return `${m.verb} ${done.length} of ${state.results.length}${sum ? ` · ${quickMoney(state.mode, sum, fmt)}` : ''}`;
}

// The mode a finished run accepts (one animal, confirmed gone), or null.
export function acceptedMode(state) {
    if (state && state.phase !== 'running' && state.mode === 'list' && QUICK_MODES[state.onRefused]) {
        // a listing run whose one quick action after a refusal was confirmed
        const after = state.results.filter(r => r.afterRefused);
        return after.length === 1 && after[0].status === QUICK_MODES[state.onRefused].done ? state.onRefused : null;
    }
    const m = state && QUICK_MODES[state.mode];
    if (!m || state.phase === 'running' || state.results.length !== 1) return null;
    return state.results[0].status === m.done ? state.mode : null;
}

// "≈ 2 min" for n animals at this pace (whole minutes, at least 1).
export function checkMinutes(n, paceMs = CHECK_PACE_MS) {
    if (!(n > 0)) return 0;
    return Math.max(1, Math.ceil(n * (CHECK_ANIMAL_MS + Math.max(0, paceMs)) / 60000));
}

// The engine's check job: "v1 <paceMs> check", then "<guid> <key> - default".
export function encodeCheckJob(rows, { paceMs = CHECK_PACE_MS } = {}) {
    const lines = [`v1 ${Math.max(CHECK_PACE_MS, Math.round(paceMs))} check`];
    const items = [];
    for (const r of rows) {
        if (!r.guid || !GUID_TOKEN.test(r.guid) || !/^[A-Za-z0-9_]+$/.test(String(r.key))) continue;
        lines.push(`${r.guid} ${r.key} - default`);
        items.push(r);
    }
    return { text: lines.join('\n'), items };
}

// The verdicts a run's state carries: [[guid, verdictOf()]].
export function verdictsOfState(state, at = Date.now()) {
    const out = [];
    if (!state || !Array.isArray(state.results)) return out;
    for (const r of state.results) {
        const v = verdictOf(r && r.verdict, at);
        if (v && r.guid != undefined) out.push([String(r.guid), v]);
    }
    return out;
}

// "Checked 7 of 10: 3 Quick trade, 2 not sellable; 3 not checked."
export function checkSummaryText(state, verdicts = null) {
    const t = tally(state);
    if (!t.total) return 'Nothing to check.';
    const cats = { market: 0, quick: 0, blocked: 0 };
    if (state) for (const r of state.results) {
        if (r.status !== 'checked') continue;
        const c = categoryOf((verdicts && verdicts.get(String(r.guid))) || verdictOf(r.verdict));
        if (cats[c] != undefined) cats[c]++;
    }
    const kinds = [];
    if (cats.market) kinds.push(`${cats.market} sellable`);
    if (cats.quick) kinds.push(`${cats.quick} Quick trade`);
    if (cats.blocked) kinds.push(`${cats.blocked} not sellable`);
    let s = `Checked ${t.checked} of ${t.total}${kinds.length ? `: ${kinds.join(', ')}` : ''}`;
    const notDone = t.total - t.checked;
    if (notDone) s += `; ${notDone} not checked`;
    return s + '.';
}

// ------------------------------------------------------------- filters
// What the desk shows, so the player can pick a population to sell (e.g.
// genes 0-50: tick all, list them, keep the rest). The main bar holds sex,
// age, rating, the gene range and what to show; "More filters" holds the
// rest. A filter left at its default filters nothing.

export const GENE_BASES = Object.freeze({
    overall: 'Overall',
    breeder: 'Breeding',
    size: 'Size',
    longevity: 'Longevity',
    fertility: 'Fertility',
    immunity: 'Immunity',
});
export const GENE_KEYS = Object.freeze(['size', 'longevity', 'fertility', 'immunity']);
export const DESK_AGES = Object.freeze(['juvenile', 'young', 'adult', 'elderly']);
// the game's EAnimalStorageTag (GameTypes.js); 0 = no tag
export const STORAGE_TAGS = Object.freeze({ 0: 'No tag', 1: 'Sell', 2: 'Release', 3: 'Move', 4: 'Keep' });
export const TAG_KEEP = 4;
export const DESK_SORTS = Object.freeze({ best: 'Best genes', worst: 'Worst genes', price: 'Price', name: 'Name' });

const MEDAL_RANK = Object.fromEntries(MEDALS.map((m, i) => [m, i]));

export const DESK_FILTERS = Object.freeze({
    species: null,
    sex: 'any',           // 'any' | 'male' | 'female'
    ages: Object.freeze([]), // DESK_AGES picked; none = any age
    fertile: 'any',       // 'any' | 'yes' (the game marks it fertile) | 'no'
    medals: Object.freeze([]), // MEDALS picked; none = any rating
    state: 'any',         // 'any' | 'sellable' | 'quick' | 'listed' | 'blocked'
    geneBasis: 'overall', // GENE_BASES: what the gene range and the sort use
    geneMin: 0,
    geneMax: 100,
    // "More filters"
    sizeMin: 0, sizeMax: 100,
    longevityMin: 0, longevityMax: 100,
    fertilityMin: 0, fertilityMax: 100,
    immunityMin: 0, immunityMax: 100,
    pregnant: 'any',      // 'any' | 'hide' | 'only'
    tags: Object.freeze([]), // storage tags picked (0..4); none = any
    keepBest: 0,          // > 0: only what is left after the best N of each species and sex
    priceMin: 0,          // recommended price, CC; 0 = no lower bound
    priceMax: 0,          // 0 = no upper bound
    kin: 'any',           // 'any' | 'related' (a close relative in storage) | 'unrelated'
    text: '',             // name contains (any case)
    sort: 'best',         // DESK_SORTS
});

const MAIN_KEYS = ['sex', 'ages', 'fertile', 'medals', 'state', 'geneMin', 'geneMax'];
const MORE_KEYS = ['sizeMin', 'sizeMax', 'longevityMin', 'longevityMax', 'fertilityMin', 'fertilityMax', 'immunityMin', 'immunityMax',
    'pregnant', 'tags', 'keepBest', 'priceMin', 'priceMax', 'kin', 'text'];

const clampPct = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const listOf = (v, list) => (Array.isArray(v) ? Array.from(new Set(v.filter(x => list.includes(x)))) : []);

// Any saved or partial filter object -> a complete, valid one. Older shapes
// still read: medal 'silver' (silver or better), age 'fertile'.
export function normalizeFilters(f) {
    const o = Object.assign({}, DESK_FILTERS, { ages: [], medals: [], tags: [] });
    if (!f || typeof f !== 'object') return o;
    o.species = typeof f.species === 'string' && f.species ? f.species : null;
    o.sex = oneOf(f.sex, ['any', 'male', 'female'], 'any');
    o.ages = listOf(f.ages, DESK_AGES);
    o.fertile = oneOf(f.fertile, ['any', 'yes', 'no'], 'any');
    if (f.age === 'fertile') o.fertile = 'yes';
    o.medals = listOf(f.medals, MEDALS);
    if (typeof f.medal === 'string' && MEDAL_RANK[f.medal] != undefined) o.medals = MEDALS.filter(m => MEDAL_RANK[m] >= MEDAL_RANK[f.medal]);
    o.state = oneOf(f.state, ['any', 'sellable', 'quick', 'listed', 'blocked'], 'any');
    o.geneBasis = oneOf(f.geneBasis, Object.keys(GENE_BASES), 'overall');
    for (const k of ['gene'].concat(GENE_KEYS)) {
        const lo = f[k + 'Min'] == undefined ? 0 : clampPct(f[k + 'Min']);
        const hi = f[k + 'Max'] == undefined ? 100 : clampPct(f[k + 'Max']);
        o[k + 'Min'] = Math.min(lo, hi);
        o[k + 'Max'] = Math.max(lo, hi);
    }
    o.pregnant = oneOf(f.pregnant, ['any', 'hide', 'only'], 'any');
    o.tags = listOf((Array.isArray(f.tags) ? f.tags : []).map(Number), [0, 1, 2, 3, 4]);
    o.keepBest = Math.max(0, Math.min(99, Math.round(Number(f.keepBest) || 0)));
    o.priceMin = Math.max(0, Math.round(Number(f.priceMin) || 0));
    o.priceMax = Math.max(0, Math.round(Number(f.priceMax) || 0));
    if (o.priceMax && o.priceMin > o.priceMax) o.priceMax = o.priceMin;
    o.kin = oneOf(f.kin, ['any', 'related', 'unrelated'], 'any');
    o.text = typeof f.text === 'string' ? f.text.slice(0, 40) : '';
    o.sort = oneOf(f.sort, Object.keys(DESK_SORTS), 'best');
    return o;
}

function differs(f, k) {
    const a = f[k], b = DESK_FILTERS[k];
    if (Array.isArray(b)) return Array.isArray(a) && a.length > 0;
    if (k === 'text') return typeof a === 'string' && a.trim() !== '';
    return a !== b;
}

// How many filters are set, on the main bar and under "More filters" (a
// min/max pair counts once).
export function activeFilterCount(f) {
    const n = keys => {
        const seen = new Set();
        for (const k of keys) if (differs(f, k)) seen.add(k.replace(/M(in|ax)$/, ''));
        return seen.size;
    };
    const main = n(MAIN_KEYS);
    const more = n(MORE_KEYS);
    return { main, more, total: main + more };
}

// Back to the defaults, keeping the species, the sort and the gene basis.
export function resetFilters(f) {
    return Object.assign(normalizeFilters(null), { species: f ? f.species : null, sort: f ? f.sort : 'best', geneBasis: f ? f.geneBasis : 'overall' });
}

const AGE_OF = {
    [Maturity.Infant]: 'juvenile',
    [Maturity.YoungAdult]: 'young', [Maturity.YoungAdultInfertile]: 'young',
    [Maturity.Adult]: 'adult', [Maturity.AdultInfertile]: 'adult',
    [Maturity.Elderly]: 'elderly', [Maturity.ElderlyInfertile]: 'elderly',
};
export function ageOf(a) {
    return AGE_OF[a.maturity] || null;
}

function isFertile(a) {
    return a.maturity == Maturity.YoungAdult || a.maturity == Maturity.Adult || a.maturity == Maturity.Elderly;
}

function pct(v) {
    return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) : null;
}

// One gene 0..100 as the game shows it (a dash where it doesn't count: size
// and immunity on exhibit animals, every gene on shoals).
export function geneOf(a, k) {
    return relevantGenes(a).includes(k) ? pct((a.genes || {})[k]) : null;
}

// The score the gene range and the sort use, 0..100 or null.
export function basisScore(r, basis = 'overall') {
    if (basis === 'overall') return r.score;
    if (basis === 'breeder') return breederScore(r.a);
    return geneOf(r.a, basis);
}

// Row ids beyond the best `keep` of each species and sex, best first by the
// basis (unknown scores last). Only animals the desk could list count: one on
// the market, a juvenile, an elderly infertile or a moving animal never takes
// a kept place (else the best adult could be the one sold). These are the
// cull candidates.
export function beyondBest(rows, keep, basis = 'overall') {
    const out = new Set();
    if (!(keep > 0)) return out;
    const groups = new Map();
    for (const r of rows) {
        if (r.block) continue;
        const k = `${r.species}|${r.a.gender}`;
        let g = groups.get(k);
        if (!g) groups.set(k, g = []);
        g.push(r);
    }
    for (const g of groups.values()) {
        if (g.length <= keep) continue;
        g.map(r => ({ r, s: basisScore(r, basis) }))
            .sort((x, y) => ((y.s ?? -1) - (x.s ?? -1)) || String(x.r.a.name || '').localeCompare(String(y.r.a.name || '')) || String(x.r.id).localeCompare(String(y.r.id)))
            .slice(keep)
            .forEach(x => out.add(x.r.id));
    }
    return out;
}

// ctx: { related: a => bool (Kin, when it knows storage), nameOf: a => string }
export function filterRows(rows, filters = DESK_FILTERS, ctx = {}) {
    const f = normalizeFilters(filters);
    const beyond = f.keepBest > 0 ? beyondBest(rows, f.keepBest, f.geneBasis) : null;
    const text = f.text.trim().toLowerCase();
    const nameOf = ctx.nameOf || (a => String(a.name || ''));
    const geneRange = f.geneMin > 0 || f.geneMax < 100;
    return rows.filter(r => {
        const a = r.a;
        if (f.species && r.species !== f.species) return false;
        if (f.sex === 'male' && a.gender != Gender.Male) return false;
        if (f.sex === 'female' && a.gender != Gender.Female) return false;
        if (f.ages.length && !f.ages.includes(ageOf(a))) return false;
        if (f.fertile === 'yes' && !isFertile(a)) return false;
        if (f.fertile === 'no' && isFertile(a)) return false;
        if (f.medals.length && !(r.medal != undefined && f.medals.includes(r.medal))) return false;
        if (f.state === 'sellable' && r.block) return false;
        if (f.state === 'quick' && r.block !== 'quick') return false;
        if (f.state === 'listed' && r.block !== 'listed') return false;
        if (f.state === 'blocked' && (!r.block || r.block === 'listed' || r.block === 'quick')) return false;
        if (geneRange) {
            const s = basisScore(r, f.geneBasis);
            if (s == null || s < f.geneMin || s > f.geneMax) return false;
        }
        for (const k of GENE_KEYS) {
            const lo = f[k + 'Min'], hi = f[k + 'Max'];
            if (lo === 0 && hi === 100) continue;
            const v = geneOf(a, k);
            if (v == null || v < lo || v > hi) return false;
        }
        if (f.pregnant === 'hide' && a.isPregnant) return false;
        if (f.pregnant === 'only' && !a.isPregnant) return false;
        if (f.tags.length && !f.tags.includes(Number(a.storageTag) || 0)) return false;
        if (beyond && !beyond.has(r.id)) return false;
        const price = r.advice && r.advice.price > 0 ? r.advice.price : 0;
        if (f.priceMin > 0 && price < f.priceMin) return false;
        if (f.priceMax > 0 && !(price > 0 && price <= f.priceMax)) return false;
        if (f.kin !== 'any' && typeof ctx.related === 'function') {
            const rel = !!ctx.related(a);
            if (f.kin === 'related' ? !rel : rel) return false;
        }
        if (text && !nameOf(a).toLowerCase().includes(text)) return false;
        return true;
    });
}

// What "Tick all" takes: sellable now and not tagged Keep in storage (unless
// the player filtered to Keep-tagged animals on purpose). A Quick trade row
// is not listable (its block says so); in List mode it is never ticked.
// (A quick mode ticks by quickEligible instead: its own 'quick' rows only.)
export function tickable(r, filters = DESK_FILTERS) {
    if (r.block) return false;
    const tags = (filters && filters.tags) || [];
    return !(Number(r.a.storageTag) === TAG_KEEP && !tags.includes(TAG_KEEP));
}

// Desk order: sellable first, then by the chosen sort (genes by the basis),
// then by name.
export function sortRows(rows, sort = 'best', basis = 'overall') {
    const name = r => String(r.a.name || '');
    const price = r => (r.advice && r.advice.price) || 0;
    const by = {
        best: (x, y) => (basisScore(y, basis) ?? -1) - (basisScore(x, basis) ?? -1),
        worst: (x, y) => (basisScore(x, basis) ?? 101) - (basisScore(y, basis) ?? 101),
        price: (x, y) => price(y) - price(x),
    }[sort] || (() => 0);
    return rows.slice().sort((x, y) => (!!x.block - !!y.block) || by(x, y) || name(x).localeCompare(name(y)));
}

// The engine's job text (docs/DESIGN-market-desk.md): "v1 <paceMs>", then
// "<guid> <key> <price|-> <hours>" per animal. Rows without a GUID or with
// a block are left out (the engine would skip them anyway).
// onRefused: 'leave' | 'quicktrade' | 'release' (the desk's option, see
// REFUSED_OPTIONS); refusedMax: at most this many quick actions after a
// refusal (Quick release before its first confirmed run: 1).
export function encodeJob(rows, { paceMs = 3000, hours = 'max', onRefused = 'leave', refusedMax = null } = {}) {
    const head = [`v1 ${Math.max(1000, Math.round(paceMs))}`];
    if (onRefused === 'quicktrade' || onRefused === 'release') {
        head.push('list', `onrefused=${onRefused}`);
        if (Number.isFinite(refusedMax) && refusedMax >= 0) head.push(`refusedmax=${Math.floor(refusedMax)}`);
    }
    const lines = [head.join(' ')];
    const items = [];
    for (const r of rows) {
        if (!r.guid || r.block || !GUID_TOKEN.test(r.guid) || !/^[A-Za-z0-9_]+$/.test(String(r.key))) continue;
        const p = r.advice && r.advice.price > 0 ? String(Math.round(r.advice.price)) : '-';
        const hr = hours === 'max' || hours === 'default' ? hours : String(Math.max(1, Math.round(hours)));
        lines.push(`${r.guid} ${r.key} ${p} ${hr}`);
        items.push(r);
    }
    return { text: lines.join('\n'), items };
}

// "When the server refuses a listing" (developer, 2026-10-18: the same
// animals fail to list in vanilla too, but can be quick-traded). A
// player-wide pref (prefs.js 'deskRefused'); Leave it by default.
export const REFUSED_OPTIONS = Object.freeze({ leave: 'Leave it', quicktrade: 'Quick trade it', release: 'Quick release it' });

export function normalizeRefused(v) {
    return REFUSED_OPTIONS[v] ? v : 'leave';
}

// What the List button and the panel say up front when it is not Leave it:
// "Refused ones will be quick-traded at once (permanent)". '' for Leave it.
export function refusedNote(opt, { limitOne = false } = {}) {
    const o = normalizeRefused(opt);
    if (o === 'leave') return '';
    const what = o === 'quicktrade' ? 'quick-traded' : 'released';
    return `Refused ones: ${what} at once (permanent)${limitOne ? ', the first one only' : ''}.`;
}

// What a job left out of the animals asked for, for the player:
// "Listing 3 of 39: 36 couldn't be identified by the game" (and the others
// that can't be listed now); '' when the job holds them all.
//   inJob: animals in the job; asked: animals ticked; noid: of those, no id
export function partialJobText({ inJob = 0, asked = 0, noid = 0 } = {}) {
    if (!(asked > inJob)) return '';
    const other = Math.max(0, asked - inJob - noid);
    const why = [];
    if (noid > 0) why.push(`${noid} couldn't be identified by the game`);
    if (other > 0) why.push(`${other} can't be listed now`);
    return `Listing ${inJob} of ${asked}${why.length ? `: ${why.join(', ')}` : ''}`;
}

// The engine's state, made safe to read (missing fields filled).
export function normalizeState(s) {
    if (!s || typeof s !== 'object') return null;
    const results = Array.isArray(s.results) ? s.results.filter(x => x && x.guid != undefined).map(x => Object.assign({ status: 'pending', kind: '', detail: '' }, x, { guid: String(x.guid) })) : [];
    return Object.assign({ run: 0, phase: 'running', mode: 'list', total: results.length, index: 0, step: '', waited: 0, message: '' }, s, { results });
}

// Counts of a run's results.
export function tally(state) {
    const t = { total: 0, pending: 0, working: 0, listed: 0, checked: 0, traded: 0, released: 0, unconfirmed: 0, unlisted: 0, skipped: 0, refused: 0, timeout: 0, stopped: 0, earned: 0, kinds: {} };
    if (!state) return t;
    for (const r of state.results) {
        t.total++;
        if (t[r.status] != undefined) t[r.status]++;
        if (r.status === 'listed' && r.price > 0) t.earned += r.price;
        if (r.status !== 'listed' && r.status !== 'pending' && r.status !== 'working' && r.kind) t.kinds[r.kind] = (t.kinds[r.kind] || 0) + 1;
    }
    return t;
}

// "listed 7 of 10 (≈ 9,800 CC); skipped 2 (2 refused by the server); 1 not started"
// note: what the page left out of the job ({ noid, asked }, listAnimals):
// "…; 36 of the 39 ticked couldn't be identified by the game (not in the job)"
export function summaryText(state, fmt = n => String(n), note = null) {
    const t = tally(state);
    if (!t.total) return 'Nothing to list.';
    const parts = [`listed ${t.listed} of ${t.total}${t.earned ? ` (≈ ${fmt(t.earned)} CC asked)` : ''}`];
    // quick-traded / released after the server refused the listing
    const after = state.results.filter(r => r.afterRefused && (r.status === 'traded' || r.status === 'released'));
    if (after.length) {
        const sum = after.reduce((n, r) => n + (r.price > 0 ? r.price : 0), 0);
        const rel = after[0].status === 'released';
        parts.push(`${rel ? 'released' : 'quick-traded'} ${after.length} after refusal${sum ? ` (${rel ? `${fmt(sum)} CC` : `$${fmt(sum)}`})` : ''}`);
    }
    const notListed = t.skipped + t.refused + t.timeout + t.stopped + t.unconfirmed;
    if (notListed) {
        const kinds = Object.entries(t.kinds).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n} ${RESULT_WORDS[k] || k}`).join(', ');
        parts.push(`not listed ${notListed}${kinds ? ` (${kinds})` : ''}`);
    }
    if (t.pending) parts.push(`${t.pending} not started`);
    if (note && note.noid > 0) parts.push(`${note.noid}${note.asked ? ` of the ${note.asked} ticked` : ''} couldn't be identified by the game (not in the job)`);
    const s = parts.join('; ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// The GUIDs of a finished run worth another try: skipped for a passing
// reason, refused, timed out, or never started.
const RETRY_KINDS = new Set(['busy', 'unselectable', 'changed', 'refused', 'timeout', 'error', 'closed', 'stopped']);
// Why the game won't trade an animal: its reason is a header ("Cannot send
// to trading as the following issues apply...") and one loc token per
// problem, [AnimalList_Problem_<Key>]; shown here as just the problems,
// translated (English if the game has no text). The same rules disable the
// game's own Trade button (AnimalStorageInfoPanel.js tradeAllowed /
// tradeDisallowedReason), so these are never sent to the server.
export const TRADE_PROBLEM_WORDS = Object.freeze({
    Juvenile_Sell: 'juvenile animals cannot be traded',
    CantBeSold: 'it must stay in the zoo for this scenario',
    Pregnant: 'pregnant',
    SeriouslyInjured: 'injured',
    Infertile_Sell: 'infertile animals cannot be traded (contraception counts)',
    BlockedByScenario: 'not at this point in the scenario',
    HasCondition: 'restrictive adoption terms',
    Infected: 'infected',
    PendingTransport: 'waiting for transport',
    // seen in game greying out Trade and Quick release (developer, 2026-10-18)
    NoBirthZoo: 'not born in a player zoo',
    CashSeeded: 'bought for cash',
});

export function tradeProblemKeys(detail) {
    const out = [];
    const re = /AnimalList_Problem_([A-Za-z0-9_]+)/g;
    let m;
    while ((m = re.exec(String(detail || '')))) if (!out.includes(m[1])) out.push(m[1]);
    return out;
}

// A result's detail in words. tr: the game's translate (may throw).
export function reasonText(kind, detail, tr = s => s) {
    if (!detail) return '';
    const safe = s => {
        try {
            const v = tr(s);
            return typeof v === 'string' && v && !v.startsWith('[') ? v : null;
        }
        catch (e) {
            return null;
        }
    };
    if (kind === 'untradeable') {
        const keys = tradeProblemKeys(detail);
        if (keys.length) return keys.map(k => safe(`[AnimalList_Problem_${k}]`) || TRADE_PROBLEM_WORDS[k] || k.replace(/_/g, ' ')).join('; ');
        // no problem token: the translated text without its header line
        const full = safe(detail) || String(detail);
        const lines = full.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        return lines.length > 1 ? lines.slice(1).join('; ') : full;
    }
    if (kind === 'refused' && /\(Unknown\)/.test(detail)) {
        return "the server gave no reason (the game's own Trade button gets the same answer). It happens most right after an animal was moved to storage; try it again later";
    }
    return safe(detail) || String(detail);
}

export function retryGuids(state) {
    // a check run lists nothing, and a quick run is never retried by a click
    if (!state || (state.mode && state.mode !== 'list')) return [];
    return state.results.filter(r => r.status === 'pending' || (r.status !== 'listed' && RETRY_KINDS.has(r.kind))).map(r => r.guid);
}

// Page-assisted reads for the engine (docs/DESIGN-market-desk.md): while it
// selects an animal, the page reads the selection, tradeAllowed and the
// listing limits from its DataStore (Lua's own reads never saw the
// selection in game, Y: 2026-10-17) and reports them in plain text (the
// mod's Lua has no JSON decoder; pz2qol.lister.lua parseSeen).
export const SEEN_CONTEXTS = Object.freeze({
    data: ['hubAnimalsData', 'animalStorageData'],
    actions: ['hubAnimalsData', 'animalStorageData', 'actions'],
    limits: ['animalTradeListingData'],
    network: ['hubAnimalsData', 'network'],
    filters: ['hubAnimalsData', 'animalStorageData', 'filters'],
    list: ['hubAnimalsData', 'animalStorageData', 'list'],
});
export const SEEN_LIMITS = Object.freeze(['tradePriceMin', 'tradePriceMax', 'tradePriceDefault', 'tradeDurationMin', 'tradeDurationMax', 'tradeDurationDefault']);
// The selection's quick actions (AnimalMarketAndStorageSchema.js actions;
// the numeric prices are in animalTradeListingData, AnimalTradeListingSchema.js).
export const SEEN_QUICK = Object.freeze({
    flags: Object.freeze(['quickTradeAllowed', 'quickReleaseAllowed', 'rehomeAllowed']),
    texts: Object.freeze(['quickTradeDisallowedReason', 'quickTradeValue', 'quickReleaseDisallowedReason', 'quickReleaseValue']),
    prices: Object.freeze(['quickTradePrice', 'quickReleasePrice']),
});

// What the page sees for row key `key`; read(context, prop) is the DataStore
// read (game.js get). sel null: the selection could not be read.
export function readSeen(key, read) {
    const r = (c, p) => {
        try {
            return read(c, p);
        }
        catch (e) {
            return undefined;
        }
    };
    const v = r(SEEN_CONTEXTS.data, 'selectedAnimalIDs');
    const sel = Array.isArray(v) ? v.filter(x => typeof x === 'string' || typeof x === 'number').map(String) : null;
    const allowed = r(SEEN_CONTEXTS.actions, 'tradeAllowed');
    const reason = r(SEEN_CONTEXTS.actions, 'tradeDisallowedReason');
    const limits = {};
    for (const p of SEEN_LIMITS) {
        const n = r(SEEN_CONTEXTS.limits, p);
        limits[p] = typeof n === 'number' && Number.isFinite(n) ? n : null;
    }
    const bool = v => (typeof v === 'boolean' ? v : null);
    const text = v => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const quick = {};
    for (const p of SEEN_QUICK.flags) quick[p] = bool(r(SEEN_CONTEXTS.actions, p));
    for (const p of SEEN_QUICK.texts) quick[p] = text(r(SEEN_CONTEXTS.actions, p));
    for (const p of SEEN_QUICK.prices) quick[p] = num(r(SEEN_CONTEXTS.limits, p));
    return {
        key: String(key), sel, allowed: typeof allowed === 'boolean' ? allowed : null, reason: typeof reason === 'string' ? reason : '', limits, quick,
        // Phase 0a (docs/PLAN-desk-quick-release.md 2): does a select send a
        // request; does the row's source or the releaseable filter classify it
        net: { connecting: bool(r(SEEN_CONTEXTS.network, 'connectingAction')), loading: bool(r(SEEN_CONTEXTS.network, 'loadingItems')) },
        releaseable: bool(r(SEEN_CONTEXTS.filters, 'isReleaseable')),
        source: text(r(SEEN_CONTEXTS.list.concat(String(key)), 'source')),
    };
}

// The page report v2 (pz2qol.lister.lua parseSeen reads v1 and v2): every
// text field percent-encoded (encodeURIComponent: no raw "|" or "," left), so
// the reasons (nested loc tokens with "|" in them) can sit anywhere.
// "v2|<key>|<sel,...|?>|<allowed 1|0|->|<pmin,pmax,pdef,hmin,hmax,hdef>|<reason%>|
//  <quickTrade>|<its reason%>|<its value%>|<quickRelease>|<its reason%>|<its value%>|
//  <rehome>|<quickTradePrice,quickReleasePrice>|<connecting,loading>|<isReleaseable>|<source%>"
export function encodeSeen(s) {
    const token = x => String(x).replace(/[|,\s]/g, '');
    const flag = v => (v === true ? '1' : v === false ? '0' : '-');
    const n = v => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '-');
    const pct = v => encodeURIComponent(String(v == undefined ? '' : v));
    const sel = Array.isArray(s.sel) ? s.sel.map(token).filter(Boolean).join(',') : '?';
    const lim = SEEN_LIMITS.map(p => n(s.limits ? s.limits[p] : null)).join(',');
    const q = s.quick || {};
    const net = s.net || {};
    return ['v2', token(s.key), sel, flag(s.allowed), lim, pct(s.reason),
        flag(q.quickTradeAllowed), pct(q.quickTradeDisallowedReason), pct(q.quickTradeValue),
        flag(q.quickReleaseAllowed), pct(q.quickReleaseDisallowedReason), pct(q.quickReleaseValue),
        flag(q.rehomeAllowed), `${n(q.quickTradePrice)},${n(q.quickReleasePrice)}`,
        `${flag(net.connecting)},${flag(net.loading)}`, flag(s.releaseable), pct(s.source), token(s.page || '')].join('|');
}

// What Lua's parseSeen makes of a report (v1 or v2), for the tests and the
// harness: { v, key, sel, allowed, reason, limits, quick?, net?, releaseable?, source? } or null.
export function decodeSeen(text) {
    const s = String(text == undefined ? '' : text);
    const flag = v => (v === '1' ? true : v === '0' ? false : null);
    const nums = v => String(v || '').split(',').map(x => (x === '' || x === '-' || !Number.isFinite(Number(x)) ? null : Number(x)));
    const sel = v => (v === '?' ? null : String(v || '').split(',').filter(Boolean));
    const limits = v => {
        const n = nums(v);
        return Object.fromEntries(SEEN_LIMITS.map((p, i) => [p, n[i] ?? null]));
    };
    const unpct = v => {
        try {
            return decodeURIComponent(v || '');
        }
        catch (e) {
            return String(v || '');
        }
    };
    if (s.startsWith('v2|')) {
        const t = s.slice(3).split('|');
        if (t.length < 16 || !t[0]) return null;
        const p = nums(t[12]);
        const net = String(t[13] || '').split(',');
        return {
            v: 2, key: t[0], sel: sel(t[1]), allowed: flag(t[2]), limits: limits(t[3]), reason: unpct(t[4]),
            quick: {
                quickTradeAllowed: flag(t[5]), quickTradeDisallowedReason: unpct(t[6]), quickTradeValue: unpct(t[7]),
                quickReleaseAllowed: flag(t[8]), quickReleaseDisallowedReason: unpct(t[9]), quickReleaseValue: unpct(t[10]),
                rehomeAllowed: flag(t[11]), quickTradePrice: p[0] ?? null, quickReleasePrice: p[1] ?? null,
            },
            net: { connecting: flag(net[0]), loading: flag(net[1]) }, releaseable: flag(t[14]), source: unpct(t[15]),
            page: t[16] || null,
        };
    }
    const m = /^v1\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([\s\S]*)$/.exec(s);
    if (!m || !m[1]) return null;
    return { v: 1, key: m[1], sel: sel(m[2]), allowed: flag(m[3]), limits: limits(m[4]), reason: m[5] };
}

// The old report, v1 (what an older Main.ovl reads; kept for the tests):
// "v1|<key>|<sel,...|?>|<1|0|->|<pmin,pmax,pdef,hmin,hmax,hdef (- none)>|<reason>"
export function encodeSeenV1(s) {
    const token = x => String(x).replace(/[|,\s]/g, '');
    const sel = Array.isArray(s.sel) ? s.sel.map(token).filter(Boolean).join(',') : '?';
    const allowed = s.allowed === true ? '1' : s.allowed === false ? '0' : '-';
    const lim = SEEN_LIMITS.map(p => {
        const n = s.limits ? s.limits[p] : null;
        return typeof n === 'number' && Number.isFinite(n) ? String(n) : '-';
    }).join(',');
    const reason = String(s.reason || '').replace(/[\r\n]/g, ' ');
    return ['v1', token(s.key), sel, allowed, lim, reason].join('|');
}

// ------------------------------------------------- what storage was scoped to
// The game filters the storage list natively: with a species (or any other)
// filter on, ['hubAnimalsData','animalStorageData','list'] holds only the rows
// that pass (startscreen.globe.animalstoragehubmode.lua: StorageUISetSpeciesFilter
// / ...ApplyFilters, then StorageUIRequestData). The filters it shows are under
// ['hubAnimalsData','animalStorageData','filters'] (AnimalMarketAndStorageSchema.js);
// range sliders are left out (their defaults are native), the row count
// (animalsInStorage) catches them.
export const NATIVE_FILTER_LISTS = Object.freeze(['filteredSpecies', 'filteredSpeciesType', 'filteredSpeciesTags', 'filteredSalinity', 'filteredBiomes',
    'filteredEcosystems', 'filteredContinents', 'filteredConservationStatus']);
export const NATIVE_FILTER_FLAGS = Object.freeze(['isHabitat', 'isExhibit', 'isShoal', 'isMale', 'isFemale', 'isUnisex', 'hasColormorph', 'isReleaseable']);

// read(prop) -> the filters context's value. -> names of the filters on.
export function nativeFiltersOn(read) {
    const on = [];
    const val = p => {
        try {
            return read(p);
        }
        catch (e) {
            return undefined;
        }
    };
    const text = val('filterInputText');
    if (typeof text === 'string' && text.trim()) on.push('filterInputText');
    for (const p of NATIVE_FILTER_LISTS) {
        const v = val(p);
        const n = Array.isArray(v) ? v.length : v && typeof v === 'object' && typeof v.length === 'number' ? v.length : 0;
        if (n > 0) on.push(p);
    }
    for (const p of NATIVE_FILTER_FLAGS) if (val(p) === true) on.push(p);
    return on;
}

// "[Animal_Lion]" / "Animal_Lion" / "Lion" -> "lion" (as scores.js normSpecies)
const speciesKey = s => String(s == null ? '' : s).trim().replace(/^\[/, '').replace(/\]$/, '').replace(/^Animal_/i, '').toLowerCase().replace(/[^a-z0-9_]/g, '');

// What the storage screen showed when the desk opened.
//   rows: readAnimal() rows of the list as the game gave it; total: its
//   animalsInStorage (or null); active: nativeFiltersOn(); modSpecies: the
//   mod's own storage species filter ('' none; it never narrows the list
//   the desk reads, only the screen).
// -> { filtered: the list may hold only part of storage (worth clearing),
//      known: a filter the game shows is on (worth saying so), species: the
//      one species it was scoped to (the rows' own spelling) or null, active }
// What animalsInStorage counts is not proven (shoals?): a count alone only
// makes the desk try, never claim, that storage is filtered.
export function storageScope({ rows = [], total = null, active = [], modSpecies = '' } = {}) {
    const list = (rows || []).filter(a => a && a.species);
    const known = (active || []).length > 0;
    const filtered = known || (typeof total === 'number' && Number.isFinite(total) && total > (rows || []).length);
    let species = null;
    const want = speciesKey(modSpecies);
    if (want) {
        const hit = list.find(a => speciesKey(a.species) === want);
        species = hit ? hit.species : null;
    }
    if (!species && filtered) {
        const kinds = new Set(list.map(a => a.species));
        if (kinds.size === 1) species = list[0].species;
    }
    return { filtered, known, species, active: (active || []).slice() };
}
