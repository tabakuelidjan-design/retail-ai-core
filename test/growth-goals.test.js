// Nordla Growth - Administration objectives: stored as the merchant's own follow-up entry (no opportunity id in its key), value rules, role and
// merchant isolation, version conflict, and the admin page wiring. Synthetic data only. No model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createHostedGrowth } from '../src/growth/server/hosted.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createMemoryFollowUpStore, followUpKeyOk, followUpValueError } from '../src/growth/server/follow-up-store.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';

const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'; const OTHER = '11111111-1111-4111-8111-111111111111';
const scopeOf = (id) => createHash('sha256').update(id).digest('hex');
const S = scopeOf(M); const SO = scopeOf(OTHER);
const KEY = `nordla.growth.goals.v1:${S}`;
const goalValue = (target = 5000, extra = {}) => ({ v: 1, goals: { weeklySalesTargetEur: target, updatedAt: '2026-11-27T10:00:00.000Z', ...extra } });
const UI = new URL('../src/growth/ui/', import.meta.url);

test('key: a goal key carries the merchant scope and NO opportunity id; another merchant scope is refused', () => {
  assert.equal(followUpKeyOk(KEY, S), true);
  assert.equal(followUpKeyOk(`${KEY}:opp-1`, S), false, 'a goal is not attached to an opportunity');
  assert.equal(followUpKeyOk(`nordla.growth.goals.v1:${SO}`, S), false, 'another merchant scope is refused');
  assert.equal(followUpKeyOk('nordla.growth.goals.v2:' + S, S), false);
});

test('value: an integer target from 0 to 100 000 000 €, or none; an optional short note; nothing else', () => {
  assert.equal(followUpValueError(KEY, goalValue(5000)), null);
  assert.equal(followUpValueError(KEY, goalValue(null)), null, 'no target is allowed');
  assert.equal(followUpValueError(KEY, goalValue(0)), null);
  assert.equal(followUpValueError(KEY, goalValue(100000000)), null);
  for (const bad of [1.5, -1, 100000001, '5000', NaN]) assert.equal(followUpValueError(KEY, goalValue(bad)), 'VALUE_INVALID', String(bad));
  assert.equal(followUpValueError(KEY, goalValue(5000, { note: 'x'.repeat(201) })), 'VALUE_INVALID');
  assert.equal(followUpValueError(KEY, goalValue(5000, { note: 'objectif de test' })), null);
  assert.equal(followUpValueError(KEY, { v: 1, goals: { weeklySalesTargetEur: 5000, owner: 'someone' } }), 'VALUE_INVALID', 'unknown field');
  assert.equal(followUpValueError(KEY, { v: 2, goals: { weeklySalesTargetEur: 5000 } }), 'VALUE_INVALID');
});

// ---- hosted: real session gate over fake identity / HTTP security, in-memory store ----
const SESSIONS = {
  'tok-owner': { merchantId: M, userId: 'u-owner', role: 'OWNER', module: 'growth' },
  'tok-viewer': { merchantId: M, userId: 'u-viewer', role: 'VIEWER', module: 'growth' },
  'tok-other': { merchantId: OTHER, userId: 'u-other', role: 'OWNER', module: 'growth' },
};
function gate() {
  const identity = { context: { module: 'growth' }, resolveAccessSession: async (t) => (SESSIONS[t] ? { ok: true, ...SESSIONS[t] } : { ok: false }), authenticateAndOpenSession: async () => ({ ok: false, status: 401 }), logoutSession: async () => {} };
  const security = { module: 'growth', cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (t) => `sid=${t}; HttpOnly`, csrfCookie: (t) => `__Host-nordla_growth_csrf=${t}`, clearSessionCookie: () => '', clearCsrfCookie: () => '' },
    csrfTokenFor: (t) => `csrf-${t}`, guardRead: () => ({ ok: true }), guardLogin: () => ({ ok: true, ctx: { requestId: 'r', clientIp: '127.0.0.1' } }), readLoginBody: async () => ({}), normalizeLogin: async (fn) => fn(), publicError: () => ({ status: 400, error: 'BAD' }),
    guardMutation: async (req, resolve) => { const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null; if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' }; if (req.headers['x-nordla-csrf'] !== `csrf-${t}`) return { ok: false, code: 'CSRF_INVALID', response: { status: 403, error: 'CSRF_INVALID' } }; return { ok: true, access: a, sessionToken: t }; } };
  return createSessionGate({ identity, security, moduleCode: 'growth' });
}
async function boot(store) {
  const app = createGrowthApp({ merchantId: M, hosted: true });
  const s = http.createServer(createHostedGrowth({ gate: gate(), merchantId: M, historyScope: S, app, store }));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const put = (token, body, csrf = `csrf-${token}`) => fetch(base + '/api/growth/follow-up', { method: 'PUT', headers: { cookie: `sid=${token}`, ...(csrf ? { 'x-nordla-csrf': csrf } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  return { put, store, close: () => new Promise((r) => s.close(r)) };
}

test('hosted: the owner stores the target; a stale write is a version conflict; the value is read back for this merchant only', async () => {
  const store = createMemoryFollowUpStore();
  const srv = await boot(store);
  try {
    const ok = await srv.put('tok-owner', { key: KEY, value: goalValue(5000), expected_version: 0 });
    assert.equal(ok.status, 200); assert.equal(ok.json.version, 1);
    const again = await srv.put('tok-owner', { key: KEY, value: goalValue(6000), expected_version: 0 });
    assert.equal(again.status, 409, 'a write based on an old version is refused, nothing is overwritten');
    const row = (await store.list(M)).find((r) => r.key === KEY);
    assert.equal(row.value.goals.weeklySalesTargetEur, 5000);
    assert.equal((await store.list(OTHER)).length, 0, 'the other merchant has no goal');
  } finally { await srv.close(); }
});

test('hosted: a viewer cannot store a target; another merchant cannot write under this scope; a missing CSRF token is refused', async () => {
  const store = createMemoryFollowUpStore();
  const srv = await boot(store);
  try {
    const viewer = await srv.put('tok-viewer', { key: KEY, value: goalValue(5000), expected_version: 0 });
    assert.equal(viewer.status, 403); assert.equal(viewer.json.error.code, 'FORBIDDEN_ROLE');
    const foreign = await srv.put('tok-other', { key: KEY, value: goalValue(5000), expected_version: 0 });
    assert.equal(foreign.status, 403, 'a session of another merchant never reaches this scope');
    const noCsrf = await srv.put('tok-owner', { key: KEY, value: goalValue(5000), expected_version: 0 }, null);
    assert.equal(noCsrf.status, 403);
    assert.equal((await store.list(M)).length, 0, 'nothing was written');
  } finally { await srv.close(); }
});

test('admin payload: the page receives its merchant scope (the goal itself is read from the merchant follow-up entry)', async () => {
  const s = http.createServer(createGrowthApp({ merchantId: M }));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const adm = await (await fetch(`http://127.0.0.1:${s.address().port}/api/growth/admin`)).json();
    assert.equal(adm.historyScope, S);
    assert.equal(adm.goals, undefined);
  } finally { s.close(); }
});

test('UI: the objective form validates the number before it is written, writes through the merchant storage, and its texts exist in fr, nl and en', async () => {
  const agents = await readFile(new URL('agents.js', UI), 'utf8');
  assert.match(agents, /growthStorage\.setItem\(key, JSON\.stringify\(\{ v: 1, goals:/);
  assert.match(agents, /!Number\.isInteger\(n\) \|\| n < 0 \|\| n > 100000000/);
  assert.doesNotMatch(agents, /innerHTML/);
  const lang = await readFile(new URL('lang-agents.js', UI), 'utf8');
  const vm = (await import('node:vm')).default;
  const keys = ['gr.adm.goal.label', 'gr.adm.goal.save', 'gr.adm.goal.invalid', 'gr.adm.goal.noScope', 'gr.adm.goal.current', 'gr.adm.goal.none', 'gr.adm.goal.hosted', 'gr.adm.goal.local', 'gr.adm.goal.notUsed'];
  for (const l of ['fr', 'nl', 'en']) {
    const ctx = { window: {} };
    vm.runInNewContext(await readFile(new URL(`lang-${l}.js`, UI), 'utf8'), ctx);
    vm.runInNewContext(lang, ctx);
    for (const k of keys) assert.ok(ctx.window.NORDLA_DICTS[l][k], `${l}: missing ${k}`);
  }
});
