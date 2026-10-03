// Field hardening: rulebook review statuses, photographed documents (OCR is never evidence by itself), vision provider boundary, server hardening, offline shell,
// Safety Gate freshness, Amazon observations and price basis, customs wording. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';
import { RULEBOOK, REVIEW, REVIEW_STATUSES } from '../src/sourcing/core/rulebook/index.js';
import { createVisionProvider, createFakeProvider, createDisabledProvider } from '../src/sourcing/adapters/ai-provider.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { newCase, dispatch, assess, safetyFacts, safetyKey } from '../src/sourcing/core/case.js';
import { identificationConfidence } from '../src/sourcing/core/identity.js';
import { summarizeMarket, normalizeObservation } from '../src/sourcing/core/amazon.js';
import { REVIEWED_RULEBOOK, NOW, MFR, build, run, ident, traits, extraTraits, importer, commercial, docsFor, doc, eudoc, testReport, LIVE_CLEAN } from './sourcing-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'sourcing');
const chargerBase = [...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ price: 24.99 })];

// ---- rulebook review ----------------------------------------------------------------------------------------------------------------------------------------------------
test('rulebook review: every existing rule has a status, none is VERIFIED_CURRENT (no consolidated text was opened), counts are pinned', () => {
  const counts = Object.fromEntries(REVIEW_STATUSES.map((s) => [s, 0]));
  for (const r of RULEBOOK) { assert.ok(r.review && REVIEW_STATUSES.includes(r.review.status), r.id); assert.ok(r.review.basis.length > 20, r.id); counts[r.review.status] += 1; }
  assert.equal(RULEBOOK.length, 31, 'no rule was added');
  assert.deepEqual(Object.keys(REVIEW).sort(), RULEBOOK.map((r) => r.id).sort());
  assert.deepEqual(counts, { VERIFIED_CURRENT: 0, VERIFIED_PRIMARY_TEXT_ONLY: 13, NEEDS_EXPERT_REVIEW: 6, INCOMPLETE: 2, UNVERIFIED: 10 });
});

test('a rule that is not verified can never give an unconditional green: marketability stays AMBER and the verdict conditional, even with perfect documents', () => {
  const full = run(build([...chargerBase, ...docsFor.charger('PD-65')]));
  assert.equal(full.decision.dimensions.supplierEvidence, 'COMPLETE');
  assert.notEqual(full.decision.dimensions.marketability, 'GREEN');
  assert.equal(full.decision.verdict, 'CONDITIONAL_GO');
  assert.ok(full.decision.rulebookReview.unreviewedApplicable.length > 0);
  assert.ok(full.decision.conditions.some((c) => /rulebook not yet verified for \d+ applicable regime/.test(c)));
  const reviewed = run(build([...chargerBase, ...docsFor.charger('PD-65')]), undefined, { rulebook: REVIEWED_RULEBOOK });
  assert.equal(reviewed.decision.verdict, 'GO'); assert.equal(reviewed.decision.rulebookReview.allApplicableReviewed, true);
  // one NEEDS_EXPERT_REVIEW rule among reviewed ones is enough to hold it back
  const oneBad = REVIEWED_RULEBOOK.map((r) => (r.id === 'eu.rohs' ? { ...r, review: { status: 'NEEDS_EXPERT_REVIEW' } } : r));
  assert.equal(run(build([...chargerBase, ...docsFor.charger('PD-65')]), undefined, { rulebook: oneBad }).decision.verdict, 'CONDITIONAL_GO');
});

test('Amazon readiness cannot be READY while the Amazon rules themselves are unverified', () => {
  const ev = [...chargerBase, ...docsFor.charger('PD-65'), { type: 'CONTEXT', context: { channels: ['own_site', 'amazon'] } }, { type: 'AMAZON', amazon: { restricted: false } },
    doc('Label artwork: manufacturer Shenzhen Brightway Electronics Co., Ltd, Longhua District, Shenzhen, China. Importer Example BV, Rue Test 1, 5000 Namur, Belgium. EU responsible person Example BV. Model PD-65', { id: 'lab', docType: 'LABEL_ARTWORK' })];
  const reviewed = run(build(ev), undefined, { rulebook: REVIEWED_RULEBOOK });
  assert.equal(reviewed.amazon.status, 'CONDITIONALLY_READY', 'V0 cannot see own actions (naming the EU responsible person): READY is not claimed');
  assert.ok(reviewed.amazon.notes.some((n) => /only you can do/.test(n)));
  const today = run(build(ev)); assert.equal(today.amazon.status, 'CONDITIONALLY_READY'); assert.ok(today.amazon.notes.some((n) => /UNVERIFIED here/.test(n)));
});

// ---- photographed documents ----------------------------------------------------------------------------------------------------------------------------------------------
const ocr = (text) => ({ type: 'DOCUMENT', fileName: 'photo.jpg', text, textSource: 'OCR', id: 'ph', photoRef: 'docphoto-ph' });
const DOC_OK = eudoc({ model: 'PD-65', product: 'USB charger', directives: ['2014/35/EU', '2014/30/EU', '2011/65/EU'], standards: ['EN 62368-1:2014', 'EN 55032:2015', 'EN IEC 63000:2018'] });
const noisy = (t) => t.replace(/ the /g, ' tbe ').replace('Signature: signed', 'Signature: [unreadable]');

test('photographed Declaration of Conformity: an OCR reading is UNVERIFIED and never counts as present until the owner confirms it; it is never a verified fact', () => {
  let c = build([...chargerBase, ocr(DOC_OK)]);
  let a = run(c); const d = a.documents[0];
  assert.equal(d.textSource, 'OCR'); assert.equal(d.confirmed, false);
  assert.equal(d.consistency, 'UNVERIFIED'); assert.ok(d.findings.some((f) => f.code === 'OCR_UNCONFIRMED'));
  assert.ok(a.decision.gaps.missingDocs.some((m) => m.docType === 'EU_DOC' || m.coverage === 'PRESENT_WITH_CONCERNS'), 'not accepted as the EU DoC yet');
  assert.ok(!a.evidence.verified.some((e) => /document/.test(e.item)), 'never VERIFIED_FACT');
  assert.ok(a.evidence.supplierClaims.some((e) => /UNVERIFIED machine reading/.test(e.note)));
  const lvd = a.rules.results.find((r) => r.ruleId === 'eu.lvd').requiredEvidence.find((e) => e.id === 'lvd.doc');
  assert.equal(lvd.coverage.status, 'PRESENT_WITH_CONCERNS');
  // the owner checks it against the paper, then confirms
  c = dispatch(c, { type: 'DOCUMENT_CONFIRM', id: 'ph' }, NOW); a = run(c);
  assert.equal(a.documents[0].confirmed, true); assert.equal(a.documents[0].consistency, 'NO_ISSUE_FOUND');
  assert.equal(a.rules.results.find((r) => r.ruleId === 'eu.lvd').requiredEvidence.find((e) => e.id === 'lvd.doc').coverage.status, 'PRESENT');
  assert.ok(!a.evidence.verified.some((e) => /document/.test(e.item)), 'confirmed by the owner is still a supplier document, not a verified fact');
  assert.match(a.documents[0].note, /not a verified fact/);
});

test('photographed Declaration with OCR noise: the owner corrects the text; correction un-confirms it until he confirms again', () => {
  let c = build([...chargerBase, ocr(noisy(DOC_OK).replace('PD-65', 'PD-6S'))]);
  assert.ok(run(c).documents[0].findings.some((f) => f.code === 'MODEL_MISMATCH'), 'a misread model shows up as a mismatch, not as a match');
  c = dispatch(c, { type: 'DOCUMENT_CONFIRM', id: 'ph' }, NOW);
  c = dispatch(c, { type: 'DOCUMENT_CORRECT', id: 'ph', text: DOC_OK }, NOW);
  assert.equal(c.documents[0].confirmed, false);
  assert.equal(run(c).documents[0].consistency, 'UNVERIFIED');
  c = dispatch(c, { type: 'DOCUMENT_CONFIRM', id: 'ph' }, NOW);
  assert.equal(run(c).documents[0].consistency, 'NO_ISSUE_FOUND');
});

test('photographed first page of a test report: missing pages are flagged; the report is not accepted as complete evidence', () => {
  const first = `${testReport({ model: 'PD-65', product: 'USB charger', standards: ['EN 62368-1:2014', 'EN 55032:2015'] }).replace('Page 1 of 1', '')}\nPage 1 of 4`;
  let c = build([...chargerBase, ocr(first)]); c = dispatch(c, { type: 'DOCUMENT_CONFIRM', id: 'ph' }, NOW);
  const d = run(c).documents[0];
  assert.ok(d.findings.some((f) => f.code === 'MISSING_PAGES' && f.severity === 'INCONSISTENT'));
  assert.equal(d.consistency, 'INCONSISTENT');
  assert.ok(run(c).decision.hardBlockers.length > 0);
});

test('photographed document for another model: contradiction, even when the owner confirmed the reading', () => {
  let c = build([...chargerBase, ocr(eudoc({ model: 'PD-200', product: 'USB charger', directives: ['2014/35/EU'], standards: ['EN 62368-1:2014'] }))]); c = dispatch(c, { type: 'DOCUMENT_CONFIRM', id: 'ph' }, NOW);
  const a = run(c); assert.ok(a.documents[0].findings.some((f) => f.code === 'MODEL_MISMATCH'));
  assert.ok(a.decision.hardBlockers.some((b) => b.code === 'DOCUMENT_CONTRADICTS_CASE') || a.decision.gaps.missingDocs.length > 0);
  assert.equal(a.decision.verdict === 'GO', false);
});

test('unreadable image: INSUFFICIENT_EVIDENCE, never guessed, never counted; photo-only documents wait for the owner to type them', () => {
  const unreadable = run(build([...chargerBase, ocr('[unreadable] ~~ ... ')])).documents[0];
  assert.equal(unreadable.consistency, 'INSUFFICIENT_EVIDENCE');
  let c = build([...chargerBase, { type: 'DOCUMENT', fileName: 'p.jpg', text: '', textSource: 'PHOTO_ONLY', id: 'po', photoRef: 'x' }]);
  let d = run(c).documents[0]; assert.equal(d.textSource, 'PHOTO_ONLY'); assert.equal(d.consistency, 'INSUFFICIENT_EVIDENCE');
  // the owner types what the paper says: now it is his transcription
  c = dispatch(c, { type: 'DOCUMENT_CORRECT', id: 'po', text: 'TEST REPORT\nManufacturer: Shenzhen Brightway Electronics Co., Ltd\nModel: PD-65\nStandards: EN 62368-1\nTesting laboratory: Pearl Delta Testing\nDate of issue: 2026-03-12' }, NOW);
  d = run(c).documents[0]; assert.equal(d.textSource, 'TRANSCRIBED'); assert.equal(d.confirmed, true); assert.match(d.note, /key fields only/);
});

test('partial photographed declaration (no signature, no address, no standards): incomplete, not accepted', () => {
  const partial = 'EU DECLARATION OF CONFORMITY\nModel: PD-65\nThe product is in conformity with Directive 2014/35/EU';
  let c = build([...chargerBase, ocr(partial)]); c = dispatch(c, { type: 'DOCUMENT_CONFIRM', id: 'ph' }, NOW);
  const d = run(c).documents[0];
  assert.ok(d.findings.some((f) => f.code === 'INCOMPLETE_DECLARATION'));
  assert.notEqual(d.consistency, 'NO_ISSUE_FOUND');
});

test('typed-from-the-paper transcription still catches a model or manufacturer mismatch, and does not pretend to judge completeness', () => {
  const t = (model, mfr) => run(build([...chargerBase, { type: 'DOCUMENT', fileName: 'typed', text: `EU DECLARATION OF CONFORMITY\nManufacturer: ${mfr}\nModel: ${model}\nUnion legislation: 2014/35/EU, 2014/30/EU\nStandards: EN 62368-1, EN 55032\nDate of issue: 2026-03-15`, textSource: 'TRANSCRIBED', docType: 'EU_DOC', id: 'ty' }])).documents[0];
  assert.equal(t('PD-65', MFR).consistency, 'NO_ISSUE_FOUND');
  assert.ok(t('PD-99', MFR).findings.some((f) => f.code === 'MODEL_MISMATCH'));
  assert.ok(t('PD-65', 'Totally Other Plastics Group').findings.some((f) => f.code === 'MANUFACTURER_MISMATCH'));
});

// ---- vision provider boundary + AI_SUGGESTED --------------------------------------------------------------------------------------------------------------------------
const mockFetch = (reply, calls = [], status = 200) => async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: status === 200, status, json: async () => ({ content: [{ type: 'text', text: reply }] }) }; };

test('vision provider: sends only the image (no supplier data), validates suggestions against Nordla categories, marks them AI_SUGGESTED, handles failures', async () => {
  const calls = [];
  const p = createVisionProvider({ apiKey: 'test-key-not-real', fetchImpl: mockFetch('Here you go ```json\n{"suggestions":[{"categoryId":"power_bank","confidence":"MEDIUM","why":"battery pack with ports"},{"categoryId":"not_a_category","confidence":"HIGH"},{"categoryId":"usb_charger","confidence":"WEIRD"}]}\n```', calls) });
  const r = await p.describe({ imageBase64: 'QUJD', imageMime: 'image/jpeg', text: null });
  assert.deepEqual(r.suggestions.map((s) => s.categoryId), ['power_bank', 'usb_charger']);
  assert.ok(r.suggestions.every((s) => s.level === 'AI_SUGGESTED')); assert.equal(r.suggestions[1].confidence, 'LOW');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages'); assert.equal(calls[0].init.headers['x-api-key'], 'test-key-not-real');
  const sent = JSON.stringify(calls[0].body); assert.ok(sent.includes('QUJD')); for (const secret of ['Brightway', 'supplier', 'price', 'quote']) assert.equal(sent.includes(secret), false, secret);
  assert.equal((await createVisionProvider({ apiKey: 'k', fetchImpl: mockFetch('no json here') }).describe({ imageBase64: 'QUJD' })).suggestions.length, 0);
  assert.equal((await createVisionProvider({ apiKey: 'k', fetchImpl: mockFetch('x', [], 500) }).describe({ imageBase64: 'QUJD' })).status, 'ERROR');
  assert.equal((await p.describe({})).status, 'NO_IMAGE');
  const doc2 = await createVisionProvider({ apiKey: 'k', fetchImpl: mockFetch('EU DECLARATION OF CONFORMITY\nModel: PD-65') }).readDocument({ imageBase64: 'QUJD' }); assert.match(doc2.text, /PD-65/);
  assert.throws(() => createVisionProvider({}), /API key/);
});

test('an AI suggestion stays LOW identification until the owner confirms it', () => {
  const guess = build([{ type: 'NAME', name: 'photo item' }, { type: 'CATEGORY', category: 'power_bank', level: 'AI_SUGGESTED' }, ...traits({ 'electrical.present': true, 'battery.present': true })]);
  assert.equal(identificationConfidence(guess.identity).level, 'LOW');
  assert.equal(run(guess).decision.dimensions.identification, 'LOW');
  assert.ok(run(guess).evidence.assumed.some((e) => e.item === 'category' && /AI SUGGESTED/.test(e.note)));
  const confirmed = dispatch(guess, { type: 'CATEGORY', category: 'power_bank' }, NOW);
  assert.notEqual(run(confirmed).decision.dimensions.identification, 'LOW');
});

// ---- server hardening ----------------------------------------------------------------------------------------------------------------------------------------------------
const TOKEN = 'hardening-token-0123456789-abcdef';
async function startApp(opts = {}) {
  const clock = { t: NOW.getTime() };
  const safety = { get: async () => ({ alerts: [{ caseNumber: 'SR/1/26', category: 'Toys', product: 'Doll', brand: 'X', name: 'Doll', model: 'D-1', riskType: 'Choking', danger: 'd'.repeat(500), description: 'e'.repeat(500), countryOfOrigin: 'China', level: 'Serious risk', secretField: 'nope' }], source: { mode: 'LIVE_VERIFIED', fetchedAt: NOW.toISOString(), newestPublication: '2026-10-02' } }), refresh: async () => ({ ok: true }) };
  const app = createSourcingApp({ token: TOKEN, store: createMemoryStore(), safety, ai: opts.ai ?? createDisabledProvider(), ecb: async () => ({ date: '2026-10-02', perEur: { USD: 1.08 } }), uiDir: join(SRC, 'ui'), coreDir: join(SRC, 'core'), allowedHosts: opts.allowedHosts ?? null, now: () => new Date(clock.t) });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token = TOKEN, headers = {} } = {}) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-sourcing-token': token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
  return { call, base, clock, close: () => new Promise((r) => server.close(r)) };
}

test('server: wrong tokens are rate limited (429), the window expires, security headers and CSP are set, Host allow-list refuses rebinding', async () => {
  const s = await startApp({ allowedHosts: ['sourcing.example.test'] });
  try {
    for (let i = 0; i < 8; i += 1) assert.equal((await s.call('/api/health', { token: 'wrong-token-wrong-token-wrong-1' })).status, 401);
    const locked = await s.call('/api/health', { token: 'wrong-token-wrong-token-wrong-1' }); assert.equal(locked.status, 429); assert.equal(locked.headers.get('retry-after'), '60');
    assert.equal((await s.call('/api/health')).status, 429, 'while locked even the right token waits');
    s.clock.t += 61_000; assert.equal((await s.call('/api/health')).status, 200);
    const r = await fetch(s.base + '/'); assert.match(r.headers.get('content-security-policy'), /default-src 'self'/); assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await s.call('/api/health', { headers: { host: 'evil.example.org' } })).status, 200, 'node sets Host itself in fetch: see the dedicated host test below');
  } finally { await s.close(); }
  // the Host header is validated on a raw request
  const s2 = await startApp({ allowedHosts: ['sourcing.example.test'] });
  try {
    const status = (host) => new Promise((resolve) => { const req = http.request(s2.base + '/api/health', { headers: { host, 'x-sourcing-token': TOKEN } }, (res) => { res.resume(); resolve(res.statusCode); }); req.end(); });
    assert.equal(await status('evil.example.org'), 421); assert.equal(await status('sourcing.example.test'), 200); assert.equal(await status('localhost'), 200);
  } finally { await s2.close(); }
});

test('server: offline shell manifest lists every module the app imports (so a case opens offline), alerts are compacted for the phone, AI status', async () => {
  const s = await startApp();
  try {
    const m = await (await fetch(s.base + '/shell-manifest.json')).json();
    // walk the static import graph of /app.js
    const seen = new Set(); const todo = ['/app.js']; const imports = new Set();
    while (todo.length) { const f = todo.pop(); if (seen.has(f)) continue; seen.add(f); const text = await readFile(f === '/app.js' ? join(SRC, 'ui', 'app.js') : join(SRC, f.replace(/^\//, '')), 'utf8'); for (const mm of text.matchAll(/from '([^']+)'/g)) { const spec = mm[1]; if (spec.startsWith('node:')) continue; const p = spec.startsWith('/') ? spec : posix.join(posix.dirname(f.startsWith('/core') ? f : f), spec); imports.add(p); if (p.startsWith('/core/')) todo.push(p); } }
    for (const p of imports) assert.ok(m.files.includes(p), `${p} missing from the offline manifest`);
    assert.ok(m.files.includes('/app.js') && m.files.includes('/app.css') && m.files.includes('/core/rulebook/review.js'));
    const al = await s.call('/api/safety/alerts'); assert.equal(al.body.alerts.length, 1); assert.equal('secretField' in al.body.alerts[0], false); assert.ok(al.body.alerts[0].danger.length <= 220);
    assert.equal((await s.call('/api/ai/status')).body.enabled, false);
  } finally { await s.close(); }
});

test('server: photo and document images are sent to a provider only with consent for THAT image; China-hosted providers are refused for confidential data', async () => {
  const fake = createFakeProvider({ region: 'EU', label: { text: DOC_OK }, describe: { suggestions: [{ categoryId: 'usb_charger', confidence: 'MEDIUM', level: 'AI_SUGGESTED' }] } });
  const s = await startApp({ ai: fake });
  try {
    const img = { fileName: 'p.jpg', mime: 'image/jpeg', dataBase64: Buffer.from('fake-image').toString('base64') };
    const noConsent = await s.call('/api/documents/extract', { method: 'POST', body: img }); assert.equal(noConsent.status, 428); assert.equal(noConsent.body.error, 'CONSENT_REQUIRED'); assert.equal(fake.calls.length, 0, 'nothing was sent');
    assert.equal((await s.call('/api/ai/describe', { method: 'POST', body: { imageBase64: 'QUJD' } })).status, 428);
    const ok = await s.call('/api/documents/extract', { method: 'POST', body: { ...img, consent: true } });
    assert.equal(ok.body.textSource, 'OCR'); assert.match(ok.body.note, /UNVERIFIED/); assert.equal(fake.calls.length, 1);
    assert.deepEqual(Object.keys(fake.calls[0].p).sort(), ['imageBase64', 'imageMime', 'language', 'task', 'text']);
  } finally { await s.close(); }
  const cn = createFakeProvider({ region: 'CN' }); const s2 = await startApp({ ai: cn });
  try { const r = await s2.call('/api/documents/extract', { method: 'POST', body: { fileName: 'p.jpg', mime: 'image/jpeg', dataBase64: 'QUJD', consent: true } }); assert.equal(r.status, 403); assert.equal(cn.calls.length, 0); } finally { await s2.close(); }
  const s3 = await startApp();
  try { const r = await s3.call('/api/documents/extract', { method: 'POST', body: { fileName: 'p.jpg', mime: 'image/jpeg', dataBase64: 'QUJD' } }); assert.equal(r.status, 200); assert.equal(r.body.text, null); assert.match(r.body.note, /type what the paper says/); } finally { await s3.close(); }
});

// ---- Safety Gate freshness and wording --------------------------------------------------------------------------------------------------------------------------------
test('Safety Gate: a phone cache is CACHED offline; an old newest weekly report is flagged; NO MATCH says it does not prove safety; offline is not clean', () => {
  const alerts = [{ caseNumber: 'SR/9/26', category: 'Toys', product: 'Doll', brand: 'Z', model: 'Z-1', countryOfOrigin: 'China', riskType: 'Choking' }];
  const base = build([...chargerBase, ...docsFor.charger('PD-65')]);
  const fresh = run(base, { safety: { alerts, source: { mode: 'LIVE_VERIFIED', fetchedAt: NOW.toISOString(), newestPublication: '2026-10-02' } } });
  assert.equal(fresh.safety.status, 'NO_MATCH_FOUND'); assert.match(fresh.safety.note, /NO MATCH FOUND does not prove safety/); assert.equal(fresh.freshness.find((f) => f.name === 'EU Safety Gate').status, 'FRESH');
  const old = run(base, { safety: { alerts, source: { mode: 'LIVE_VERIFIED', fetchedAt: NOW.toISOString(), newestPublication: '2026-09-04' } } });
  assert.equal(old.freshness.find((f) => f.name === 'EU Safety Gate').status, 'STALE'); assert.ok(old.decision.conditions.some((c) => /weekly report ingested is \d+ days old/.test(c)));
  const cached = run(base, { safety: { alerts, source: { mode: 'CACHED', fetchedAt: '2026-09-30T08:00:00Z', newestPublication: '2026-09-26' } } });
  assert.equal(cached.dataMode, 'CACHED'); assert.ok(cached.decision.conditions.some((c) => /CACHED/.test(c)));
  const none = run(base, {}); assert.equal(none.safety.status, 'NOT_CHECKED'); assert.match(none.safety.note, /not a clean result and does not prove safety/); assert.equal(none.dataMode, 'OFFLINE_VERIFICATION_REQUIRED');
  assert.equal(none.decision.dimensions.safetyRisk, 'UNKNOWN');
});

// ---- Amazon observations, price basis ---------------------------------------------------------------------------------------------------------------------------------
test('Amazon observations: pack quantity compared per unit, ASIN normalised, BE/FR/DE/NL, price basis OBSERVED / TARGET / ASSUMED kept apart', () => {
  const o = normalizeObservation({ marketplace: 'amazon.nl', price: '29.90', packQty: 2, asin: ' b0abc12345 ', reviews: 120, rating: 4.4, notes: 'twin pack' }, NOW);
  assert.equal(o.unitMinor, 1495); assert.equal(o.asin, 'B0ABC12345'); assert.equal(o.status, 'OBSERVED');
  const s = summarizeMarket([o, normalizeObservation({ marketplace: 'amazon.be', price: '14.00' }, NOW), normalizeObservation({ marketplace: 'amazon.fr', price: '16.50' }, NOW), normalizeObservation({ marketplace: 'amazon.de', price: '15.00' }, NOW)], NOW);
  assert.equal(s.byMarketplace.filter((m) => m.status === 'OBSERVED').length, 4); assert.equal(s.byMarketplace.find((m) => m.marketplace === 'amazon.nl').medianMinor, 1495);
  const base = [...chargerBase, ...docsFor.charger('PD-65')];
  const target = run(build(base)); assert.equal(target.economics.priceBasis, 'TARGET'); assert.ok(target.evidence.estimated.some((e) => /selling price \(TARGET\)/.test(e.item)));
  const observedNoListing = run(build([...base, { type: 'SALE', sale: { sellingPriceGross: 24.99, vatRatePct: 21, targetContributionPct: 30, priceBasis: 'OBSERVED' } }]));
  assert.equal(observedNoListing.economics.priceBasis, 'ASSUMED', 'OBSERVED without an observation is not accepted as observed');
  assert.ok(observedNoListing.decision.conditions.some((c) => /selling price is ASSUMED/.test(c))); assert.ok(observedNoListing.evidence.assumed.some((e) => /selling price \(ASSUMED\)/.test(e.item)));
  const observed = run(build([...base, { type: 'AMAZON_OBS', observation: { marketplace: 'amazon.be', price: '24.99' } }, { type: 'SALE', sale: { sellingPriceGross: 24.99, vatRatePct: 21, targetContributionPct: 30, priceBasis: 'OBSERVED' } }]));
  assert.equal(observed.economics.priceBasis, 'OBSERVED'); assert.ok(observed.evidence.observed.some((e) => /selling price \(OBSERVED\)/.test(e.item)));
  const removed = dispatch(build([...base, { type: 'AMAZON_OBS', observation: { marketplace: 'amazon.be', price: '24.99' } }]), { type: 'AMAZON_OBS_REMOVE', index: 0 }, NOW); assert.equal(removed.amazon.observations.length, 0);
});

// ---- customs wording --------------------------------------------------------------------------------------------------------------------------------------------------------
test('customs: only HS/CN CANDIDATES, never "confirmed" without a binding tariff information; the missing lookup is stated', () => {
  const a = run(build(chargerBase)); const c = a.customs;
  assert.match(c.codeLabel, /HS\/CN CANDIDATE 8504\.40 \(not a classification\)/); assert.equal(c.lookup, 'NOT_INTEGRATED'); assert.match(c.limitation, /No official TARIC/);
  assert.ok(c.candidates.every((h) => h.label === 'HS/CN CANDIDATE'));
  assert.equal(JSON.stringify(c).toUpperCase().includes('CONFIRMED HS'), false);
  const bti = run(build([...chargerBase, { type: 'CUSTOMS', customs: { bti: { number: 'BE-2026-001', validUntil: '2027-06-01' } } }])).customs;
  assert.equal(bti.status, 'CLASSIFICATION_BINDING_BTI'); assert.match(bti.codeLabel, /binding tariff information BE-2026-001/);
  const none = run(build(chargerBase.filter((e) => e.type !== 'CUSTOMS'))).customs; assert.equal(none.codeLabel, 'NO HS/CN CODE CHOSEN');
});
