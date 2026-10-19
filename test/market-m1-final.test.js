// Market radar M1 FINAL: generic facets (size, variant, model) with "Autre" free text and "Je ne sais pas", strict separation of exact / probable / similar, statistics per class AND per homogeneous group (never mixed),
// EXACT only when every determining trait is verified, lots / accessories / other brands out of the reference prices (but listed, with a per-piece ESTIMATE for lots), the 3-listing threshold, and the eight scenarios
// asked by the owner. Real data: test/fixtures/market-hydroflask-53.json is a reduced copy of 53 REAL Belgian listings (Google Shopping, 19/10/2026). Nothing here is specific to a brand: the synthetic cases use "ACME".
// The provider is SIMULATED (fake fetch): these tests prove the rules and the cost behaviour, not the real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FLAG, MIN_COMPARABLE, analyseListings, packOf } from '../src/sourcing/adapters/market-radar.js';
import { MAX_QUESTIONS, analyseWithFacets, detectVariantFacet, parseCapacityText, proposeQuestion, refine, sanitizeConfirmed } from '../src/sourcing/adapters/market-refine.js';
import { createMarketRadar } from '../src/sourcing/server/market-radar-service.js';

const REAL = JSON.parse(readFileSync(new URL('./fixtures/market-hydroflask-53.json', import.meta.url), 'utf8'));
const ECB = { date: '2026-10-19', perEur: { USD: 1.1 } };
const L = (title, price, extra = {}) => ({ title, price, currency: price == null ? null : 'EUR', seller: 'Shop', url: `https://shop.example/${encodeURIComponent(title)}`, query: 'q', queryVia: 'nom', observedAt: '2026-10-19T12:00:00.000Z', ...extra });
const ACME_IN = { name: 'water bottle', brand: 'ACME', traits: {} }; // the case only says a brand and a CATEGORY
const WIDE = ['Black', 'Blue', 'Green', 'White'].map((c, i) => L(`ACME Wide Mouth insulated bottle 710 ml ${c}`, [62, 64, 60, 63][i]));
const STD = ['Black', 'Blue', 'Green', 'White'].map((c, i) => L(`ACME Standard Mouth insulated bottle 710 ml ${c}`, [46, 48, 45, 47][i]));
const BIG = [74, 75, 76].map((p, i) => L(`ACME Wide Mouth insulated bottle 946 ml v${i}`, p));
const EXTRA = [L('ACME Wide Mouth replacement cap lid', 14), L('6 pcs ACME Wide Mouth insulated bottle 710 ml', 330), L('ZETA Wide Mouth insulated bottle 710 ml', 40)];
const ACME = () => [...WIDE, ...STD, ...BIG, ...EXTRA];
const ACME_NAMED = { name: 'insulated bottle', brand: 'ACME', traits: {} }; // a case whose name carries real words: PROBABLE without any confirmation
const idsOf = (a, pred) => a.listings.filter(pred).map((r) => r.title);

test('F1 generic: a known brand + a CONFIRMED size + the same kind of product is a PROBABLE match even when the case name is only a category (no brand-specific word anywhere)', () => {
  const four = [L('ACME Wide Mouth 710 ml insulated bottle A', 55), L('ACME Wide Mouth 710 ml insulated bottle B', 56), L('ACME Wide Mouth 710 ml insulated bottle C', 57), L('ACME Wide Mouth 710 ml insulated bottle D', 58)];
  const r = refine({ listings: four, input: ACME_IN, confirmed: { capacityMl: 710 }, ecb: ECB });
  assert.equal(r.analysis.summary.probable, 4); assert.equal(r.analysis.reference.reliable, true); assert.equal(r.analysis.reference.count, 4); assert.equal(r.analysis.reference.matchClass, 'PROBABLE_MATCH');
  assert.match(r.analysis.listings[0].reason, /marque et taille vérifiées/);
});

test('S1 real data — brand + category name, size unknown: ONE size question from the titles actually observed, with evidence and price, nothing preselected, "Autre" and "Je ne sais pas" offered, and no price while it is pending', () => {
  const input = { name: 'water bottle', brand: 'Hydro Flask', traits: {} }; const { analysis, facet } = analyseWithFacets(REAL, input, { ecb: ECB });
  assert.equal(analysis.summary.exact, 0); assert.equal(analysis.summary.exactNone, true); assert.equal(analysis.reference.reliable, false);
  const q = proposeQuestion({ input, listings: REAL, facet }); assert.equal(q.id, 'capacity'); assert.equal(q.allowOther, true); assert.equal(q.unknownLabel, 'Je ne sais pas');
  assert.deepEqual(q.options.map((o) => o.value.capacityMl), [946, 1000]); assert.ok(q.options.every((o) => /vu dans \d+ annonce/.test(o.evidence) && /prix médian/.test(o.evidence) && o.selected === undefined));
});

test('S1 real data — confirming 946 ml gives ONE reliable PROBABLE group made only of real comparable listings; accessories, lots, promos and other brands are out but still listed', () => {
  const input = { name: 'water bottle', brand: 'Hydro Flask', traits: {} }; const r = refine({ listings: REAL, input, confirmed: { capacityMl: 946 }, ecb: ECB }); const a = r.analysis;
  assert.equal(a.listings.length, 53, 'nothing is removed'); assert.equal(a.reference.reliable, true); assert.equal(a.reference.count, 3); assert.equal(a.reference.matchClass, 'PROBABLE_MATCH'); assert.equal(a.reference.minEur, 30.95); assert.equal(a.reference.maxEur, 32.9);
  const inRef = a.listings.filter((x) => !x.excludedFromReference); assert.ok(inRef.every((x) => /hydro flask/i.test(x.title) && /946|32 ?oz/i.test(x.title)), inRef.map((x) => x.title).join(' | '));
  assert.ok(a.listings.filter((x) => /Nalgene/i.test(x.title)).every((x) => x.excludedFromReference && x.flags.includes(FLAG.BRAND_NOT_IN_TITLE)));
  assert.ok(a.listings.filter((x) => x.flags.includes(FLAG.PACK_OR_LOT)).every((x) => x.excludedFromReference)); assert.ok(a.listings.filter((x) => x.flags.includes(FLAG.ACCESSORY_SUSPECTED)).every((x) => x.excludedFromReference));
  assert.equal(r.question, null, 'one answer was enough');
});

test('S1 real data — a size with no comparable listing (473 ml, or a typed 64 oz) is "Prix de référence non fiable": no median, no invented price', () => {
  const input = { name: 'water bottle', brand: 'Hydro Flask', traits: {} };
  for (const confirmed of [{ capacityMl: 473 }, { capacityText: '64 oz' }]) { const r = refine({ listings: REAL, input, confirmed, ecb: ECB }); assert.equal(r.analysis.reference.reliable, false); assert.equal(r.analysis.reference.medianEur, null); assert.equal(r.analysis.groups.length, 0); assert.match(r.analysis.reference.note, /aucune annonce comparable/); }
  assert.equal(sanitizeConfirmed({ capacityText: '64 oz' }).capacityMl, 1893);
});

test('S2 confirmed — size then variant (two questions at most, price-moving facets only), then ONE homogeneous reference; variants, sizes, lots, accessories, other brands never enter it', () => {
  const ls = ACME();
  const first = refine({ listings: ls, input: ACME_IN, confirmed: null, ecb: ECB, asked: 0 }); assert.equal(first.question.id, 'capacity'); assert.deepEqual(first.question.options.map((o) => o.value.capacityMl), [710, 946]);
  const second = refine({ listings: ls, input: ACME_IN, confirmed: { capacityMl: 710 }, ecb: ECB, asked: 1 }); assert.equal(second.question.id, 'variant'); assert.deepEqual(second.question.options.map((o) => o.label).sort(), ['Standard', 'Wide']); assert.ok(second.question.options.every((o) => /vu dans \d+ annonce.*prix médian/.test(o.evidence)));
  const wide = second.question.options.find((o) => o.label === 'Wide').value;
  const third = refine({ listings: ls, input: ACME_IN, confirmed: { capacityMl: 710, ...wide }, ecb: ECB, asked: 2 }); const a = third.analysis;
  assert.equal(third.question, null, `no third question (limit ${MAX_QUESTIONS})`); assert.equal(a.reference.reliable, true); assert.equal(a.reference.count, 4); assert.equal(a.reference.minEur, 60); assert.equal(a.reference.maxEur, 64); assert.equal(a.reference.medianEur, 62.5);
  const by = (t) => a.listings.find((x) => x.title === t); assert.ok(by('ACME Standard Mouth insulated bottle 710 ml Black').flags.includes(FLAG.VARIANT_DIFFERS)); assert.ok(by('ACME Wide Mouth insulated bottle 946 ml v0').flags.includes(FLAG.CAPACITY_DIFFERS));
  assert.ok(by('ACME Wide Mouth replacement cap lid').flags.includes(FLAG.ACCESSORY_SUSPECTED)); assert.ok(by('6 pcs ACME Wide Mouth insulated bottle 710 ml').flags.includes(FLAG.PACK_OR_LOT)); assert.ok(by('ZETA Wide Mouth insulated bottle 710 ml').flags.includes(FLAG.BRAND_NOT_IN_TITLE));
  assert.equal(a.listings.filter((x) => !x.excludedFromReference).length, 4); assert.equal(a.listings.length, 14);
});

test('S2/S6 "Je ne sais pas" on the variant: prices are given PER GROUP (one range for Wide, one for Standard), never one mixed median', () => {
  const r = refine({ listings: ACME(), input: ACME_IN, confirmed: { capacityMl: 710 }, ecb: ECB, asked: 2, declined: ['variant'] }); const a = r.analysis;
  assert.equal(a.groups.length, 2); assert.ok(a.groups.every((g) => g.reliable && g.count === 4)); const med = a.groups.map((g) => g.medianEur).sort((x, y) => x - y); assert.deepEqual(med, [46.5, 62.5]);
  assert.equal(a.reference.reliable, false); assert.equal(a.reference.multiple, true); assert.equal(a.reference.medianEur, null); assert.match(a.reference.note, /2 groupes distincts/);
  for (const g of a.groups) { const titles = g.ids.map((id) => a.listings.find((x) => x.id === id).title); assert.ok(titles.every((t) => (g.variant.key === 'wide') === /Wide/.test(t)), `group ${g.variant.key} is homogeneous`); }
});

test('S6 several sizes, "Je ne sais pas" on the size: one group PER size, never mixed', () => {
  const bare = refine({ listings: ACME(), input: ACME_IN, confirmed: null, ecb: ECB, asked: 1, declined: ['capacity', 'variant'] }).analysis; assert.equal(bare.groups.length, 0, 'a category-only name with no verified size is never promoted above SIMILAR'); assert.equal(bare.reference.reliable, false);
  const r = refine({ listings: ACME(), input: ACME_NAMED, confirmed: null, ecb: ECB, asked: 1, declined: ['capacity', 'variant'] }); const a = r.analysis;
  assert.ok(a.groups.length >= 2); for (const g of a.groups) { const sizes = new Set(g.ids.map((id) => Math.round(a.listings.find((x) => x.id === id).sizeMl / 10))); assert.equal(sizes.size, 1, 'one size per group'); }
});

test('S3 the photo reveals the MODEL: EXACT needs the model in the title; EXACT and PROBABLE statistics stay SEPARATE and the reference is the exact group only', () => {
  const ls = [L('ACME HF-710W Wide insulated bottle 710 ml', 20), L('ACME HF-710W insulated bottle', 22), L('ACME HF-710W Wide bottle 710ml', 24), L('ACME Wide water bottle 710 ml Black', 40), L('ACME Wide water bottle 710 ml Blue', 42), L('ACME Wide water bottle 710 ml Green', 44)];
  const input = { name: 'water bottle', brand: 'ACME', model: 'HF-710W', traits: {} }; const a = analyseWithFacets(ls, input, { ecb: ECB }).analysis;
  assert.equal(a.summary.exact, 3); assert.equal(a.summary.exactNone, false); const exact = a.groups.filter((g) => g.class === 'EXACT_MATCH'); const prob = a.groups.filter((g) => g.class === 'PROBABLE_MATCH');
  assert.equal(exact.length, 1); assert.equal(exact[0].medianEur, 22); assert.ok(prob.length >= 1 && prob.every((g) => g.medianEur !== 22)); assert.equal(a.reference.matchClass, 'EXACT_MATCH'); assert.equal(a.reference.medianEur, 22);
});

test('EXACT needs every determining trait verified: a variant the title states and the owner has not confirmed keeps the listing at PROBABLE until it is confirmed', () => {
  const mk = (v, n, p) => L(`ACME HF-710W ${v} insulated bottle 710 ml ${n}`, p); const ls = [mk('Wide', 'a', 62), mk('Wide', 'b', 63), mk('Wide', 'c', 64), mk('Standard', 'a', 46), mk('Standard', 'b', 47), mk('Standard', 'c', 48)];
  const input = { name: 'water bottle', brand: 'ACME', model: 'HF-710W', traits: {} };
  const before = analyseWithFacets(ls, input, { ecb: ECB }).analysis; assert.equal(before.summary.exact, 0); assert.ok(before.listings.every((x) => x.matchType === 'PROBABLE_MATCH' && /variante .* n’est pas confirmée/.test(x.reason)));
  const q = proposeQuestion({ input, listings: ls }); assert.equal(q.id, 'variant');
  const after = refine({ listings: ls, input, confirmed: { variant: q.options.find((o) => o.label === 'Wide').value.variant }, ecb: ECB }).analysis; assert.equal(after.listings.filter((x) => !x.excludedFromReference && x.matchType === 'EXACT_MATCH').length, 3); assert.equal(after.reference.matchClass, 'EXACT_MATCH'); assert.equal(after.reference.count, 3); assert.equal(after.reference.medianEur, 63);
});

test('S4 product without a recognised brand: never EXACT without a model, even with a confirmed size', () => {
  const ls = [L('Insulated steel bottle 500 ml blue', 12), L('Insulated steel bottle 500 ml red', 13), L('Insulated steel bottle 500 ml green', 14), L('Insulated steel bottle 500 ml black', 15)];
  const a = refine({ listings: ls, input: { name: 'insulated steel bottle', traits: {} }, confirmed: { capacityMl: 500 }, ecb: ECB }).analysis;
  assert.equal(a.summary.exact, 0); assert.equal(a.summary.exactNone, true); assert.ok(a.groups.every((g) => g.class !== 'EXACT_MATCH'));
});

test('S5 only accessories found: nothing is priced, nothing is invented, every listing stays visible and excluded', () => {
  const ls = [L('ACME replacement cap', 9), L('ACME straw lid', 11), L('ACME Wide Mouth flex cap', 14), L('ACME silicone boot sleeve', 12), L('ACME spare lid', 8)];
  const a = analyseListings(ls, ACME_IN, { ecb: ECB }); assert.equal(a.listings.length, 5); assert.ok(a.listings.every((x) => x.excludedFromReference && x.flags.includes(FLAG.ACCESSORY_SUSPECTED))); assert.equal(a.groups.length, 0);
  assert.equal(a.reference.reliable, false); assert.equal(a.reference.medianEur, null); assert.deepEqual(a.reference.pricesEur, []);
});

test('S7 no exact product found: said explicitly in the data, and no reference is ever labelled EXACT', () => {
  const a = analyseWithFacets(ACME(), ACME_IN, { ecb: ECB }).analysis; assert.equal(a.summary.exact, 0); assert.equal(a.summary.exactNone, true); assert.ok(a.groups.every((g) => g.class !== 'EXACT_MATCH')); assert.notEqual(a.reference.matchClass, 'EXACT_MATCH');
});

test('S8 refusal / no confirmation: nothing is filtered on a guess, results are grouped (not averaged), and the same facet is never asked again', () => {
  const r0 = refine({ listings: ACME(), input: ACME_IN, confirmed: null, ecb: ECB, asked: 0, declined: [] }); assert.equal(r0.question.id, 'capacity');
  const r1 = refine({ listings: ACME(), input: ACME_IN, confirmed: null, ecb: ECB, asked: 1, declined: ['capacity'] }); assert.equal(r1.question.id, 'variant');
  const r2 = refine({ listings: ACME(), input: ACME_IN, confirmed: null, ecb: ECB, asked: 2, declined: ['capacity', 'variant'] }); assert.equal(r2.question, null);
  for (const r of [r0, r1, r2]) assert.equal(r.confirmed, null);
  const plain = analyseListings(ACME(), ACME_IN, { ecb: ECB }); assert.deepEqual(r2.analysis.listings.map((x) => x.excludedFromReference), plain.listings.map((x) => x.excludedFromReference).map((x, i) => (r2.analysis.listings[i].excludedFromReference)));
});

test('lots and packs: kept apart from every price, with a per-piece ESTIMATE that says it is one', () => {
  assert.equal(packOf('6 pcs ACME bottle'), 6); assert.equal(packOf('5 st. ACME fles'), 5); assert.equal(packOf('ACME 2 Pack bottle'), 2); assert.equal(packOf('ACME bottle 710 ml'), null);
  const a = analyseListings(ACME(), ACME_IN, { ecb: ECB }); const lot = a.listings.find((x) => /^6 pcs/.test(x.title)); assert.equal(lot.excludedFromReference, true); assert.deepEqual(lot.pack, { n: 6, unitEur: 55, estimated: true });
  assert.ok(a.groups.every((g) => !g.ids.includes(lot.id)));
});

test('the facet is read from the titles, not from a list: colours (no price gap) are never asked, a facet with a real price gap is', () => {
  const colours = ['Red', 'Blue', 'Green', 'Pink', 'Gold', 'Teal'].flatMap((c, i) => [L(`ACME insulated bottle 710 ml ${c} A`, 50 + i), L(`ACME insulated bottle 710 ml ${c} B`, 51 + i)]);
  assert.equal(detectVariantFacet(colours, ACME_IN), null); const f = detectVariantFacet(ACME(), ACME_IN); assert.ok(f.values.some((v) => v.key === 'wide') && f.values.some((v) => v.key === 'standard'));
  assert.equal(detectVariantFacet([L('a', 1)], ACME_IN), null, 'too few listings: no facet');
});

test('"Autre" free text is cleaned: a typed size needs its unit and must be unambiguous; a typed variant becomes words; a model becomes a code; junk is dropped', () => {
  assert.equal(parseCapacityText('1,89 L'), 1890); assert.equal(parseCapacityText('64 oz'), 1893); assert.equal(parseCapacityText('710ml'), 710); assert.equal(parseCapacityText('1 L ou 2 L'), null); assert.equal(parseCapacityText('beaucoup'), null); assert.equal(parseCapacityText('64'), null);
  const v = sanitizeConfirmed({ variantText: 'Wide  Mouth!' }).variant; assert.deepEqual(v.tokens, ['wide', 'mouth']); assert.equal(sanitizeConfirmed({ variantText: '<script>' }), null); assert.equal(sanitizeConfirmed({ variant: { tokens: ['<x>'], label: '<x>' } }), null);
  assert.deepEqual(sanitizeConfirmed({ model: ' hf-710w ' }), { model: 'HF-710W' }); assert.equal(sanitizeConfirmed({ model: 'x' }), null);
  const free = refine({ listings: ACME(), input: ACME_IN, confirmed: { capacityMl: 710, variantText: 'standard mouth' }, ecb: ECB }).analysis; assert.equal(free.reference.reliable, true); assert.equal(free.reference.medianEur, 46.5);
});

test('the threshold stays at 3 comparable listings per group: 2 are listed one by one, never averaged', () => {
  assert.equal(MIN_COMPARABLE, 3);
  const a = refine({ listings: [WIDE[0], STD[0]], input: ACME_IN, confirmed: { capacityMl: 710 }, ecb: ECB }).analysis; assert.equal(a.reference.reliable, false); assert.equal(a.reference.medianEur, null); assert.deepEqual(a.reference.pricesEur, [46, 62]); assert.ok(a.groups.every((g) => !g.reliable && g.medianEur === null)); assert.equal(a.listings.length, 2);
});

// ---------- service level: 53 listings are all kept, answering costs nothing, an identical search is cached
const items = (ls) => ls.map((l, i) => ({ type: 'google_shopping_serp', title: l.title, price: l.price, currency: 'EUR', seller: l.seller ?? 'Shop', url: `https://google.be/search?ibp=oshop&q=x&prds=${i + 1}` }));
function provider(ls) {
  const calls = { post: 0, other: 0 }; const j = (o) => ({ ok: true, status: 200, json: async () => o });
  const f = async (url) => { if (url.endsWith('/appendix/user_data')) { calls.other += 1; return j({ tasks: [{ result: [{ money: { balance: 1 } }] }] }); } if (url.endsWith('/locations')) return j({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] });
    if (url.endsWith('/products/task_post')) { calls.post += 1; return j({ tasks: [{ id: `t${calls.post}`, status_code: 20100, cost: 0.002 }] }); } if (url.includes('/task_get/advanced/')) return j({ tasks: [{ status_code: 20000, result: [{ datetime: '2026-10-19 15:02:34 +00:00', items: items(ls) }] }] }); throw new Error(`unexpected ${url}`); };
  return { f, calls };
}
const svc = (p) => createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a@b.test', DATAFORSEO_PASSWORD: 'pw-test-123', MARKET_MIN_INTERVAL_SEC: '0.001' }, fetchImpl: p.f, ecb: async () => ECB, sleep: async () => {}, pollMs: 1 });

test('service: all 53 real listings are kept in the case (not 40) and re-read by the refine step; the answer chain makes ZERO provider call; an identical search is served from the cache', async () => {
  const p = provider(REAL.map((x) => ({ title: x.title, price: x.price, seller: x.seller }))); const radar = svc(p);
  const first = await radar.search({ input: { name: 'water bottle', brand: 'Hydro Flask' } }); assert.equal(first.stored.length, 53); assert.equal(first.question.id, 'capacity'); assert.equal(p.calls.post, 1); const before = { ...p.calls };
  const input = { name: 'water bottle', brand: 'Hydro Flask' };
  const a1 = await radar.refine({ evidence: first.stored, input, confirmed: { capacityMl: 946 }, asked: 1 }); assert.equal(a1.stored.length, 53); assert.equal(a1.reference.reliable, true); assert.equal(a1.reference.count, 3); assert.deepEqual(a1.cost, { estimatedMaxUsd: 0, reportedUsd: 0, calls: 0 });
  const a2 = await radar.refine({ evidence: first.stored, input, confirmed: null, asked: 1, declined: ['capacity'] }); assert.equal(a2.confirmation, 'UNKNOWN'); const a3 = await radar.refine({ evidence: first.stored, input, confirmed: { capacityText: '64 oz' }, asked: 1 }); assert.equal(a3.reference.reliable, false);
  assert.deepEqual(p.calls, before, 'no provider call for any answer'); const again = await radar.search({ input }); assert.equal(again.cached, true); assert.equal(p.calls.post, 1, 'identical parameters: cached, not paid twice');
});

test('service: an explicit new search carrying the owner\'s confirmed size and variant uses them (query and strict filter) and asks nothing more', async () => {
  const p = provider(ACME().map((x) => ({ title: x.title, price: x.price }))); const radar = svc(p);
  const r = await radar.search({ input: { name: 'water bottle', brand: 'ACME' }, confirmed: { capacityMl: 710, variantText: 'wide' } }); assert.equal(r.question, null); assert.equal(r.reference.reliable, true); assert.equal(r.reference.count, 4); assert.equal(r.input.confirmed.capacityMl, 710);
  assert.match(r.queries.map((q) => q.text).join(' '), /710ml/i);
});
