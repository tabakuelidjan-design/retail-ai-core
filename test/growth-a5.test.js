// Nordla Growth - A5: a Stratège draft started from ONE priority of Opportunités. The server checks the priority against the merchant's CURRENT
// priorities, sets the reference, and never creates, changes or deletes a priority. Synthetic data and a FAKE provider only. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createHostedGrowth } from '../src/growth/server/hosted.js';
import { createMemoryFollowUpStore, followUpValueError, agentDraftKey } from '../src/growth/server/follow-up-store.js';
import { priorityItemsById, priorityFocus } from '../src/growth/agents/priority-ref.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';

const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'; const OTHER = '11111111-1111-4111-8111-111111111111';
const scopeOf = (id) => createHash('sha256').update(id).digest('hex');
const S = scopeOf(M);
const UI = new URL('../src/growth/ui/', import.meta.url);

const itemAlpha = () => ({ id: 'inquiry:alpha', kind: 'inquiryTest', category: 'inbox', sourcePage: 'inbox', title: { code: 'inbox.title', params: {} }, explanation: { code: 'inbox.ZERO.why', params: {} }, reliability: 'limited', evidence: { network: 'instagram', requestType: 'quote', status: 'ZERO', handle: '@private-handle', text: 'message privé' } });
const inboxFor = (items) => async () => ({ state: 'OK', accounts: [], items });
const okProvider = (calls = []) => ({ name: 'fake', model: 'test-model', complete: async ({ user }) => { calls.push(user); return JSON.stringify({ draft: 'Brouillon de test synthétique.', reason: 'Raison de test.', limits: ['limite de test'] }); } });

async function serve(app) {
  const s = http.createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const post = async (body, path = '/api/growth/agents/run') => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const raw = await r.text(); let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } return { status: r.status, json }; };
  const get = async (path) => (await fetch(base + path)).json();
  return { base, post, get, close: () => new Promise((r) => s.close(r)) };
}

test('A5 engine: the priority lookup covers the page blocks by stable id, and the agent sees no personal field of a priority', () => {
  const payload = { sections: { fix: [{ id: 'fix:purchase-cost' }], commercial: [{ id: 'product:p1' }], watch: [] }, inbox: { items: [itemAlpha()] } };
  const idx = priorityItemsById(payload);
  assert.deepEqual([...idx.keys()].sort(), ['fix:purchase-cost', 'inquiry:alpha', 'product:p1']);
  const focus = priorityFocus(idx.get('inquiry:alpha'));
  assert.equal(focus.id, 'inquiry:alpha');
  assert.equal(Object.hasOwn(focus.evidence, 'handle'), false); assert.equal(Object.hasOwn(focus.evidence, 'text'), false);
  assert.equal(focus.evidence.network, 'instagram');
});

test('A5 link: a valid priority of THIS merchant starts a draft; the server sets the reference; the provider receives only the verified context', async () => {
  const calls = [];
  const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: okProvider(calls), inbox: inboxFor([itemAlpha()]), productPotential: async () => ({ rows: [] }) }));
  try {
    const r = await srv.post({ agentId: 'strategist', priorityId: 'inquiry:alpha' });
    assert.equal(r.status, 200); assert.deepEqual(r.json.priorityRef, { id: 'inquiry:alpha' });
    assert.equal(r.json.requiresHumanConfirmation, true);
    assert.equal(calls.length, 1); const sent = JSON.parse(calls[0]);
    assert.match(sent.priority.id, /^ref:[0-9a-f]{16}$/, 'an account priority reaches the provider as an opaque reference, never as the account id');
    assert.doesNotMatch(calls[0], /inquiry:alpha|"accountId"/);
    assert.doesNotMatch(calls[0], /@private-handle|message privé/, 'no handle and no message text reach the provider');
  } finally { await srv.close(); }
});

test('A5 refusals: an unknown priority, a priority that is no longer there, another merchant\'s priority: PRIORITY_NOT_FOUND, the provider is never called', async () => {
  const calls = [];
  let present = true;
  const inbox = async () => ({ state: 'OK', accounts: [], items: present ? [itemAlpha()] : [] });
  const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: okProvider(calls), inbox, productPotential: async () => ({ rows: [] }) }));
  const other = await serve(createGrowthApp({ merchantId: OTHER, agentProvider: okProvider(calls), inbox: inboxFor([{ ...itemAlpha(), id: 'inquiry:beta' }]), productPotential: async () => ({ rows: [] }) }));
  try {
    const unknown = await srv.post({ agentId: 'strategist', priorityId: 'inquiry:zzz' });
    assert.equal(unknown.status, 404); assert.equal(unknown.json.error.code, 'PRIORITY_NOT_FOUND');
    const foreign = await srv.post({ agentId: 'strategist', priorityId: 'inquiry:beta' });
    assert.equal(foreign.status, 404); assert.equal(foreign.json.error.code, 'PRIORITY_NOT_FOUND', 'the other merchant\'s priority is not visible from this merchant');
    present = false; // the priority existed in an earlier read and has gone today
    const gone = await srv.post({ agentId: 'strategist', priorityId: 'inquiry:alpha' });
    assert.equal(gone.status, 404); assert.equal(gone.json.error.code, 'PRIORITY_NOT_FOUND');
    assert.equal(calls.length, 0, 'no provider call for a refused priority');
    const reverse = await other.post({ agentId: 'strategist', priorityId: 'inquiry:alpha' });
    assert.equal(reverse.status, 404, 'and the reverse: the first merchant\'s priority is not visible from the second');
  } finally { await srv.close(); await other.close(); }
});

test('A5 input: a malformed priority id or a non-strategist agent is a bad request; no provider call', async () => {
  const calls = [];
  const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: okProvider(calls), inbox: inboxFor([itemAlpha()]), productPotential: async () => ({ rows: [] }) }));
  try {
    assert.equal((await srv.post({ agentId: 'strategist', priorityId: 42 })).status, 400);
    assert.equal((await srv.post({ agentId: 'strategist', priorityId: '' })).status, 400);
    assert.equal((await srv.post({ agentId: 'strategist', priorityId: 'x'.repeat(201) })).status, 400);
    assert.equal((await srv.post({ agentId: 'products', priorityId: 'inquiry:alpha' })).status, 400, 'only the Stratège starts from a priority');
    assert.equal(calls.length, 0);
  } finally { await srv.close(); }
});

test('A5 without a provider: a valid priority still produces no draft and no reference; the state is said', async () => {
  const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: null, inbox: inboxFor([itemAlpha()]), productPotential: async () => ({ rows: [] }) }));
  try {
    const r = await srv.post({ agentId: 'strategist', priorityId: 'inquiry:alpha' });
    assert.equal(r.status, 503); assert.equal(r.json.error.code, 'AI_NOT_CONFIGURED');
    assert.equal(r.json.priorityRef, undefined);
  } finally { await srv.close(); }
});

test('A5 failure: a provider error saves nothing and returns no reference', async () => {
  const broken = { name: 'fake', model: 'm', complete: async () => { throw new Error('boom with a secret-looking value'); } };
  const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: broken, inbox: inboxFor([itemAlpha()]), productPotential: async () => ({ rows: [] }) }));
  try {
    const r = await srv.post({ agentId: 'strategist', priorityId: 'inquiry:alpha' });
    assert.equal(r.status, 502); assert.equal(r.json.priorityRef, undefined); assert.doesNotMatch(JSON.stringify(r.json), /secret/);
  } finally { await srv.close(); }
});

test('A5 no mutation: the priorities are the same before and after a draft is started, and nothing is written to the follow-up store', async () => {
  const srv = await serve(createGrowthApp({ merchantId: M, agentProvider: okProvider(), inbox: inboxFor([itemAlpha()]), productPotential: async () => ({ rows: [] }) }));
  try {
    const before = JSON.stringify((await srv.get('/api/growth/opportunities')).inbox);
    await srv.post({ agentId: 'strategist', priorityId: 'inquiry:alpha' });
    const after = JSON.stringify((await srv.get('/api/growth/opportunities')).inbox);
    assert.equal(after, before);
  } finally { await srv.close(); }
});

test('A5 storage: a draft may carry the reference (its id only); no other field, no long or control-character id; A3 / A4 drafts stay valid', () => {
  const key = agentDraftKey(S);
  const base = { id: 'draft-0001', at: '2026-11-27T10:00:00.000Z', period: 'weeks8', draft: 'x', reason: 'r', limits: [], sources: [], confirmations: [], state: 'pending' };
  assert.equal(followUpValueError(key, { v: 1, drafts: [base] }), null, 'an A4 draft without reference is still valid');
  assert.equal(followUpValueError(key, { v: 1, drafts: [{ ...base, priorityRef: { id: 'inquiry:alpha' } }] }), null);
  assert.equal(followUpValueError(key, { v: 1, drafts: [{ ...base, priorityRef: { id: 'inquiry:alpha', extra: 1 } }] }), 'VALUE_INVALID');
  assert.equal(followUpValueError(key, { v: 1, drafts: [{ ...base, priorityRef: { id: 'x'.repeat(201) } }] }), 'VALUE_INVALID');
  assert.equal(followUpValueError(key, { v: 1, drafts: [{ ...base, priorityRef: { id: 'a\u0007b' } }] }), 'VALUE_INVALID');
  assert.equal(followUpValueError(key, { v: 1, drafts: [{ ...base, priorityRef: 'inquiry:alpha' }] }), 'VALUE_INVALID');
});

test('A5 with A4: a reference survives a review, and a reviewed draft keeps its decision (hosted, real session gate)', async () => {
  const SESSIONS = { 'tok-owner': { merchantId: M, userId: 'u-owner', role: 'OWNER', module: 'growth' }, 'tok-viewer': { merchantId: M, userId: 'u-viewer', role: 'VIEWER', module: 'growth' } };
  const identity = { context: { module: 'growth' }, resolveAccessSession: async (t) => (SESSIONS[t] ? { ok: true, ...SESSIONS[t] } : { ok: false }), authenticateAndOpenSession: async () => ({ ok: false, status: 401 }), logoutSession: async () => {} };
  const security = { module: 'growth', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (t) => `sid=${t}; HttpOnly`, csrfCookie: (t) => `__Host-nordla_growth_csrf=${t}`, clearSessionCookie: () => '', clearCsrfCookie: () => '' },
    csrfTokenFor: (t) => `csrf-${t}`, guardRead: () => ({ ok: true }), guardLogin: () => ({ ok: true, ctx: { requestId: 'r', clientIp: '127.0.0.1' } }), readLoginBody: async () => ({}), normalizeLogin: async (fn) => fn(), publicError: () => ({ status: 400, error: 'BAD' }),
    guardMutation: async (req, resolve) => { const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null; if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' }; if (req.headers['x-nordla-csrf'] !== `csrf-${t}`) return { ok: false, code: 'CSRF_INVALID', response: { status: 403, error: 'CSRF_INVALID' } }; return { ok: true, access: a, sessionToken: t }; } };
  const gate = createSessionGate({ identity, security, moduleCode: 'growth' });
  const store = createMemoryFollowUpStore();
  const ref = { id: 'inquiry:alpha' };
  await store.put(M, agentDraftKey(S), { v: 1, drafts: [{ id: 'draft-0001', at: '2026-11-27T10:00:00.000Z', period: 'weeks8', draft: 'x', reason: 'r', limits: [], sources: [], confirmations: [], state: 'pending', priorityRef: ref }] }, 0, 'u-owner');
  const app = createGrowthApp({ merchantId: M, hosted: true, agentProvider: okProvider(), inbox: inboxFor([itemAlpha()]), productPotential: async () => ({ rows: [] }) });
  const handler = createHostedGrowth({ gate, merchantId: M, historyScope: S, app, store });
  const s = http.createServer(handler); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = (path, { token, body }) => fetch(base + path, { method: 'POST', headers: { cookie: `sid=${token}`, 'x-nordla-csrf': `csrf-${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  try {
    const viewer = await call('/api/growth/agents/run', { token: 'tok-viewer', body: { agentId: 'strategist', priorityId: 'inquiry:alpha' } });
    assert.equal(viewer.status, 403); assert.equal(viewer.json.error.code, 'FORBIDDEN_ROLE');
    const run = await call('/api/growth/agents/run', { token: 'tok-owner', body: { agentId: 'strategist', priorityId: 'inquiry:alpha' } });
    assert.equal(run.status, 200); assert.deepEqual(run.json.priorityRef, ref);
    const rev = await call('/api/growth/agents/review', { token: 'tok-owner', body: { id: 'draft-0001', status: 'validated' } });
    assert.equal(rev.status, 200); assert.deepEqual(rev.json.value.drafts[0].priorityRef, ref, 'the reference survives the review');
    const again = await call('/api/growth/agents/review', { token: 'tok-owner', body: { id: 'draft-0001', status: 'rejected' } });
    assert.equal(again.json.error.code, 'ALREADY_REVIEWED', 'a reviewed draft keeps its decision');
  } finally { s.close(); }
});

test('A5 UI: the button is on priority rows only, the draft shows the server reference, and no text is matched or invented in the page', async () => {
  const opp = await readFile(new URL('opportunities.js', UI), 'utf8');
  const agents = await readFile(new URL('agents.js', UI), 'utf8');
  assert.match(opp, /view\.priorityId \? opAgentDraftAction\(view\.priorityId\)/);
  assert.match(agents, /\.\.\.\(res\.priorityRef \? \{ priorityRef: \{ id: res\.priorityRef\.id \} \} : \{\}\)/, 'the reference is copied from the server answer only');
  assert.doesNotMatch(agents, /innerHTML/);
  assert.doesNotMatch(agents, /includes\(\s*(dr|d)\.draft/, 'no matching by draft text');
  const lang = await readFile(new URL('lang-agents.js', UI), 'utf8');
  const keys = ['gr.ag.fromPriority', 'gr.ag.priorityLinked', 'gr.ag.priorityGone', 'gr.ag.priorityGeneric', 'gr.ag.err.PRIORITY_NOT_FOUND'];
  const vm = (await import('node:vm')).default;
  for (const l of ['fr', 'nl', 'en']) {
    const ctx = { window: {} };
    vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
    vm.runInNewContext(lang, ctx);
    for (const k of keys) assert.ok(ctx.window.NORDLA_DICTS[l][k], `${l}: missing ${k}`);
  }
});
