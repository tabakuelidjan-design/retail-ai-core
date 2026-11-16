// Nordla Créateur HOSTED (DEMO only): sign-in through the Core identity gate of the 'creator' module, tenant scope, roles, and the DEMO marks.
// Fakes only: a fake identity + HTTP security under the REAL session gate, a hub double, a catalog double. No network, no credential, no cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHostedCreator } from '../src/creative-autonomy/creator/hosted.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';
import { randomBytes } from 'node:crypto';
import { createIdentityDb } from './fixtures/identity-db.js';
import { createFakeGoTrue } from './fixtures/fake-gotrue.js';
import { createIdentityService } from '../src/identity/service.js';
import { createMemberService } from '../src/identity/members.js';
import { createModuleProvisioning } from '../src/identity/provisioning.js';
import { loadIdentityConfig, loadRateLimitConfig } from '../src/identity/config.js';
import { createHttpSecurity } from '../src/security/index.js';

const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5'; const OTHER = '11111111-1111-4111-8111-111111111111';
const PID = 'gid://shopify/Product/1'; const V1 = 'gid://shopify/ProductVariant/11';
const catalog = async () => [{ product_id: PID, title: 'TEST produit', variants: [{ variant_id: V1, title: 'Noir', price: '19,90 €' }] }];
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** A hub double that remembers for which merchant it was built. */
function hubFor(merchantId, built) {
  built.push(merchantId);
  return { async call(module, command, args) {
    return { ok: true, status: 'REVIEW_REQUIRED', result: { run_id: args.run_id, published: false, live_provider: false, media_id: 'gid://shopify/MediaImage/1', source_sha256: 'a'.repeat(64), policy_version: 1, withheld: 0,
      results: [{ image: `/private/${args.run_id}.png`, technical: 'PASS' }], reservation: { status: 'RESERVED', ceiling_eur: 0.5, closing: { status: 'SETTLED', settled_eur: 0.0371 } } } };
  } };
}

/** The real session gate over a fake identity (sessions by token) and a fake HTTP security (the cookie is the token; a change needs x-nordla-csrf = 'csrf-' + token). */
function gateOver(sessions, moduleCode = 'creator') {
  const identity = { context: { module: moduleCode },
    resolveAccessSession: async (t) => sessions[t] ? { ok: true, ...sessions[t] } : { ok: false },
    authenticateAndOpenSession: async ({ email }) => (email === 'owner@nordla-test.example' ? { ok: true, token: 'tok-owner', session: { role: 'OWNER' } } : { ok: false, status: 401, error: 'LOGIN_FAILED', message: 'Connexion impossible.' }),
    logoutSession: async () => {} };
  const security = { module: moduleCode, cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (t) => `sid=${t}`, csrfCookie: (t) => `csrf=${t}`, clearSessionCookie: () => 'sid=;', clearCsrfCookie: () => 'csrf=;' },
    csrfTokenFor: (t) => `csrf-${t}`,
    guardRead: () => ({ ok: true }), guardLogin: () => ({ ok: true, ctx: { requestId: 'r', clientIp: '127.0.0.1' } }),
    readLoginBody: async (req) => { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString()); },
    normalizeLogin: async (fn) => fn(), publicError: (e) => ({ status: 400, error: 'BAD' }),
    guardMutation: async (req, resolve) => {
      const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null;
      if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' };
      if (req.headers['x-nordla-csrf'] !== `csrf-${t}`) return { ok: false, code: 'CSRF_INVALID', response: { status: 403, error: 'CSRF_INVALID' } };
      return { ok: true, access: a, sessionToken: t };
    } };
  return createSessionGate({ identity, security, moduleCode });
}

const SESSIONS = {
  'tok-owner': { merchantId: M, userId: 'u-owner', role: 'OWNER', module: 'creator' },
  'tok-viewer': { merchantId: M, userId: 'u-viewer', role: 'VIEWER', module: 'creator' },
  'tok-other': { merchantId: OTHER, userId: 'u-other', role: 'OWNER', module: 'creator' },
};
async function boot(extra = {}) {
  const built = []; const handler = createHostedCreator({ gate: gateOver(SESSIONS), merchantId: M, integrationFor: (m) => hubFor(m, built), catalogFor: () => catalog, tenantName: 'HABB (démo)', ...extra });
  const s = http.createServer(handler); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (path, { token = null, body = null, csrf = token ? `csrf-${token}` : null } = {}) => {
    const headers = { ...(token ? { cookie: `sid=${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(body && csrf ? { 'x-nordla-csrf': csrf } : {}) };
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { /* a page */ }
    return { status: r.status, type: r.headers.get('content-type'), headers: Object.fromEntries(r.headers), body: parsed, text };
  };
  return { built, req, close: () => new Promise((r) => s.close(r)) };
}

test('the session gate takes the module code: "creator" is accepted for a creator pair, a "sourcing" pair is refused, and the default is unchanged', () => {
  assert.doesNotThrow(() => gateOver(SESSIONS, 'creator'));
  const sourcingPair = gateOver(SESSIONS, 'sourcing'); assert.equal(sourcingPair.mode, 'session');
  const id = { context: { module: 'sourcing' }, resolveAccessSession() {}, authenticateAndOpenSession() {} }; const sec = { module: 'sourcing', guardMutation() {} };
  assert.throws(() => createSessionGate({ identity: id, security: sec, moduleCode: 'creator' }), /"creator" module/);
  assert.doesNotThrow(() => createSessionGate({ identity: id, security: sec }), 'no moduleCode = sourcing, as before');
});

test('hosted Creator: the page is served without a session (it holds no data); every API route needs one', async () => {
  const s = await boot();
  try {
    const page = await s.req('/'); assert.equal(page.status, 200); assert.match(page.type, /text\/html/);
    assert.equal((await s.req('/creator.js')).status, 200);
    // the shared design system (served by the shared reader, not from a module folder): without the tokens the navigation grid collapses to one column
    const tokens = await s.req('/nordla-tokens.css'); assert.equal(tokens.status, 200); assert.match(tokens.type, /text\/css/); assert.match(tokens.text, /--nordla-nav-width/);
    assert.equal((await s.req('/nordla-ds.css')).status, 200); assert.equal((await s.req('/style.css')).status, 200);
    for (const p of ['/api/creator/status', '/api/creator/products', '/api/creator/creations']) { const r = await s.req(p); assert.equal(r.status, 401, p); assert.equal(r.body.error, 'SESSION_INVALID'); }
    assert.equal((await s.req('/api/creator/creations', { body: { product_id: PID, variant_id: V1, objective: 'x' } })).status, 401);
    assert.equal(s.built.length, 0, 'no hub was built for an anonymous visitor');
    const sess = await s.req('/api/auth/session'); assert.deepEqual(sess.body, { mode: 'session', authenticated: false });
  } finally { await s.close(); }
});

test('hosted Creator: sign-in through the gate, then the screen works for THIS merchant only and is flagged DEMO in the data', async () => {
  const s = await boot();
  try {
    const bad = await s.req('/api/auth/login', { body: { email: 'nobody@nordla-test.example', password: 'x' }, csrf: null }); assert.equal(bad.status, 401);
    const ok = await s.req('/api/auth/login', { body: { email: 'owner@nordla-test.example', password: 'x' }, csrf: null }); assert.equal(ok.status, 200); assert.equal(ok.body.role, 'OWNER');
    const t = 'tok-owner';
    const st = (await s.req('/api/creator/status', { token: t })).body; assert.deepEqual(st, { mode: 'SIMULATED', demo: true, live_provider: false, auto_publish: false, tenant: 'HABB (démo)' });
    assert.equal((await s.req('/api/creator/products', { token: t })).body.products.length, 1);
    const c = (await s.req('/api/creator/creations', { token: t, body: { product_id: PID, variant_id: V1, objective: 'Faire découvrir' } })).body;
    assert.equal(c.demo, true); assert.equal(c.simulated, true); assert.equal(c.published, false);
    assert.deepEqual(s.built, [M], 'the hub was built for the session’s merchant, once');
    const list = (await s.req('/api/creator/creations', { token: t })).body.creations; assert.ok(list.every((x) => x.demo === true));
  } finally { await s.close(); }
});

test('hosted Creator: a change without the CSRF pair is refused; a session of ANOTHER merchant is refused (TENANT_MISMATCH) and builds nothing', async () => {
  const s = await boot();
  try {
    const noCsrf = await s.req('/api/creator/creations', { token: 'tok-owner', body: { product_id: PID, variant_id: V1, objective: 'x' }, csrf: 'wrong' }); assert.equal(noCsrf.status, 403);
    for (const p of ['/api/creator/status', '/api/creator/products', '/api/creator/creations']) { const r = await s.req(p, { token: 'tok-other' }); assert.equal(r.status, 403, p); assert.deepEqual(r.body, { error: { code: 'TENANT_MISMATCH' } }); }
    const post = await s.req('/api/creator/creations', { token: 'tok-other', body: { product_id: PID, variant_id: V1, objective: 'x' } }); assert.equal(post.status, 403);
    assert.deepEqual(s.built, [], 'no hub, no catalog and no creation for a foreign merchant');
  } finally { await s.close(); }
});

test('hosted Creator: a VIEWER reads but cannot create; each person has their own creations', async () => {
  const s = await boot();
  try {
    assert.equal((await s.req('/api/creator/products', { token: 'tok-viewer' })).status, 200);
    const refused = await s.req('/api/creator/creations', { token: 'tok-viewer', body: { product_id: PID, variant_id: V1, objective: 'x' } }); assert.equal(refused.status, 403); assert.deepEqual(refused.body, { error: { code: 'FORBIDDEN_ROLE' } });
    await s.req('/api/creator/creations', { token: 'tok-owner', body: { product_id: PID, variant_id: V1, objective: 'Faire découvrir' } });
    assert.equal((await s.req('/api/creator/creations', { token: 'tok-owner' })).body.creations.length, 1);
    assert.equal((await s.req('/api/creator/creations', { token: 'tok-viewer' })).body.creations.length, 0, 'the viewer does not see the owner’s creations');
  } finally { await s.close(); }
});

test('hosted Creator is DEMO ONLY and cannot be turned live: no export of a simulated image, and the caller has no way to pass another mode', async () => {
  const s = await boot();
  try {
    const t = 'tok-owner';
    const c = (await s.req('/api/creator/creations', { token: t, body: { product_id: PID, variant_id: V1, objective: 'Faire découvrir' } })).body;
    // wait for the double to finish
    for (let i = 0; i < 50; i += 1) { const v = (await s.req(`/api/creator/creations/${c.creation_id}`, { token: t })).body; if (v.status !== 'RUNNING') break; await new Promise((r) => setTimeout(r, 20)); }
    await s.req(`/api/creator/creations/${c.creation_id}/decision`, { token: t, body: { decision: 'ACCEPT' } });
    const v = (await s.req(`/api/creator/creations/${c.creation_id}`, { token: t })).body;
    assert.equal(v.demo, true); assert.deepEqual(v.exports, [], 'no download link for a DEMO image, even once accepted');
    const exp = await s.req(`/api/creator/creations/${c.creation_id}/export/0.png`, { token: t }); assert.equal(exp.status, 409); assert.deepEqual(exp.body, { error: { code: 'EXPORT_DISABLED_IN_DEMO' } });
  } finally { await s.close(); }
  const src = readFileSync(new URL('../src/creative-autonomy/creator/hosted.js', import.meta.url), 'utf8');
  assert.equal((src.match(/mode: 'SIMULATED', demo: true/g) ?? []).length, 2, 'both Creator instances in hosted.js are built SIMULATED + demo, by the file itself');
  assert.ok(!/mode\s*[,}]|\bmode =/.test(src.replace(/mode: 'SIMULATED'/g, '')), 'hosted.js takes no mode parameter');
});

test('hosted Creator page: DEMO marks and a sign-in form exist in the page code, with design-system tokens only', () => {
  const ui = readFileSync(new URL('../src/creative-autonomy/creator/ui/creator.js', import.meta.url), 'utf8');
  assert.match(ui, /DÉMO — aucune image réelle/); assert.match(ui, /cr-demo/); assert.match(ui, /\/api\/auth\/login/); assert.match(ui, /x-nordla-csrf/);
  const css = readFileSync(new URL('../src/creative-autonomy/creator/ui/creator.css', import.meta.url), 'utf8');
  assert.match(css, /\.cr-demo::before \{ content: 'DÉMO'/);
});

// ---- the REAL identity service, HTTP security (local mode) and session gate, over the in-memory identity database: the same stack as scripts/creator-hosted-demo.mjs ----
test('hosted Creator over the REAL identity stack: the owner works, a viewer only reads, a member of ANOTHER merchant cannot sign in, and a session never crosses merchants', async () => {
  const A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'; const B = '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
  const people = ['owner', 'viewer', 'stranger'].map((k, i) => ({ key: k, id: `0000000${i + 1}-7777-4777-8777-00000000000${i + 1}`, email: `${k}@demo.nordla.test`, password: `synthetic passphrase for ${k}` }));
  const P = Object.fromEntries(people.map((p) => [p.key, p]));
  const db = createIdentityDb({ merchants: [A, B], users: people.map((p) => p.id) }); const auth = createFakeGoTrue({ users: people });
  const members = (m) => createMemberService({ supabase: db.supabase, merchantId: m });
  await members(A).bootstrapOwner({ userId: P.owner.id }); await members(A).addMember({ actorUserId: P.owner.id, targetUserId: P.viewer.id, role: 'VIEWER' }); await members(B).bootstrapOwner({ userId: P.stranger.id });
  const prov = createModuleProvisioning({ supabase: db.supabase }); for (const m of [A, B]) await prov.enableModule({ merchantId: m, moduleCode: 'creator', source: 'provisioning:manual' });
  const serverFor = async (merchantId) => {
    const identity = createIdentityService({ merchantId, moduleCode: 'creator', supabase: db.supabase, auth: { baseUrl: 'https://ref.supabase.example', anonKey: `anon-${randomBytes(20).toString('hex')}` }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: randomBytes(32), fetchImpl: auth.fetchImpl });
    const holder = {}; const srv = http.createServer((q, r) => holder.h(q, r)); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
    const security = createHttpSecurity({ environment: 'local', proxy: 'none', allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: [`http://127.0.0.1:${port}`], moduleCode: 'creator', loginTiming: { minMs: 200, jitterMs: 0 } });
    holder.h = createHostedCreator({ gate: createSessionGate({ identity, security, moduleCode: 'creator' }), merchantId, integrationFor: (m) => hubFor(m, []), catalogFor: () => catalog });
    const base = `http://127.0.0.1:${port}`; const origin = base; const jar = {};
    const login = async (p) => { const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: p.email, password: p.password }) });
      const set = r.headers.getSetCookie(); const pick = (n) => set.find((c) => c.startsWith(n))?.split(';')[0]; const sid = pick('nordla_dev_creator_sid='); const cs = pick('nordla_dev_creator_csrf=');
      if (r.status === 200 && sid && cs) jar[p.key] = { cookie: `${sid}; ${cs}`, csrf: cs.split('=')[1] }; return r.status; };
    const call = async (who, path, body) => { const j = jar[who]; const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { origin, ...(j ? { cookie: j.cookie } : {}), ...(body ? { 'content-type': 'application/json', 'x-nordla-csrf': j?.csrf ?? '' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
    return { login, call, jar, close: () => new Promise((r) => srv.close(r)) };
  };
  const a = await serverFor(A); const b = await serverFor(B);
  try {
    assert.notEqual(await a.login(P.stranger), 200, 'a member of merchant B cannot sign in to merchant A');
    assert.equal(await a.login(P.owner), 200); assert.equal(await a.login(P.viewer), 200);
    assert.equal((await a.call('owner', '/api/creator/status')).body.demo, true);
    assert.equal((await a.call('viewer', '/api/creator/products')).status, 200);
    assert.equal((await a.call('viewer', '/api/creator/creations', { product_id: PID, variant_id: V1, objective: 'x' })).status, 403, 'a viewer cannot create');
    assert.equal((await a.call('owner', '/api/creator/creations', { product_id: PID, variant_id: V1, objective: 'Faire découvrir' })).status, 202);
    // REPLAY: the owner's session cookies of merchant A sent to the server of merchant B are worthless
    b.jar.owner = a.jar.owner; assert.equal((await b.call('owner', '/api/creator/creations')).status, 401, 'a session of merchant A is not a session of merchant B');
    assert.equal((await b.call('owner', '/api/creator/status')).status, 401);
  } finally { await a.close(); await b.close(); }
});
