// Market radar (server side): analysis rules, cost/rate controls, error mapping, credential hygiene and the HTTP route. The provider is SIMULATED here (fake fetch): these tests prove the rules, not the real provider
// (the real provider was exercised separately: see docs/MARKET-RADAR.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyseListings, classifyListing, compareWithSupplier, linkInfo, marketplaceOf, mergeIdentification, queriesFromInput, volumeMl, FLAG } from '../src/sourcing/adapters/market-radar.js';
import { ProviderError, fetchShoppingListings } from '../src/sourcing/adapters/market-dataforseo.js';
import { createMarketRadar, RadarError } from '../src/sourcing/server/market-radar-service.js';
import { startSourcingServer } from '../src/sourcing/server/index.js';

const SECRET = 'S3cr3t-Pa55word-XYZ'; const LOGIN = 'owner@example.test';
const ENV = { DATAFORSEO_LOGIN: LOGIN, DATAFORSEO_PASSWORD: SECRET };
const ECB = { date: '2026-10-19', perEur: { USD: 1.1, CNY: 7.8 } };
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const L = (title, price, extra = {}) => ({ title, price, currency: price == null ? null : 'EUR', seller: 'Shop', url: `https://shop.example/${encodeURIComponent(title)}`, query: 'q', queryVia: 'nom', observedAt: '2026-10-19T12:00:00.000Z', ...extra });

// ---------- analysis rules
test('volume parsing: litres, ml, cl, oz, decimal comma', () => { assert.equal(volumeMl('1,18 L'), 1180); assert.equal(volumeMl('500ml'), 500); assert.equal(volumeMl('50cl'), 500); assert.ok(Math.abs(volumeMl('40oz') - 1182.9) < 1); assert.equal(volumeMl('no volume'), null); });

test('EXACT needs the exact model (and the brand when known): a similar title is never EXACT', () => {
  const input = { name: 'insulated bottle', brand: 'ACME', model: 'RB-980HB', traits: {} };
  assert.equal(classifyListing(L('ACME RB980HB insulated bottle 500 ml', 20), input).matchType, 'EXACT_MATCH');
  assert.equal(classifyListing(L('ACME insulated bottle steel', 20), input).matchType, 'PROBABLE_MATCH');
  assert.equal(classifyListing(L('Generic insulated bottle', 20), input).matchType, 'SIMILAR_PRODUCT');
  assert.equal(classifyListing(L('RB-980HB bottle', 20), input).matchType, 'PROBABLE_MATCH'); // model without the known brand: not EXACT
  const nameOnly = classifyListing(L('ACME insulated bottle', 20), { name: 'insulated bottle', traits: {} }); assert.notEqual(nameOnly.matchType, 'EXACT_MATCH');
});

test('flags: pack / lot, accessory, different capacity (downgraded to SIMILAR), capacity not stated', () => {
  const input = { name: 'Stanley Quencher tumbler 1.18L', brand: 'Stanley', traits: {} };
  assert.ok(classifyListing(L('Stanley Quencher tumbler 1.18L 50 pcs wholesale', 300), input).flags.includes(FLAG.PACK_OR_LOT));
  const acc = classifyListing(L('Stanley Quencher straws replacement set', 15), input); assert.ok(acc.flags.includes(FLAG.ACCESSORY_SUSPECTED)); assert.equal(acc.matchType, 'SIMILAR_PRODUCT');
  const cap = classifyListing(L('Stanley Quencher tumbler 0.887L', 40), input); assert.ok(cap.flags.includes(FLAG.CAPACITY_DIFFERS)); assert.equal(cap.matchType, 'SIMILAR_PRODUCT');
  assert.ok(classifyListing(L('Stanley Quencher tumbler', 55), input).flags.includes(FLAG.CAPACITY_NOT_STATED));
});

test('outliers, packs and accessories are FLAGGED and kept out of the reference range, never deleted', () => {
  const input = { name: 'Stanley Quencher tumbler 1.18L', brand: 'Stanley', traits: {} };
  const ls = [L('Stanley Quencher tumbler 1.18L A', 50), L('Stanley Quencher tumbler 1.18L B', 55), L('Stanley Quencher tumbler 1.18L C', 60), L('Stanley Quencher tumbler 1.18L D', 52), L('Stanley Quencher tumbler 1.18L E', 58),
    L('Stanley Quencher tumbler 1.18L F', 3810), L('Stanley Quencher tumbler 1.18L G', 4), L('Stanley Quencher 12 pack tumbler 1.18L', 400), L('Stanley Quencher tumbler 1.18L no price', null)];
  const a = analyseListings(ls, input, { ecb: ECB });
  assert.equal(a.listings.length, 9); // nothing removed
  const by = (t) => a.listings.find((r) => r.title.endsWith(t) || r.title.includes(t));
  assert.ok(by(' F').flags.includes(FLAG.PRICE_OUTLIER_HIGH)); assert.ok(by(' G').flags.includes(FLAG.PRICE_OUTLIER_LOW)); assert.ok(by('12 pack').flags.includes(FLAG.PACK_OR_LOT)); assert.ok(by('no price').flags.includes(FLAG.NO_PRICE));
  assert.equal(a.listings.filter((r) => r.excludedFromReference).length, 4);
  assert.equal(a.reference.count, 5); assert.equal(a.reference.medianEur, 55); assert.equal(a.reference.maxEur, 60); // the 3810 € lot is not in the range
});

test('without exact or probable matches there is NO reference price: similar products only are reported as such, never as a median', () => {
  const a = analyseListings([L('Acme steel flask bottle', 20), L('Acme flask bottle large', 30)], { name: 'Acme thermos bottle', brand: 'Acme', traits: {} }, { ecb: ECB });
  assert.equal(a.reference.reliable, false); assert.equal(a.reference.medianEur, null); assert.match(a.reference.note, /similaire/i); assert.equal(a.reference.count, 0);
});

test('Google Shopping links are labelled as such; marketplaces come from the SELLER, never from the link', () => {
  assert.equal(linkInfo('https://google.be/search?ibp=oshop&q=x&prds=1').kind, 'GOOGLE_SHOPPING_PAGE');
  assert.equal(linkInfo('https://www.bol.com/nl/p/x/1/').kind, 'MERCHANT_DIRECT');
  assert.equal(marketplaceOf('Amazon.com.be', 'https://google.be/search?ibp=oshop'), 'amazon.be'); assert.equal(marketplaceOf('bol', 'https://google.be/search?ibp=oshop'), 'bol.com'); assert.equal(marketplaceOf('Giftable', 'https://google.be/x'), null);
});

test('queries: GTIN first, then brand + model, then name; capped; photo identification only fills what is missing', () => {
  const q = queriesFromInput({ name: 'tumbler', brand: 'Stanley', model: 'H2.0', gtin: '4006381333931', traits: {} }, 2); assert.equal(q.length, 2); assert.equal(q[0].strength, 'GTIN'); assert.equal(q[1].text, 'Stanley H2.0');
  const m = mergeIdentification({ name: 'bottle', brand: null, model: null, gtin: null }, { source: 'PHOTO_VISION', logos: ['ACME'], models: ['RB-980HB'], bestGuess: ['another name'] });
  assert.equal(m.brand, 'ACME'); assert.equal(m.model, 'RB-980HB'); assert.equal(m.name, 'bottle'); assert.equal(m.sources.brand, 'PHOTO_VISION'); // the case's own name is kept
});

test('comparison with the supplier: dated ECB conversion, limits stated, unknown currency never converted', () => {
  const ref = { matchClass: 'PROBABLE_MATCH', medianEur: 55 };
  const c = compareWithSupplier({ reference: ref, supplier: { price: 11, currency: 'USD' }, ecb: ECB }); assert.equal(c.supplierEur, 10); assert.equal(c.ratio, 0.18); assert.equal(c.ecbDate, '2026-10-19'); assert.ok(c.caveats.some((x) => /TVA/.test(x)) && c.caveats.some((x) => /importation/.test(x)));
  assert.equal(compareWithSupplier({ reference: ref, supplier: { price: 5, currency: 'ZZZ' }, ecb: ECB }).supplierEur, null);
  assert.match(compareWithSupplier({ reference: ref, supplier: null, ecb: ECB }).note, /aucun prix fournisseur/);
});

// ---------- the service (fake provider)
const items = (...rows) => rows.map((r) => ({ type: 'google_shopping_serp', ...r }));
function fakeProvider({ balance = 1, listings = null, taskStatus = 20000, postHttp = 200, locHttp = 200, onCall = () => {}, hang = false } = {}) {
  const calls = []; let n = 0;
  const f = async (url, opt = {}) => {
    calls.push(url); onCall(url, opt);
    if (url.endsWith('/appendix/user_data')) return balance === null ? json({}, 500) : json({ tasks: [{ result: [{ money: { balance } }] }] });
    if (url.endsWith('/locations')) return locHttp !== 200 ? json({}, locHttp) : json({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] });
    if (url.endsWith('/products/task_post')) return postHttp !== 200 ? json({}, postHttp) : json({ tasks: [{ id: `t${++n}`, status_code: 20100, cost: 0.002 }] });
    if (url.includes('/task_get/advanced/')) return hang ? json({ tasks: [{ status_code: 40602, status_message: 'Task In Queue.' }] }) : json({ tasks: [{ status_code: taskStatus, result: [{ datetime: '2026-10-19 15:02:34 +00:00', items: listings ?? items(
      { title: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L', price: 55, currency: 'EUR', seller: 'Stanley 1913 EU', url: 'https://google.be/search?ibp=oshop&q=x&prds=1' },
      { title: 'Stanley 1913 Quencher H2.0 FlowState Tumbler 1,18 L', price: 54.63, currency: 'EUR', seller: 'Amazon.com.be', url: 'https://google.be/search?ibp=oshop&q=x&prds=2' },
      { title: 'Stanley Quencher H2.0 40oz', price: 109.95, currency: 'EUR', seller: 'bol', url: 'https://google.be/search?ibp=oshop&q=x&prds=3' }) }] }] });
    throw new Error(`unexpected ${url}`);
  };
  return { f, calls };
}
const body = (over = {}) => ({ input: { name: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L', brand: 'Stanley' }, supplier: { price: 11, currency: 'USD' }, ...over });
const radar = (p, extra = {}) => createMarketRadar({ env: ENV, fetchImpl: p.f, ecb: async () => ECB, sleep: async () => {}, pollMs: 1, ...extra });
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { assert.ok(e instanceof RadarError, String(e)); return e.code; } };

test('a successful search returns listings with provenance, Amazon.be / bol found separately, comparison, cost and stored evidence', async () => {
  const p = fakeProvider(); const r = await radar(p).search(body());
  assert.equal(r.status, 'DONE'); assert.equal(r.listings.length, 3); assert.equal(r.observedAt, '2026-10-19T15:02:34.000Z'); assert.equal(r.cached, false);
  assert.equal(r.marketplaces['amazon.be'], 1); assert.equal(r.marketplaces['bol.com'], 1); assert.ok(r.listings.every((l) => l.linkKind === 'GOOGLE_SHOPPING_PAGE' && l.url && l.observedAt && l.source));
  assert.equal(r.comparison.supplierEur, 10); assert.equal(r.cost.reportedUsd, 0.002); assert.equal(r.stored.length, 3); assert.ok(r.stored.every((e) => e.country === 'BE' && e.specs.linkKind === 'GOOGLE_SHOPPING_PAGE'));
  assert.ok(r.notes.some((n) => /pas la page directe/.test(n)));
});

test('credentials never appear in a result or in any error', async () => {
  const p = fakeProvider(); const ok = JSON.stringify(await radar(p).search(body())); assert.ok(!ok.includes(SECRET) && !ok.includes(LOGIN) && !ok.includes(Buffer.from(`${LOGIN}:${SECRET}`).toString('base64')));
  for (const opts of [{ postHttp: 401 }, { postHttp: 500 }, { locHttp: 429 }]) { try { await radar(fakeProvider(opts)).search(body()); assert.fail('should throw'); } catch (e) { const t = JSON.stringify({ m: e.message, c: e.code, s: e.stack?.split('\n')[0] }); assert.ok(!t.includes(SECRET) && !t.includes(LOGIN)); } }
  const st = JSON.stringify(radar(p).status()); assert.ok(!st.includes(SECRET) && !st.includes(LOGIN));
});

test('the same search is paid once: the second one is served from the cache, flagged as cached, with the original date', async () => {
  const p = fakeProvider(); const rd = radar(p); const a = await rd.search(body()); const callsAfterFirst = p.calls.length; const b = await rd.search(body());
  assert.equal(b.cached, true); assert.equal(p.calls.length, callsAfterFirst); assert.equal(b.observedAt, a.observedAt);
});

test('rate and cost controls: minimum interval, daily cap, balance, estimate', async () => {
  let t = Date.parse('2026-10-19T12:00:00Z'); const now = () => new Date(t);
  const p = fakeProvider(); const rd = radar(p, { now, env: { ...ENV, MARKET_DAILY_MAX: '2', MARKET_MIN_INTERVAL_SEC: '10' } });
  await rd.search(body()); assert.equal(await codeOf(() => rd.search(body({ input: { name: 'Another product X', brand: 'Acme' } }))), 'TOO_SOON');
  t += 11_000; await rd.search(body({ input: { name: 'Another product X', brand: 'Acme' } })); t += 11_000;
  assert.equal(await codeOf(() => rd.search(body({ input: { name: 'Third product Y', brand: 'Zed' } }))), 'DAILY_LIMIT');
  assert.equal(await codeOf(() => radar(fakeProvider({ balance: 0.001 })).search(body())), 'BALANCE_LOW');
  assert.equal(await codeOf(() => radar(fakeProvider({ balance: null })).search(body())), 'BALANCE_UNREADABLE');
  assert.equal(await codeOf(() => createMarketRadar({ env: { ...ENV, MARKET_MAX_COST_USD: '0.001' }, fetchImpl: fakeProvider().f }).search(body())), 'COST_LIMIT');
});

test('a second search while one is running is refused (no repeated paid calls)', async () => {
  let release; const gate = new Promise((r) => { release = r; }); const p = fakeProvider(); const slow = async (u, o) => (u.endsWith('/appendix/user_data') ? (await gate, p.f(u, o)) : p.f(u, o));
  const rd = createMarketRadar({ env: { ...ENV, MARKET_MIN_INTERVAL_SEC: '0.001' }, fetchImpl: slow, ecb: async () => ECB, sleep: async () => {}, pollMs: 1 });
  const first = rd.search(body()); await new Promise((r) => setTimeout(r, 5));
  assert.equal(await codeOf(() => rd.search(body({ input: { name: 'Different thing', brand: 'Acme' } }))), 'BUSY'); release(); assert.equal((await first).status, 'DONE');
});

test('network error, provider refusal, timeout: explicit codes, nothing invented, no automatic retry', async () => {
  const down = createMarketRadar({ env: ENV, fetchImpl: async (u) => { if (u.endsWith('/appendix/user_data')) return json({ tasks: [{ result: [{ money: { balance: 1 } }] }] }); throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, ecb: async () => ECB, sleep: async () => {} });
  assert.equal(await codeOf(() => down.search(body())), 'NETWORK');
  assert.equal(await codeOf(() => radar(fakeProvider({ postHttp: 401 })).search(body())), 'PROVIDER_AUTH');
  assert.equal(await codeOf(() => radar(fakeProvider({ postHttp: 402 })).search(body())), 'PROVIDER_BALANCE');
  assert.equal(await codeOf(() => radar(fakeProvider({ postHttp: 429 })).search(body())), 'PROVIDER_RATE_LIMIT');
  const p = fakeProvider({ hang: true }); let ticks = 0; const rd = radar(p, { maxWaitMs: 30, sleep: async () => { ticks++; await new Promise((r) => setTimeout(r, 10)); } });
  assert.equal(await codeOf(() => rd.search(body())), 'TIMEOUT'); assert.equal(p.calls.filter((u) => u.endsWith('/task_post')).length, 1); // one paid task, never re-posted
});

test('no result: an honest DONE with zero listings, never a fabricated one; invalid input and missing configuration are explicit', async () => {
  const r = await radar(fakeProvider({ listings: [] })).search(body()); assert.equal(r.status, 'DONE'); assert.equal(r.listings.length, 0); assert.equal(r.reference.reliable, false); assert.equal(r.reference.medianEur, null); assert.ok(r.notes.some((n) => /rien trouvé/.test(n)));
  assert.equal(await codeOf(() => radar(fakeProvider()).search({ input: {} })), 'INVALID_INPUT');
  assert.equal(await codeOf(() => createMarketRadar({ env: {} }).search(body())), 'NOT_CONFIGURED'); assert.equal(createMarketRadar({ env: {} }).status().enabled, false);
  assert.equal(await codeOf(() => radar(fakeProvider()).search(body({ country: 'US' }))), 'BAD_COUNTRY');
});

test('a badly identified product (name only, generic) never gets EXACT and says so; listings without a link are dropped', async () => {
  const listings = items({ title: 'Some generic bottle', price: 12, currency: 'EUR', seller: 'S1', url: 'https://google.be/search?ibp=oshop&q=1' }, { title: 'No link bottle', price: 5, currency: 'EUR', seller: 'S2' });
  const r = await radar(fakeProvider({ listings })).search({ input: { name: 'bottle' } });
  assert.equal(r.listings.length, 1); assert.ok(r.listings.every((l) => l.matchType !== 'EXACT_MATCH')); assert.equal(r.input.sources && Object.keys(r.input.sources).length, 0);
});

test('a photo identification fills only what the case lacks and is recorded as the source (no photo is handled here)', async () => {
  const r = await radar(fakeProvider()).search({ input: { name: 'bottle' }, identification: { source: 'PHOTO_VISION', logos: ['Stanley'], models: [], eans: [] } });
  assert.equal(r.input.brand, 'Stanley'); assert.equal(r.input.sources.brand, 'PHOTO_VISION'); assert.equal(r.input.name, 'bottle');
});

test('adapter: a task still in queue is polled, a refused task is an error', async () => {
  let g = 0; const f = async (u) => u.endsWith('/locations') ? json({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] }) : u.endsWith('/task_post') ? json({ tasks: [{ id: 'z', status_code: 20100, cost: 0.002 }] }) : (++g < 3 ? json({ tasks: [{ status_code: 40602 }] }) : json({ tasks: [{ status_code: 20000, result: [{ items: items({ title: 'X', price: 1, currency: 'EUR', url: 'https://u.example/x' }) }] }] }));
  const r = await fetchShoppingListings({ queries: [{ text: 'x', via: 't' }], login: 'a', password: 'b', fetchImpl: f, pollMs: 1, sleep: async () => {} }); assert.equal(r.listings.length, 1); assert.equal(g, 3);
  await assert.rejects(() => fetchShoppingListings({ queries: [{ text: 'x', via: 't' }], login: 'a', password: 'b', fetchImpl: async (u) => (u.endsWith('/locations') ? json({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] }) : json({ tasks: [{ status_code: 40501 }] })), pollMs: 1, sleep: async () => {} }), (e) => e instanceof ProviderError);
});

// ---------- the HTTP route (real server, fake radar)
test('HTTP: token required, status and search answer, error codes reach the client, no credential in the body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nordla-radar-')); const TOKEN = 'radar-token-0123456789-abcdef'; const p = fakeProvider();
  const market = createMarketRadar({ env: ENV, fetchImpl: p.f, ecb: async () => ECB, sleep: async () => {}, pollMs: 1, now: () => new Date('2026-10-19T12:00:00Z') });
  const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port: 0, dir, fetchImpl: async () => { throw new Error('no network'); }, services: { market } });
  const base = `http://127.0.0.1:${server.port}`; const H = { 'x-sourcing-token': TOKEN, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/market/status`)).status, 401);
    const st = await (await fetch(`${base}/api/market/status`, { headers: H })).json(); assert.equal(st.enabled, true); assert.equal(st.photoIdentification.enabled, false);
    const ok = await fetch(`${base}/api/market/search`, { method: 'POST', headers: H, body: JSON.stringify(body()) }); const txt = await ok.text(); assert.equal(ok.status, 200); assert.ok(!txt.includes(SECRET) && !txt.includes(LOGIN)); assert.equal(JSON.parse(txt).listings.length, 3);
    const bad = await fetch(`${base}/api/market/search`, { method: 'POST', headers: H, body: JSON.stringify({ input: {} }) }); assert.equal(bad.status, 400); assert.equal((await bad.json()).error, 'INVALID_INPUT');
    const soon = await fetch(`${base}/api/market/search`, { method: 'POST', headers: H, body: JSON.stringify(body({ input: { name: 'Different thing', brand: 'Acme' } })) }); assert.equal(soon.status, 429); assert.ok(soon.headers.get('retry-after'));
  } finally { await new Promise((r) => server.server.close(r)); rmSync(dir, { recursive: true, force: true }); }
});

// ---------- calibration on REAL titles (Belgian Google Shopping, 19/10/2026)
test('real titles: Dutch piece counts and promotional printing are lots; collaborations, "avec anse" and "met Rietje" are not accessories or lots', () => {
  const input = { name: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L', brand: 'Stanley', traits: {} }; const f = (t) => classifyListing(L(t, 50), input).flags;
  assert.ok(f('5 st. Stanley Quencher H2.0 1200 ml beker').includes(FLAG.PACK_OR_LOT)); assert.ok(f('50st. Stanley Quencher H2.0 FlowState 890 ml gerecyclede').includes(FLAG.PACK_OR_LOT)); assert.ok(f('25 st. Drinkbeker Stanley Quencher H2.0 1200 ml bedrukken met logo').includes(FLAG.PROMO_PRINTED));
  assert.ok(!f('Gobelet Stanley 1913 x LoveShack Fancy Holiday FlowState Quencher 40 oz').includes(FLAG.PACK_OR_LOT)); assert.ok(!f('Stanley 1913 x FARM Rio Quencher H2.0 FlowState').includes(FLAG.PACK_OR_LOT));
  assert.ok(!f('Gourde Stanley Cup Quencher H2.0 FlowState Tumbler 1,18 L avec anse').includes(FLAG.ACCESSORY_SUSPECTED)); assert.ok(!f('Quencher H2.0 FlowState Beker 890 ml met Rietje').includes(FLAG.ACCESSORY_SUSPECTED)); assert.ok(!f('Gourde Stanley Quencher H2.0 1,18 L avec paille').includes(FLAG.ACCESSORY_SUSPECTED));
  assert.ok(f('Stanley 4-Pack Quencher 1.2L Tumbler Straws').includes(FLAG.ACCESSORY_SUSPECTED)); assert.ok(f('Stanley Quencher straw replacement').includes(FLAG.ACCESSORY_SUSPECTED));
});

test('real-world pollution: promotional lots at ~300 € no longer drag the median and hide the consumer prices (they are flagged and kept)', () => {
  const input = { name: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L', brand: 'Stanley', traits: {} };
  const consumer = ['A', 'B', 'C', 'D', 'E', 'F'].map((x, i) => L(`Stanley Quencher H2.0 FlowState Tumbler 1.18L ${x}`, 50 + i * 2));
  const lots = [L('5 st. Stanley Quencher H2.0 1200 ml beker', 297), L('3 st. Stanley Quencher H2.0 1200 ml beker Grijs', 217), L('10 st. - Stanley Quencher H2.0', 532), L('5 st. - Stanley quencher h2.0 1200 ml beker bedrukken', 388), L('4st. Stanley Quencher H2.0 1200 ml beker - Zwart bedrukken', 245)];
  const a = analyseListings([...lots, ...consumer], input, { ecb: ECB });
  assert.equal(a.listings.length, 11); assert.equal(a.reference.matchClass, 'PROBABLE_MATCH'); assert.equal(a.reference.count, 6); assert.ok(a.reference.maxEur <= 60 && a.reference.minEur >= 50);
  assert.ok(a.listings.filter((r) => r.flags.includes(FLAG.PACK_OR_LOT) || r.flags.includes(FLAG.PROMO_PRINTED)).length === 5); assert.ok(!a.listings.some((r) => r.flags.includes(FLAG.PRICE_OUTLIER_LOW)), 'consumer prices must not be called outliers');
});

test('real titles: a different model of the same brand (ProTour) is SIMILAR, the same product with a retailer-style title is PROBABLE, never EXACT without the model', () => {
  const input = { name: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L', brand: 'Stanley', traits: {} }; const c = (title) => classifyListing(L(title, 55), input).matchType;
  assert.equal(c('Stanley The Quencher ProTour Flip Straw Tumbler'), 'SIMILAR_PRODUCT'); assert.equal(c('Gourde Isotherme PSG x Stanley 1913 Quencher ProTour Flip Straw Tumbler'), 'SIMILAR_PRODUCT');
  assert.equal(c('Quencher H2.0 FlowState Tumbler Stanley'), 'PROBABLE_MATCH'); assert.equal(c('Stanley 1913 Quencher H2.0 FlowState Tumbler – koud voor 15 uur'), 'PROBABLE_MATCH');
  assert.equal(c('Gourde Quencher H2.0 FlowState Tumbler - Blue Sky'), 'PROBABLE_MATCH'); // brand absent from the retailer's title: all distinctive words present
  for (const title of ['Stanley Quencher H2.0 FlowState Tumbler', 'Quencher H2.0 FlowState Tumbler Stanley']) assert.notEqual(c(title), 'EXACT_MATCH');
});

test('a listing with NO word in common with the search is flagged NO_TEXT_OVERLAP and never enters a price range (real case: a bare barcode query returned unrelated groceries)', () => {
  const input = { name: 'Nutella', brand: 'Nutella', quantity: '400 g', traits: {} };
  const a = analyseListings([L('Unox Cup a Soep prei Crème 48g', 1.99), L('Chocomel vol 1 liter', 4.15), L('Nutella pâte à tartiner 400 g', 3.89), L('Ferrero Nutella 400g pot', 3.99)], input, { ecb: ECB });
  const by = (t) => a.listings.find((r) => r.title.startsWith(t)); assert.ok(by('Unox').flags.includes(FLAG.NO_TEXT_OVERLAP)); assert.ok(by('Chocomel').excludedFromReference); assert.ok(!by('Nutella').flags.includes(FLAG.NO_TEXT_OVERLAP));
  assert.equal(a.reference.count, 2); assert.ok(a.reference.maxEur < 4.1); assert.equal(a.reference.reliable, false, 'two comparable listings are not enough for a median'); assert.equal(a.reference.medianEur, null); assert.deepEqual(a.reference.pricesEur, [3.89, 3.99]);
  const gtinOnly = analyseListings([L('Anything at all', 5), L('Other thing', 6)], { gtin: '3017620422003', traits: {} }, { ecb: ECB }); assert.equal(gtinOnly.reference.reliable, false); assert.equal(gtinOnly.reference.count, 0); assert.ok(gtinOnly.listings.every((r) => r.flags.includes(FLAG.NO_TEXT_OVERLAP) && r.excludedFromReference), 'a bare barcode search cannot be verified: nothing enters a range');
});

test('once the barcode is resolved to a name the bare number is not searched; the quantity joins the name query', () => {
  const q = queriesFromInput({ name: 'Nutella', brand: 'Nutella', quantity: '400 g', gtin: '3017620422003', gtinResolved: true, traits: {} }, 2); assert.equal(q.length, 1); assert.equal(q[0].text, 'Nutella 400 g'); assert.match(q[0].via, /base ouverte/);
  assert.equal(queriesFromInput({ gtin: '3017620422003', traits: {} }, 2)[0].strength, 'GTIN');
});

test('real Hydro Flask titles: caps, lids, straws and totes are accessories; a bottle sold WITH a cap, or a bare model name, is not', () => {
  const input = { name: 'water bottle', brand: 'Hydro Flask', traits: {} }; const f = (title) => classifyListing(L(title, 30), input).flags;
  for (const title of ['Hydro Flask Standard Mouth Flex Cap', 'Hydro Flask Wide Flex Straw', 'Hydro Flask Closeable Press-In Lid', 'Hydro Flask Insulated Tote 20l', 'Hydro Flask Wide Flex Sip Lid', 'Hydro Flask 32oz / 946ml Flex Chug Cap']) assert.ok(f(title).includes(FLAG.ACCESSORY_SUSPECTED), title);
  for (const title of ['Hydro Flask Wide Flex Cap Thermosfles', 'Hydro Flask Wide Mouth', 'Hydro Flask All Around Travel Tumbler', 'Hydro Flask 20oz Wide Flex Cap Bottle Black']) assert.ok(!f(title).includes(FLAG.ACCESSORY_SUSPECTED), title);
  assert.ok(!classifyListing(L('Hydro Flask Standard Mouth Flex Cap', 30), { name: 'flex cap', brand: 'Hydro Flask', traits: {} }).flags.includes(FLAG.ACCESSORY_SUSPECTED), 'when the owner is looking for a cap, a cap is not an accessory');
});
