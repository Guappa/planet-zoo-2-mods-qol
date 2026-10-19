// Species names as the game shows them, in the player's game language
// (Kin setting gameSpeciesNames, on by default). A local lookup in the game's
// text tables: nothing is sent or stored. Falls back to the internal name.
// Idea: salula1986 (Nexus).
import { translate, doesTextSymbolExist } from '/js/common/core/Localisation.js';
import { getKinSettings } from '/js/mods/pz2qol/kin.js';
import { reportError } from '/js/mods/pz2qol/errors.js';
import { createSpeciesNamer, plainSpeciesName, speciesId } from '/js/mods/pz2qol/speciesnamecore.js';

const GAME_LOC = {
    exists: id => doesTextSymbolExist(id) === true,
    translate: s => translate(s),
};

const namer = createSpeciesNamer({
    loc: GAME_LOC,
    enabled: () => {
        try {
            return getKinSettings().gameSpeciesNames !== false;
        }
        catch (e) {
            return true;
        }
    },
    onFail: e => reportError('ui', 'Species names: the game\'s translation failed; showing internal names', e, { silent: true }),
});

// "[Animal_RedPanda]" / "RedPanda" -> the game's name for it, or "RedPanda".
export function speciesName(s) {
    return namer(s);
}

export { plainSpeciesName, speciesId };

// Harness only: a fake { exists, translate } (the harness has no loc files);
// null puts the game's back.
export function _setSpeciesLocaliserForTests(loc) {
    namer.setLoc(loc || GAME_LOC);
}
