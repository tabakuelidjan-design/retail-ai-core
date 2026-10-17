// Nordla convergence (unified hosted server): the registry of modules tells the truth about every module, Social Publishing is visible READ-ONLY, the roles that may change
// China Sourcing data are enforced, and nothing here can approve, schedule, publish, pay or order. Everything runs on ISOLATED SYNTHETIC data, with the identity and
// GoTrue fakes of the hosted-server tests: no network, no real account, no secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  mkdtemp, mkdir, readdir, readFile, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityDb } from './fixtures/identity-db.js';
import { createFakeGoTrue } from './fixtures/fake-gotrue.js';
import { createIdentityService } from '../src/identity/service.js';
import { createMemberService } from '../src/identity/members.js';
import { createModuleProvisioning } from '../src/identity/provisioning.js';
import { loadIdentityConfig, loadRateLimitConfig } from '../src/identity/config.js';
import { createHttpSecurity } from '../src/security/index.js';
import { startSourcingServer } from '../src/sourcing/server/index.js';
import { STATE_TONE, MODULE_META } from '../src/sourcing/nordla-ui/nordla-view.js';

const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2b6';
const ROLES = { owner: 'OWNER', buyer: 'COLLABORATOR', viewer: 'VIEWER', accountant: 'ACCOUNTANT' };
const people = Object.keys(ROLES).map((k, i) => ({ key: k, id: `${String(i + 1).padStart(8, '0')}-4444-4444-8444-${String(i + 1).padStart(12, '0')}`, email: `${k}@nordla-test.example`, password: `synthetic passphrase for ${k}` }));
const P = Object.fromEntries(people.map((p) => [p.key, p]));
const HOST = 'app.nordla-test.example'; const ORIGIN = `https://${HOST}`;

async function world({ social = null } = {}) {
  const ENV = {
    SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: M, SOURCING_PUBLIC_ORIGIN: ORIGIN, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'x', SUPABASE_ANON_KEY: 'anon',
    NORDLA_IDENTITY_RATE_LIMIT_KEY: randomBytes(32).toString('hex'), NORDLA_CSRF_KEY: randomBytes(32).toString('hex'), SOURCING_MERCHANT_ID: 'habb', SOURCING_HOST: '127.0.0.1', ...(social ? { SOCIAL_DATA_DIR: social } : {}),
  };
  const db = createIdentityDb({ merchants: [M], users: people.map((p) => p.id) }); const auth = createFakeGoTrue({ users: people });
  const members = createMemberService({ supabase: db.supabase, merchantId: M });
  await members.bootstrapOwner({ userId: P.owner.id });
  for (const k of ['buyer', 'viewer', 'accountant']) await members.addMember({ actorUserId: P.owner.id, targetUserId: P[k].id, role: ROLES[k] });
  await createModuleProvisioning({ supabase: db.supabase }).enableModule({ merchantId: M, moduleCode: 'sourcing', source: 'provisioning:manual' });
  const dir = await mkdtemp(join(tmpdir(), 'nordla-convergence-'));
  const services = () => ({
    readers: { finance: null, analytics: null },
    identity: createIdentityService({ merchantId: M, moduleCode: 'sourcing', supabase: db.supabase, auth: { baseUrl: ENV.SUPABASE_URL, anonKey: ENV.SUPABASE_ANON_KEY }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, fetchImpl: auth.fetchImpl }),
    security: createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [HOST], allowedOrigins: [ORIGIN], moduleCode: 'sourcing', csrfKey: ENV.NORDLA_CSRF_KEY, rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, loginTiming: { minMs: 200, jitterMs: 0 } }),
  });
  const w = { dir, srv: null };
  w.start = async () => { w.srv = await startSourcingServer({ env: { ...ENV, SOURCING_DATA_DIR: dir }, log: () => {}, port: 0, services: services(), fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) }); };
  w.stop = async () => { await new Promise((r) => w.srv.server.close(r)); w.srv.server.closeAllConnections?.(); };
  const H = { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.9', origin: ORIGIN };
  w.call = (method, path, { body, who } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: w.srv.port, path, method, headers: { ...H, 'content-type': 'application/json', ...(who ? { cookie: who.cookie, 'x-nordla-csrf': who.csrf } : {}), ...(data ? { 'content-length': data.length } : {}) } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  w.login = (p) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ email: p.email, password: p.password }));
    const r = http.request({ host: '127.0.0.1', port: w.srv.port, path: '/api/auth/login', method: 'POST', headers: { ...H, 'content-type': 'application/json', 'content-length': data.length } }, (res) => { res.resume(); res.on('end', () => { const set = res.headers['set-cookie'] ?? []; const pick = (n) => set.find((c) => c.startsWith(n))?.split(';')[0]; const sid = pick('__Host-nordla_sourcing_sid='); const cs = pick('__Host-nordla_sourcing_csrf='); resolve({ cookie: [sid, cs].join('; '), csrf: cs?.split('=')[1] }); }); });
    r.on('error', reject); r.write(data); r.end();
  });
  return w;
}
const snapshot = async (dir) => { const out = {}; for (const f of await readdir(dir, { recursive: true })) { try { out[f] = (await readFile(join(dir, f))).toString('base64'); } catch { /* a directory */ } } return out; };

test('CV-1 roles: VIEWER and ACCOUNTANT read China Sourcing but cannot change, delete, refresh or send anything to an AI reader; COLLABORATOR and OWNER can', async () => {
  const w = await world(); await w.start();
  try {
    const who = Object.fromEntries(await Promise.all(Object.keys(ROLES).map(async (k) => [k, await w.login(P[k])])));
    for (const k of ['viewer', 'accountant']) {
      assert.equal((await w.call('GET', '/api/cases', { who: who[k] })).status, 200, `${k} reads`);
      assert.equal((await w.call('GET', '/api/core/modules', { who: who[k] })).status, 200, `${k} sees the modules`);
      for (const [method, path, body] of [
        ['PUT', '/api/cases/case_x1', { id: 'case_x1' }], ['DELETE', '/api/cases/case_x1'], ['PUT', '/api/cases/case_x1/photos/k1', { dataUrl: 'data:image/jpeg;base64,AAAA' }],
        ['POST', '/api/safety/refresh', {}], ['POST', '/api/documents/extract', { dataBase64: 'AAAA', fileName: 'a.pdf', mime: 'application/pdf' }], ['POST', '/api/ai/describe', { consent: true }], ['PUT', '/api/field/workspace', {}],
      ]) {
        const r = await w.call(method, path, { who: who[k], body });
        assert.equal(r.status, 403, `${k} ${method} ${path}`); assert.equal(r.body.error, 'FORBIDDEN_ROLE', `${k} ${method} ${path}`);
      }
      assert.notEqual((await w.call('POST', '/api/safety/check', { who: who[k], body: {} })).status, 403, 'a safety check only computes on what is posted: allowed to everyone');
    }
    for (const k of ['buyer', 'owner']) {
      assert.notEqual((await w.call('DELETE', '/api/cases/case_x1', { who: who[k] })).status, 403, `${k} may delete (nothing to delete here)`);
      assert.equal((await w.call('PUT', '/api/cases/case_x1', { who: who[k], body: { id: 'other' } })).status, 400, `${k} reaches the handler (ID_MISMATCH), not the role guard`);
    }
    assert.equal((await w.call('GET', '/api/core/modules')).status, 401, 'no session, nothing');
  } finally { await w.stop(); }
});

test('CV-2 the module registry tells the truth: every module listed with a known state and a reason; unconnected modules are NOT presented as available', async () => {
  const w = await world(); await w.start();
  try {
    const owner = await w.login(P.owner);
    const { modules } = (await w.call('GET', '/api/core/modules', { who: owner })).body;
    const by = Object.fromEntries(modules.map((m) => [m.key, m]));
    assert.deepEqual(modules.map((m) => m.key), ['core', 'finance', 'analytics', 'procurement', 'sourcing', 'branding', 'marketing', 'creative', 'parle', 'validations', 'social', 'activation', 'growth']);
    for (const m of modules) {
      assert.ok(Object.hasOwn(STATE_TONE, m.state), `${m.key}: known state ${m.state}`);
      assert.ok(m.label && m.detail && m.detail.length > 20, `${m.key}: a label and a reason`);
      assert.ok(Object.hasOwn(MODULE_META, m.key), `${m.key}: the screen knows how to show it`);
    }
    for (const k of ['finance', 'analytics']) assert.equal(by[k].state, 'NON RACCORDÉ', `${k} without its reader is not connected`);
    for (const k of ['social', 'activation', 'growth']) assert.equal(by[k].state, 'NON RACCORDÉ', k);
    assert.ok(['BLOQUÉ', 'LIMITÉ'].includes(by.creative.state)); assert.match(by.creative.detail, /aucun fournisseur/i, 'no AI provider is claimed');
    assert.match(by.parle.detail, /sans modèle d’IA/); assert.match(by.parle.detail, /ne commande, ne paie ni n’approuve jamais/);
    assert.match(by.validations.detail, /pas encore de file d’approbation unique/);
    assert.match(by.validations.detail, /Finance n’a pas de double contrôle/);
    assert.match(by.activation.detail, /Rien n’est diffusé/);
    assert.match(by.social.detail, /rien n’est publié d’ici/);
    assert.deepEqual(modules.filter((m) => m.offline).map((m) => m.key), ['sourcing']);
  } finally { await w.stop(); }
});

test('CV-3 Social Publishing is visible READ-ONLY when the operator names its directory: counts only, no caption, no token, nothing written, nothing approved or published', async () => {
  const social = await mkdtemp(join(tmpdir(), 'nordla-social-'));
  await mkdir(join(social, 'posts'), { recursive: true });
  const post = (n, state, extra = {}) => writeFile(join(social, 'posts', `post_${n}.json`), JSON.stringify({ id: `post_${n}`, state, caption: 'SECRET-CAPTION-TEXT', approval: { sig: 'SECRET-SIGNATURE' }, ...extra }));
  await post('aaaaaaaa1', 'READY_FOR_REVIEW'); await post('aaaaaaaa2', 'READY_FOR_REVIEW'); await post('aaaaaaaa3', 'SCHEDULED', { publish_at: '2026-10-20T10:00:00.000Z' }); await post('aaaaaaaa4', 'SCHEDULED', { publish_at: '2026-10-19T09:00:00.000Z' }); await post('aaaaaaaa5', 'PUBLISHED');
  await writeFile(join(social, 'token.txt'), 'SECRET-OWNER-TOKEN-0123456789');
  const before = await snapshot(social);
  const w = await world({ social }); await w.start();
  try {
    const viewer = await w.login(P.viewer);
    const r = await w.call('GET', '/api/core/modules', { who: viewer });
    const row = r.body.modules.find((m) => m.key === 'social');
    assert.equal(row.state, 'LECTURE SEULE');
    assert.match(row.detail, /5 publication\(s\) au calendrier, 2 à valider par vous/);
    assert.match(row.detail, /2026-10-19T09:00:00.000Z/);
    assert.match(row.detail, /aucune plateforme connectée/);
    assert.match(row.detail, /uniquement dans l’application Social/);
    const wire = JSON.stringify(r.body);
    for (const secret of ['SECRET-CAPTION-TEXT', 'SECRET-SIGNATURE', 'SECRET-OWNER-TOKEN']) assert.equal(wire.includes(secret), false, `${secret} never leaves`);
    // the shared screen offers no way to approve / schedule / publish a post
    for (const path of ['/api/core/social', '/api/core/social/approve', '/api/core/social/publish', '/api/social/run']) assert.equal((await w.call('POST', path, { who: viewer, body: {} })).status === 200, false, path);
    assert.deepEqual(await snapshot(social), before, 'the Social Publishing directory is byte for byte unchanged');
  } finally { await w.stop(); }
});

test('CV-4 a Social directory that cannot be read is said so, and every other module still answers', async () => {
  const social = await mkdtemp(join(tmpdir(), 'nordla-social-bad-'));
  await mkdir(join(social, 'posts'), { recursive: true });
  await writeFile(join(social, 'posts', 'post_broken01.json'), '{ not json');
  const w = await world({ social }); await w.start();
  try {
    const owner = await w.login(P.owner);
    const { modules } = (await w.call('GET', '/api/core/modules', { who: owner })).body;
    assert.equal(modules.find((m) => m.key === 'social').state, 'À VÉRIFIER');
    assert.equal(modules.find((m) => m.key === 'sourcing').state, 'DISPONIBLE');
    assert.equal(modules.length, 13);
    assert.equal((await w.call('GET', '/api/cases', { who: owner })).status, 200);
  } finally { await w.stop(); }
});

test('CV-5 static guarantees: the Core and the Social reader make no network call, import no publisher / credential / store, and write nothing', async () => {
  const files = [...(await readdir(new URL('../src/core-pilot/', import.meta.url))).filter((f) => f.endsWith('.js')).map((f) => new URL(`../src/core-pilot/${f}`, import.meta.url)), new URL('../src/social/reader.js', import.meta.url)];
  for (const f of files) {
    const src = (await readFile(f, 'utf8')).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/\bfetch\s*\(|from 'node:(?:https?|net|tls|dgram)'|XMLHttpRequest|WebSocket/.test(src), false, `${f.pathname.split('/').pop()}: no network`);
  }
  const reader = (await readFile(files.at(-1), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.equal(/writeFile|appendFile|rename|unlink|mkdir|rm\(|publisher|credentials|store\.js|providers|integrity/.test(reader), false, 'the Social reader reads only');
});
