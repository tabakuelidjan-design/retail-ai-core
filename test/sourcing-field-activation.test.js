// Field activation: offline capability matrix, money speed (every input moves the result), document evidence states, phone launcher (fake tunnel), security fail-closed.
// The real-browser cold-start proof lives in test/e2e/sourcing-pwa.e2e.js (npm run sourcing:e2e).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { capabilityMatrix, liveLabel, CAPABILITY_CLASS } from '../src/sourcing/core/capabilities.js';
import { assess, dispatch, documentEvidenceState } from '../src/sourcing/core/case.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { startPhoneMode, parseTunnelUrl, pairingLink } from '../src/sourcing/server/phone.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { createDisabledProvider } from '../src/sourcing/adapters/ai-provider.js';
import { NOW, build, run, ident, traits, extraTraits, importer, commercial, doc, eudoc } from './sourcing-fixtures.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sourcing');

// ---- capability matrix --------------------------------------------------------------------------------------------------------------------------------------------------
const ids = ['case', 'photo', 'manual_identification', 'ai_vision', 'supplier_questions', 'document_text', 'pdf_extraction', 'document_photo_ai', 'document_confirm', 'rulebook', 'safety_gate', 'customs', 'amazon_observations', 'landed_cost', 'max_purchase_price', 'verdict', 'save', 'case_history', 'sync'];
const m = (o) => Object.fromEntries(capabilityMatrix({ serverReachable: false, appCached: true, safetyCache: { present: true, ageDays: 2 }, aiConfigured: false, ...o }).map((f) => [f.id, f]));

test('capability matrix covers every field feature with one of the six classes', () => {
  const all = m({}); for (const id of ids) { assert.ok(all[id], id); assert.ok(Object.values(CAPABILITY_CLASS).includes(all[id].class), id); assert.ok(all[id].note.length > 5, id); }
  assert.deepEqual(new Set(Object.values(CAPABILITY_CLASS)), new Set(['AVAILABLE_OFFLINE', 'AVAILABLE_FROM_CACHE', 'REQUIRES_NETWORK', 'REQUIRES_SERVER', 'REQUIRES_EXTERNAL_PROVIDER', 'UNAVAILABLE']));
});

test('capability matrix: offline, the whole decision path works on the phone; server and provider features say so honestly', () => {
  const off = m({});
  for (const id of ['case', 'photo', 'manual_identification', 'supplier_questions', 'document_text', 'document_confirm', 'customs', 'amazon_observations', 'landed_cost', 'max_purchase_price', 'verdict', 'save', 'case_history', 'rulebook']) assert.equal(off[id].availableNow, true, id);
  for (const id of ['pdf_extraction', 'sync', 'safety_gate_refresh', 'fx_rate']) { assert.equal(off[id].class, 'REQUIRES_SERVER'); assert.equal(off[id].availableNow, false, id); }
  assert.equal(off.ai_vision.class, 'REQUIRES_EXTERNAL_PROVIDER'); assert.equal(off.ai_vision.availableNow, false); assert.equal(off.document_photo_ai.availableNow, false);
  assert.equal(off.safety_gate.class, 'AVAILABLE_FROM_CACHE'); assert.equal(off.safety_gate.availableNow, true); assert.match(off.safety_gate.note, /CACHED/);
  const none = m({ safetyCache: { present: false } }); assert.equal(none.safety_gate.availableNow, false); assert.match(none.safety_gate.note, /OFFLINE - VERIFICATION REQUIRED.*not a clean result/);
  const on = m({ serverReachable: true, aiConfigured: true, aiRegion: 'EU' }); assert.equal(on.pdf_extraction.availableNow, true); assert.equal(on.ai_vision.availableNow, true); assert.match(on.ai_vision.note, /consent per image/);
  const onNoAi = m({ serverReachable: true, aiConfigured: false }); assert.equal(onNoAi.ai_vision.availableNow, false); assert.match(onNoAi.ai_vision.note, /identify it by hand/);
});

test('"LIVE" is only ever said for a fresh copy while the server is reachable NOW; a cache is CACHED, none is OFFLINE', () => {
  const copy = { present: true, ageHours: 2, serverMode: 'LIVE_VERIFIED' };
  assert.equal(liveLabel({ serverReachable: true, safetyCache: copy }), 'LIVE_VERIFIED');
  assert.equal(liveLabel({ serverReachable: false, safetyCache: copy }), 'CACHED');
  assert.equal(liveLabel({ serverReachable: true, safetyCache: { ...copy, ageHours: 30 } }), 'CACHED');
  assert.equal(liveLabel({ serverReachable: true, safetyCache: { ...copy, serverMode: 'CACHED' } }), 'CACHED');
  assert.equal(liveLabel({ serverReachable: true, safetyCache: { present: false } }), 'OFFLINE_VERIFICATION_REQUIRED');
});

// ---- money speed ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const base = [...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ unitPrice: 4.2, qty: 1000, moq: 500, price: 24.99, target: 30, duty: 2.7 })];
const point = (extra = [], over = {}) => { const a = run(build([...base, ...extra]), undefined, over); return { landed: a.landed.totals.landedPerUnitEurMinor, contribution: a.economics.contributionMinor, max: a.maxPurchasePrice.maxUnitPriceMinor, a }; };

test('money: every input the owner can change moves the landed cost, the profit and the maximum purchase price the right way', () => {
  const b = point();
  const cheaper = point([{ type: 'QUOTE', quote: { unitPrice: 3.2, currency: 'USD', qty: 1000, moq: 500, incoterm: 'FOB' } }]); assert.ok(cheaper.landed < b.landed && cheaper.contribution > b.contribution); assert.equal(cheaper.max, b.max, 'the maximum price does not depend on the current quote');
  const dearerFreight = point([{ type: 'COSTS', costs: { fx: { rate: 0.92, date: '2026-10-02', source: 'USER_ENTERED' }, costs: { freight: { total: 2400, status: 'ESTIMATED' } }, importVat: { ratePct: 21, recoverable: true } } }]); assert.ok(dearerFreight.landed > b.landed && dearerFreight.max < b.max);
  const moreDuty = point([{ type: 'CUSTOMS', customs: { duty: { ratePct: 12, kind: 'USER_ENTERED' } } }]); assert.ok(moreDuty.landed > b.landed && moreDuty.max < b.max);
  const nonRecoverableVat = point([{ type: 'COSTS', costs: { fx: { rate: 0.92, date: '2026-10-02', source: 'USER_ENTERED' }, costs: { freight: { total: 600, status: 'ESTIMATED' } }, importVat: { ratePct: 21, recoverable: false } } }]); assert.ok(nonRecoverableVat.landed > b.landed, 'import VAT that cannot be recovered is a cost');
  const higherPrice = point([{ type: 'SALE', sale: { sellingPriceGross: 39.99, vatRatePct: 21, targetContributionPct: 30 } }]); assert.ok(higherPrice.contribution > b.contribution && higherPrice.max > b.max);
  const hungrier = point([{ type: 'SALE', sale: { sellingPriceGross: 24.99, vatRatePct: 21, targetContributionPct: 50 } }]); assert.ok(hungrier.max < b.max && hungrier.contribution === b.contribution);
  const moq = point([{ type: 'QUOTE', quote: { unitPrice: 4.2, currency: 'USD', qty: 300, moq: 500, incoterm: 'FOB' } }]); assert.ok(moq.a.landed.warnings.some((w) => /QUANTITY_BELOW_MOQ/.test(w)), 'buying under the MOQ is flagged');
  const bigger = point([{ type: 'QUOTE', quote: { unitPrice: 4.2, currency: 'USD', qty: 5000, moq: 500, incoterm: 'FOB' } }]); assert.ok(bigger.landed !== b.landed, 'quantity changes the fixed-cost share');
});

test('money: Amazon fees move the Amazon economics and stay UNKNOWN until entered; unknown cost components stay visible', () => {
  const az = [{ type: 'CONTEXT', context: { channels: ['amazon'] } }];
  const unknown = run(build([...base, ...az, { type: 'SALE_AMAZON', sale: { sellingPriceGross: 24.99, vatRatePct: 21, lines: [{ key: 'referral', kind: 'pct_of_gross', status: 'UNKNOWN' }, { key: 'fulfilment', kind: 'per_unit', status: 'UNKNOWN' }] } }]));
  assert.equal(unknown.economicsAmazon.status, 'UPPER_BOUND'); assert.deepEqual(unknown.economicsAmazon.unknownLines.sort(), ['fulfilment', 'referral']);
  const known = run(build([...base, ...az, { type: 'SALE_AMAZON', sale: { sellingPriceGross: 24.99, vatRatePct: 21, lines: [{ key: 'referral', kind: 'pct_of_gross', value: '15', status: 'KNOWN' }, { key: 'fulfilment', kind: 'per_unit', value: '3.50', status: 'KNOWN' }] } }]));
  assert.equal(known.economicsAmazon.status, 'COMPLETE'); assert.ok(known.economicsAmazon.contributionMinor < unknown.economicsAmazon.contributionMinor);
  const noFreight = run(build(base.filter((e) => e.type !== 'COSTS'))); assert.equal(noFreight.landed.status, 'INFORMATION_INSUFFICIENT'); assert.ok(noFreight.landed.unknown.length > 0);
});

// ---- document evidence states --------------------------------------------------------------------------------------------------------------------------------------------------
test('document evidence: SUPPLIER CLAIM, UNVERIFIED and CONFIRMED AGAINST DOCUMENT stay distinct; a supplier document is never VERIFIED', () => {
  const t = eudoc({ model: 'PD-65', directives: ['2014/35/EU'], standards: ['EN 62368-1'] });
  const st = (e) => run(build([...base, { type: 'DOCUMENT', id: 'd', text: t, ...e }])).documents[0].evidenceState;
  assert.equal(st({ textSource: 'PASTED' }), 'SUPPLIER_CLAIM'); assert.equal(st({ textSource: 'NATIVE' }), 'SUPPLIER_CLAIM');
  assert.equal(st({ textSource: 'OCR' }), 'UNVERIFIED'); assert.equal(st({ textSource: 'PHOTO_ONLY', text: '' }), 'UNVERIFIED');
  assert.equal(st({ textSource: 'TRANSCRIBED' }), 'CONFIRMED_AGAINST_DOCUMENT');
  let c = build([...base, { type: 'DOCUMENT', id: 'd', text: t, textSource: 'OCR' }]); c = dispatch(c, { type: 'DOCUMENT_CONFIRM', id: 'd' }, NOW);
  assert.equal(assess(c, { now: NOW }).documents[0].evidenceState, 'CONFIRMED_AGAINST_DOCUMENT');
  for (const s of ['PASTED', 'NATIVE', 'OCR', 'PHOTO_ONLY', 'TRANSCRIBED']) assert.notEqual(documentEvidenceState({ textSource: s, confirmed: true }), 'VERIFIED');
  assert.equal(run(c).evidence.verified.some((e) => /document/.test(e.item)), false);
});

// ---- phone launcher (fake tunnel: nothing is exposed) ---------------------------------------------------------------------------------------------------------------------------
const fakeServer = () => { const calls = []; return { calls, startServer: async (o) => { calls.push(o); return { port: 18787, token: 'fake-token-0123456789-abcdef-ghij', server: { close: (cb) => cb?.() } }; } }; };
const fakeSpawn = (script) => () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => p.emit('exit', 0); setTimeout(() => script(p), 5); return p; };

test('phone launcher: parses the quick-tunnel address, allows only that host, and builds a pairing link with the token in the FRAGMENT', async () => {
  assert.equal(parseTunnelUrl('INF |  https://quiet-river-1234.trycloudflare.com  |'), 'https://quiet-river-1234.trycloudflare.com'); assert.equal(parseTunnelUrl('https://evil.example.org'), null);
  const fs = fakeServer(); const r = await startPhoneMode({ env: {}, log: () => {}, startServer: fs.startServer, spawnImpl: fakeSpawn((p) => p.stderr.emit('data', Buffer.from('Your quick Tunnel has been created! https://quiet-river-1234.trycloudflare.com'))), cloudflared: 'cloudflared', tunnelTimeoutMs: 2000 });
  assert.equal(r.tunnel.url, 'https://quiet-river-1234.trycloudflare.com'); assert.equal(r.tunnel.link, 'https://quiet-river-1234.trycloudflare.com/#t=fake-token-0123456789-abcdef-ghij');
  assert.deepEqual(fs.calls[0].allowedHosts, ['quiet-river-1234.trycloudflare.com'], 'the live allow-list now holds exactly the tunnel host');
  assert.equal(new URL(r.tunnel.link).search, ''); assert.equal(pairingLink('https://a.trycloudflare.com/', 'tok'), 'https://a.trycloudflare.com/#t=tok'); await r.stop();
});

test('phone launcher: no cloudflared, a crash or a timeout exposes NOTHING and says why', async () => {
  const miss = await startPhoneMode({ env: {}, log: () => {}, startServer: fakeServer().startServer, spawnImpl: fakeSpawn((p) => p.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }))), cloudflared: 'cloudflared', tunnelTimeoutMs: 2000 });
  assert.equal(miss.tunnel, null); assert.match(miss.reason, /not installed|ENOENT/); assert.match(miss.localUrl, /^http:\/\/127\.0\.0\.1:/);
  const dead = await startPhoneMode({ env: {}, log: () => {}, startServer: fakeServer().startServer, spawnImpl: fakeSpawn((p) => p.emit('exit', 1)), cloudflared: 'cloudflared', tunnelTimeoutMs: 2000 }); assert.equal(dead.tunnel, null); assert.match(dead.reason, /stopped/);
  const slow = await startPhoneMode({ env: {}, log: () => {}, startServer: fakeServer().startServer, spawnImpl: fakeSpawn(() => {}), cloudflared: 'cloudflared', tunnelTimeoutMs: 100 }); assert.equal(slow.tunnel, null); assert.match(slow.reason, /in time/);
});

// ---- security: fail closed, real client behind the tunnel ---------------------------------------------------------------------------------------------------------------------
test('server fails closed: no token (or a short one) means no server; behind the tunnel each real client has its own lockout counter', async () => {
  const mk = (token) => createSourcingApp({ token, store: createMemoryStore(), ai: createDisabledProvider(), uiDir: join(SRC, 'ui'), coreDir: join(SRC, 'core') });
  assert.throws(() => mk(undefined), /token/); assert.throws(() => mk('short'), /token/); assert.throws(() => mk(''), /token/);
  const app = createSourcingApp({ token: 'phone-token-0123456789-abcdef-zz', store: createMemoryStore(), ai: createDisabledProvider(), uiDir: join(SRC, 'ui'), coreDir: join(SRC, 'core'), allowedHosts: ['quiet-river-1234.trycloudflare.com'] });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  const hit = (headers) => new Promise((resolve) => { const req = http.request({ port, path: '/api/health', headers: { host: 'quiet-river-1234.trycloudflare.com', ...headers } }, (res) => { res.resume(); resolve(res.statusCode); }); req.end(); });
  try {
    for (let i = 0; i < 8; i++) assert.equal(await hit({ 'x-sourcing-token': 'wrong-wrong-wrong-wrong-wrong-xx', 'cf-connecting-ip': '203.0.113.9' }), 401);
    assert.equal(await hit({ 'x-sourcing-token': 'wrong-wrong-wrong-wrong-wrong-xx', 'cf-connecting-ip': '203.0.113.9' }), 429, 'the attacker is locked out');
    assert.equal(await hit({ 'x-sourcing-token': 'phone-token-0123456789-abcdef-zz', 'cf-connecting-ip': '198.51.100.7' }), 200, 'the owner behind the same tunnel is not');
    assert.equal(await hit({ host: 'evil.example.org', 'x-sourcing-token': 'phone-token-0123456789-abcdef-zz' }), 421);
  } finally { await new Promise((r) => server.close(r)); }
});
