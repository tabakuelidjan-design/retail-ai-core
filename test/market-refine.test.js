// Market radar refinement: at most ONE one-tap question (size or model), built only from evidence and never preselected; the owner's answer re-reads the listings already obtained (strict comparability);
// below 3 really comparable listings there is NO median ("Prix de référence non fiable"); the whole step costs nothing and calls nothing. The provider is SIMULATED (these tests prove the rules, not the real provider).
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseListings, clusterVolumes, FLAG, mergeIdentification, volumesIn } from '../src/sourcing/adapters/market-radar.js';
import { listingFromEvidence, proposeQuestion, refine, sanitizeConfirmed } from '../src/sourcing/adapters/market-refine.js';
import { createMarketRadar, RadarError } from '../src/sourcing/server/market-radar-service.js';

const ECB = { date: '2026-10-19', perEur: { USD: 1.1 } };
const L = (title, price, extra = {}) => ({ title, price, currency: price == null ? null : 'EUR', seller: 'Shop', url: `https://shop.example/${encodeURIComponent(title)}`, query: 'q', queryVia: 'nom', observedAt: '2026-10-19T12:00:00.000Z', ...extra });
const BASE = { name: 'Stanley Quencher H2.0 tumbler', brand: 'Stanley', traits: {} }; // the case does NOT say the size
const SIZES = [L('Stanley Quencher H2.0 tumbler 1.18L Rose', 55), L('Stanley Quencher H2.0 tumbler 1,18 L Blue', 54), L('Stanley Quencher H2.0 tumbler 1.18L Cream', 56), L('Stanley Quencher H2.0 tumbler 1.18L Black', 58),
  L('Stanley Quencher H2.0 tumbler 887ml Rose', 40), L('Stanley Quencher H2.0 tumbler 0.887 L Blue', 41), L('Stanley Quencher H2.0 tumbler', 20)];

test('size unknown + the listings show two sizes: ONE capacity question, options sorted by evidence, each says where it comes from, none preselected', () => {
  const q = proposeQuestion({ input: BASE, listings: SIZES });
  assert.equal(q.id, 'capacity'); assert.equal(q.options.length, 2); assert.equal(q.unknownLabel, 'Je ne sais pas');
  assert.deepEqual(q.options.map((o) => o.value.capacityMl), [1180, 887]); assert.match(q.options[0].evidence, /vu dans 4 annonce/); assert.match(q.options[1].evidence, /vu dans 2 annonce/);
  for (const o of q.options) { assert.equal(o.selected, undefined); assert.equal(o.default, undefined); assert.ok(o.evidence, 'no option without its evidence'); }
});

test('no question when the size is already known (case name, traits, GTIN quantity, label), when all listings agree, or when the owner already answered', () => {
  assert.equal(proposeQuestion({ input: { ...BASE, name: 'Stanley Quencher H2.0 tumbler 1.18L' }, listings: SIZES }), null);
  assert.equal(proposeQuestion({ input: { ...BASE, traits: { capacity: '40 oz' } }, listings: SIZES }), null);
  assert.equal(proposeQuestion({ input: { ...BASE, quantity: '1,18 L' }, listings: SIZES }), null);
  assert.equal(proposeQuestion({ input: BASE, listings: SIZES.slice(0, 4) }), null, 'every listing says 1.18 L: nothing to ask');
  assert.equal(proposeQuestion({ input: BASE, listings: SIZES, answered: true }), null);
  assert.equal(proposeQuestion({ input: { ...BASE, confirmed: { capacityMl: 1180 } }, listings: SIZES }), null);
  assert.equal(proposeQuestion({ input: BASE, listings: [L('Stanley Quencher 1.18L', 50), L('Stanley Quencher 887ml', 40), L('Stanley Quencher', 30)] }), null, 'a size seen once is not evidence enough to ask');
});

test('the same size written two ways (40 oz = 1.18 L) is ONE option, and a label that agrees with itself sets the size automatically', () => {
  assert.deepEqual(clusterVolumes(volumesIn('40 oz 1.18 L 1,18L')), [1180].map((x) => clusterVolumes(volumesIn('1.18 L'))[0]));
  const id = mergeIdentification({ ...BASE }, { source: 'PHOTO_VISION', ocrText: 'STANLEY QUENCHER 40 OZ 1.18 L', bestGuess: [], eans: [], models: [], logos: [] });
  assert.equal(id.capacityHint.source, 'ÉTIQUETTE (OCR)'); assert.ok(Math.abs(id.capacityHint.ml - 1180) < 10); assert.equal(id.capacityCandidates, undefined);
  assert.equal(proposeQuestion({ input: id, listings: SIZES }), null, 'the label already says the size');
});

test('a label with two different sizes is a QUESTION with the label as evidence, never an automatic pick', () => {
  const id = mergeIdentification({ ...BASE }, { source: 'PHOTO_VISION', ocrText: 'QUENCHER 30 OZ / 40 OZ', bestGuess: [], eans: [], models: [], logos: [] });
  assert.equal(id.capacityHint, undefined); assert.equal(id.capacityCandidates.length, 2);
  const q = proposeQuestion({ input: id, listings: [] }); assert.equal(q.id, 'capacity'); assert.ok(q.options.every((o) => /étiquette/.test(o.evidence)));
});

test('model: one model read on the label is used automatically; two different ones are a question (never models[0])', () => {
  const one = mergeIdentification({ ...BASE }, { source: 'PHOTO_VISION', models: ['H2-1180'], eans: [], logos: [], bestGuess: [] }); assert.equal(one.model, 'H2-1180');
  const two = mergeIdentification({ ...BASE, name: 'Stanley Quencher tumbler 1.18L' }, { source: 'PHOTO_VISION', models: ['H2-1180', 'H1-0887'], eans: [], logos: [], bestGuess: [] });
  assert.equal(two.model, undefined, 'no silent pick'); assert.deepEqual(two.modelCandidates, ['H2-1180', 'H1-0887']);
  const q = proposeQuestion({ input: two, listings: [] }); assert.equal(q.id, 'model'); assert.deepEqual(q.options.map((o) => o.value.model), ['H2-1180', 'H1-0887']);
  assert.equal(proposeQuestion({ input: { ...two, model: 'H2-1180' }, listings: [] }), null);
});

test('at most ONE question: with both a size and a model uncertain, the size comes first', () => {
  const both = { ...mergeIdentification({ ...BASE }, { source: 'PHOTO_VISION', models: ['H2-1180', 'H1-0887'], eans: [], logos: [], bestGuess: [] }) };
  assert.equal(proposeQuestion({ input: both, listings: SIZES }).id, 'capacity');
});

test('answers are cleaned: a size 50..5000 ml and a model code; anything else is dropped; null = "Je ne sais pas"', () => {
  assert.deepEqual(sanitizeConfirmed({ capacityMl: 1180.4, model: ' h2-1180 ', evil: 'x' }), { capacityMl: 1180, model: 'H2-1180' });
  assert.equal(sanitizeConfirmed({ capacityMl: 5 }), null); assert.equal(sanitizeConfirmed({ capacityMl: 99999 }), null); assert.equal(sanitizeConfirmed({ model: '<script>' }), null); assert.equal(sanitizeConfirmed(null), null); assert.equal(sanitizeConfirmed('1180'), null);
});

const MIX = () => [L('Stanley Quencher H2.0 tumbler 1.18L Rose', 55), L('Stanley Quencher H2.0 tumbler 1.18L Blue', 54), L('Stanley Quencher H2.0 tumbler 1.18L Cream', 56), L('Stanley Quencher H2.0 tumbler 1.18L Black', 58), L('Stanley Quencher H2.0 tumbler 1.18L Green', 57),
  L('Stanley Quencher H2.0 tumbler 887ml Rose', 40), L('Stanley Quencher H2.0 tumbler', 20), L('Yeti Rambler tumbler 1.18L', 70), L('Stanley Quencher H2.0 tumbler 1.18L 2 pack', 110), L('Stanley Quencher straw replacement 1.18L', 15)];

test('after the owner confirms the size: other sizes, listings that do not state a size, other brands, lots and accessories leave the median but stay listed with their reason', () => {
  const r = refine({ listings: MIX(), input: BASE, confirmed: { capacityMl: 1180 }, ecb: ECB });
  const a = r.analysis; assert.equal(a.listings.length, 10, 'nothing is deleted');
  const by = (t) => a.listings.find((x) => x.title === t);
  assert.ok(by('Stanley Quencher H2.0 tumbler 887ml Rose').flags.includes(FLAG.CAPACITY_DIFFERS)); assert.ok(by('Stanley Quencher H2.0 tumbler').flags.includes(FLAG.CAPACITY_NOT_STATED));
  assert.ok(by('Yeti Rambler tumbler 1.18L').flags.some((f) => [FLAG.BRAND_NOT_IN_TITLE, FLAG.NO_TEXT_OVERLAP].includes(f))); assert.ok(by('Stanley Quencher H2.0 tumbler 1.18L 2 pack').flags.includes(FLAG.PACK_OR_LOT)); assert.ok(by('Stanley Quencher straw replacement 1.18L').flags.includes(FLAG.ACCESSORY_SUSPECTED));
  assert.equal(a.listings.filter((x) => x.excludedFromReference).length, 5);
  assert.equal(a.reference.reliable, true); assert.equal(a.reference.count, 5); assert.equal(a.reference.medianEur, 56); assert.equal(a.reference.minEur, 54); assert.equal(a.reference.maxEur, 58);
  assert.equal(r.confirmed.capacityMl, 1180);
});

test('"Je ne sais pas" changes nothing: the ordinary classification stays (the listing without a size is not thrown out on a guess)', () => {
  const mix = () => MIX().map((x) => (x.title === 'Stanley Quencher H2.0 tumbler' ? { ...x, price: 52 } : x)); const unknown = refine({ listings: mix(), input: BASE, confirmed: null, ecb: ECB }); const plain = analyseListings(mix(), BASE, { ecb: ECB });
  assert.deepEqual(unknown.analysis.listings.map((x) => x.excludedFromReference), plain.listings.map((x) => x.excludedFromReference)); assert.equal(unknown.confirmed, null);
  assert.equal(unknown.analysis.listings.find((x) => x.title === 'Stanley Quencher H2.0 tumbler').excludedFromReference, false);
});

test('confirmed model: listings that do not carry the model are excluded; the model makes EXACT possible', () => {
  const ls = [L('Stanley Quencher H2.0 H2-1180 tumbler', 55), L('Stanley Quencher H2.0 H2-1180 Blue', 54), L('Stanley Quencher H2.0 H2-1180 Cream', 56), L('Stanley Quencher H1.0 tumbler 0.887', 40), L('Stanley Quencher tumbler', 30)];
  const a = refine({ listings: ls, input: { name: 'Stanley Quencher tumbler', brand: 'Stanley', traits: {} }, confirmed: { model: 'H2-1180' }, ecb: ECB }).analysis;
  assert.equal(a.listings.filter((x) => x.matchType === 'EXACT_MATCH').length, 3); assert.equal(a.listings.filter((x) => x.excludedFromReference).length, 2); assert.ok(a.listings.find((x) => x.title.includes('H1.0')).flags.includes(FLAG.MODEL_NOT_IN_TITLE));
  assert.equal(a.reference.reliable, true); assert.equal(a.reference.matchClass, 'EXACT_MATCH');
});

test('fewer than 3 really comparable listings: NO median ("Prix de référence non fiable"), the prices stay readable one by one, and the supplier comparison refuses to use them', () => {
  const ls = [L('Stanley Quencher H2.0 tumbler 1.18L Rose', 55), L('Stanley Quencher H2.0 tumbler 1.18L Blue', 54), L('Stanley Quencher H2.0 tumbler 887ml', 40), L('Stanley Quencher straw replacement', 15)];
  const r = refine({ listings: ls, input: BASE, confirmed: { capacityMl: 1180 }, ecb: ECB, supplier: { price: 11, currency: 'USD' } }); const ref = r.analysis.reference;
  assert.equal(ref.reliable, false); assert.equal(ref.medianEur, null); assert.equal(ref.count, 2); assert.deepEqual(ref.pricesEur, [54, 55]); assert.match(ref.note, /seulement 2/);
  assert.equal(r.comparison.ratio, null); assert.match(r.comparison.note, /non fiable/); assert.equal(r.analysis.listings.length, 4);
});

test('only similar products found: no reference at all, said as such', () => {
  const r = refine({ listings: [L('Generic steel tumbler', 12), L('Other insulated cup', 14), L('Another travel mug', 9)], input: BASE, confirmed: null, ecb: ECB }).analysis.reference;
  assert.equal(r.reliable, false); assert.equal(r.medianEur, null); assert.equal(r.count, 0);
});

// ---------- the service: refine = zero network, zero cost, no credentials needed
const evidenceOf = (ls) => analyseListings(ls, BASE, { ecb: ECB }).listings.map((x) => ({ seller: x.seller, url: x.url, price: x.price ? { amount: x.price.amount, currency: x.price.currency } : null, observedAt: x.observedAt, specs: { title: x.title, query: x.query, queryVia: x.queryVia } }));

test('POST refine logic: pure local re-reading, ZERO fetch, ZERO cost, works without any provider credential, and keeps a record of the answer', async () => {
  const calls = []; const spy = async (u) => { calls.push(u); throw new Error('the refine step must never call out'); };
  const svc = createMarketRadar({ env: {}, fetchImpl: spy, ecb: async () => ECB });
  const r = await svc.refine({ evidence: evidenceOf(MIX()), input: { name: BASE.name, brand: 'Stanley' }, confirmed: { capacityMl: 1180 }, supplier: { price: 11, currency: 'USD' } });
  assert.equal(calls.length, 0); assert.equal(r.status, 'DONE'); assert.equal(r.provider, 'local-refine'); assert.deepEqual(r.cost, { estimatedMaxUsd: 0, reportedUsd: 0, calls: 0 }); assert.equal(r.confirmation, 'CONFIRMED');
  assert.equal(r.reference.medianEur, 56); assert.equal(r.stored.length, 10); assert.equal(r.stored.filter((e) => e.specs.excluded).length, 5); assert.equal(r.comparison.supplierEur, 10);
  const u = await svc.refine({ evidence: evidenceOf(MIX()), input: { name: BASE.name, brand: 'Stanley' }, confirmed: null }); assert.equal(u.confirmation, 'UNKNOWN'); assert.equal(calls.length, 0);
  await assert.rejects(() => svc.refine({ evidence: [], input: {} }), (e) => e instanceof RadarError && e.code === 'INVALID_INPUT');
});

test('listingFromEvidence rebuilds the analysis input from what the phone stored', () => {
  const l = listingFromEvidence({ seller: 'S', url: 'https://x.test/a', price: { amount: 5, currency: 'EUR' }, observedAt: 'T', specs: { title: 'T1', query: 'q', queryVia: 'v', productId: 'p' } });
  assert.deepEqual(l, { title: 'T1', seller: 'S', price: 5, currency: 'EUR', url: 'https://x.test/a', observedAt: 'T', query: 'q', queryVia: 'v', productId: 'p' });
});

test('a search that carries the owner\'s answer (explicit paid action) uses it in the query and in the strict filter; the search result proposes at most one question and none when already confirmed', async () => {
  const mk = (title, price, id) => ({ type: 'google_shopping_serp', title, price, currency: 'EUR', seller: 'Shop', url: `https://google.be/search?ibp=oshop&q=x&prds=${id}` });
  const listings = [mk('Stanley Quencher H2.0 tumbler 1.18L Rose', 55, 1), mk('Stanley Quencher H2.0 tumbler 1.18L Blue', 54, 2), mk('Stanley Quencher H2.0 tumbler 887ml Rose', 40, 3), mk('Stanley Quencher H2.0 tumbler 887ml Blue', 41, 4)];
  const posted = []; const f = async (url, opt = {}) => { const j = (o) => ({ ok: true, status: 200, json: async () => o });
    if (url.endsWith('/appendix/user_data')) return j({ tasks: [{ result: [{ money: { balance: 1 } }] }] }); if (url.endsWith('/locations')) return j({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] });
    if (url.endsWith('/products/task_post')) { posted.push(opt.body); return j({ tasks: [{ id: 't1', status_code: 20100, cost: 0.002 }] }); }
    if (url.includes('/task_get/advanced/')) return j({ tasks: [{ status_code: 20000, result: [{ datetime: '2026-10-19 15:02:34 +00:00', items: listings }] }] }); throw new Error(`unexpected ${url}`); };
  const mkSvc = () => createMarketRadar({ env: { DATAFORSEO_LOGIN: 'a@example.com', DATAFORSEO_PASSWORD: 'pw-test-123', MARKET_MIN_INTERVAL_SEC: '0.001' }, fetchImpl: f, ecb: async () => ECB, sleep: async () => {}, pollMs: 1 });
  const first = await mkSvc().search({ input: { name: BASE.name, brand: 'Stanley' } }); assert.equal(first.question.id, 'capacity'); assert.equal(first.question.options.length, 2);
  const second = await mkSvc().search({ input: { name: BASE.name, brand: 'Stanley' }, confirmed: { capacityMl: 1180 } }); assert.equal(second.question, null);
  assert.match(String(posted.at(-1)), /1\.18L|1,18L|1\.18 ?L/i, 'the confirmed size is part of the new query'); assert.equal(second.listings.filter((x) => x.excludedFromReference).length, 2); assert.equal(second.input.confirmed.capacityMl, 1180);
});
