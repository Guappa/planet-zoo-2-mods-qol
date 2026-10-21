// Stuck aquarium animals: the page side of PZ2QoL.BoxRelease. Lua finds
// aquarium animals the game boxed and never lets out, and unboxes them
// itself (hands-free, on by default; Kin setting releaseBoxed). This page
// sends the setting. A release shows nothing; only an animal that keeps
// getting boxed again gets a Needs-you alert (the mod then leaves it alone
// for 10 minutes of game time). HUD page only.
import { getKinSettings, locateAnimal, onKinSettings } from '/js/mods/pz2qol/kin.js';
import { kinToast } from '/js/mods/pz2qol/kinalerts.js';
import { isHudPage } from '/js/mods/pz2qol/kinhooks.js';
import { speciesName } from '/js/mods/pz2qol/speciesnames.js';
import { breadcrumb, reportError } from '/js/mods/pz2qol/errors.js';

let lastSent = null;

export function releaseOn(settings = getKinSettings()) {
    return !settings || settings.releaseBoxed !== false;
}

function sendSetting(force) {
    const on = releaseOn();
    if (!force && on === lastSent) return;
    lastSent = on;
    try {
        breadcrumb('release_set');
        engine.trigger('PZ2QoL_ReleaseSet', on);
    }
    catch (e) {
        reportError('ui', 'Stuck aquarium animals: could not reach the game', e, { silent: true });
    }
}

// Only 'gaveup' shows anything: a release itself is silent (developer,
// 2026-10-19).
export function releaseToast(kind, id, species, count) {
    if (kind !== 'gaveup') return null;
    const name = species ? speciesName(species) : 'An animal';
    return {
        severity: 'risk',
        level: 'action',
        kind: 'boxed',
        title: `${name} keeps getting boxed`,
        text: `The game boxed it again right after the mod let it out (${count} times). The mod leaves it for 10 minutes of game time. Its spot in the aquarium may be too tight: check the scenery and the water depth around it.`,
        species,
        actions: [{ label: 'Locate', icon: 'IconLocation', primary: true, run: () => locateAnimal(id) }],
    };
}

export function installBoxRelease() {
    if (!isHudPage()) return true;
    engine.on('PZ2QoL_ReleaseEvent', (kind, id, species, count) => {
        try {
            breadcrumb('release_event');
            const t = releaseToast(String(kind), id, String(species || ''), Number(count) || 0);
            if (t) kinToast(t);
        }
        catch (e) {
            reportError('mod', 'Stuck aquarium animals: notice failed', e, { silent: true });
        }
    });
    onKinSettings(() => sendSetting(false));
    // Lua starts on; tell it the player's choice now and whenever it comes up again
    engine.on('PZ2QoL_Hello', () => sendSetting(true));
    sendSetting(true);
    return true;
}
