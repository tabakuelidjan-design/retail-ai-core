// The Creator as an ISOLATED module on the hosted Nordla server: same session as the rest of Nordla, archived-run replay instead of a provider, merchant-scoped storage.
// Fakes only (fake identity under the REAL session gate); the replay reads the archived files of config/creator/staging-replay. No network, no provider, no cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCreatorHost, creatorPage } from '../src/sourcing/server/creator-host.js';
import { createStagingCreatorWorld, TEST_IMAGE, TEST_NONE } from '../src/creative-autonomy/creator/staging-world.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';
import { buildCreator } from '../src/sourcing/server/index.js';
import { NONE_CODE } from '../src/creative-autonomy/stop-reason.js';

const M = '67646dbb-5e2e-4cd7-aad6-0d9ae81b9e81'; const OTHER = '4159734e-27be-4772-bb7c-6c5f24fbafcc';
const SESSIONS = {
  'tok-owner': { merchantId: M, userId: 'u-owner', role: 'OWNER', module: 'sourcing' },
  'tok-owner2': { merchantId: M, userId: 'u-owner2', role: 'OWNER', module: 'sourcing' },
  'tok-viewer': { merchantId: M, userId: 'u-viewer', role: 'VIEWER', module: 'sourcing' },
  'tok-other': { merchantId: OTHER, userId: 'u-other', role: 'OWNER', module: 'sourcing' },
};
function gateOver(sessions, moduleCode = 'sourcing') {
  const identity = { context: { module: moduleCode }, resolveAccessSession: async (t) => (sessions[t] ? { ok: true, ...sessions[t] } : { ok: false }), authenticateAndOpenSession: async () => ({ ok: false, status: 401 }), logoutSession: async () => {} };
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
async function boot(dataDir, { merchantId = M } = {}) {
  const host = createCreatorHost({ gate: gateOver(SESSIONS), merchantId, dataDir, delayMs: 5 });
  const s = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); if (!(await host.handle(req, res, u))) { res.writeHead(404); res.end('{"error":"NOT_FOUND"}'); } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (path, { token = null, body = null, csrf = true } = {}) => {
    const headers = { ...(token ? { cookie: `sid=${token}` } : {}), ...(body ? { 'content-type': 'application/json', ...(token && csrf ? { 'x-nordla-csrf': `csrf-${token}` } : {}) } : {}) };
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch { /* a page or an image */ }
    return { status: r.status, type: r.headers.get('content-type'), buf, json, text: buf.toString('utf8') };
  };
  return { req, close: () => new Promise((r) => s.close(r)) };
}
const until = async (fn, ms = 4000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };
const BRIEF = { objective: 'Donner envie d’acheter ce produit.', audience: 'Clients de test', occasion: 'Test', offer: 'Aucune remise', permissions: [] };
const create = (s, product, token = 'tok-owner') => s.req('/api/creator/creations', { token, body: { product_id: product.product_id, variant_id: product.variant_id, ...BRIEF } });
const finished = (s, id, token = 'tok-owner') => until(async () => { const v = (await s.req(`/api/creator/creations/${id}`, { token })).json; return v && !['RUNNING'].includes(v.status) ? v : null; });
const PNG_MAGIC = '89504e470d0a1a0a';

test('CST-1 the page is served at /creator with every file re-pointed at /creator-assets (the sourcing server owns the root paths); no session needed for the page, a session for every API route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cst-')); const s = await boot(dir);
  try {
    const page = await s.req('/creator'); assert.equal(page.status, 200); assert.match(page.type, /text\/html/);
    assert.match(page.text, /\/creator-assets\/creator\.js/); assert.doesNotMatch(page.text, /(?:href|src)="\/(?:creator\.js|creator\.css|style\.css|nordla-ds\.css|nordla-tokens\.css)"/);
    for (const f of ['creator.js', 'creator.css', 'nordla-ds.css', 'nordla-tokens.css', 'style.css', 'nordla-icon.js']) assert.equal((await s.req(`/creator-assets/${f}`)).status, 200, f);
    assert.equal((await s.req('/creator-assets/..%2Fapp.js')).status, 404); assert.equal((await s.req('/creator-assets/unknown.js')).status, 404);
    for (const p of ['/api/creator/status', '/api/creator/products', '/api/creator/creations']) { const r = await s.req(p); assert.equal(r.status, 401, p); }
    assert.equal((await s.req('/api/creator/creations', { body: { product_id: TEST_IMAGE.product_id, variant_id: TEST_IMAGE.variant_id, ...BRIEF } })).status, 401, 'no session, no change');
    assert.equal((await s.req('/procurement/')).status, 404, 'the host answers only its own paths');
    assert.match(await creatorPage(), /\/creator-assets\/nordla-icon\.js/);
  } finally { await s.close(); }
});

test('CST-2 IMAGE: a launch from the merchant session is tracked, ends READY with an image flagged TEST/DEMO, and the result is still there after a restart (same volume)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cst-')); let s = await boot(dir);
  let id;
  try {
    const products = (await s.req('/api/creator/products', { token: 'tok-owner' })).json.products;
    assert.deepEqual(products.map((p) => p.product_id), [TEST_IMAGE.product_id, TEST_NONE.product_id]); assert.ok(products.every((p) => /^TEST/.test(p.title)));
    const st = (await s.req('/api/creator/status', { token: 'tok-owner' })).json; assert.equal(st.demo, true); assert.equal(st.live_provider, false); assert.equal(st.auto_publish, false);
    const c = await create(s, TEST_IMAGE); assert.equal(c.status, 202); assert.equal(c.json.status, 'RUNNING'); id = c.json.creation_id; assert.equal(c.json.demo, true); assert.equal(c.json.published, false);
    const done = await finished(s, id); assert.equal(done.status, 'READY'); assert.equal(done.result.images.length, 1); assert.deepEqual(done.exports, [], 'a TEST image can never be exported');
    const img = await s.req(done.result.images[0], { token: 'tok-owner' }); assert.equal(img.status, 200); assert.equal(img.type, 'image/png'); assert.equal(img.buf.subarray(0, 8).toString('hex'), PNG_MAGIC); assert.ok(img.buf.length > 100_000);
  } finally { await s.close(); }
  // a restart on the same volume: the creation and its file come back
  s = await boot(dir);
  try {
    const list = (await s.req('/api/creator/creations', { token: 'tok-owner' })).json.creations; assert.equal(list.length, 1); assert.equal(list[0].creation_id, id); assert.equal(list[0].status, 'READY');
    const img = await s.req(list[0].result.images[0], { token: 'tok-owner' }); assert.equal(img.status, 200); assert.equal(img.buf.subarray(0, 8).toString('hex'), PNG_MAGIC);
  } finally { await s.close(); }
});

test('CST-3 NONE: the archived run cr-08a0933b0836 ends NO_RESULT with Creator\'s OWN reason and the AD_NO_CONVINCING_IDEA code (not "every proposal was withheld"), and it survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cst-')); let s = await boot(dir); let id;
  try {
    const c = await create(s, TEST_NONE); id = c.json.creation_id; const done = await finished(s, id);
    assert.equal(done.status, 'NO_RESULT'); assert.equal(done.error.code, NONE_CODE); assert.match(done.error.reason, /^Aucun détail visible dans la scène ne montre un besoin concret que ce câble résout/); assert.equal(done.result.images.length, 0);
  } finally { await s.close(); }
  s = await boot(dir);
  try { const v = (await s.req(`/api/creator/creations/${id}`, { token: 'tok-owner' })).json; assert.equal(v.status, 'NO_RESULT'); assert.equal(v.error.code, NONE_CODE); assert.ok(v.error.reason.length > 100); } finally { await s.close(); }
});

test('CST-4 RIGHTS: a session of another merchant is refused, a viewer cannot launch, each person sees only their own creations and files, a change needs the CSRF pair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cst-')); const s = await boot(dir);
  try {
    const c = await create(s, TEST_IMAGE); const id = c.json.creation_id; const done = await finished(s, id); const file = done.result.images[0];
    assert.equal((await s.req('/api/creator/creations', { token: 'tok-other' })).status, 403); assert.equal((await s.req('/api/creator/creations', { token: 'tok-other' })).json.error.code, 'TENANT_MISMATCH');
    assert.equal((await create(s, TEST_IMAGE, 'tok-other')).status, 403);
    assert.equal((await s.req('/api/creator/creations', { token: 'tok-viewer' })).status, 200); const v = await create(s, TEST_IMAGE, 'tok-viewer'); assert.equal(v.status, 403); assert.equal(v.json.error.code, 'FORBIDDEN_ROLE');
    assert.deepEqual((await s.req('/api/creator/creations', { token: 'tok-owner2' })).json.creations, [], 'another person of the same merchant has their own history');
    assert.equal((await s.req(file, { token: 'tok-owner2' })).status, 404, 'and cannot read the file of someone else\'s creation');
    assert.equal((await s.req(file, { token: 'tok-other' })).status, 403); assert.equal((await s.req(file)).status, 401);
    const bad = await s.req('/api/creator/creations', { token: 'tok-owner', csrf: false, body: { product_id: TEST_IMAGE.product_id, variant_id: TEST_IMAGE.variant_id, ...BRIEF } }); assert.equal(bad.status, 403, 'a change without the CSRF pair is refused');
  } finally { await s.close(); }
});

test('CST-5 STORAGE: everything is under <volume>/creator/<merchant>/ ; a produced file is read only from that merchant\'s own images folder, whatever a history file says; ids are validated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cst-')); const w = createStagingCreatorWorld({ dataDir: dir, delayMs: 0 });
  assert.equal(w.imagesDir(M), join(dir, 'creator', M, 'images')); assert.equal(w.persistDirFor(M, 'u1'), join(dir, 'creator', M, 'history', 'u1'));
  assert.throws(() => w.persistDirFor(M, '../x'), (e) => e.code === 'USER_INVALID'); assert.throws(() => w.imagesDir('..\\..\\x'), (e) => e.code === 'MERCHANT_INVALID'); assert.throws(() => w.imagesDir(''), (e) => e.code === 'MERCHANT_INVALID');
  const hub = w.integrationFor(M);
  assert.equal((await hub.call('SOURCING', 'produce_product_visual', { run_id: 'cr-0123456789ab', product_id: TEST_IMAGE.product_id })).ok, false, 'only the Creative module is answered');
  assert.equal((await hub.call('CREATIVE', 'anything_else', { run_id: 'cr-0123456789ab' })).ok, false);
  assert.equal((await hub.call('CREATIVE', 'produce_product_visual', { run_id: '../../evil', product_id: TEST_IMAGE.product_id })).code, 'RUN_ID_INVALID');
  assert.equal((await hub.call('CREATIVE', 'produce_product_visual', { run_id: 'cr-0123456789ab', product_id: 'gid://shopify/Product/1' })).code, 'UNKNOWN_PRODUCT', 'a real product has no archived run: nothing is invented');
  const own = (await hub.call('CREATIVE', 'produce_product_visual', { run_id: 'cr-0123456789ab', product_id: TEST_IMAGE.product_id })).result.results[0].image;
  assert.ok(own.startsWith(join(dir, 'creator', M, 'images')));
  const read = w.readImageFor(M); assert.equal((await read(own)).subarray(0, 8).toString('hex'), PNG_MAGIC);
  mkdirSync(join(dir, 'creator', OTHER, 'images'), { recursive: true }); const foreign = join(dir, 'creator', OTHER, 'images', 'x.png'); writeFileSync(foreign, 'secret');
  await assert.rejects(() => read(foreign), (e) => e.code === 'PATH_REFUSED'); await assert.rejects(() => read(join(dir, 'creator', M, 'images', '..', '..', OTHER, 'images', 'x.png')), (e) => e.code === 'PATH_REFUSED');
  assert.deepEqual(readdirSync(join(dir, 'creator')).sort(), [M, OTHER].sort());
});

test('CST-6 ISOLATION: without NORDLA_CREATOR_MODULE=1 nothing is built; without the hosted identity it is not built either; a broken module never stops the server', async () => {
  const log = []; const gate = {};
  assert.equal(await buildCreator({ env: {}, gate, hosted: { merchantId: M, dataDir: 'x' }, log: (m) => log.push(m) }), null);
  assert.equal(await buildCreator({ env: { NORDLA_CREATOR_MODULE: '1' }, gate: null, hosted: null, log: (m) => log.push(m) }), null); assert.match(log.at(-1), /NOT built/);
  assert.equal(await buildCreator({ env: { NORDLA_CREATOR_MODULE: '1' }, gate, hosted: { merchantId: M, dataDir: 'x' }, log: (m) => log.push(m) }), null, 'a gate without authorize is refused by the Creator: logged, not thrown');
  const ok = await buildCreator({ env: { NORDLA_CREATOR_MODULE: '1' }, gate: gateOver(SESSIONS), hosted: { merchantId: M, dataDir: mkdtempSync(join(tmpdir(), 'cst-')) }, log: (m) => log.push(m) });
  assert.equal(typeof ok.handle, 'function'); assert.match(log.at(-1), /Creator: ON \(archived-run replay, no provider/);
});
