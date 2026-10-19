// Contract tests of the isolated market proof: providers are SIMULATED here (fake fetch). They prove the rules, not the real providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validGtin, identifyPhoto, buildQueries, classifyMatch, flattenItems, toEvidence, searchShopping, bolByEan, ecbRates, compareToSupplier, configured, loadEnv } from '../tools/market-proof/lib.mjs';

const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, text: async () => (typeof o === 'string' ? o : JSON.stringify(o)) });
const NOW = () => new Date('2026-10-19T12:00:00Z');

test('GTIN check digit', () => { assert.equal(validGtin('4006381333931'), true); assert.equal(validGtin('4006381333932'), false); assert.equal(validGtin('12345'), false); });

test('no credentials: nothing is searched, nothing is sent, nothing is invented', async () => {
  let called = 0; const f = async () => { called++; return json({}); };
  assert.equal((await identifyPhoto({ imageBase64: 'AAAA', consent: true, env: {}, fetchImpl: f })).status, 'NOT_CONFIGURED');
  const s = await searchShopping({ queries: [{ text: 'x', via: 't', strength: 'NAME_ONLY' }], env: {}, fetchImpl: f }); assert.equal(s.status, 'PROVIDER_NOT_CONFIGURED'); assert.deepEqual(s.evidence, []);
  assert.equal((await bolByEan({ ean: '4006381333931', env: {}, fetchImpl: f })).status, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(called, 0);
});

test('the photo leaves the machine only with consent', async () => {
  let called = 0; const r = await identifyPhoto({ imageBase64: 'AAAA', consent: false, env: { GOOGLE_VISION_API_KEY: 'k' }, fetchImpl: async () => { called++; return json({}); } });
  assert.equal(r.status, 'CONSENT_REQUIRED'); assert.equal(called, 0);
});

test('Vision answer -> best guess, logo, valid EAN and model from the label text', async () => {
  const f = async (url, opt) => { assert.match(url, /images:annotate/); assert.ok(opt.headers['x-goog-api-key']); return json({ responses: [{ webDetection: { bestGuessLabels: [{ label: 'insulated water bottle 500ml' }], webEntities: [{ description: 'Water bottle', score: 0.9 }], pagesWithMatchingImages: [{ url: 'https://shop.example/p', pageTitle: 'Bottle' }] }, textAnnotations: [{ description: 'ACME RB-980HB\n4006381333931\n12345678' }], logoAnnotations: [{ description: 'ACME' }] }] }); };
  const r = await identifyPhoto({ imageBase64: 'AAAA', consent: true, env: { GOOGLE_VISION_API_KEY: 'k' }, fetchImpl: f });
  assert.equal(r.status, 'DONE'); assert.deepEqual(r.eans, ['4006381333931']); assert.ok(r.models.includes('RB-980HB')); assert.equal(r.logos[0], 'ACME');
  const q = buildQueries(r); assert.equal(q[0].strength, 'GTIN'); assert.ok(q.some((x) => x.text === 'ACME RB-980HB'));
});

test('a listing without a link is dropped; a bad price becomes null, never invented', () => {
  const base = { q: { text: 'acme bottle', via: 't' }, country: 'BE', observedAt: NOW().toISOString() };
  assert.equal(toEvidence({ title: 'Bottle', price: 10, currency: 'EUR' }, base), null);
  const ev = toEvidence({ title: 'ACME bottle', price: 'abc', currency: 'EUR', url: 'https://shop.example/x', seller: 'Shop' }, base); assert.equal(ev.price, null); assert.equal(ev.url, 'https://shop.example/x');
  assert.equal(toEvidence({ title: 'ACME bottle', price: 12.5, currency: 'EUR', shopping_url: 'https://g.example/s' }, base).price.amount, 12.5);
});

test('match classes are conservative: EXACT needs a GTIN or the exact model', () => {
  assert.equal(classifyMatch('ACME RB-980HB bottle', { model: 'RB-980HB' }).matchType, 'EXACT_MATCH');
  assert.equal(classifyMatch('Some bottle', { gtinHit: true }).matchType, 'EXACT_MATCH');
  assert.equal(classifyMatch('ACME steel bottle 500ml', { brand: 'ACME', queryText: 'ACME steel bottle' }).matchType, 'PROBABLE_MATCH');
  assert.equal(classifyMatch('Plastic cup', { brand: 'ACME', queryText: 'ACME steel bottle' }).matchType, 'SIMILAR_PRODUCT');
});

test('Shopping flow with a fake DataForSEO: locations -> task_post -> task_get -> sanitized evidence with provenance', async () => {
  const f = async (url, opt = {}) => {
    if (url.endsWith('/locations')) return json({ tasks: [{ result: [{ location_code: 2056, location_name: 'Belgium', country_iso_code: 'BE' }] }] });
    if (url.endsWith('/products/task_post')) { const b = JSON.parse(opt.body)[0]; assert.equal(b.location_code, 2056); assert.equal(b.priority, 2); return json({ tasks: [{ id: 't1', status_code: 20100 }] }); }
    if (url.includes('/task_get/advanced/t1')) return json({ tasks: [{ status_code: 20000, result: [{ items: [
      { type: 'google_shopping_serp', title: 'ACME RB-980HB steel bottle', price: 24.9, currency: 'EUR', seller: 'bol.com', url: 'https://www.bol.com/p/1' },
      { type: 'google_shopping_carousel', items: [{ type: 'google_shopping_carousel_element', title: 'ACME bottle', price: 19, currency: 'EUR', seller: 'Amazon.nl', shopping_url: 'https://google.example/s/2' }, { type: 'google_shopping_carousel_element', title: 'no link', price: 5, currency: 'EUR' }] },
    ] }] }] });
    throw new Error('unexpected ' + url);
  };
  const r = await searchShopping({ queries: [{ text: 'ACME RB-980HB', via: 'test', strength: 'MODEL' }], country: 'BE', env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }, now: NOW, fetchImpl: f, pollMs: 1, ctx: { model: 'RB-980HB', brand: 'ACME' } });
  assert.equal(r.status, 'DONE'); assert.equal(r.evidence.length, 2); // the listing without a link is dropped
  const bol = r.evidence.find((e) => e.seller === 'bol.com'); assert.equal(bol.matchType, 'EXACT_MATCH'); assert.equal(bol.country, 'BE'); assert.equal(bol.observedAt, '2026-10-19T12:00:00.000Z'); assert.equal(bol.price.amount, 24.9); assert.equal(bol.price.vatIncluded, null);
});

test('a provider error is reported, never replaced by invented results', async () => {
  const r = await searchShopping({ queries: [{ text: 'x', via: 't', strength: 'NAME_ONLY' }], env: { DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' }, fetchImpl: async () => json({}, 401), pollMs: 1 });
  assert.equal(r.status, 'ERROR'); assert.deepEqual(r.evidence, []);
});

test('bol official API by EAN: only a real answer with a link is recorded', async () => {
  const env = { BOL_CLIENT_ID: 'a', BOL_CLIENT_SECRET: 'b' };
  const f = async (url) => url.includes('login.bol.com') ? json({ access_token: 't' }) : url.includes('/offers/best') ? json({ price: 19.99 }) : json({ ean: '4006381333931', url: 'https://www.bol.com/nl/p/x/1/' });
  const ok = await bolByEan({ ean: '4006381333931', env, now: NOW, fetchImpl: f }); assert.equal(ok.evidence.length, 1); assert.equal(ok.evidence[0].matchType, 'EXACT_MATCH'); assert.equal(ok.evidence[0].price.amount, 19.99);
  const noLink = await bolByEan({ ean: '4006381333931', env, now: NOW, fetchImpl: async (u) => u.includes('login.bol.com') ? json({ access_token: 't' }) : json({ ean: 'x' }) }); assert.equal(noLink.evidence.length, 0);
  assert.equal((await bolByEan({ ean: '123', env, fetchImpl: f })).status, 'ERROR');
});

test('ECB parsing and comparison arithmetic', async () => {
  const xml = `<gesmes><Cube><Cube time='2026-10-19'><Cube currency='USD' rate='1.1000'/><Cube currency='CNY' rate='7.8000'/></Cube></Cube></gesmes>`;
  const ecb = await ecbRates(async () => json(xml)); assert.equal(ecb.date, '2026-10-19'); assert.equal(ecb.rates.USD, 1.1);
  const ev = [{ matchType: 'EXACT_MATCH', price: { amount: 20, currency: 'EUR' } }, { matchType: 'EXACT_MATCH', price: { amount: 30, currency: 'EUR' } }, { matchType: 'SIMILAR_PRODUCT', price: { amount: 10, currency: 'EUR' } }];
  const c = compareToSupplier({ evidence: ev, supplier: { price: 5.5, currency: 'USD' }, ecb }); assert.equal(c.supplierEur, 5); assert.equal(c.exact.medianEur, 25); assert.equal(c.exact.ratioSupplierToMedian, 0.2); assert.equal(c.similar.count, 1);
  assert.equal(compareToSupplier({ evidence: [], supplier: { price: 5, currency: 'XXX' }, ecb }).supplierEur, null); // unknown currency: no invented conversion
});

test('env file values never leak through configured()', () => { const c = configured({ GOOGLE_VISION_API_KEY: 'secret', DATAFORSEO_LOGIN: 'l' }); assert.deepEqual(c, { vision: true, shopping: false, bol: false }); assert.ok(typeof loadEnv('Z:/missing.env', {}) === 'object'); });
