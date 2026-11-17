// "Ajouter une vidéo" on the hosted Nordla server: upload an MP4, play it (Range), edit the two captions separately, find everything after a restart. Fakes only (fake identity under the REAL session gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoHost } from '../src/sourcing/server/video-host.js';
import { buildVideos } from '../src/sourcing/server/index.js';
import { createSessionGate } from '../src/sourcing/server/session-gate.js';

const M = '67646dbb-5e2e-4cd7-aad6-0ab289b068cb'; const OTHER = '4159734e-27be-4772-bb7c-6c5f24fbafcc';
const SESSIONS = {
  'tok-owner': { merchantId: M, userId: 'u-owner', role: 'OWNER', module: 'sourcing' }, 'tok-viewer': { merchantId: M, userId: 'u-viewer', role: 'VIEWER', module: 'sourcing' },
  'tok-other': { merchantId: OTHER, userId: 'u-other', role: 'OWNER', module: 'sourcing' },
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
async function boot(dataDir) {
  const host = await createVideoHost({ gate: gateOver(SESSIONS), merchantId: M, dataDir });
  const s = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://x'); if (!(await host.handle(req, res, u))) { res.writeHead(404); res.end('{"error":"NOT_FOUND"}'); } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${s.address().port}`;
  const req = async (path, { token = null, body, raw, headers = {}, csrf = true } = {}) => {
    const post = body !== undefined || raw !== undefined;
    const h = { ...(token ? { cookie: `sid=${token}` } : {}), ...(post && token && csrf ? { 'x-nordla-csrf': `csrf-${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
    const r = await fetch(base + path, { method: post ? 'POST' : 'GET', headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch { /* page or video */ }
    return { status: r.status, type: r.headers.get('content-type'), range: r.headers.get('content-range'), buf, json, text: buf.toString('utf8') };
  };
  return { req, close: () => new Promise((r) => s.close(r)) };
}
// A tiny but structurally valid MP4 head ("ftyp" box) followed by filler: the host checks the container signature and streams the bytes, it never decodes.
const mp4 = (size = 4096) => { const b = Buffer.alloc(size, 7); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); return b; };
const tmp = () => mkdtempSync(join(tmpdir(), 'vid-'));
const up = (s, token, buf, name = 'UNIPROVE test.mp4') => s.req('/api/videos', { token, raw: buf, headers: { 'content-type': 'video/mp4', 'x-filename': encodeURIComponent(name) } });

test('VD-1 the page and its files are served without a session; every API route (including the video) needs the session', async () => {
  const s = await boot(tmp());
  try {
    const page = await s.req('/videos'); assert.equal(page.status, 200); assert.match(page.text, /video-assets\/video\.js/); assert.doesNotMatch(page.text, /\/gbp/);
    for (const f of ['video.js', 'video.css', 'nordla-ds.css']) assert.equal((await s.req(`/video-assets/${f}`)).status, 200);
    assert.equal((await s.req('/video-assets/secret.txt')).status, 404);
    for (const path of ['/api/videos', '/api/videos/VID-00000000/file']) assert.equal((await s.req(path)).status, 401, path);
    assert.equal((await up(s, null, mp4())).status, 401);
  } finally { await s.close(); }
});

test('VD-2 the owner drops an MP4: it is stored, listed, playable with Range, and the two captions are edited SEPARATELY; everything survives a restart', async () => {
  const dir = tmp(); let s = await boot(dir); const file = mp4(50_000);
  try {
    const a = await up(s, 'tok-owner', file); assert.equal(a.status, 201); const v = a.json.video;
    assert.match(v.id, /^VID-[0-9a-f]{8}$/); assert.equal(v.state, 'DRAFT'); assert.equal(v.stateLabel, 'Brouillon'); assert.equal(v.size, 50_000); assert.equal(v.title, 'UNIPROVE test'); assert.deepEqual([v.captions.tiktok.text, v.captions.instagram.text], ['', '']);
    assert.match(a.json.notice, /aucun compte TikTok ou Instagram n’est connecté/);
    const full = await s.req(v.fileUrl, { token: 'tok-viewer' }); assert.equal(full.status, 200); assert.equal(full.type, 'video/mp4'); assert.ok(full.buf.equals(file), 'the exact bytes come back');
    const part = await s.req(v.fileUrl, { token: 'tok-viewer', headers: { range: 'bytes=0-99' } }); assert.equal(part.status, 206); assert.equal(part.buf.length, 100); assert.equal(part.range, 'bytes 0-99/50000');
    assert.equal((await s.req(v.fileUrl, { token: 'tok-viewer', headers: { range: 'bytes=999999-' } })).status, 416);
    const e1 = await s.req(`/api/videos/${v.id}`, { token: 'tok-owner', body: { tiktok: 'Le verre trempé UNIPROVE, posé en 5 minutes. #HABB' } }); assert.equal(e1.status, 200);
    assert.equal(e1.json.video.captions.tiktok.text, 'Le verre trempé UNIPROVE, posé en 5 minutes. #HABB'); assert.equal(e1.json.video.captions.instagram.text, '', 'editing TikTok leaves Instagram untouched');
    const e2 = await s.req(`/api/videos/${v.id}`, { token: 'tok-owner', body: { instagram: 'Protégez votre écran à Namur.\nRue de Bruxelles 18.' } });
    assert.equal(e2.json.video.captions.instagram.text, 'Protégez votre écran à Namur.\nRue de Bruxelles 18.'); assert.equal(e2.json.video.captions.tiktok.text, 'Le verre trempé UNIPROVE, posé en 5 minutes. #HABB', 'editing Instagram leaves TikTok untouched');
    await s.close(); s = await boot(dir); // restart: the same volume
    const back = (await s.req('/api/videos', { token: 'tok-viewer' })).json.videos; assert.equal(back.length, 1);
    assert.equal(back[0].id, v.id); assert.equal(back[0].captions.tiktok.text, 'Le verre trempé UNIPROVE, posé en 5 minutes. #HABB'); assert.match(back[0].captions.instagram.text, /Rue de Bruxelles 18/); assert.equal(back[0].captions.instagram.updatedBy, 'u-owner');
    assert.ok((await s.req(back[0].fileUrl, { token: 'tok-viewer' })).buf.equals(file), 'the video itself survives the restart');
  } finally { await s.close(); }
});

test('VD-3 refusals: not an MP4, empty, too long a caption; nothing half-written is left on disk', async () => {
  const dir = tmp(); const s = await boot(dir);
  try {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100)]); const r = await up(s, 'tok-owner', png, 'photo.mp4'); assert.equal(r.status, 415); assert.equal(r.json.error.code, 'NOT_AN_MP4');
    const e = await up(s, 'tok-owner', Buffer.alloc(0)); assert.ok([400, 415].includes(e.status));
    const ok = (await up(s, 'tok-owner', mp4())).json.video;
    const long = await s.req(`/api/videos/${ok.id}`, { token: 'tok-owner', body: { tiktok: 'x'.repeat(2201) } }); assert.equal(long.status, 400); assert.equal(long.json.error.code, 'TIKTOK_CAPTION_TOO_LONG');
    assert.equal((await s.req('/api/videos', { token: 'tok-owner' })).json.videos.length, 1, 'the refused files left no draft');
    const files = readdirSync(join(dir, 'video-drafts', M, 'files')); assert.deepEqual(files, [`${ok.id}.mp4`], 'no .part file left');
  } finally { await s.close(); }
});

test('VD-4 rights: a read-only role reads and plays but never changes, another merchant is refused, a change needs the CSRF pair', async () => {
  const s = await boot(tmp());
  try {
    const v = (await up(s, 'tok-owner', mp4())).json.video;
    assert.equal((await up(s, 'tok-viewer', mp4())).json.error.code, 'FORBIDDEN_ROLE');
    assert.equal((await s.req(`/api/videos/${v.id}`, { token: 'tok-viewer', body: { tiktok: 'x' } })).json.error.code, 'FORBIDDEN_ROLE');
    assert.equal((await s.req(`/api/videos/${v.id}/remove`, { token: 'tok-viewer', body: {} })).json.error.code, 'FORBIDDEN_ROLE');
    for (const path of ['/api/videos', v.fileUrl]) { const r = await s.req(path, { token: 'tok-other' }); assert.equal(r.status, 403); assert.equal(r.json.error.code, 'TENANT_MISMATCH'); }
    assert.equal((await s.req(`/api/videos/${v.id}`, { token: 'tok-owner', body: { tiktok: 'x' }, csrf: false })).status, 403, 'no CSRF header, no change');
    assert.equal((await up(s, 'tok-owner', mp4()) ).status, 201);
    const gone = await s.req(`/api/videos/${v.id}/remove`, { token: 'tok-owner', body: {} }); assert.equal(gone.status, 200); assert.equal(gone.json.videos.length, 1); assert.equal((await s.req(v.fileUrl, { token: 'tok-owner' })).status, 404);
  } finally { await s.close(); }
});

test('VD-5 ISOLATION: without NORDLA_VIDEO_DRAFTS_MODULE=1 nothing is built; without the hosted identity it is not built either; the module has no network or publishing code', async () => {
  const gate = gateOver(SESSIONS); const hosted = { merchantId: M, dataDir: tmp() }; const log = () => {};
  assert.equal(await buildVideos({ env: {}, gate, hosted, log }), null); assert.equal(await buildVideos({ env: { NORDLA_VIDEO_DRAFTS_MODULE: '1' }, gate: null, hosted: null, log }), null);
  const host = await buildVideos({ env: { NORDLA_VIDEO_DRAFTS_MODULE: '1' }, gate, hosted, log }); assert.equal(typeof host.handle, 'function');
  const { readFileSync } = await import('node:fs');
  for (const f of ['../src/video-drafts/videos.js', '../src/sourcing/server/video-host.js', '../src/video-drafts/ui/video.js']) { const src = readFileSync(new URL(f, import.meta.url), 'utf8'); assert.doesNotMatch(src, /tiktok\.com|instagram\.com|graph\.facebook|open-api|node:https?'|node:net'|\bfetch\(\s*['"`]https?:/i, `${f} contacts no social network`); }
});
