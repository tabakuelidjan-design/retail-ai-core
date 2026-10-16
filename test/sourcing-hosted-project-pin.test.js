// Staging / production separation of the hosted China Sourcing server (src/sourcing/server/hosted.js, supabaseProjectPin):
// a service pinned to one Supabase project refuses another project's URL or JWT key, on Railway the pin is mandatory, and no refusal
// message ever contains the URL or the key. Synthetic refs and keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { hostedConfig, supabaseProjectPin, verifyPinnedProject, HostedConfigError } from '../src/sourcing/server/hosted.js';

const STAGING = 'aaaaaaaaaaaaaaaaaaaa'; const OTHER = 'bbbbbbbbbbbbbbbbbbbb';
const jwt = (payload) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'c2lnbmF0dXJlLW5vdC1jaGVja2Vk'].join('.');
const BASE = {
  SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: '67646dbb-5e2e-4cd7-aad6-0ab289b068cb', SOURCING_PUBLIC_ORIGIN: 'https://app.example.test', SOURCING_MERCHANT_ID: 'habb',
  SUPABASE_URL: `https://${STAGING}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: jwt({ ref: STAGING, role: 'service_role' }), SUPABASE_ANON_KEY: jwt({ ref: STAGING, role: 'anon' }),
  NORDLA_IDENTITY_RATE_LIMIT_KEY: randomBytes(32).toString('hex'), NORDLA_CSRF_KEY: randomBytes(32).toString('hex'),
};
const RAILWAY = { RAILWAY_ENVIRONMENT_ID: 'env-test', RAILWAY_SERVICE_ID: 'svc-test' };
const refused = (env, code) => {
  let err = null; try { hostedConfig(env); } catch (e) { err = e; }
  assert.ok(err instanceof HostedConfigError, `expected ${code}`); assert.equal(err.code, code);
  for (const secret of [env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_ANON_KEY]) if (secret) assert.ok(!err.message.includes(secret), 'a refusal never prints the URL or a key');
  return err;
};

test('pinned to its project: accepted, and the verified ref is returned (shown in the startup log)', () => {
  assert.equal(hostedConfig({ ...BASE, ...RAILWAY, NORDLA_SUPABASE_PROJECT_REF: STAGING }).supabaseRef, STAGING);
  assert.equal(supabaseProjectPin({ ...BASE, NORDLA_SUPABASE_PROJECT_REF: STAGING.toUpperCase(), SUPABASE_URL: `https://${STAGING}.supabase.co/` }), STAGING);
});

test('on Railway the pin is mandatory; off Railway an unpinned server keeps its previous behaviour', () => {
  refused({ ...BASE, ...RAILWAY }, 'HOSTED_SUPABASE_PROJECT_REQUIRED');
  assert.equal(hostedConfig(BASE).supabaseRef, null);
});

test('another project\'s URL is refused (a production URL pasted into a staging service)', () => {
  refused({ ...BASE, ...RAILWAY, NORDLA_SUPABASE_PROJECT_REF: STAGING, SUPABASE_URL: `https://${OTHER}.supabase.co` }, 'HOSTED_SUPABASE_PROJECT_MISMATCH');
  for (const url of [`http://${STAGING}.supabase.co`, `https://${STAGING}.supabase.co.evil.example`, `https://${STAGING}.supabase.co:8443`, `https://${STAGING}.supabase.co/rest/v1`, `https://x:y@${STAGING}.supabase.co`, 'not a url']) {
    refused({ ...BASE, NORDLA_SUPABASE_PROJECT_REF: STAGING, SUPABASE_URL: url }, 'HOSTED_SUPABASE_PROJECT_MISMATCH');
  }
});

test('another project\'s key is refused (service role or anon), an opaque key is not judged', () => {
  refused({ ...BASE, NORDLA_SUPABASE_PROJECT_REF: STAGING, SUPABASE_SERVICE_ROLE_KEY: jwt({ ref: OTHER, role: 'service_role' }) }, 'HOSTED_SUPABASE_KEY_MISMATCH');
  refused({ ...BASE, NORDLA_SUPABASE_PROJECT_REF: STAGING, SUPABASE_ANON_KEY: jwt({ ref: OTHER, role: 'anon' }) }, 'HOSTED_SUPABASE_KEY_MISMATCH');
  assert.equal(supabaseProjectPin({ ...BASE, NORDLA_SUPABASE_PROJECT_REF: STAGING, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_opaque-test-value', SUPABASE_ANON_KEY: 'sb_publishable_opaque' }), STAGING);
});

test('an invalid pin is refused', () => {
  refused({ ...BASE, NORDLA_SUPABASE_PROJECT_REF: 'not-a-ref' }, 'HOSTED_SUPABASE_PROJECT_INVALID');
});

// live start-up check: works for OPAQUE keys too (sb_secret_ / sb_publishable_ do not name their project): the pinned project's gateway judges them
const M = BASE.NORDLA_MERCHANT_ID;
const fakeProject = ({ ref, serviceKey, anonKey, merchants = [M], down = false }) => {
  const seen = [];
  const fetchImpl = async (url, { headers } = {}) => {
    seen.push(new URL(url).host);
    if (down) throw new Error('connect ECONNREFUSED');
    if (new URL(url).host !== `${ref}.supabase.co`) throw new Error('unexpected host');
    const key = headers.apikey;
    if (url.includes('/rest/v1/merchants')) { if (key !== serviceKey) return new Response('{"message":"Invalid API key"}', { status: 401 }); const id = new URL(url).searchParams.get('id').replace(/^eq\./, ''); return Response.json(merchants.includes(id) ? [{ id }] : []); }
    if (url.endsWith('/auth/v1/settings')) return key === anonKey ? Response.json({ external: {} }) : new Response('{"message":"Invalid API key"}', { status: 401 });
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, seen };
};
const OPAQUE = { ...BASE, NORDLA_SUPABASE_PROJECT_REF: STAGING, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_staging-opaque-test', SUPABASE_ANON_KEY: 'sb_publishable_staging-opaque-test' };
const rejectsWith = async (p, code, env) => { await assert.rejects(p, (e) => { assert.ok(e instanceof HostedConfigError); assert.equal(e.code, code); for (const k of [env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_ANON_KEY]) assert.ok(!e.message.includes(k), 'no key printed'); return true; }); };

test('start-up check: staging keys (opaque) and a merchant that exists in staging -> VERIFIED; every request goes to the pinned host only', async () => {
  const p = fakeProject({ ref: STAGING, serviceKey: OPAQUE.SUPABASE_SERVICE_ROLE_KEY, anonKey: OPAQUE.SUPABASE_ANON_KEY });
  assert.equal(await verifyPinnedProject(OPAQUE, hostedConfig(OPAQUE), { fetchImpl: p.fetchImpl }), 'VERIFIED');
  assert.deepEqual([...new Set(p.seen)], [`${STAGING}.supabase.co`]);
});

test('start-up check: an OPAQUE production key (service or anon) is rejected by the staging gateway -> refuses to start', async () => {
  const staging = fakeProject({ ref: STAGING, serviceKey: 'sb_secret_staging-real', anonKey: 'sb_publishable_staging-real' });
  const prodService = { ...OPAQUE, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_PRODUCTION-key', SUPABASE_ANON_KEY: 'sb_publishable_staging-real' };
  await rejectsWith(verifyPinnedProject(prodService, hostedConfig(prodService), { fetchImpl: staging.fetchImpl }), 'HOSTED_SUPABASE_KEY_REJECTED', prodService);
  const prodAnon = { ...OPAQUE, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_staging-real', SUPABASE_ANON_KEY: 'sb_publishable_PRODUCTION-key' };
  await rejectsWith(verifyPinnedProject(prodAnon, hostedConfig(prodAnon), { fetchImpl: staging.fetchImpl }), 'HOSTED_SUPABASE_KEY_REJECTED', prodAnon);
});

test('start-up check: a merchant id that does not exist in the pinned project (e.g. the production one) -> refuses to start', async () => {
  const p = fakeProject({ ref: STAGING, serviceKey: OPAQUE.SUPABASE_SERVICE_ROLE_KEY, anonKey: OPAQUE.SUPABASE_ANON_KEY, merchants: ['00000000-0000-4000-8000-000000000001'] });
  await rejectsWith(verifyPinnedProject(OPAQUE, hostedConfig(OPAQUE), { fetchImpl: p.fetchImpl }), 'HOSTED_MERCHANT_NOT_IN_PROJECT', OPAQUE);
});

test('start-up check: project unreachable -> UNVERIFIED (logged), not a pass and not a crash loop; not pinned -> no request', async () => {
  const p = fakeProject({ ref: STAGING, down: true });
  assert.equal(await verifyPinnedProject(OPAQUE, hostedConfig(OPAQUE), { fetchImpl: p.fetchImpl }), 'UNVERIFIED_UNREACHABLE');
  const none = fakeProject({ ref: STAGING });
  assert.equal(await verifyPinnedProject(BASE, hostedConfig(BASE), { fetchImpl: none.fetchImpl }), 'NOT_PINNED'); assert.equal(none.seen.length, 0);
});
