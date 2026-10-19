// Boxed with no destination (pure, no DOM): an animal sitting in its
// transport box with no transport job, outside any habitat. The game only
// warns after a long time (AnimalBoxedOutsideOfHabitatForProlongedTime);
// kinboxed.js warns after a few seconds.
//
// Which location types such an animal has is a guess (offline: arrivals may
// be "escaped and boxed"), so every type but these counts:
//   habitat     in a habitat (its box is being opened, or it is placed)
//   vet         at the vet
//   quarantine  in quarantine
//   transit     being carried
//   trade       waiting at the trade centre (only with boxedIncludeTrade)
export const BOXED_AFTER_CHOICES = [5, 10, 30, 60];
const NOT_WAITING = new Set(['habitat', 'vet', 'quarantine', 'transit']);

export function isBoxedWaiting(a, settings = {}) {
    if (!a || !a.boxed || a.moving || a.alive === false || a.exhibit) return false;
    if (a.hab) return false;
    const lt = a.lt || '';
    if (lt === 'trade') return !!settings.boxedIncludeTrade;
    return !NOT_WAITING.has(lt);
}

export function boxedAfterMs(settings = {}) {
    const s = Number(settings.boxedAfterS);
    return (s > 0 ? s : 10) * 1000;
}

// One scan: which boxed animals are due an alert now.
//   state: Map(animal id -> { first, alerted }), kept between scans
//   -> { due: [{ animal, waitedMs }], wake: ms until the next one is due, or null }
// An animal is alerted once, and again only after it stopped waiting.
export function boxedStep(model, settings, state, now) {
    const due = [];
    let wake = null;
    const live = new Set();
    const on = settings && settings.boxedAlert !== false;
    if (model && model.scope === 'park' && on) {
        const after = boxedAfterMs(settings);
        for (const a of model.animals.values()) {
            if (!isBoxedWaiting(a, settings)) continue;
            live.add(a.id);
            let s = state.get(a.id);
            if (!s) state.set(a.id, s = { first: now, alerted: false });
            if (s.alerted) continue;
            const left = s.first + after - now;
            if (left <= 0) {
                s.alerted = true;
                due.push({ animal: a, waitedMs: now - s.first });
            }
            else {
                wake = wake == null ? left : Math.min(wake, left);
            }
        }
    }
    for (const id of Array.from(state.keys())) if (!live.has(id)) state.delete(id);
    return { due, wake };
}

// "12 s", "2 min"
export function waitedText(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}
