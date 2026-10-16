// Browser-harness scenario: fertility over an animal's life. The Lion
// father of the kin fixture is made old and infertile (elderly), the
// mother is in her last fertile years. Checks: the father/daughter pair is
// "covered" with the reason, the Species board shows "too old" and the
// fertile-years tag, the kin card says why, and the father is no breeder
// for Suggest fixes. Restores the fixture afterwards.
import { seedZooKin } from './kin_fixture.mjs';

export const name = 'fertility';

const BOARD = '/js/mods/pz2qol/kinboard.js';

export async function hud(page, ctx) {
    const facts = {};
    const problems = [];
    await seedZooKin(page);
    const ids = await page.evaluate(async () => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const snap = JSON.parse(JSON.stringify(window.__kinFixture.snapshot));
        const lions = window.__kinFixture.layout.filter(l => l.species === 'Lion');
        const dad = lions.find(l => l.n === 0), mum = lions.find(l => l.n === 1), daughter = lions.find(l => l.n === 3);
        snap.speciesFacts = { Lion: { maturity: 3, infertility: 15, life: 20 } };
        for (const a of snap.animals) {
            if (a.species !== 'Lion') continue;
            a.age = a.juv ? 1 : 6;
            a.ageQ = a.juv ? 0 : 2;
            if (a.id === dad.id) Object.assign(a, { age: 16.5, ageQ: 3, infertile: true });
            if (a.id === mum.id) Object.assign(a, { age: 13.6 });
        }
        kin.applyKinSnapshot(snap);
        return { dad: dad.id, mum: mum.id, daughter: daughter.id };
    });
    facts.ids = ids;
    facts.pair = await page.evaluate(async ({ dad, daughter }) => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const m = kin.getKinModel();
        const p = (m.byAnimal.get(dad) || []).find(x => x.a.id === daughter || x.b.id === daughter);
        return p ? { severity: p.severity, cover: p.cover } : null;
    }, ids);
    if (!facts.pair || facts.pair.severity !== 'covered' || !/too old to breed/.test(facts.pair.cover || '')) problems.push('old father x daughter not covered with the reason: ' + JSON.stringify(facts.pair));
    // the kin card of the daughter says why
    facts.card = await page.evaluate(async ({ daughter }) => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const ui = await import('/js/mods/pz2qol/kinui.js');
        const m = kin.getKinModel();
        const el = ui.animalCardContent(m, m.animals.get(daughter), { pinned: true });
        return el.textContent;
    }, ids);
    if (!/too old to breed/.test(facts.card)) problems.push('kin card does not say the father is too old: ' + facts.card.slice(0, 200));
    facts.dadCard = await page.evaluate(async ({ dad }) => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const ui = await import('/js/mods/pz2qol/kinui.js');
        const m = kin.getKinModel();
        return ui.animalCardContent(m, m.animals.get(dad), { pinned: true }).querySelector('.PZ2QoL_cardSubtitle').textContent;
    }, ids);
    if (!/elderly/.test(facts.dadCard) || !/too old to breed/.test(facts.dadCard)) problems.push('father card subtitle: ' + facts.dadCard);
    // Species board tags
    await page.evaluate(async url => (await import(url)).openSpeciesBoard({ species: 'Lion' }), BOARD);
    await page.waitForTimeout(700);
    facts.tags = await page.evaluate(() => [...document.querySelectorAll('.PZ2QoL_kb .PZ2QoL_kbTag')].map(t => t.className.replace('PZ2QoL_kbTag', '').trim() + ':' + t.textContent.trim()));
    if (!facts.tags.some(t => t === 'old:too old')) problems.push('board has no "too old" tag: ' + JSON.stringify(facts.tags));
    if (!facts.tags.some(t => /^ending:1y fertile$/.test(t))) problems.push('board has no fertile-years tag: ' + JSON.stringify(facts.tags));
    await ctx.shot(page, 'kf_1_board');
    facts.breeders = await page.evaluate(async ({ dad, mum }) => {
        const kin = await import('/js/mods/pz2qol/kin.js');
        const core = await import('/js/mods/pz2qol/kinboardcore.js');
        const m = kin.getKinModel();
        return { dad: core.fertileAdult(m.animals.get(dad)), mum: core.fertileAdult(m.animals.get(mum)) };
    }, ids);
    if (facts.breeders.dad !== false || facts.breeders.mum !== true) problems.push('breeders: ' + JSON.stringify(facts.breeders));
    await page.evaluate(async url => (await import(url)).closeSpeciesBoard(), BOARD);
    // back to the plain fixture for later scenarios
    await page.evaluate(async () => (await import('/js/mods/pz2qol/kin.js')).applyKinSnapshot(window.__kinFixture.snapshot));
    facts.problems = problems;
    if (problems.length) throw new Error('fertility: ' + problems.join('; '));
    return facts;
}
