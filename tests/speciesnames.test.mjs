import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeciesNamer, plainSpeciesName, speciesId } from '../mods/PZ2QoL/UI/UIGameface/js/mods/pz2qol/speciesnamecore.js';

// A fake of the game's Localisation.js: exists() takes ids without brackets,
// translate() bracketed symbols.
function fakeLoc(dict, extra = {}) {
    const calls = { exists: [], translate: [] };
    const loc = {
        exists(id) {
            calls.exists.push(id);
            return Object.prototype.hasOwnProperty.call(dict, id);
        },
        translate(sym) {
            calls.translate.push(sym);
            const m = /^\[(.*)\]$/.exec(sym);
            return m && Object.prototype.hasOwnProperty.call(dict, m[1]) ? dict[m[1]] : sym;
        },
    };
    return Object.assign(loc, extra, { calls });
}

test('speciesId', () => {
    assert.equal(speciesId('[Animal_Warthog_Common]'), 'Warthog_Common');
    assert.equal(speciesId('Animal_Warthog_Common'), 'Warthog_Common');
    assert.equal(speciesId('Warthog_Common'), 'Warthog_Common');
    assert.equal(speciesId('Lion'), 'Lion');
    assert.equal(speciesId(''), '');
    assert.equal(speciesId(null), '');
    assert.equal(speciesId(undefined), '');
});

test('plainSpeciesName: the internal name, as before', () => {
    assert.equal(plainSpeciesName('Warthog_Common'), 'Warthog Common');
    assert.equal(plainSpeciesName('[Animal_RedPanda]'), 'RedPanda');
    assert.equal(plainSpeciesName(''), 'Unknown species');
    assert.equal(plainSpeciesName(null), 'Unknown species');
});

test('the game name: exists without brackets, translate with', () => {
    const loc = fakeLoc({ Animal_Warthog_Common: 'Warzenschwein' });
    const name = createSpeciesNamer({ loc });
    assert.equal(name('Warthog_Common'), 'Warzenschwein');
    assert.deepEqual(loc.calls.exists, ['Animal_Warthog_Common']);
    assert.deepEqual(loc.calls.translate, ['[Animal_Warthog_Common]']);
});

test('a bracketed symbol is translated directly, even when exists says no', () => {
    const loc = fakeLoc({ Animal_Lion: 'Löwe' }, { exists() { return false; } });
    const name = createSpeciesNamer({ loc });
    assert.equal(name('[Animal_Lion]'), 'Löwe');
});

test('fallbacks to the internal name', () => {
    assert.equal(createSpeciesNamer({ loc: fakeLoc({}) })('Warthog_Common'), 'Warthog Common');
    assert.equal(createSpeciesNamer({ loc: fakeLoc({ Animal_Lion: '' }) })('Lion'), 'Lion');
    assert.equal(createSpeciesNamer({ loc: fakeLoc({ Animal_Lion: '   ' }) })('Lion'), 'Lion');
    assert.equal(createSpeciesNamer({ loc: fakeLoc({ Animal_Lion: '[Animal_Lion]' }) })('Lion'), 'Lion');
    assert.equal(createSpeciesNamer({ loc: fakeLoc({ Animal_Lion: '!Animal_Lion!' }) })('Lion'), 'Lion');
    assert.equal(createSpeciesNamer({ loc: fakeLoc({ Animal_Lion: '!Animal_Lion!' }) })('[Animal_Lion]'), 'Lion');
    assert.equal(createSpeciesNamer({ loc: null })('Red_Panda'), 'Red Panda');
    assert.equal(createSpeciesNamer({ loc: fakeLoc({}) })(''), 'Unknown species');
});

test('a throwing localiser: internal names, onFail once', () => {
    const fails = [];
    const loc = { exists() { return true; }, translate() { throw new TypeError('not ready'); } };
    const name = createSpeciesNamer({ loc, onFail: e => fails.push(e) });
    assert.equal(name('Lion'), 'Lion');
    assert.equal(name('Zebra'), 'Zebra');
    assert.equal(name('[Animal_Lion]'), 'Lion');
    assert.equal(fails.length, 1);
    assert.ok(fails[0] instanceof TypeError);
    // a throwing onFail never breaks a name
    const name2 = createSpeciesNamer({ loc, onFail: () => { throw new Error('x'); } });
    assert.equal(name2('Lion'), 'Lion');
});

test('switched off: internal names, the localiser is never asked', () => {
    const loc = fakeLoc({ Animal_Lion: 'Löwe' });
    let on = false;
    const name = createSpeciesNamer({ loc, enabled: () => on });
    assert.equal(name('Lion'), 'Lion');
    assert.equal(name('[Animal_Lion]'), 'Lion');
    assert.equal(loc.calls.exists.length + loc.calls.translate.length, 0);
    on = true;
    assert.equal(name('Lion'), 'Löwe');
    on = false;
    assert.equal(name('Lion'), 'Lion', 'the cache does not override the switch');
});

test('caching: one lookup per species; setLoc clears it', () => {
    const loc = fakeLoc({ Animal_Lion: 'Löwe' });
    const name = createSpeciesNamer({ loc });
    assert.equal(name('Lion'), 'Löwe');
    assert.equal(name('Lion'), 'Löwe');
    assert.equal(name('[Animal_Lion]'), 'Löwe');
    assert.equal(loc.calls.translate.length, 1);
    const loc2 = fakeLoc({ Animal_Lion: 'Lion d\'Afrique' });
    name.setLoc(loc2);
    assert.equal(name('Lion'), 'Lion d\'Afrique');
    name.setLoc(null);
    assert.equal(name('Lion'), 'Lion');
});

test('a failed lookup is not cached (called before the game is ready, then retried)', () => {
    let ready = false;
    const loc = {
        exists() { if (!ready) throw new TypeError('_impl undefined'); return true; },
        translate() { return 'Löwe'; },
    };
    const name = createSpeciesNamer({ loc });
    assert.equal(name('Lion'), 'Lion');
    ready = true;
    assert.equal(name('Lion'), 'Löwe');
    // a missing name is not cached either
    const dict = {};
    const name2 = createSpeciesNamer({ loc: fakeLoc(dict) });
    assert.equal(name2('Lion'), 'Lion');
    dict.Animal_Lion = 'Löwe';
    assert.equal(name2('Lion'), 'Löwe');
});
