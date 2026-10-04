// HTTP app for China Sourcing field mode. The decision logic lives in src/sourcing/core and runs IN THE BROWSER too (offline): this server only adds what a phone cannot do
// alone - cases kept on disk, the Safety Gate cache, PDF text, optional ECB rates and an optional AI provider. Every /api route needs the token.
import { readFile, readdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { join, extname } from 'node:path';
import { matchSafetyGate } from '../core/safety.js';
import { compactAlert } from '../adapters/safety-gate.js';
import { pdfToText } from '../adapters/pdf.js';
import { fxFor } from '../adapters/fx.js';
import { callProvider, DATA_CLASS, ProviderPolicyError } from '../adapters/ai-provider.js';
import { StoreError } from '../store/file-store.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
const MAX_BODY = 16 * 1024 * 1024;
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css', '/sw.js': 'sw.js', '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg', '/storage.js': 'storage.js', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/icon-maskable-512.png': 'icon-maskable-512.png', '/apple-touch-icon.png': 'apple-touch-icon.png' };
const CORE_FILE = /^\/core\/((?:rulebook\/)?[a-z0-9-]+\.js)$/;

const sameToken = (a, b) => { const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'same-origin', 'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
const json = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC, ...extra }); res.end(JSON.stringify(body)); };
async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

/** Behind the local tunnel every request comes from 127.0.0.1: the proxy's own header (trusted ONLY from a loopback peer) tells the real client apart, so one attacker cannot lock the owner out. */
const clientIp = (req) => { const peer = req.socket.remoteAddress ?? 'unknown'; const loop = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer); const fwd = loop ? String(req.headers['cf-connecting-ip'] ?? '').trim() : ''; return /^[0-9a-f.:]{3,45}$/i.test(fwd) ? fwd : peer; };
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const FAIL_LIMIT = 8; const FAIL_WINDOW_MS = 60_000;

export function createSourcingApp({ token, store, safety = null, ecb = null, ai = null, uiDir, coreDir, allowedHosts = null, now = () => new Date() }) {
  if (!token || String(token).length < 24) throw new Error('a token of at least 24 characters is required');
  // Host header allow-list (blocks DNS-rebinding on the loopback server). A tunnel's public host name must be added by the owner (SOURCING_ALLOWED_HOSTS).
  // `allowedHosts` may be a live array: the phone launcher adds the tunnel host name once it is known
  const hostOk = (req) => { const hosts = (allowedHosts ?? []).map((h) => String(h).toLowerCase()); const h = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''); return hosts.length ? hosts.includes(h) || LOOPBACK_HOSTS.includes(h) : true; };
  // failed token attempts per client address: too many in a minute -> 429 (guessing is slow; a valid token never counts)
  const fails = new Map();
  const blocked = (ip) => { const f = (fails.get(ip) ?? []).filter((t) => now().getTime() - t < FAIL_WINDOW_MS); fails.set(ip, f); return f.length >= FAIL_LIMIT; };
  const failed = (ip) => { const f = fails.get(ip) ?? []; f.push(now().getTime()); fails.set(ip, f); };
  let shellCache = null;
  async function shellManifest() {
    if (shellCache) return shellCache;
    const walk = async (dir, prefix) => { const out = []; for (const e of await readdir(dir, { withFileTypes: true })) { if (e.isDirectory()) out.push(...await walk(join(dir, e.name), `${prefix}${e.name}/`)); else if (/\.js$/.test(e.name)) out.push(`${prefix}${e.name}`); } return out; };
    return (shellCache = { version: 1, files: [...new Set([...Object.keys(STATIC).filter((k) => k !== '/index.html'), ...(await walk(coreDir, '/core/'))])].sort() });
  }
  async function serveStatic(res, file, dir) {
    try { const data = await readFile(join(dir, file)); res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SEC }); res.end(data); }
    catch { json(res, 404, { error: 'NOT_FOUND' }); }
  }
  async function api(req, res, url) {
    const ip = clientIp(req);
    if (blocked(ip)) return json(res, 429, { error: 'TOO_MANY_ATTEMPTS' }, { 'retry-after': '60' });
    if (!sameToken(req.headers['x-sourcing-token'], token)) { failed(ip); return json(res, 401, { error: 'UNAUTHORIZED' }); }
    const p = url.pathname; const m = req.method;
    if (p === '/api/health' && m === 'GET') return json(res, 200, { ok: true, time: now().toISOString(), safetyGate: safety ? (await safety.get()).source : { mode: 'OFFLINE_VERIFICATION_REQUIRED', coverage: 'no Safety Gate adapter configured' } });
    if (p === '/api/cases' && m === 'GET') return json(res, 200, { cases: await store.list() });
    const c = /^\/api\/cases\/([A-Za-z0-9_-]{1,80})$/.exec(p);
    if (c && m === 'GET') { const s = await store.get(c[1]); return s ? json(res, 200, s) : json(res, 404, { error: 'NOT_FOUND' }); }
    if (c && m === 'PUT') { const body = await readBody(req); if (body.id !== c[1]) return json(res, 400, { error: 'ID_MISMATCH' }); try { return json(res, 200, await store.save(body)); } catch (e) { if (e instanceof StoreError && e.code === 'CONFLICT') return json(res, 409, { error: 'CONFLICT', server: e.server }); throw e; } }
    if (c && m === 'DELETE') return json(res, 200, { removed: await store.remove(c[1]) });
    if (p === '/api/safety/check' && m === 'POST') {
      const { identity } = await readBody(req); if (!identity) return json(res, 400, { error: 'IDENTITY_REQUIRED' });
      const { alerts, source } = safety ? await safety.get() : { alerts: null, source: { mode: 'OFFLINE_VERIFICATION_REQUIRED', fetchedAt: null } };
      return json(res, 200, matchSafetyGate({ identity, alerts, source }));
    }
    if (p === '/api/safety/alerts' && m === 'GET') { // the cache, compacted, so the phone can keep it and match offline (shown there as CACHED)
      const { alerts, source } = safety ? await safety.get() : { alerts: null, source: { mode: 'OFFLINE_VERIFICATION_REQUIRED', fetchedAt: null } };
      return json(res, 200, { source, alerts: alerts ? alerts.map(compactAlert) : null });
    }
    if (p === '/api/ai/status' && m === 'GET') return json(res, 200, { enabled: ai?.enabled === true, provider: ai?.enabled ? ai.name : null, region: ai?.enabled ? ai.region : null });
    if (p === '/api/safety/refresh' && m === 'POST') return safety ? json(res, 200, await safety.refresh({ maxReports: 26 })) : json(res, 503, { error: 'NO_SAFETY_ADAPTER' });
    if (p === '/api/documents/extract' && m === 'POST') {
      const b = await readBody(req); const buf = Buffer.from(String(b.dataBase64 ?? ''), 'base64'); const name = String(b.fileName ?? ''); const mime = String(b.mime ?? '');
      if (!buf.length) return json(res, 400, { error: 'EMPTY_FILE' });
      if (mime === 'application/pdf' || /\.pdf$/i.test(name)) { try { const r = await pdfToText(buf); return json(res, 200, { ...r, textSource: r.textChars >= 120 ? 'NATIVE' : null, note: r.textChars < 120 ? 'almost no text layer: this looks like a scan. a scanned PDF cannot be read here: photograph the page and use the photo path, or type what the paper says.' : null }); } catch { return json(res, 422, { error: 'PDF_UNREADABLE' }); } }
      if (mime.startsWith('text/') || /\.(txt|csv)$/i.test(name)) return json(res, 200, { text: buf.toString('utf8'), pages: null, pageCount: null, note: null });
      if (mime.startsWith('image/')) {
        if (!ai?.enabled) return json(res, 200, { text: null, textSource: null, note: 'image documents need an AI reader (none configured): the photo stays as evidence; type what the paper says (Docs > Type from the paper)' });
        // a supplier document is CONFIDENTIAL: it leaves this server only with the owner's explicit consent for THIS image
        if (b.consent !== true) return json(res, 428, { error: 'CONSENT_REQUIRED', provider: ai.name, region: ai.region, note: `this image would be sent to ${ai.name} (${ai.region}) to be read` });
        try {
          const r = await callProvider(ai, 'readDocument', { imageBase64: b.dataBase64, imageMime: mime, task: 'read document text' }, { dataClass: DATA_CLASS.CONFIDENTIAL }); const text = String(r.text ?? '');
          return json(res, 200, { text, textSource: 'OCR', provider: ai.name, status: r.status, note: r.status === 'OK' && text.replace(/\s/g, '').length >= 40 ? 'UNVERIFIED machine reading: check every field against the paper before confirming' : 'the image could not be read: type what the paper says' });
        } catch (e) { if (e instanceof ProviderPolicyError) return json(res, 403, { error: e.code }); throw e; }
      }
      return json(res, 200, { text: null, pages: null, note: 'unsupported file type' });
    }
    if (p === '/api/ai/describe' && m === 'POST') {
      if (!ai?.enabled) return json(res, 200, { status: 'DISABLED', suggestions: [], note: 'No AI provider configured: type a description, or choose the category yourself.' });
      const b = await readBody(req);
      if (b.consent !== true) return json(res, 428, { error: 'CONSENT_REQUIRED', provider: ai.name, region: ai.region, note: `this photo would be sent to ${ai.name} (${ai.region}) to be analysed` });
      try { return json(res, 200, await callProvider(ai, 'describe', { imageBase64: b.imageBase64, imageMime: b.imageMime, text: b.text, task: 'recognise product' }, { dataClass: DATA_CLASS.CONFIDENTIAL })); } catch (e) { if (e instanceof ProviderPolicyError) return json(res, 403, { error: e.code }); throw e; }
    }
    if (p === '/api/fx' && m === 'GET') { const cur = url.searchParams.get('currency') ?? 'USD'; if (!ecb) return json(res, 503, { error: 'NO_FX_SOURCE' }); try { const r = await ecb(); const fx = fxFor(cur, r); return fx ? json(res, 200, fx) : json(res, 404, { error: 'CURRENCY_UNKNOWN' }); } catch { return json(res, 503, { error: 'FX_UNAVAILABLE' }); } }
    return json(res, 404, { error: 'NOT_FOUND' });
  }
  const handler = async (req, res) => {
    try {
      if (!hostOk(req)) return json(res, 421, { error: 'HOST_NOT_ALLOWED' });
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/shell-manifest.json' && req.method === 'GET') return json(res, 200, await shellManifest(), { 'cache-control': 'no-cache' });
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (STATIC[url.pathname]) return await serveStatic(res, STATIC[url.pathname], uiDir);
      const core = CORE_FILE.exec(url.pathname); if (core) return await serveStatic(res, core[1], coreDir);
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (e) { const status = e.status ?? 500; json(res, status, { error: status === 500 ? 'INTERNAL' : String(e.message) }); if (status === 500) console.error('[sourcing]', e); }
  };
  return { handler };
}
