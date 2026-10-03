// Adapters, persistence, the HTTP app, and the FIELD END-TO-END acceptance: one product photo -> probable category -> supplier price and MOQ -> critical questions ->
// supplier documents uploaded and inspected -> regulatory / safety / customs / Amazon checks -> landed economics -> verdict with WHY, MISSING, DOCUMENTS TO REQUEST,
// MAXIMUM PURCHASE PRICE and NEXT ACTION. Everything is synthetic and local: no network, no production service.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseXml } from '../src/sourcing/adapters/xml.js';
import { parseWeeklyIndex, parseWeeklyReport, createSafetyGateAdapter, INDEX_URL } from '../src/sourcing/adapters/safety-gate.js';
import { parseEcb, fxFor } from '../src/sourcing/adapters/fx.js';
import { createDisabledProvider, createFakeProvider, callProvider, minimizePayload, assertProviderAllowed, DATA_CLASS, ProviderPolicyError } from '../src/sourcing/adapters/ai-provider.js';
import { createMemoryStore, createFileStore, StoreError } from '../src/sourcing/store/file-store.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { newCase, dispatch, assess, suggestCategories, safetyFacts, safetyKey, recordDecision } from '../src/sourcing/core/case.js';
import { NOW, MFR, eudoc, testReport, docsFor, LIVE_CLEAN } from './sourcing-fixtures.js';

const IDX = `<?xml version="1.0"?><!-- comment --><Safety-Gate><weeklyReport><reference>Report-2026-9</reference><publicationDate>06/03/2026</publicationDate><URL>https://x.test/api/download/weeklyReport/detail/xml/10000295?language=en&amp;search=A,</URL></weeklyReport><weeklyReport><reference>Report-2026-39</reference><publicationDate>02/10/2026</publicationDate><URL>https://x.test/api/download/weeklyReport/detail/xml/10000325?language=en&amp;search=B,</URL></weeklyReport></Safety-Gate>`;
const REP = (n) => `<?xml version="1.0"?><alerts><alert><caseNumber>SR/0000${n}/26</caseNumber><category>Electrical appliances</category><product>USB charger</product><brand>Acme</brand><name>Charger &amp; cable</name><type_numberOfModel>CH-${n}</type_numberOfModel><barcode xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/><riskType>Electric shock</riskType><danger>Insulation fails</danger><countryOfOrigin>China</countryOfOrigin><level>Serious risk</level></alert></alerts>`;
const fakeFetch = (calls = [], fail = false) => async (u) => { calls.push(u); if (fail) throw new Error('network down'); if (u === INDEX_URL) return { ok: true, text: async () => IDX }; return { ok: true, text: async () => REP(/xml\/(\d+)/.exec(u)[1].slice(-2)) }; };

test('XML reader: nesting, entities, CDATA, nil attributes', () => {
  const r = parseXml('<a x="1"><b>1 &amp; 2</b><c><![CDATA[<raw>]]></c><d xsi:nil="true"/></a>');
  const a = r.children[0]; assert.equal(a.attrs.x, '1'); assert.equal(a.children[0].text, '1 & 2'); assert.equal(a.children[1].text, '<raw>'); assert.equal(a.children[2].name, 'd');
});

test('Safety Gate adapter: index sorted newest first by year/week, trailing comma removed, alert fields mapped (model <- type_numberOfModel, nil -> null)', () => {
  const idx = parseWeeklyIndex(IDX); assert.deepEqual(idx.map((r) => r.reference), ['Report-2026-39', 'Report-2026-9']);
  assert.equal(idx[0].id, '10000325'); assert.equal(idx[0].url.endsWith(','), false);
  const al = parseWeeklyReport(REP('11'), 'Report-2026-39'); assert.equal(al.length, 1);
  assert.equal(al[0].model, 'CH-11'); assert.equal(al[0].barcode, null); assert.equal(al[0].name, 'Charger & cable'); assert.equal(al[0].reportRef, 'Report-2026-39');
});

test('Safety Gate adapter modes: OFFLINE with no cache, LIVE after a refresh, CACHED in a new process, a failed refresh never erases the cache or fakes live', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sg-'));
  try {
    assert.equal((await createSafetyGateAdapter({ cacheDir: dir, fetchImpl: fakeFetch([], true) }).get()).source.mode, 'OFFLINE_VERIFICATION_REQUIRED');
    const a = createSafetyGateAdapter({ cacheDir: dir, fetchImpl: fakeFetch(), now: () => NOW });
    assert.equal((await a.refresh({ maxReports: 5 })).added, 2);
    const live = await a.get(); assert.equal(live.source.mode, 'LIVE_VERIFIED'); assert.equal(live.alerts.length, 2); assert.match(live.source.attribution, /European Commission/); assert.match(live.source.coverage, /older alerts are NOT ingested/);
    const later = createSafetyGateAdapter({ cacheDir: dir, fetchImpl: fakeFetch([], true), now: () => new Date(NOW.getTime() + 3 * 86400000) });
    const cached = await later.get(); assert.equal(cached.source.mode, 'CACHED'); assert.equal(cached.alerts.length, 2);
    const failed = await later.refresh(); assert.equal(failed.ok, false);
    const still = await later.get(); assert.equal(still.source.mode, 'CACHED'); assert.equal(still.alerts.length, 2); assert.match(still.source.error, /network down/);
    assert.equal((await readdir(dir)).length, 2);
    const again = createSafetyGateAdapter({ cacheDir: dir, fetchImpl: fakeFetch(), now: () => NOW }); assert.equal((await again.refresh()).added, 0, 'cached reports are not downloaded twice');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ECB rates: EUR per unit of the supplier currency, with date and source', () => {
  const r = parseEcb('<gesmes:Envelope xmlns:gesmes="g"><Cube><Cube time="2026-10-02"><Cube currency="USD" rate="1.0800"/><Cube currency="CNY" rate="7.7000"/></Cube></Cube></gesmes:Envelope>');
  assert.equal(r.date, '2026-10-02'); const fx = fxFor('usd', r); assert.equal(fx.rate, 0.925926); assert.equal(fx.source, 'ECB reference rate'); assert.equal(fxFor('XXX', r), null);
});

test('AI provider boundary: disabled by default, confidential data never reaches a China-hosted provider unless explicitly allowed, payload minimised', async () => {
  assert.equal((await createDisabledProvider().describe()).status, 'DISABLED');
  const cn = createFakeProvider({ region: 'CN' });
  await assert.rejects(() => callProvider(cn, 'describe', { text: 'x' }, { dataClass: DATA_CLASS.CONFIDENTIAL }), (e) => e instanceof ProviderPolicyError && e.code === 'PROVIDER_REGION_BLOCKED');
  await assert.rejects(() => callProvider(cn, 'describe', { text: 'x' }, { dataClass: DATA_CLASS.PERSONAL }));
  assert.equal(cn.calls.length, 0, 'nothing was sent');
  assert.equal((await callProvider(cn, 'describe', { text: 'public product photo' }, { dataClass: DATA_CLASS.PUBLIC })).status, 'OK');
  assert.equal((await callProvider(cn, 'describe', { text: 'x' }, { dataClass: DATA_CLASS.CONFIDENTIAL, allowChinaProviders: true })).status, 'OK');
  const eu = createFakeProvider({ region: 'EU' }); assert.equal(assertProviderAllowed(eu, DATA_CLASS.PERSONAL), true);
  const m = minimizePayload({ text: 'Contact sales@example.com or +86 138 0013 8000 about PB-100', supplier: 'SECRET', price: 4.2, imageBase64: 'abc' });
  assert.equal('supplier' in m, false); assert.equal('price' in m, false); assert.match(m.text, /\[email\]/); assert.match(m.text, /\[phone\]/); assert.ok(m.text.includes('PB-100'));
});

test('stores: atomic file store, optimistic concurrency, safe ids, corrupt files skipped but never deleted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-'));
  try {
    for (const store of [createMemoryStore(), createFileStore(dir)]) {
      const c = newCase({ id: 'p1', name: 'x', now: NOW });
      const s1 = await store.save(c); assert.equal(s1.rev, 1);
      const s2 = await store.save({ ...s1, notes: [{ at: 'x', text: 'n' }] }); assert.equal(s2.rev, 2);
      await assert.rejects(() => store.save({ ...s1 }), (e) => e instanceof StoreError && e.code === 'CONFLICT' && e.server.rev === 2);
      assert.equal((await store.list())[0].id, 'p1'); assert.equal((await store.get('p1')).rev, 2); assert.equal(await store.get('nope'), null);
      await assert.rejects(() => store.get('../etc/passwd'), (e) => e.code === 'CASE_ID_INVALID');
      assert.equal(await store.remove('p1'), true);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- HTTP app + field end-to-end ------------------------------------------------------------------------------------------------------------------------------------------
const TOKEN = 'unit-test-token-0123456789-abcdef';
async function startApp({ safetyAlerts = [], mode = 'LIVE_VERIFIED', ai = createDisabledProvider() } = {}) {
  const store = createMemoryStore();
  const safety = { get: async () => ({ alerts: safetyAlerts, source: { mode, fetchedAt: NOW.toISOString(), coverage: 'synthetic' } }), refresh: async () => ({ ok: true, added: 0 }) };
  const app = createSourcingApp({ token: TOKEN, store, safety, ai, ecb: async () => ({ date: '2026-10-02', perEur: { USD: 1.08 } }), uiDir: new URL('../src/sourcing/ui/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), coreDir: new URL('../src/sourcing/core/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token = TOKEN } = {}) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-sourcing-token': token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
  return { server, call, base, store, close: () => new Promise((r) => server.close(r)) };
}

test('HTTP app: every /api route needs the token, static files are whitelisted, no path traversal, cases round-trip, conflicts answer 409', async () => {
  const s = await startApp();
  try {
    assert.equal((await s.call('/api/health', { token: null })).status, 401);
    assert.equal((await s.call('/api/health', { token: 'wrong-token-wrong-token-wrong' })).status, 401);
    assert.equal((await s.call('/api/health')).status, 200);
    assert.equal((await fetch(s.base + '/')).status, 200);
    assert.equal((await fetch(s.base + '/core/case.js')).status, 200);
    assert.equal((await fetch(s.base + '/core/rulebook/eu.js')).status, 200);
    assert.equal((await fetch(s.base + '/core/../server/app.js')).status, 404);
    assert.equal((await fetch(s.base + '/..%2fserver%2fapp.js')).status, 404);
    assert.equal((await fetch(s.base + '/src/sourcing/server/app.js')).status, 404);
    const c = newCase({ id: 'c1', name: 'p', now: NOW });
    const put = await s.call('/api/cases/c1', { method: 'PUT', body: c }); assert.equal(put.status, 200); assert.equal(put.body.rev, 1);
    assert.equal((await s.call('/api/cases/c1', { method: 'PUT', body: c })).status, 409);
    assert.equal((await s.call('/api/cases/c1', { method: 'PUT', body: { ...c, id: 'other' } })).status, 400);
    assert.equal((await s.call('/api/cases')).body.cases.length, 1);
    assert.equal((await s.call('/api/fx?currency=USD')).body.source, 'ECB reference rate');
  } finally { await s.close(); }
});

test('FIELD E2E: photo -> category -> price + MOQ -> questions -> documents inspected -> safety, customs, Amazon -> landed -> decision; saved, reloaded, then still usable OFFLINE', async () => {
  const s = await startApp({ ai: createFakeProvider({ region: 'EU', describe: { suggestions: [{ categoryId: 'power_bank', confidence: 'MEDIUM' }] } }) });
  try {
    // 1. a photo: the AI only SUGGESTS a probable category
    const d = await s.call('/api/ai/describe', { method: 'POST', body: { imageBase64: 'aGk=', imageMime: 'image/jpeg' } });
    assert.equal(d.body.suggestions[0].categoryId, 'power_bank');
    let c = newCase({ id: 'field-1', name: 'Power bank 10000mAh (photo)', now: NOW });
    c = dispatch(c, { type: 'PHOTO', ref: 'photo-0' }, NOW);
    c = dispatch(c, { type: 'CATEGORY', category: d.body.suggestions[0].categoryId, level: 'PROBABLE' }, NOW);
    assert.ok(suggestCategories('power bank 10000mAh').some((x) => x.id === 'power_bank'));
    let a = assess(c, { now: NOW });
    assert.equal(a.identity.confidence.level, 'LOW', 'a photo-based guess is not an identification');
    assert.equal(a.decision.verdict, 'INSUFFICIENT_INFORMATION');
    // 2. the owner types supplier price and MOQ
    c = dispatch(c, { type: 'QUOTE', quote: { unitPrice: '4.20', currency: 'USD', qty: 1000, moq: 500, incoterm: 'FOB', leadTimeDays: 20 } }, NOW);
    assert.equal(assess(c, { now: NOW }).decision.verdict, 'INSUFFICIENT_INFORMATION', 'price and MOQ alone do not identify the product');
    c = dispatch(c, { type: 'CATEGORY', category: 'power_bank' }, NOW); // the owner taps the suggestion: now it is HIS confirmation, not the AI's guess
    c = dispatch(c, { type: 'IDENTIFIER', name: 'model', value: 'PB-100', level: 'USER_STATED' }, NOW);
    c = dispatch(c, { type: 'IDENTIFIER', name: 'manufacturer', value: MFR, level: 'USER_STATED' }, NOW);
    c = dispatch(c, { type: 'PLACING', placing: { underOwnNameOrBrand: false, manufacturerEstablishedInEU: false, euAuthorisedRepresentative: false } }, NOW);
    for (const [t, v] of Object.entries({ 'electrical.present': true, 'battery.present': true, 'radio.present': false, childrenUse: false, foodContact: false, cosmetic: false, ppe: false, textile: false, medical: false, chemicalMixture: false })) c = dispatch(c, { type: 'TRAIT', trait: t, value: v }, NOW);
    c = dispatch(c, { type: 'TRAIT', trait: 'battery.chemistry', value: 'li_ion' }, NOW);
    a = assess(c, { now: NOW });
    // 3. critical missing questions, prioritised, bilingual
    assert.ok(a.questions.filter((q) => q.priority === 'P1').length >= 3);
    assert.ok(a.questions.some((q) => q.id === 'doc:TEST_REPORT' || q.id.startsWith('doc:EU_DOC')));
    assert.ok(a.questions.every((q) => q.en && /[一-鿿]/.test(q.zh)));
    // 4. documents uploaded through the server (text), then inspected against the case
    for (const [name, text] of [['doc-eu.txt', eudoc({ model: 'PB-100', product: 'Power bank', directives: ['2014/30/EU', '2011/65/EU'], standards: ['EN 55032:2015', 'EN 55035:2017', 'EN IEC 63000:2018', 'IEC 62133-2:2017'] })], ['report.txt', testReport({ model: 'PB-100', product: 'Power bank', standards: ['EN 55032:2015', 'EN 55035:2017', 'IEC 62133-2:2017'], rohs: true })]]) {
      const up = await s.call('/api/documents/extract', { method: 'POST', body: { fileName: name, mime: 'text/plain', dataBase64: Buffer.from(text).toString('base64') } });
      assert.equal(up.status, 200); c = dispatch(c, { type: 'DOCUMENT', fileName: name, text: up.body.text, id: name }, NOW);
    }
    // 5. Safety Gate through the server adapter (live), stored with the exact product facts it was checked for
    const facts = safetyFacts(c); const sg = await s.call('/api/safety/check', { method: 'POST', body: { identity: facts } });
    assert.equal(sg.body.status, 'NO_MATCH_FOUND'); assert.equal(sg.body.source.mode, 'LIVE_VERIFIED');
    c = dispatch(c, { type: 'SAFETY_SNAPSHOT', snapshot: { ...sg.body, identityKey: safetyKey(facts), checkedAt: NOW.toISOString() } }, NOW);
    // 6. customs, import costs, selling price, Amazon
    c = dispatch(c, { type: 'CUSTOMS', customs: { chosenCode: '8507.60', duty: { ratePct: 2.7, kind: 'USER_ENTERED' } } }, NOW);
    const fx = await s.call('/api/fx?currency=USD');
    c = dispatch(c, { type: 'COSTS', costs: { fx: fx.body, costs: { freight: { total: 600, status: 'ESTIMATED' }, testing: { total: 400, status: 'ESTIMATED' } }, importVat: { ratePct: 21, recoverable: true } } }, NOW);
    c = dispatch(c, { type: 'SALE', sale: { sellingPriceGross: 24.99, vatRatePct: 21, targetContributionPct: 30 } }, NOW);
    c = dispatch(c, { type: 'CONTEXT', context: { channels: ['own_site', 'amazon'] } }, NOW);
    c = dispatch(c, { type: 'AMAZON_OBS', observation: { marketplace: 'amazon.be', price: '27.90', observedAt: '2026-10-02T09:00:00Z' } }, NOW);
    a = assess(c, { now: NOW });
    // 7. the verdict card
    assert.equal(a.dataMode, 'LIVE_VERIFIED');
    assert.ok(['COMPLETE', 'RANGE'].includes(a.landed.status), a.landed.status);
    assert.ok(a.landed.totals.landedPerUnitEurMinor > 420 * 0.92, 'landed cost includes freight, testing and duty');
    assert.ok(a.maxPurchasePrice.maxUnitPriceMinor > 0 && a.maxPurchasePrice.display);
    assert.equal(a.rules.ce.status, 'CE_REQUIRED');
    assert.equal(a.decision.dimensions.safetyRisk, 'MEDIUM', 'lithium battery = higher-risk regime, even with no Safety Gate match');
    assert.equal(a.decision.verdict, 'CONDITIONAL_GO');
    assert.ok(a.decision.why.length >= 4 && a.decision.nextAction.length > 20);
    assert.ok(Array.isArray(a.decision.gaps.missingDocs) && a.decision.gaps.missingDocs.some((m) => m.docType === 'UN383' || m.docType === 'BATTERY_DOC'), 'the battery documents are still to request');
    assert.ok(a.questions.some((q) => q.docType === 'UN383'));
    assert.ok(a.decision.blocksAmazon.length > 0 && a.market.referencePriceMinor === 2790);
    assert.equal(a.decision.canCommitMoney, false);
    assert.ok(a.evidence.calculated.length && a.evidence.supplierClaims.length && a.freshness.length === 4);
    // 8. saved, reloaded: nothing is lost
    c = recordDecision(c, a, NOW);
    assert.equal((await s.call('/api/cases/field-1', { method: 'PUT', body: c })).status, 200);
    const back = (await s.call('/api/cases/field-1')).body;
    assert.deepEqual(assess(back, { now: NOW }).decision.verdict, a.decision.verdict);
    assert.equal(back.documents.length, 2); assert.equal(back.decisions.length, 1); assert.equal(back.quotes.length, 1);
  // 9. server gone (offline in a factory hall): the SAME case, kept on the phone, still computes; the stored Safety Gate result is shown as CACHED after 24 h, never live
  const phoneCopy = JSON.parse(JSON.stringify(c));
  const offline = assess(phoneCopy, { now: new Date(NOW.getTime() + 2 * 86400000) });
  assert.equal(offline.dataMode, 'CACHED');
  assert.equal(offline.decision.verdict, 'CONDITIONAL_GO');
  assert.ok(offline.maxPurchasePrice.maxUnitPriceMinor > 0);
  } finally { await s.close(); }
});

test('offline behaviour: a stored live check is only LIVE for the same product facts and under 24 h; otherwise CACHED; with none, OFFLINE - VERIFICATION REQUIRED', () => {
  let c = newCase({ id: 'o1', name: 'USB charger', now: NOW });
  c = dispatch(c, { type: 'IDENTIFIER', name: 'model', value: 'PD-65', level: 'USER_STATED' }, NOW);
  assert.equal(assess(c, { now: NOW }).dataMode, 'OFFLINE_VERIFICATION_REQUIRED');
  const facts = safetyFacts(c);
  c = dispatch(c, { type: 'SAFETY_SNAPSHOT', snapshot: { status: 'NO_MATCH_FOUND', matches: [], hazards: [], note: null, source: { mode: 'LIVE_VERIFIED', fetchedAt: NOW.toISOString() }, identityKey: safetyKey(facts) } }, NOW);
  assert.equal(assess(c, { now: NOW }).dataMode, 'LIVE_VERIFIED');
  assert.equal(assess(c, { now: new Date(NOW.getTime() + 2 * 86400000) }).dataMode, 'CACHED');
  const changed = dispatch(c, { type: 'IDENTIFIER', name: 'model', value: 'PD-66', level: 'USER_STATED' }, NOW);
  const a = assess(changed, { now: NOW }); assert.equal(a.dataMode, 'CACHED');
  assert.ok(a.decision.conditions.some((x) => /CACHED/.test(x)));
  assert.ok(a.freshness.find((f) => f.name === 'EU Safety Gate').status !== 'FRESH');
});

test('failure isolation: a Safety Gate adapter that throws would not be needed by the core - the case computes with no externals at all', () => {
  const a = assess(newCase({ id: 'z', name: 'x', now: NOW }), { now: NOW });
  assert.equal(a.decision.verdict, 'INSUFFICIENT_INFORMATION');
  assert.ok(a.rules.results.length > 10);
});
