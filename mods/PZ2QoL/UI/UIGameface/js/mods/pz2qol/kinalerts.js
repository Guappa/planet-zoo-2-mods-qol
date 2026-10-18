// Kin alerts: a toast when a pair becomes an inbreeding risk (a youngster
// grows up next to its sibling, an animal moves in with its father,
// contraception is lifted...). The game's own warning only comes once the
// animals have mated; this one comes within a scan (~20 s) of the change.
// On the first scan of a park, one summary toast if there are risks already.
// Display only; the buttons do what the game's own controls do, one click
// one action.
import { getKinSettings, onKin, setContraception } from '/js/mods/pz2qol/kin.js';
import { newRisks, relationWord, SEVERITY_INFO, Sex, habitatsAtRisk } from '/js/mods/pz2qol/kincore.js';
import { sexSymbol, placeOf } from '/js/mods/pz2qol/kinui.js';
import { openKinPlanner } from '/js/mods/pz2qol/kinplanner.js';
import { isHudPage } from '/js/mods/pz2qol/kinhooks.js';
import { h, icon, setClass } from '/js/mods/pz2qol/ui.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';

const MAX_TOASTS = 3;
const TOAST_MS = 25000;

let root = null;
let previous = null;
let summaryShown = false;
// pair key -> last time it was a (watched) risk. A pair that drops out of
// one scan (an animal in transport, at the vet, a failed read) and comes
// back is not new; one that was safe for half an hour and is risky again is.
const seen = new Map();
const SEEN_MS = 30 * 60 * 1000;

function watchedNow(model, settings) {
    return model.pairs.filter(p => p.severity === 'risk' || (settings.alertKin && p.severity === 'kin'));
}

function remember(pairs, now) {
    for (const p of pairs) seen.set(p.key, now);
    if (seen.size > 5000) {
        for (const [k, t] of seen) if (now - t > SEEN_MS) seen.delete(k);
    }
}

function ensureRoot() {
    if (!root) {
        root = h('div.PZ2QoL_kinToasts');
        document.body.appendChild(root);
    }
    return root;
}

function toast({ severity, title, text, actions }) {
    ensureRoot();
    while (root.childNodes.length >= MAX_TOASTS) root.removeChild(root.firstChild);
    let timer = null;
    const close = () => {
        clearTimeout(timer);
        setClass(node, 'leaving', true);
        setTimeout(() => node.parentNode && node.parentNode.removeChild(node), 250);
    };
    const buttons = (actions || []).map(a => h(`div.PZ2QoL_kinAction${a.primary ? '.primary' : ''}`, {
        onClick: () => {
            try {
                a.run();
            }
            catch (e) {
                reportError('ui', `"${a.label}" failed`, e);
            }
            if (a.closes !== false) close();
        },
    }, a.icon ? icon(a.icon, a.primary ? 'white' : 'brown', 'xs') : null, h('span', { text: a.label })));
    const node = h(`div.PZ2QoL_kinToast.sev_${severity}`, null,
        h('div.PZ2QoL_kinToastStripe'),
        h('div.PZ2QoL_kinToastBody', null,
            h('div.PZ2QoL_kinToastHead', null, h('div.PZ2QoL_kinCardIcon'), h('div.PZ2QoL_kinToastTitle', { text: title }),
                h('div.PZ2QoL_kinToastClose', { text: '✕', title: 'Dismiss', onClick: close })),
            h('div.PZ2QoL_kinToastText', { text }),
            buttons.length ? h('div.PZ2QoL_kinActions', null, buttons) : null));
    node.addEventListener('mouseenter', () => clearTimeout(timer));
    node.addEventListener('mouseleave', () => {
        clearTimeout(timer);
        timer = setTimeout(close, TOAST_MS / 2);
    });
    timer = setTimeout(close, TOAST_MS);
    root.appendChild(node);
    breadcrumb('kin_alert');
    return node;
}

function pairText(model, p) {
    const word = relationWord(model.ped.relation(p.a.guid, p.b.guid), p.b.sex);
    const place = placeOf(model, p.a) || 'A habitat';
    return `${place}: ${p.b.name} ${sexSymbol(p.b.sex)} is ${p.a.name} ${sexSymbol(p.a.sex)}'s ${word}${p.mated ? ', and they are mates now' : ''}.`;
}

function pairToast(model, p) {
    const female = p.b.sex === Sex.Female ? p.b : p.a.sex === Sex.Female ? p.a : p.b;
    const actions = [
        { label: 'Show', icon: 'IconGenetics', primary: true, run: () => openKinPlanner({ habitatId: p.hab, animalId: p.a.id, pairKey: p.key }) },
    ];
    if (!female.contra) actions.push({ label: `Contraception for ${female.name}`, icon: 'Icon_Contracepted', run: () => setContraception(female.id, true) });
    const label = p.severity === 'risk' ? 'inbreeding risk' : SEVERITY_INFO[p.severity].label.toLowerCase();
    toast({
        severity: p.severity,
        // a pair bond kept them apart until now (newRisks sets bondEnded)
        title: p.bondEnded ? `Bond ended: ${label}` : `New ${label}`,
        text: pairText(model, p) + (p.bondEnded ? ' The pair bond that kept them apart has ended.' : '')
            + (p.tier === 'game' ? '' : ' The game does not warn about this pair.'),
        actions,
    });
}

function summaryToast(model) {
    const habitats = habitatsAtRisk(model).filter(h => h.counts.risk > 0);
    const n = model.counts.risk;
    toast({
        severity: 'risk',
        title: 'Kin check',
        text: `${n} related pair${n > 1 ? 's' : ''} could inbreed in ${habitats.length} habitat${habitats.length > 1 ? 's' : ''}${habitats.length ? ` (${habitats.slice(0, 3).map(h => h.name).join(', ')}${habitats.length > 3 ? ', …' : ''})` : ''}.`,
        actions: [{ label: 'Open kin planner', icon: 'IconGenetics', primary: true, run: () => openKinPlanner({}) }],
    });
}

function onModel(model) {
    const settings = getKinSettings();
    try {
        if (!model || model.scope !== 'park') {
            if (!model) previous = null;
            return;
        }
        const now = Date.now();
        const watched = watchedNow(model, settings);
        if (!settings.alerts) {
            remember(watched, now);
            return;
        }
        if (!previous) {
            remember(watched, now);
            if (!summaryShown && model.counts.risk > 0) {
                summaryShown = true;
                summaryToast(model);
            }
            return;
        }
        const fresh = newRisks(previous, model, { includeKin: settings.alertKin }).filter(p => {
            const t = seen.get(p.key);
            return t == null || now - t > SEEN_MS;
        });
        remember(watched, now);
        if (fresh.length > MAX_TOASTS) {
            toast({
                severity: 'risk',
                title: `${fresh.length} new related pairs`,
                text: 'Several animals can now breed with a relative.',
                actions: [{ label: 'Open kin planner', icon: 'IconGenetics', primary: true, run: () => openKinPlanner({}) }],
            });
        }
        else {
            for (const p of fresh) pairToast(model, p);
        }
    }
    catch (e) {
        reportError('mod', 'Kin alert failed', e, { silent: true });
    }
    finally {
        if (model && model.scope === 'park') previous = model;
    }
}

// For the browser harness.
export function kinAlertCount() {
    return root ? root.childNodes.length : 0;
}

export function installKinAlerts() {
    if (!isHudPage()) return true;
    // stay out of the way of the game's popups (Compare Mates, Genealogy)
    setInterval(() => {
        if (root) setClass(root, 'underPopup', !!document.querySelector('.PopupActionsModule_root.show'));
    }, 500);
    onKin((model, scope) => {
        if (scope && scope !== 'park') return;
        onModel(model);
    });
    return true;
}
