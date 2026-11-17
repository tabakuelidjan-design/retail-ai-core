// The Google Business post drafts on the hosted Nordla server: review, approval bound to one version, attested manual publication. Fakes only (fake identity under the REAL session gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGbpHost, gbpPage } from '../src/sourcing/server/gbp-host.js';
import { buildGbp } from '../src/sourcing/server/index.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';

const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb'; const OTHER = '4159734e-27be-4772-bb7c-6c5f24fbafcc';
const SESSIONS = {
  'tok-owner': { merchantId: M, userId: 'u-owner', role: 'OWNER', module: 'sourcing' }, 'tok-admin': { merchantId: M, userId: 'u-admin', role: 'ADMIN', module: 'sourcing' },
  'tok-viewer': { merchantId: M, userId: 'u-viewer', role: 'VIEWER', module: 'sourcing' }, 'tok-other': { merchantId: OTHER, userId: 'u-other', role: 'OWNER', module: 'sourcing' },
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
async function boot(dataDir, { draftsDir, merchantId = M } = {}) {
  const host = await createGbpHost({ gate: gateOver(SESSIONS), merchantId, dataDir, ...(draftsDir ? { draftsDir } : {}) });
  const s = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); if (!(await host.handle(req, res, u))) { res.writeHead(404); res.end('{"error":"NOT_FOUND"}'); } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (path, { token = null, body, csrf = true } = {}) => {
    const post = body !== undefined; const headers = { ...(token ? { cookie: `sid=${token}` } : {}), ...(post ? { 'content-type': 'application/json', ...(token && csrf ? { 'x-nordla-csrf': `csrf-${token}` } : {}) } : {}) };
    const r = await fetch(base + path, { method: post ? 'POST' : 'GET', headers, body: post ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch { /* page or image */ }
    return { status: r.status, type: r.headers.get('content-type'), buf, json, text: buf.toString('utf8') };
  };
  return { req, close: () => new Promise((r) => s.close(r)) };
}
const TEXT_11 = 'Verre trempé à 15 €, pose incluse chez HABB à Namur. Appelez-nous avec le modèle de votre téléphone pour vérifier la disponibilité.\n\nHABB · Rue de Bruxelles 18, Namur\nDu lundi au samedi, de 10 h à 18 h.';
const TEXT_12 = 'Une photo que vous aimez, sur une coque imprimée dans notre atelier à Namur. On cadre l’image avec vous, puis on imprime sur place.\n\nCoque et personnalisation à 25 €. Comptez environ 5 minutes si la coque pour votre modèle est en stock.\n\nHABB · Rue de Bruxelles 18, Namur\nDu lundi au samedi, de 10 h à 18 h.';
const tmp = () => mkdtempSync(join(tmpdir(), 'gbp-'));

test('GD-1 the page and its files are served without a session; every API route (including the images) needs the session', async () => {
  const s = await boot(tmp());
  try {
    const p = await s.req('/gbp'); assert.equal(p.status, 200); assert.match(p.type, /text\/html/); assert.match(p.text, /\/gbp-assets\/gbp\.js/); assert.doesNotMatch(p.text, /href="\/gbp\.css"/); assert.equal(p.text, await gbpPage());
    for (const f of ['gbp.js', 'gbp.css', 'nordla-ds.css', 'nordla-tokens.css']) assert.equal((await s.req(`/gbp-assets/${f}`)).status, 200, f);
    assert.equal((await s.req('/gbp-assets/other.js')).status, 404);
    for (const path of ['/api/gbp/drafts', '/api/gbp/drafts/GBP-POST-11/image']) assert.equal((await s.req(path)).status, 401, path);
    assert.equal((await s.req('/api/gbp/drafts/GBP-POST-11/approve', { body: {} })).status, 401);
    assert.equal((await s.req('/api/creator/status')).status, 404, 'no other module is mounted by this host');
  } finally { await s.close(); }
});

test('GD-2 the two drafts carry the owner\'s exact texts, their image (a real JPEG), a state "À examiner" and the honest "no publication from Nordla" notice with the Google case', async () => {
  const s = await boot(tmp());
  try {
    const v = (await s.req('/api/gbp/drafts', { token: 'tok-viewer' })).json;
    assert.deepEqual(v.drafts.map((d) => d.id), ['GBP-POST-11', 'GBP-POST-12']); assert.equal(v.drafts[0].text, TEXT_11); assert.equal(v.drafts[1].text, TEXT_12);
    assert.ok(v.drafts.every((d) => d.state === 'REVIEW' && d.stateLabel === 'À examiner' && d.checks.length && /^[0-9a-f]{64}$/.test(d.version)));
    assert.equal(v.publish.available, false); assert.equal(v.publish.case, '8-1074000042712'); assert.match(v.publish.message, /8-1074000042712/);
    for (const d of v.drafts) { const img = await s.req(d.imageUrl.split('?')[0], { token: 'tok-viewer' }); assert.equal(img.status, 200); assert.equal(img.type, 'image/jpeg'); assert.equal(img.buf.subarray(0, 2).toString('hex'), 'ffd8'); assert.ok(img.buf.length > 50_000); }
    assert.equal((await s.req('/api/gbp/drafts/GBP-POST-99/image', { token: 'tok-viewer' })).status, 404);
  } finally { await s.close(); }
});

test('GD-3 approval is bound to the version read, a publication can only be attested for an approved version, a withdrawal is possible, and everything survives a restart', async () => {
  const dir = tmp(); let s = await boot(dir);
  try {
    const d = (await s.req('/api/gbp/drafts', { token: 'tok-owner' })).json.drafts[0];
    const stale = await s.req('/api/gbp/drafts/GBP-POST-11/approve', { token: 'tok-owner', body: { expected_version: 'f'.repeat(64) } }); assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'VERSION_CHANGED');
    assert.equal((await s.req('/api/gbp/drafts/GBP-POST-11/published', { token: 'tok-owner', body: {} })).json.error.code, 'NOT_APPROVED', 'nothing can be attested before approval');
    const ok = await s.req('/api/gbp/drafts/GBP-POST-11/approve', { token: 'tok-owner', body: { expected_version: d.version } }); assert.equal(ok.status, 200);
    const a = ok.json.drafts.find((x) => x.id === 'GBP-POST-11'); assert.equal(a.state, 'APPROVED'); assert.equal(a.approvedBy, 'u-owner'); assert.ok(a.approvedAt); assert.equal(ok.json.drafts.find((x) => x.id === 'GBP-POST-12').state, 'REVIEW', 'the other draft is untouched');
    assert.equal((await s.req('/api/gbp/drafts/GBP-POST-11/approve', { token: 'tok-owner', body: { expected_version: d.version } })).json.error.code, 'ALREADY_APPROVED');
    assert.equal((await s.req('/api/gbp/drafts/GBP-POST-11/published', { token: 'tok-owner', body: { url: 'http://not-https.example' } })).json.error.code, 'URL_INVALID');
    await s.close(); s = await boot(dir); // restart: the same volume
    assert.equal((await s.req('/api/gbp/drafts', { token: 'tok-admin' })).json.drafts[0].state, 'APPROVED', 'the approval survives a restart');
    const pub = await s.req('/api/gbp/drafts/GBP-POST-11/published', { token: 'tok-admin', body: { url: 'https://g.page/r/habb-test' } }); assert.equal(pub.status, 200);
    const p = pub.json.drafts[0]; assert.deepEqual([p.state, p.publishedUrl, p.publishedAt !== null], ['PUBLISHED', 'https://g.page/r/habb-test', true]); assert.equal((await s.req('/api/gbp/drafts/GBP-POST-11/published', { token: 'tok-owner', body: {} })).json.error.code, 'ALREADY_PUBLISHED');
    const back = await s.req('/api/gbp/drafts/GBP-POST-11/revoke', { token: 'tok-owner', body: {} }); assert.equal(back.json.drafts[0].state, 'REVIEW'); assert.equal((await s.req('/api/gbp/drafts/GBP-POST-11/revoke', { token: 'tok-owner', body: {} })).json.error.code, 'NOT_APPROVED');
  } finally { await s.close(); }
});

test('GD-4 rights: a read-only role reads but never decides, another merchant is refused, and a change needs the CSRF pair', async () => {
  const s = await boot(tmp());
  try {
    const d = (await s.req('/api/gbp/drafts', { token: 'tok-viewer' })).json.drafts[0]; const body = { expected_version: d.version };
    assert.equal((await s.req('/api/gbp/drafts/GBP-POST-11/approve', { token: 'tok-viewer', body })).json.error.code, 'FORBIDDEN_ROLE');
    for (const path of ['/api/gbp/drafts', '/api/gbp/drafts/GBP-POST-11/image']) { const r = await s.req(path, { token: 'tok-other' }); assert.equal(r.status, 403); assert.equal(r.json.error.code, 'TENANT_MISMATCH'); }
    assert.equal((await s.req('/api/gbp/drafts/GBP-POST-11/approve', { token: 'tok-owner', body, csrf: false })).status, 403, 'no CSRF header, no change');
    assert.equal((await s.req('/api/gbp/drafts', { token: 'tok-viewer' })).json.drafts[0].state, 'REVIEW', 'nothing was decided');
  } finally { await s.close(); }
});

test('GD-5 an approval applies to ONE version: when the text of a draft changes, the draft is back to "À examiner" and must be approved again', async () => {
  const dataDir = tmp(); const draftsDir = join(tmp(), 'drafts'); cpSync(new URL('../config/gbp-drafts/habb/', import.meta.url), draftsDir, { recursive: true });
  const url = () => pathToFileURL(`${draftsDir}${draftsDir.endsWith('/') || draftsDir.endsWith('\\') ? '' : '/'}`);
  let s = await boot(dataDir, { draftsDir: url() });
  try {
    const d = (await s.req('/api/gbp/drafts', { token: 'tok-owner' })).json.drafts[0];
    assert.equal((await s.req('/api/gbp/drafts/GBP-POST-11/approve', { token: 'tok-owner', body: { expected_version: d.version } })).status, 200);
    await s.close();
    const f = join(draftsDir, 'drafts.json'); writeFileSync(f, readFileSync(f, 'utf8').replace('pose incluse chez HABB', 'pose incluse chez HABB Namur')); // the owner changes the TEXT (the title is not part of the version)
    s = await boot(dataDir, { draftsDir: url() });
    const after = (await s.req('/api/gbp/drafts', { token: 'tok-owner' })).json.drafts[0]; assert.notEqual(after.version, d.version); assert.equal(after.state, 'REVIEW', 'the old approval does not cover the new text');
    assert.equal((await s.req('/api/gbp/drafts/GBP-POST-11/approve', { token: 'tok-owner', body: { expected_version: d.version } })).json.error.code, 'VERSION_CHANGED', 'approving the version read before the change is refused');
  } finally { await s.close(); }
});

test('GD-6 ISOLATION: without NORDLA_GBP_DRAFTS_MODULE=1 nothing is built; without the hosted identity it is not built either; a broken drafts folder never stops the server', async () => {
  const gate = gateOver(SESSIONS); const logs = []; const log = (l) => logs.push(l);
  assert.equal(await buildGbp({ env: {}, gate, hosted: { merchantId: M, dataDir: tmp() }, log }), null);
  assert.equal(await buildGbp({ env: { NORDLA_GBP_DRAFTS_MODULE: '1' }, gate: null, hosted: null, log }), null); assert.match(logs.at(-1), /NOT built/);
  const on = await buildGbp({ env: { NORDLA_GBP_DRAFTS_MODULE: '1' }, gate, hosted: { merchantId: M, dataDir: tmp() }, log }); assert.equal(typeof on.handle, 'function'); assert.match(logs.at(-1), /nothing is published by Nordla/);
  await assert.rejects(() => createGbpHost({ gate, merchantId: M, dataDir: tmp(), draftsDir: pathToFileURL('C:/does/not/exist/') }));
  const src = readFileSync(new URL('../src/sourcing/server/app.js', import.meta.url), 'utf8'); assert.match(src, /if \(gbp && await gbp\.handle\(req, res, url\)\) return;/);
});
