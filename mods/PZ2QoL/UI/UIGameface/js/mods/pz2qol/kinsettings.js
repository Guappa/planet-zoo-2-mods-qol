// Every Kin setting, once: its default (kin.js keeps the player's changes
// from these) and where the Kin planner's Settings show it (section, sub,
// label, tip, the choices of a pick-one setting, the setting it needs on).
// The popover is drawn from this table, in its order: a new setting is one
// entry here. Pure (node tests). A setting with no section has no switch.
import { DEFAULT_CLOSE_KINSHIP } from './kincore.js';
import { BOXED_AFTER_CHOICES } from './kinboxedcore.js';

export const KIN_SETTINGS = Object.freeze([
    // badges, filters and panels
    { key: 'enabled', default: true },
    {
        key: 'alerts', default: true, section: 'Alerts', label: 'New inbreeding risks',
        tip: 'A message when a related pair becomes able to breed (an animal grows up, moves in, or stops contraception)',
    },
    {
        key: 'alertKin', default: false, section: 'Alerts', label: 'Close kin too', needs: 'alerts',
        tip: 'Also alert for close relatives the game does not warn about (cousins, grandparents...)',
    },
    {
        key: 'alertLife', default: false, section: 'Alerts', label: 'Animals growing up',
        tip: 'A note when a young animal will grow up into a problem: group too big, pushed out of its group, or an inbreeding risk. Nothing when it is fine.',
    },
    {
        key: 'toastLevel', default: 'action', section: 'Alerts', label: 'Pop up for',
        choices: [
            { value: 'action', label: 'Needs you', tip: 'Only notices that need you to act pop up; the rest go to the notice log' },
            { value: 'heads', label: 'Heads-up too', tip: 'Heads-ups pop up as well' },
        ],
    },
    {
        key: 'boxedAlert', default: true, section: 'Alerts', label: 'Boxed with nowhere to go',
        tip: 'A Needs-you alert when an animal waits in its transport box with no destination (the game only warns after a long time)',
    },
    {
        key: 'boxedAfterS', default: 10, section: 'Alerts', needs: 'boxedAlert',
        choices: BOXED_AFTER_CHOICES.map(sec => ({ value: sec, label: sec < 60 ? `${sec} s` : `${sec / 60} min`, tip: `Alert after ${sec} seconds in the box` })),
    },
    {
        key: 'boxedIncludeTrade', default: false, section: 'Alerts', label: 'Trade centre too', needs: 'boxedAlert',
        tip: 'Also alert for animals waiting boxed at the trade centre (off: they are expected to wait there)',
    },
    {
        key: 'releaseBoxed', default: true, section: 'Alerts', label: 'Let out stuck aquarium animals',
        tip: "The game sometimes boxes aquarium animals and never lets them out. On: the mod unboxes them after 30 s, one at a time, as the Unbox button does (Franchise too). Off: the game's own behaviour.",
    },
    {
        key: 'quarantineSick', default: true, section: 'Trade centre', label: 'Quarantine sick animals first',
        tip: "When the mod sends an infected or injured animal to the trade centre (a plan, Thin out, the Breeding programme), it goes to a quarantine first: the market won't take a sick animal, and the quarantine gets it treated. When it passes, a notice offers to send it on.",
    },
    {
        key: 'showCovered', default: true, section: 'Show', label: 'Covered pairs',
        tip: 'Related pairs kept apart by contraception or infertility',
    },
    {
        key: 'bondHolds', default: true, section: 'Show', label: 'Pair bonds count as protection',
        tip: 'A related pair the game will not let breed because one of them is bonded to another mate (monogamy) shows as Bonded elsewhere, not as a risk. It becomes a risk again when the bond ends.',
    },
    {
        key: 'gameSpeciesNames', default: true, section: 'Names', label: "Species names in the game's language",
        tip: "On: species names as the game shows them, in your game language. Off: the game's internal species names (e.g. Warthog Common), the same in every language.",
    },
    {
        key: 'closeKinship', default: DEFAULT_CLOSE_KINSHIP, section: 'Close kin from',
        note: 'Kinship at or above this counts as close kin. 1/16 is first cousins.',
        choices: [
            { value: 1 / 8, label: '1/8', tip: 'Only half-siblings, grandparents, full aunts and uncles and closer' },
            { value: 1 / 16, label: '1/16', tip: 'Also first cousins, great-grandparents, half aunts and uncles (default)' },
            { value: 1 / 32, label: '1/32', tip: 'Also half cousins and other more distant relatives' },
        ],
    },
    // Species board: run a whole staged plan in a Franchise zoo (or when the
    // mode is unknown); single moves are always one click
    { key: 'allowPlansOnline', default: false },
].map(s => Object.freeze(s)));

export const DEFAULT_KIN_SETTINGS = Object.freeze(Object.fromEntries(KIN_SETTINGS.map(s => [s.key, s.default])));

// Is `value` this choice? (the close-kin line is a fraction)
export function isChoice(value, choice) {
    return typeof choice === 'number' ? Math.abs(Number(value) - choice) < 1e-9 : value === choice;
}
