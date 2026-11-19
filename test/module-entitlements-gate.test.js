// Phase 1 - module registry and default-deny entitlements (identity/module-catalog.js, identity/entitlements.js, core-pilot/http.js).
// Scenarios: OWNER opens an authorised module, ADMIN/ACCOUNTANT/VIEWER rules, suspended or removed person (no role), absence of an
// entitlement, another merchant's entitlement never counts, a failing reader refuses, and the Core panel never shows a module as active.
import test from 'node:test';
import { K_FINANCE, K_ANALYTICS, K_WRONG } from './fixtures/sso-test-keys.js';
import assert from 'node:assert/strict';
import { CATALOG, MODULE_STATUS, decideModuleOpen, catalogOf } from '../src/identity/module-catalog.js';
import { MODULE_CODES } from '../src/identity/modules.js';
import { activeEntitlementsOf } from '../src/identity/entitlements.js';
import { createCoreHttp } from '../src/core-pilot/http.js';

const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb';
const OTHER = '7e570000-0000-4000-8000-000000000001';
const ACTIVE = (...codes) => new Set(codes);

test('catalogue: every AVAILABLE module has a registered entitlement; DEMO and PLANNED modules have none', () => {
  for (const m of CATALOG) {
    if (m.status === MODULE_STATUS.AVAILABLE) assert.ok(MODULE_CODES.includes(m.entitlement), `${m.key} must name a registered entitlement`);
    else assert.equal(m.entitlement, null, `${m.key} is ${m.status}: it must not be granted by an entitlement`);
  }
  assert.equal(catalogOf('creator').status, MODULE_STATUS.DEMO, 'Creator is a replay, never presented as a working module');
});

test('decision: OWNER opens an authorised, ACTIVE module', () => {
  assert.deepEqual(decideModuleOpen({ key: 'finance', role: 'OWNER', activeCodes: ACTIVE('finance') }), { ok: true });
  assert.deepEqual(decideModuleOpen({ key: 'analytics', role: 'ADMIN', activeCodes: ACTIVE('analytics') }), { ok: true });
  assert.deepEqual(decideModuleOpen({ key: 'analytics', role: 'ACCOUNTANT', activeCodes: ACTIVE('analytics') }), { ok: true });
});

test('decision: default deny without an explicit ACTIVE entitlement (Finance and Analyses are not granted by default)', () => {
  assert.equal(decideModuleOpen({ key: 'finance', role: 'OWNER', activeCodes: ACTIVE('analytics') }).code, 'MODULE_NOT_ENABLED');
  assert.equal(decideModuleOpen({ key: 'analytics', role: 'OWNER', activeCodes: ACTIVE() }).code, 'MODULE_NOT_ENABLED');
  assert.equal(decideModuleOpen({ key: 'finance', role: 'OWNER', activeCodes: null }).code, 'MODULE_NOT_ENABLED', 'an unknown entitlement state is refused');
});

test('decision: role rules hold (VIEWER and a removed or suspended person without a role are refused for Finance and Analyses)', () => {
  assert.equal(decideModuleOpen({ key: 'finance', role: 'VIEWER', activeCodes: ACTIVE('finance') }).code, 'FORBIDDEN');
  assert.equal(decideModuleOpen({ key: 'analytics', role: null, activeCodes: ACTIVE('analytics') }).code, 'FORBIDDEN');
});

test('decision: non-AVAILABLE and unknown modules are refused, even with a matching code', () => {
  assert.equal(decideModuleOpen({ key: 'creator', role: 'OWNER', activeCodes: ACTIVE('finance') }).code, 'MODULE_NOT_AVAILABLE');
  assert.equal(decideModuleOpen({ key: 'nope', role: 'OWNER', activeCodes: ACTIVE('finance') }).code, 'MODULE_UNKNOWN');
});

test('entitlements: only THIS merchant and only ACTIVE, registered codes count', async () => {
  const seen = [];
  const supabase = { select: async (table, q) => { seen.push({ table, q }); return [
    { merchant_id: M, module_code: 'finance', status: 'ACTIVE' },
    { merchant_id: M, module_code: 'growth', status: 'SUSPENDED' },
    { merchant_id: OTHER, module_code: 'analytics', status: 'ACTIVE' },
    { merchant_id: M, module_code: 'unknown-module', status: 'ACTIVE' },
  ]; } };
  const active = await activeEntitlementsOf({ supabase, merchantId: M });
  assert.deepEqual([...active].sort(), ['finance'], 'other merchant, suspended and unregistered codes do not count');
  assert.equal(seen[0].table, 'module_entitlements');
  assert.equal(seen[0].q.merchant_id, `eq.${M}`, 'the query is scoped to the merchant');
  assert.equal(seen[0].q.status, 'eq.ACTIVE');
});

test('entitlements: a failing read propagates (the caller then refuses), a missing merchant is refused', async () => {
  await assert.rejects(activeEntitlementsOf({ supabase: { select: async () => { throw new Error('down'); } }, merchantId: M }), /down/);
  await assert.rejects(activeEntitlementsOf({ supabase: { select: async () => [] }, merchantId: '' }), TypeError);
});

// --- Core HTTP ----------------------------------------------------------------------------------------------------------------

const SSO = { publicUrl: 'https://finance-staging-staging.up.railway.app', secret: K_FINANCE, merchantId: M };
const ASSO = { publicUrl: 'https://analytics-staging-staging.up.railway.app', secret: K_ANALYTICS, merchantId: M };

async function call(core, method, route, actor) {
  const chunks = []; let status = 0;
  const req = { method, url: route, headers: {}, on() {}, [Symbol.asyncIterator]: async function* () { yield Buffer.from('{}'); } };
  const res = { writeHead(s) { status = s; }, setHeader() {}, end(b) { chunks.push(String(b)); } };
  await core.handle(req, res, new URL(`http://x${route}`), actor);
  return { status, body: JSON.parse(chunks.join('') || '{}') };
}
const coreWith = (entitlements, extra = {}) => createCoreHttp({ runtime: null, store: {}, merchantId: M, finance: { source: 'Finance · test', inbox: async () => ({}) }, financeSso: SSO, analytics: { source: 'Analytics · test' }, analyticsSso: ASSO, entitlements, ...extra });

test('Core open: OWNER opens Finance only when finance is ACTIVE for the merchant', async () => {
  const owner = { role: 'OWNER', userId: 'u1' };
  const ok = await call(coreWith(async () => ACTIVE('finance')), 'POST', '/api/core/finance/open', owner);
  assert.equal(ok.status, 200); assert.match(ok.body.url, /^https:\/\/finance-staging-staging\.up\.railway\.app\/sso\?t=/);
  const denied = await call(coreWith(async () => ACTIVE('analytics')), 'POST', '/api/core/finance/open', owner);
  assert.equal(denied.status, 403); assert.equal(denied.body.error, 'MODULE_NOT_ENABLED'); assert.equal(denied.body.url, undefined);
});

test('Core open: a failing entitlement reader refuses (default deny), and so does an absent reader', async () => {
  const owner = { role: 'OWNER', userId: 'u1' };
  assert.equal((await call(coreWith(async () => { throw new Error('down'); }), 'POST', '/api/core/analytics/open', owner)).status, 403);
  assert.equal((await call(coreWith(null), 'POST', '/api/core/analytics/open', owner)).status, 403);
});

test('Core open: a removed or suspended person (no role) and a VIEWER never receive a Finance or Analyses ticket', async () => {
  const core = coreWith(async () => ACTIVE('finance', 'analytics'));
  assert.equal((await call(core, 'POST', '/api/core/finance/open', { role: null, userId: 'u9' })).status, 403);
  assert.equal((await call(core, 'POST', '/api/core/analytics/open', { role: 'VIEWER', userId: 'u2' })).status, 403);
  assert.equal((await call(core, 'POST', '/api/core/analytics/open', { role: 'ACCOUNTANT', userId: 'u3' })).status, 200);
});

test('Core panel: a module without an ACTIVE entitlement is shown as NON ACTIVÉ, with no dashboard link', async () => {
  const off = await call(coreWith(async () => ACTIVE()), 'GET', '/api/core/modules', { role: 'OWNER', userId: 'u1' });
  const fin = off.body.modules.find((m) => m.key === 'finance'); const ana = off.body.modules.find((m) => m.key === 'analytics');
  assert.equal(fin.state, 'NON ACTIVÉ'); assert.equal(fin.dashboard, false);
  assert.equal(ana.state, 'NON ACTIVÉ'); assert.equal(ana.dashboard, false); assert.equal(ana.analytics_url, undefined);
  const on = await call(coreWith(async () => ACTIVE('finance', 'analytics')), 'GET', '/api/core/modules', { role: 'OWNER', userId: 'u1' });
  assert.equal(on.body.modules.find((m) => m.key === 'finance').dashboard, true);
  assert.equal(on.body.modules.find((m) => m.key === 'finance').state, 'LECTURE SEULE');
});

test('Core panel: Growth is listed as NON ACTIVÉ without an entitlement, and points nowhere', async () => {
  const env = { GROWTH_PUBLIC_URL: 'https://growth-staging-staging.up.railway.app', GROWTH_SSO_SECRET: 'z'.repeat(32) };
  const core = createCoreHttp({ runtime: null, store: {}, merchantId: M, env, entitlements: async () => ACTIVE() });
  const g = (await call(core, 'GET', '/api/core/modules', { role: 'OWNER', userId: 'u1' })).body.modules.find((m) => m.key === 'growth');
  assert.equal(g.state, 'NON ACTIVÉ'); assert.equal(g.growth_url, null); assert.equal(g.growth_sso, false);
});

test('Brand, Marketing, Creator and the other unfinished modules stay closed: no entitlement, never AVAILABLE', () => {
  for (const key of ['brand', 'marketing', 'creator', 'video', 'gbp', 'connections', 'market-radar']) {
    const m = catalogOf(key);
    assert.ok(m, `${key} is listed`);
    assert.notEqual(m.status, MODULE_STATUS.AVAILABLE, `${key} is not presented as working`);
    assert.equal(m.entitlement, null);
    assert.deepEqual(decideModuleOpen({ key, role: 'OWNER', activeCodes: new Set(MODULE_CODES) }).ok, false, `${key} cannot be opened even with every code active`);
  }
});
