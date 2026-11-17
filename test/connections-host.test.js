// Paramètres › Connexions on the hosted Nordla server: the extensible registry, the honest states, the Instagram READ-ONLY journey (simulated provider answers only), rights, merchant isolation,
// and "no token ever reaches the browser". Fake identity under the REAL session gate; fake Vault; fake provider HTTP. NO real credential, NO network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CATEGORY, PROVIDERS, createRegistry, defineProvider } from '../src/connections/registry.js';
import { createConnectionsService } from '../src/connections/service.js';
import { createInstagramReadService } from '../src/connections/instagram-read.js';
import { createInstagramReaderFor } from '../src/provider-connections/instagram-reader.js';
import { createConnectionsHost } from '../src/sourcing/server/connections-host.js';
import { buildConnections } from '../src/sourcing/server/index.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';
import { BELGIAN_BANKS } from '../src/finance/bank-catalog-be.js';
import { APP_ENV } from '../src/provider-connections/index.js';
import {
  ENV, IG_ACCOUNT, M1, M2, allSecrets, createProvisioningDb, igRoutes, makeRuntime,
} from './provider-fixtures.js';
import { createFakeHttp } from './channel-fixtures.js';

const SESSIONS = {
  'tok-owner': { merchantId: M1, userId: 'u-owner', role: 'OWNER', module: 'sourcing' }, 'tok-viewer': { merchantId: M1, userId: 'u-viewer', role: 'VIEWER', module: 'sourcing' },
  'tok-other': { merchantId: M2, userId: 'u-other', role: 'OWNER', module: 'sourcing' }, 'tok-admin': { merchantId: M1, userId: 'u-admin', role: 'ADMIN', module: 'sourcing' },
};
function gateOver(sessions, moduleCode = 'sourcing') {
  const identity = { context: { module: moduleCode }, resolveAccessSession: async (t) => (sessions[t] ? { ok: true, ...sessions[t] } : { ok: false }), authenticateAndOpenSession: async () => ({ ok: false, status: 401 }), logoutSession: async () => ({ ok: true }) };
  const security = { module: moduleCode, cookies: { read: (c) => ({ session: /sid=([^;]+)/.exec(c ?? '')?.[1] ?? null }), sessionCookie: (t) => `sid=${t}`, csrfCookie: (t) => `csrf=${t}`, clearSessionCookie: () => 'sid=;', clearCsrfCookie: () => 'csrf=;' },
    csrfTokenFor: (t) => `csrf-${t}`, guardRead: () => ({ ok: true }), guardLogin: () => ({ ok: true, ctx: {} }), readLoginBody: async () => ({}), normalizeLogin: async (fn) => fn(), publicError: () => ({ status: 400, error: 'BAD' }),
    guardMutation: async (req, resolve) => {
      const t = /sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; const a = t ? await resolve(t) : null;
      if (!a?.ok) return { ok: false, code: 'SESSION_INVALID' };
      if (req.headers['x-nordla-csrf'] !== `csrf-${t}`) return { ok: false, code: 'CSRF_INVALID', response: { status: 403, error: 'CSRF_INVALID' } };
      return { ok: true, access: a, sessionToken: t };
    } };
  return createSessionGate({ identity, security, moduleCode });
}
const READ_PERMS = 'instagram_business_basic,instagram_business_manage_insights';
const ENV_READ = { ...ENV, NORDLA_PROVIDER_SCOPE_MODE: 'read' };
const NO_APP = Object.fromEntries(Object.entries(ENV).filter(([k]) => !k.startsWith('INSTAGRAM_')));

async function boot({ env = ENV_READ, routes = igRoutes({ permissions: READ_PERMS }), extra = [], shop = true, graph = null, langOf = null, disabledSections = [] } = {}) {
  const ctx = makeRuntime({ routes, env });
  if (shop) await ctx.rt.connectorRepository.link({ merchantId: M1, kind: 'shopify', externalId: 'gid://shopify/Shop/STAGING-1', status: 'CONFIGURED', config: {} });
  const registry = createRegistry({ extra });
  const service = createConnectionsService({
    disabledSections, registry, center: ctx.rt.connectionCenter, connectorRepository: ctx.rt.connectorRepository, appConfigPresent: ctx.rt.appConfigPresent, appEnvNames: APP_ENV,
    redirectUriOf: (k) => { try { return ctx.rt.appConfigFor(k).redirectUri; } catch { return `https://sourcing-staging-staging.up.railway.app/api/connections/${k}/callback`; } },
    merchantLabel: async () => 'HABB (test staging)', environmentLabel: 'Staging', shopifySync: async () => ({ status: 'completed', startedAt: '2026-11-17T08:00:00Z', finishedAt: '2026-11-17T08:01:00Z' }), bankCatalog: BELGIAN_BANKS, bankProvider: { id: 'enable-banking', label: 'Enable Banking' },
  });
  const reads = createInstagramReadService({ connectorRepository: ctx.rt.connectorRepository, readerFor: ({ merchantId, connectorId, grantedScopes }) => createInstagramReaderFor({ tokenManager: ctx.rt.tokenManager, merchantId, connectorId, graphVersion: 'v25.0', grantedScopes, fetchImpl: graph?.fetchImpl ?? (async () => { throw new Error('no network in this test'); }) }) });
  const host = await createConnectionsHost({ gate: gateOver(SESSIONS), merchantId: M1, runtime: ctx.rt, service, registry, reads, langOf });
  const s = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); if (!(await host.handle(req, res, u))) { res.writeHead(404); res.end('{"error":"NOT_FOUND"}'); } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${s.address().port}`;
  const seen = [];
  const req = async (path, { token = null, body, csrf = true } = {}) => {
    const post = body !== undefined; const headers = { ...(token ? { cookie: `sid=${token}` } : {}), ...(post ? { 'content-type': 'application/json', ...(token && csrf ? { 'x-nordla-csrf': `csrf-${token}` } : {}) } : {}) };
    const r = await fetch(base + path, { method: post ? 'POST' : 'GET', headers, body: post ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await r.text(); seen.push(text, r.headers.get('location') ?? ''); let json = null; try { json = JSON.parse(text); } catch { /* page */ }
    return { status: r.status, location: r.headers.get('location'), json, text };
  };
  return { ctx, req, seen, close: () => new Promise((r) => s.close(r)) };
}
const find = (ov, id) => ov.categories.flatMap((c) => c.providers).find((p) => p.id === id);

test('CX-1 the registry is extensible: the catalogue, "Commerce et gestion" as Prévu, one Odoo connection with several capabilities, a new provider needs no page change', async () => {
  const ids = PROVIDERS.map((p) => p.id); assert.deepEqual(ids, ['shopify', 'instagram', 'tiktok', 'google_business_profile', 'bank', 'odoo', 'woocommerce', 'prestashop']);
  for (const id of ['odoo', 'woocommerce', 'prestashop']) { const p = PROVIDERS.find((x) => x.id === id); assert.deepEqual([p.category, p.status, p.source], ['commerce_gestion', 'PLANNED', null]); }
  assert.deepEqual([...PROVIDERS.find((p) => p.id === 'odoo').capabilities], ['sales', 'catalog', 'stock', 'invoicing'], 'ONE Odoo connection declares several capabilities');
  assert.equal(CATEGORY.commerce_gestion.label, 'Commerce et gestion');
  assert.throws(() => defineProvider({ id: 'x1', label: 'X', category: 'nope', status: 'PLANNED' }), /unknown category/); assert.throws(() => defineProvider({ id: 'x2', label: 'X', category: 'boutique', status: 'PLANNED', capabilities: ['magic'] }), /unknown capability/);
  assert.throws(() => createRegistry({ extra: [{ id: 'odoo', label: 'Odoo', category: 'commerce_gestion', status: 'PLANNED' }] }), /twice/);
  const t = await boot({ extra: [{ id: 'lightspeed', label: 'Lightspeed', category: 'commerce_gestion', status: 'PLANNED', capabilities: ['sales', 'stock'], description: 'Test.' }] });
  try { const ov = (await t.req('/api/connections', { token: 'tok-viewer' })).json; assert.equal(find(ov, 'lightspeed').statusLabel, 'Prévu'); assert.equal(ov.categories.find((c) => c.id === 'commerce_gestion').providers.length, 4); }
  finally { await t.close(); }
});

test('CX-2 the page shows the real state: Shopify linked + last sync, Instagram "Application Meta à configurer", Google and Bank steps, Odoo / WooCommerce / PrestaShop "Prévu"', async () => {
  const t = await boot({ env: { ...NO_APP, NORDLA_PROVIDER_SCOPE_MODE: 'read' } });
  try {
    const ov = (await t.req('/api/connections', { token: 'tok-owner' })).json; assert.equal(ov.canManage, true);
    const shop = find(ov, 'shopify'); assert.equal(shop.connections.length, 1); assert.equal(shop.connections[0].stateLabel, 'Boutique liée'); assert.equal(shop.connections[0].sync.label, 'Dernière synchronisation réussie'); assert.deepEqual(shop.connections[0].actions, []);
    const ig = find(ov, 'instagram'); assert.equal(ig.setup.state, 'APP_MISSING'); assert.equal(ig.setup.label, 'Application Meta à configurer'); assert.equal(ig.setup.canConnect, false); assert.equal(ig.accessLabel, 'Lecture seule');
    assert.deepEqual(ig.setup.steps.map((x) => [x.title, x.state]), [['Configuration Meta', 'current'], ['Autorisation du compte', 'todo'], ['Vérification', 'todo']]); assert.match(ig.setup.steps[1].detail, /Instagram HABB \(test staging\)/);
    const facts = ig.setup.steps[0].facts.join(' | '); assert.doesNotMatch(facts, /https?:\/\//, 'the return address is not printed in the text'); assert.deepEqual(ig.setup.steps[0].copy, { label: 'Copier l’adresse de retour', value: 'https://sourcing-staging-staging.up.railway.app/api/connections/instagram/callback', what: 'Adresse de retour à déclarer dans l’application (URI de redirection OAuth valides).' }); assert.match(facts, /INSTAGRAM_CLIENT_ID, INSTAGRAM_CLIENT_SECRET, INSTAGRAM_REDIRECT_URI/); assert.equal(ig.dataLabel, 'Profil, publications et statistiques');
    assert.equal(find(ov, 'tiktok').statusLabel, 'Prévu', 'TikTok stays Prévu until its journey is validated'); assert.equal(find(ov, 'tiktok').setup.canConnect, false);
    const g = find(ov, 'google_business_profile'); assert.equal(g.setup.state, 'WAITING'); assert.match(g.setup.detail, /8-1074000042712/); assert.equal(g.connections.length, 0); assert.equal(g.setup.canConnect, false);
    const b = find(ov, 'bank'); assert.equal(b.setup.state, 'WAITING'); assert.equal(b.setup.steps.length, 3); assert.equal(b.bank.banks.length, BELGIAN_BANKS.length); assert.ok(b.bank.banks.some((x) => x.key === 'kbc') && b.bank.pilot === 'kbc'); assert.equal(b.bank.provider.label, 'Enable Banking');
    for (const id of ['odoo', 'woocommerce', 'prestashop']) assert.equal(find(ov, id).statusLabel, 'Prévu');
    assert.equal(find(ov, 'odoo').multiCapability, true);
    const denied = await t.req('/api/connections/connect', { token: 'tok-owner', body: { provider: 'instagram' } }); assert.equal(denied.status, 409); assert.equal(denied.json.error.code, 'APP_NOT_CONFIGURED'); assert.deepEqual(denied.json.missing, ['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET', 'INSTAGRAM_REDIRECT_URI']); // names, never values
    for (const id of ['google_business_profile', 'bank', 'odoo', 'tiktok_x']) assert.equal((await t.req('/api/connections/connect', { token: 'tok-owner', body: { provider: id } })).json.error.code, 'PROVIDER_UNSUPPORTED');
  } finally { await t.close(); }
});

test('CX-3 Instagram READ-ONLY journey with simulated answers: connect -> consent -> return -> choose the account -> verified state, read scopes only, no token in any response', async () => {
  const t = await boot();
  try {
    const start = await t.req('/api/connections/connect', { token: 'tok-owner', body: { provider: 'instagram' } }); assert.equal(start.status, 200);
    const url = new URL(start.json.authorizationUrl); assert.equal(url.hostname, 'www.instagram.com'); assert.equal(url.searchParams.get('redirect_uri'), ENV.INSTAGRAM_REDIRECT_URI);
    assert.deepEqual(url.searchParams.get('scope').split(','), ['instagram_business_basic', 'instagram_business_manage_insights']); assert.doesNotMatch(url.searchParams.get('scope'), /publish|messages|comments/);
    const state = url.searchParams.get('state');
    const back = await t.req(`/api/connections/instagram/callback?code=SIM-CODE-1&state=${encodeURIComponent(state)}`, { token: 'tok-owner' }); // the browser returns with the Nordla cookie
    assert.equal(back.status, 303); const to = new URL(back.location, 'http://x'); assert.equal(to.pathname, '/settings/connections'); assert.equal(to.searchParams.get('provider'), 'instagram'); const ref = to.searchParams.get('connect'); assert.match(ref, /^[0-9a-f-]{36}$/);
    const replay = await t.req(`/api/connections/instagram/callback?code=SIM-CODE-1&state=${encodeURIComponent(state)}`, { token: 'tok-owner' }); assert.match(replay.location, /connect_error=INVALID_STATE/, 'a callback is single use');
    const targets = (await t.req(`/api/connections/targets?session=${ref}`, { token: 'tok-owner' })).json; assert.equal(targets.selectionRequired, true); assert.equal(targets.targets.length, 1); assert.deepEqual([targets.targets[0].externalId, targets.targets[0].displayName, targets.targets[0].eligible], [IG_ACCOUNT, 'habb.be', true]);
    assert.equal(find((await t.req('/api/connections', { token: 'tok-owner' })).json, 'instagram').connections.length, 0, 'nothing is connected before the account is chosen');
    const done = await t.req('/api/connections/select', { token: 'tok-owner', body: { session_ref: ref, external_id: IG_ACCOUNT } }); assert.equal(done.status, 200); assert.equal(done.json.state, 'CONFIGURED');
    const ig = find(done.json, 'instagram'); assert.equal(ig.connections.length, 1); const c = ig.connections[0];
    assert.deepEqual([c.account, c.accountId, c.state, c.stateLabel, c.readOnly], ['habb.be', IG_ACCOUNT, 'VERIFIED', 'Connecté, vérifié', true]); assert.deepEqual(c.scopes, ['instagram_business_basic', 'instagram_business_manage_insights']); assert.ok(c.verifiedAt);
    assert.deepEqual(c.actions, ['read', 'verify', 'reconnect', 'disconnect']);
    const again = await t.req('/api/connections/select', { token: 'tok-owner', body: { session_ref: ref, external_id: IG_ACCOUNT } }); assert.equal(again.status, 409, 'the session is finished');
    const re = await t.req(`/api/connections/${c.id}/verify`, { token: 'tok-owner', body: {} }); assert.equal(re.status, 200); assert.equal(find(re.json, 'instagram').connections[0].state, 'VERIFIED');
    const text = t.seen.join('\n'); for (const s of allSecrets()) assert.ok(!text.includes(s), 'no secret value reaches the browser'); assert.doesNotMatch(text, /access_token|client_secret|refresh_token|SIM-CODE-1/);
    const gone = await t.req(`/api/connections/${c.id}/disconnect`, { token: 'tok-owner', body: {} }); assert.equal(find(gone.json, 'instagram').connections[0].state, 'NOT_CONFIGURED'); assert.equal(find(gone.json, 'instagram').connections[0].stateLabel, 'Non connecté');
  } finally { await t.close(); }
});

test('CX-4 denied consent, an account that is not professional, a stale session and a wrong state are explicit and connect nothing', async () => {
  const t = await boot({ routes: igRoutes({ permissions: READ_PERMS, accountType: 'Personal' }) });
  try {
    const s1 = new URL((await t.req('/api/connections/connect', { token: 'tok-owner', body: { provider: 'instagram' } })).json.authorizationUrl).searchParams.get('state');
    assert.match((await t.req(`/api/connections/instagram/callback?error=access_denied&state=${encodeURIComponent(s1)}`, { token: 'tok-owner' })).location, /connect_error=USER_DENIED/);
    assert.match((await t.req('/api/connections/instagram/callback?code=x&state=forged', { token: 'tok-owner' })).location, /connect_error=INVALID_STATE/);
    const s2 = new URL((await t.req('/api/connections/connect', { token: 'tok-owner', body: { provider: 'instagram' } })).json.authorizationUrl).searchParams.get('state');
    const ref = new URL((await t.req(`/api/connections/instagram/callback?code=c2&state=${encodeURIComponent(s2)}`, { token: 'tok-owner' })).location, 'http://x').searchParams.get('connect');
    const tg = (await t.req(`/api/connections/targets?session=${ref}`, { token: 'tok-owner' })).json.targets[0]; assert.equal(tg.eligible, false); assert.ok(tg.reasons.includes('ACCOUNT_NOT_PROFESSIONAL'));
    const bad = await t.req('/api/connections/select', { token: 'tok-owner', body: { session_ref: ref, external_id: IG_ACCOUNT } }); assert.equal(bad.status, 422); assert.equal(bad.json.error.code, 'PC_TARGET_INELIGIBLE');
    assert.equal((await t.req('/api/connections/select', { token: 'tok-owner', body: { session_ref: ref, external_id: 'someone-else' } })).status, 404, 'an account that was not authorised cannot be chosen');
    assert.equal(find((await t.req('/api/connections', { token: 'tok-owner' })).json, 'instagram').connections.length, 0);
  } finally { await t.close(); }
});

test('CX-5 rights and merchant isolation: a viewer reads but never connects; another merchant is refused; a change needs the CSRF pair; a foreign session cannot be completed', async () => {
  const t = await boot();
  try {
    assert.equal((await t.req('/api/connections')).status, 401); assert.equal((await t.req('/api/connections', { token: 'tok-other' })).json.error.code, 'TENANT_MISMATCH');
    const v = (await t.req('/api/connections', { token: 'tok-viewer' })).json; assert.equal(v.canManage, false); assert.equal(find(v, 'instagram').setup.canConnect, false); assert.deepEqual(find(v, 'shopify').connections[0].actions, []);
    assert.equal((await t.req('/api/connections/connect', { token: 'tok-viewer', body: { provider: 'instagram' } })).json.error.code, 'FORBIDDEN_ROLE');
    assert.equal((await t.req('/api/connections/connect', { token: 'tok-owner', body: { provider: 'instagram' }, csrf: false })).status, 403, 'no CSRF header, no change');
    const state = new URL((await t.req('/api/connections/connect', { token: 'tok-owner', body: { provider: 'instagram' } })).json.authorizationUrl).searchParams.get('state');
    assert.match((await t.req(`/api/connections/instagram/callback?code=c&state=${encodeURIComponent(state)}`, { token: 'tok-viewer' })).location, /connect_error=FORBIDDEN_ROLE/, 'a viewer cannot complete a consent');
    assert.match((await t.req(`/api/connections/instagram/callback?code=c&state=${encodeURIComponent(state)}`, { token: 'tok-other' })).location, /connect_error=TENANT_MISMATCH/);
    assert.match((await t.req(`/api/connections/instagram/callback?code=c&state=${encodeURIComponent(state)}`)).location, /connect_error=SESSION_INVALID/);
    assert.equal((await t.req('/api/connections/targets?session=not-a-uuid', { token: 'tok-owner' })).status, 400);
    assert.equal((await t.req('/api/connections/targets?session=11111111-1111-4111-8111-111111111111', { token: 'tok-viewer' })).json.error.code, 'FORBIDDEN_ROLE');
    // two shops of the same provider coexist: the model never assumes one
    await t.ctx.rt.connectorRepository.link({ merchantId: M1, kind: 'shopify', externalId: 'gid://shopify/Shop/STAGING-2', status: 'CONFIGURED', config: {} });
    assert.equal(find((await t.req('/api/connections', { token: 'tok-owner' })).json, 'shopify').connections.length, 2);
  } finally { await t.close(); }
});

test('CX-6 ISOLATION: without NORDLA_CONNECTIONS_MODULE=1 nothing is built; without the hosted identity neither; when built the provider scopes are READ-ONLY whatever the environment says; the page and the module hold no publishing code', async () => {
  const gate = gateOver(SESSIONS); const hosted = { merchantId: M1, dataDir: '.' }; const log = () => {};
  assert.equal(await buildConnections({ env: {}, gate, hosted, log }), null); assert.equal(await buildConnections({ env: { NORDLA_CONNECTIONS_MODULE: '1' }, gate: null, hosted: null, log }), null);
  const db = createProvisioningDb(); const host = await buildConnections({ env: { ...ENV, NORDLA_CONNECTIONS_MODULE: '1', NORDLA_PROVIDER_SCOPE_MODE: 'publish' }, gate, hosted, log, supabase: db, fetchImpl: async () => { throw new Error('no network in this test'); } });
  assert.equal(typeof host.handle, 'function');
  const s = http.createServer(async (req, res) => { if (!(await host.handle(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end(); } }); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/connections/connect`, { method: 'POST', headers: { cookie: 'sid=tok-owner', 'x-nordla-csrf': 'csrf-tok-owner', 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'instagram' }) });
    assert.equal(r.status, 200); const scope = new URL((await r.json()).authorizationUrl).searchParams.get('scope'); assert.doesNotMatch(scope, /publish/); assert.match(scope, /instagram_business_basic/);
  } finally { await new Promise((r) => s.close(r)); }
  const { readFileSync } = await import('node:fs');
  for (const f of ['../src/connections/registry.js', '../src/connections/service.js', '../src/sourcing/server/connections-host.js', '../src/connections/ui/connections.js']) { const src = readFileSync(new URL(f, import.meta.url), 'utf8'); assert.doesNotMatch(src, /graph\.instagram\.com|api\.instagram\.com|open\.tiktokapis|googleapis\.com|content_publish|media_publish/i, `${f} talks to no provider and publishes nothing`); }
});

test('CX-7 the Settings home: six sections, the real availability of each, the Connections card highlighted with the catalogue states, the Nordla menu, readable by any role, the page served at /settings', async () => {
  const t = await boot({ env: { ...NO_APP, NORDLA_PROVIDER_SCOPE_MODE: 'read' } });
  try {
    const page = await t.req('/settings'); assert.equal(page.status, 200); assert.match(page.text, /connections-assets\/connections\.js/); assert.equal((await t.req('/settings/')).status, 200); assert.equal((await t.req('/api/settings')).status, 401);
    const s = (await t.req('/api/settings', { token: 'tok-viewer' })).json;
    assert.deepEqual(s.cards.map((c) => c.id), ['general', 'team', 'connections', 'notifications', 'preferences', 'security']); assert.deepEqual(s.cards.map((c) => c.label), ['Général', 'Équipe et accès', 'Connexions', 'Notifications', 'Préférences', 'Sécurité']);
    assert.deepEqual(s.cards.filter((c) => c.available).map((c) => c.id), ['general', 'team', 'connections', 'notifications', 'preferences', 'security'], 'Général, Équipe et accès, Connexions, Notifications, Préférences and Sécurité have a screen'); const conn = s.cards.find((c) => c.id === 'connections'); assert.equal(conn.href, '/settings/connections');
    assert.equal(s.cards.find((x) => x.id === 'general').href, '/settings/general'); assert.equal(s.cards.find((x) => x.id === 'security').href, '/settings/security'); for (const c of s.cards.filter((x) => !['connections', 'general', 'security', 'team', 'preferences', 'notifications'].includes(x.id))) { assert.deepEqual([c.available, c.href, c.availabilityLabel], [false, null, 'Prévu']); assert.ok(c.note, 'what already works, or that nothing does'); }
    assert.equal(s.cards.find((c) => c.id === 'team').href, '/settings/team'); assert.equal(s.cards.find((c) => c.id === 'preferences').href, '/settings/preferences'); assert.deepEqual(conn.providers.map((p) => p.id), ['shopify', 'instagram', 'tiktok', 'google_business_profile', 'bank', 'odoo', 'woocommerce', 'prestashop']);
    const st = Object.fromEntries(conn.providers.map((p) => [p.id, p.statusLabel])); assert.deepEqual([st.shopify, st.instagram, st.tiktok, st.google_business_profile, st.bank, st.odoo], ['Connecté', 'Application Meta à configurer', 'Prévu', 'En attente', 'En attente', 'Prévu']);
    assert.ok(!conn.providers.some((p) => /stripe|google analytics/i.test(p.label)), 'the catalogue providers, not the mock-up ones');
    assert.deepEqual(s.nav.map((n) => n.label), ['Accueil', 'Sourcing', 'Achats', 'Finance', 'Analyses', 'Growth', 'Marketing', 'Paramètres']); assert.equal(s.nav.find((n) => n.id === 'settings').href, '/settings'); assert.deepEqual([s.merchant.name, s.environment], ['HABB (test staging)', 'Staging']);
    const noShop = await boot({ shop: false }); try { const c2 = (await noShop.req('/api/settings', { token: 'tok-owner' })).json.cards.find((c) => c.id === 'connections'); assert.equal(c2.providers.find((p) => p.id === 'shopify').statusLabel, 'Non reliée', 'no shop linked to this merchant: said plainly'); } finally { await noShop.close(); }
  } finally { await t.close(); }
});

test('CX-7b the Settings hub follows the signed-in person’s saved language (Préférences); no saved language or a failing lookup = French as before; the card is a "Prévu" card when the module is off', async () => {
  const langs = { 'u-owner': 'nl', 'u-viewer': 'en' };
  const t = await boot({ env: { ...NO_APP, NORDLA_PROVIDER_SCOPE_MODE: 'read' }, langOf: async ({ userId }) => { if (userId === 'u-boom') throw new Error('down'); return langs[userId] ?? null; } });
  try {
    const nl = (await t.req('/api/settings', { token: 'tok-owner' })).json; assert.equal(nl.lang, 'nl'); assert.equal(nl.texts.title, 'Instellingen'); assert.equal(nl.cards.find((c) => c.id === 'preferences').label, 'Voorkeuren'); assert.equal(nl.cards.find((c) => c.id === 'preferences').href, '/settings/preferences'); assert.equal(nl.nav.at(-1).label, 'Instellingen');
    const en = (await t.req('/api/settings', { token: 'tok-viewer' })).json; assert.equal(en.cards.find((c) => c.id === 'security').label, 'Security');
    const fr = (await t.req('/api/settings', { token: 'tok-admin' })).json; assert.equal(fr.lang, undefined); assert.equal(fr.cards.find((c) => c.id === 'preferences').label, 'Préférences'); assert.equal(fr.nav.at(-1).label, 'Paramètres');
  } finally { await t.close(); }
  const off = await boot({ env: { ...NO_APP, NORDLA_PROVIDER_SCOPE_MODE: 'read' }, disabledSections: ['preferences'] });
  try { const c = (await off.req('/api/settings', { token: 'tok-owner' })).json.cards.find((x) => x.id === 'preferences'); assert.deepEqual([c.available, c.href, c.availabilityLabel], [false, null, 'Prévu']); } finally { await off.close(); }
  const boom = await boot({ env: { ...NO_APP, NORDLA_PROVIDER_SCOPE_MODE: 'read' }, langOf: async () => { throw new Error('down'); } });
  try { const r = await boom.req('/api/settings', { token: 'tok-owner' }); assert.equal(r.status, 200); assert.equal(r.json.nav.at(-1).label, 'Paramètres'); } finally { await boom.close(); }
});

// ------------------------------------------------------------------ the Instagram READ through the host (simulated Graph answers)
const gerrBody = (code, message = 'x') => ({ error: { message, type: 'OAuthException', code } });
const insBody = (obj) => ({ data: Object.entries(obj).map(([name, value]) => ({ name, period: 'lifetime', values: [{ value }] })) });
function graphDouble(state) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url); const path = u.pathname; const q = Object.fromEntries(u.searchParams); calls.push({ method: init.method, path });
    const send = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (state.mode === 'rejected') return send(400, gerrBody(190, 'Invalid OAuth access token'));
    if (path === '/v25.0/me') return send(200, { user_id: IG_ACCOUNT, username: 'habb.be', name: 'HABB', account_type: 'Business', followers_count: 128, follows_count: 40, media_count: 53 });
    if (path === '/v25.0/me/media') return send(200, { data: [{ id: 'M2', media_type: 'REELS', timestamp: '2026-11-10T09:00:00+0000', permalink: 'https://www.instagram.com/p/NEW/', caption: 'Coque personnalisée à Namur', like_count: 12, comments_count: 0 }] });
    return send(200, insBody({ reach: 340, views: 0, likes: 12, comments: 0, shares: 2 })); // `saved` is not returned
  };
  return { fetchImpl, calls };
}
async function connectInstagram(t) {
  const state = new URL((await t.req('/api/connections/connect', { token: 'tok-owner', body: { provider: 'instagram' } })).json.authorizationUrl).searchParams.get('state');
  const ref = new URL((await t.req(`/api/connections/instagram/callback?code=SIM&state=${encodeURIComponent(state)}`, { token: 'tok-owner' })).location, 'http://x').searchParams.get('connect');
  const done = await t.req('/api/connections/select', { token: 'tok-owner', body: { session_ref: ref, external_id: IG_ACCOUNT } }); assert.equal(done.status, 200);
  return find(done.json, 'instagram').connections[0];
}
const statOf = (snap, name) => snap.publication.item.stats.find((s) => s.name === name);

test('CX-8 Instagram READ: profile + latest publication from simulated answers; zero vs unavailable vs missing permission are distinct; the date of the last SUCCESSFUL read is kept; a failure never erases it; no secret leaves', async () => {
  const state = { mode: 'ok' }; const graph = graphDouble(state);
  const t = await boot({ graph });
  try {
    const c0 = await connectInstagram(t); assert.equal(c0.canRead, true); assert.deepEqual([c0.lastRead, c0.lastReadOkAt], [null, null], 'nothing read yet: said so'); assert.ok(c0.actions.includes('read'));
    assert.equal((await t.req(`/api/connections/${c0.id}/read`, { token: 'tok-viewer', body: {} })).json.error.code, 'FORBIDDEN_ROLE'); assert.equal((await t.req(`/api/connections/${c0.id}/read`, { token: 'tok-other', body: {} })).json.error.code, 'TENANT_MISMATCH');
    assert.equal(graph.calls.length, 0, 'nothing is read before the owner asks');
    const ok = await t.req(`/api/connections/${c0.id}/read`, { token: 'tok-owner', body: {} }); assert.equal(ok.status, 200); const snap = ok.json.read; assert.equal(snap.outcome, 'OK');
    assert.deepEqual([snap.profile.data.name, snap.profile.data.username, snap.profile.data.followers.value], ['HABB', 'habb.be', 128]);
    assert.deepEqual([statOf(snap, 'reach').state, statOf(snap, 'reach').value], ['VALUE', 340]); assert.deepEqual([statOf(snap, 'views').state, statOf(snap, 'views').value], ['ZERO', 0]); assert.deepEqual([statOf(snap, 'saved').state, statOf(snap, 'saved').value], ['UNAVAILABLE', null]);
    assert.ok(graph.calls.every((c) => c.method === 'GET'), 'only reads');
    const seen = find((await t.req('/api/connections', { token: 'tok-viewer' })).json, 'instagram').connections[0]; // a viewer SEES what was read
    assert.equal(seen.lastReadOkAt, snap.at); assert.equal(seen.lastRead.outcome, 'OK'); assert.equal(seen.lastRead.profile.data.name, 'HABB'); assert.deepEqual(seen.actions, [], 'but cannot trigger a read');
    // the token is refused: explicit error, the failed attempt is recorded, the last SUCCESSFUL read date is untouched
    state.mode = 'rejected'; const bad = await t.req(`/api/connections/${c0.id}/read`, { token: 'tok-owner', body: {} }); assert.equal(bad.status, 409); assert.equal(bad.json.error.code, 'REAUTH_REQUIRED');
    const after = find((await t.req('/api/connections', { token: 'tok-owner' })).json, 'instagram').connections[0]; assert.equal(after.lastReadOkAt, snap.at, 'a failure never erases the last successful read'); assert.deepEqual([after.lastRead.outcome, after.lastRead.problem, after.lastRead.profile], ['FAILED', 'TOKEN_REJECTED', null]); assert.equal(after.lastReadData.profile.data.name, 'HABB', 'the data last really read stays visible after a failure'); assert.equal(after.lastReadData.at, snap.at);
    // the connection carries only the basic permission: the insights are reported as a MISSING PERMISSION, by name
    state.mode = 'ok'; const stored = (await t.ctx.rt.connectorRepository.listForMerchant(M1)).find((c) => c.id === c0.id);
    await t.ctx.rt.connectorRepository.update({ merchantId: M1, connectorId: c0.id, status: 'CONFIGURED', config: { ...stored.config, granted_scopes: ['instagram_business_basic'] } });
    const calls = graph.calls.length; const part = await t.req(`/api/connections/${c0.id}/read`, { token: 'tok-owner', body: {} }); assert.equal(part.status, 200); assert.equal(part.json.read.outcome, 'PARTIAL');
    for (const s of part.json.read.publication.item.stats) assert.deepEqual([s.state, s.permission, s.value], ['PERMISSION_MISSING', 'instagram_business_manage_insights', null]);
    assert.equal(part.json.read.profile.state, 'OK'); assert.ok(!graph.calls.slice(calls).some((c) => c.path.includes('insights')), 'no insight is requested without the permission');
    const text = t.seen.join('\n'); for (const s of allSecrets()) assert.ok(!text.includes(s), 'no secret value reaches the browser'); assert.doesNotMatch(text, /access_token|client_secret|refresh_token|Bearer /);
    assert.equal((await t.req(`/api/connections/${c0.id}/read`, { token: 'tok-owner', body: {}, csrf: false })).status, 403, 'a read needs the CSRF pair too');
  } finally { await t.close(); }
});
