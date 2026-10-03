// HTTP app for China Sourcing field mode. The decision logic lives in src/sourcing/core and runs IN THE BROWSER too (offline): this server only adds what a phone cannot do
// alone - cases kept on disk, the Safety Gate cache, PDF text, optional ECB rates and an optional AI provider. Every /api route needs the token.
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { join, extname } from 'node:path';
import { matchSafetyGate } from '../core/safety.js';
import { pdfToText } from '../adapters/pdf.js';
import { fxFor } from '../adapters/fx.js';
import { callProvider, DATA_CLASS, ProviderPolicyError } from '../adapters/ai-provider.js';
import { StoreError } from '../store/file-store.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const MAX_BODY = 16 * 1024 * 1024;
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/app.css': 'app.css', '/sw.js': 'sw.js', '/manifest.webmanifest': 'manifest.webmanifest', '/icon.svg': 'icon.svg' };
const CORE_FILE = /^\/core\/((?:rulebook\/)?[a-z0-9-]+\.js)$/;

const sameToken = (a, b) => { const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8'); if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

export function createSourcingApp({ token, store, safety = null, ecb = null, ai = null, uiDir, coreDir, now = () => new Date() }) {
  if (!token || String(token).length < 24) throw new Error('a token of at least 24 characters is required');
  async function serveStatic(res, file, dir) {
    try { const data = await readFile(join(dir, file)); res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(data); }
    catch { json(res, 404, { error: 'NOT_FOUND' }); }
  }
  async function api(req, res, url) {
    if (!sameToken(req.headers['x-sourcing-token'], token)) return json(res, 401, { error: 'UNAUTHORIZED' });
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
    if (p === '/api/safety/refresh' && m === 'POST') return safety ? json(res, 200, await safety.refresh({ maxReports: 12 })) : json(res, 503, { error: 'NO_SAFETY_ADAPTER' });
    if (p === '/api/documents/extract' && m === 'POST') {
      const b = await readBody(req); const buf = Buffer.from(String(b.dataBase64 ?? ''), 'base64'); const name = String(b.fileName ?? ''); const mime = String(b.mime ?? '');
      if (!buf.length) return json(res, 400, { error: 'EMPTY_FILE' });
      if (mime === 'application/pdf' || /\.pdf$/i.test(name)) { try { const r = await pdfToText(buf); return json(res, 200, { ...r, note: r.textChars < 120 ? 'almost no text layer: this looks like a scan. Nordla does no OCR; the document cannot be assessed (INSUFFICIENT_EVIDENCE) unless you paste its text.' : null }); } catch { return json(res, 422, { error: 'PDF_UNREADABLE' }); } }
      if (mime.startsWith('text/') || /\.(txt|csv)$/i.test(name)) return json(res, 200, { text: buf.toString('utf8'), pages: null, pageCount: null, note: null });
      if (mime.startsWith('image/') && ai?.enabled) { try { const r = await callProvider(ai, 'readLabel', { imageBase64: b.dataBase64, imageMime: mime, task: 'read document text' }, { dataClass: DATA_CLASS.CONFIDENTIAL }); return json(res, 200, { text: r.text ?? '', pages: null, note: 'text read by an AI provider: it can contain errors, check it against the photo' }); } catch (e) { if (e instanceof ProviderPolicyError) return json(res, 403, { error: e.code }); throw e; } }
      return json(res, 200, { text: null, pages: null, note: mime.startsWith('image/') ? 'image documents need an AI reader (none configured) or typed text: Nordla does no OCR' : 'unsupported file type' });
    }
    if (p === '/api/ai/describe' && m === 'POST') {
      if (!ai?.enabled) return json(res, 200, { status: 'DISABLED', suggestions: [], note: 'No AI provider configured: type a description, or choose the category yourself.' });
      const b = await readBody(req); try { return json(res, 200, await callProvider(ai, 'describe', { imageBase64: b.imageBase64, imageMime: b.imageMime, text: b.text, task: 'recognise product' }, { dataClass: DATA_CLASS.CONFIDENTIAL })); } catch (e) { if (e instanceof ProviderPolicyError) return json(res, 403, { error: e.code }); throw e; }
    }
    if (p === '/api/fx' && m === 'GET') { const cur = url.searchParams.get('currency') ?? 'USD'; if (!ecb) return json(res, 503, { error: 'NO_FX_SOURCE' }); try { const r = await ecb(); const fx = fxFor(cur, r); return fx ? json(res, 200, fx) : json(res, 404, { error: 'CURRENCY_UNKNOWN' }); } catch { return json(res, 503, { error: 'FX_UNAVAILABLE' }); } }
    return json(res, 404, { error: 'NOT_FOUND' });
  }
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (STATIC[url.pathname]) return await serveStatic(res, STATIC[url.pathname], uiDir);
      const core = CORE_FILE.exec(url.pathname); if (core) return await serveStatic(res, core[1], coreDir);
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (e) { const status = e.status ?? 500; json(res, status, { error: status === 500 ? 'INTERNAL' : String(e.message) }); if (status === 500) console.error('[sourcing]', e); }
  };
  return { handler };
}
