// Hosted Growth: sign-in through the Core identity gate of the 'growth' module, tenant scope, roles, and the SERVER-SIDE follow-up (plans, applied actions, review results,
// requests and commercial follow-up) per merchant. Fakes only: a fake identity + HTTP security under the REAL session gate, an in-memory store, a fake Supabase
// (PostgREST semantics). No network, no credential. The browser side (session.js + persist.js) runs in a vm against the real HTTP server, two separate "browsers".
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createHostedGrowth } from '../src/growth/server/hosted.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createMemoryFollowUpStore, createSupabaseFollowUpStore, followUpKeyOk, MAX_ENTRY_BYTES } from '../src/growth/server/follow-up-store.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';
import { growthHostedConfig, buildGrowthGate } from '../src/growth/server/hosted-main.js';
import { Node, all, text } from './growth-dom.js';

const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'; const OTHER = '11111111-1111-4111-8111-111111111111';
const scopeOf = (id) => createHash('sha256').update(id).digest('hex');
const S = scopeOf(M); const SO = scopeOf(OTHER);
const OPKEY = `nordla.growth.follow-up.v1:${S}:op-1`; const PIPEKEY = `nordla.growth.pipeline.v1:${S}`;
const plan = (at = '2026-11-16T10:00:00.000Z') => ({ snapshot: { id: 'op-1' }, events: [{ type: 'plan', at, text: 'Préparer la gourde' }] });
const pipe = () => ({ v: 1, requests: { r1: { id: 'r1' } }, events: [] });

const SESSIONS = {
  'tok-owner': { merchantId: M, userId: 'u-owner', role: 'OWNER', module: 'growth' },
  'tok-collab': { merchantId: M, userId: 'u-collab', role: 'COLLABORATOR', module: 'growth' },
  'tok-viewer': { merchantId: M, userId: 'u-viewer', role: 'VIEWER', module: 'growth' },
  'tok-other': { merchantId: OTHER, userId: 'u-other', role: 'OWNER', module: 'growth' },
};
const LOGINS = { 'owner@nordla-test.example': 'tok-owner', 'collab@nordla-test.example': 'tok-collab', 'viewer@nordla-test.example': 'tok-viewer', 'other@nordla-test.example': 'tok-other' };
const CSRF = '__Host-nordla_growth_csrf';

/** The real session gate over a fake identity (sessions by token) and a fake HTTP security (the cookie is the token; a change needs x-nordla-csrf = 'csrf-' + token). */
function gateOver(sessions = SESSIONS, moduleCode = 'growth', features = {}) {
  const identity = { context: { module: moduleCode },
    resolveAccessSession: async (t) => (sessions[t] ? { ok: true, ...sessions[t] } : { ok: false }),
    authenticateAndOpenSession: async ({ email, password }) => (LOGINS[email] && password === 'right' ? { ok: true, token: LOGINS[email], session: { role: sessions[LOGINS[email]].role } } : { ok: false, status: 401, error: 'LOGIN_FAILED', message: 'Connexion impossible.' }),
    logoutSession: async () => {} };
  const security = { module: moduleCode, cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (t) => `sid=${t}; HttpOnly`, csrfCookie: (t) => `${CSRF}=${t}`, clearSessionCookie: () => 'sid=; Max-Age=0', clearCsrfCookie: () => `${CSRF}=; Max-Age=0` },
    csrfTokenFor: (t) => `csrf-${t}`,
    guardRead: () => ({ ok: true }), guardLogin: () => ({ ok: true, ctx: { requestId: 'r', clientIp: '127.0.0.1' } }),
    readLoginBody: async (req) => { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString()); },
    normalizeLogin: async (fn) => fn(), publicError: () => ({ status: 400, error: 'BAD' }),
    guardMutation: async (req, resolve) => {
      const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null;
      if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' };
      if (req.headers['x-nordla-csrf'] !== `csrf-${t}`) return { ok: false, code: 'CSRF_INVALID', response: { status: 403, error: 'CSRF_INVALID' } };
      return { ok: true, access: a, sessionToken: t };
    } };
  return createSessionGate({ identity, security, moduleCode, features });
}

async function boot({ merchantId = M, store = createMemoryFollowUpStore(), sessions = SESSIONS, ssoOnly = false } = {}) {
  const app = createGrowthApp({ merchantId, hosted: true });
  const handler = createHostedGrowth({ gate: gateOver(sessions, 'growth', { ssoOnly }), merchantId, historyScope: scopeOf(merchantId), app, store, ssoOnly });
  const s = http.createServer(handler); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (path, { token = null, method = 'GET', body = null, csrf = token ? `csrf-${token}` : null } = {}) => {
    const headers = { ...(token ? { cookie: `sid=${token}` } : {}), ...(csrf && method !== 'GET' ? { 'x-nordla-csrf': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const raw = await r.text(); let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } return { status: r.status, json, raw, headers: r.headers };
  };
  return { base, req, store, close: () => new Promise((r) => s.close(r)) };
}
const put = (srv, token, key, value, expected = 0, extra = {}) => srv.req('/api/growth/follow-up', { token, method: 'PUT', body: { key, value, expected_version: expected }, ...extra });

test('HOS-1 the page and its scripts need no session; every API route needs one; the hosted script is served only to the hosted app', async () => {
  const srv = await boot();
  try {
    const page = await srv.req('/'); assert.equal(page.status, 200); assert.ok(page.raw.includes('<script src="session.js"></script>') && page.raw.includes('src="persist.js"'), 'the hosted page loads the sign-in script (relative path, so it works under the Core /growth/ mount)');
    assert.equal((await srv.req('/session.js')).status, 200); assert.equal((await srv.req('/persist.js')).status, 200); assert.equal((await srv.req('/nordla-ds.css')).status, 200);
    assert.equal((await srv.req('/healthz')).status, 200);
    for (const p of ['/api/growth/overview', '/api/growth/opportunities', '/api/growth/corrections', '/api/growth/review', '/api/growth/follow-up', '/api/growth/store']) assert.equal((await srv.req(p)).status, 401, `${p} without a session`);
    assert.equal((await srv.req('/api/growth/follow-up', { method: 'PUT', body: { key: OPKEY, value: plan(), expected_version: 0 } })).status, 401);
    const local = http.createServer(createGrowthApp({})); await new Promise((r) => local.listen(0, '127.0.0.1', r));
    const lp = await fetch(`http://127.0.0.1:${local.address().port}/`); const lt = await lp.text();
    assert.ok(!lt.includes('/session.js'), 'the local preview page never loads the sign-in script');
    assert.equal((await fetch(`http://127.0.0.1:${local.address().port}/session.js`)).status === 200, false, 'the local server does not serve it');
    await new Promise((r) => local.close(r));
  } finally { await srv.close(); }
});

test('HOS-2 a session of another merchant is refused on every route (TENANT_MISMATCH), reads and writes', async () => {
  const srv = await boot();
  try {
    for (const p of ['/api/growth/follow-up', '/api/growth/opportunities']) { const r = await srv.req(p, { token: 'tok-other' }); assert.equal(r.status, 403); assert.equal(r.json.error.code, 'TENANT_MISMATCH'); }
    const w = await put(srv, 'tok-other', `nordla.growth.follow-up.v1:${SO}:op-1`, plan()); assert.equal(w.status, 403); assert.equal(w.json.error.code, 'TENANT_MISMATCH');
    assert.deepEqual(await srv.store.list(OTHER), [], 'nothing was written for the other merchant');
  } finally { await srv.close(); }
});

test('HOS-3 follow-up: save, read, versions, scope of keys, shapes, sizes, roles, CSRF', async () => {
  const srv = await boot();
  try {
    const a = await put(srv, 'tok-owner', OPKEY, plan(), 0); assert.equal(a.status, 200); assert.equal(a.json.version, 1);
    const g = await srv.req('/api/growth/follow-up', { token: 'tok-owner' }); assert.equal(g.status, 200); assert.equal(g.json.merchant_scope, S);
    assert.deepEqual(g.json.entries.map((e) => [e.key, e.version]), [[OPKEY, 1]]); assert.equal(g.json.entries[0].value.events[0].text, 'Préparer la gourde');
    // version: updating names the version it read; a stale writer is refused with the current entry
    const b = await put(srv, 'tok-owner', OPKEY, plan('2026-11-16T11:00:00.000Z'), 1); assert.equal(b.json.version, 2);
    const stale = await put(srv, 'tok-collab', OPKEY, plan('2026-11-16T12:00:00.000Z'), 1); assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'VERSION_CONFLICT'); assert.equal(stale.json.current.version, 2);
    const exists = await put(srv, 'tok-collab', OPKEY, plan(), 0); assert.equal(exists.status, 409, 'creating an entry that exists is a conflict');
    // keys: only this merchant's scope and only the shapes the screen writes
    for (const key of [`nordla.growth.follow-up.v1:${SO}:op-1`, 'nordla.growth.follow-up.v1:abc:op-1', `nordla.growth.follow-up.v1:${S}`, `nordla.growth.pipeline.v1:${S}:x`, `other.key:${S}:op`, '../etc/passwd', 42, null]) {
      const r = await put(srv, 'tok-owner', key, plan()); assert.equal(r.status, 400, String(key)); assert.equal(r.json.error.code, 'KEY_NOT_ALLOWED');
    }
    assert.equal((await put(srv, 'tok-owner', OPKEY, 'text', 2)).status, 400); assert.equal((await put(srv, 'tok-owner', OPKEY, [], 2)).status, 400); assert.equal((await put(srv, 'tok-owner', OPKEY, { events: 'x', snapshot: {} }, 2)).status, 400);
    assert.equal((await put(srv, 'tok-owner', PIPEKEY, { v: 2, requests: {} })).status, 400); assert.equal((await put(srv, 'tok-owner', PIPEKEY, pipe(), 0)).status, 200);
    const big = await put(srv, 'tok-owner', OPKEY, { snapshot: {}, events: [], pad: 'x'.repeat(MAX_ENTRY_BYTES) }, 2); assert.ok([400, 413].includes(big.status)); assert.equal(big.status, 413);
    assert.equal((await put(srv, 'tok-owner', OPKEY, plan(), -1)).status, 400); assert.equal((await put(srv, 'tok-owner', OPKEY, plan(), 'x')).status, 400);
    // roles and CSRF
    const v = await put(srv, 'tok-viewer', OPKEY, plan(), 2); assert.equal(v.status, 403); assert.equal(v.json.error.code, 'FORBIDDEN_ROLE'); assert.equal((await srv.req('/api/growth/follow-up', { token: 'tok-viewer' })).status, 200, 'a viewer reads');
    assert.equal((await put(srv, 'tok-owner', OPKEY, plan(), 2, { csrf: 'wrong' })).status, 403); assert.equal((await put(srv, 'tok-owner', OPKEY, plan(), 2, { csrf: null })).status, 403);
    assert.equal((await srv.req('/api/growth/follow-up', { token: 'tok-owner', method: 'DELETE', csrf: 'csrf-tok-owner' })).status, 405);
    assert.equal((await srv.req('/api/growth/follow-up', { token: 'tok-owner', method: 'PUT', body: null })).status, 400);
  } finally { await srv.close(); }
});

test('HOS-4 two merchants on ONE store never see or change each other\'s follow-up; the same plan is found by another person, and after a restart', async () => {
  const store = createMemoryFollowUpStore();
  const a = await boot({ merchantId: M, store }); const b = await boot({ merchantId: OTHER, store });
  try {
    assert.equal((await put(a, 'tok-owner', OPKEY, plan(), 0)).status, 200);
    assert.equal((await put(b, 'tok-other', `nordla.growth.follow-up.v1:${SO}:op-1`, { snapshot: { id: 'op-1' }, events: [{ type: 'plan', at: '2026-11-16T09:00:00.000Z', text: 'AUTRE BOUTIQUE' }] }, 0)).status, 200);
    const ga = await a.req('/api/growth/follow-up', { token: 'tok-owner' }); const gb = await b.req('/api/growth/follow-up', { token: 'tok-other' });
    assert.deepEqual(ga.json.entries.map((e) => e.key), [OPKEY]); assert.ok(!JSON.stringify(ga.json).includes('AUTRE BOUTIQUE'));
    assert.deepEqual(gb.json.entries.map((e) => e.key), [`nordla.growth.follow-up.v1:${SO}:op-1`]); assert.ok(!JSON.stringify(gb.json).includes('Préparer la gourde'));
    // the other merchant's session cannot reach M's server, and M's key cannot be written through the other merchant's server
    assert.equal((await a.req('/api/growth/follow-up', { token: 'tok-other' })).status, 403); assert.equal((await put(b, 'tok-other', OPKEY, plan(), 0)).status, 400);
    // another person of the same merchant (another browser) finds the same plan
    assert.equal((await a.req('/api/growth/follow-up', { token: 'tok-collab' })).json.entries[0].value.events[0].text, 'Préparer la gourde');
    // a restart: a new server instance over the same store
    const again = await boot({ merchantId: M, store }); try { assert.equal((await again.req('/api/growth/follow-up', { token: 'tok-owner' })).json.entries.length, 1); } finally { await again.close(); }
  } finally { await a.close(); await b.close(); }
});

/** A tiny PostgREST: select / insertIgnoringDuplicates / update with eq filters, recording every call. */
function fakePostgrest() {
  const rows = []; const calls = [];
  const eqs = (f) => Object.entries(f).filter(([k, v]) => typeof v === 'string' && v.startsWith('eq.')).map(([k, v]) => [k, v.slice(3)]);
  const match = (r, f) => eqs(f).every(([k, v]) => String(r[k]) === v);
  return { rows, calls,
    async select(table, p) { calls.push(['select', table, p]); return rows.filter((r) => match(r, p)).map((r) => ({ ...r, value: structuredClone(r.value) })); },
    async insertIgnoringDuplicates(table, rs) { calls.push(['insert', table, rs]); const out = []; for (const r of rs) if (!rows.some((x) => x.merchant_id === r.merchant_id && x.entry_key === r.entry_key)) { rows.push(structuredClone(r)); out.push(structuredClone(r)); } return out; },
    async update(table, f, patch) { calls.push(['update', table, f, patch]); const out = []; for (const r of rows) if (match(r, f)) { Object.assign(r, structuredClone(patch)); out.push(structuredClone(r)); } return out; } };
}
test('HOS-5 the Supabase store: every query names the merchant; writes are conditional on the version; same contract as the memory store', async () => {
  const pg = fakePostgrest(); const store = createSupabaseFollowUpStore(pg);
  assert.deepEqual(await store.put(M, OPKEY, plan(), 0, 'u1'), { ok: true, version: 1 });
  assert.deepEqual(await store.put(M, OPKEY, plan('2026-11-17T00:00:00.000Z'), 1, 'u2'), { ok: true, version: 2 });
  const stale = await store.put(M, OPKEY, plan(), 1, 'u3'); assert.equal(stale.code, 'VERSION_CONFLICT'); assert.equal(stale.current.version, 2);
  const dup = await store.put(M, OPKEY, plan(), 0, 'u3'); assert.equal(dup.code, 'VERSION_CONFLICT');
  assert.equal(pg.rows[0].updated_by, 'u2'); assert.equal(pg.rows[0].merchant_id, M);
  // the other merchant's row with the SAME key text is separate: the key carries the scope, the row carries the merchant
  assert.deepEqual(await store.put(OTHER, OPKEY, plan(), 0, 'u9'), { ok: true, version: 1 });
  assert.equal((await store.list(M)).length, 1); assert.equal((await store.list(OTHER)).length, 1);
  for (const [kind, , a, b] of pg.calls) { if (kind === 'select') assert.match(a.merchant_id, /^eq\./); if (kind === 'update') assert.match(a.merchant_id, /^eq\./); if (kind === 'insert') assert.ok(a.every((r) => r.merchant_id)); }
  // a store row of another scope is never returned by the hosted API even if it were in the table
  const mem = createMemoryFollowUpStore(); await mem.put(M, `nordla.growth.follow-up.v1:${SO}:op-1`, plan(), 0, 'x');
  const srv = await boot({ store: mem }); try { assert.deepEqual((await srv.req('/api/growth/follow-up', { token: 'tok-owner' })).json.entries, []); } finally { await srv.close(); }
  assert.ok(followUpKeyOk(OPKEY, S) && followUpKeyOk(PIPEKEY, S) && !followUpKeyOk(OPKEY, SO));
  assert.ok(followUpKeyOk(`nordla.growth.follow-up.v1:${S}:${encodeURIComponent('product:7e570001-0000-4000-8000-000000000001')}`, S), 'an opportunity id with ":" is written percent-encoded by the screen (a product opportunity could not be saved)');
  assert.ok(!followUpKeyOk(`nordla.growth.follow-up.v1:${S}:op%zz`, S) && !followUpKeyOk(`nordla.growth.follow-up.v1:${S}:op%2`, S) && !followUpKeyOk(`nordla.growth.follow-up.v1:${S}:a b`, S), 'a bare or malformed % is still refused');
});

test('HOS-6 hosted start: complete configuration or nothing; the gate is built for the growth module only', async () => {
  const base = { GROWTH_HOSTED: '1', NORDLA_MERCHANT_ID: M, GROWTH_PUBLIC_ORIGIN: 'https://app.nordla.app', SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_ANON_KEY: 'a', NORDLA_IDENTITY_RATE_LIMIT_KEY: 'k'.repeat(40), NORDLA_CSRF_KEY: 'c'.repeat(40), NORDLA_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' };
  const cfg = growthHostedConfig(base); assert.equal(cfg.merchantId, M); assert.equal(cfg.origin, 'https://app.nordla.app'); assert.deepEqual(cfg.allowedHosts, ['app.nordla.app']);
  assert.throws(() => growthHostedConfig({ ...base, GROWTH_HOSTED: '' }), { code: 'HOSTED_NOT_ENABLED' });
  assert.throws(() => growthHostedConfig({ ...base, NORDLA_MERCHANT_ID: '' }), { code: 'HOSTED_MERCHANT_REQUIRED' });
  assert.throws(() => growthHostedConfig({ ...base, GROWTH_PUBLIC_ORIGIN: 'http://app.nordla.app' }), { code: 'HOSTED_ORIGIN_REQUIRED' });
  assert.throws(() => growthHostedConfig({ ...base, NORDLA_CSRF_KEY: '' }), { code: 'HOSTED_IDENTITY_REQUIRED' });
  assert.throws(() => growthHostedConfig({ ...base, SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' }), { code: 'HOSTED_SUPABASE_PROJECT_MISMATCH' });
  assert.throws(() => buildGrowthGate(base, cfg, { identity: { context: { module: 'sourcing' }, resolveAccessSession() {}, authenticateAndOpenSession() {} }, security: { module: 'growth', guardMutation() {} } }), /growth/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The browser side: session.js + persist.js in a vm, each "browser" with its own cookie jar and its own localStorage, talking to the real HTTP server above.
async function browser(srv, { local = {}, lang = 'fr' } = {}) {
  const jar = new Map(); const ls = new Map(Object.entries(local)); const errors = []; const requests = [];
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const realFetch = async (path, init = {}) => {
    requests.push(`${(init.method ?? 'GET').toUpperCase()} ${path}`); // what the page actually sent (method and path only)
    const r = await fetch(srv.base + path, { ...init, headers: { ...(init.headers ?? {}), cookie: cookieHeader() } });
    for (const sc of r.headers.getSetCookie()) { const kv = sc.split(';')[0]; const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (v === '') jar.delete(k); else jar.set(k, v); }
    return r;
  };
  const root = new Node('div'); const byId = (id) => all(root, (n) => n.attrs?.id === id)[0] ?? null;
  const document = { createElement: (t) => new Node(t), createTextNode: (s) => ({ nodeType: 3, data: s }), getElementById: (id) => (id === 'app' ? root : byId(id)),
    get cookie() { return [...jar].filter(([k]) => k === CSRF).map(([k, v]) => `${k}=${v}`).join('; '); } };
  const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : (k === 'nordla_lang' ? lang : null)), setItem: (k, v) => { ls.set(k, String(v)); }, key: (i) => [...ls.keys()][i] ?? null, get length() { return ls.size; } };
  const ctx = { document, console: { error: (...a) => errors.push(a.join(' ')), log() {} }, localStorage, fetch: realFetch, Intl, Math, Date, JSON, Object, Array, Set, Map, Number, String, Error, Promise, setTimeout, location: { reload() { ctx.reloaded = true; }, pathname: '/', hash: '' }, reloaded: false };
  ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.window.location = ctx.location;
  vm.createContext(ctx);
  // the page's tiny element helper (app.js defines the real one): same contract for what session.js uses (class, id, on, disabled, children)
  vm.runInContext(`function h(tag, attrs, ...children) { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') el.className = v; else if (k === 'on') { for (const [e, f] of Object.entries(v)) el.addEventListener(e, f); } else el.setAttribute(k, v === true ? '' : v); } const add = (c) => { if (Array.isArray(c)) c.forEach(add); else if (c != null && c !== false) el.append(c); }; children.forEach(add); return el; }`, ctx);
  for (const f of [new URL('../src/analytics-premium/ui/i18n.js', import.meta.url), new URL('../src/growth/ui/lang-fr.js', import.meta.url), new URL('../src/growth/ui/lang-nl.js', import.meta.url), new URL('../src/growth/ui/lang-en.js', import.meta.url)]) vm.runInContext(await readFile(f, 'utf8'), ctx, { filename: f.pathname });
  vm.runInContext('const t = NORDLA_I18N.t;', ctx); // app.js defines this one line in the page; session.js uses it when it is called
  for (const f of [new URL('../src/growth/ui/persist.js', import.meta.url), new URL('../src/growth/ui/session.js', import.meta.url)]) vm.runInContext(await readFile(f, 'utf8'), ctx, { filename: f.pathname });
  const b = {
    ctx, root, errors, ls, jar, requests,
    boot: async () => { await ctx.growthHosted.boot(() => { b.routed += 1; }); },
    login: async (email, password = 'right') => { byId('gr-login-email').value = email; byId('gr-login-password').value = password; byId('gr-login-go').listeners.click[0](); for (let i = 0; i < 50 && !b.routed && !all(root, (n) => /gr-login-error/.test(n.className)).length; i += 1) await new Promise((r) => setTimeout(r, 10)); },
    flush: async () => { await Promise.all([...ctx.growthHosted.store.chain.values()]); await new Promise((r) => setTimeout(r, 5)); },
    set: (k, v) => vm.runInContext(`growthStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))})`, ctx),
    get: (k) => vm.runInContext(`growthStorage.getItem(${JSON.stringify(k)})`, ctx),
    screen: () => text(root), bar: () => text(ctx.growthHosted.state.bar ?? new Node('div')), routed: 0,
  };
  return b;
}

test('HOS-11 SSO-only: a direct sign-in is refused with the Nordla message (not the generic failure) and the screen does not open', async () => {
  const srv = await boot({ ssoOnly: true });
  try {
    const A = await browser(srv); await A.boot();
    assert.ok(A.screen().includes('Connectez-vous à Nordla (Core)'), 'the page says where to sign in');
    assert.ok(!A.screen().includes('Connexion impossible.'), 'not the generic failure');
    assert.equal(all(A.root, (n) => n.attrs?.id === 'gr-login-email' || n.attrs?.id === 'gr-login-password').length, 0, 'no credential field is drawn');
    assert.equal(A.requests.filter((r) => r.includes('/api/auth/login')).length, 0, 'the page sends no sign-in request');
    assert.equal(A.routed, 0, 'the screen did not open');
  } finally { await srv.close(); }
});

test('HOS-7 sign-in form, wrong password, role shown, the follow-up loads; a plan written in one browser is found in ANOTHER browser after signing in again', async () => {
  const srv = await boot();
  try {
    const A = await browser(srv); await A.boot();
    assert.ok(A.screen().includes('Connexion') && A.screen().includes('Adresse e-mail'), 'not signed in: the sign-in form, no data');
    await A.login('owner@nordla-test.example', 'wrong'); assert.ok(A.screen().includes('Connexion impossible.'), 'one public refusal'); assert.equal(A.routed, 0, 'the screen did not open');
    await A.login('owner@nordla-test.example'); assert.equal(A.routed, 1, 'signed in: the screen opens'); assert.ok(A.bar().includes('Rôle : OWNER'));
    assert.equal(A.ctx.growthPersist.server !== null, true, 'the follow-up is on the server');
    A.set(OPKEY, plan()); A.set(PIPEKEY, pipe()); assert.ok(A.get(OPKEY).includes('Préparer la gourde'), 'the screen sees its write at once'); await A.flush();
    assert.equal(A.ls.has(OPKEY), false, 'nothing is written in this browser: the server is the store');
    assert.deepEqual((await srv.store.list(M)).map((r) => r.key).sort(), [OPKEY, PIPEKEY].sort());
    // another browser, another person of the same merchant, never saw this plan before
    const B = await browser(srv); await B.boot(); await B.login('collab@nordla-test.example'); assert.equal(B.routed, 1);
    assert.equal(JSON.parse(B.get(OPKEY)).events[0].text, 'Préparer la gourde', 'the same plan is found'); assert.equal(JSON.parse(B.get(PIPEKEY)).requests.r1.id, 'r1', 'and the commercial follow-up');
    // B changes it (it read version 1), A (still on version 1... A wrote it, so it holds version 1 too) then writes again: B's change is not lost silently
    B.set(OPKEY, { ...plan('2026-11-16T12:00:00.000Z'), events: [...plan().events, { type: 'applied', at: '2026-11-16T12:00:00.000Z' }] }); await B.flush();
    A.set(OPKEY, { ...plan('2026-11-16T13:00:00.000Z') }); await A.flush();
    assert.ok(A.bar().includes('Une autre session a modifié ce suivi'), 'the conflict is said: ' + A.bar());
    assert.equal(JSON.parse(A.get(OPKEY)).events.length, 2, 'A was reloaded with B\'s change (the applied event is there)');
    const server = (await srv.store.list(M)).find((r) => r.key === OPKEY); assert.equal(server.value.events.length, 2, 'the server kept B\'s change');
    assert.equal(A.errors.length + B.errors.length, 0);
  } finally { await srv.close(); }
});

test('HOS-8 a viewer reads but cannot save (said, not hidden); a refused write is not shown as saved; another merchant\'s account cannot even start a session here', async () => {
  const srv = await boot();
  try {
    const A = await browser(srv); await A.boot(); await A.login('owner@nordla-test.example'); A.set(OPKEY, plan()); await A.flush();
    const V = await browser(srv); await V.boot(); await V.login('viewer@nordla-test.example'); assert.equal(V.routed, 1);
    assert.equal(JSON.parse(V.get(OPKEY)).events.length, 1, 'a viewer reads the follow-up'); assert.ok(V.bar().includes('lire le suivi, pas de l’enregistrer'));
    V.set(OPKEY, { ...plan(), events: [...plan().events, { type: 'applied', at: '2026-11-16T14:00:00.000Z' }] }); await V.flush();
    assert.ok(V.bar().includes('Enregistrement impossible (FORBIDDEN_ROLE)'), V.bar()); assert.equal(JSON.parse(V.get(OPKEY)).events.length, 1, 'the screen went back to what the server has');
    assert.equal((await srv.store.list(M)).find((r) => r.key === OPKEY).value.events.length, 1);
    // an account of another merchant signs in at the gate (it exists) but every data call is refused: the screen never gets a follow-up
    const O = await browser(srv); await O.boot(); await O.login('other@nordla-test.example'); assert.equal(O.routed, 0, 'no screen'); assert.equal(O.ctx.growthPersist.server, null); assert.ok(!O.screen().includes('Préparer la gourde'));
    // sign out: back to the form, the server entries are no longer reachable from this page
    await A.ctx.growthHosted.boot(() => {}); const out = all(A.ctx.growthHosted.state.bar, (n) => /gr-session-logout/.test(n.className))[0]; out.listeners.click[0](); await new Promise((r) => setTimeout(r, 30));
    assert.ok(A.screen().includes('Connexion') && A.ctx.growthPersist.server === null);
  } finally { await srv.close(); }
});

test('HOS-9 history already stored in this browser: offered, never deleted or overwritten; entries the server already has are kept as they are; the other merchant\'s scope is ignored', async () => {
  const srv = await boot();
  try {
    const A = await browser(srv); await A.boot(); await A.login('owner@nordla-test.example'); A.set(OPKEY, { ...plan(), events: [...plan().events, { type: 'applied', at: '2026-11-16T12:00:00.000Z' }] }); await A.flush();
    const local = { [OPKEY]: JSON.stringify({ ...plan(), events: [{ type: 'plan', at: '2026-11-15T09:00:00.000Z', text: 'ancien local' }] }), [`nordla.growth.follow-up.v1:${S}:op-2`]: JSON.stringify(plan()), [PIPEKEY]: JSON.stringify(pipe()), [`nordla.growth.follow-up.v1:${SO}:op-9`]: JSON.stringify(plan()), 'nordla_lang': 'fr' };
    const B = await browser(srv, { local }); await B.boot(); await B.login('owner@nordla-test.example');
    assert.ok(B.bar().includes('2 suivi(s) de ce navigateur ne sont pas encore sur le serveur'), 'op-2 and the pipeline are offered; op-1 exists on the server; the other scope is ignored: ' + B.bar());
    assert.equal(JSON.parse(B.get(OPKEY)).events.length, 2, 'the server version wins on screen: nothing local overwrote it');
    const go = all(B.ctx.growthHosted.state.bar, (n) => /gr-session-import/.test(n.className))[0]; go.listeners.click[0](); for (let i = 0; i < 80 && !B.bar().includes('enregistré(s) sur le serveur'); i++) await new Promise((r) => setTimeout(r, 25)); // wait for the save, up to 2 s
    assert.ok(B.bar().includes('2 suivi(s) enregistré(s) sur le serveur'), B.bar());
    assert.deepEqual((await srv.store.list(M)).map((r) => r.key).sort(), [OPKEY, `nordla.growth.follow-up.v1:${S}:op-2`, PIPEKEY].sort());
    assert.equal((await srv.store.list(M)).find((r) => r.key === OPKEY).value.events.length, 2, 'the server entry was not replaced by the older local copy');
    assert.equal(B.ls.get(OPKEY), local[OPKEY], 'the browser copy is untouched'); assert.ok(B.ls.has(`nordla.growth.follow-up.v1:${SO}:op-9`));
    assert.equal((await srv.store.list(OTHER)).length, 0);
  } finally { await srv.close(); }
});

test('HOS-10 FR / NL / EN: the sign-in and bar texts exist in the three languages and the browser-only wording is replaced on the hosted server', async () => {
  const srv = await boot();
  try {
    for (const lang of ['fr', 'nl', 'en']) {
      const B = await browser(srv, { lang }); await B.boot(); const tx = B.screen(); assert.ok(!/gr\.session\.[a-z]+/i.test(tx), `${lang}: no raw key: ${tx}`);
      const d = B.ctx.window.NORDLA_DICTS[lang]; for (const k of ['gr.pipe.storage', 'gr.follow.local', 'gr.follow.history']) assert.ok(!/(ce|dans) navigateur|this browser|deze browser/i.test(d[k]), `${lang} ${k} no longer says the history is in this browser: ${d[k]}`);
    }
  } finally { await srv.close(); }
});

test('HOS-sign-in-button: the page element helper writes ANY value as an attribute, so a boolean disabled:false would disable the button for good; the UI must pass "disabled" or null', async () => {
  const { readdir, readFile: rf } = await import('node:fs/promises');
  const dir = new URL('../src/growth/ui/', import.meta.url);
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.js'))) {
    const src = await rf(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\bdisabled:\s*([^,}]+)/g)) assert.match(m[1].trim(), /\?\s*'disabled'\s*:\s*null$|^null$|^'disabled'$/, `${f}: "disabled: ${m[1].trim()}" would be written as disabled="false" by h()`);
  }
  const app = await rf(new URL('app.js', dir), 'utf8');
  assert.match(app, /else if \(v != null\) el\.setAttribute\(k, v\)/); // the reason for the rule
});

test('HOS-nav the session answers /api/growth/home with the clean https Nordla home address (or null), only to a signed-in session of this merchant', async () => {
  const mk = (homeUrl) => createHostedGrowth({ gate: { handle: async () => false, authorize: async (req) => (req.headers.cookie === 'ok' ? { ok: true, access: { merchantId: 'm1', role: 'OWNER', userId: 'u' } } : { ok: false, status: 401, body: { error: 'AUTH' } }) }, merchantId: 'm1', historyScope: 'h', app: async (req, res) => { res.writeHead(200); res.end('{}'); }, store: createMemoryFollowUpStore(), homeUrl });
  const call = async (h, cookie) => { let status; let body = ''; await h({ method: 'GET', url: '/api/growth/home', headers: cookie ? { cookie } : {} }, { writeHead: (s) => { status = s; }, end: (b) => { body = String(b ?? ''); }, headersSent: false }); return { status, body: body ? JSON.parse(body) : null }; };
  assert.equal((await call(mk('https://nordla.example.app'))).status, 401);
  assert.deepEqual((await call(mk('https://nordla.example.app'), 'ok')).body, { url: 'https://nordla.example.app' });
  assert.deepEqual((await call(mk(null), 'ok')).body, { url: null });
});

// ---- SSO-only (NORDLA_SSO_ONLY=1): the server refuses a direct sign-in, the session state says so, the page sends nothing ----
test('HOS-12 SSO-only: the server refuses a direct sign-in with 403 NORDLA_SESSION_REQUIRED, even with a correct password, and sets no session', async () => {
  const srv = await boot({ ssoOnly: true });
  try {
    const r = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@nordla-test.example', password: 'right' }) });
    const body = await r.json();
    assert.equal(r.status, 403);
    assert.equal(body.error?.code, 'NORDLA_SESSION_REQUIRED');
    assert.ok(!r.headers.getSetCookie().some((c) => /^__Host-nordla_growth_sid=[^;]+/.test(c) && !/=;|=\s*;/.test(c)), 'no growth session cookie is issued');
  } finally { await srv.close(); }
});

test('HOS-13 the session state tells the page about SSO-only, with or without a session; a non-SSO server does not say it', async () => {
  const sso = await boot({ ssoOnly: true });
  const plain = await boot({ ssoOnly: false });
  try {
    const a = await (await fetch(sso.base + '/api/auth/session')).json();
    assert.equal(a.mode, 'session'); assert.equal(a.authenticated, false); assert.equal(a.ssoOnly, true, 'SSO-only is announced without a session');
    const b = await (await fetch(plain.base + '/api/auth/session')).json();
    assert.equal(b.authenticated, false); assert.equal('ssoOnly' in b, false, 'a non-SSO server does not add the flag');
  } finally { await sso.close(); await plain.close(); }
});

test('HOS-14 non-SSO is unchanged: the page keeps its sign-in form and a submitted sign-in is sent to /api/auth/login', async () => {
  const srv = await boot();
  try {
    const A = await browser(srv); await A.boot();
    assert.ok(A.screen().includes('Adresse e-mail'), 'the sign-in form is drawn');
    await A.login('owner@nordla-test.example', 'wrong');
    assert.ok(A.screen().includes('Connexion impossible.'), 'the public refusal is shown as before');
    assert.ok(A.requests.some((r) => r === 'POST /api/auth/login'), 'the sign-in is sent to /api/auth/login as before');
  } finally { await srv.close(); }
});

test('HOS-15 the SSO-only message exists in French, Dutch and English, and is not the generic sign-in failure', async () => {
  const load = async (name) => readFile(new URL(`../src/growth/ui/${name}`, import.meta.url), 'utf8');
  const keyOf = (text, key) => { const m = new RegExp(`'${key.replace(/\./g, '\.')}': "([^"]*)"`).exec(text); return m ? m[1] : null; };
  for (const name of ['lang-fr.js', 'lang-nl.js', 'lang-en.js']) {
    const text = await load(name);
    const sso = keyOf(text, 'gr.session.ssoOnly'); const generic = keyOf(text, 'gr.session.failed');
    assert.ok(sso && sso.trim().length > 20, `${name}: the SSO-only message is present`);
    assert.notEqual(sso, generic, `${name}: not the generic failure`);
  }
});

test('HOS-16 the SSO-only text says: sign in to Nordla (Core) with the usual account, open Growth from Nordla, and there is no separate Growth password', async () => {
  const load = async (name) => readFile(new URL(`../src/growth/ui/${name}`, import.meta.url), 'utf8');
  const keyOf = (text, key) => { const m = new RegExp(`'${key.replace(/\./g, '\.')}': "([^"]*)"`).exec(text); return m ? m[1] : null; };
  const expect = {
    'lang-fr.js': ['Nordla (Core)', 'compte habituel', 'ouvrez Développement des ventes depuis Nordla', "n'a pas de mot de passe distinct"],
    'lang-nl.js': ['Nordla (Core)', 'gewone account', 'open daarna Growth vanuit Nordla', 'geen apart wachtwoord'],
    'lang-en.js': ['Nordla (Core)', 'usual account', 'open Growth from Nordla', 'no separate password'],
  };
  for (const [name, parts] of Object.entries(expect)) {
    const sso = keyOf(await load(name), 'gr.session.ssoOnly');
    for (const p of parts) assert.ok(sso && sso.includes(p), `${name}: the text says "${p}"`);
  }
});
