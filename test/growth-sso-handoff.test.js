// Single sign-on Nordla -> Growth, Nordla side: the ticket comes from a person who holds a Nordla session (the gate runs before core.handle), carries the person and the merchant
// but NO role, any signed-in role may ask (Growth re-checks membership, module and role itself), never without the shared secret, never to a free destination.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHttp, growthSsoConfig } from '../src/core-pilot/http.js';
import { createHandoffVerifier, issueHandoff, openSessionForHandoff, HANDOFF_DESTINATIONS } from '../src/identity/handoff.js';

const SECRET = 'growth-sso-secret-0123456789abcdef';
const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb'; const U = '11111111-2222-4333-8444-555555555555';
const ENV = { GROWTH_PUBLIC_URL: 'https://growth.example.app', GROWTH_SSO_SECRET: SECRET };
const call = async (core, actor, body = {}) => {
  const chunks = []; let status = 0;
  const res = { writeHead: (s) => { status = s; }, end: (b) => chunks.push(String(b ?? '')), setHeader() {} };
  const req = { method: 'POST', url: '/api/core/growth/open', headers: {}, on() {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); } };
  await core.handle(req, res, new URL('http://x/api/core/growth/open'), actor);
  return { status, body: chunks.join('') ? JSON.parse(chunks.join('')) : null };
};

test('the ticket is issued for the signed-in person of THIS merchant, to any role (read-only included), for an allow-listed destination, and carries no role or secret', async () => {
  const core = createCoreHttp({ runtime: null, store: {}, merchantId: M, env: ENV });
  for (const role of ['OWNER', 'VIEWER', 'COLLABORATOR']) {
    const r = await call(core, { role, userId: U }, { to: 'opportunities' }); assert.equal(r.status, 200, role);
    const u = new URL(r.body.url); assert.equal(u.origin, 'https://growth.example.app'); assert.equal(u.pathname, '/sso'); assert.equal(u.searchParams.get('to'), 'opportunities');
    assert.ok(!r.body.url.includes(SECRET)); const payload = JSON.parse(Buffer.from(u.searchParams.get('t').split('.')[0], 'base64url').toString());
    assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'jti', 'm', 'u', 'v']); assert.equal(payload.u, U); assert.equal(payload.m, M); assert.ok(!JSON.stringify(payload).includes(role));
    assert.deepEqual(createHandoffVerifier({ secret: SECRET, merchantId: M }).verify(u.searchParams.get('t')), { ok: true, userId: U });
  }
  assert.equal(new URL((await call(core, { role: 'VIEWER', userId: U })).body.url).searchParams.get('to'), 'dropoff', 'default destination');
});

test('refusals: no secret or no https address (503), no Nordla account behind the call (409), a free destination (400); nothing is issued', async () => {
  for (const env of [{ GROWTH_PUBLIC_URL: 'https://growth.example.app' }, { GROWTH_SSO_SECRET: SECRET }, { ...ENV, GROWTH_SSO_SECRET: 'short' }, { ...ENV, GROWTH_PUBLIC_URL: 'http://growth.example.app' }]) {
    assert.equal((await call(createCoreHttp({ runtime: null, store: {}, merchantId: M, env }), { role: 'OWNER', userId: U })).status, 503, JSON.stringify(env));
  }
  const core = createCoreHttp({ runtime: null, store: {}, merchantId: M, env: ENV });
  assert.equal((await call(core, { role: 'OWNER' })).status, 409);
  for (const to of ['https://evil.example', '../x', 'finance', '__proto__']) assert.equal((await call(core, { role: 'OWNER', userId: U }, { to })).status, 400, to);
  assert.equal(growthSsoConfig(ENV, null), null);
});

test('the modules list tells the screen whether single sign-on is on (growth_sso) and says so honestly in the detail', async () => {
  const mods = async (env) => { const chunks = []; const res = { writeHead() {}, end: (b) => chunks.push(String(b)), setHeader() {} }; await createCoreHttp({ runtime: null, store: {}, merchantId: M, env }).handle({ method: 'GET', url: '/api/core/modules', headers: {}, on() {} }, res, new URL('http://x/api/core/modules'), { role: 'VIEWER', userId: U }); return JSON.parse(chunks.join('')).modules.find((m) => m.key === 'growth'); };
  const on = await mods(ENV); assert.equal(on.growth_sso, true); assert.match(on.detail, /aucune seconde connexion/);
  const off = await mods({ GROWTH_PUBLIC_URL: 'https://growth.example.app' }); assert.equal(off.growth_sso, false); assert.match(off.detail, /connexion demandée/);
});

test('openSessionForHandoff uses the same database function as a password sign-in and never reveals why a refusal happened', async () => {
  const calls = []; const mk = (out) => ({ rpc: async (fn, args) => { calls.push([fn, args]); if (out instanceof Error) throw out; return out; } });
  const ok = await openSessionForHandoff({ supabase: mk({ ok: true, session_id: 's1', role: 'VIEWER' }), merchantId: M, moduleCode: 'growth', userId: U, absoluteMs: 3600_000 });
  assert.equal(ok.ok, true); assert.equal(ok.role, 'VIEWER'); assert.match(ok.token, /^[A-Za-z0-9_-]{40,}$/);
  const [fn, args] = calls[0]; assert.equal(fn, 'identity_open_session'); assert.equal(args.p_module, 'growth'); assert.equal(args.p_user, U); assert.equal(args.p_merchant, M); assert.notEqual(args.p_token_hash, ok.token, 'only the hash goes to the database');
  for (const out of [{ ok: false, code: 'MODULE_NOT_ENABLED' }, { ok: false, code: 'NOT_MEMBER' }, null, new Error('down')]) assert.deepEqual(await openSessionForHandoff({ supabase: mk(out), merchantId: M, moduleCode: 'growth', userId: U, absoluteMs: 1000 }), { ok: false });
});

test('the ticket cannot be replayed, expired, forged, retargeted to another merchant or built without a person; the destinations are a closed list', () => {
  let t = 1_000_000_000_000; const now = () => t; const v = createHandoffVerifier({ secret: SECRET, merchantId: M, now });
  const good = issueHandoff({ secret: SECRET, merchantId: M, userId: U, now }); assert.equal(v.verify(good).ok, true); assert.equal(v.verify(good).code, 'SSO_REPLAYED');
  const exp = issueHandoff({ secret: SECRET, merchantId: M, userId: U, now, ttlSeconds: 10 }); t += 120_000; assert.equal(v.verify(exp).code, 'SSO_EXPIRED');
  assert.equal(v.verify(issueHandoff({ secret: SECRET, merchantId: 'other', userId: U, now })).code, 'SSO_WRONG_MERCHANT');
  assert.equal(v.verify(issueHandoff({ secret: 'another-secret-another-secret-123', merchantId: M, userId: U, now })).code, 'SSO_BAD_SIGNATURE');
  assert.equal(v.verify('x.y').code, 'SSO_BAD_SIGNATURE'); assert.equal(v.verify(null).code, 'SSO_MALFORMED');
  assert.throws(() => issueHandoff({ secret: SECRET, merchantId: M, userId: 'not-a-uuid' }), { code: 'SSO_USER_REQUIRED' });
  assert.throws(() => issueHandoff({ secret: 'short', merchantId: M, userId: U }), { code: 'SSO_NOT_CONFIGURED' });
  assert.deepEqual(Object.keys(HANDOFF_DESTINATIONS).sort(), ['dropoff', 'opportunities']);
  assert.equal(issueHandoff({ secret: SECRET, merchantId: M, userId: U, now, ttlSeconds: 9999 }).length > 0, true);
});

test('the module is shown as « Sourcing » in the modules list (menu, card and title come from it) while its key stays « sourcing »', async () => {
  const chunks = []; const res = { writeHead() {}, end: (b) => chunks.push(String(b)), setHeader() {} };
  await createCoreHttp({ runtime: null, store: {}, merchantId: M, env: ENV }).handle({ method: 'GET', url: '/api/core/modules', headers: {}, on() {} }, res, new URL('http://x/api/core/modules'), { role: 'OWNER', userId: U });
  const row = JSON.parse(chunks.join('')).modules.find((m) => m.key === 'sourcing'); assert.equal(row.label, 'Sourcing'); assert.equal(row.offline, true);
});
