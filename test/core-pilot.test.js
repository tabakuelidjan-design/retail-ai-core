// Nordla Core, first real path: Enterprise -> Subject (sourcing purchase) -> Levers -> Decision (Socle) -> human decision -> follow-up,
// persisted in a hash-chained journal, served behind the hosted sign-in, and Parle à Nordla (text) answering only from what is really
// connected, with sources. Real sourcing engine, real Socle engine, real file journal, real HTTP servers; synthetic people and cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { buildSourcingPurchaseSubject, SOURCING_PURCHASE } from '../src/buying/sourcing-purchase.js';
import { createCoreRuntime } from '../src/core-pilot/runtime.js';
import { createFileJournal, createMemoryJournal } from '../src/core-pilot/journal.js';
import { loadCoreConfig, validateCoreConfig } from '../src/core-pilot/config.js';
import { sourcingPurchaseFacts } from '../src/core-pilot/sourcing-facts.js';
import { askNordla } from '../src/core-pilot/ask.js';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createMemoryStore } from '../src/sourcing/store/file-store.js';
import { startSourcingServer } from '../src/sourcing/server/index.js';
import { createIdentityDb } from './fixtures/identity-db.js';
import { createFakeGoTrue } from './fixtures/fake-gotrue.js';
import { createIdentityService } from '../src/identity/service.js';
import { createMemberService } from '../src/identity/members.js';
import { createModuleProvisioning } from '../src/identity/provisioning.js';
import { loadIdentityConfig, loadRateLimitConfig } from '../src/identity/config.js';
import { createHttpSecurity } from '../src/security/index.js';
import { NOW, LIVE_CLEAN, ident, traits, importer, commercial, extraTraits } from './sourcing-fixtures.js';

const MID = 'merchant-test';
const OWNER = { userId: 'user-owner', role: 'OWNER' };
const BUYER = { userId: 'user-buyer', role: 'COLLABORATOR' };
const CONFIG = validateCoreConfig({ schema: 1, merchantId: 'test', currency: 'EUR', gates: { materialityThreshold: 0, maxPrioritySubjects: 10, cooldownDays: 14, aggravationFactor: 1.5 }, testSmall: { budget: null }, ownerRules: [] });
const externals = { safety: LIVE_CLEAN };
const mk = (events, id) => { let c = newCase({ id, name: 'x', now: NOW }); for (const e of events) c = dispatch(c, e, NOW); return c; };
// a clean household product with documents not required: the sourcing verdict is GO (money may be committed)
const goCase = (id = 'case-go', qty = 1000) => mk([...ident({ name: 'Bamboo kitchen organiser', category: 'household_general' }), ...traits({}), ...importer, { type: 'SUPPLIER', supplier: { name: 'Yiwu Greenline' } }, ...commercial({ unitPrice: 4.2, qty, moq: 500 })], id);
// a mains charger without its conformity documents: hard blockers, money may NOT be committed
const blockedCase = (id = 'case-blocked') => mk([...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ unitPrice: 4.2, qty: 1000, moq: 500, price: 24.99, target: 30, duty: 2.7 })], id);
const runtime = (journal = createMemoryJournal({ merchantId: MID }), config = CONFIG) => createCoreRuntime({ merchantId: MID, config, journal, now: () => NOW });

test('facts: every number comes from the sourcing engine (same code as the phone); unknown stays null and keeps the subject TO_VERIFY', () => {
  const { input, scenarios } = sourcingPurchaseFacts(goCase(), { merchantId: MID, now: NOW, externals });
  assert.equal(input.verdict, 'GO'); assert.equal(input.can_commit_money, true); assert.ok(input.landed_total > 0 && input.contribution_per_unit !== null);
  assert.ok(scenarios.moq && scenarios.moq.landed_total < input.landed_total, 'the MOQ scenario is priced by the engine, not scaled by hand');
  const subject = buildSourcingPurchaseSubject(input);
  assert.equal(subject.type, SOURCING_PURCHASE); assert.ok(subject.facts.every((f) => f.source_ref === `sourcing-case:case-go@${goCase().updatedAt}`), 'every fact names its source case and version');
  assert.notEqual(subject.confidence, 'HIGH', 'a new product has no sales history: never HIGH');
  const bare = mk([...ident({ name: 'Mug', category: 'household_general' })], 'case-bare');
  const s2 = buildSourcingPurchaseSubject(sourcingPurchaseFacts(bare, { merchantId: MID, now: NOW, externals }).input);
  assert.equal(s2.facts.find((f) => f.key === 'landed_total').value, null); assert.equal(s2.materiality, 0);
  assert.ok(s2.missing_data.some((m) => m.field === 'landed_total' && m.blocking));
});

test('decision: hard blockers ELIMINATE every order before comparison; the recommendation is a small test, with the reasons', async () => {
  const rt = runtime();
  const r = await rt.analyseCase(blockedCase(), { externals, actor: OWNER });
  assert.equal(r.status, 'ANALYSED'); assert.equal(r.entry.recommendation.kind, 'TEST_SMALL');
  const orders = r.entry.options.eliminated.filter((e) => e.lever_id.startsWith('buying.'));
  assert.equal(orders.length, 2); assert.ok(orders.every((o) => o.reasons.some((x) => /can_commit_money eq true \(actual false\)/.test(x))));
  assert.ok(r.entry.options.remaining.some((x) => x.lever_id === 'DO_NOTHING'), 'doing nothing stays a legitimate option');
  assert.equal(r.entry.comparison_method?.uses_llm ?? false, false);
  // an eliminated option can never be approved, and the refused attempt leaves no trace in the journal
  const before = (await rt.overview()).journal_head;
  await assert.rejects(rt.decideHuman(r.entry.id, { decision: 'APPROVED_ALTERNATIVE', chosen_lever_ids: ['buying.ORDER_QUOTED_QTY'], reason: 'je veux commander' }, OWNER), { code: 'LEVER_ELIMINATED' });
  assert.equal((await rt.overview()).journal_head, before);
});

test('decision: a GO case keeps both order sizes eligible; LOW confidence (target price, no market evidence) => test small first; the owner may choose an order', async () => {
  const rt = runtime();
  const r = await rt.analyseCase(goCase(), { externals, actor: OWNER });
  const ids = r.entry.options.remaining.map((x) => x.lever_id);
  assert.ok(ids.includes('buying.ORDER_QUOTED_QTY') && ids.includes('buying.ORDER_MOQ'));
  const order = r.entry.options.remaining.find((x) => x.lever_id === 'buying.ORDER_QUOTED_QTY');
  assert.ok(order.axes.cash_impact < 0 && order.axes.margin_impact > 0 && order.axes.reversibility === 'IRREVERSIBLE'); assert.equal(order.axes.time_to_cash_days, null, 'unknown stays unknown');
  assert.equal(r.entry.recommendation.kind, 'TEST_SMALL'); assert.equal(r.entry.recommendation.tests_lever_id !== null, true);
  // a collaborator may analyse but may not approve an order (owner approval) - enforced in code
  await assert.rejects(rt.decideHuman(r.entry.id, { decision: 'APPROVED_ALTERNATIVE', chosen_lever_ids: ['buying.ORDER_MOQ'], reason: 'go' }, BUYER), { code: 'APPROVAL_ROLE_REQUIRED' });
  await assert.rejects(rt.decideHuman(r.entry.id, { decision: 'APPROVED', reason: '' }, OWNER), { code: 'INVALID_FIELD' }, 'a reason is required');
  const d = await rt.decideHuman(r.entry.id, { decision: 'APPROVED_ALTERNATIVE', chosen_lever_ids: ['buying.ORDER_MOQ'], reason: 'commande au minimum pour tester le marché' }, OWNER);
  assert.deepEqual(d.entry.human_decision.chosen_lever_ids, ['buying.ORDER_MOQ']); assert.equal(d.entry.human_decision.approver, 'user:user-owner'); assert.equal(d.subject.status, 'IN_PROGRESS');
  await assert.rejects(rt.decideHuman(r.entry.id, { decision: 'REJECTED', reason: 'non' }, OWNER), { code: 'INVALID_STATE' });
  // follow-up: NOT_MEASURABLE is a legitimate result; a second result is refused; results never touch the rules
  const f = await rt.recordResult(r.entry.id, { result: 'NOT_MEASURABLE', notes: 'marchandise pas encore reçue' }, OWNER);
  assert.equal(f.entry.result.result, 'NOT_MEASURABLE'); assert.equal(f.entry.result.evidence_level, 'NONE'); assert.equal(f.subject.status, 'RESULT'); assert.deepEqual(f.entry.learning.rule_changes, []);
  await assert.rejects(rt.recordResult(r.entry.id, { result: 'CONFIRMED', evidence_level: 'STRONG' }, OWNER), { code: 'ALREADY_MEASURED' });
});

test('owner rules from configuration eliminate before comparison (MAX_BUDGET); none is invented when the owner gave none', async () => {
  const withBudget = validateCoreConfig({ ...CONFIG, ownerRules: [{ id: 'budget', type: 'MAX_BUDGET', params: { max_budget: 3000 } }] });
  const rt = runtime(createMemoryJournal({ merchantId: MID }), withBudget);
  const r = await rt.analyseCase(goCase(), { externals, actor: OWNER });
  const el = r.entry.options.eliminated.find((x) => x.lever_id === 'buying.ORDER_QUOTED_QTY');
  assert.equal(el.stage, 'RULES'); assert.ok(el.reasons.some((x) => /budget: cost .* > budget 3000/.test(x)));
  const { config } = await loadCoreConfig({ SOURCING_MERCHANT_ID: 'habb' });
  assert.deepEqual(config.ownerRules, [], 'the pilot merchant file invents no owner constraint');
  assert.equal((await runtime(createMemoryJournal({ merchantId: MID }), config).overview()).owner_rules, 'NOT_CONFIGURED');
});

test('persistence: the journal rebuilds the same state after a restart; same case version = same analysis; an edited line stops the Core', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'core-journal-'));
  try {
    const file = join(dir, 'core', 'decision-journal.jsonl');
    const a = runtime(createFileJournal({ merchantId: MID, file }));
    const r = await a.analyseCase(goCase(), { externals, actor: OWNER });
    assert.equal((await a.analyseCase(goCase(), { externals, actor: OWNER })).status, 'UNCHANGED', 'no duplicate subject for the same case version');
    await a.decideHuman(r.entry.id, { decision: 'DEFERRED', reason: 'attendre l’échantillon' }, OWNER);
    const b = runtime(createFileJournal({ merchantId: MID, file }));
    const o = await b.overview();
    assert.equal(o.decisions.length, 1); assert.equal(o.decisions[0].entry.human_decision.decision, 'DEFERRED'); assert.equal(o.journal_head, (await a.overview()).journal_head);
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 2);
    // another merchant's runtime cannot read this journal
    await assert.rejects(createCoreRuntime({ merchantId: 'someone-else', config: CONFIG, journal: createFileJournal({ merchantId: 'someone-else', file }) }).overview(), { code: 'JOURNAL_CORRUPT' });
    // edit one figure in the journal: detected, the Core refuses to start, the file is left exactly as found
    const raw = await readFile(file, 'utf8'); const edited = raw.replace('"DEFERRED"', '"APPROVED"'); await writeFile(file, edited);
    await assert.rejects(runtime(createFileJournal({ merchantId: MID, file })).overview(), { code: 'JOURNAL_CORRUPT' });
    assert.equal(await readFile(file, 'utf8'), edited, 'never repaired or truncated by code');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Parle à Nordla (text): answers from the open case and the journal with sources; Finance / Analytics are said NOT connected, with no figure', async () => {
  const rt = runtime(); const cases = { 'case-go': goCase() };
  const ctx = { runtime: rt, getCase: async (id) => cases[id] ?? null, externals, actor: OWNER, now: NOW };
  const sum = await askNordla({ text: 'résume ce dossier', caseId: 'case-go' }, ctx);
  assert.equal(sum.status, 'ANSWERED'); assert.match(sum.answer, /verdict GO/); assert.deepEqual(sum.sources[0], { kind: 'sourcing_case', ref: 'case-go', version: cases['case-go'].updatedAt });
  const buy = await askNordla({ text: 'Dois-je acheter ce produit ?', caseId: 'case-go' }, ctx);
  assert.match(buy.answer, /Recommandation Nordla Core/); assert.match(buy.answer, /Rien n’est commandé ni payé par Nordla/); assert.ok(buy.sources.some((s) => s.kind === 'core_journal'));
  const waiting = await askNordla({ text: 'quelles décisions sont en attente ?' }, ctx);
  assert.match(waiting.answer, /1 décision\(s\) attendent votre validation/);
  for (const q of ['pourquoi mes ventes ont baissé ?', 'montre les factures de ce fournisseur', 'combien de stock reste-t-il de ce produit ?']) {
    const r = await askNordla({ text: q }, ctx);
    assert.equal(r.status, 'MODULE_NOT_CONNECTED', q); assert.doesNotMatch(r.answer, /\d/, `${q}: no figure is invented`); assert.equal(r.sources.length, 0);
  }
  const lost = await askNordla({ text: 'raconte une blague' }, ctx); assert.equal(lost.status, 'NOT_UNDERSTOOD'); assert.match(lost.answer, /Je sais/);
  assert.equal((await askNordla({ text: 'dois-je acheter ?' }, { ...ctx, runtime: null })).status, 'CORE_NOT_CONFIGURED');
});

// ---- HTTP: local (token) server and HOSTED (Nordla session) server
const TOKEN = 't'.repeat(32);
function serve(app) { const s = http.createServer(app.handler); return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s))); }
const req = (port, method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers, ...(data ? { 'content-length': data.length } : {}) } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null })); });
  r.on('error', reject); if (data) r.write(data); r.end();
});

test('HTTP (local PC server): the Core reads the case AS HELD BY THE SERVER; journal says LOCAL_TOKEN; not configured => 503 with the reason', async () => {
  const { createCoreHttp } = await import('../src/core-pilot/http.js');
  const store = createMemoryStore(); const rt = runtime();
  const core = createCoreHttp({ runtime: rt, store, externals: async () => externals });
  const s = await serve(createSourcingApp({ token: TOKEN, core, store, uiDir: '.', coreDir: '.' })); const port = s.address().port; const H = { 'x-sourcing-token': TOKEN };
  try {
    assert.equal((await req(port, 'GET', '/api/core/status')).status, 401, 'no token, no Core');
    const st = (await req(port, 'GET', '/api/core/status', { headers: H })).body;
    assert.equal(st.enabled, true); assert.equal(st.executes_actions, false); assert.equal(st.owner_rules, 'NOT_CONFIGURED'); assert.ok(st.not_connected.FINANCE);
    assert.equal((await req(port, 'POST', '/api/core/cases/case-go/analyse', { headers: H })).body.error, 'CASE_NOT_ON_SERVER');
    await store.save(goCase());
    const a = await req(port, 'POST', '/api/core/cases/case-go/analyse', { headers: H });
    assert.equal(a.status, 200); assert.equal(a.body.decision.case_id, 'case-go'); assert.equal(a.body.decision.executes_nothing, true);
    assert.ok(a.body.decision.facts.every((f) => f.source.startsWith('sourcing-case:case-go@')));
    const h = await req(port, 'POST', `/api/core/decisions/${a.body.decision.id}/human`, { headers: H, body: { decision: 'REJECTED', reason: 'pas cette saison', approver: 'system' } });
    assert.equal(h.status, 200); assert.equal(h.body.decision.human_decision.approver, 'local-owner', 'the approver is never taken from the request body'); assert.equal(h.body.decision.subject.status, 'DISMISSED');
    const list = await req(port, 'GET', '/api/core/decisions?case=case-go', { headers: H }); assert.equal(list.body.decisions.length, 1);
    const ask = await req(port, 'POST', '/api/core/ask', { headers: H, body: { text: 'résume ce dossier', caseId: 'case-go' } }); assert.equal(ask.body.status, 'ANSWERED');
  } finally { s.close(); }
  const off = createCoreHttp({ runtime: null, configError: 'CORE_NOT_CONFIGURED: core-decision.json not found', store });
  const s2 = await serve(createSourcingApp({ token: TOKEN, core: off, store, uiDir: '.', coreDir: '.' }));
  try {
    const st = await req(s2.address().port, 'GET', '/api/core/status', { headers: H }); assert.equal(st.body.enabled, false); assert.match(st.body.reason, /core-decision.json not found/);
    assert.equal((await req(s2.address().port, 'POST', '/api/core/cases/case-go/analyse', { headers: H })).status, 503);
  } finally { s2.close(); }
});

test('HTTP (HOSTED): who decides comes from the Nordla session; only the owner approves; an eliminated order cannot be approved; CSRF required; the journal survives a restart', async () => {
  const M = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const people = ['owner', 'buyer'].map((k, i) => ({ key: k, id: `${String(i + 1).padStart(8, '0')}-2222-4222-8222-${String(i + 1).padStart(12, '0')}`, email: `${k}@nordla-test.example`, password: `synthetic passphrase for ${k}` }));
  const [PO, PB] = people; const HOST = 'sourcing.nordla-test.example'; const ORIGIN = `https://${HOST}`;
  const ENV = { SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: M, SOURCING_PUBLIC_ORIGIN: ORIGIN, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'x', SUPABASE_ANON_KEY: 'anon', NORDLA_IDENTITY_RATE_LIMIT_KEY: randomBytes(32).toString('hex'), NORDLA_CSRF_KEY: randomBytes(32).toString('hex'), SOURCING_MERCHANT_ID: 'habb', SOURCING_HOST: '127.0.0.1' };
  const db = createIdentityDb({ merchants: [M], users: people.map((p) => p.id) }); const auth = createFakeGoTrue({ users: people });
  const members = createMemberService({ supabase: db.supabase, merchantId: M }); await members.bootstrapOwner({ userId: PO.id }); await members.addMember({ actorUserId: PO.id, targetUserId: PB.id, role: 'COLLABORATOR' });
  await createModuleProvisioning({ supabase: db.supabase }).enableModule({ merchantId: M, moduleCode: 'sourcing', source: 'provisioning:manual' });
  const services = () => ({ identity: createIdentityService({ merchantId: M, moduleCode: 'sourcing', supabase: db.supabase, auth: { baseUrl: ENV.SUPABASE_URL, anonKey: ENV.SUPABASE_ANON_KEY }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, fetchImpl: auth.fetchImpl }), security: createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [HOST], allowedOrigins: [ORIGIN], moduleCode: 'sourcing', csrfKey: ENV.NORDLA_CSRF_KEY, rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, loginTiming: { minMs: 200, jitterMs: 0 } }) });
  const dir = await mkdtemp(join(tmpdir(), 'core-hosted-'));
  const start = () => startSourcingServer({ env: { ...ENV, SOURCING_DATA_DIR: dir }, log: () => {}, port: 0, services: services(), fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) });
  let srv = await start();
  const call = (method, path, { body, cookie, csrf } = {}) => req(srv.port, method, path, { body, headers: { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7', origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-nordla-csrf': csrf } : {}) } });
  const login = async (p) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ email: p.email, password: p.password }));
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/auth/login', method: 'POST', headers: { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7', origin: ORIGIN, 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      res.resume(); res.on('end', () => { const set = res.headers['set-cookie'] ?? []; const pick = (n) => set.find((c) => c.startsWith(n))?.split(';')[0]; const sid = pick('__Host-nordla_sourcing_sid='); const cs = pick('__Host-nordla_sourcing_csrf='); resolve({ cookie: [sid, cs].join('; '), csrf: cs.split('=')[1] }); });
    });
    r.on('error', reject); r.write(data); r.end();
  });
  try {
    assert.equal((await call('GET', '/api/core/status')).status, 401, 'no session, no Core');
    const owner = await login(PO); const buyer = await login(PB);
    const put = await call('PUT', '/api/cases/case-go', { body: goCase(), ...owner }); assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await call('POST', '/api/core/cases/case-go/analyse', { cookie: buyer.cookie })).status, 403, 'a change without the CSRF token is refused');
    const a = await call('POST', '/api/core/cases/case-go/analyse', buyer); assert.equal(a.status, 200, 'a collaborator may ask for an analysis');
    const id = a.body.decision.id;
    // this server has no live Safety Gate data: the sourcing engine does not allow committing money, so every order is eliminated
    assert.ok(a.body.decision.options.filter((o) => o.lever_id.startsWith('buying.')).every((o) => o.status === 'ELIMINATED'));
    assert.equal(a.body.decision.recommendation.kind, 'TEST_SMALL');
    const elim = await call('POST', `/api/core/decisions/${id}/human`, { ...owner, body: { decision: 'APPROVED_ALTERNATIVE', chosen_lever_ids: ['buying.ORDER_MOQ'], reason: 'commande' } });
    assert.equal(elim.status, 409); assert.equal(elim.body.error, 'LEVER_ELIMINATED');
    const refused = await call('POST', `/api/core/decisions/${id}/human`, { ...buyer, body: { decision: 'APPROVED', reason: 'go' } });
    assert.equal(refused.status, 403); assert.equal(refused.body.error, 'APPROVAL_ROLE_REQUIRED');
    const ok = await call('POST', `/api/core/decisions/${id}/human`, { ...owner, body: { decision: 'APPROVED', reason: 'échantillon d’abord' } });
    assert.equal(ok.status, 200); assert.equal(ok.body.decision.human_decision.approver, `user:${PO.id}`); assert.deepEqual(ok.body.decision.human_decision.chosen_lever_ids, ['TEST_SMALL']);
    const journal = (await readFile(join(dir, 'core', 'decision-journal.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(journal.map((e) => [e.kind, e.actor.user_id, e.actor.role, e.actor.auth]), [['ANALYSED', PB.id, 'COLLABORATOR', 'NORDLA_SESSION'], ['HUMAN_DECISION', PO.id, 'OWNER', 'NORDLA_SESSION']]);
    assert.ok(journal.every((e) => e.merchant_id === M), 'the journal belongs to the server merchant');
    assert.doesNotMatch(JSON.stringify(journal), /@nordla-test\.example/, 'no e-mail in the journal');
    await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.();
    srv = await start(); const again = await login(PO);
    const after = await call('GET', '/api/core/decisions', again);
    assert.equal(after.body.decisions.length, 1); assert.equal(after.body.decisions[0].human_decision.decision, 'APPROVED');
  } finally { await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); await rm(dir, { recursive: true, force: true }); }
});
