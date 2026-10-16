// Species board: pick a species, see its animals habitat by habitat, spot
// the problems, and plan moves right there.
//
//   header   title, Kin planner, Rescan, Close
//   left     every species, problems first
//   middle   the species' habitats as columns of animal cards (plus the
//            trade centre and "Elsewhere"); drag cards between columns, or
//            select them and press "Move N here", to stage moves in a plan
//   bottom   the plan: its moves, what it fixes and creates (simulated on
//            the kin model), Suggest fixes, Clear, Execute
//
// Nothing moves until the player runs the plan (one move at a time, each
// confirmed by the game, kinmoves.js) or presses "Move now" on one animal.
// Gameface: own DOM under <body>, explicit display:flex, no CSS grid, no
// native scrolling (kinpanel.js), pointer drag with mouse events (no HTML5
// drag and drop).
import { Sex, relationWord, severityRank, fertilityTag } from '/js/mods/pz2qol/kincore.js';
import {
    TRADE, boardColumns, canMove, moveText, planImpact, planProblems, prunePlan, setMove, simulatePlan, speciesList, suggestPlan,
} from '/js/mods/pz2qol/kinboardcore.js';
import { countWord, visibleCounts } from '/js/mods/pz2qol/kinplannercore.js';
import {
    getKinModel, getKinSettings, getKinState, markKinActive, onKin, onKinSettings, requestKinScan, setKinSettings,
} from '/js/mods/pz2qol/kin.js';
import {
    cachedDestinations, getPlanRun, moveAnimal, onPlanRun, planBlockedReason, requestDestinations, requestSpeciesInfo, runPlan, stopPlan,
} from '/js/mods/pz2qol/kinmoves.js';
import { PROGRAMME_DEFAULTS, conceptionChance, planProgramme, youngQuality } from '/js/mods/pz2qol/kinprogramme.js';
import { FILL_STEPS, cullPlan, geneScore } from '/js/mods/pz2qol/kincull.js';
import { hideKinCard, kinBadge, sexClass, sexSymbol } from '/js/mods/pz2qol/kinui.js';
import { clear, h, icon, setClass, setText } from '/js/mods/pz2qol/ui.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { getAssignments, onAssignments, toggleAssignment, assignmentStorage } from '/js/mods/pz2qol/kinassign.js';
import {
    btn as kitBtn, closeButton, closeOtherPanels, countPills, makeGuard, makeScroll, panelApi, placePanel, refreshBars, registerPanel,
    remPx, restoreScroll, scrollBoxTo, speciesName, switchEl as kitSwitch, trunc, wheelScroll,
} from '/js/mods/pz2qol/kinpanel.js';

const TICK_MS = 2000;
const NOTICE_MS = 9000;
const DRAG_START_PX = 6;

const guard = makeGuard('Species board');
const btn = (...args) => kitBtn(guard, ...args);
const switchEl = (...args) => kitSwitch(guard, ...args);

const LT_WORDS = { transit: 'in transit', quarantine: 'quarantine', vet: 'at the vet', escaped: 'escaped', other: 'elsewhere', trade: 'trade centre' };

// --------------------------------------------------------------- state

const S = {
    root: null,
    el: {},
    open: false,
    species: null,
    plan: [],                 // [{ id, to }]
    reasons: new Map(),       // id -> why Suggest fixes moved it
    selected: new Set(),
    dest: null,
    destLoading: false,
    notice: null,             // { text, tone, until }
    boxes: {},
    scroll: { rail: 0, board: 0, list: 0, impact: 0, cols: {} },
    columns: [],
    colEls: new Map(),        // column id -> { el, col, rel, drop }
    cards: new Map(),         // animal id -> card element (where it is after the plan)
    menu: null,
    menuFor: null,
    drag: null,
    suppressClick: false,
    hoverId: null,
    deferred: false,
    queued: false,
    planTab: 'plan',
    sent: new Set(),          // ids we sent a move for (their leaving the plan is expected)
    pendingMove: new Map(),   // id -> to (a "Move now" in flight)
    lastModel: undefined,
    modelTime: 0,
    model: null,
    after: null,
    unsub: [],
    timer: 0,
    prog: null,               // the breeding programme preview: { species, state, step, info, results, ... }
};

// "Fewer moves <-> Best genetics": the optimiser's cost per moved animal.
const PROG_STEPS = [
    { label: 'Fewest moves', cost: 0.15 },
    { label: 'Fewer moves', cost: 0.08 },
    { label: 'Balanced', cost: 0.04 },
    { label: 'Best genetics', cost: 0.02 },
];
const PROG_DEFAULT_STEP = 2;

// Thin out: the last known "over the room" count per species (for the rail)
const overBySpecies = new Map();
const CULL_MARKS = {
    'breeding core': { cls: 'core', text: 'core', title: 'The breeding core of this habitat: kept' },
    pregnant: { cls: 'preg', text: 'pregnant', title: 'Pregnant: never sent away' },
    'best genes of the species': { cls: 'best', text: 'best', title: 'The best genes of the species: kept' },
    'your choice': { cls: 'mine', text: 'your choice', title: 'You chose this' },
    'on the move': { cls: 'moving', text: 'on the move', title: 'Already on the move' },
};
const SYSTEM_WORDS = {
    polygyny: 'Harem: one breeding male per habitat',
    polyandry: 'One breeding female per habitat',
    monogamy: 'Pairs: one partner each',
    mixed: 'Mixed groups',
};

function notice(text, tone = 'info') {
    S.notice = { text, tone, until: Date.now() + NOTICE_MS };
    renderNotice();
}

function destFor(model) {
    const d = S.dest;
    const tc = (d && d.tradeCentre) || (model && model.tradeCentre) || null;
    if (!d) return tc ? { bySpecies: {}, habitats: [], tradeCentre: tc } : null;
    return d.tradeCentre || !tc ? d : Object.assign({}, d, { tradeCentre: tc });
}

function destKnown() {
    return !!(S.dest && S.dest.bySpecies && S.species && S.dest.bySpecies[S.species]);
}

function homeOf(a) {
    return a.hab || (a.lt === 'trade' ? TRADE : 'away');
}

function placeName(model, to) {
    if (to === TRADE) {
        const d = destFor(model);
        return (d && d.tradeCentre && d.tradeCentre.name) || 'Trade centre';
    }
    if (to === 'away') return 'Elsewhere';
    const hb = model && model.habitats.get(String(to));
    if (hb && hb.name) return hb.name;
    const d = S.dest && (S.dest.habitats || []).find(x => String(x.id) === String(to));
    return d ? d.name : String(to);
}

// --------------------------------------------------------------- skeleton

function ensureRoot() {
    if (S.root && S.root.parentNode) return S.root;
    const el = S.el;
    el.sub = h('div.PZ2QoL_kbSub');
    const head = h('div.PZ2QoL_kpHead', null,
        h('div.PZ2QoL_kpLogo.board'),
        h('div.PZ2QoL_kpTitles', null,
            h('div.PZ2QoL_kpTitle', { text: 'Species board' }),
            el.sub),
        h('div.PZ2QoL_kpFlex'),
        btn('Kin planner', 'IconGenetics', openPlanner, { title: 'The relatedness matrix and mate finder' }),
        btn('Rescan', 'Icon_CircleWithArrows', () => {
            requestKinScan('board', { force: true });
            loadDestinations(true);
            notice('Reading the animals and the habitats again…');
        }, { title: 'Read the animals and the habitat checks again now' }),
        closeButton(guard, 'Close (Esc)', () => closeSpeciesBoard()));
    el.rail = h('div.PZ2QoL_kbRail');
    el.board = h('div.PZ2QoL_kbBoard');
    el.plan = h('div.PZ2QoL_kbPlan');
    el.legend = h('div.PZ2QoL_kpLegend');
    el.status = h('div.PZ2QoL_kpStatus');
    const root = h('div.PZ2QoL_kb.hidden', null,
        head,
        h('div.PZ2QoL_kbBody', null, el.rail, el.board),
        el.plan,
        h('div.PZ2QoL_kpFoot', null, el.legend, h('div.PZ2QoL_kpFlex'), el.status));
    root.addEventListener('mousedown', e => {
        e.stopPropagation();
        try {
            if (S.menu && !S.menu.contains(e.target)) closeMenu();
        }
        catch (err) {
            reportError('ui', 'Species board: menu failed', err, { silent: true });
        }
    });
    root.addEventListener('click', e => e.stopPropagation());
    root.addEventListener('dragstart', e => e.preventDefault());
    root.addEventListener('wheel', e => {
        e.preventDefault();
        e.stopPropagation();
    });
    document.body.appendChild(root);
    S.root = root;
    buildLegend();
    return root;
}

function buildLegend() {
    const l = S.el.legend;
    clear(l);
    const item = (cls, label) => h('div.PZ2QoL_kpLegendItem', null, h(`div.PZ2QoL_kbSwatch.${cls}`), h('span', { text: label }));
    l.appendChild(item('sev_risk', 'Inbreeding risk'));
    l.appendChild(item('sev_kin', 'Close kin'));
    l.appendChild(item('sev_future', 'Future risk'));
    l.appendChild(item('sev_covered', 'Covered'));
    l.appendChild(item('planned', 'Planned move'));
    l.appendChild(item('ghost', 'Leaving'));
    l.appendChild(h('div.PZ2QoL_kpLegendItem.hint', { text: 'Drag cards between habitats · Shift+click selects several · Shift+wheel scrolls sideways' }));
}

// ---------------------------------------------------------------- render

function queueRender() {
    if (!S.open) return;
    if (S.drag || S.menu) {
        S.deferred = true;
        return;
    }
    if (S.queued) return;
    S.queued = true;
    setTimeout(() => {
        S.queued = false;
        renderAll();
    }, 0);
}

function onModel(model) {
    if (model === S.lastModel) return;
    S.lastModel = model;
    if (!model) return;
    S.modelTime = Date.now();
    // keep the plan, without the moves that cannot happen any more
    const kept = prunePlan(model, S.plan);
    const dropped = S.plan.filter(m => !kept.includes(m));
    S.plan = kept;
    const said = [];
    for (const m of dropped) {
        S.reasons.delete(m.id);
        if (S.sent.has(m.id)) continue;          // we moved it: expected
        const a = model.animals.get(String(m.id));
        if (!a) said.push(`${m.id} (no longer in the zoo)`);
        else if (a.moving) said.push(`${a.name} ${sexSymbol(a.sex)} (already on the move)`);
        else if (homeOf(a) === String(m.to)) said.push(`${a.name} ${sexSymbol(a.sex)} (already there)`);
        else said.push(`${a.name} ${sexSymbol(a.sex)} (cannot move now)`);
    }
    if (said.length) notice(`Removed from the plan: ${said.join(', ')}.`, 'warn');
    for (const id of Array.from(S.selected)) {
        const a = model.animals.get(id);
        if (!a || !canMove(a) || a.species !== S.species) S.selected.delete(id);
    }
}

function renderAll() {
    if (!S.root || !S.open) return;
    try {
        S.deferred = false;
        const model = getKinModel();
        onModel(model);
        S.model = model;
        if (model) {
            const list = speciesList(model);
            if (!S.species || !list.some(s => s.species === S.species)) {
                S.species = list.length ? list[0].species : null;
                S.selected.clear();
                if (S.species) loadDestinations(false);
            }
        }
        const dest = destFor(model);
        S.after = model ? simulatePlan(model, S.plan, dest) : null;
        S.boxes = {};
        renderHead(model);
        renderRail(model);
        renderBoard(model, dest);
        fitColumns();
        fitProgramme();
        fitCull();
        renderPlan(model, dest);
        renderFoot();
        if (S.hoverId) highlightRelatives(S.hoverId);
        setTimeout(() => refreshBars(S.boxes), 0);
    }
    catch (e) {
        reportError('ui', 'Species board could not draw', e);
    }
}

function renderHead(model) {
    const el = S.el.sub;
    clear(el);
    if (!model) {
        el.appendChild(h('span', { text: getKinSettings().enabled ? 'Waiting for animal data' : 'Kin is turned off' }));
        return;
    }
    el.appendChild(h('span', { text: 'Drag animals between habitats to plan moves. Nothing moves until you run the plan or press Move now.' }));
}

// ------------------------------------------------------------------ rail

function assignedCount(model, species) {
    let n = 0;
    for (const set of getAssignments(model).values()) if (set.has(species)) n++;
    return n;
}

// The column's assignment: whose habitat it is, one click to change it.
function assignEl(model, c) {
    if (c.kind !== 'habitat') return null;
    const sp = speciesName(S.species);
    const others = c.assigned.filter(x => x !== S.species).map(speciesName);
    const toggle = () => {
        toggleAssignment(model, c.id, S.species, c.name);
        // once per session: the game gives mods no place to keep data (its file calls are stubs)
        if (assignmentStorage() === 'memory' && !S.memoryNoted) {
            S.memoryNoted = true;
            notice('Habitat assignments last until you close the game. Planet Zoo 2 gives mods no place to keep them yet.', 'info');
        }
        renderAll();
    };
    const kids = [];
    if (c.mine) {
        kids.push(h('div.PZ2QoL_kbAssign.mine', {
            title: `Assigned to ${sp}${others.length ? ' (and ' + others.join(', ') + ')' : ''}: Suggest fixes moves ${sp} only into its assigned habitats and puts no other species here. Click to remove.`,
            onClick: guard('Assign', toggle),
        }, h('span', { text: `★ ${trunc(sp, 16)} habitat` })));
    }
    else if (c.reservedOther) {
        kids.push(h('div.PZ2QoL_kbAssign.other', {
            title: `Assigned to ${others.join(', ')}. Click to allow ${sp} here too.`,
            onClick: guard('Assign', toggle),
        }, h('span', { text: `Assigned to ${trunc(others.join(', '), 18)}` })));
    }
    else {
        kids.push(h('div.PZ2QoL_kbAssign', {
            title: `Set this habitat aside for ${sp}: Suggest fixes will then use only ${sp}'s assigned habitats, and never put other species here`,
            onClick: guard('Assign', toggle),
        }, h('span', { text: `☆ Assign to ${trunc(sp, 16)}` })));
    }
    if (c.mine && c.intruders && c.intruders.length) {
        const list = c.intruders.map(o => `${o.count} ${speciesName(o.species)}`).join(', ');
        kids.push(h('div.PZ2QoL_kbIntruders', { text: `+ ${list}`, title: `Also living here: ${list}` }));
    }
    return h('div.PZ2QoL_kbAssignRow', null, kids);
}

function renderRail(model) {
    const el = S.el.rail;
    clear(el);
    const box = makeScroll('rail', { onScroll: (x, y) => { S.scroll.rail = y; } });
    S.boxes.rail = box;
    el.appendChild(box.wrap);
    if (!model) return;
    if (S.cull) cullResult();          // its "N over" shows in the rail
    const list = speciesList(model);
    const showCovered = getKinSettings().showCovered;
    box.content.appendChild(h('div.PZ2QoL_kpSideHead', { text: `Species (${list.length})` }));
    if (!list.length) box.content.appendChild(h('div.PZ2QoL_kbRailEmpty', { text: 'No animals in the zoo yet.' }));
    for (const s of list) {
        const on = s.species === S.species;
        const counts = visibleCounts(s.counts, showCovered);
        const pills = countPills(counts, { compact: true });
        const worst = counts.risk ? 'risk' : counts.kin ? 'kin' : counts.future ? 'future' : counts.covered ? 'covered' : 'none';
        const meta = [`${s.males}♂ ${s.females}♀`];
        if (s.juveniles) meta.push(`${s.juveniles} young`);
        meta.push(`${s.habitats.length} habitat${s.habitats.length === 1 ? '' : 's'}`);
        if (s.away) meta.push(`${s.away} away`);
        const own = assignedCount(model, s.species);
        if (own) meta.push(`★ ${own} assigned`);
        const over = overBySpecies.get(s.species);
        if (over) meta.push(`${over} over`);
        box.content.appendChild(h(`div.PZ2QoL_kbSpecies.sev_${worst}${on ? '.on' : ''}`, {
            'data-species': s.species,
            title: speciesName(s.species),
            onClick: guard('Species', () => focusSpecies(s.species)),
        },
        h('div.PZ2QoL_kpHabTop', null,
            h('div.PZ2QoL_kpHabName', { text: trunc(speciesName(s.species), 20) }),
            h('div.PZ2QoL_kpHabCount', { text: String(s.animals), title: `${s.animals} animals` })),
        h('div.PZ2QoL_kbSpeciesMeta', { text: meta.join(' · ') }),
        h('div.PZ2QoL_kbSpeciesPills', null, pills.length ? pills : h('div.PZ2QoL_kpHabOk', { text: 'No related pairs' }))));
    }
    restoreScroll(box, 0, S.scroll.rail);
}

// ----------------------------------------------------------------- board

function renderBoard(model, dest) {
    const el = S.el.board;
    clear(el);
    S.colEls = new Map();
    S.cards = new Map();
    if (!model) {
        el.appendChild(waitingState());
        return;
    }
    if (!S.species) {
        el.appendChild(h('div.PZ2QoL_kpEmpty', null,
            h('div.PZ2QoL_kpEmptyTitle', { text: 'No animals yet' }),
            h('div.PZ2QoL_kpEmptyText', { text: 'Once your zoo has animals in habitats, pick a species on the left to see them here.' })));
        return;
    }
    const assignments = getAssignments(model);
    const base = boardColumns(model, S.species, [], dest, { assignments });
    const cols = boardColumns(model, S.species, S.plan, dest, { assignments });
    // a stable order: the order before the plan (a drop must not reshuffle the board)
    const order = new Map(base.map((c, i) => [c.id, i]));
    cols.sort((x, y) => (order.has(x.id) ? order.get(x.id) : 999) - (order.has(y.id) ? order.get(y.id) : 999));
    S.columns = cols;
    const animals = Array.from(model.animals.values()).filter(a => a.species === S.species && !a.exhibit);
    const habs = new Set(animals.filter(a => a.hab).map(a => a.hab));
    const away = animals.filter(a => !a.hab && a.lt !== 'trade').length;
    const now = speciesList(model).find(s => s.species === S.species);
    const run = getPlanRun();
    // header line
    const right = [];
    if (S.selected.size) {
        right.push(h('div.PZ2QoL_kbSel', null,
            h('span', { text: `${S.selected.size} selected` }),
            h('div.PZ2QoL_kbLink', { onClick: guard('Clear selection', () => { S.selected.clear(); renderAll(); }) }, h('span', { text: 'Clear' }))));
    }
    if (run.running) right.push(h('div.PZ2QoL_kbLock', { text: 'A plan is running: the board is locked' }));
    else if (S.destLoading && !destKnown()) right.push(h('div.PZ2QoL_kbDestState', { text: 'Asking the game which habitats suit them…' }));
    else if (!destKnown()) right.push(h('div.PZ2QoL_kbDestState.unknown', { text: 'Habitats not checked yet: any habitat accepts a planned move' }));
    el.appendChild(h('div.PZ2QoL_kpMainHead.kb', null,
        h('div.PZ2QoL_kpMainTitles', null,
            h('div.PZ2QoL_kpMainTitle', { text: trunc(speciesName(S.species), 30) }),
            h('div.PZ2QoL_kpMainSub', { text: `${animals.length} animal${animals.length === 1 ? '' : 's'} · ${habs.size} habitat${habs.size === 1 ? '' : 's'}${away ? ` · ${away} elsewhere` : ''}` })),
        h('div.PZ2QoL_kbHeadPills', null, now ? countPills(visibleCounts(now.counts, getKinSettings().showCovered)) : null),
        h('div.PZ2QoL_kpFlex'),
        right));
    // no other suitable habitat: say so
    if (destKnown()) {
        const ok = Object.entries(S.dest.bySpecies[S.species]).filter(([, d]) => d.ok).map(([id]) => id);
        if (ok.length <= 1 && habs.size <= 1) {
            el.appendChild(h('div.PZ2QoL_kbHint.warn', { text: `No other habitat suits ${speciesName(S.species)} right now. Build or extend one, or use the trade centre to make room.` }));
        }
    }
    if (S.prog && S.prog.species === S.species) {
        el.appendChild(programmeEl(model));
        return;
    }
    if (S.cull && S.cull.species === S.species) {
        el.appendChild(cullEl(model));
        return;
    }
    const box = makeScroll('kbCols', {
        x: true,
        y: false,
        onScroll: (x) => { S.scroll.board = x; },
    });
    S.boxes.board = box;
    const row = h('div.PZ2QoL_kbColRow');
    for (const c of cols) row.appendChild(columnEl(model, c));
    box.content.appendChild(row);
    el.appendChild(box.wrap);
    restoreScroll(box, S.scroll.board, 0);
}

// Columns as tall as the board strip, cards scrolling inside. Sized in
// pixels after layout rather than left to flex shrinking: with many animals
// in one habitat the column grew to fit every card, its own scroll area had
// nothing to scroll, and the strip cut the rest off (seen in game).
function fitColumns() {
    const board = S.boxes.board;
    if (!board) return;
    const vpH = Math.floor(board.vp.getBoundingClientRect().height);
    if (!(vpH > 0)) return;
    const pad = Math.ceil(remPx() * 0.75);
    const colH = Math.max(remPx() * 8, vpH - pad);
    board.content.style.height = `${vpH}px`;
    for (const { el } of S.colEls.values()) {
        if (!el || !el.parentNode) continue;
        el.style.height = `${colH}px`;
        const head = el.querySelector('.PZ2QoL_kbColHead');
        const body = el.querySelector('.PZ2QoL_kpScroll.kbColBody');
        if (!head || !body) continue;
        const inner = el.getBoundingClientRect().height - (el.offsetHeight - el.clientHeight);
        const bodyH = Math.max(remPx() * 3, Math.floor((inner || colH) - head.getBoundingClientRect().height));
        body.style.flex = '0 0 auto';
        body.style.height = `${bodyH}px`;
    }
}

function waitingState() {
    const off = !getKinSettings().enabled;
    const st = getKinState();
    return h('div.PZ2QoL_kpEmpty', null,
        h(`div.PZ2QoL_kpEmptyIcon.${off ? 'off' : 'wait'}`),
        h('div.PZ2QoL_kpEmptyTitle', { text: off ? 'Kin is off' : 'Waiting for animal data' }),
        h('div.PZ2QoL_kpEmptyText', {
            text: off ? 'Kin is turned off, so the board has nothing to show.'
                : st.state === 'nopark' ? 'No park is loaded. Open a zoo and the board fills in by itself.'
                    : 'Kin reads your zoo\'s animals and their parents. This takes a moment after a park loads.',
        }),
        h('div.PZ2QoL_kpEmptyActions', null,
            off ? btn('Turn Kin on', 'IconGenetics', () => setKinSettings({ enabled: true }), { cls: 'primary', tint: 'white' })
                : btn('Rescan', 'Icon_CircleWithArrows', () => requestKinScan('board', { force: true }), { cls: 'primary', tint: 'white' })));
}

// Can these animals be planned into this column? { ok, reason, unknown, noop }
function dropCheck(model, c, ids) {
    if (!c) return { ok: false, reason: '' };
    if (c.kind === 'away') return { ok: false, reason: 'Animals on their way, in quarantine or at the vet are listed here; nothing can be sent here.' };
    if (c.kind === 'habitat' && c.dest && c.dest.ok === false) return { ok: false, reason: `${c.name}: ${c.dest.reason || 'not suitable for this species'}` };
    const movable = ids.map(id => model.animals.get(String(id))).filter(a => a && canMove(a));
    if (!movable.length) return { ok: false, reason: 'These animals cannot move right now.' };
    const planned = new Map(S.plan.map(m => [m.id, m.to]));
    const noop = movable.every(a => (planned.get(a.id) || homeOf(a)) === c.id);
    return { ok: true, reason: '', unknown: c.kind === 'habitat' && !c.dest, noop };
}

function columnEl(model, c) {
    const empty = !c.animals.length;
    const unsuitable = c.kind === 'habitat' && c.dest && c.dest.ok === false;
    const unknown = c.kind === 'habitat' && !c.dest;
    const worst = c.risk.risk ? 'risk' : c.risk.kin ? 'kin' : c.risk.future ? 'future' : 'none';
    const cls = [`kind_${c.kind}`, `sev_${worst}`];
    if (empty) cls.push('empty');
    if (unsuitable) cls.push('unsuitable');
    if (unknown) cls.push('unknown');
    const node = h(`div.PZ2QoL_kbCol.${cls.join('.')}`, { 'data-col': c.id, 'data-kind': c.kind });
    // head
    const counts = [];
    if (c.counts.males) counts.push(`${c.counts.males}♂`);
    if (c.counts.females) counts.push(`${c.counts.females}♀`);
    if (c.counts.juveniles) counts.push(`${c.counts.juveniles} young`);
    const iconName = c.kind === 'trade' ? 'IconTradeCentre' : c.kind === 'away' ? 'IconTransport' : 'IconHabitat';
    const rel = h('div.PZ2QoL_kbColRel');
    const drop = h('div.PZ2QoL_kbColDrop');
    let status;
    const ids = Array.from(S.selected);
    const sel = ids.length ? dropCheck(model, c, ids) : null;
    if (sel && sel.ok && !sel.noop && !getPlanRun().running) {
        status = h('div.PZ2QoL_kbMoveHere', {
            title: sel.unknown ? 'Not checked by the game yet' : `Plan moving the selected animals to ${c.name}`,
            onClick: guard('Move here', () => applyMoves(Array.from(S.selected), c.id)),
        }, h('div.PZ2QoL_kbArrow'), h('span', { text: `Move ${ids.length} here` }));
    }
    else if (unsuitable) status = h('div.PZ2QoL_kbColStatus.bad', { text: `Not suitable: ${c.dest.reason || 'the game says no'}`, title: c.dest.reason || '' });
    else if (c.kind === 'away') status = h('div.PZ2QoL_kbColStatus', { text: 'On the move, quarantine, vet: cannot move' });
    else if (c.kind === 'trade') status = h('div.PZ2QoL_kbColStatus', { text: 'Holding area for trading or release' });
    else if (unknown) status = h('div.PZ2QoL_kbColStatus.faint', { text: S.destLoading ? 'Checking…' : 'Not checked yet' });
    else if (empty) status = h('div.PZ2QoL_kbColStatus.ok', { text: 'Empty · suitable' });
    else status = h('div.PZ2QoL_kbColStatus.ok', { text: 'Suitable' });
    const other = c.other.slice(0, 2).map(o => h('div.PZ2QoL_kbOther', { text: `${trunc(speciesName(o.species), 10)} ${o.count}`, title: `${o.count} ${speciesName(o.species)} share this habitat` }));
    if (c.other.length > 2) other.push(h('div.PZ2QoL_kbOther', { text: `+${c.other.length - 2}`, title: c.other.slice(2).map(o => speciesName(o.species)).join(', ') }));
    const riskPills = countPills(visibleCounts(c.risk, getKinSettings().showCovered), { compact: true });
    const head = h('div.PZ2QoL_kbColHead', null,
        h('div.PZ2QoL_kbColTop', null,
            icon(iconName, 'brown', 'sm'),
            h('div.PZ2QoL_kbColName', { text: trunc(c.name, 22), title: c.name }),
            h('div.PZ2QoL_kpFlex'),
            h('div.PZ2QoL_kpHabCount', { text: String(c.animals.length) })),
        h('div.PZ2QoL_kbColMeta', null,
            h('div.PZ2QoL_kbColCounts', { text: counts.join(' · ') || (empty ? 'no animals' : '') }),
            h('div.PZ2QoL_kpFlex'),
            other),
        h('div.PZ2QoL_kbColPills', null, riskPills.length ? riskPills
            : h('div.PZ2QoL_kbColAlone', { text: c.kind !== 'habitat' || empty ? '' : 'No related pairs' })),
        status,
        assignEl(model, c),
        rel,
        drop);
    head.addEventListener('wheel', e => {
        e.preventDefault();
        e.stopPropagation();
        if (S.boxes.board) wheelScroll(S.boxes.board, e, true);
    });
    node.appendChild(head);
    // body: the cards
    const body = makeScroll('kbColBody', {
        onScroll: (x, y) => { S.scroll.cols[c.id] = y; },
        onWheel: (box, e) => {
            // sideways with Shift, or when this column does not scroll
            if (!S.boxes.board) return false;
            if (e.shiftKey || box.vp.scrollHeight <= box.vp.getBoundingClientRect().height + 1) {
                wheelScroll(S.boxes.board, e, true);
                return true;
            }
            return false;
        },
    });
    S.boxes['col_' + c.id] = body;
    for (const x of c.animals) body.content.appendChild(cardEl(model, c, x));
    if (c.leaving.length) {
        body.content.appendChild(h('div.PZ2QoL_kbLeavingHead', { text: `Leaving (${c.leaving.length})` }));
        for (const l of c.leaving) body.content.appendChild(ghostEl(model, l));
    }
    if (!c.animals.length && !c.leaving.length) {
        body.content.appendChild(h(`div.PZ2QoL_kbDropHint${unsuitable || c.kind === 'away' ? '.no' : ''}`, {
            text: unsuitable ? 'Not suitable for this species' : c.kind === 'away' ? 'Nobody away' : 'Drop animals here',
        }));
    }
    node.appendChild(body.wrap);
    restoreScroll(body, 0, S.scroll.cols[c.id] || 0);
    S.colEls.set(c.id, { el: node, col: c, rel, drop });
    return node;
}

function tagsFor(a, x, model) {
    const out = [];
    if (a.moving) out.push(h('span.PZ2QoL_kbTag.moving', { text: 'on the move' }));
    else if (!a.hab && a.lt && a.lt !== 'trade' && a.lt !== 'habitat') out.push(h('span.PZ2QoL_kbTag.away', { text: LT_WORDS[a.lt] || a.lt }));
    if (x && x.planned) {
        const before = model.animals.get(a.id);
        out.push(h('span.PZ2QoL_kbTag.from', { text: `from ${trunc(placeName(model, before ? homeOf(before) : ''), 16)}` }));
    }
    const ft = fertilityTag(a);
    if (ft) out.push(h(`span.PZ2QoL_kbTag.${ft.cls}`, { text: ft.text, title: ft.title }));
    if (a.contra) out.push(h('span.PZ2QoL_kbTag.contra', { text: 'contra' }));
    if (a.preg) out.push(h('span.PZ2QoL_kbTag.preg', { text: 'pregnant' }));
    if (S.pendingMove.has(a.id)) out.push(h('span.PZ2QoL_kbTag.moving', { text: 'moving…' }));
    return out;
}

// The animal's worst counted severity now (before the plan).
function baseSeverity(model, id) {
    const list = (model.byAnimal.get(String(id)) || []).filter(p => p.severity !== 'distant');
    return list.length ? list[0].severity : null;
}

function cardEl(model, c, x) {
    const a = x.a;
    const movable = canMove(model.animals.get(a.id)) && !S.pendingMove.has(a.id);
    const sev = x.severity || 'none';
    const cls = [sexClass(a.sex), `sev_${sev}`];
    if (a.juv) cls.push('juv');
    if (x.planned) cls.push('planned');
    if (!movable) cls.push('locked');
    if (a.moving) cls.push('moving');
    if (S.selected.has(a.id)) cls.push('selected');
    // what the plan does to this animal
    let change = null;
    if (S.plan.length) {
        const was = baseSeverity(model, a.id);
        const now = x.severity && x.severity !== 'covered' ? x.severity : null;
        const wasC = was && was !== 'covered' ? was : null;
        if (severityRank(now) < severityRank(wasC)) change = h('span.PZ2QoL_kbTag.fixed', { text: 'fixed' });
        else if (severityRank(now) > severityRank(wasC)) change = h('span.PZ2QoL_kbTag.worse', { text: now === 'risk' ? 'new risk' : 'new kin' });
    }
    const mates = (model.animals.get(a.id) || a).mates || [];
    // the worst relative it shares a habitat with (after the plan)
    let kinLine = null;
    const worstPair = x.pairs[0];
    if (worstPair) {
        const wordFor = o => {
            const r = a.guid && o.guid ? model.ped.relation(a.guid, o.guid) : null;
            return r ? relationWord(r, o.sex) : 'relative';
        };
        const partner = worstPair.a.id === a.id ? worstPair.b : worstPair.a;
        kinLine = h(`span.PZ2QoL_kbKinLine.sev_${worstPair.severity}`, {
            text: `${wordFor(partner)} ${trunc(partner.name, 10)}${x.pairs.length > 1 ? ` +${x.pairs.length - 1}` : ''}`,
            title: x.pairs.map(p => {
                const o = p.a.id === a.id ? p.b : p.a;
                return `${wordFor(o)} ${o.name}`;
            }).join(', '),
        });
    }
    const relLabel = h('span.PZ2QoL_kbRelLabel');
    const top = h('div.PZ2QoL_kbCardTop', null,
        h('div.PZ2QoL_kbCardName', { text: `${sexSymbol(a.sex)} ${trunc(a.name, 15)}`, title: a.name }),
        mates.length ? h('div.PZ2QoL_kpMated.inline', { title: 'Has a mate now' }, icon('Icon_Heart', 'white', 'xs')) : null,
        h('div.PZ2QoL_kpFlex'),
        x.severity ? kinBadge(x.severity, x.pairs.length, { compact: true }) : null,
        x.planned
            ? h('div.PZ2QoL_kbCardX', { title: 'Remove this move from the plan', onClick: guard('Remove move', () => removeMove(a.id)) }, h('div.PZ2QoL_kpCloseX.a'), h('div.PZ2QoL_kpCloseX.b'))
            : h('div.PZ2QoL_kbCardMenu', { title: 'Actions', onClick: guard('Menu', e => openMenu(a.id, e.currentTarget || e.target)) }, h('div.PZ2QoL_kbDot'), h('div.PZ2QoL_kbDot'), h('div.PZ2QoL_kbDot')));
    const card = h(`div.PZ2QoL_kbCard.${cls.join('.')}`, { 'data-id': a.id, 'data-sev': sev, 'data-planned': x.planned ? '1' : '0' },
        h('div.PZ2QoL_kbStripe'),
        h('div.PZ2QoL_kbCardMain', null,
            top,
            h('div.PZ2QoL_kbCardTags', null, tagsFor(a, x, model), change, kinLine, h('div.PZ2QoL_kpFlex'), relLabel)));
    card.__id = a.id;
    card.__rel = relLabel;
    card.addEventListener('mouseenter', () => {
        if (S.drag) return;
        S.hoverId = a.id;
        highlightRelatives(a.id);
    });
    card.addEventListener('mouseleave', () => {
        if (S.drag || S.hoverId !== a.id) return;
        S.hoverId = null;
        clearHighlight();
    });
    card.addEventListener('mousedown', e => {
        if (e.button !== 0 || !movable || getPlanRun().running) return;
        for (let n = e.target; n && n !== card; n = n.parentNode) {
            if (n.classList && (n.classList.contains('PZ2QoL_kbCardMenu') || n.classList.contains('PZ2QoL_kbCardX') || n.classList.contains('PZ2QoL_kin'))) return;
        }
        e.preventDefault();          // no text selection, no native drag
        startPointer(e, a.id, card);
    });
    card.addEventListener('click', guard('Select', e => {
        if (S.suppressClick) {
            S.suppressClick = false;
            return;
        }
        if (!movable) {
            notice(a.moving ? `${a.name} is already on the move.` : `${a.name} cannot be moved from here.`, 'warn');
            return;
        }
        if (getPlanRun().running) return;
        const multi = e.shiftKey || e.ctrlKey || e.metaKey;
        if (multi) {
            if (S.selected.has(a.id)) S.selected.delete(a.id);
            else S.selected.add(a.id);
        }
        else if (S.selected.has(a.id) && S.selected.size === 1) S.selected.clear();
        else {
            S.selected.clear();
            S.selected.add(a.id);
        }
        renderAll();
    }));
    S.cards.set(a.id, card);
    return card;
}

function ghostEl(model, l) {
    const a = l.a;
    const node = h(`div.PZ2QoL_kbCard.ghost.${sexClass(a.sex)}`, { 'data-ghost': a.id, title: `${a.name} is planned to move to ${l.toName}` },
        h('div.PZ2QoL_kbStripe'),
        h('div.PZ2QoL_kbCardMain', null,
            h('div.PZ2QoL_kbCardTop', null,
                h('div.PZ2QoL_kbCardName', { text: `${sexSymbol(a.sex)} ${trunc(a.name, 17)}` }),
                h('div.PZ2QoL_kpFlex'),
                h('div.PZ2QoL_kbCardX', { title: 'Keep it here (remove the move)', onClick: guard('Remove move', () => removeMove(a.id)) }, h('div.PZ2QoL_kpCloseX.a'), h('div.PZ2QoL_kpCloseX.b'))),
            h('div.PZ2QoL_kbCardTags', null, h('div.PZ2QoL_kbArrow.small'), h('span.PZ2QoL_kbGoing', { text: trunc(l.toName, 24) }))));
    return node;
}

// ------------------------------------------------------- relatives on hover

function clearHighlight() {
    if (S.root) setClass(S.root, 'hovering', false);
    for (const card of S.cards.values()) {
        setClass(card, 'relHot', false);
        setClass(card, 'dim', false);
        setClass(card, 'focus', false);
        for (const s of ['risk', 'kin', 'future', 'covered', 'distant', 'apart']) setClass(card, 'rel_' + s, false);
        setText(card.__rel, '');
    }
    for (const c of S.colEls.values()) {
        setText(c.rel, '');
        c.rel.className = 'PZ2QoL_kbColRel';
    }
}

// Every relative of `id` on the board lights up with how it is related;
// the rest fades. Column heads count the relatives in them.
function highlightRelatives(id) {
    const model = S.model;
    const after = S.after;
    if (!model || !after) return;
    clearHighlight();
    const self = model.animals.get(String(id));
    if (!self || !self.guid) return;
    const pairs = new Map();
    for (const p of after.byAnimal.get(self.id) || []) pairs.set(p.a.id === self.id ? p.b.id : p.a.id, p);
    const perCol = new Map();
    let any = false;
    for (const [oid, card] of S.cards) {
        if (oid === self.id) {
            setClass(card, 'focus', true);
            continue;
        }
        const other = model.animals.get(oid);
        const rel = other && other.guid ? model.ped.relation(self.guid, other.guid) : null;
        if (!rel) {
            setClass(card, 'dim', true);
            continue;
        }
        any = true;
        const p = pairs.get(oid);
        const tone = p ? p.severity : 'apart';
        setClass(card, 'relHot', true);
        setClass(card, 'rel_' + tone, true);
        setText(card.__rel, relationWord(rel, other.sex));
        const col = card.__col || findCol(oid);
        if (col) {
            const e = perCol.get(col) || { n: 0, worst: null };
            e.n++;
            if (severityRank(tone) > severityRank(e.worst)) e.worst = tone;
            perCol.set(col, e);
        }
    }
    if (S.root) setClass(S.root, 'hovering', true);
    if (!any) {
        for (const card of S.cards.values()) setClass(card, 'dim', false);
    }
    for (const [colId, e] of perCol) {
        const c = S.colEls.get(colId);
        if (!c) continue;
        setText(c.rel, `${e.n} relative${e.n > 1 ? 's' : ''}`);
        c.rel.className = `PZ2QoL_kbColRel show rel_${e.worst || 'apart'}`;
    }
}

function findCol(id) {
    for (const [colId, c] of S.colEls) {
        if (c.col.animals.some(x => x.a.id === id)) return colId;
    }
    return null;
}

// ------------------------------------------------------------- dragging

function startPointer(e, id, card) {
    const start = { x: e.clientX, y: e.clientY };
    const move = ev => {
        try {
            if (!S.drag) {
                if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < DRAG_START_PX) return;
                beginDrag(id, card, ev);
            }
            dragMove(ev);
        }
        catch (err) {
            reportError('ui', 'Species board: dragging failed', err, { silent: true });
            cancelDrag();
        }
    };
    const up = ev => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!S.drag) return;
        try {
            endDrag(ev);
        }
        catch (err) {
            reportError('ui', 'Species board: dropping failed', err);
            cancelDrag();
        }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    S.pointerOff = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
    };
}

function beginDrag(id, card, ev) {
    const model = S.model;
    const ids = S.selected.has(id) && S.selected.size > 1 ? Array.from(S.selected) : [id];
    const a = model.animals.get(id);
    const label = ids.length > 1 ? `${a.name} and ${ids.length - 1} more` : `${sexSymbol(a.sex)} ${a.name}`;
    const ghost = h(`div.PZ2QoL_kbDrag.${sexClass(a.sex)}`, null, h('div.PZ2QoL_kbDragName', { text: trunc(label, 30) }), h('div.PZ2QoL_kbDragHint', { text: 'Drop on a habitat' }));
    document.body.appendChild(ghost);
    S.drag = { ids, ghost, over: null, check: null, origin: card };
    S.suppressClick = true;
    setClass(card, 'dragSource', true);
    setClass(S.root, 'dragging', true);
    closeMenu();
}

function columnAt(x, y) {
    for (const [colId, c] of S.colEls) {
        const r = c.el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return colId;
    }
    return null;
}

function dragMove(ev) {
    const d = S.drag;
    if (!d) return;
    const rem = remPx();
    d.ghost.style.left = `${Math.round(ev.clientX + rem * 0.8)}px`;
    d.ghost.style.top = `${Math.round(ev.clientY + rem * 0.5)}px`;
    // near the board's edges: scroll it
    const board = S.boxes.board;
    if (board) {
        const r = board.vp.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
            if (ev.clientX < r.left + rem * 3) scrollBoxTo(board, board.vp.scrollLeft - rem * 1.2, 0);
            else if (ev.clientX > r.right - rem * 3) scrollBoxTo(board, board.vp.scrollLeft + rem * 1.2, 0);
        }
    }
    const over = columnAt(ev.clientX, ev.clientY);
    if (over === d.over) return;
    if (d.over && S.colEls.get(d.over)) {
        const old = S.colEls.get(d.over);
        setClass(old.el, 'dropOk', false);
        setClass(old.el, 'dropNo', false);
        setText(old.drop, '');
        setClass(old.drop, 'show', false);
    }
    d.over = over;
    d.check = null;
    if (!over) return;
    const c = S.colEls.get(over);
    const check = dropCheck(S.model, c.col, d.ids);
    d.check = check;
    setClass(c.el, check.ok ? 'dropOk' : 'dropNo', true);
    let text = check.reason;
    let tone = 'bad';
    if (check.ok) {
        if (check.noop) {
            text = 'Already here';
            tone = 'info';
        }
        else {
            // what this drop would change for the species
            let trial = S.plan;
            for (const id of d.ids) trial = setMove(S.model, trial, id, over);
            const dest = destFor(S.model);
            const imp = planImpact(S.after, simulatePlan(S.model, trial, dest), S.species);
            const made = imp.created.filter(p => p.severity === 'risk' || p.severity === 'kin');
            const gone = imp.fixed.filter(p => p.severity === 'risk' || p.severity === 'kin');
            if (made.length) {
                text = `Creates ${made.length} related pair${made.length > 1 ? 's' : ''} here`;
                tone = 'bad';
            }
            else if (gone.length) {
                text = `Fixes ${gone.length} related pair${gone.length > 1 ? 's' : ''}`;
                tone = 'ok';
            }
            else {
                text = 'No new related pairs';
                tone = 'ok';
            }
            if (check.unknown) text += ' · not checked by the game yet';
        }
    }
    setText(c.drop, text);
    c.drop.className = `PZ2QoL_kbColDrop show ${tone}`;
}

function endDrag(ev) {
    const d = S.drag;
    dragMove(ev);
    const over = d.over;
    const check = d.check;
    cancelDrag(true);
    // the click that may follow this mouseup belongs to the drag; later ones do not
    setTimeout(() => { S.suppressClick = false; }, 0);
    if (!over) return renderAll();
    if (!check || !check.ok) {
        if (check && check.reason) notice(check.reason, 'bad');
        return renderAll();
    }
    if (check.noop) return renderAll();
    applyMoves(d.ids, over);
}

function cancelDrag(keepSuppress) {
    const d = S.drag;
    if (S.pointerOff) S.pointerOff();
    S.pointerOff = null;
    if (!d) return;
    if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
    S.drag = null;
    if (!keepSuppress) S.suppressClick = false;
    setClass(S.root, 'dragging', false);
    if (S.deferred || !keepSuppress) renderAll();
}

// ----------------------------------------------------------- plan editing

function applyMoves(ids, to) {
    const model = getKinModel();
    if (!model) return;
    let plan = S.plan;
    const names = [];
    for (const id of ids) {
        const a = model.animals.get(String(id));
        if (!a || !canMove(a)) continue;
        plan = setMove(model, plan, a.id, to);
        S.reasons.delete(a.id);
        names.push(`${a.name} ${sexSymbol(a.sex)}`);
    }
    S.plan = plan;
    S.selected.clear();
    if (names.length) {
        notice(`${names.join(', ')} → ${placeName(model, to)}: planned. Nothing moves until you run the plan.`);
        breadcrumb('kin_board_plan');
    }
    S.planTab = 'plan';
    renderAll();
}

function removeMove(id) {
    const model = getKinModel();
    const a = model && model.animals.get(String(id));
    S.plan = a ? setMove(model, S.plan, a.id, homeOf(a)) : S.plan.filter(m => m.id !== String(id));
    S.reasons.delete(String(id));
    renderAll();
}

function suggest() {
    const model = getKinModel();
    if (!model || !S.species) return;
    if (!destKnown()) {
        notice('Kin needs the game\'s habitat checks before it can suggest moves. Press Rescan or wait a moment.', 'warn');
        loadDestinations(true);
        return;
    }
    const assignments = getAssignments(model);
    const own = assignedCount(model, S.species);
    const moves = suggestPlan(model, S.species, destFor(model), { allowTrade: false, includeKin: true, assignments });
    if (!moves.length) {
        const list = speciesList(model).find(s => s.species === S.species);
        notice(list && (list.counts.risk || list.counts.kin)
            ? (own
                ? `No move into ${speciesName(S.species)}'s ${own} assigned habitat${own > 1 ? 's' : ''} fixes its related pairs without creating new ones. Assign another habitat, use contraception, or the trade centre.`
                : `No move fixes ${speciesName(S.species)}'s related pairs without creating new ones. Try another habitat, contraception, or the trade centre.`)
            : `${speciesName(S.species)} has no related pairs to fix.`, list && (list.counts.risk || list.counts.kin) ? 'warn' : 'ok');
        return;
    }
    let plan = S.plan;
    for (const m of moves) {
        plan = setMove(model, plan, m.id, m.to);
        S.reasons.set(String(m.id), m.reason || '');
    }
    S.plan = plan;
    S.planTab = 'plan';
    notice(`Kin suggests ${moves.length} move${moves.length > 1 ? 's' : ''}${own ? `, only into ${speciesName(S.species)}'s ${own} assigned habitat${own > 1 ? 's' : ''}` : ''}. Check them below; nothing moves until you run the plan.`, 'ok');
    breadcrumb('kin_board_suggest');
    renderAll();
}

function clearPlan() {
    S.plan = [];
    S.reasons.clear();
    renderAll();
}

function execute() {
    const model = getKinModel();
    const blocked = planBlockedReason(model);
    if (blocked) {
        notice(blocked, 'warn');
        return;
    }
    if (!S.plan.length) return;
    const plan = S.plan.map(m => ({ id: m.id, to: m.to }));
    for (const m of plan) S.sent.add(m.id);
    S.planTab = 'run';
    S.selected.clear();
    closeMenu();
    breadcrumb('kin_board_execute');
    runPlan(plan, { destinations: destFor(model) }).then(r => {
        if (r && r.ok === false && r.detail && !getPlanRun().finished) notice(r.detail, 'bad');
        queueRender();
    }, e => {
        reportError('mod', 'Species board: the plan could not run', e);
        queueRender();
    });
    renderAll();
}

// One move now, one click (like the game's own Move).
function moveNow(id, to) {
    const model = getKinModel();
    const a = model && model.animals.get(String(id));
    if (!a) return;
    if (getPlanRun().running) {
        notice('A plan is running. Wait for it to finish (or stop it) before moving animals.', 'warn');
        return;
    }
    if (S.pendingMove.size) {
        notice('One move at a time: wait for the game to answer the last one.', 'warn');
        return;
    }
    if (!canMove(a)) {
        notice(`${a.name} cannot be moved right now.`, 'warn');
        return;
    }
    const where = placeName(model, to);
    S.pendingMove.set(a.id, to);
    S.sent.add(a.id);
    closeMenu();
    notice(`Moving ${a.name} ${sexSymbol(a.sex)} to ${where}…`);
    breadcrumb('kin_board_move_now');
    moveAnimal(a.id, to).then(r => {
        S.pendingMove.delete(a.id);
        if (r && r.ok) {
            notice(`${a.name} ${sexSymbol(a.sex)} is on the way to ${where}.`, 'ok');
            const m = getKinModel();
            if (m) S.plan = S.plan.filter(x => x.id !== a.id);
        }
        else {
            S.sent.delete(a.id);
            notice(`The game did not move ${a.name}: ${(r && r.detail) || 'no answer'}.`, 'bad');
        }
        queueRender();
    }, e => {
        S.pendingMove.delete(a.id);
        S.sent.delete(a.id);
        reportError('mod', 'Species board: the move failed', e);
        queueRender();
    });
    renderAll();
}

// ------------------------------------------------------------------ menu

function closeMenu() {
    if (S.menu && S.menu.parentNode) S.menu.parentNode.removeChild(S.menu);
    const had = !!S.menu;
    S.menu = null;
    S.menuFor = null;
    if (had && S.deferred) queueRender();
}

function openMenu(id, anchor) {
    const model = getKinModel();
    const a = model && model.animals.get(String(id));
    if (!a || !S.root) return;
    if (S.menuFor === a.id) return closeMenu();
    closeMenu();
    const planned = S.plan.find(m => m.id === a.id);
    const kids = [h('div.PZ2QoL_kbMenuTitle', { text: `${sexSymbol(a.sex)} ${a.name}` }),
        h('div.PZ2QoL_kbMenuSub', { text: placeName(model, homeOf(a)) })];
    const running = getPlanRun().running;
    if (!canMove(a)) kids.push(h('div.PZ2QoL_kbMenuNote', { text: a.moving ? 'Already on the move.' : 'Cannot be moved from here.' }));
    else if (planned) {
        kids.push(h(`div.PZ2QoL_kbMenuItem.primary${running ? '.disabled' : ''}`, { onClick: guard('Move now', () => moveNow(a.id, planned.to)) },
            h('span', { text: `Move now to ${trunc(placeName(model, planned.to), 22)}` })));
        kids.push(h('div.PZ2QoL_kbMenuItem', { onClick: guard('Remove move', () => { closeMenu(); removeMove(a.id); }) }, h('span', { text: 'Remove from the plan' })));
    }
    else {
        const targets = S.columns.filter(c => c.kind !== 'trade' && c.id !== homeOf(a) && dropCheck(model, c, [a.id]).ok);
        // the trade centre first: the usual place to send surplus animals
        if (homeOf(a) !== TRADE) {
            kids.push(h(`div.PZ2QoL_kbMenuItem.trade${running ? '.disabled' : ''}`, {
                title: 'One move: a keeper takes it to the trade centre, where you can sell, trade or release it',
                onClick: guard('Move now', () => moveNow(a.id, TRADE)),
            }, h('span', { text: `Send to ${trunc(placeName(model, TRADE), 22)}` })));
        }
        kids.push(h('div.PZ2QoL_kbMenuHead', { text: targets.length ? 'Move now to a habitat (one move)' : 'No other suitable habitat' }));
        for (const c of targets.slice(0, 8)) {
            kids.push(h(`div.PZ2QoL_kbMenuItem${running ? '.disabled' : ''}`, { onClick: guard('Move now', () => moveNow(a.id, c.id)) },
                h('span', { text: trunc(c.name, 26) }), c.dest || c.kind !== 'habitat' ? null : h('span.PZ2QoL_kbMenuFaint', { text: 'not checked' })));
        }
    }
    kids.push(h('div.PZ2QoL_kbMenuItem.ghost', { onClick: guard('Kin planner', () => openPlanner({ animalId: a.id })) }, h('span', { text: 'Relatives and mates in the kin planner' })));
    const menu = h('div.PZ2QoL_kbMenu', null, kids);
    menu.addEventListener('mousedown', e => e.stopPropagation());
    S.root.appendChild(menu);
    S.menu = menu;
    S.menuFor = a.id;
    // next to the card, inside the panel
    const rr = S.root.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    let left = ar.right - rr.left + 4;
    if (left + mr.width > rr.width - 8) left = ar.left - rr.left - mr.width - 4;
    let top = ar.top - rr.top - 4;
    if (top + mr.height > rr.height - 8) top = rr.height - mr.height - 8;
    menu.style.left = `${Math.round(Math.max(8, left))}px`;
    menu.style.top = `${Math.round(Math.max(8, top))}px`;
}

// ------------------------------------------------------------------ plan

function renderNotice() {
    const el = S.el.notice;
    if (!el) return;
    const n = S.notice && Date.now() < S.notice.until ? S.notice : null;
    setText(el, n ? n.text : '');
    el.className = `PZ2QoL_kbNotice${n ? ' show ' + n.tone : ''}`;
}

function impactLine(label, n, tone) {
    return h(`div.PZ2QoL_kbImpactNum.${tone}`, null, h('span.PZ2QoL_kbImpactN', { text: String(n) }), h('span', { text: label }));
}

function pairText(p) {
    const word = relationWord(p.rel, p.b.sex);
    return `${p.a.name} ${sexSymbol(p.a.sex)} – ${p.b.name} ${sexSymbol(p.b.sex)}${word ? ` (${p.a.sex === Sex.Male ? 'his ' : ''}${word})` : ''}`;
}

function renderPlan(model, dest) {
    const el = S.el.plan;
    clear(el);
    const run = getPlanRun();
    // left: the moves (or the last run's log)
    const list = h('div.PZ2QoL_kbPlanList');
    const hasRun = run.running || run.finished;
    const tab = hasRun && S.planTab === 'run' ? 'run' : 'plan';
    list.appendChild(h('div.PZ2QoL_kbTabs', null,
        h(`div.PZ2QoL_kbTab${tab === 'plan' ? '.on' : ''}`, { onClick: guard('Plan', () => { S.planTab = 'plan'; renderAll(); }) }, h('span', { text: `Plan · ${S.plan.length} move${S.plan.length === 1 ? '' : 's'}` })),
        hasRun ? h(`div.PZ2QoL_kbTab${tab === 'run' ? '.on' : ''}`, { onClick: guard('Run', () => { S.planTab = 'run'; renderAll(); }) }, h('span', { text: run.running ? 'Running' : 'Last run' })) : null,
        h('div.PZ2QoL_kpFlex'),
        h(`div.PZ2QoL_kpBtn.small.PZ2QoL_kbClearPlan${S.plan.length && !run.running ? '' : '.disabled'}`, { title: 'Remove every planned move', onClick: guard('Clear plan', clearPlan) }, h('span', { text: 'Clear plan' }))));
    const box = makeScroll('kbPlanBox', { onScroll: (x, y) => { S.scroll.list = y; } });
    S.boxes.list = box;
    if (tab === 'run') {
        if (!run.log.length) box.content.appendChild(h('div.PZ2QoL_kbPlanEmpty', { text: run.current ? `Sending: ${run.current}` : 'Starting…' }));
        run.log.forEach((l, i) => box.content.appendChild(h(`div.PZ2QoL_kbLogRow.${l.ok ? 'ok' : 'bad'}`, null,
            h('div.PZ2QoL_kbLogMark', { text: l.ok ? '✓' : '✗' }),
            h('div.PZ2QoL_kbLogText', null, h('span', { text: `${i + 1}. ${l.text}` }), l.detail ? h('span.PZ2QoL_kbLogDetail', { text: l.detail }) : null))));
        if (run.running && run.current) box.content.appendChild(h('div.PZ2QoL_kbLogRow.now', null, h('div.PZ2QoL_kbLogMark', { text: '…' }), h('div.PZ2QoL_kbLogText', null, h('span', { text: run.current }))));
    }
    else if (!S.plan.length) {
        box.content.appendChild(h('div.PZ2QoL_kbPlanEmpty', { text: 'No moves yet. Drag animals between habitats, select them and press "Move N here", or let Kin suggest fixes.' }));
    }
    else {
        S.plan.forEach((m, i) => {
            const a = model && model.animals.get(m.id);
            const reason = S.reasons.get(m.id);
            box.content.appendChild(h(`div.PZ2QoL_kbMove${a && a.species === S.species ? '' : '.other'}`, { 'data-move': m.id },
                h('div.PZ2QoL_kbMoveN', { text: String(i + 1) }),
                h('div.PZ2QoL_kbMoveText', { title: moveText(model, m, dest) },
                    h('div.PZ2QoL_kbMoveMain', null,
                        a ? h(`span.PZ2QoL_kbMoveName.${sexClass(a.sex)}`, { text: `${sexSymbol(a.sex)} ${trunc(a.name, 16)}` }) : h('span', { text: m.id }),
                        h('span.PZ2QoL_kbMoveWhere', { text: `${trunc(placeName(model, a ? homeOf(a) : ''), 18)} → ${trunc(placeName(model, m.to), 20)}` })),
                    reason ? h('span.PZ2QoL_kbMoveWhy', { text: `Suggested: ${reason}` }) : null),
                h(`div.PZ2QoL_kbMini${run.running || S.pendingMove.size ? '.disabled' : ''}`, {
                    title: 'Send just this move to the game now (one move)',
                    onClick: guard('Move now', () => moveNow(m.id, m.to)),
                }, h('span', { text: 'Move now' })),
                h('div.PZ2QoL_kbCardX', { title: 'Remove this move', onClick: guard('Remove move', () => removeMove(m.id)) }, h('div.PZ2QoL_kpCloseX.a'), h('div.PZ2QoL_kpCloseX.b'))));
        });
    }
    list.appendChild(box.wrap);
    restoreScroll(box, 0, S.scroll.list);
    el.appendChild(list);
    // middle: what the plan does
    el.appendChild(impactEl(model, dest));
    // right: actions
    el.appendChild(actionsEl(model));
}

function impactEl(model, dest) {
    const wrap = h('div.PZ2QoL_kbImpact');
    const box = makeScroll('kbImpactBox', { onScroll: (x, y) => { S.scroll.impact = y; } });
    S.boxes.impact = box;
    const c = box.content;
    S.el.notice = h('div.PZ2QoL_kbNotice');
    if (!model || !S.species) {
        c.appendChild(h('div.PZ2QoL_kbPlanEmpty', { text: 'Pick a species to plan moves.' }));
        wrap.appendChild(box.wrap);
        wrap.appendChild(S.el.notice);
        renderNotice();
        return wrap;
    }
    const after = S.after || model;
    const sp = planImpact(model, after, S.species);
    const zoo = planImpact(model, after);
    const name = speciesName(S.species);
    wrap.setAttribute('data-fixed', String(sp.risksFixed));
    wrap.setAttribute('data-created', String(sp.risksCreated));
    wrap.setAttribute('data-after-risk', String(sp.after.risk));
    wrap.setAttribute('data-after-kin', String(sp.after.kin));
    wrap.setAttribute('data-moves', String(S.plan.length));
    if (!S.plan.length) {
        c.appendChild(h('div.PZ2QoL_kbImpactTitle', { text: `${name} now` }));
        c.appendChild(h('div.PZ2QoL_kbImpactRow', null, countPills(sp.before).length ? countPills(sp.before) : h('div.PZ2QoL_kpCount.sev_none', null, h('span.PZ2QoL_kpCountL', { text: 'No related pairs' }))));
        c.appendChild(h('div.PZ2QoL_kbImpactNote', { text: sp.before.risk || sp.before.kin
            ? 'Move animals to see what changes. "Suggest fixes" moves as few animals as possible, each to a habitat where it has no relatives.'
            : 'Nothing to fix for this species. You can still plan moves to balance the habitats.' }));
    }
    else {
        const fixedKin = sp.fixed.filter(p => p.severity === 'kin').length;
        const createdKin = sp.created.filter(p => p.severity === 'kin').length;
        c.appendChild(h('div.PZ2QoL_kbImpactTitle', { text: `What the plan does for ${name}` }));
        c.appendChild(h('div.PZ2QoL_kbImpactNums', null,
            impactLine(countWord('risk', sp.risksFixed) + ' fixed', sp.risksFixed, sp.risksFixed ? 'good' : 'flat'),
            impactLine(sp.risksCreated === 1 ? 'new risk' : 'new risks', sp.risksCreated, sp.risksCreated ? 'bad' : 'flat'),
            fixedKin ? impactLine('close kin fixed', fixedKin, 'good') : null,
            createdKin ? impactLine('new close kin', createdKin, 'bad') : null));
        const left = countPills(sp.after);
        c.appendChild(h('div.PZ2QoL_kbImpactRow', null, h('span.PZ2QoL_kbImpactLabel', { text: 'Left after the plan:' }),
            left.length ? left : h('div.PZ2QoL_kpCount.sev_none', null, h('span.PZ2QoL_kpCountL', { text: 'No related pairs' }))));
        c.appendChild(h('div.PZ2QoL_kbImpactRow.faint', null, h('span', { text: `Zoo-wide inbreeding risks: ${zoo.before.risk} → ${zoo.after.risk}${zoo.risksCreated ? ` (${zoo.risksCreated} new)` : ''}` })));
        for (const p of sp.created.filter(q => q.severity === 'risk' || q.severity === 'kin')) {
            c.appendChild(h(`div.PZ2QoL_kbCreated.sev_${p.severity}`, null, h('span', { text: `New ${p.severity === 'risk' ? 'inbreeding risk' : 'close kin'}: ${pairText(p)} in ${placeName(model, p.hab)}` })));
        }
    }
    for (const pr of planProblems(model, S.plan, dest, { assignments: getAssignments(model) })) {
        c.appendChild(h(`div.PZ2QoL_kbProblem${pr.warn ? '.warn' : ''}`, null, h('span', { text: pr.text })));
    }
    restoreScroll(box, 0, S.scroll.impact);
    wrap.appendChild(box.wrap);
    wrap.appendChild(S.el.notice);
    renderNotice();
    return wrap;
}

function actionsEl(model) {
    const run = getPlanRun();
    const el = h('div.PZ2QoL_kbActions');
    // the buttons stay put; messages scroll below them
    const box = makeScroll('kbActBox', { onScroll: (x, y) => { S.scroll.actions = y; } });
    S.boxes.actions = box;
    const msg = box.content;
    const finish = () => {
        el.appendChild(box.wrap);
        restoreScroll(box, 0, S.scroll.actions || 0);
        return el;
    };
    if (run.running) {
        const pct = run.total ? Math.round(run.done / run.total * 100) : 0;
        el.appendChild(h('div.PZ2QoL_kbRunTitle', { text: `Moving ${Math.min(run.done + 1, run.total)} of ${run.total}` }));
        const last = run.log.length ? run.log[run.log.length - 1] : null;
        const between = !run.current || (last && last.text === run.current);
        el.appendChild(h('div.PZ2QoL_kbRunNow', { text: between ? (run.done ? 'Done one; a short pause before the next…' : 'Starting…') : run.current }));
        el.appendChild(h('div.PZ2QoL_kbProgress', null, h('div.PZ2QoL_kbProgressFill', { style: { width: `${pct}%` } })));
        el.appendChild(btn(run.stopping ? 'Stopping after this move…' : 'Stop', null, () => stopPlan(), { cls: run.stopping ? 'disabled.wide' : 'stop.wide' }));
        msg.appendChild(h('div.PZ2QoL_kbRunNote', { text: 'One move at a time; each waits for the game to confirm it before the next.' }));
        return finish();
    }
    const blocked = model ? planBlockedReason(model) : 'No kin data yet.';
    const row = h('div.PZ2QoL_kbActRow', null,
        btn('Suggest fixes', 'IconGenetics', suggest, { title: 'Moves that remove this species\' related pairs without creating new ones' }),
        btn('Breeding programme', 'IconFertility', openProgramme, {
            cls: S.prog && S.prog.species === S.species ? 'on' : '',
            title: 'Plan the best breeding groups for this species: unrelated partners, the best expected young, the game\'s own group sizes and space',
        }),
        btn('Thin out', 'IconTradeCentre', openCull, {
            cls: S.cull && S.cull.species === S.species ? 'on' : '',
            title: 'Full habitats: pick the animals to send to the trade centre (too old, extra males, weaker genes) and keep the best breeders',
        }));
    el.appendChild(row);
    const exec = btn(`Execute plan (${S.plan.length} move${S.plan.length === 1 ? '' : 's'})`, null, execute, {
        cls: `primary.wide${!S.plan.length || blocked ? '.disabled' : ''}`,
        title: 'Run the plan: one move at a time, each confirmed by the game; it stops at the first problem',
    });
    el.appendChild(exec);
    if (run.finished) {
        msg.appendChild(h(`div.PZ2QoL_kbRunResult.${run.error ? 'bad' : 'ok'}`, {
            text: run.error ? `Last run stopped after ${run.done} of ${run.total}: ${run.error}` : `Last run: ${run.done} move${run.done === 1 ? '' : 's'} sent to the game.`,
        }));
    }
    if (blocked && S.plan.length && model) {
        const online = model.mode !== 'offline' && !getKinSettings().allowPlansOnline;
        const head = model.mode === 'franchise' ? 'Franchise zoo: running a whole plan is off by default.' : 'Game mode not known: running a whole plan is off by default.';
        msg.appendChild(h('div.PZ2QoL_kbBlocked', { text: online ? head + ' "Move now" still moves one animal per click.' : blocked, title: blocked }));
        if (online) {
            msg.appendChild(switchEl('Allow running plans in Franchise', false, () => setKinSettings({ allowPlansOnline: true }),
                'Lets Execute run whole plans in a Franchise (online) zoo'));
            msg.appendChild(h('div.PZ2QoL_kbWarn', { text: 'These are online actions: still one confirmed move at a time, stopping at the first problem.' }));
        }
    }
    else if (model && model.mode !== 'offline' && getKinSettings().allowPlansOnline) {
        msg.appendChild(switchEl('Allow running plans in Franchise', true, () => setKinSettings({ allowPlansOnline: false }),
            'Turn off to allow single moves only'));
    }
    return finish();
}

// ------------------------------------------------------ breeding programme

// The species' habitats the game should describe: where it lives, where it
// may go, and the ones set aside for it.
function programmeHabitats(model, species) {
    const ids = new Set();
    for (const a of model.animals.values()) if (a.species === species && a.hab) ids.add(a.hab);
    const d = S.dest && S.dest.bySpecies && S.dest.bySpecies[species];
    if (d) for (const [id, v] of Object.entries(d)) if (v && v.ok) ids.add(String(id));
    for (const [hab, set] of getAssignments(model)) if (set && set.has(species)) ids.add(String(hab));
    return Array.from(ids);
}

function openProgramme() {
    const model = getKinModel();
    if (!model || !S.species) return;
    if (getPlanRun().running) {
        notice('A plan is running. Wait for it to finish before planning a new one.', 'warn');
        return;
    }
    if (S.prog && S.prog.species === S.species) return closeProgramme();
    S.cull = null;
    const species = S.species;
    S.prog = { species, state: 'loading', step: PROG_DEFAULT_STEP, info: null, infoError: '', results: new Map(), modelRef: null, error: null };
    closeMenu();
    S.selected.clear();
    S.scroll.prog = 0;
    breadcrumb('kin_board_programme');
    renderAll();
    const done = info => {
        if (!S.prog || S.prog.species !== species) return;
        S.prog.info = info && typeof info === 'object' && !info.error ? info : null;
        S.prog.infoError = info && info.error ? String(info.error) : '';
        S.prog.state = 'ready';
        S.prog.results = new Map();
        queueRender();
    };
    // the habitat checks first: suitable empty habitats are part of the programme
    const ids = [];
    for (const a of model.animals.values()) if (a.species === species && !a.exhibit) ids.push(a.id);
    const ready = destKnown() ? Promise.resolve() : requestDestinations(ids).then(d => {
        if (d) S.dest = d;
    }, () => {});
    ready.then(() => requestSpeciesInfo(species, programmeHabitats(getKinModel() || model, species))).then(done, e => {
        reportError('mod', 'Species board: species facts failed', e, { silent: true });
        done(null);
    });
}

function closeProgramme() {
    S.prog = null;
    renderAll();
}

// The optimiser's result for the current step (cached per step and model).
function programmeResult() {
    const p = S.prog;
    const model = getKinModel();
    if (!p || !model || p.state !== 'ready') return null;
    if (p.modelRef !== model) {
        p.modelRef = model;
        p.results = new Map();
    }
    const key = `${p.step}|${p.useTrade !== false}`;
    if (p.results.has(key)) return p.results.get(key);
    let r = null;
    try {
        r = planProgramme(model, p.species, p.info || {}, destFor(model), {
            assignments: getAssignments(model),
            options: { moveCost: PROG_STEPS[p.step].cost, useTradeCentre: p.useTrade !== false },
        });
        p.error = null;
    }
    catch (e) {
        p.error = e;
        reportError('ui', 'Species board: the breeding programme failed', e);
    }
    p.results.set(key, r);
    return r;
}

function placeOfHab(model, hab) {
    return hab === TRADE ? placeName(model, TRADE) : hab === 'away' ? 'Elsewhere' : placeName(model, hab);
}

// Who it would breed with in its new group, for the plan's reason line.
function programmeReason(model, a, to, groups, info) {
    if (to === TRADE) return 'no place in a breeding group (to trade or release)';
    const fromTrade = a.lt === 'trade' && !a.hab;
    const why = programmeReasonIn(model, a, to, groups, info);
    return fromTrade ? `from the trade centre: ${why}` : why;
}

function programmeReasonIn(model, a, to, groups, info) {
    const g = groups.find(x => x.hab === to);
    let best = null;
    for (const b of g ? g.animals : []) {
        if (b.id === a.id || (a.sex !== Sex.Unisex && b.sex === a.sex)) continue;
        const rel = a.guid && b.guid ? model.ped.relation(a.guid, b.guid) : null;
        if (rel) continue;
        const [m, f] = a.sex === Sex.Female ? [b, a] : [a, b];
        const v = youngQuality(m, f) * conceptionChance(m, f, info || {});
        if (!best || v > best.v) best = { v, b, q: Math.round(youngQuality(m, f) * 100) };
    }
    return best ? `breeds with ${best.b.name} ${sexSymbol(best.b.sex)} (expected young ${best.q})` : 'breeding programme';
}

function useProgramme() {
    const model = getKinModel();
    const r = programmeResult();
    if (!model || !r) return;
    let plan = [];
    S.reasons.clear();
    for (const m of r.moves) {
        const a = model.animals.get(String(m.id));
        if (!a || !canMove(a)) continue;
        plan = setMove(model, plan, a.id, m.to);
        S.reasons.set(a.id, programmeReason(model, a, m.to, r.groups, S.prog && S.prog.info));
    }
    S.plan = plan;
    S.prog = null;
    S.planTab = 'plan';
    notice(plan.length
        ? `Breeding programme: ${plan.length} move${plan.length === 1 ? '' : 's'} in the plan. Check the board; nothing moves until you run the plan or press Move now.`
        : 'The breeding programme needs no moves: the groups are already the best the optimiser found.', 'ok');
    breadcrumb('kin_board_programme_use');
    renderAll();
}

function programmeWarnings(model, p, r) {
    const out = [];
    const info = p.info;
    if (!info) {
        out.push(p.infoError
            ? `The game could not describe ${speciesName(p.species)} (${p.infoError}), so this plan uses estimates: up to ${PROGRAMME_DEFAULTS.defaultCapacity} adults per habitat, mixed groups, conception from the fertility genes.`
            : `The game did not answer, so this plan uses estimates: up to ${PROGRAMME_DEFAULTS.defaultCapacity} adults per habitat, mixed groups, conception from the fertility genes.`);
        return out;
    }
    if (!Array.isArray(info.conception) || !info.conception.length) out.push('No conception table from the game: the chance of young is estimated from the fertility genes.');
    if (!info.mating) out.push('The mating system is not known: mixed groups are assumed.');
    if (r) {
        const hs = info.habitats || {};
        const noSpace = r.habitats.filter(hb => !(hs[hb] && hs[hb].available));
        const busy = r.habitats.filter(hb => hs[hb] && hs[hb].calculating);
        const fall = info.social && info.social.max > 0 ? `the group size (up to ${info.social.max})` : `a default of ${PROGRAMME_DEFAULTS.defaultCapacity} adults`;
        if (noSpace.length) out.push(`No space data for ${noSpace.map(hb => placeOfHab(model, hb)).join(', ')}: room there comes from ${fall}.`);
        if (busy.length) out.push(`The game is still measuring ${busy.map(hb => placeOfHab(model, hb)).join(', ')}: its space may change.`);
    }
    return out;
}

function statTile(key, label, before, after, better, fmt = v => String(v)) {
    const b = before == null ? null : before, a = after == null ? null : after;
    let tone = 'flat';
    if (b != null && a != null && a !== b) tone = (better === 'up' ? a > b : a < b) ? 'good' : 'bad';
    return h(`div.PZ2QoL_kbStat.${tone}`, { 'data-key': key, 'data-before': b == null ? '' : String(b), 'data-after': a == null ? '' : String(a) },
        h('div.PZ2QoL_kbStatLabel', { text: label }),
        h('div.PZ2QoL_kbStatValue', null,
            h('span.PZ2QoL_kbStatBefore', { text: b == null ? '–' : fmt(b) }),
            h('div.PZ2QoL_kbArrow.small'),
            h('span.PZ2QoL_kbStatAfter', { text: a == null ? '–' : fmt(a) })));
}

function programmeEl(model) {
    const p = S.prog;
    const name = speciesName(p.species);
    const wrap = h(`div.PZ2QoL_kbProg.state_${p.state}`);
    const cancel = btn('Cancel', null, closeProgramme, { title: 'Back to the board (Esc)' });
    if (p.state === 'loading') {
        wrap.appendChild(h('div.PZ2QoL_kpEmpty', null,
            h('div.PZ2QoL_kpEmptyIcon.wait'),
            h('div.PZ2QoL_kpEmptyTitle', { text: 'Asking the game…' }),
            h('div.PZ2QoL_kpEmptyText', { text: `${name}: group size, mating system, fertility ages, the chance of young and the space in each habitat.` }),
            h('div.PZ2QoL_kpEmptyActions', null, cancel)));
        return wrap;
    }
    const r = programmeResult();
    if (!r) {
        wrap.appendChild(h('div.PZ2QoL_kpEmpty', null,
            h('div.PZ2QoL_kpEmptyTitle', { text: 'No programme' }),
            h('div.PZ2QoL_kpEmptyText', { text: p.error ? 'The optimiser failed for this species. The board is unchanged.' : `${name} has no animals that can breed and move.` }),
            h('div.PZ2QoL_kpEmptyActions', null, cancel)));
        return wrap;
    }
    const system = r.system === 'mixed' && !(p.info && p.info.mating) ? 'Unknown: mixed groups' : (SYSTEM_WORDS[r.system] || SYSTEM_WORDS.mixed);
    const toTrade = r.moves.filter(m => m.to === TRADE).length;
    const fromTrade = r.fromTrade || 0;
    const tradeBits = [fromTrade ? `${fromTrade} from the trade centre` : '', toTrade ? `${toTrade} to the trade centre` : ''].filter(Boolean).join(', ');
    // breeders waiting at the trade centre: use them or not
    const tradeToggle = r.tradeWaiting > 0 ? h(`div.PZ2QoL_kbTradeUse${p.useTrade !== false ? '.on' : ''}`, {
        'data-waiting': String(r.tradeWaiting),
        title: p.useTrade !== false
            ? `${r.tradeWaiting} breeder${r.tradeWaiting === 1 ? '' : 's'} of this species wait at the trade centre; the programme may bring them into a group. Click to leave them there.`
            : `Click to let the programme bring the ${r.tradeWaiting} breeder${r.tradeWaiting === 1 ? '' : 's'} waiting at the trade centre into a group.`,
        onClick: guard('Programme trade centre', () => {
            p.useTrade = p.useTrade === false;
            renderAll();
        }),
    }, h('span', { text: `${p.useTrade !== false ? '☑' : '☐'} Use the trade centre (${r.tradeWaiting} waiting)` })) : null;
    // head: title, the slider, the buttons
    const steps = h('div.PZ2QoL_kbSteps', null,
        h('span.PZ2QoL_kbStepEnd', { text: 'Fewer moves' }),
        PROG_STEPS.map((st, i) => h(`div.PZ2QoL_kbStep${i === p.step ? '.on' : ''}`, {
            'data-step': String(i),
            title: `${st.label}: each move costs ${st.cost} (in expected-young units)`,
            onClick: guard('Programme step', () => {
                p.step = i;
                renderAll();
            }),
        }, h('div.PZ2QoL_kbStepDot'))),
        h('span.PZ2QoL_kbStepEnd', { text: 'Best genetics' }));
    wrap.appendChild(h('div.PZ2QoL_kbProgHead', null,
        h('div.PZ2QoL_kbProgTitles', null,
            h('div.PZ2QoL_kbProgTitle', { text: `Breeding programme · ${trunc(name, 24)}` }),
            h('div.PZ2QoL_kbProgSub', { text: `${system} · ${r.moves.length} move${r.moves.length === 1 ? '' : 's'}${tradeBits ? ` (${tradeBits})` : ''}` })),
        h('div.PZ2QoL_kpFlex'),
        tradeToggle,
        steps,
        btn(`Use this plan (${r.moves.length})`, null, useProgramme, { cls: `primary${r.moves.length ? '' : '.disabled'}`, title: 'Put these moves in the plan (it replaces the current plan)' }),
        cancel));
    for (const w of programmeWarnings(model, p, r)) wrap.appendChild(h('div.PZ2QoL_kbProgWarn', { text: w }));
    // the numbers, before -> after
    const b = r.before, a = r.after;
    wrap.appendChild(h('div.PZ2QoL_kbStats', { 'data-moves': String(r.moves.length), 'data-system': r.system },
        statTile('pairs', 'Breeding pairs', b.breedingPairs, a.breedingPairs, 'up'),
        statTile('related', 'Related pairs together', b.relatedPairs, a.relatedPairs, 'down'),
        statTile('quality', 'Expected young', b.youngQuality, a.youngQuality, 'up'),
        statTile('conception', 'Chance of young', b.conception, a.conception, 'up', v => `${v}%`),
        statTile('idle', 'Without a partner', b.idle, a.idle, 'down'),
        h('div.PZ2QoL_kbStat.moves', { 'data-key': 'moves' }, h('div.PZ2QoL_kbStatLabel', { text: 'Moves' }), h('div.PZ2QoL_kbStatValue', null, h('span.PZ2QoL_kbStatAfter', { text: String(r.moves.length) })))));
    // the target groups, habitat by habitat
    const box = makeScroll('kbProgGroups', { x: true, y: true, onScroll: (x, y) => { S.scroll.progX = x; S.scroll.prog = y; } });
    S.boxes.prog = box;
    const row = h('div.PZ2QoL_kbGroupRow');
    const groups = new Map(r.groups.map(g => [g.hab, g]));
    const order = r.habitats.slice();
    for (const g of r.groups) if (!order.includes(g.hab) && g.hab !== TRADE) order.push(g.hab);
    if (groups.has(TRADE)) order.push(TRADE);
    const moved = new Map(r.moves.map(m => [m.id, m.to]));
    for (const hab of order) row.appendChild(groupEl(model, hab, groups.get(hab), r, moved));
    box.content.appendChild(row);
    wrap.appendChild(box.wrap);
    restoreScroll(box, S.scroll.progX || 0, S.scroll.prog || 0);
    return wrap;
}

function groupEl(model, hab, g, r, moved) {
    const animals = g ? g.animals : [];
    const trade = hab === TRADE;
    const cap = r.capacity[hab];
    const staying = g ? g.staying : 0;
    const adults = animals.length + staying;
    const over = !trade && cap != null && adults > cap;
    const node = h(`div.PZ2QoL_kbGroup${trade ? '.trade' : ''}${over ? '.over' : ''}${animals.length ? '' : '.none'}`, { 'data-hab': hab });
    node.appendChild(h('div.PZ2QoL_kbGroupHead', null,
        icon(trade ? 'IconTradeCentre' : 'IconHabitat', 'brown', 'sm'),
        h('div.PZ2QoL_kbGroupName', { text: trunc(placeOfHab(model, hab), 22), title: placeOfHab(model, hab) })));
    node.appendChild(h('div.PZ2QoL_kbGroupCap', {
        text: trade ? 'Leftovers: no place in a breeding group'
            : `${adults} adult${adults === 1 ? '' : 's'}${cap != null ? ` · room for ${cap}` : ''}${over ? ' · over' : ''}`,
    }));
    const line = a => {
        const from = model.animals.get(a.id);
        const home = from ? homeOf(from) : '';
        const incoming = moved.has(a.id) && home !== hab;
        return h(`div.PZ2QoL_kbGroupAnimal.${sexClass(a.sex)}${incoming ? '.in' : ''}`, { 'data-id': a.id },
            h('span.PZ2QoL_kbGroupWho', { text: `${sexSymbol(a.sex)} ${trunc(a.name, 15)}`, title: a.name }),
            incoming ? h('span.PZ2QoL_kbGroupFrom', null, h('div.PZ2QoL_kbArrow.small'), h('span', { text: `from ${trunc(placeOfHab(model, home), 12)}` })) : null);
    };
    const males = animals.filter(a => a.sex === Sex.Male);
    const females = animals.filter(a => a.sex !== Sex.Male);
    if (!animals.length) node.appendChild(h('div.PZ2QoL_kbGroupEmpty', { text: 'No breeders' }));
    for (const a of males) node.appendChild(line(a));
    if (males.length && females.length) node.appendChild(h('div.PZ2QoL_kbGroupGap'));
    for (const a of females) node.appendChild(line(a));
    if (staying) node.appendChild(h('div.PZ2QoL_kbGroupStay', { text: `+${staying} staying (young or not breeding)` }));
    // who leaves this habitat
    const leaving = [];
    for (const [id, to] of moved) {
        const a0 = model.animals.get(id);
        if (a0 && homeOf(a0) === hab && to !== hab) leaving.push({ a: a0, to });
    }
    if (leaving.length) {
        node.appendChild(h('div.PZ2QoL_kbGroupLeaveHead', { text: `Leaving (${leaving.length})` }));
        for (const l of leaving) {
            node.appendChild(h(`div.PZ2QoL_kbGroupAnimal.out.${sexClass(l.a.sex)}`, null,
                h('span.PZ2QoL_kbGroupWho', { text: `${sexSymbol(l.a.sex)} ${trunc(l.a.name, 12)}` }),
                h('span.PZ2QoL_kbGroupFrom', null, h('div.PZ2QoL_kbArrow.small'), h('span', { text: trunc(placeOfHab(model, l.to), 14) }))));
        }
    }
    return node;
}

// Like the columns: the group strip gets its height in pixels after layout.
function fitProgramme() {
    const box = S.boxes.prog;
    if (!box || !S.el.board) return;
    try {
        const board = S.el.board.getBoundingClientRect();
        const top = box.wrap.getBoundingClientRect().top;
        const pad = Math.ceil(remPx() * 0.45);
        const hgt = Math.max(remPx() * 6, Math.floor(board.bottom - top - pad));
        box.wrap.style.flex = '0 0 auto';
        box.wrap.style.height = `${hgt}px`;
        setTimeout(() => refreshBars({ prog: box }), 0);
    }
    catch (e) {
        // cosmetic
    }
}

// --------------------------------------------------------------- thin out

function openCull() {
    const model = getKinModel();
    if (!model || !S.species) return;
    if (getPlanRun().running) {
        notice('A plan is running. Wait for it to finish before planning a new one.', 'warn');
        return;
    }
    if (S.cull && S.cull.species === S.species) return closeCull();
    S.prog = null;
    const species = S.species;
    S.cull = { species, state: 'loading', info: null, infoError: '', fill: 'balanced', oldAlways: false, keepIds: new Set(), cullIds: new Set(), result: null, key: '' };
    closeMenu();
    S.selected.clear();
    S.scroll.cull = 0;
    S.scroll.cullX = 0;
    breadcrumb('kin_board_thin_out');
    renderAll();
    const done = info => {
        if (!S.cull || S.cull.species !== species) return;
        S.cull.info = info && typeof info === 'object' && !info.error ? info : null;
        S.cull.infoError = info && info.error ? String(info.error) : '';
        S.cull.state = 'ready';
        S.cull.key = '';
        queueRender();
    };
    // like the breeding programme: the habitat checks first, then the game's facts
    const ids = [];
    for (const a of model.animals.values()) if (a.species === species && !a.exhibit) ids.push(a.id);
    const ready = destKnown() ? Promise.resolve() : requestDestinations(ids).then(d => {
        if (d) S.dest = d;
    }, () => {});
    ready.then(() => requestSpeciesInfo(species, programmeHabitats(getKinModel() || model, species))).then(done, e => {
        reportError('mod', 'Species board: species facts failed', e, { silent: true });
        done(null);
    });
}

function closeCull() {
    S.cull = null;
    renderAll();
}

function cullFill(c) {
    const st = FILL_STEPS.find(x => x.id === c.fill) || FILL_STEPS[1];
    return st.fill;
}

// cullPlan for the current choices (cached until a choice or the model changes)
function cullResult() {
    const c = S.cull;
    const model = getKinModel();
    if (!c || !model || c.state !== 'ready') return null;
    const key = [c.fill, c.oldAlways, Array.from(c.keepIds).sort().join(','), Array.from(c.cullIds).sort().join(',')].join('|');
    if (c.modelRef === model && c.key === key) return c.result;
    let r = null;
    try {
        r = cullPlan(model, c.species, c.info || {}, {
            options: { fill: cullFill(c), oldAlways: c.oldAlways, keepIds: c.keepIds, cullIds: c.cullIds },
        });
        c.error = null;
        if (r) {
            let over = 0;
            for (const hb of r.habitats) if (hb.room) over += Math.max(0, hb.adults - hb.capacity);
            overBySpecies.set(c.species, over);
        }
    }
    catch (e) {
        c.error = e;
        reportError('ui', 'Species board: Thin out failed', e);
    }
    c.modelRef = model;
    c.key = key;
    c.result = r;
    return r;
}

// Kept -> leaving, leaving -> kept (the player's choice wins over the plan).
function toggleCull(id, leaving) {
    const c = S.cull;
    const model = getKinModel();
    const a = model && model.animals.get(String(id));
    if (!c || !a) return;
    if (leaving) {
        if (c.cullIds.has(a.id)) c.cullIds.delete(a.id);
        else c.keepIds.add(a.id);
    }
    else {
        if (a.moving) {
            notice(`${a.name} is already on the move.`, 'warn');
            return;
        }
        if (c.keepIds.has(a.id)) c.keepIds.delete(a.id);
        else c.cullIds.add(a.id);
    }
    renderAll();
}

function useCull() {
    const model = getKinModel();
    const r = cullResult();
    if (!model || !r || !r.moves.length) return;
    let plan = S.plan;
    let n = 0;
    for (const m of r.moves) {
        const a = model.animals.get(String(m.id));
        if (!a || !canMove(a)) continue;
        plan = setMove(model, plan, a.id, TRADE);
        S.reasons.set(a.id, `Thin out: ${m.reason}`);
        n++;
    }
    S.plan = plan;
    S.cull = null;
    S.planTab = 'plan';
    notice(`Thin out: ${n} animal${n === 1 ? '' : 's'} to the trade centre in the plan. Nothing moves until you run the plan or press Move now.`, 'ok');
    breadcrumb('kin_board_thin_out_use');
    renderAll();
}

function cullEl(model) {
    const c = S.cull;
    const name = speciesName(c.species);
    const wrap = h(`div.PZ2QoL_kbProg.PZ2QoL_kbCull.state_${c.state}`);
    const cancel = btn('Cancel', null, closeCull, { title: 'Back to the board (Esc)' });
    if (c.state === 'loading') {
        wrap.appendChild(h('div.PZ2QoL_kpEmpty', null,
            h('div.PZ2QoL_kpEmptyIcon.wait'),
            h('div.PZ2QoL_kpEmptyTitle', { text: 'Asking the game…' }),
            h('div.PZ2QoL_kpEmptyText', { text: `${name}: how many each habitat has room for, the group size and the fertile ages.` }),
            h('div.PZ2QoL_kpEmptyActions', null, cancel)));
        return wrap;
    }
    const r = cullResult();
    if (!r || !r.habitats.length) {
        wrap.appendChild(h('div.PZ2QoL_kpEmpty', null,
            h('div.PZ2QoL_kpEmptyTitle', { text: 'Nothing to thin out' }),
            h('div.PZ2QoL_kpEmptyText', { text: c.error ? 'Thin out failed for this species. The board is unchanged.' : `${name} has no animals in habitats.` }),
            h('div.PZ2QoL_kpEmptyActions', null, cancel)));
        return wrap;
    }
    const n = r.moves.length;
    const fill = h('div.PZ2QoL_kbSeg', null, FILL_STEPS.map(st => h(`div.PZ2QoL_kbSegItem${st.id === c.fill ? '.on' : ''}`, {
        'data-fill': st.id,
        title: `Keep up to ${Math.round(st.fill * 100)}% of each habitat's room${st.fill < 1 ? ' (the rest is room for young)' : ''}`,
        onClick: guard('Fill', () => {
            c.fill = st.id;
            renderAll();
        }),
    }, h('span', { text: st.label }))));
    const old = switchEl('Also send too-old animals from habitats that are not full', c.oldAlways, () => {
        c.oldAlways = !c.oldAlways;
        renderAll();
    }, 'Animals past breeding age leave even where there is room');
    const words = { polygyny: 'harem', polyandry: 'one breeding female per habitat', monogamy: 'pairs', mixed: 'mixed groups' };
    wrap.appendChild(h('div.PZ2QoL_kbProgHead', null,
        h('div.PZ2QoL_kbProgTitles', null,
            h('div.PZ2QoL_kbProgTitle', { text: `Thin out · ${trunc(name, 24)}` }),
            h('div.PZ2QoL_kbProgSub', { text: `${n} to the trade centre${r.atTrade ? ` · ${r.atTrade} already there` : ''} · ${words[r.system] || 'mixed groups'}` })),
        h('div.PZ2QoL_kpFlex'),
        fill,
        btn(`Send ${n} to the trade centre`, null, useCull, { cls: `primary${n ? '' : '.disabled'}`, title: 'Put these moves in the plan; Execute (or Move now) on the board sends them, one at a time' }),
        cancel));
    wrap.appendChild(h('div.PZ2QoL_kbCullBar', null, old, h('div.PZ2QoL_kpFlex'),
        h('div.PZ2QoL_kbCullHint', { text: 'From the trade centre you can sell them (Animal Storage, Market lister), trade or release them.' })));
    if (r.estimated) {
        wrap.appendChild(h('div.PZ2QoL_kbProgWarn', { text: `The game gave no room for these habitats: Thin out keeps ${Math.round(cullFill(c) * 100)}% of the current adults.` }));
    }
    else {
        const guess = r.habitats.filter(hb => !hb.room).map(hb => placeOfHab(model, hb.hab));
        if (guess.length) wrap.appendChild(h('div.PZ2QoL_kbProgWarn', { text: `No room from the game for ${guess.join(', ')}: there the current adults count as full.` }));
    }
    const b = r.before, a = r.after;
    wrap.appendChild(h('div.PZ2QoL_kbStats', { 'data-moves': String(n) },
        statTile('animals', 'Animals', b.animals, a.animals, 'down'),
        statTile('adults', 'Adults', b.adults, a.adults, 'down'),
        statTile('gene', 'Average genes', b.gene, a.gene, 'up'),
        statTile('old', 'Too old to breed', b.old, a.old, 'down'),
        h('div.PZ2QoL_kbStat.moves.wide', { 'data-key': 'moves' },
            h('div.PZ2QoL_kbStatLabel', { text: 'To the trade centre' }),
            h('div.PZ2QoL_kbStatValue', null, h('span.PZ2QoL_kbStatAfter', { text: String(n) }),
                r.removedGene != null ? h('span.PZ2QoL_kbStatNote', { text: `genes avg ${r.removedGene}` }) : null))));
    const box = makeScroll('kbProgGroups', { x: true, y: true, onScroll: (x, y) => { S.scroll.cullX = x; S.scroll.cull = y; } });
    S.boxes.cull = box;
    const row = h('div.PZ2QoL_kbGroupRow');
    for (const hb of r.habitats) row.appendChild(cullHabEl(model, hb));
    box.content.appendChild(row);
    wrap.appendChild(box.wrap);
    restoreScroll(box, S.scroll.cullX || 0, S.scroll.cull || 0);
    return wrap;
}

function cullRow(model, entry, leaving) {
    const a = model.animals.get(entry.id);
    if (!a) return null;
    const tag = fertilityTag(a);
    const mark = !leaving && entry.why ? CULL_MARKS[entry.why] : null;
    const gene = entry.gene != null ? Math.round(entry.gene * 100) : null;
    const node = h(`div.PZ2QoL_kbCullRow.${sexClass(a.sex)}.${leaving ? 'leave' : 'keep'}`, {
        'data-id': a.id,
        'data-state': leaving ? 'cull' : 'keep',
        'data-why': leaving ? entry.reason : (entry.why || ''),
        title: leaving ? `${a.name} leaves: ${entry.reason}. Click to keep it.` : `${a.name} stays${entry.why ? ` (${entry.why})` : ''}. Click to send it to the trade centre.`,
        onClick: guard('Thin out', () => toggleCull(a.id, leaving)),
    },
    h('div.PZ2QoL_kbCullTop', null,
        h('span.PZ2QoL_kbGroupWho', { text: `${sexSymbol(a.sex)} ${trunc(a.name, 14)}` }),
        a.juv ? h('span.PZ2QoL_kbTag.young', { text: 'young' }) : null,
        tag && !a.juv ? h(`span.PZ2QoL_kbTag.fert_${tag.cls}`, { text: tag.text, title: tag.title }) : null,
        mark ? h(`span.PZ2QoL_kbTag.mark_${mark.cls}`, { text: mark.text, title: mark.title }) : null,
        h('div.PZ2QoL_kpFlex'),
        gene != null ? h('span.PZ2QoL_kbGene', { text: String(gene), title: `Gene score ${gene}` }) : null,
        leaving
            ? h('span.PZ2QoL_kbCullUndo', { text: 'keep' })
            : h('div.PZ2QoL_kbCullX', null, h('div.PZ2QoL_kpCloseX.a'), h('div.PZ2QoL_kpCloseX.b'))),
    leaving ? h('div.PZ2QoL_kbCullWhy', { text: entry.reason }) : null);
    return node;
}

function cullHabEl(model, hb) {
    const over = hb.adults > hb.target;
    const node = h(`div.PZ2QoL_kbGroup.PZ2QoL_kbCullHab${over ? '.over' : ''}`, { 'data-hab': hb.hab });
    node.appendChild(h('div.PZ2QoL_kbGroupHead', null,
        icon('IconHabitat', 'brown', 'sm'),
        h('div.PZ2QoL_kbGroupName', { text: trunc(placeOfHab(model, hb.hab), 22), title: placeOfHab(model, hb.hab) })));
    node.appendChild(h('div.PZ2QoL_kbGroupCap', {
        text: `${hb.adults} adult${hb.adults === 1 ? '' : 's'} · room for ${hb.capacity}${hb.room ? '' : '?'} → keep ${hb.target}${hb.juveniles ? ` · ${hb.juveniles} young` : ''}`,
        title: hb.room ? 'Room from the game (group size and space)' : 'The game gave no room: the current adults count as full',
    }));
    // who leaves first: that is what the player checks
    if (hb.cull.length) {
        node.appendChild(h('div.PZ2QoL_kbCullHead.leave.first', { text: `To the trade centre (${hb.cull.length})` }));
        for (const k of hb.cull) {
            const el = cullRow(model, k, true);
            if (el) node.appendChild(el);
        }
    }
    else node.appendChild(h('div.PZ2QoL_kbGroupEmpty', { text: over ? 'Nothing it can spare' : 'Fits: nobody leaves' }));
    const keep = hb.keep.slice().sort((x, y) => (y.value || 0) - (x.value || 0));
    node.appendChild(h('div.PZ2QoL_kbCullHead', { text: `Stay (${keep.length}) · click one to send it away` }));
    for (const k of keep) {
        const el = cullRow(model, k, false);
        if (el) node.appendChild(el);
    }
    return node;
}

function fitCull() {
    const box = S.boxes.cull;
    if (!box || !S.el.board) return;
    try {
        const board = S.el.board.getBoundingClientRect();
        const top = box.wrap.getBoundingClientRect().top;
        const hgt = Math.max(remPx() * 6, Math.floor(board.bottom - top - Math.ceil(remPx() * 0.45)));
        box.wrap.style.flex = '0 0 auto';
        box.wrap.style.height = `${hgt}px`;
        setTimeout(() => refreshBars({ cull: box }), 0);
    }
    catch (e) {
        // cosmetic
    }
}

// ---------------------------------------------------------------- footer

function renderFoot() {
    const el = S.el.status;
    if (!el) return;
    const model = getKinModel();
    let text = 'No data yet';
    if (!getKinSettings().enabled) text = 'Kin is off';
    else if (model && S.modelTime) {
        const s = Math.round((Date.now() - S.modelTime) / 1000);
        text = `Updated ${s < 5 ? 'just now' : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`}`;
        if (model.mode === 'franchise') text += ' · Franchise zoo';
    }
    setText(el, text);
}

// ------------------------------------------------------------ navigation

function openPlanner(opts) {
    const p = panelApi('planner');
    if (!p) return;
    const o = Object.assign({}, opts || {});
    if (o.animalId == null && S.species && S.columns.length) {
        const c = S.columns.find(x => x.kind === 'habitat' && x.animals.length);
        if (c) {
            o.habitatId = c.id;
            o.species = S.species;
        }
    }
    p.open(o);
}

function loadDestinations(force) {
    const model = getKinModel();
    if (!model || !S.species) return;
    const species = S.species;
    const ids = [];
    for (const a of model.animals.values()) if (a.species === species && !a.exhibit) ids.push(a.id);
    if (!ids.length) return;
    S.destLoading = true;
    requestDestinations(ids, { force: !!force }).then(d => {
        if (d) S.dest = d;
        S.destLoading = false;
        if (S.open && S.species === species) queueRender();
    }, e => {
        S.destLoading = false;
        reportError('mod', 'Species board: habitat checks failed', e, { silent: true });
        queueRender();
    });
}

function focusSpecies(species, animalId) {
    if (species !== S.species) {
        S.species = species;
        S.selected.clear();
        S.scroll.board = 0;
        S.scroll.cols = {};
        S.hoverId = null;
    }
    closeMenu();
    loadDestinations(false);
    if (animalId != null) {
        const model = getKinModel();
        const a = model && model.animals.get(String(animalId).replace(/^animal_/, ''));
        if (a && canMove(a)) {
            S.selected.clear();
            S.selected.add(a.id);
        }
    }
    renderAll();
    // bring the chosen animal's column into view
    if (animalId != null) {
        setTimeout(() => {
            try {
                const card = S.cards.get(String(animalId).replace(/^animal_/, ''));
                const board = S.boxes.board;
                if (!card || !board) return;
                const cr = card.getBoundingClientRect(), br = board.vp.getBoundingClientRect();
                if (cr.left < br.left || cr.right > br.right) scrollBoxTo(board, board.vp.scrollLeft + cr.left - br.left - remPx(), 0);
            }
            catch (e) {
                // cosmetic
            }
        }, 0);
    }
}

// ------------------------------------------------------------ open/close

function tick() {
    if (!S.open) return;
    try {
        markKinActive();
        renderFoot();
        if (S.notice && Date.now() >= S.notice.until) {
            S.notice = null;
            renderNotice();
        }
        if (!S.drag) {
            fitColumns();
            refreshBars(S.boxes);
        }
    }
    catch (e) {
        reportError('ui', 'Species board refresh failed', e, { silent: true });
    }
}

function subscribe() {
    unsubscribe();
    S.unsub.push(onKin(() => queueRender()));
    S.unsub.push(onKinSettings(() => queueRender()));
    S.unsub.push(onAssignments(() => queueRender()));
    S.unsub.push(onPlanRun(() => queueRender()));
    S.timer = setInterval(tick, TICK_MS);
}

function unsubscribe() {
    for (const fn of S.unsub) {
        try {
            fn();
        }
        catch (e) {
            // gone
        }
    }
    S.unsub = [];
    if (S.timer) clearInterval(S.timer);
    S.timer = 0;
}

// Opens the board. opts: { species, animalId }; without them it keeps the
// last species (or the one with the worst problems).
export function openSpeciesBoard(opts = {}) {
    try {
        ensureRoot();
        hideKinCard();
        closeOtherPanels('board');
        const o = opts || {};
        const model = getKinModel();
        let species = o.species != null ? String(o.species) : null;
        if (o.animalId != null && model) {
            const a = model.animals.get(String(o.animalId).replace(/^animal_/, ''));
            if (a) species = a.species;
        }
        if (!S.dest) S.dest = cachedDestinations();
        const wasOpen = S.open;
        S.open = true;
        setClass(S.root, 'hidden', false);
        placePanel(S.root);
        if (!wasOpen) subscribe();
        breadcrumb('kin_board_open');
        requestKinScan('board');
        markKinActive();
        if (species) focusSpecies(species, o.animalId);
        else {
            renderAll();
            loadDestinations(false);
        }
        return true;
    }
    catch (e) {
        reportError('ui', 'Species board could not open', e);
        return false;
    }
}

export function closeSpeciesBoard() {
    try {
        cancelDrag();
        closeMenu();
        S.open = false;
        S.hoverId = null;
        unsubscribe();
        if (S.root) setClass(S.root, 'hidden', true);
        // the plan stays for next time (a running plan keeps running)
    }
    catch (e) {
        reportError('ui', 'Species board could not close', e, { silent: true });
    }
    return true;
}

export function isSpeciesBoardOpen() {
    return S.open;
}

let installed = false;
export function installSpeciesBoard() {
    if (installed) return true;
    installed = true;
    document.addEventListener('keydown', e => {
        if (!S.open) return;
        if (e.key !== 'Escape' && e.keyCode !== 27) return;
        try {
            e.preventDefault();
            e.stopPropagation();
            if (S.drag) cancelDrag();
            else if (S.menu) closeMenu();
            else if (S.prog) closeProgramme();
            else if (S.cull) closeCull();
            else closeSpeciesBoard();
        }
        catch (err) {
            reportError('ui', 'Species board: Esc failed', err, { silent: true });
        }
    }, true);
    window.addEventListener('resize', () => {
        if (!S.open) return;
        placePanel(S.root);
        setTimeout(() => {
            fitColumns();
            refreshBars(S.boxes);
        }, 0);
    });
    return true;
}

registerPanel('board', { open: openSpeciesBoard, close: closeSpeciesBoard, isOpen: isSpeciesBoardOpen });
