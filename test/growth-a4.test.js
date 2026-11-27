// Nordla Growth - A4: the human decision on a Stratège draft (pending -> validated | rejected). Hosted server with the REAL session gate over fake
// identity / HTTP security, and the in-memory follow-up store. Synthetic data only. No model call, no action is started by any decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createHostedGrowth } from '../src/growth/server/hosted.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createMemoryFollowUpStore, followUpValueError, agentDraftKey, draftId, normalizeDraftState } from '../src/growth/server/follow-up-store.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';

const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'; const OTHER = '11111111-1111-4111-8111-111111111111';
const scopeOf = (id) => createHash('sha256').update(id).digest('hex');
const S = scopeOf(M); const SO = scopeOf(OTHER);
const KEY = agentDraftKey(S);
const AT = '2026-11-27T10:00:00.000Z';
const draft = (over = {}) => ({ id: 'draft-0001', at: AT, period: 'weeks8', draft: 'Texte de test synthétique.', reason: 'Raison de test.', limits: ['limite de test'], sources: [], confirmations: ['plan_review'], state: 'pending', ...over });
const SESSIONS = {
  'tok-owner': { merchantId: M, userId: 'u-owner', role: 'OWNER', module: 'growth' },
  'tok-collab': { merchantId: M, userId: 'u-collab', role: 'COLLABORATOR', module: 'growth' },
  'tok-viewer': { merchantId: M, userId: 'u-viewer', role: 'VIEWER', module: 'growth' },
  'tok-other': { merchantId: OTHER, userId: 'u-other', role: 'OWNER', module: 'growth' },
};

function gate() {
  const identity = { context: { module: 'growth' }, resolveAccessSession: async (t) => (SESSIONS[t] ? { ok: true, ...SESSIONS[t] } : { ok: false }),
    authenticateAndOpenSession: async () => ({ ok: false, status: 401 }), logoutSession: async () => {} };
  const security = { module: 'growth', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (t) => `sid=${t}; HttpOnly`, csrfCookie: (t) => `__Host-nordla_growth_csrf=${t}`, clearSessionCookie: () => '', clearCsrfCookie: () => '' },
    csrfTokenFor: (t) => `csrf-${t}`, guardRead: () => ({ ok: true }), guardLogin: () => ({ ok: true, ctx: { requestId: 'r', clientIp: '127.0.0.1' } }),
    readLoginBody: async () => ({}), normalizeLogin: async (fn) => fn(), publicError: () => ({ status: 400, error: 'BAD' }),
    guardMutation: async (req, resolve) => {
      const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null;
      if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' };
      if (req.headers['x-nordla-csrf'] !== `csrf-${t}`) return { ok: false, code: 'CSRF_INVALID', response: { status: 403, error: 'CSRF_INVALID' } };
      return { ok: true, access: a, sessionToken: t };
    } };
  return createSessionGate({ identity, security, moduleCode: 'growth' });
}

async function boot(store) {
  const app = createGrowthApp({ merchantId: M, hosted: true });
  const handler = createHostedGrowth({ gate: gate(), merchantId: M, historyScope: S, app, store });
  const s = http.createServer(handler); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (path, { token = null, method = 'GET', body = null, csrf = token ? `csrf-${token}` : null } = {}) => {
    const headers = { ...(token ? { cookie: `sid=${token}` } : {}), ...(csrf && method !== 'GET' ? { 'x-nordla-csrf': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const raw = await r.text(); let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } return { status: r.status, json };
  };
  return { req, close: () => new Promise((r) => s.close(r)) };
}
const review = (srv, token, body, extra = {}) => srv.req('/api/growth/agents/review', { token, method: 'POST', body, ...extra });
const rowOf = async (store, scope = M) => (await store.list(scope)).find((r) => r.key === agentDraftKey(scope === M ? S : SO));
const seed = async (store, drafts, merchant = M, key = KEY) => store.put(merchant, key, { v: 1, drafts }, 0, 'u-owner', new Date(AT));

test('A4 transitions: pending -> validated records the date and the reviewer; the same decision again changes nothing; the opposite is refused', async () => {
  const store = createMemoryFollowUpStore(); await seed(store, [draft()]);
  const srv = await boot(store);
  try {
    const ok = await review(srv, 'tok-owner', { id: 'draft-0001', status: 'validated' });
    assert.equal(ok.status, 200); assert.equal(ok.json.ok, true); assert.equal(ok.json.version, 2);
    const d = ok.json.value.drafts[0];
    assert.equal(d.state, 'validated'); assert.equal(d.reviewedBy, 'u-owner'); assert.match(d.reviewedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((await rowOf(store)).value.drafts[0].state, 'validated', 'stored, not only answered');
    const again = await review(srv, 'tok-owner', { id: 'draft-0001', status: 'validated' });
    assert.equal(again.status, 200); assert.equal(again.json.unchanged, true); assert.equal((await rowOf(store)).version, 2, 'no second write');
    const opposite = await review(srv, 'tok-owner', { id: 'draft-0001', status: 'rejected' });
    assert.equal(opposite.status, 409); assert.equal(opposite.json.error.code, 'ALREADY_REVIEWED');
    assert.equal((await rowOf(store)).value.drafts[0].state, 'validated', 'a reviewed draft keeps its decision');
  } finally { await srv.close(); }
});

test('A4 rejected: pending -> rejected is recorded with the same rules; the reviewer is the session user', async () => {
  const store = createMemoryFollowUpStore(); await seed(store, [draft()]);
  const srv = await boot(store);
  try {
    const r = await review(srv, 'tok-collab', { id: 'draft-0001', status: 'rejected' });
    assert.equal(r.status, 200); assert.equal(r.json.value.drafts[0].state, 'rejected'); assert.equal(r.json.value.drafts[0].reviewedBy, 'u-collab');
  } finally { await srv.close(); }
});

test('A4 validation: the status and the draft id are checked on the server; an unknown draft is 404 and nothing is written', async () => {
  const store = createMemoryFollowUpStore(); await seed(store, [draft()]);
  const srv = await boot(store);
  try {
    assert.equal((await review(srv, 'tok-owner', { id: 'short', status: 'validated' })).json.error.code, 'DRAFT_ID_INVALID');
    assert.equal((await review(srv, 'tok-owner', { id: 'bad id with spaces', status: 'validated' })).json.error.code, 'DRAFT_ID_INVALID');
    assert.equal((await review(srv, 'tok-owner', { id: 'draft-0001', status: 'pending' })).json.error.code, 'STATUS_INVALID');
    assert.equal((await review(srv, 'tok-owner', { id: 'draft-0001', status: 'published' })).json.error.code, 'STATUS_INVALID');
    const unknown = await review(srv, 'tok-owner', { id: 'draft-9999', status: 'validated' });
    assert.equal(unknown.status, 404); assert.equal(unknown.json.error.code, 'DRAFT_NOT_FOUND');
    assert.equal((await rowOf(store)).version, 1, 'nothing written by a refused decision');
  } finally { await srv.close(); }
});

test('A4 roles: a viewer cannot review a draft; a missing CSRF token is refused; nothing is written', async () => {
  const store = createMemoryFollowUpStore(); await seed(store, [draft()]);
  const srv = await boot(store);
  try {
    const v = await review(srv, 'tok-viewer', { id: 'draft-0001', status: 'validated' });
    assert.equal(v.status, 403); assert.equal(v.json.error.code, 'FORBIDDEN_ROLE');
    const noCsrf = await review(srv, 'tok-owner', { id: 'draft-0001', status: 'validated' }, { csrf: null });
    assert.equal(noCsrf.status, 403); assert.match(JSON.stringify(noCsrf.json), /CSRF_INVALID/);
    assert.equal((await rowOf(store)).value.drafts[0].state, 'pending');
  } finally { await srv.close(); }
});

test('A4 isolation: another merchant cannot review this draft, and an identical id under another scope is never touched', async () => {
  const store = createMemoryFollowUpStore(); await seed(store, [draft()]);
  await seed(store, [draft({ state: 'pending' })], OTHER, agentDraftKey(SO));
  const srv = await boot(store);
  try {
    const foreign = await review(srv, 'tok-other', { id: 'draft-0001', status: 'validated' });
    assert.equal(foreign.status, 403); assert.equal(foreign.json.error.code, 'TENANT_MISMATCH');
    assert.equal((await rowOf(store, OTHER)).value.drafts[0].state, 'pending', 'the other merchant row is untouched');
    assert.equal((await rowOf(store)).value.drafts[0].state, 'pending');
  } finally { await srv.close(); }
});

test('A4 legacy drafts (A3, no id, state to_validate) keep their id rule and become pending -> validated on review', async () => {
  const store = createMemoryFollowUpStore(); await seed(store, [{ at: AT, period: 'weeks8', draft: 'Ancien brouillon.', reason: 'r', limits: [], sources: [], confirmations: [], state: 'to_validate' }]);
  const srv = await boot(store);
  try {
    const legacyId = draftId({ at: AT }); assert.equal(legacyId, 'a20261127100000000');
    assert.equal(normalizeDraftState('to_validate'), 'pending');
    const r = await review(srv, 'tok-owner', { id: legacyId, status: 'validated' });
    assert.equal(r.status, 200); assert.equal(r.json.value.drafts[0].state, 'validated'); assert.equal(r.json.value.drafts[0].id, legacyId);
  } finally { await srv.close(); }
});

test('A4 value rules: draft states and ids are checked when the agent drafts are written', () => {
  const key = agentDraftKey(S);
  assert.equal(followUpValueError(key, { v: 1, drafts: [draft()] }), null);
  assert.equal(followUpValueError(key, { v: 1, drafts: [draft({ state: 'published' })] }), 'VALUE_INVALID');
  assert.equal(followUpValueError(key, { v: 1, drafts: [draft({ id: 'x' })] }), 'VALUE_INVALID');
  assert.equal(followUpValueError(key, { v: 1, drafts: ['not an object'] }), 'VALUE_INVALID');
});

test('A4 local preview: a decision is refused (NOT_HOSTED), the route is never a dead end', async () => {
  const app = createGrowthApp({});
  const s = http.createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/growth/agents/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'draft-0001', status: 'validated' }) });
    assert.equal(r.status, 503); assert.equal((await r.json()).error.code, 'NOT_HOSTED');
  } finally { s.close(); }
});
