// Is something of the game's own on top of the screen our fixed toolbars
// float over? Our bars live under <body> with a z-index, so they paint over
// the game's Layer collection (its modals and dropdowns) unless they step
// aside. True while any of these is open:
//  - a game popup (Compare Mates, Genealogy): .PopupActionsModule_root.show
//  - a darkened modal Layer (the hub's Zoopedia, Settings, Help, Save...)
//  - the Zoopedia itself (the park HUD shows it outside a Layer)
//  - a search box's suggestions (InputField_resultsMenu, e.g. Animal
//    Storage's species search; Nexus report 2026-10-20)
// No imports: node tests can load it.
function shown(node) {
    if (!node) return false;
    const r = node.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    for (let n = node; n && n !== document.body; n = n.parentNode) {
        if (n.classList && (n.classList.contains('hidden') || n.classList.contains('hideAllLayers'))) return false;
    }
    return true;
}

function anyShown(sel) {
    const list = document.querySelectorAll(sel);
    for (let i = 0; i < list.length; i++) {
        if (shown(list[i])) return true;
    }
    return false;
}

export function gameOnTop() {
    try {
        if (document.querySelector('.PopupActionsModule_root.show')) return true;
        return anyShown('.LayerCollection .Layer_background.darken')
            || anyShown('.ZoopediaModule_root')
            || anyShown('.InputField_resultsMenu');
    }
    catch (e) {
        return false;
    }
}
