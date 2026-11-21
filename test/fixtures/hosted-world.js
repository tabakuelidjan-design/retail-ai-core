// A hosted China Sourcing / Nordla server over the identity and GoTrue test doubles, with named people holding each role, on ISOLATED SYNTHETIC data.
// Used by the security tests (permissions matrix, cross-merchant access, outbound-call audit). No network, no real account, no secret.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityDb } from './identity-db.js';
import { createFakeGoTrue } from './fake-gotrue.js';
import { createIdentityService } from '../../src/identity/service.js';
import { createMemberService } from '../../src/identity/members.js';
import { createModuleProvisioning } from '../../src/identity/provisioning.js';
import { loadIdentityConfig, loadRateLimitConfig } from '../../src/identity/config.js';
import { createHttpSecurity } from '../../src/security/index.js';
import { startSourcingServer } from '../../src/sourcing/server/index.js';

export const HOST = 'app.nordla-test.example';
export const ORIGIN = `https://${HOST}`;
export const MERCHANT_A = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2c1';
export const MERCHANT_B = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2c2';
const person = (key, n) => ({ key, id: `${String(n).padStart(8, '0')}-5555-4555-8555-${String(n).padStart(12, '0')}`, email: `${key}@nordla-test.example`, password: `synthetic passphrase for ${key}` });

/** Roles of merchant A: owner, admin, buyer (COLLABORATOR), viewer, accountant. `stranger` belongs to merchant B only. */
export const PEOPLE = Object.fromEntries([['owner', 1], ['admin', 2], ['buyer', 3], ['viewer', 4], ['accountant', 5], ['stranger', 6], ['nobody', 7]].map(([k, n]) => [k, person(k, n)]));
const ROLE_OF = { admin: 'ADMIN', buyer: 'COLLABORATOR', viewer: 'VIEWER', accountant: 'ACCOUNTANT' };

export async function hostedWorld({ envExtra = {}, readers = { finance: null, analytics: null }, startOptions = {}, memberOverride = null } = {}) {
  const ENV = {
    SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: MERCHANT_A, SOURCING_PUBLIC_ORIGIN: ORIGIN, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'x', SUPABASE_ANON_KEY: 'anon',
    NORDLA_IDENTITY_RATE_LIMIT_KEY: randomBytes(32).toString('hex'), NORDLA_CSRF_KEY: randomBytes(32).toString('hex'), SOURCING_MERCHANT_ID: 'habb', SOURCING_HOST: '127.0.0.1', ...envExtra,
  };
  const everyone = Object.values(PEOPLE);
  const db = createIdentityDb({ merchants: [MERCHANT_A, MERCHANT_B], users: everyone.map((p) => p.id) });
  const auth = createFakeGoTrue({ users: everyone });
  const membersA = createMemberService({ supabase: db.supabase, merchantId: MERCHANT_A });
  await membersA.bootstrapOwner({ userId: PEOPLE.owner.id });
  for (const [k, role] of Object.entries(memberOverride ?? ROLE_OF)) await membersA.addMember({ actorUserId: PEOPLE.owner.id, targetUserId: PEOPLE[k].id, role });
  const membersB = createMemberService({ supabase: db.supabase, merchantId: MERCHANT_B });
  await membersB.bootstrapOwner({ userId: PEOPLE.stranger.id });
  const prov = createModuleProvisioning({ supabase: db.supabase });
  await prov.enableModule({ merchantId: MERCHANT_A, moduleCode: 'sourcing', source: 'provisioning:manual' });
  await prov.enableModule({ merchantId: MERCHANT_B, moduleCode: 'sourcing', source: 'provisioning:manual' });
  const dir = await mkdtemp(join(tmpdir(), 'nordla-night-'));
  await mkdir(dir, { recursive: true });
  const services = (merchantId = MERCHANT_A) => ({
    readers,
    identity: createIdentityService({ merchantId, moduleCode: 'sourcing', supabase: db.supabase, auth: { baseUrl: ENV.SUPABASE_URL, anonKey: ENV.SUPABASE_ANON_KEY }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, fetchImpl: auth.fetchImpl }),
    security: createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [HOST], allowedOrigins: [ORIGIN], moduleCode: 'sourcing', csrfKey: ENV.NORDLA_CSRF_KEY, rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, loginTiming: { minMs: 200, jitterMs: 0 } }),
  });
  const w = { dir, srv: null, srvB: null, db, env: ENV };
  w.start = async () => { w.srv = await startSourcingServer({ env: { ...ENV, SOURCING_DATA_DIR: dir }, log: () => {}, port: 0, services: services(), fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}), ...startOptions }); };
  /** A SECOND server of the SAME deployment, bound to merchant B (own data folder), over the same identity database: to replay a session of one merchant on the other. */
  w.startB = async () => { w.srvB = await startSourcingServer({ env: { ...ENV, NORDLA_MERCHANT_ID: MERCHANT_B, SOURCING_MERCHANT_ID: 'habb', SOURCING_DATA_DIR: await mkdtemp(join(tmpdir(), 'nordla-night-b-')) }, log: () => {}, port: 0, services: services(MERCHANT_B), fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}), ...startOptions }); };
  w.stop = async () => { for (const s of [w.srv, w.srvB]) { if (!s) continue; await new Promise((r) => s.server.close(r)); s.server.closeAllConnections?.(); } };
  const H = { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.21', origin: ORIGIN };
  w.callOn = (srv, method, path, { body, who } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: srv.port, path, method, headers: { ...H, 'content-type': 'application/json', ...(who ? { cookie: who.cookie, 'x-nordla-csrf': who.csrf } : {}), ...(data ? { 'content-length': data.length } : {}) } }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { const t = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = t ? JSON.parse(t) : null; } catch { parsed = { raw: t.slice(0, 200) }; } resolve({ status: res.statusCode, body: parsed }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  w.call = (method, path, opts) => w.callOn(w.srv, method, path, opts);
  /** @returns {{cookie, csrf, status} | {refused: true, status}} */
  w.loginOn = (srv, p) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ email: p.email, password: p.password }));
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/auth/login', method: 'POST', headers: { ...H, 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      res.resume(); res.on('end', () => {
        const set = res.headers['set-cookie'] ?? []; const pick = (n) => set.find((c) => c.startsWith(n))?.split(';')[0];
        const sid = pick('__Host-nordla_sourcing_sid='); const cs = pick('__Host-nordla_sourcing_csrf=');
        resolve(sid && cs ? { cookie: [sid, cs].join('; '), csrf: cs.split('=')[1], status: res.statusCode } : { refused: true, status: res.statusCode });
      });
    });
    r.on('error', reject); r.write(data); r.end();
  });
  w.login = (p) => w.loginOn(w.srv, p);
  w.loginAll = async () => Object.fromEntries(await Promise.all(Object.entries(PEOPLE).filter(([k]) => k !== 'nobody' && k !== 'stranger').map(async ([k, p]) => [k, await w.login(p)])));
  return w;
}
