// Auto mode, one species at a time: on the schedule the player chose on the
// Species board, Thin out (if chosen) and then the species' Breeding
// programme are worked out with the settings saved for it, and the moves
// run one at a time like the board's Execute (kinauto.js). Pure, no game
// imports (Node tests). Design: docs/DESIGN-autopilot.md section 16.
//
// Never moved by Auto mode: animals the player marked "hands off", animals
// the player moved by hand (for a while), pregnant females, animals on the
// move. Animals Auto mode sent to the trade centre stay there (the
// programme never brings them back), so Thin out and the programme can't
// trade an animal back and forth.
//
// Why it settles: on a zoo that does not change, the programme's plan only
// ever raises its own score (every move it keeps gains something), and
// Thin out only takes animals away. So runs stop finding work until
// something changes in the zoo (a birth, a death, the player).
import { TRADE, canMove, isPinned, moveText, simulatePlan } from './kinboardcore.js';
import { PROGRAMME_DEFAULT_STEP, PROGRAMME_STEPS, isBreeder, planProgramme } from './kinprogramme.js';
import { FILL_STEPS, cullPlan } from './kincull.js';
import { Sex, buildKinModel } from './kincore.js';

// How often a species' run comes round, in months of the park's calendar
// (12 a year, 3 a season): game time, so it stops while the game is paused
// and runs faster at 2x and 5x.
export const EVERY_CHOICES = Object.freeze([1, 3, 6, 12]);

// One species' settings, as kept per zoo (kinautoledger.js).
export const SPECIES_DEFAULTS = Object.freeze({
    on: false,
    every: 3,                   // EVERY_CHOICES (months): a season
    step: PROGRAMME_DEFAULT_STEP, // PROGRAMME_STEPS: Fewest moves .. Best genetics
    trade: true,                // the programme may bring breeders from the trade centre
    thin: true,                 // then Thin out the habitats over their room
    fill: 'balanced',           // Thin out's fill level (FILL_STEPS)
});

// The search budget of one run (the board's Breeding programme uses the same).
export const AUTO_SEARCH = Object.freeze({ maxEvaluations: 3000000, timeBudgetMs: 6000 });

export const AUTO_LIMITS = Object.freeze({
    manualYears: 2,             // an animal the player moved stays put this long (years of the park's calendar)
    cooldownYears: 1,           // an animal Auto mode moved stays put this long: as births and
                                // ageing change the zoo, the programme's best layout shifts, and
                                // without this it would move some animals back and forth
    growUpYears: 0.5,           // young this close to growing up count as breeders (they are
                                // moved away from a parent before they can breed with it)
    reversalYears: 1,           // a move back to where it left within this counts as a reversal
    reversalsToStop: 2,         // that many reversals in the window: Auto stops for the species
    settleMs: 60000,            // after a zoo loads: watch this long first
    settleScans: 3,
    pauseAfterSkipsMs: 10 * 60 * 1000, // a run with this many refusals pauses the species
    skipsToPause: 3,
});

// A kept settings object, checked (unknown values fall back to the defaults).
export function normalizeSpecies(raw) {
    const s = Object.assign({}, SPECIES_DEFAULTS);
    if (!raw || typeof raw !== 'object') return s;
    s.on = raw.on === true || raw.on === 1;
    if (EVERY_CHOICES.includes(Number(raw.every))) s.every = Number(raw.every);
    if (Number.isInteger(raw.step) && raw.step >= 0 && raw.step < PROGRAMME_STEPS.length) s.step = raw.step;
    if (raw.trade === false || raw.trade === 0) s.trade = false;
    if (raw.thin === false || raw.thin === 0) s.thin = false;
    if (FILL_STEPS.some(f => f.id === raw.fill)) s.fill = raw.fill;
    return s;
}

// The programme's options for these settings (the board's programmeOptions
// with the same slider step, trade switch and make-up).
export function programmeOptionsFor(settings, ratio = 'auto', pinIds = null) {
    const st = PROGRAMME_STEPS[settings.step] || PROGRAMME_STEPS[PROGRAMME_DEFAULT_STEP];
    const o = { moveCost: st.cost, useTradeCentre: settings.trade !== false, ratio: ratio || 'auto' };
    if (st.outsider != null) o.outsiderCost = st.outsider;
    if (pinIds && pinIds.size) o.pinIds = pinIds;
    return Object.assign(o, AUTO_SEARCH);
}

export function fillOf(settings) {
    const st = FILL_STEPS.find(x => x.id === settings.fill) || FILL_STEPS.find(x => x.id === SPECIES_DEFAULTS.fill);
    return st.fill;
}

const asSet = v => (v instanceof Set ? v : new Set(Array.isArray(v) ? v.map(String) : []));

function homeOf(a) {
    return a.hab || (a.lt === 'trade' ? TRADE : '');
}

// The ledger's view for this load, checked: { pinned, manual, leaving,
// recentFrom: Map(id -> Set(hab)), blocked: Set('id>to') }.
function viewOf(v) {
    const o = v || {};
    const recent = new Map();
    const src = o.recentFrom instanceof Map ? o.recentFrom : new Map(Object.entries(o.recentFrom || {}));
    for (const [k, s] of src) recent.set(String(k), asSet(s));
    return { pinned: asSet(o.pinned), manual: asSet(o.manual), cooled: asSet(o.cooled), leaving: asSet(o.leaving), recentFrom: recent, blocked: asSet(o.blocked) };
}

// The animals Auto mode leaves where they are (hands off, moved by the
// player, moved by Auto mode itself lately), and those the programme
// treats as fixed (also the ones it sent away, which stay away).
export function locksOf(model, species, view) {
    const v = viewOf(view);
    const locked = new Set();
    for (const a of model.animals.values()) {
        if (a.species !== species) continue;
        if (v.pinned.has(a.id) || v.manual.has(a.id) || v.cooled.has(a.id)) locked.add(a.id);
    }
    const pins = new Set(locked);
    for (const id of v.leaving) {
        const a = model.animals.get(id);
        if (a && a.species === species && homeOf(a) === TRADE) pins.add(id);
    }
    return { locked, pins, view: v };
}

// One run, in two halves around the Breeding programme (the runtime runs
// the programme's search in slices in between):
//
//   1. Thin out (if chosen) on the zoo as it is: adults over each
//      habitat's fill level go to the trade centre, the old and infertile
//      first. It comes first because the programme counts the adults that
//      don't breed as fixed room: with them still there it would send
//      breeders away instead.
//   2. The programme on the zoo as Thin out leaves it, with the animals
//      Auto mode must not move pinned (and the ones just sent away).
//
// input: { model, species, info, destinations, assignments, settings
//          (normalizeSpecies), ratio (the board's make-up choice), view
//          (kinautoledger ledgerView), tradeFree (places left at the trade
//          centre, null: unknown) }
// prepareAutoRun(input) -> { model (after Thin out), pins, ... } for the
// programme; finishAutoRun(input, prep, programmeResult) -> the run:
// { species, moves: [{ id, to, reason, stage: 'thin'|'programme', reversal }],
//   programme, thin, notes: [text], held: [{ id, why }] }
// planAutoRun(input) does all three at once (tests).
export function prepareAutoRun(input) {
    const { model, species, info = null, destinations = null } = input;
    const settings = normalizeSpecies(Object.assign({}, input.settings, { on: true }));
    const out = { species, moves: [], programme: null, thin: null, notes: [], held: [] };
    const prep = { out, settings, model, pins: new Set(), locked: new Set(), view: viewOf(input.view), taken: new Set(), tradeLeft: Infinity };
    if (!model || !species) return prep;
    const { locked, pins, view } = locksOf(model, species, input.view);
    Object.assign(prep, { locked, pins, view, tradeLeft: input.tradeFree == null ? Infinity : Math.max(0, input.tradeFree) });
    if (settings.thin) {
        // animals Auto mode placed lately stay (Thin out does not undo the
        // programme's last runs), and so does what it must not touch
        const keepIds = new Set(locked);
        for (const id of view.recentFrom.keys()) keepIds.add(id);
        const c = cullPlan(model, species, info || {}, { options: { fill: fillOf(settings), ratio: input.ratio || 'auto', keepIds } });
        out.thin = c;
        if (c) for (const m of c.moves) addMove(prep, model.animals.get(String(m.id)), TRADE, `Thin out: ${m.reason}`, 'thin');
    }
    if (out.moves.length) {
        prep.model = simulatePlan(model, out.moves, destinations);
        for (const m of out.moves) prep.pins.add(m.id);
    }
    prep.model = projectGrownUp(prep.model, species, info, AUTO_LIMITS.growUpYears);
    return prep;
}

// The zoo with the species' young that grow up within `years` shown as
// adults, so the programme places them as breeders (away from a parent)
// before they can breed. The same model when there are none.
export function projectGrownUp(model, species, info, years) {
    const facts = (model && model.speciesFacts && model.speciesFacts[species]) || {};
    const ages = (info && info.fertilityAges) || {};
    const maturity = ages.maturity != null ? ages.maturity : facts.maturity;
    if (!model || !model.snapshot || maturity == null) return model;
    const soon = new Set();
    for (const a of model.animals.values()) {
        if (a.species === species && a.juv && !a.exhibit && typeof a.age === 'number' && a.age >= maturity - years) soon.add(a.id);
    }
    if (!soon.size) return model;
    const animals = model.snapshot.animals.map(a => {
        if (!soon.has(String(a.id))) return a;
        const fert = a.fert && a.fert.state === 'young' ? Object.assign({}, a.fert, { state: '' }) : a.fert;
        return Object.assign({}, a, { juv: false, age: Math.max(a.age, maturity), ageQ: 2, fert });
    });
    const opts = Object.assign({}, model.opts || { closeKinship: model.closeKinship }, { ped: model.ped || null });
    return buildKinModel(Object.assign({}, model.snapshot, { animals, normalized: true }), opts);
}

function addMove(prep, a, to, reason, stage) {
    const { out, locked, taken, view } = prep;
    if (!a || !canMove(a) || isPinned(a) || locked.has(a.id) || taken.has(a.id)) return false;
    if (String(to) === homeOf(a)) return false;
    if (view.blocked.has(`${a.id}>${to}`)) {
        out.held.push({ id: a.id, why: 'the game refused this move recently' });
        return false;
    }
    if (to === TRADE) {
        if (prep.tradeLeft <= 0) {
            out.held.push({ id: a.id, why: 'the trade centre is full' });
            return false;
        }
        prep.tradeLeft--;
    }
    const back = view.recentFrom.get(a.id);
    out.moves.push({ id: a.id, to: String(to), reason, stage, reversal: !!(back && back.has(String(to))) });
    taken.add(a.id);
    return true;
}

// The programme's moves (made on prep.model) added to the run.
export function finishAutoRun(input, prep, programme) {
    const { out } = prep;
    out.programme = programme || null;
    const model = input.model;
    // (young about to grow up count as breeders here: one with no place in
    // a group goes to the trade centre rather than grow up next to a parent;
    // the soak's inbred births went from 0 to 5 % when they stayed)
    for (const m of (programme && programme.moves) || []) addMove(prep, model && model.animals.get(String(m.id)), m.to, m.reason || 'breeding programme', 'programme');
    keepLastBreeders(input, out);
    if (out.held.some(x => x.why === 'the trade centre is full')) out.notes.push('The trade centre is full: some animals stay until there is room (sell or release the ones waiting there).');
    const idle = programme && programme.after ? programme.after.idle || 0 : 0;
    if (idle) out.notes.push(`${idle} breeder${idle === 1 ? ' has' : 's have'} no unrelated partner in the zoo: new animals from the market would let ${idle === 1 ? 'it' : 'them'} breed.`);
    return out;
}

// The programme sends breeders with no place in a group to the trade
// centre. In a species where everyone is related that would empty it, so
// Auto mode never sends away the last breeding male or female left in the
// habitats (the run's later trade moves are dropped first).
function keepLastBreeders(input, out) {
    const { model, species } = input;
    if (!model) return;
    const facts = (model.speciesFacts && model.speciesFacts[species]) || {};
    const ages = (input.info && input.info.fertilityAges) || { maturity: facts.maturity, infertility: facts.infertility };
    const info = { fertilityAges: ages };
    const left = { [Sex.Male]: 0, [Sex.Female]: 0 };
    const goes = new Set(out.moves.filter(m => m.to === TRADE).map(m => m.id));
    const comes = new Set(out.moves.filter(m => m.to !== TRADE).map(m => m.id));
    for (const a of model.animals.values()) {
        if (a.species !== species || a.exhibit || !(a.sex in left) || !isBreeder(a, info)) continue;
        const inHab = a.hab ? !goes.has(a.id) : comes.has(a.id);
        if (inHab) left[a.sex]++;
    }
    for (let i = out.moves.length - 1; i >= 0; i--) {
        const m = out.moves[i];
        if (m.to !== TRADE) continue;
        const a = model.animals.get(m.id);
        if (!a || !a.hab || !(a.sex in left) || !isBreeder(a, info) || left[a.sex] > 0) continue;
        out.moves.splice(i, 1);
        left[a.sex]++;
        out.held.push({ id: a.id, why: 'the last breeder of its sex stays' });
    }
}

export function planAutoRun(input) {
    const prep = prepareAutoRun(input);
    if (!input.model || !input.species) return prep.out;
    const r = planProgramme(prep.model, input.species, input.info || {}, input.destinations || null, {
        assignments: input.assignments || null,
        options: programmeOptionsFor(prep.settings, input.ratio || 'auto', prep.pins),
    });
    return finishAutoRun(input, prep, r);
}

// --------------------------------------------------------------- watching

// Per species: what a plan depends on, as one string. A ready plan is made
// again when this changes.
export function speciesFingerprints(model) {
    const out = new Map();
    if (!model) return out;
    const parts = new Map();
    for (const a of model.animals.values()) {
        if (!a.species || a.exhibit) continue;
        if (!parts.has(a.species)) parts.set(a.species, []);
        const f = a.fert ? a.fert.state : '';
        parts.get(a.species).push([a.guid || a.id, a.hab, a.lt, a.moving ? 1 : 0, a.juv ? 1 : 0, a.contra ? 1 : 0, a.infertile ? 1 : 0, a.preg ? 1 : 0, f, a.bond ? a.bond.mate : '', a.alive === false ? 0 : 1].join(':'));
    }
    for (const [sp, list] of parts) out.set(sp, list.sort().join('|'));
    return out;
}

// What changed that Auto mode did not do: the player (or the game) moved an
// animal. seen: { id: { hab } } (this load); expected: Map(id -> { to })
// for Auto mode's own moves. -> { seen, moved: [id] }
export function observeChanges(seen, model, expected) {
    const next = {};
    const moved = [];
    const exp = expected instanceof Map ? expected : new Map();
    for (const a of model ? model.animals.values() : []) {
        if (a.exhibit) continue;
        const stable = !a.moving && (a.lt === 'habitat' || a.lt === 'trade');
        const here = homeOf(a);
        const was = seen && seen[a.id];
        if (!was) {
            next[a.id] = { hab: stable ? here : '' };
            continue;
        }
        const e = exp.get(a.id);
        const rec = { hab: was.hab };
        if (stable) {
            if (was.hab && here !== was.hab && !(e && e.to != null && String(e.to) === here)) moved.push(a.id);
            rec.hab = here;
        }
        next[a.id] = rec;
    }
    return { seen: next, moved };
}

// ------------------------------------------------------------------ texts

export function sexMark(a) {
    return a && a.sex === Sex.Male ? '♂' : a && a.sex === Sex.Female ? '♀' : '';
}

export function actionText(model, x, destinations) {
    const a = model && model.animals.get(String(x.id));
    if (!a) return String(x.id);
    return moveText(model, x, destinations);
}

// The park's calendar as one number: months since the start of year 0
// (Year*12 + Month-1 + the part of the month gone). gate: PZ2QoL_AutoGate's
// answer. null when the game gave no date.
export function calendarMonths(gate) {
    if (!gate || typeof gate.year !== 'number' || typeof gate.month !== 'number') return null;
    const p = typeof gate.monthProp === 'number' ? Math.max(0, Math.min(1, gate.monthProp)) : 0;
    return gate.year * 12 + (gate.month - 1) + p;
}

// "1 month", "1 season", "2 seasons", "1 year"
export function everyWords(months) {
    if (months === 12) return '1 year';
    if (months % 3 === 0) return months === 3 ? '1 season' : `${months / 3} seasons`;
    return months === 1 ? '1 month' : `${months} months`;
}

export function everyText(months) {
    return months === 12 ? 'every year' : months === 3 ? 'every season' : `every ${everyWords(months)}`;
}

// Game time left, in months: "in 2 months", "in half a month", "now".
export function dueText(months) {
    if (!(months > 0.02)) return 'now';
    if (months < 0.75) return 'in under a month';
    const m = Math.round(months * 2) / 2;
    return `in ${m === 1 ? '1 month' : `${m} months`}`;
}

// The same in real time at the speed the game runs now ("about 4 min"), or
// '' while it is paused or not measured yet. rate: months per real ms.
export function realTimeText(months, rate) {
    if (!(months > 0) || !(rate > 0)) return '';
    const s = months / rate / 1000;
    if (s < 60) return 'under a minute';
    const m = Math.round(s / 60);
    return m < 90 ? `about ${m} min` : `about ${Math.round(m / 60 * 10) / 10} h`;
}
