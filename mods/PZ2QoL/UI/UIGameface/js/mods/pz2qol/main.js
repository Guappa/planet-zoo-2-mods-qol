// PZ2QoL UI entry. Loaded by PZ2QoLFrontend.html after the game's own
// Frontend.js, so it shares the game's module instances.
import { loadCSS } from '/js/common/util/CSSUtil.js';
import { breadcrumb, installErrorCapture, reportError } from '/js/mods/pz2qol/errors.js';
import { installDebugLog } from '/js/mods/pz2qol/debuglog.js';
import { installListFilter, installSelectAllGuard } from '/js/mods/pz2qol/listfilter.js';
import { installBadges } from '/js/mods/pz2qol/badges.js';
import { installBars } from '/js/mods/pz2qol/bars.js';
import { installPriceBook } from '/js/mods/pz2qol/pricebook.js';
import { installLister } from '/js/mods/pz2qol/lister.js';
import { installZoo } from '/js/mods/pz2qol/zoo.js';
import { installKin } from '/js/mods/pz2qol/kin.js';
import { installKinZoo } from '/js/mods/pz2qol/kinzoo.js';
import { installKinPanels } from '/js/mods/pz2qol/kinhabitat.js';
import { installKinMates } from '/js/mods/pz2qol/kinmates.js';
import { installKinStorage } from '/js/mods/pz2qol/kinstorage.js';
import { installKinPlanner } from '/js/mods/pz2qol/kinplanner.js';
import { installKinAlerts } from '/js/mods/pz2qol/kinalerts.js';
import { installBoxedAlerts } from '/js/mods/pz2qol/kinboxed.js';
import { installQuarantineAlerts } from '/js/mods/pz2qol/kinquarantine.js';
import { installHudLauncher } from '/js/mods/pz2qol/hudlauncher.js';
import { installStorageSend } from '/js/mods/pz2qol/storagesend.js';
import { installTradeJump } from '/js/mods/pz2qol/tradejump.js';
import { installStorageFetch } from '/js/mods/pz2qol/storagefetch.js';

export const VERSION = '3.0.0';

// Debug builds: tell Lua how far the page got (written to dbg/trace.log).
const trace = breadcrumb;
trace('main_start');

function step(name, fn) {
    trace('step_' + name.replace(/[^A-Za-z]/g, ''));
    try {
        const ok = fn();
        if (ok === false) {
            reportError('mod', `${name} not installed`, 'The game UI did not look as expected; this feature is off.', { silent: true });
        }
    }
    catch (e) {
        reportError('mod', `${name} failed to start`, e);
    }
}

step('Error capture', installErrorCapture);
// debug builds: the detailed log (dbg/trace.log); a no-op otherwise
step('Debug log', installDebugLog);
step('Styles', () => {
    loadCSS('mods/pz2qol');
    loadCSS('mods/pz2qol_kin');
    loadCSS('mods/pz2qol_kinplanner');
    loadCSS('mods/pz2qol_kinmates');
    loadCSS('mods/pz2qol_hud');
});
step('Storage filters', installListFilter);
step('Select-all guard', installSelectAllGuard);
step('Score badges', installBadges);
step('Toolbars', installBars);
step('Price book', installPriceBook);
step('Market lister', installLister);
step('Zoo animal filters', installZoo);
// Kin: relatedness and inbreeding risk
step('Kin data', installKin);
step('Kin in zoo management', installKinZoo);
step('Kin in info panels', installKinPanels);
step('Kin in Compare Mates and Genealogy', installKinMates);
step('Kin in Animal Storage', installKinStorage);
step('Kin planner', installKinPlanner);
step('Kin alerts', installKinAlerts);
step('Boxed animal alerts', installBoxedAlerts);
step('Quarantine notices', installQuarantineAlerts);
// in the park: one-click Species board and the autosave control
step('Park launcher', installHudLauncher);
step('Find a habitat', installStorageSend);
// Species board / Kin planner -> the hub's Animal Storage or Market for one species
step('Trade shortcuts', installTradeJump);
step('Bring to the trade centre', installStorageFetch);
// Species board: loaded on its own, so a missing or broken board never
// stops the rest of the mod
step('Species board', () => {
    import('/js/mods/pz2qol/kinboard.js')
        .then(m => {
            loadCSS('mods/pz2qol_kinboard');
            if (m.installSpeciesBoard() === false) reportError('mod', 'Species board not installed', 'The game UI did not look as expected.', { silent: true });
        })
        .catch(e => reportError('mod', 'Species board failed to start', e));
});
// Market desk: list many storage animals at once (its own module, so a
// broken desk never stops the rest of the mod)
step('Market desk', () => {
    import('/js/mods/pz2qol/marketdesk.js')
        .then(m => {
            loadCSS('mods/pz2qol_marketdesk');
            if (m.installMarketDesk() === false) reportError('mod', 'Market desk not installed', 'The game UI did not look as expected.', { silent: true });
        })
        .catch(e => reportError('mod', 'Market desk failed to start', e));
});
document.body.classList.add('PZ2QoL');
console.log(`[PZ2QoL] UI v${VERSION} loaded`);
trace('main_done');
setTimeout(() => trace('tick_1s'), 1000);
setTimeout(() => trace('tick_10s'), 10000);
// proves the page was alive up to the last line before a crash
setInterval(() => trace('heartbeat'), 10000);
