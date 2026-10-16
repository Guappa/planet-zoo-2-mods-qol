// Kin planner: the zoo-wide answer to "who here can safely breed with whom".
//
// A large panel in its own DOM under <body> (never inside the game's preact
// tree):
//   header   zoo-wide counts, Breeding heat map, Settings, Rescan, Close
//   left     Zoo overview + every habitat with animals, worst first
//   middle   overview: every related pair, by habitat; or one habitat's
//            relatedness matrix per species (rows ♂, columns ♀)
//   right    the selected square (how they are related, expected young, one
//            click actions) or the selected animal's best mates zoo-wide
//   footer   legend and data age
// Opened by openKinPlanner({ habitatId, animalId, species, pairKey }) from
// the toolbars, kin cards and alerts. Esc closes it.
//
// Gameface: no CSS grid and no native scrolling (the game never uses
// overflow:auto; its ScrollPane sets scrollTop on an overflow:hidden box and
// handles the wheel itself), so the scroll areas here do the same, with
// their own thumbs.
import {
    SEVERITY_INFO, Sex, canLocate, explainRelation, habitatSummary, mateCandidates, offspringScore, percent, predictOffspring, relationWord,
} from '/js/mods/pz2qol/kincore.js';
import {
    COUNTED, buildMatrix, countWord, kinshipFraction, mateSections, overviewGroups, plannerHabitats, resolveState,
    speciesTabs, stateFromOpen, tierNote, zooCounts,
} from '/js/mods/pz2qol/kinplannercore.js';
import {
    getKinModel, getKinSettings, getKinState, isBreedingHeatmapOn, locateAnimal, markKinActive, onKin, onKinSettings,
    requestKinScan, setBreedingHeatmap, setContraception, setKinSettings,
} from '/js/mods/pz2qol/kin.js';
import { hideKinCard, offspringBlock, placeOf, severityTag, sexClass, sexSymbol } from '/js/mods/pz2qol/kinui.js';
import { clear, h, icon, setClass, setText, tierOf } from '/js/mods/pz2qol/ui.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import {
    btn as kitBtn, closeButton, closeOtherPanels, countPills, makeGuard, makeScroll, panelApi, placePanel, refreshBars as kitRefreshBars,
    registerPanel, restoreScroll, speciesName, switchEl as kitSwitch, trunc, wheelScroll,
} from '/js/mods/pz2qol/kinpanel.js';

const TICK_MS = 2000;           // markKinActive + "updated N s ago"
const MATE_LIMIT = 24;          // mate rows before "Show all"
const CONTRA_PENDING_MS = 6000; // a contraception click waits this long for the scan
const THRESHOLDS = [
    { value: 1 / 8, label: '1/8', tip: 'Only half-siblings, grandparents, full aunts and uncles and closer' },
    { value: 1 / 16, label: '1/16', tip: 'Also first cousins, great-grandparents, half aunts and uncles (default)' },
    { value: 1 / 32, label: '1/32', tip: 'Also half cousins and other more distant relatives' },
];

const guard = makeGuard('Kin planner');
const btn = (...args) => kitBtn(guard, ...args);
const switchEl = (...args) => kitSwitch(guard, ...args);
const refreshBars = () => kitRefreshBars(S.boxes);
const placeRoot = () => placePanel(S.root);

// --------------------------------------------------------------- state

const S = {
    root: null,
    mini: null,
    el: {},
    open: false,
    minimized: false,
    miniText: '',
    popover: false,
    st: { habId: null, species: null, pair: null, animal: null, includeYoung: true },
    mateYoung: false,
    mateAll: false,
    mateOpen: null,      // candidate id expanded in the mate list
    pendingOpen: null,   // open options waiting for the first model
    modelTime: 0,
    lastModel: undefined,
    unsub: [],
    timer: 0,
    queued: false,
    boxes: {},           // scroll boxes of the current render
    scroll: { side: 0, main: 0, detail: 0, mx: 0, my: 0 },
    keys: { main: '', detail: '' },
    pendingContra: new Map(), // id -> { on, until }
    matrix: null,        // { m, cells: [[node]], rowHeads, colHeads }
};

function scorePill(score, extra = '') {
    if (score == null) return h(`div.PZ2QoL_kpScore.tier_none${extra ? '.' + extra : ''}`, { text: '?', title: 'Genes not known' });
    return h(`div.PZ2QoL_kpScore.${tierOf(score)}${extra ? '.' + extra : ''}`, { text: String(score), title: `Expected young: ${score}/100 (mean of the four predicted genes)` });
}

function nameSpan(a, { max = 0, cls = '' } = {}) {
    return h(`span.PZ2QoL_kpName.${sexClass(a.sex)}${cls ? '.' + cls : ''}`, { text: `${sexSymbol(a.sex)} ${max ? trunc(a.name, max) : a.name}`, title: a.name });
}

function statusTags(a, { short = false } = {}) {
    const out = [];
    if (a.juv) out.push(h('span.PZ2QoL_kpTag.young', { text: 'young', title: 'Juvenile: cannot breed yet' }));
    if (a.contra) out.push(h('span.PZ2QoL_kpTag.contra', { text: short ? 'contra' : 'contraception', title: 'On contraception' }));
    if (a.infertile && !a.juv) out.push(h('span.PZ2QoL_kpTag.contra', { text: 'infertile', title: 'Infertile' }));
    if (a.preg) out.push(h('span.PZ2QoL_kpTag.preg', { text: 'pregnant', title: 'Pregnant' }));
    return out;
}

// ------------------------------------------------------------- skeleton

function ensureRoot() {
    if (S.root && S.root.parentNode) return S.root;
    const el = S.el;
    el.summary = h('div.PZ2QoL_kpSummary');
    el.board = btn('Species board', 'IconHabitat', openBoardFromPlanner, {
        title: 'Pick a species, see its animals habitat by habitat, and plan moves',
    });
    el.heat = btn('Breeding heat map', 'Icon_Heatmap', toggleHeatmap, {
        title: "Shows the game's own inbreeding-risk overlay in the world. The overlay uses the game's rule, which may differ from Kin's.",
    });
    el.settingsBtn = btn('Settings', 'IconSettings', () => setPopover(!S.popover), { title: 'Alerts and what counts as close kin' });
    el.popover = h('div.PZ2QoL_kpPopover');
    el.popover.addEventListener('mousedown', e => e.stopPropagation());
    const settingsWrap = h('div.PZ2QoL_kpPopWrap', null, el.settingsBtn, el.popover);
    el.rescan = btn('Rescan', 'Icon_CircleWithArrows', () => {
        requestKinScan('planner', { force: true });
        S.scanAsked = Date.now();
        renderFoot();
    }, { title: 'Read the animals again now' });
    el.close = h('div.PZ2QoL_kpClose', { title: 'Close (Esc)', onClick: guard('Close', () => closeKinPlanner()) },
        h('div.PZ2QoL_kpCloseX.a'), h('div.PZ2QoL_kpCloseX.b'));
    const head = h('div.PZ2QoL_kpHead', null,
        h('div.PZ2QoL_kpLogo'),
        h('div.PZ2QoL_kpTitles', null,
            h('div.PZ2QoL_kpTitle', { text: 'Kin planner' }),
            el.summary),
        h('div.PZ2QoL_kpFlex'),
        el.board, el.heat, settingsWrap, el.rescan, el.close);
    el.side = h('div.PZ2QoL_kpSide');
    el.main = h('div.PZ2QoL_kpMain');
    el.detail = h('div.PZ2QoL_kpDetail');
    el.legend = h('div.PZ2QoL_kpLegend');
    el.status = h('div.PZ2QoL_kpStatus');
    const root = h('div.PZ2QoL_kp.hidden', null,
        head,
        h('div.PZ2QoL_kpBody', null, el.side, el.main, el.detail),
        h('div.PZ2QoL_kpFoot', null, el.legend, h('div.PZ2QoL_kpFlex'), el.status));
    // the panel keeps its clicks and wheel to itself
    root.addEventListener('mousedown', e => {
        e.stopPropagation();
        try {
            if (S.popover && !el.popover.contains(e.target) && !el.settingsBtn.contains(e.target)) setPopover(false);
        }
        catch (err) {
            reportError('ui', 'Kin planner: settings failed', err, { silent: true });
        }
    });
    root.addEventListener('click', e => e.stopPropagation());
    root.addEventListener('wheel', e => {
        e.preventDefault();
        e.stopPropagation();
    });
    document.body.appendChild(root);
    S.root = root;
    buildLegend();
    // the minimised pill (after Locate or the heat map)
    if (S.mini && S.mini.parentNode) S.mini.parentNode.removeChild(S.mini);
    el.miniText = h('div.PZ2QoL_kpMiniText');
    el.miniHeat = h('div.PZ2QoL_kpBtn.small', { onClick: guard('Heat map', () => { setBreedingHeatmap(false); restore(); }) }, h('span', { text: 'Turn heat map off' }));
    S.mini = h('div.PZ2QoL_kpMini.hidden', null,
        h('div.PZ2QoL_kpLogo.small'),
        h('div.PZ2QoL_kpMiniTitles', null, h('div.PZ2QoL_kpMiniTitle', { text: 'Kin planner' }), el.miniText),
        el.miniHeat,
        h('div.PZ2QoL_kpBtn.small.primary', { onClick: guard('Back', restore) }, h('span', { text: 'Back to planner' })),
        h('div.PZ2QoL_kpClose.small', { title: 'Close the planner', onClick: guard('Close', () => closeKinPlanner()) },
            h('div.PZ2QoL_kpCloseX.a'), h('div.PZ2QoL_kpCloseX.b')));
    S.mini.addEventListener('mousedown', e => e.stopPropagation());
    document.body.appendChild(S.mini);
    return root;
}

function buildLegend() {
    const l = S.el.legend;
    clear(l);
    const item = (cls, label, tip) => h('div.PZ2QoL_kpLegendItem', { title: tip || undefined }, h(`div.PZ2QoL_kpSwatch.${cls}`), h('span', { text: label }));
    for (const s of ['risk', 'kin', 'future', 'covered', 'distant']) l.appendChild(item('sev_' + s, SEVERITY_INFO[s].label, SEVERITY_INFO[s].tip));
    l.appendChild(item('sev_none', 'Unrelated', 'No shared ancestor the game records'));
    l.appendChild(h('div.PZ2QoL_kpLegendItem', { title: 'They are mates now' }, h('div.PZ2QoL_kpMated.legend', null, icon('Icon_Heart', 'white', 'xs')), h('span', { text: 'Mates now' })));
    l.appendChild(h('div.PZ2QoL_kpLegendItem', { title: "Expected young: the mean of the four genes the game predicts for their offspring" },
        h('div.PZ2QoL_kpScore.tier_good', { text: '63' }), h('span', { text: 'Expected young (0–100)' })));
}

// ---------------------------------------------------------------- render

function queueRender() {
    if (S.queued || !S.open || S.minimized) return;
    S.queued = true;
    setTimeout(() => {
        S.queued = false;
        renderAll();
    }, 0);
}

function renderAll() {
    if (!S.root || !S.open || S.minimized) return;
    try {
        const model = getKinModel();
        const settings = getKinSettings();
        if (model !== S.lastModel) {
            S.lastModel = model;
            if (model) S.modelTime = Date.now();
        }
        if (model && S.pendingOpen) {
            S.st = stateFromOpen(model, S.pendingOpen, S.st);
            S.pendingOpen = null;
        }
        S.st = resolveState(model, S.st);
        // contraception clicks the model now shows as done
        if (model) {
            for (const [id, p] of S.pendingContra) {
                const a = model.animals.get(id);
                if (!a || a.contra === p.on || Date.now() > p.until) S.pendingContra.delete(id);
            }
        }
        S.boxes = {};
        S.matrix = null;
        renderHead(model, settings);
        renderSide(model, settings);
        renderMain(model, settings);
        renderDetail(model, settings);
        renderFoot();
        // thumbs need the layout
        setTimeout(refreshBars, 0);
    }
    catch (e) {
        reportError('ui', 'Kin planner could not draw', e);
    }
}

// ---------------------------------------------------------------- header

function renderHead(model, settings) {
    const el = S.el;
    clear(el.summary);
    if (!model) {
        el.summary.appendChild(h('div.PZ2QoL_kpSummaryText', { text: settings.enabled ? 'Waiting for animal data' : 'Kin is turned off' }));
    }
    else {
        const counts = zooCounts(model, settings.showCovered);
        const pills = countPills(counts);
        if (pills.length) {
            el.summary.appendChild(h('div.PZ2QoL_kpSummaryText', { text: 'Zoo-wide' }));
            pills.forEach(p => el.summary.appendChild(p));
        }
        else {
            el.summary.appendChild(h('div.PZ2QoL_kpCount.sev_none', null, h('span.PZ2QoL_kpCountL', { text: 'No related breeding pairs' })));
        }
        let animals = 0;
        for (const hb of plannerHabitats(model)) animals += hb.animals;
        el.summary.appendChild(h('div.PZ2QoL_kpSummaryText.faint', { text: `${animals} animals in ${model.habitatSummaries.size} habitats` }));
    }
    setClass(el.heat, 'on', isBreedingHeatmapOn());
    setClass(el.settingsBtn, 'on', S.popover);
    if (S.popover) renderPopover(settings);
}

function setPopover(on) {
    S.popover = !!on;
    setClass(S.el.popover, 'open', S.popover);
    setClass(S.el.settingsBtn, 'on', S.popover);
    if (S.popover) renderPopover(getKinSettings());
}

function renderPopover(settings) {
    const p = S.el.popover;
    clear(p);
    p.appendChild(h('div.PZ2QoL_kpPopHead', { text: 'Alerts' }));
    p.appendChild(switchEl('New inbreeding risks', settings.alerts, () => setKinSettings({ alerts: !getKinSettings().alerts }),
        'A message when a related pair becomes able to breed (an animal grows up, moves in, or stops contraception)'));
    const kin = switchEl('Close kin too', settings.alertKin, () => {
        if (getKinSettings().alerts) setKinSettings({ alertKin: !getKinSettings().alertKin });
    }, 'Also alert for close relatives the game does not warn about (cousins, grandparents...)');
    setClass(kin, 'disabled', !settings.alerts);
    p.appendChild(kin);
    p.appendChild(h('div.PZ2QoL_kpPopHead', { text: 'Show' }));
    p.appendChild(switchEl('Covered pairs', settings.showCovered, () => setKinSettings({ showCovered: !getKinSettings().showCovered }),
        'Related pairs kept apart by contraception or infertility'));
    p.appendChild(h('div.PZ2QoL_kpPopHead', { text: 'Close kin from' }));
    const seg = h('div.PZ2QoL_kpSeg', null, THRESHOLDS.map(t => h(`div.PZ2QoL_kpSegItem${Math.abs(settings.closeKinship - t.value) < 1e-9 ? '.on' : ''}`, {
        title: t.tip,
        onClick: guard('Close kin', () => setKinSettings({ closeKinship: t.value })),
    }, h('span', { text: t.label }))));
    p.appendChild(seg);
    p.appendChild(h('div.PZ2QoL_kpPopNote', { text: 'Kinship at or above this counts as close kin. 1/16 is first cousins.' }));
}

// The species board for what is on screen here (the habitat's species, or
// the selected animal's).
function openBoardFromPlanner() {
    const board = panelApi('board');
    if (!board) return;
    const model = getKinModel();
    const opts = {};
    const a = model && S.st.animal != null ? model.animals.get(String(S.st.animal)) : null;
    if (a) {
        opts.species = a.species;
        opts.animalId = a.id;
    }
    else if (S.st.species) opts.species = S.st.species;
    board.open(opts);
}

function toggleHeatmap() {
    const on = !isBreedingHeatmapOn();
    setBreedingHeatmap(on);
    breadcrumb('kin_planner_heatmap');
    if (on) minimize('Breeding heat map is on', true);
    else renderHead(getKinModel(), getKinSettings());
}

// --------------------------------------------------------------- sidebar

function renderSide(model, settings) {
    clear(S.el.side);
    const box = makeScroll('side', { onScroll: (x, y) => { S.scroll.side = y; } });
    S.boxes.side = box;
    S.el.side.appendChild(box.wrap);
    const c = box.content;
    const overviewOn = S.st.habId == null;
    const zoo = model ? zooCounts(model, settings.showCovered) : null;
    c.appendChild(h(`div.PZ2QoL_kpHab.overview${overviewOn ? '.on' : ''}`, { onClick: guard('Overview', () => selectHabitat(null)) },
        h('div.PZ2QoL_kpHabTop', null,
            icon('IconGenetics', overviewOn ? 'white' : 'brown', 'sm'),
            h('div.PZ2QoL_kpHabName', { text: 'Zoo overview' })),
        h('div.PZ2QoL_kpHabPills', null, zoo && countPills(zoo, { compact: true }).length ? countPills(zoo, { compact: true })
            : h('div.PZ2QoL_kpHabOk', { text: model ? 'All clear' : 'No data yet' }))));
    if (!model) return;
    const list = plannerHabitats(model, settings);
    c.appendChild(h('div.PZ2QoL_kpSideHead', { text: `Habitats (${list.length})` }));
    for (const hb of list) {
        const on = S.st.habId === hb.id;
        const pills = countPills(hb.counts, { compact: true });
        c.appendChild(h(`div.PZ2QoL_kpHab.sev_${hb.worst || 'none'}${on ? '.on' : ''}`, { title: hb.name, onClick: guard('Habitat', () => selectHabitat(hb.id)) },
            h('div.PZ2QoL_kpHabTop', null,
                icon(hb.kind === 'exhibit' ? 'IconExhibit' : 'IconHabitat', on ? 'white' : 'brown', 'sm'),
                h('div.PZ2QoL_kpHabName', { text: trunc(hb.name, 21) }),
                h('div.PZ2QoL_kpHabCount', { text: String(hb.animals), title: `${hb.animals} animals` })),
            h('div.PZ2QoL_kpHabPills', null, pills.length ? pills : h('div.PZ2QoL_kpHabOk', { text: 'No related pairs' }))));
    }
    restoreScroll(box, 0, S.scroll.side);
}

// ------------------------------------------------------------------ main

function renderMain(model, settings) {
    const el = S.el.main;
    clear(el);
    if (!model) {
        el.appendChild(waitingState(settings));
        return;
    }
    if (S.st.habId == null) renderOverview(model, settings);
    else renderHabitat(model, settings);
}

function waitingState(settings) {
    const off = !settings.enabled;
    const state = getKinState();
    const text = off ? 'Kin is turned off, so no relatedness is read.'
        : state.state === 'nopark' ? 'No park is loaded. Open a zoo and the planner fills in by itself.'
            : 'Kin reads your zoo\'s animals and their parents. This takes a moment after a park loads. If it stays empty, press Rescan.';
    return h('div.PZ2QoL_kpEmpty', null,
        h(`div.PZ2QoL_kpEmptyIcon.${off ? 'off' : 'wait'}`),
        h('div.PZ2QoL_kpEmptyTitle', { text: off ? 'Kin is off' : 'Waiting for animal data' }),
        h('div.PZ2QoL_kpEmptyText', { text }),
        h('div.PZ2QoL_kpEmptyActions', null,
            off ? btn('Turn Kin on', 'IconGenetics', () => setKinSettings({ enabled: true }), { cls: 'primary', tint: 'white' })
                : btn('Rescan', 'Icon_CircleWithArrows', () => requestKinScan('planner', { force: true }), { cls: 'primary', tint: 'white' })));
}

function mainHead(title, sub, extra) {
    return h('div.PZ2QoL_kpMainHead', null,
        h('div.PZ2QoL_kpMainTitles', null,
            h('div.PZ2QoL_kpMainTitle', { text: title }),
            h('div.PZ2QoL_kpMainSub', { text: sub })),
        h('div.PZ2QoL_kpFlex'),
        extra || null);
}

function renderOverview(model, settings) {
    const el = S.el.main;
    const groups = overviewGroups(model, settings);
    let total = 0;
    for (const g of groups) total += g.pairs.length;
    el.appendChild(mainHead('Zoo overview',
        total ? `${total} related ${total === 1 ? 'pair shares' : 'pairs share'} a habitat. Worst first; click a pair to see it in its habitat.`
            : 'Every male and female of the same species in the same habitat, checked for kinship.'));
    if (!groups.length) {
        let animals = 0;
        for (const hb of plannerHabitats(model)) animals += hb.animals;
        el.appendChild(h('div.PZ2QoL_kpEmpty.ok', null,
            h('div.PZ2QoL_kpEmptyIcon.ok', null, h('div.PZ2QoL_kpCheck')),
            h('div.PZ2QoL_kpEmptyTitle', { text: 'All clear' }),
            h('div.PZ2QoL_kpEmptyText', { text: `No related animals can breed with each other in your zoo. Kin checked ${animals} animals in ${model.habitatSummaries.size} habitats${settings.showCovered ? '' : ' (covered pairs hidden)'}.` }),
            h('div.PZ2QoL_kpEmptyText.faint', { text: 'Pick a habitat on the left to see its relatedness matrix, or click an animal there to find it the best mate.' })));
        return;
    }
    const key = 'overview';
    const old = S.keys.main;
    S.keys.main = key;
    const box = makeScroll('mainList', { onScroll: (x, y) => { S.scroll.main = y; } });
    S.boxes.main = box;
    el.appendChild(box.wrap);
    for (const g of groups) {
        const group = h(`div.PZ2QoL_kpGroup.sev_${g.worst || 'none'}`);
        group.appendChild(h('div.PZ2QoL_kpGroupHead', { onClick: guard('Habitat', () => selectHabitat(g.hab)) },
            icon(g.kind === 'exhibit' ? 'IconExhibit' : 'IconHabitat', 'brown', 'sm'),
            h('div.PZ2QoL_kpGroupName', { text: g.name }),
            h('div.PZ2QoL_kpGroupPills', null, countPills(g.counts)),
            h('div.PZ2QoL_kpFlex'),
            h('div.PZ2QoL_kpLink', null, h('span', { text: 'Open matrix' }), h('div.PZ2QoL_kpChevron'))));
        // the species only matters where several share the habitat
        const mixed = new Set(g.pairs.map(p => p.species)).size > 1;
        for (const p of g.pairs) group.appendChild(pairRowEl(model, p, mixed));
        box.content.appendChild(group);
    }
    restoreScroll(box, 0, old === key ? S.scroll.main : 0);
}

function pairRowEl(model, p, showSpecies) {
    const word = relationWord(p.rel, p.b.sex);
    const phrase = p.a.sex === Sex.Male ? `his ${word}` : word;
    return h(`div.PZ2QoL_kpPairRow.sev_${p.severity}`, {
        title: `${p.b.name} is ${p.a.name}'s ${word}`,
        onClick: guard('Pair', () => selectPairFromOverview(p)),
    },
    h('div.PZ2QoL_kpPairTag', null, severityTag(p.severity)),
    h('div.PZ2QoL_kpPairNames', null, nameSpan(p.a, { max: 14 }), h('span.PZ2QoL_kpDash', { text: '–' }), nameSpan(p.b, { max: 14 })),
    h('div.PZ2QoL_kpPairRel', { text: phrase }),
    h('div.PZ2QoL_kpPairPct', { text: percent(p.kinship) }),
    showSpecies ? h('div.PZ2QoL_kpPairSpecies', { text: speciesName(p.species) }) : null,
    p.mated ? h('div.PZ2QoL_kpMatesNow', null, icon('Icon_Heart', 'white', 'xs'), h('span', { text: 'mates now' })) : h('div.PZ2QoL_kpMatesNow.empty'),
    h('div.PZ2QoL_kpChevron'));
}

// --------------------------------------------------------- habitat view

function renderHabitat(model, settings) {
    const el = S.el.main;
    const sum = habitatSummary(model, S.st.habId);
    if (!sum) return;
    let animals = 0;
    for (const sp of sum.species) animals += sp.animals.length;
    const young = switchEl('Include young', S.st.includeYoung, () => {
        S.st.includeYoung = !S.st.includeYoung;
        renderAll();
    }, 'Show juveniles in the matrix (they are future risks, not current ones)');
    el.appendChild(mainHead(trunc(sum.name || 'Habitat', 34),
        `${sum.kind === 'exhibit' ? 'Exhibit' : 'Habitat'} · ${animals} animal${animals === 1 ? '' : 's'} · ${sum.species.length} species`,
        h('div.PZ2QoL_kpMainTools', null, countPills(settingsCounts(sum.counts, settings)), young)));
    const tabs = speciesTabs(sum, settings.showCovered);
    if (tabs.length > 1) {
        el.appendChild(h('div.PZ2QoL_kpTabs', null, tabs.map(t => {
            const on = t.species === S.st.species;
            return h(`div.PZ2QoL_kpTab${on ? '.on' : ''}`, { onClick: guard('Species', () => selectSpecies(t.species)) },
                h('div.PZ2QoL_kpTabName', { text: speciesName(t.species) }),
                h('div.PZ2QoL_kpTabMeta', { text: t.unisex ? `${t.animals}` : `${t.males}♂ ${t.females}♀` }),
                t.worst ? h(`div.PZ2QoL_kpTabDot.sev_${t.worst}`, { text: String(t.counts[t.worst]), title: `${t.counts[t.worst]} ${countWord(t.worst, t.counts[t.worst])}` }) : null);
        })));
    }
    const m = buildMatrix(model, S.st.habId, S.st.species, { includeYoung: S.st.includeYoung });
    if (!m) return;
    const key = `${m.habId}|${m.species}|${S.st.includeYoung}`;
    const keep = S.keys.main === key;
    S.keys.main = key;
    if (!m.rows.length || !m.cols.length) {
        el.appendChild(noPairsState(m));
        return;
    }
    el.appendChild(matrixEl(m, keep));
    const hints = [m.unisex ? 'Each square: how the column animal is related to the row animal.' : 'Each square: what she is to him.',
        'Click a square for details, a name to find that animal a mate.'];
    if (m.hiddenYoung) hints.push(`${m.hiddenYoung} young hidden.`);
    el.appendChild(h('div.PZ2QoL_kpHint', { text: hints.join(' ') }));
}

function settingsCounts(counts, settings) {
    return Object.assign({}, counts, { covered: settings.showCovered ? counts.covered : 0 });
}

function noPairsState(m) {
    const all = m.rows.concat(m.cols.filter(c => !m.rows.includes(c)));
    const sexWord = m.rows.length ? 'males' : 'females';
    return h('div.PZ2QoL_kpEmpty.small', null,
        h('div.PZ2QoL_kpEmptyTitle', { text: all.length ? `Only ${sexWord} here` : 'No animals shown' }),
        h('div.PZ2QoL_kpEmptyText', { text: all.length
            ? `No ${speciesName(m.species)} here can breed with each other. Click one to find it a mate elsewhere in the zoo.`
            : (m.hiddenYoung ? 'Only young animals live here. Turn on "Include young" to see them.' : 'No animals of this species here.') }),
        h('div.PZ2QoL_kpChips', null, all.map(a => h(`div.PZ2QoL_kpChip${S.st.animal === a.id ? '.on' : ''}`, { onClick: guard('Animal', () => selectAnimal(a.id)) },
            nameSpan(a, { max: 18 })))));
}

// rows ♂ x columns ♀; headers stay in place while the squares scroll
function matrixEl(m, keep) {
    const cellsBox = makeScroll('cells', { x: true, y: true });
    const colStrip = h('div.PZ2QoL_kpColHeads');
    const rowStrip = h('div.PZ2QoL_kpRowHeads');
    const colVp = h('div.PZ2QoL_kpColVp', null, colStrip);
    const rowVp = h('div.PZ2QoL_kpRowVp', null, rowStrip);
    cellsBox.onScroll = (x, y) => {
        colVp.scrollLeft = x;
        rowVp.scrollTop = y;
        S.scroll.mx = x;
        S.scroll.my = y;
    };
    S.boxes.matrix = cellsBox;
    // the headers scroll the squares too (the column heads sideways)
    colVp.addEventListener('wheel', e => {
        e.preventDefault();
        e.stopPropagation();
        wheelScroll(cellsBox, e, true);
    });
    rowVp.addEventListener('wheel', e => {
        e.preventDefault();
        e.stopPropagation();
        wheelScroll(cellsBox, e, false);
    });
    const colHeads = m.cols.map((a, i) => {
        const node = h(`div.PZ2QoL_kpColHead.${sexClass(a.sex)}.sev_${m.worst.get(a.id) || 'none'}${a.juv ? '.juv' : ''}`, {
            title: `${a.name}: click to find a mate`,
            onClick: guard('Animal', () => selectAnimal(a.id)),
        },
        h('div.PZ2QoL_kpHeadName', { text: `${sexSymbol(a.sex)} ${trunc(a.name, 10)}` }),
        headTags(a));
        node.__i = i;
        colStrip.appendChild(node);
        return node;
    });
    const rowHeads = m.rows.map((a, i) => {
        const node = h(`div.PZ2QoL_kpRowHead.${sexClass(a.sex)}.sev_${m.worst.get(a.id) || 'none'}${a.juv ? '.juv' : ''}`, {
            title: `${a.name}: click to find a mate`,
            onClick: guard('Animal', () => selectAnimal(a.id)),
        },
        h('div.PZ2QoL_kpHeadName', { text: `${sexSymbol(a.sex)} ${trunc(a.name, 15)}` }),
        headTags(a));
        node.__i = i;
        rowStrip.appendChild(node);
        return node;
    });
    const grid = h('div.PZ2QoL_kpGrid');
    const cells = m.cells.map((row, ri) => {
        const line = h('div.PZ2QoL_kpGridRow');
        const nodes = row.map((cell, ci) => {
            const node = cellEl(cell);
            node.__r = ri;
            node.__c = ci;
            line.appendChild(node);
            return node;
        });
        grid.appendChild(line);
        return nodes;
    });
    cellsBox.content.appendChild(grid);
    // one listener for every square
    const cellOf = t => {
        for (let n = t; n && n !== grid; n = n.parentNode) if (n.__r != null) return n;
        return null;
    };
    grid.addEventListener('click', guard('Square', e => {
        e.stopPropagation();
        const n = cellOf(e.target);
        if (!n) return;
        const cell = m.cells[n.__r][n.__c];
        if (cell.self) return;
        selectPair(cell.a.id, cell.b.id);
    }));
    let hot = null;
    grid.addEventListener('mouseover', e => {
        try {
            const n = cellOf(e.target);
            const next = n ? [n.__r, n.__c] : null;
            if (hot && next && hot[0] === next[0] && hot[1] === next[1]) return;
            if (hot) {
                setClass(rowHeads[hot[0]], 'hot', false);
                setClass(colHeads[hot[1]], 'hot', false);
            }
            hot = next;
            if (hot) {
                setClass(rowHeads[hot[0]], 'hot', true);
                setClass(colHeads[hot[1]], 'hot', true);
            }
        }
        catch (err) {
            // cosmetic only
        }
    });
    grid.addEventListener('mouseleave', () => {
        if (!hot) return;
        setClass(rowHeads[hot[0]], 'hot', false);
        setClass(colHeads[hot[1]], 'hot', false);
        hot = null;
    });
    const corner = h('div.PZ2QoL_kpCorner', null,
        h('div.PZ2QoL_kpCornerLine'),
        h('div.PZ2QoL_kpCornerCols', { text: m.unisex ? 'All' : '♀ Females' }),
        h('div.PZ2QoL_kpCornerRows', { text: m.unisex ? 'All' : '♂ Males' }));
    const node = h('div.PZ2QoL_kpMatrix', null,
        h('div.PZ2QoL_kpMatrixTop', null, corner, colVp),
        h('div.PZ2QoL_kpMatrixBody', null, rowVp, cellsBox.wrap));
    S.matrix = { m, cells, rowHeads, colHeads };
    markSelection();
    restoreScroll(cellsBox, keep ? S.scroll.mx : 0, keep ? S.scroll.my : 0);
    return node;
}

function headTags(a) {
    const tags = statusTags(a, { short: true });
    return tags.length ? h('div.PZ2QoL_kpHeadTags', null, tags) : null;
}

function cellEl(cell) {
    if (cell.self) return h('div.PZ2QoL_kpCell.self', null, h('div.PZ2QoL_kpCellSelf'));
    const sev = cell.severity;
    const kids = [];
    if (cell.word) kids.push(h('div.PZ2QoL_kpCellWord', { text: cell.word }));
    const meta = h('div.PZ2QoL_kpCellMeta', null,
        cell.kinship > 0 ? h('span.PZ2QoL_kpCellPct', { text: percent(cell.kinship) }) : null,
        cell.score != null ? scorePill(cell.score, 'mini') : null);
    kids.push(meta);
    if (cell.mated) kids.push(h('div.PZ2QoL_kpMated', { title: 'Mates now' }, icon('Icon_Heart', 'white', 'xs')));
    const info = SEVERITY_INFO[sev];
    const tip = `${cell.a.name} × ${cell.b.name}: ${cell.word || 'unrelated'}${cell.kinship > 0 ? ` (${percent(cell.kinship)} kinship)` : ''}`
        + `${info ? ' · ' + info.label : ''}${cell.score != null ? ` · expected young ${cell.score}/100` : ''}${cell.mated ? ' · mates now' : ''}`;
    return h(`div.PZ2QoL_kpCell.sev_${sev}${cell.mated ? '.mated' : ''}${cell.word ? '' : '.noword'}`, { title: tip }, kids);
}

// Selection marks without rebuilding the matrix.
function markSelection() {
    const mx = S.matrix;
    if (!mx) return;
    const pair = S.st.pair;
    // a bordered ring (not an inset shadow) marks the chosen square
    if (mx.ring && mx.ring.parentNode) mx.ring.parentNode.removeChild(mx.ring);
    mx.cells.forEach((row, ri) => row.forEach((node, ci) => {
        const cell = mx.m.cells[ri][ci];
        const on = !!pair && cell.a.id === pair.a && cell.b.id === pair.b;
        setClass(node, 'on', on);
        if (on) {
            mx.ring = mx.ring || h('div.PZ2QoL_kpRing');
            node.appendChild(mx.ring);
        }
    }));
    mx.rowHeads.forEach((node, i) => {
        const a = mx.m.rows[i];
        setClass(node, 'on', S.st.animal === a.id);
        setClass(node, 'sel', !!pair && pair.a === a.id);
    });
    mx.colHeads.forEach((node, i) => {
        const a = mx.m.cols[i];
        setClass(node, 'on', S.st.animal === a.id);
        setClass(node, 'sel', !!pair && pair.b === a.id);
    });
}

// ------------------------------------------------------------- selection

function selectHabitat(habId) {
    S.st = Object.assign({}, S.st, { habId: habId == null ? null : String(habId), species: null, pair: null });
    renderAll();
}

function selectSpecies(species) {
    S.st = Object.assign({}, S.st, { species, pair: null });
    renderAll();
}

function selectPair(a, b) {
    const same = S.st.pair && S.st.pair.a === a && S.st.pair.b === b;
    S.st = Object.assign({}, S.st, { pair: same ? null : { a, b }, animal: null });
    markSelection();
    renderDetail(getKinModel(), getKinSettings());
    setTimeout(refreshBars, 0);
}

function selectAnimal(id) {
    const same = S.st.animal === id && !S.st.pair;
    S.st = Object.assign({}, S.st, { animal: same ? null : id, pair: null });
    S.mateAll = false;
    S.mateOpen = null;
    markSelection();
    renderDetail(getKinModel(), getKinSettings());
    setTimeout(refreshBars, 0);
}

function selectPairFromOverview(p) {
    S.st = Object.assign({}, S.st, {
        habId: p.hab,
        species: p.species,
        pair: { a: p.a.id, b: p.b.id },
        animal: null,
        includeYoung: S.st.includeYoung || p.a.juv || p.b.juv,
    });
    renderAll();
}

// ---------------------------------------------------------------- detail

function renderDetail(model, settings) {
    const el = S.el.detail;
    clear(el);
    let key = 'help';
    if (model && S.st.pair) key = `pair|${S.st.pair.a}|${S.st.pair.b}`;
    else if (model && S.st.animal != null) key = `animal|${S.st.animal}|${S.mateYoung}|${S.mateAll}`;
    const keep = S.keys.detail === key || (key.startsWith('animal|') && S.keys.detail.startsWith(`animal|${S.st.animal}|`));
    S.keys.detail = key;
    const box = makeScroll('detail', { onScroll: (x, y) => { S.scroll.detail = y; } });
    S.boxes.detail = box;
    el.appendChild(box.wrap);
    const c = box.content;
    try {
        if (!model) c.appendChild(helpEl(null, settings));
        else if (S.st.pair) c.appendChild(pairDetail(model, settings));
        else if (S.st.animal != null) c.appendChild(mateFinder(model, settings));
        else c.appendChild(helpEl(model, settings));
    }
    catch (e) {
        reportError('ui', 'Kin planner: details failed', e, { silent: true });
        c.appendChild(h('div.PZ2QoL_kpDetText', { text: 'These details could not be shown.' }));
    }
    restoreScroll(box, 0, keep ? S.scroll.detail : 0);
}

function detCard(cls, ...kids) {
    return h(`div.PZ2QoL_kpDet${cls ? '.' + cls : ''}`, null, kids);
}

function helpEl(model, settings) {
    const kids = [h('div.PZ2QoL_kpDetTitle', { text: 'How to read the planner' })];
    if (model) {
        let mated = 0;
        for (const p of model.pairs) if (p.mated && p.severity !== 'distant') mated++;
        const list = plannerHabitats(model, settings);
        const bad = list.filter(hb => hb.counts.risk + hb.counts.kin > 0).length;
        kids.push(h('div.PZ2QoL_kpFacts', null,
            factTile(String(bad), bad === 1 ? 'habitat needs care' : 'habitats need care', bad ? 'risk' : 'ok'),
            factTile(String(mated), mated === 1 ? 'related pair mates now' : 'related pairs mate now', mated ? 'kin' : 'ok')));
    }
    kids.push(h('div.PZ2QoL_kpDetText', { text: 'Kin compares every male and female of the same species that share a habitat, using the parents the game records.' }));
    for (const s of ['risk', 'kin', 'future', 'covered']) {
        kids.push(h('div.PZ2QoL_kpHelpRow', null, severityTag(s), h('div.PZ2QoL_kpHelpText', { text: SEVERITY_INFO[s].tip })));
    }
    kids.push(h('div.PZ2QoL_kpSubhead', { text: 'Tips' }));
    kids.push(h('div.PZ2QoL_kpTip', { text: 'Click a square to see how two animals are related, what their young would inherit, and to give either one contraception.' }));
    kids.push(h('div.PZ2QoL_kpTip', { text: 'Click a name to rank every possible mate in the zoo, unrelated and best genes first.' }));
    kids.push(h('div.PZ2QoL_kpTip', { text: 'The game only warns about parents and siblings. Amber pairs are relatives it does not warn about.' }));
    return detCard('help', kids);
}

function factTile(value, label, tone) {
    return h(`div.PZ2QoL_kpFact.${tone}`, null, h('div.PZ2QoL_kpFactValue', { text: value }), h('div.PZ2QoL_kpFactLabel', { text: label }));
}

function animalLine(model, a) {
    const bits = [a.juv ? 'young' : 'adult'];
    if (a.contra) bits.push('on contraception');
    if (a.infertile && !a.juv) bits.push('infertile');
    if (a.preg) bits.push('pregnant');
    return bits.join(' · ');
}

function contraButton(a, { primary = true } = {}) {
    const pending = S.pendingContra.get(a.id);
    if (pending) {
        return h('div.PZ2QoL_kpAct.disabled', { title: 'Waiting for the game' }, h('span', { text: pending.on ? 'Starting contraception…' : 'Stopping contraception…' }));
    }
    const on = !!a.contra;
    return h(`div.PZ2QoL_kpAct${on || !primary ? '' : '.primary'}`, {
        title: on ? `Stop contraception for ${a.name} (the game's own toggle, this animal only)` : `Give ${a.name} contraception (the game's own toggle, this animal only)`,
        onClick: guard('Contraception', () => {
            if (S.pendingContra.has(a.id)) return;
            // exactly one game action for exactly one animal
            if (setContraception(a.id, !on)) {
                S.pendingContra.set(a.id, { on: !on, until: Date.now() + CONTRA_PENDING_MS });
                breadcrumb('kin_planner_contra');
            }
            renderDetail(getKinModel(), getKinSettings());
        }),
    }, icon('Icon_Contracepted', on ? 'brown' : 'white', 'xs'), h('span', { text: on ? 'Stop contraception' : 'Contraception' }));
}

function locateButton(a) {
    // only animals out in a habitat can be located (not exhibits, transit,
    // trade centre or quarantine)
    if (!canLocate(a)) return null;
    return h('div.PZ2QoL_kpAct', {
        title: `Move the camera to ${a.name} and open its info panel. The planner shrinks to a small bar.`,
        onClick: guard('Locate', () => {
            if (locateAnimal(a.id)) minimize(`Showing ${a.name}`);
        }),
    }, icon('IconLocation', 'brown', 'xs'), h('span', { text: 'Locate' }));
}

function pairDetail(model, settings) {
    const a = model.animals.get(S.st.pair.a);
    const b = model.animals.get(S.st.pair.b);
    if (!a || !b) return helpEl(model, settings);
    const m = S.matrix && S.matrix.m;
    const pair = (m && m.pairMap.get(a.id + '|' + b.id)) || model.pairs.find(p => (p.a === a && p.b === b) || (p.a === b && p.b === a)) || null;
    const rel = a.guid && b.guid ? model.ped.relation(a.guid, b.guid) : null;
    const sev = pair ? pair.severity : 'none';
    const tier = pair ? pair.tier : (rel ? 'distant' : 'none');
    const word = rel ? relationWord(rel, b.sex) : '';
    const kinship = rel ? rel.kinship : 0;
    const mated = (a.mates || []).includes(b.id) || (b.mates || []).includes(a.id);
    const kids = [];
    kids.push(h('div.PZ2QoL_kpDetTop', null,
        sev === 'none' ? h('div.PZ2QoL_kinTag.sev_none', { text: 'Unrelated' }) : severityTag(sev),
        h('div.PZ2QoL_kpFlex'),
        h('div.PZ2QoL_kpDetPlace', { text: `${speciesName(a.species)} · ${placeOf(model, a) || 'no habitat'}` })));
    kids.push(h('div.PZ2QoL_kpDuo', null,
        duoAnimal(model, a), h('div.PZ2QoL_kpDuoX', { text: '×' }), duoAnimal(model, b)));
    const frac = kinshipFraction(kinship);
    kids.push(h(`div.PZ2QoL_kpRelBig.sev_${sev}`, null,
        h('div.PZ2QoL_kpRelWord', { text: word ? word.charAt(0).toUpperCase() + word.slice(1) : 'Not related' }),
        kinship > 0 ? h('div.PZ2QoL_kpRelPct', { text: `${percent(kinship)} kinship${frac ? ` (${frac})` : ''}` }) : null));
    kids.push(h('div.PZ2QoL_kpDetText', { text: explainRelation(model, a, b) }));
    kids.push(h(`div.PZ2QoL_kpNote.tier_${tier}`, { text: tierNote(tier, model.closeKinship) }));
    const notes = [];
    if (mated) notes.push(`${a.name} and ${b.name} are mates now.`);
    for (const x of [a, b]) {
        if (x.contra) notes.push(`${x.name} is on contraception, so this pair cannot breed.`);
        else if (x.infertile && !x.juv) notes.push(`${x.name} is infertile.`);
    }
    for (const x of [a, b]) if (x.juv) notes.push(`${x.name} is still young${pair ? ': this becomes a risk when it grows up.' : '.'}`);
    for (const n of notes) kids.push(h('div.PZ2QoL_kpBullet', null, h('div.PZ2QoL_kpBulletDot'), h('span', { text: n })));
    const off = offspringBlock(a, b);
    if (off) {
        const score = scorePill(offspringScore(predictOffspring(a.genes, b.genes)));
        kids.push(h('div.PZ2QoL_kpOffspring', null, off, h('div.PZ2QoL_kpOffScore', null, h('span', { text: 'Overall' }), score)));
    }
    else kids.push(h('div.PZ2QoL_kpDetText.faint', { text: 'Genes not known for one of them, so no prediction for their young.' }));
    kids.push(h('div.PZ2QoL_kpSubhead', { text: 'Actions · one click is one game action' }));
    const suggest = (sev === 'risk' || sev === 'kin') ? (b.sex === Sex.Female ? b : a) : null;
    kids.push(h('div.PZ2QoL_kpActCols', null, [a, b].map(x => h(`div.PZ2QoL_kpActCol${suggest === x && !x.contra ? '.suggest' : ''}`, null,
        nameSpan(x, { max: 18 }),
        suggest === x && !x.contra ? h('div.PZ2QoL_kpSuggest', { text: `Suggested: keeps ${x.sex === Sex.Female ? 'her' : x.sex === Sex.Male ? 'him' : 'it'} from breeding with any relative` }) : null,
        contraButton(x, { primary: !suggest || suggest === x }),
        locateButton(x),
        h('div.PZ2QoL_kpAct.ghost', { onClick: guard('Find a mate', () => selectAnimal(x.id)) }, icon('IconGender', 'brown', 'xs'), h('span', { text: 'Find a mate' }))))));
    return detCard('pair', kids);
}

function duoAnimal(model, a) {
    return h(`div.PZ2QoL_kpDuoAnimal.${sexClass(a.sex)}`, null,
        h('div.PZ2QoL_kpDuoName', { text: `${sexSymbol(a.sex)} ${trunc(a.name, 16)}`, title: a.name }),
        h('div.PZ2QoL_kpDuoLine', { text: animalLine(model, a) }));
}

function mateFinder(model, settings) {
    const self = model.animals.get(String(S.st.animal));
    if (!self) return helpEl(model, settings);
    const kids = [];
    kids.push(h('div.PZ2QoL_kpDetTop', null,
        h('div.PZ2QoL_kpDetKicker', { text: 'Find a mate' }),
        h('div.PZ2QoL_kpFlex'),
        h('div.PZ2QoL_kpDetPlace', { text: `${speciesName(self.species)} · ${placeOf(model, self) || 'no habitat'}` })));
    kids.push(h(`div.PZ2QoL_kpSelf.${sexClass(self.sex)}`, null,
        h('div.PZ2QoL_kpSelfName', { text: `${sexSymbol(self.sex)} ${self.name}` }),
        h('div.PZ2QoL_kpDuoLine', { text: animalLine(model, self) })));
    kids.push(h('div.PZ2QoL_kpActRow', null, contraButton(self), locateButton(self)));
    const cands = mateCandidates(model, self.id, { includeJuveniles: S.mateYoung });
    const want = self.sex === Sex.Male ? 'females' : self.sex === Sex.Female ? 'males' : 'partners';
    kids.push(h('div.PZ2QoL_kpMateHead', null,
        h('div.PZ2QoL_kpSubhead.flat', { text: `${cands.length} possible ${want} in the zoo` }),
        h('div.PZ2QoL_kpFlex'),
        switchEl('Young too', S.mateYoung, () => {
            S.mateYoung = !S.mateYoung;
            renderDetail(getKinModel(), getKinSettings());
            setTimeout(refreshBars, 0);
        }, 'Also list juveniles (they can breed once grown)')));
    if (!cands.length) {
        kids.push(h('div.PZ2QoL_kpDetText.faint', { text: `No other ${speciesName(self.species)} ${want} in the zoo${S.mateYoung ? '' : ' (young ones hidden)'}.` }));
        return detCard('mates', kids);
    }
    let shown = 0;
    const limit = S.mateAll ? Infinity : MATE_LIMIT;
    let rank = 0;
    for (const sec of mateSections(cands)) {
        if (shown >= limit) break;
        kids.push(h(`div.PZ2QoL_kpMateSection.tier_${sec.tier}`, { title: sec.note }, h('span', { text: sec.label }), h('span.PZ2QoL_kpMateSectionN', { text: String(sec.cands.length) })));
        for (const cand of sec.cands) {
            rank++;
            if (shown >= limit) break;
            kids.push(mateRow(model, self, cand, rank));
            shown++;
        }
    }
    if (shown < cands.length) {
        kids.push(h('div.PZ2QoL_kpAct.ghost.wide', { onClick: guard('Show all', () => {
            S.mateAll = true;
            renderDetail(getKinModel(), getKinSettings());
            setTimeout(refreshBars, 0);
        }) }, h('span', { text: `Show all ${cands.length}` })));
    }
    return detCard('mates', kids);
}

function mateRow(model, self, cand, rank) {
    const a = cand.animal;
    const open = S.mateOpen === a.id;
    const word = cand.rel ? relationWord(cand.rel, a.sex) : '';
    const place = placeOf(model, a) || 'Not in a habitat';
    const mated = (self.mates || []).includes(a.id) || (a.mates || []).includes(self.id);
    const row = h(`div.PZ2QoL_kpMate.tier_${cand.tier}${cand.sameHabitat ? '.same' : ''}${open ? '.open' : ''}`);
    const top = h('div.PZ2QoL_kpMateTop', {
        title: open ? 'Click to fold' : 'Click for their expected young',
        onClick: guard('Mate', () => {
            S.mateOpen = open ? null : a.id;
            renderDetail(getKinModel(), getKinSettings());
            setTimeout(refreshBars, 0);
        }),
    },
    h('div.PZ2QoL_kpRank', { text: String(rank) }),
    h('div.PZ2QoL_kpMateMain', null,
        h('div.PZ2QoL_kpMateNameLine', null,
            nameSpan(a, { max: 17 }),
            mated ? h('div.PZ2QoL_kpMated.inline', { title: 'Mates now' }, icon('Icon_Heart', 'white', 'xs')) : null,
            statusTags(a, { short: true })),
        h('div.PZ2QoL_kpMateSub', null,
            cand.sameHabitat ? h('span.PZ2QoL_kpHere', { text: 'same habitat' }) : h('span.PZ2QoL_kpPlace', { text: trunc(place, 22), title: place }),
            h(`span.PZ2QoL_kpMateRel.tier_${cand.tier}`, { text: word ? `${word} · ${percent(cand.kinship)}` : 'unrelated' }))),
    scorePill(cand.score));
    row.appendChild(top);
    if (open) {
        const more = h('div.PZ2QoL_kpMateMore');
        more.appendChild(h('div.PZ2QoL_kpDetText', { text: explainRelation(model, self, a) }));
        const off = offspringBlock(self, a);
        if (off) more.appendChild(off);
        else more.appendChild(h('div.PZ2QoL_kpDetText.faint', { text: 'Genes not known, so no prediction for their young.' }));
        more.appendChild(h('div.PZ2QoL_kpActRow', null, locateButton(a),
            a.hab && a.hab === self.hab ? h('div.PZ2QoL_kpAct.ghost', { onClick: guard('Square', () => {
                const pairIds = self.sex === Sex.Female && a.sex !== Sex.Female ? { a: a.id, b: self.id } : { a: self.id, b: a.id };
                S.st = Object.assign({}, S.st, { habId: self.hab, species: self.species, pair: pairIds, animal: null, includeYoung: S.st.includeYoung || a.juv || self.juv });
                renderAll();
            }) }, h('span', { text: 'Show in matrix' })) : null));
        row.appendChild(more);
    }
    return row;
}

// ---------------------------------------------------------------- footer

function ago(ms) {
    const s = Math.round(ms / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s} s ago`;
    const m = Math.round(s / 60);
    return `${m} min ago`;
}

function renderFoot() {
    const el = S.el.status;
    if (!el) return;
    const st = getKinState();
    const model = getKinModel();
    let text;
    if (!getKinSettings().enabled) text = 'Kin is off';
    else if (S.scanAsked && Date.now() - S.scanAsked < 2500) text = 'Scanning…';
    else if (st.state === 'busy') text = 'Scanning…';
    else if (st.state === 'error') text = 'The last scan failed; showing older data';
    else if (model && S.modelTime) text = `Updated ${ago(Date.now() - S.modelTime)}`;
    else text = 'No data yet';
    setText(el, text);
}

// ------------------------------------------------------------ open/close

function tick() {
    if (!S.open) return;
    try {
        if (!S.minimized) markKinActive();
        else if (S.miniHeat && !isBreedingHeatmapOn()) {
            S.miniHeat = false;
            setText(S.el.miniText, 'Breeding heat map is off');
            setClass(S.el.miniHeat, 'hidden', true);
        }
        let stale = false;
        for (const [id, p] of S.pendingContra) {
            if (Date.now() > p.until) {
                S.pendingContra.delete(id);
                stale = true;
            }
        }
        if (stale && !S.minimized) renderDetail(getKinModel(), getKinSettings());
        renderFoot();
        if (!S.minimized) refreshBars();
    }
    catch (e) {
        reportError('ui', 'Kin planner refresh failed', e, { silent: true });
    }
}

function subscribe() {
    unsubscribe();
    S.unsub.push(onKin(() => queueRender()));
    S.unsub.push(onKinSettings(() => queueRender()));
    S.timer = setInterval(tick, TICK_MS);
}

function unsubscribe() {
    for (const fn of S.unsub) {
        try {
            fn();
        }
        catch (e) {
            // already gone
        }
    }
    S.unsub = [];
    if (S.timer) clearInterval(S.timer);
    S.timer = 0;
}

function minimize(text, heat) {
    if (!S.open) return;
    S.minimized = true;
    S.miniHeat = !!heat;
    setPopover(false);
    setClass(S.root, 'hidden', true);
    setText(S.el.miniText, text || '');
    setClass(S.el.miniHeat, 'hidden', !heat && !isBreedingHeatmapOn());
    setClass(S.mini, 'hidden', false);
}

function restore() {
    if (!S.open) return;
    S.minimized = false;
    setClass(S.mini, 'hidden', true);
    setClass(S.root, 'hidden', false);
    placeRoot();
    markKinActive();
    renderAll();
}

// Opens the planner. opts: { habitatId, animalId, species, pairKey }; with
// none, it opens on the zoo overview (or where it was left, if it is open).
export function openKinPlanner(opts = {}) {
    try {
        ensureRoot();
        hideKinCard();
        const o = opts || {};
        const any = o.habitatId != null || o.animalId != null || o.pairKey != null || o.species != null;
        const model = getKinModel();
        if (any) {
            S.mateAll = false;
            S.mateOpen = null;
            if (model) {
                S.st = stateFromOpen(model, o, S.st);
                S.pendingOpen = null;
            }
            else {
                S.st = stateFromOpen(null, o, S.st);
                S.pendingOpen = o;
            }
        }
        else if (!S.open) {
            S.st = Object.assign({}, S.st, { habId: null, species: null, pair: null, animal: null });
        }
        closeOtherPanels('planner');
        const wasOpen = S.open;
        S.open = true;
        S.minimized = false;
        setClass(S.mini, 'hidden', true);
        setClass(S.root, 'hidden', false);
        placeRoot();
        if (!wasOpen) subscribe();
        breadcrumb('kin_planner_open');
        requestKinScan('planner');
        markKinActive();
        renderAll();
        return true;
    }
    catch (e) {
        reportError('ui', 'Kin planner could not open', e);
        return false;
    }
}

export function closeKinPlanner() {
    try {
        S.open = false;
        S.minimized = false;
        S.popover = false;
        unsubscribe();
        if (S.root) setClass(S.root, 'hidden', true);
        if (S.mini) setClass(S.mini, 'hidden', true);
        if (S.el.popover) setClass(S.el.popover, 'open', false);
        S.pendingContra.clear();
        // the next open starts fresh from the overview's scroll positions
        S.boxes = {};
        S.matrix = null;
    }
    catch (e) {
        reportError('ui', 'Kin planner could not close', e, { silent: true });
    }
    return true;
}

// True while the planner is open (also while shrunk to its small bar).
export function isKinPlannerOpen() {
    return S.open;
}

let installed = false;
export function installKinPlanner() {
    if (installed) return true;
    installed = true;
    document.addEventListener('keydown', e => {
        if (!S.open || S.minimized) return;
        if (e.key !== 'Escape' && e.keyCode !== 27) return;
        try {
            e.preventDefault();
            e.stopPropagation();
            if (S.popover) setPopover(false);
            else closeKinPlanner();
        }
        catch (err) {
            reportError('ui', 'Kin planner: Esc failed', err, { silent: true });
        }
    }, true);
    window.addEventListener('resize', () => {
        if (!S.open || S.minimized) return;
        placeRoot();
        setTimeout(refreshBars, 0);
    });
    return true;
}

registerPanel('planner', { open: openKinPlanner, close: closeKinPlanner, isOpen: isKinPlannerOpen });
