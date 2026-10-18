// In-park launcher: two round buttons docked on top of the game's own
// tools column (bottom left: Paths, Barriers, Terrain ...), styled like it.
//  - Species board: opens (or closes) the board in one click.
//  - Autosave: shows the mod's autosave state; click for its settings.
//
// Our own element under <body>, placed every tick from the tools column's
// box (.ToolsBar_root), never inside the game's preact tree (the game
// recreates that column). Hidden whenever the column is hidden (management
// screen, photo/camera mode, hidden UI, cinematics), and it gives up the
// autosave button, then itself, when the alert buttons above leave no room.
import { autosaveCard, getAutosaveSummary, installAutosave, onAutosave } from '/js/mods/pz2qol/autosave.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';
import { h, icon, setClass, setText } from '/js/mods/pz2qol/ui.js';

const TICK_MS = 250;

let dock = null;
let boardBtn = null;
let saveBtn = null;
let saveBadge = null;
let card = null;
let boardModule = null;

function board() {
    if (boardModule) return Promise.resolve(boardModule);
    return import('/js/mods/pz2qol/kinboard.js').then(m => (boardModule = m));
}

function toggleBoard() {
    breadcrumb('board_launch');
    closeCard();
    board().then(m => {
        if (m.isSpeciesBoardOpen && m.isSpeciesBoardOpen()) m.closeSpeciesBoard();
        else m.openSpeciesBoard({});
        setTimeout(sync, 50);
    }).catch(e => reportError('ui', 'Species board could not open', e));
}

// a round button with a hover label to its right, like the game's own
function roundButton(iconName, label, onClick) {
    const tip = h('div.PZ2QoL_dockTip', { text: label });
    const b = h('div.PZ2QoL_dockBtn', { onClick: () => {
        try {
            onClick();
        }
        catch (e) {
            reportError('ui', `"${label}" failed`, e);
        }
    } }, h('div.PZ2QoL_dockBg'), icon(iconName, 'brown', 'dock'), tip);
    b.addEventListener('mouseenter', () => setClass(b, 'hover', true));
    b.addEventListener('mouseleave', () => setClass(b, 'hover', false));
    b.__tip = tip;
    return b;
}

function closeCard() {
    if (!card) return;
    card.remove();
    card = null;
    setClass(saveBtn, 'on', false);
}

function toggleCard() {
    if (card) return closeCard();
    card = autosaveCard(closeCard);
    document.body.appendChild(card);
    setClass(saveBtn, 'on', true);
    sync();
}

function build() {
    boardBtn = roundButton('IconAnimals', 'Species board', toggleBoard);
    saveBtn = roundButton('save', 'Autosave', toggleCard);
    saveBadge = h('div.PZ2QoL_dockBadge');
    saveBtn.appendChild(saveBadge);
    dock = h('div.PZ2QoL_dock', null, h('div.PZ2QoL_dockPanel'), saveBtn, boardBtn);
    document.body.appendChild(dock);
    document.addEventListener('click', e => {
        if (card && !card.contains(e.target) && !saveBtn.contains(e.target)) closeCard();
    });
    document.addEventListener('keydown', e => {
        if (card && (e.key === 'Escape' || e.keyCode === 27)) {
            e.stopPropagation();
            closeCard();
        }
    }, true);
}

function visibleBox(node) {
    if (!node) return null;
    for (let n = node; n && n != document.body; n = n.parentNode) {
        if (n.classList && (n.classList.contains('hidden') || n.classList.contains('displayNone'))) return null;
    }
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
}

function sync() {
    if (!dock) return;
    const sum = getAutosaveSummary();
    if (sum) {
        setText(saveBadge, sum.short);
        saveBadge.dataset.tone = sum.tone;
        setText(saveBtn.__tip, `${sum.title} · ${sum.detail}`);
    }
    let open = false;
    try {
        open = !!(boardModule && boardModule.isSpeciesBoardOpen && boardModule.isSpeciesBoardOpen());
    }
    catch (e) {
        open = false;
    }
    setClass(boardBtn, 'on', open);
    if (card && card.__sync) card.__sync();
}

function place() {
    const tools = visibleBox(document.querySelector('.ToolsBar_root'));
    if (!tools) {
        dock.style.display = 'none';
        closeCard();
        return;
    }
    dock.style.display = 'flex';
    // just above the tools column, same left edge
    dock.style.left = `${Math.round(tools.left)}px`;
    dock.style.top = '';
    dock.style.bottom = `${Math.round(window.innerHeight - tools.top)}px`;
    // the alert buttons above grow downwards: keep clear of them
    const alerts = visibleBox(document.querySelector('.NotificationsModule_buttons'));
    const room = alerts ? tools.top - alerts.bottom - 4 : Infinity;
    setClass(saveBtn, 'displayNone', false);
    setClass(dock, 'displayNone', false);
    if (dock.getBoundingClientRect().height > room) {
        setClass(saveBtn, 'displayNone', true);
        if (dock.getBoundingClientRect().height > room) setClass(dock, 'displayNone', true);
    }
    if (card) {
        const r = saveBtn.getBoundingClientRect();
        if (r.height <= 0) return closeCard();
        card.style.left = `${Math.round(r.right + 14)}px`;
        card.style.bottom = `${Math.round(Math.max(8, window.innerHeight - r.bottom - 6))}px`;
    }
}

let installed = false;
export function installHudLauncher() {
    if (installed) return true;
    // the park HUD page only
    if (!/PZ2QoLHUD/i.test(String(window.location && window.location.pathname))) return true;
    installed = true;
    installAutosave();
    build();
    onAutosave(() => sync());
    setInterval(() => {
        try {
            place();
            sync();
        }
        catch (e) {
            reportError('ui', 'HUD launcher failed', e, { silent: true });
        }
    }, TICK_MS);
    return true;
}
