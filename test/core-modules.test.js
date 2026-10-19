// The single Nordla entry on the HOSTED server, end to end, on ISOLATED SYNTHETIC data (Finance acceptance world, Analytics dataset):
// the 7 modules as the server reports them, Finance / Analytics answers with sources, Branding proposal -> preview -> OWNER approval
// -> official Guardian verdict, Marketing proposal -> OWNER decision, Creative honestly blocked without a provider; who acts comes from
// the session; everything survives a restart; nothing is published, paid or produced.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { accWorld } from './finance-acceptance-world.js';
import { writeDataset, NOW as AN_NOW } from './fixtures/analytics-dataset.js';
import { createFinanceReader } from '../src/core-pilot/finance-reader.js';
import { createAnalyticsReader } from '../src/core-pilot/analytics-reader.js';
import { creativeCapability } from '../src/core-pilot/campaign.js';
import { Resvg } from '@resvg/resvg-js';

const M = '36b1a1a7-2a48-416a-9dfe-ce66fe1ec2a5';
const people = ['owner', 'buyer'].map((k, i) => ({ key: k, id: `${String(i + 1).padStart(8, '0')}-3333-4333-8333-${String(i + 1).padStart(12, '0')}`, email: `${k}@nordla-test.example`, password: `synthetic passphrase for ${k}` }));
const [PO, PB] = people; const HOST = 'app.nordla-test.example'; const ORIGIN = `https://${HOST}`;

async function world() {
  const ENV = { SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: M, SOURCING_PUBLIC_ORIGIN: ORIGIN, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'x', SUPABASE_ANON_KEY: 'anon', NORDLA_IDENTITY_RATE_LIMIT_KEY: randomBytes(32).toString('hex'), NORDLA_CSRF_KEY: randomBytes(32).toString('hex'), SOURCING_MERCHANT_ID: 'habb', SOURCING_HOST: '127.0.0.1' };
  const db = createIdentityDb({ merchants: [M], users: people.map((p) => p.id) }); const auth = createFakeGoTrue({ users: people });
  const members = createMemberService({ supabase: db.supabase, merchantId: M }); await members.bootstrapOwner({ userId: PO.id }); await members.addMember({ actorUserId: PO.id, targetUserId: PB.id, role: 'COLLABORATOR' });
  await createModuleProvisioning({ supabase: db.supabase }).enableModule({ merchantId: M, moduleCode: 'sourcing', source: 'provisioning:manual' });
  // isolated synthetic Finance + Analytics (never real data)
  const fw = accWorld({ merchantId: M });
  const a = await fw.supplier(121000, { dueDate: '2026-09-28', supplierName: 'Yiwu Greenline', invoiceNumber: 'YG-1' }); await fw.supplier(48400, { dueDate: '2026-10-08', supplierName: 'Dongguan Pioneer', invoiceNumber: 'DP-7' }); await fw.paySupplier(21000, [[a.id, 21000]]);
  const readers = { finance: createFinanceReader({ store: fw.st, merchantId: M, timeZone: 'Europe/Brussels', now: () => '2026-10-03T10:00:00.000Z', source: 'Finance · données de test isolées' }), analytics: createAnalyticsReader({ reportsDir: await writeDataset(), now: () => AN_NOW, source: 'Analytics · données de test isolées' }) };
  const dir = await mkdtemp(join(tmpdir(), 'nordla-modules-'));
  const services = () => ({ readers, identity: createIdentityService({ merchantId: M, moduleCode: 'sourcing', supabase: db.supabase, auth: { baseUrl: ENV.SUPABASE_URL, anonKey: ENV.SUPABASE_ANON_KEY }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, fetchImpl: auth.fetchImpl }), security: createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [HOST], allowedOrigins: [ORIGIN], moduleCode: 'sourcing', csrfKey: ENV.NORDLA_CSRF_KEY, rateLimitKey: ENV.NORDLA_IDENTITY_RATE_LIMIT_KEY, loginTiming: { minMs: 200, jitterMs: 0 } }) });
  const w = { dir, srv: null };
  w.start = async () => { w.srv = await startSourcingServer({ env: { ...ENV, SOURCING_DATA_DIR: dir }, log: () => {}, port: 0, services: services(), fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) }); };
  w.stop = async () => { await new Promise((r) => w.srv.server.close(r)); w.srv.server.closeAllConnections?.(); };
  const H = { host: HOST, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7', origin: ORIGIN };
  w.call = (method, path, { body, who } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: w.srv.port, path, method, headers: { ...H, 'content-type': 'application/json', ...(who ? { cookie: who.cookie, 'x-nordla-csrf': who.csrf } : {}), ...(data ? { 'content-length': data.length } : {}) } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  w.raw = (path, who) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: w.srv.port, path, method: 'GET', headers: { ...H, ...(who ? { cookie: who.cookie } : {}) } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], bytes: Buffer.concat(c) })); });
    r.on('error', reject); r.end();
  });
  w.login = (p) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ email: p.email, password: p.password }));
    const r = http.request({ host: '127.0.0.1', port: w.srv.port, path: '/api/auth/login', method: 'POST', headers: { ...H, 'content-type': 'application/json', 'content-length': data.length } }, (res) => { res.resume(); res.on('end', () => { const set = res.headers['set-cookie'] ?? []; const pick = (n) => set.find((c) => c.startsWith(n))?.split(';')[0]; const sid = pick('__Host-nordla_sourcing_sid='); const cs = pick('__Host-nordla_sourcing_csrf='); resolve({ cookie: [sid, cs].join('; '), csrf: cs?.split('=')[1] }); }); });
    r.on('error', reject); r.write(data); r.end();
  });
  return w;
}

test('Nordla single entry: the modules (7 connected + the ones listed as not connected) with their REAL state, Finance / Analytics answers with sources, Branding and Marketing with OWNER decisions, Creative blocked honestly, restart-safe', async () => {
  const w = await world(); await w.start();
  try {
    assert.equal((await w.call('GET', '/api/core/modules')).status, 401, 'no session, nothing');
    const owner = await w.login(PO); const buyer = await w.login(PB);
    const mods = (await w.call('GET', '/api/core/modules', { who: owner })).body.modules;
    assert.deepEqual(mods.map((m) => [m.key, m.state]), [['core', 'DISPONIBLE'], ['finance', 'LECTURE SEULE'], ['analytics', 'LECTURE SEULE'], ['procurement', 'DISPONIBLE'], ['sourcing', 'DISPONIBLE'], ['branding', 'À APPROUVER'], ['marketing', 'LIMITÉ'], ['creative', 'LIMITÉ'],
      // convergence: the modules that exist but are not (all) connected here are listed too, with their honest state
      ['parle', 'LIMITÉ'], ['validations', 'LIMITÉ'], ['social', 'NON RACCORDÉ'], ['activation', 'NON RACCORDÉ'], ['growth', 'NON RACCORDÉ']]);
    assert.match(mods.find((m) => m.key === 'creative').detail, /Génération IA : aucun fournisseur connecté/, 'AI generation stays said as not connected');
    assert.deepEqual(mods.filter((m) => m.offline).map((m) => m.key), ['sourcing'], 'only Sourcing is said to work offline');
    // Finance and Analytics through Parle à Nordla, with sources
    const fin = (await w.call('POST', '/api/core/ask', { who: buyer, body: { text: 'quelles factures fournisseurs dois-je payer et quelles sont les échéances ?' } })).body;
    assert.match(fin.answer, /EN RETARD de 5 j — Yiwu Greenline/); assert.equal(fin.sources[0].source, 'Finance · données de test isolées');
    const sales = (await w.call('POST', '/api/core/ask', { who: buyer, body: { text: 'comment évoluent mes ventes ?' } })).body;
    assert.match(sales.answer, /Chiffre d’affaires net HT : 489,25 €/); assert.equal(sales.sources[0].kind, 'analytics');
    // Branding: proposal, preview (not official), collaborator cannot approve, owner approves -> official verdicts
    assert.equal((await w.call('GET', '/api/core/branding', { who: buyer })).body.status, 'PROPOSED_NOT_APPROVED');
    const pre = (await w.call('POST', '/api/core/branding/check', { who: buyer, body: { text: 'Dernière chance !!! Le meilleur cadeau de Namur.' } })).body;
    assert.equal(pre.official, false); assert.equal(pre.status, 'RULES_NOT_APPROVED'); assert.ok(pre.findings.some((f) => f.forbidden === 'dernière chance'));
    const refused = await w.call('POST', '/api/core/branding/approve', { who: buyer }); assert.equal(refused.status, 403);
    assert.equal((await w.call('POST', '/api/core/branding/approve', { who: owner })).body.status, 'APPROVED');
    const off = (await w.call('POST', '/api/core/branding/check', { who: buyer, body: { text: 'Dernière chance !!! Le meilleur cadeau de Namur.' } })).body;
    assert.equal(off.official, true); assert.equal(off.outcome, 'FAIL');
    assert.equal((await w.call('POST', '/api/core/branding/check', { who: buyer, body: { text: 'Un cadeau personnalisé, imprimé avec soin dans notre boutique de Namur.' } })).body.outcome, 'PASS');
    // Marketing proposal from identified data -> blockers said -> owner decision; never publishable
    const camp = (await w.call('POST', '/api/core/campaigns', { who: buyer, body: { product: 'Fixture Widget', objective: 'ventes en boutique', audience: 'parents', channel: 'Instagram', copy: 'Un cadeau personnalisé, imprimé avec soin dans notre boutique de Namur.' } })).body;
    assert.equal(camp.publishable, false); assert.equal(camp.contract.published, false); assert.equal(camp.creative.status, 'PROVIDER_NOT_CONNECTED');
    assert.equal(camp.brand.outcome, 'PASS'); assert.ok(camp.blockers.some((b) => /affirmation approuvée/.test(b)) && camp.blockers.some((b) => /aucun fournisseur/.test(b)));
    assert.equal(camp.opportunity.source, 'Analytics · données de test isolées');
    assert.equal((await w.call('POST', `/api/core/campaigns/${encodeURIComponent(camp.id)}/decision`, { who: buyer, body: { decision: 'APPROVED_FOR_CREATION', reason: 'ok' } })).status, 403);
    assert.equal((await w.call('POST', `/api/core/campaigns/${encodeURIComponent(camp.id)}/decision`, { who: owner, body: { decision: 'DEFERRED', reason: '' } })).status, 400, 'a reason is required');
    const dec = (await w.call('POST', `/api/core/campaigns/${encodeURIComponent(camp.id)}/decision`, { who: owner, body: { decision: 'DEFERRED', reason: 'attendre les affirmations produit vérifiées' } })).body;
    assert.equal(dec.by, `user:${PO.id}`); assert.equal(dec.published, false);
    // restart: approval and campaign decisions are still there (server volume)
    await w.stop(); await w.start(); const again = await w.login(PO);
    assert.equal((await w.call('GET', '/api/core/branding', { who: again })).body.status, 'APPROVED');
    const list = (await w.call('GET', '/api/core/campaigns', { who: again })).body.campaigns; assert.equal(list.length, 1); assert.equal(list[0].decision.decision, 'DEFERRED');
    assert.equal((await w.call('GET', '/api/core/modules', { who: again })).body.modules.find((m) => m.key === 'branding').state, 'DISPONIBLE');
    assert.doesNotMatch(await readFile(join(w.dir, 'core', 'campaigns.jsonl'), 'utf8'), /@nordla-test\.example/, 'no e-mail stored');
  } finally { await w.stop(); await rm(w.dir, { recursive: true, force: true }); }
});

test('Creative capability: without provider keys it is PROVIDER_NOT_CONNECTED with the missing keys named; nothing is produced', () => {
  const c = creativeCapability({});
  assert.equal(c.status, 'PROVIDER_NOT_CONNECTED'); assert.deepEqual(c.missing, ['ALIBABA_MODEL_STUDIO_API_KEY', 'ALIBABA_MODEL_STUDIO_WORKSPACE_ID']); assert.match(c.note, /ni simulée/);
  const k = creativeCapability({ ALIBABA_MODEL_STUDIO_API_KEY: 'k', ALIBABA_MODEL_STUDIO_WORKSPACE_ID: 'ws-1234567890' });
  assert.notEqual(k.status, 'READY', 'keys alone never mean a verified provider');
});

// A synthetic "photo" (never a merchant asset): a dark frame, colour blocks and a disc.
const photoPng = (seed = 1) => new Uint8Array(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#202020"/><rect x="20" y="20" width="560" height="760" fill="rgb(${200 - seed * 9},170,150)"/><circle cx="300" cy="400" r="${150 + seed}" fill="#34495e"/></svg>`).render().asPng());
const dataUrl = (b) => `data:image/png;base64,${Buffer.from(b).toString('base64')}`;

test('Création without a provider: the owner\'s photo kept pixel-exact + a headline -> deterministic PNG with MEASURED fidelity, brand-checked, OWNER decision, restart-safe; nothing published', async () => {
  const w = await world(); await w.start();
  try {
    assert.equal((await w.call('POST', '/api/core/creation', { body: { photo: dataUrl(photoPng()), headline: 'x' } })).status, 401, 'no session, nothing');
    const owner = await w.login(PO); const buyer = await w.login(PB);
    const st = (await w.call('GET', '/api/core/creation', { who: buyer })).body;
    assert.equal(st.status, 'LOCAL_AVAILABLE'); assert.equal(st.typography, 'Playfair Display'); assert.equal(st.ai_generation, 'non connectée');
    const c = (await w.call('POST', '/api/core/creation', { who: buyer, body: { photo: dataUrl(photoPng()), headline: 'Un cadeau imprimé avec soin à Namur' } })).body;
    assert.equal(c.status, 'TO_OWNER_REVIEW'); assert.equal(c.published, false); assert.equal(c.owner_approval, 'PENDING'); assert.equal(c.by, `user:${PB.id}`);
    assert.deepEqual(Object.fromEntries(c.fidelity.map((f) => [f.check, f.outcome])), { PRODUCT_IDENTITY: 'PASS', PRODUCT_GEOMETRY: 'PASS', PIECE_COUNT: 'PASS', PRODUCT_COLOR: 'PASS', TEXT: 'NOT_MEASURABLE' }, 'measured on the delivered PNG; printed text on the photo is said unmeasured');
    assert.equal(c.brand.official, false, 'rules not approved: the brand check is a labelled preview');
    assert.equal(c.png.width, 1080); assert.equal(c.png.height, 1350);
    // the PNG is served only with a session, and its bytes are the recorded ones
    assert.equal((await w.raw(`/api/core/creation/${c.id}.png`)).status, 401);
    const img = await w.raw(`/api/core/creation/${c.id}.png`, buyer);
    assert.equal(img.status, 200); assert.equal(img.type, 'image/png'); assert.equal(createHash('sha256').update(img.bytes).digest('hex'), c.png.sha256);
    // same photo + same headline = the same bytes, kept once (deterministic; the product mask of PM-6 is not on this path)
    const again = (await w.call('POST', '/api/core/creation', { who: owner, body: { photo: dataUrl(photoPng()), headline: 'Un cadeau imprimé avec soin à Namur' } })).body;
    assert.equal(again.id, c.id); assert.equal(again.png.sha256, c.png.sha256);
    // input errors are said, never guessed
    assert.equal((await w.call('POST', '/api/core/creation', { who: buyer, body: { photo: dataUrl(photoPng()), headline: '' } })).body.error, 'FIELD_REQUIRED');
    assert.equal((await w.call('POST', '/api/core/creation', { who: buyer, body: { photo: 'data:image/png;base64,AAAA', headline: 'Titre' } })).body.error, 'PHOTO_FORMAT');
    const clear = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="10" fill="#000"/></svg>').render().asPng());
    assert.equal((await w.call('POST', '/api/core/creation', { who: buyer, body: { photo: dataUrl(clear), headline: 'Titre' } })).body.error, 'PHOTO_TRANSPARENT', 'transparency is refused, not measured as if opaque');
    // OWNER decision only, with a reason
    assert.equal((await w.call('POST', `/api/core/creation/${c.id}/decision`, { who: buyer, body: { decision: 'APPROVED', reason: 'ok' } })).status, 403);
    assert.equal((await w.call('POST', `/api/core/creation/${c.id}/decision`, { who: owner, body: { decision: 'APPROVED', reason: '' } })).status, 400);
    const d = (await w.call('POST', `/api/core/creation/${c.id}/decision`, { who: owner, body: { decision: 'APPROVED', reason: 'photo fidèle, titre sobre' } })).body;
    assert.equal(d.by, `user:${PO.id}`); assert.equal(d.published, false);
    // once the brand rules are approved, a forbidden headline is BLOCKED before any rendering
    assert.equal((await w.call('POST', '/api/core/branding/approve', { who: owner })).body.status, 'APPROVED');
    const blocked = (await w.call('POST', '/api/core/creation', { who: buyer, body: { photo: dataUrl(photoPng(2)), headline: 'Dernière chance !!!' } })).body;
    assert.equal(blocked.status, 'BLOCKED_BY_BRAND'); assert.equal(blocked.png, null); assert.equal(blocked.brand.outcome, 'FAIL');
    // restart: visuals, decisions and images are still there
    await w.stop(); await w.start(); const o2 = await w.login(PO);
    const list = (await w.call('GET', '/api/core/creation', { who: o2 })).body.creations;
    assert.deepEqual(list.map((x) => x.status), ['BLOCKED_BY_BRAND', 'TO_OWNER_REVIEW']); assert.equal(list[1].decision.decision, 'APPROVED');
    assert.equal((await w.raw(`/api/core/creation/${c.id}.png`, o2)).status, 200);
    assert.doesNotMatch(await readFile(join(w.dir, 'core', 'creations', 'creations.jsonl'), 'utf8'), /@nordla-test\.example|base64/, 'no e-mail and no photo bytes in the journal');
  } finally { await w.stop(); await rm(w.dir, { recursive: true, force: true }); }
});
