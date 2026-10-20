// Market radar M1 FINAL: generic facets (size, variant, model) with "Autre" free text and "Je ne sais pas", strict separation of exact / probable / similar, statistics per class AND per homogeneous group (never mixed),
// EXACT only when every determining trait is verified, lots / accessories / other brands out of the reference prices (but listed, with a per-piece ESTIMATE for lots), the 3-listing threshold, and the eight scenarios
// asked by the owner. Real data: test/fixtures/market-hydroflask-53.json is a reduced copy of 53 REAL Belgian listings (Google Shopping, 19/10/2026). Nothing here is specific to a brand: the synthetic cases use "ACME".
// The provider is SIMULATED (fake fetch): these tests prove the rules and the cost behaviour, not the real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FLAG, MIN_COMPARABLE, analyseListings, packOf, typeOf } from '../src/sourcing/adapters/market-radar.js';
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
  assert.match(r.analysis.listings[0].reason, /marque et taille ou variante vérifiées, même type de produit/);
});

test('G2 real data — a "water bottle" case: every Travel Tumbler / beker of the 53 real listings is ANOTHER KIND of product, flagged and out of every price; no choice is worth a question', () => {
  const input = { name: 'water bottle', brand: 'Hydro Flask', traits: {} }; const { analysis, facet } = analyseWithFacets(REAL, input, { ecb: ECB });
  assert.equal(analysis.summary.exact, 0); assert.equal(analysis.summary.exactNone, true); assert.equal(analysis.reference.reliable, false);
  const tumblers = analysis.listings.filter((x) => typeOf(x.title, 'Hydro Flask') === 'tumbler'); assert.ok(tumblers.length >= 10, `real tumblers found: ${tumblers.length}`);
  assert.ok(tumblers.every((x) => x.flags.includes(FLAG.TYPE_DIFFERS) && x.excludedFromReference && x.reason === 'autre type de produit'));
  assert.equal(proposeQuestion({ input, listings: REAL, facet }), null, 'in-scope bottles show no size or variant that moves the price: nothing to ask');
});

test('G2 real data — the case does not say the KIND of product: ONE type question (bottle vs travel tumbler) from the titles actually observed, with evidence and price, nothing preselected, "Je ne sais pas" offered', () => {
  const input = { name: 'Hydro Flask', brand: 'Hydro Flask', traits: {} }; const q = proposeQuestion({ input, listings: REAL });
  assert.equal(q.id, 'type'); assert.equal(q.unknownLabel, 'Je ne sais pas'); assert.equal(q.allowOther, false); assert.deepEqual(q.options.map((o) => o.label).sort(), ['gobelet de voyage', 'gourde / bouteille']);
  assert.ok(q.options.every((o) => /\d+ annonce\(s\) retenue\(s\) · prix médian indicatif/.test(o.evidence) && o.selected === undefined && o.value.productType));
  const ans = refine({ listings: REAL, input, confirmed: { productType: 'bottle' }, ecb: ECB }); assert.ok(ans.analysis.listings.filter((x) => typeOf(x.title, 'Hydro Flask') === 'tumbler').every((x) => x.excludedFromReference));
});

test('G2 real data — "Je ne sais pas" on the type: prices are NEVER pooled across types (groups per type), and a median needs 3 homogeneous listings', () => {
  const input = { name: 'Hydro Flask', brand: 'Hydro Flask', traits: {} }; const a = refine({ listings: REAL, input, confirmed: { capacityMl: 946 }, ecb: ECB, asked: 1, declined: ['type'] }).analysis;
  for (const g of a.groups) { const types = new Set(g.ids.map((id) => typeOf(a.listings.find((x) => x.id === id).title, 'Hydro Flask') ?? 'none')); assert.equal(types.size, 1, `group ${g.type} is of one type only`); }
  assert.equal(a.reference.medianEur, null); assert.ok(a.groups.every((g) => g.count < 3 || g.reliable));
});

test('G1+G2 real data — confirming 946 ml for a bottle: the Travel Tumblers no longer make a "bottle" price; only an undetermined-type listing remains and it is alone: "Prix de référence non fiable"', () => {
  const input = { name: 'water bottle', brand: 'Hydro Flask', traits: {} }; const r = refine({ listings: REAL, input, confirmed: { capacityMl: 946 }, ecb: ECB }); const a = r.analysis;
  assert.equal(a.listings.length, 53, 'nothing is removed'); assert.equal(a.reference.reliable, false); assert.equal(a.reference.medianEur, null); assert.deepEqual(a.reference.pricesEur, [32.9]);
  const inRef = a.listings.filter((x) => !x.excludedFromReference); assert.ok(inRef.every((x) => typeOf(x.title, 'Hydro Flask') !== 'tumbler')); assert.ok(a.listings.filter((x) => /Nalgene/i.test(x.title)).every((x) => x.excludedFromReference && x.flags.includes(FLAG.BRAND_NOT_IN_TITLE)));
  assert.ok(a.listings.filter((x) => x.flags.includes(FLAG.PACK_OR_LOT) || x.flags.includes(FLAG.ACCESSORY_SUSPECTED)).every((x) => x.excludedFromReference)); assert.match(a.reference.note, /seulement 1 annonce/);
});

test('G1 real data — the two real "Hydro Flask Wide Mouth" listings (Amazon.be 38,99 €, Snowleader 44,90 €; no container noun, no size): never EXACT; with the variant "wide mouth" confirmed they become PROBABLE with LOW confidence and an honest reason, grouped apart from sized listings; 2 listings are not a reference', () => {
  const input = { name: 'water bottle', brand: 'Hydro Flask', traits: {} };
  const before = analyseWithFacets(REAL, input, { ecb: ECB }).analysis; const wm = before.listings.filter((x) => /^Hydro Flask Wide Mouth$/.test(x.title)); assert.equal(wm.length, 2); assert.ok(wm.every((x) => x.matchType === 'SIMILAR_PRODUCT'), 'without any verified trait they stay SIMILAR');
  const after = refine({ listings: REAL, input, confirmed: { variantText: 'wide mouth' }, ecb: ECB }).analysis; const wm2 = after.listings.filter((x) => /^Hydro Flask Wide Mouth$/.test(x.title));
  assert.ok(wm2.every((x) => x.matchType === 'PROBABLE_MATCH' && x.confidence === 'LOW' && !x.excludedFromReference && /type de produit non précisé/.test(x.reason)), JSON.stringify(wm2.map((x) => [x.matchType, x.confidence, x.reason])));
  assert.equal(after.summary.exact, 0); assert.equal(after.reference.reliable, false); assert.equal(after.reference.medianEur, null); assert.ok(after.reference.pricesEur.includes(38.99) && after.reference.pricesEur.includes(44.9));
});

test('G1 generic: "ACME Wide Mouth 710 ml" has no container noun: brand + verified size is enough for PROBABLE (LOW confidence, reason says the type is not stated), and it never becomes EXACT', () => {
  const ls = [L('ACME Wide Mouth 710 ml Black', 55), L('ACME Wide Mouth 710 ml Blue', 56), L('ACME Wide Mouth 710 ml Green', 57), L('ACME Wide Mouth 710 ml White', 58)];
  const a = refine({ listings: ls, input: ACME_IN, confirmed: { capacityMl: 710 }, ecb: ECB }).analysis; assert.equal(a.summary.probable, 4); assert.equal(a.summary.exact, 0); assert.equal(a.reference.reliable, true); assert.equal(a.reference.count, 4);
  assert.ok(a.listings.every((x) => x.confidence === 'LOW' && /type de produit non précisé/.test(x.reason)));
});

test('G2 generic: a TUMBLER is never priced with a BOTTLE, whatever the brand; with the type unknown they are grouped apart; the type is a question only when the two kinds differ in price', () => {
  const bottles = [58, 59, 60].map((p, i) => L(`ZORBA insulated bottle 710 ml b${i}`, p)); const tumblers = [30, 31, 32].map((p, i) => L(`ZORBA travel tumbler 710 ml t${i}`, p)); const input = { name: 'ZORBA', brand: 'ZORBA', traits: {} };
  const known = refine({ listings: [...bottles, ...tumblers], input: { ...input, name: 'insulated bottle' }, confirmed: { capacityMl: 710 }, ecb: ECB }).analysis; assert.equal(known.reference.count, 3); assert.equal(known.reference.medianEur, 59); assert.ok(tumblers.every((t) => known.listings.find((x) => x.title === t.title).flags.includes(FLAG.TYPE_DIFFERS)));
  const unknown = refine({ listings: [...bottles, ...tumblers], input, confirmed: { capacityMl: 710 }, ecb: ECB }); assert.equal(unknown.analysis.groups.length, 2); assert.equal(unknown.analysis.reference.multiple, true); assert.equal(unknown.analysis.reference.medianEur, null);
  const q = proposeQuestion({ input, listings: [...bottles, ...tumblers] }); assert.equal(q.id, 'type', 'one size only in the titles: the kind of product is the question');
  const typeQ = proposeQuestion({ input: { ...input, confirmed: { capacityMl: 710 } }, listings: [...bottles, ...tumblers] }); assert.equal(typeQ.id, 'type');
  const cheap = [58, 59, 60, 57, 56, 55].map((p, i) => L(`ZORBA ${i % 2 ? 'insulated bottle' : 'travel tumbler'} 710 ml c${i}`, p)); assert.equal(proposeQuestion({ input: { ...input, confirmed: { capacityMl: 710 } }, listings: cheap }), null, 'same price range: the type does not move the price: not asked');
  assert.equal(typeOf('Hydro Flask Wide Mouth', 'Hydro Flask'), null); assert.equal(typeOf('Thermosflessen 32 oz Travel Tumbler'), null, 'two families: undetermined'); assert.equal(typeOf('ACME gourde 1 L'), 'bottle'); assert.equal(typeOf('ACME gobelet 40 cl'), 'tumbler');
});

test('S1 real data — a size with no comparable listing (473 ml, or a typed 64 oz) is "Prix de référence non fiable": no median, no invented price', () => {
  const input = { name: 'water bottle', brand: 'Hydro Flask', traits: {} };
  for (const confirmed of [{ capacityMl: 473 }, { capacityText: '64 oz' }]) { const r = refine({ listings: REAL, input, confirmed, ecb: ECB }); assert.equal(r.analysis.reference.reliable, false); assert.equal(r.analysis.reference.medianEur, null); assert.equal(r.analysis.groups.length, 0); assert.match(r.analysis.reference.note, /aucune annonce comparable/); }
  assert.equal(sanitizeConfirmed({ capacityText: '64 oz' }).capacityMl, 1893);
});

test('S2 confirmed — size then variant (two questions at most, price-moving facets only), then ONE homogeneous reference; variants, sizes, lots, accessories, other brands never enter it', () => {
  const ls = ACME();
  const first = refine({ listings: ls, input: ACME_IN, confirmed: null, ecb: ECB, asked: 0 }); assert.equal(first.question.id, 'capacity'); assert.deepEqual(first.question.options.map((o) => o.value.capacityMl), [710, 946]);
  const second = refine({ listings: ls, input: ACME_IN, confirmed: { capacityMl: 710 }, ecb: ECB, asked: 1 }); assert.equal(second.question.id, 'variant'); assert.deepEqual(second.question.options.map((o) => o.label).sort(), ['Standard mouth', 'Wide mouth']); assert.ok(second.question.options.every((o) => /vu dans \d+ annonce.*prix médian/.test(o.evidence)));
  const wide = second.question.options.find((o) => /^Wide/.test(o.label)).value;
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
  const after = refine({ listings: ls, input, confirmed: { variant: q.options.find((o) => /^Wide/.test(o.label)).value.variant }, ecb: ECB }).analysis; assert.equal(after.listings.filter((x) => !x.excludedFromReference && x.matchType === 'EXACT_MATCH').length, 3); assert.equal(after.reference.matchClass, 'EXACT_MATCH'); assert.equal(after.reference.count, 3); assert.equal(after.reference.medianEur, 63);
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

test('H3 real data — the type question promises exactly what the answer then shows: the same count and median as INDICATIVE prices, apart from the reference, never promoted to "probable"', () => {
  const input = { name: 'Hydro Flask', brand: 'Hydro Flask', traits: {} }; const { facet } = analyseWithFacets(REAL, input, { ecb: ECB }); const q = proposeQuestion({ input, listings: REAL, facet }); assert.equal(q.id, 'type');
  for (const o of q.options) {
    const [, n, med] = /^(\d+) annonce\(s\) retenue\(s\) · prix médian indicatif (\d+,\d+) €/.exec(o.evidence); const a = refine({ listings: REAL, input, confirmed: o.value, ecb: ECB, asked: 1 }).analysis; const ind = a.indicative.find((x) => x.type === o.value.productType);
    assert.equal(ind.count, Number(n)); assert.equal(`${ind.medianEur.toFixed(2).replace('.', ',')}`, med); assert.equal(a.summary.probable, 0, 'brand + type alone never makes a listing "probable"'); assert.equal(a.reference.reliable, false); assert.equal(a.reference.medianEur, null);
  }
  const r = refine({ listings: REAL, input, confirmed: { productType: 'bottle' }, ecb: ECB, supplier: { price: 11, currency: 'USD' } }); assert.equal(r.comparison.ratio, null, 'an indicative price is never used for the supplier ratio');
});

test('H3 indicative prices: one family at a time, at least 3 similar listings per family, never pooled across families, never when the listings are comparable', () => {
  const b = (p, i) => L(`ZORBA insulated bottle ${i}`, p); const t = (p, i) => L(`ZORBA travel tumbler ${i}`, p); const input = { name: 'ZORBA', brand: 'ZORBA', traits: {} };
  const a = analyseListings([b(58, 1), b(59, 2), b(60, 3), t(30, 4), t(31, 5), t(32, 6)], input, { ecb: ECB }); assert.equal(a.indicative.length, 2); assert.deepEqual(a.indicative.map((x) => [x.type, x.count, x.medianEur]).sort(), [['bottle', 3, 59], ['tumbler', 3, 31]]);
  const two = analyseListings([b(58, 1), b(59, 2), t(30, 3), t(31, 4)], input, { ecb: ECB }); assert.equal(two.indicative.length, 0, 'two per family is not enough');
  const cmp = analyseListings([L('ZORBA insulated bottle 710 ml a', 50), L('ZORBA insulated bottle 710 ml b', 51), L('ZORBA insulated bottle 710 ml c', 52)], { name: 'insulated bottle', brand: 'ZORBA', traits: {} }, { ecb: ECB }); assert.equal(cmp.reference.reliable, true); assert.equal(cmp.indicative.length, 0, 'comparable listings are a reference, not an indication');
});

test('H2 "Préciser": typed size / model / variant go through the same cleaning as "Autre"; a value that is not understood is dropped (the screen says which one), a newly typed value replaces the earlier one, and it never needs a provider', async () => {
  assert.deepEqual(sanitizeConfirmed({ capacityText: '64 oz', model: 'x', variantText: 'wide mouth' }), { capacityMl: 1893, variant: { key: 'wide mouth', label: 'wide mouth', tokens: ['wide', 'mouth'] } }, 'the invalid model is dropped, the others kept');
  const radar = createMarketRadar({ env: {}, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ECB }); const ev = ACME().map((x, i) => ({ seller: 'S', url: `https://google.be/search?ibp=oshop&prds=${i}`, price: { amount: x.price, currency: 'EUR' }, observedAt: x.observedAt, specs: { title: x.title, query: 'q', queryVia: 'nom' } }));
  const first = await radar.refine({ evidence: ev, input: ACME_IN, confirmed: { capacityText: '710 ml' }, asked: 0 }); assert.equal(first.input.confirmed.capacityMl, 710); assert.equal(first.question.id, 'variant', 'Préciser consumed no question: the variant is still asked');
  const second = await radar.refine({ evidence: ev, input: ACME_IN, confirmed: { capacityText: '946 ml', variantText: 'wide mouth' }, asked: 0 }); assert.equal(second.input.confirmed.capacityMl, 946); assert.equal(second.reference.reliable, true); assert.equal(second.reference.count, 3);
});

test('H4 real data — a KNOWN brand is respected: the indicative prices of the same brand and type are the same whatever the case name ("water bottle" or "Hydro Flask" + type answered), and another brand (Nalgene) is left out, counted and said', () => {
  const named = analyseWithFacets(REAL, { name: 'water bottle', brand: 'Hydro Flask', traits: {} }, { ecb: ECB }).analysis; const typed = refine({ listings: REAL, input: { name: 'Hydro Flask', brand: 'Hydro Flask', traits: {} }, confirmed: { productType: 'bottle' }, ecb: ECB, asked: 1 }).analysis;
  const pick = (a) => a.indicative.find((x) => x.type === 'bottle'); assert.deepEqual(pick(named), pick(typed)); assert.deepEqual(pick(named), { type: 'bottle', count: 4, minEur: 31.1, medianEur: 42.68, maxEur: 44.95 });
  assert.equal(named.indicativeBasis.brandKnown, true); assert.equal(named.indicativeBasis.brand, 'Hydro Flask'); assert.equal(named.indicativeBasis.otherBrandLeftOut, 2); assert.ok(named.listings.filter((x) => /Nalgene/i.test(x.title)).length >= 2, 'the other-brand listings stay listed');
  const q = proposeQuestion({ input: { name: 'Hydro Flask', brand: 'Hydro Flask', traits: {} }, listings: REAL }); const bottle = q.options.find((o) => o.value.productType === 'bottle'); assert.match(bottle.evidence, /^4 annonce\(s\) retenue\(s\) · prix médian indicatif 42,68 €/, 'the question promises the brand-respecting number');
});

test('H4 brand spelling variants never exclude a valid listing (case, accents, spaces, hyphens, symbols are ignored); a different brand is excluded; an unknown brand filters nothing and says so', () => {
  const input = { name: 'water bottle', brand: 'Hydro Flask', traits: {} };
  const ls = [L('Hydroflask water fles A', 30), L('HYDRO-FLASK water fles B', 31), L('Hydro Flask® water fles C', 32), L('hydro  flask water fles D', 33), L('Nalgene water fles E', 20), L('Contigo water fles F', 22)]; // similar (half of the name's words), same kind of product
  const a = analyseListings(ls, input, { ecb: ECB }); assert.ok(a.listings.every((x) => x.matchType === 'SIMILAR_PRODUCT' && !x.excludedFromReference && x.type === 'bottle'));
  assert.deepEqual(a.indicative.map((x) => [x.type, x.count, x.medianEur]), [['bottle', 4, 31.5]], 'the four spellings of the brand are all kept'); assert.equal(a.indicativeBasis.otherBrandLeftOut, 2); assert.equal(a.indicativeBasis.brandKnown, true);
  assert.equal(analyseListings(ls, { ...input, brand: 'Stanley' }, { ecb: ECB }).indicative.length, 0, 'with another brand known, none of these listings is that brand');
  const unknown = analyseListings(ls, { name: 'water bottle', traits: {} }, { ecb: ECB }); assert.equal(unknown.indicativeBasis.brandKnown, false); assert.equal(unknown.indicativeBasis.otherBrandLeftOut, 0); assert.equal(unknown.indicative[0].count, 6, 'nothing is filtered when the brand is unknown');
});

test('PROVISIONAL brand — a brand read by a machine (Vision, barcode, barcode database) filters NOTHING until the owner confirms it; the screen data says so', () => {
  for (const source of ['PHOTO_VISION', 'LOCAL_BARCODE', 'GTIN_DB']) {
    const input = { name: 'water bottle', brand: 'Hydro Flask', traits: {}, sources: { brand: source } }; const a = analyseWithFacets(REAL, input, { ecb: ECB }).analysis; const bottle = a.indicative.find((x) => x.type === 'bottle');
    assert.deepEqual(bottle, { type: 'bottle', count: 6, minEur: 15.95, medianEur: 35.75, maxEur: 44.95 }, `${source}: the other-brand listings (Nalgene) are NOT thrown out while the brand is provisional`);
    assert.equal(a.indicativeBasis.provisional, true); assert.equal(a.indicativeBasis.brandKnown, true); assert.equal(a.indicativeBasis.brandSource, source); assert.equal(a.indicativeBasis.otherBrandLeftOut, 0); assert.equal(a.indicativeBasis.notNamedKept, 2);
  }
});

test('CONFIRMED brand — after the owner confirms it explicitly, the H4 filter applies (same numbers as a brand typed in the case); unknown brand and case brand are unchanged', () => {
  const prov = { name: 'water bottle', brand: 'Hydro Flask', traits: {}, sources: { brand: 'PHOTO_VISION' } };
  const r = refine({ listings: REAL, input: prov, confirmed: { brand: 'Hydro Flask' }, ecb: ECB }); const a = r.analysis;
  assert.deepEqual(a.indicative.find((x) => x.type === 'bottle'), { type: 'bottle', count: 4, minEur: 31.1, medianEur: 42.68, maxEur: 44.95 }); assert.equal(a.indicativeBasis.provisional, false); assert.equal(a.indicativeBasis.brandSource, 'OWNER_CONFIRMED'); assert.equal(a.indicativeBasis.otherBrandLeftOut, 2); assert.equal(r.confirmed.brand, 'Hydro Flask');
  const fromCase = analyseWithFacets(REAL, { name: 'water bottle', brand: 'Hydro Flask', traits: {} }, { ecb: ECB }).analysis; assert.deepEqual(fromCase.indicative, a.indicative, 'a brand typed in the case behaves like a confirmed brand');
  assert.equal(analyseWithFacets(REAL, { name: 'water bottle', traits: {} }, { ecb: ECB }).analysis.indicativeBasis.brandKnown, false);
  assert.equal(sanitizeConfirmed({ brand: '®®' }), null); assert.equal(sanitizeConfirmed({ brand: ' Hydro Flask ' }).brand, 'Hydro Flask'); assert.equal(refine({ listings: REAL, input: prov, confirmed: { brand: '®®' }, ecb: ECB }).analysis.indicativeBasis.provisional, true, 'an unusable brand confirms nothing');
  assert.equal(refine({ listings: REAL, input: prov, confirmed: { brand: 'Hydro Flask' }, ecb: ECB }).analysis.summary.exact, 0); assert.equal(refine({ listings: REAL, input: prov, confirmed: { brand: 'Hydro Flask' }, ecb: ECB }).analysis.reference.reliable, false, 'confirming a brand never creates a reference price');
});

test('PROVISIONAL / CONFIRMED brand — the type question promises exactly what the answer shows, in both states', () => {
  const evidenceOf = (input, kind) => { const q = proposeQuestion({ input, listings: REAL, facet: analyseWithFacets(REAL, input, { ecb: ECB }).facet }); return q.options.find((o) => o.value.productType === kind); };
  for (const sources of [{ brand: 'LOCAL_BARCODE' }, { brand: 'OWNER_CONFIRMED' }]) {
    const input = { name: 'Hydro Flask', brand: 'Hydro Flask', traits: {}, sources }; const o = evidenceOf(input, 'bottle'); const [, n, med] = /^(\d+) annonce\(s\) retenue\(s\) · prix médian indicatif (\d+,\d+) €/.exec(o.evidence);
    const ind = refine({ listings: REAL, input, confirmed: o.value, ecb: ECB, asked: 1 }).analysis.indicative.find((x) => x.type === 'bottle'); assert.equal(ind.count, Number(n)); assert.equal(ind.medianEur.toFixed(2).replace('.', ','), med);
  }
  // (with a brand-only case name the other brands already have no word in common with the search and are out of scope in both states: the promise is the same, and it always equals the answer)
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
  const p = provider(REAL.map((x) => ({ title: x.title, price: x.price, seller: x.seller }))); const radar = svc(p); const input = { name: 'Hydro Flask', brand: 'Hydro Flask' };
  const first = await radar.search({ input }); assert.equal(first.stored.length, 53); assert.equal(first.question.id, 'type'); assert.equal(p.calls.post, 1); const before = { ...p.calls };
  const a1 = await radar.refine({ evidence: first.stored, input, confirmed: { productType: 'bottle' }, asked: 1 }); assert.equal(a1.stored.length, 53); assert.deepEqual(a1.cost, { estimatedMaxUsd: 0, reportedUsd: 0, calls: 0 }); assert.ok(a1.stored.filter((e) => e.specs.type === 'tumbler').every((e) => e.specs.excluded));
  const a2 = await radar.refine({ evidence: first.stored, input, confirmed: { productType: 'bottle', capacityMl: 946 }, asked: 2 }); assert.equal(a2.reference.reliable, false); assert.equal(a2.question, null);
  const a3 = await radar.refine({ evidence: first.stored, input, confirmed: null, asked: 1, declined: ['type'] }); assert.equal(a3.confirmation, 'UNKNOWN'); const a4 = await radar.refine({ evidence: first.stored, input, confirmed: { capacityText: '64 oz' }, asked: 1 }); assert.equal(a4.reference.reliable, false);
  assert.deepEqual(p.calls, before, 'no provider call for any answer'); const again = await radar.search({ input }); assert.equal(again.cached, true); assert.equal(p.calls.post, 1, 'identical parameters: cached, not paid twice');
});

test('service: a brand that only a Vision read provided is PROVISIONAL (no brand filter); the owner\'s confirmation re-reads the listings for free and only then filters', async () => {
  const p = provider(REAL.map((x) => ({ title: x.title, price: x.price, seller: x.seller }))); const radar = svc(p); const ident = { source: 'PHOTO_VISION', logos: ['Hydro Flask'], eans: [], models: [], bestGuess: [] };
  const first = await radar.search({ input: { name: 'water bottle' }, identification: ident }); assert.equal(first.input.sources.brand, 'PHOTO_VISION'); assert.equal(first.indicativeBasis.provisional, true); assert.equal(first.indicativeBasis.brand, 'Hydro Flask'); assert.equal(first.indicative.find((x) => x.type === 'bottle').count, 6); const before = { ...p.calls };
  const kept = await radar.refine({ evidence: first.stored, input: { name: 'water bottle', brand: first.input.brand }, inputSources: first.input.sources, identification: ident, confirmed: null, asked: 0 }); assert.equal(kept.indicativeBasis.provisional, true, 'still provisional until the owner confirms');
  const confirmed = await radar.refine({ evidence: first.stored, input: { name: 'water bottle', brand: first.input.brand }, inputSources: first.input.sources, identification: ident, confirmed: { brand: 'Hydro Flask' }, asked: 0 }); assert.equal(confirmed.indicativeBasis.provisional, false); assert.equal(confirmed.indicativeBasis.brandSource, 'OWNER_CONFIRMED'); assert.equal(confirmed.indicative.find((x) => x.type === 'bottle').count, 4); assert.equal(confirmed.input.confirmed.brand, 'Hydro Flask');
  assert.deepEqual(p.calls, before, 'confirming a brand costs nothing: no provider call');
  const typed = await svc(provider(REAL.map((x) => ({ title: x.title, price: x.price })))).search({ input: { name: 'water bottle', brand: 'Hydro Flask' } }); assert.equal(typed.indicativeBasis.provisional, false, 'a brand typed in the case is the owner\'s own: filtering from the start'); assert.equal(typed.indicative.find((x) => x.type === 'bottle').count, 4);
});

test('service: an explicit new search carrying the owner\'s confirmed size and variant uses them (query and strict filter) and asks nothing more', async () => {
  const p = provider(ACME().map((x) => ({ title: x.title, price: x.price }))); const radar = svc(p);
  const r = await radar.search({ input: { name: 'water bottle', brand: 'ACME' }, confirmed: { capacityMl: 710, variantText: 'wide' } }); assert.equal(r.question, null); assert.equal(r.reference.reliable, true); assert.equal(r.reference.count, 4); assert.equal(r.input.confirmed.capacityMl, 710);
  assert.match(r.queries.map((q) => q.text).join(' '), /710ml/i);
});
