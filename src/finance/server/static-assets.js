// Finance static files: compression, validators and cache policy (Finance only; the shared Nordla reader is used as-is).
//
//   * text files (html/js/css/svg) are sent brotli- or gzip-compressed when the browser accepts it; compressed bodies are
//     computed once per file content (keyed by its hash) and kept in memory;
//   * every file carries a strong ETag (hash of its content) and a conditional request answers 304 without a body;
//   * index.html is served "no-cache" and references its scripts/styles with ?v=<content hash>: a request carrying the
//     CURRENT hash is cached for a year (immutable), so a repeat visit downloads nothing and a deploy that changes a file
//     changes its URL - no stale code after a release;
//   * anything else (fonts, icons, a stale ?v=) is "no-cache": always revalidated, answered 304 when unchanged.
// Files are read on every request exactly as before (no in-memory copy of the sources), so local edits show on reload.

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, constants as zc, gzip } from 'node:zlib';

const br = promisify(brotliCompress);
const gz = promisify(gzip);
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg\+xml)/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MAX_COMPRESSED = 200; // distinct (content, encoding) pairs kept; cleared when exceeded (only grows while files are edited locally)
const ASSET_REF = /(src|href)="(\/[A-Za-z0-9_./-]+\.(?:js|css))"/g;

const hashOf = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 20);

/** Preferred encoding the browser accepts: br, then gzip, else null. `q=0` means refused. */
export function pickEncoding(acceptEncoding) {
  const accepted = new Map(String(acceptEncoding ?? '').split(',').map((p) => { const [name, ...params] = p.trim().toLowerCase().split(';'); const q = params.map((s) => s.trim()).find((s) => s.startsWith('q=')); return [name, q ? Number(q.slice(2)) : 1]; }));
  const ok = (name) => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

/** True when an If-None-Match header names this content hash (any encoding suffix, weak or strong). */
function notModified(ifNoneMatch, hash) {
  if (!ifNoneMatch) return false;
  return String(ifNoneMatch).split(',').some((t) => t.trim().replace(/^W\//, '').replace(/"/g, '').split('-')[0] === hash);
}

/**
 * @param {{ resolve: (pathname: string) => Promise<{body: Buffer, type: string}|null> }} deps
 *   resolve: the module's existing file lookup (own UI files + shared Nordla files); returns null for anything else.
 */
export function createStaticAssets({ resolve }) {
  const compressed = new Map();
  async function encode(body, hash, enc) {
    const key = `${hash}:${enc}`;
    if (!compressed.has(key)) {
      if (compressed.size >= MAX_COMPRESSED) compressed.clear();
      // Brotli quality 5: ~20 ms for all Finance scripts vs ~950 ms at 11 (paid by the first visitor after each deploy), output only ~13% larger.
      compressed.set(key, enc === 'br' ? br(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 5, [zc.BROTLI_PARAM_SIZE_HINT]: body.length } }) : gz(body, { level: 6 }));
    }
    try { return await compressed.get(key); } catch (e) { compressed.delete(key); throw e; }
  }

  /** index.html with every local script/style reference versioned by the referenced file's content hash. */
  async function versionedIndex(html) {
    const text = html.toString('utf8');
    const refs = [...new Set([...text.matchAll(ASSET_REF)].map((m) => m[2]))];
    const hashes = new Map(await Promise.all(refs.map(async (p) => { const f = await resolve(p); return [p, f ? hashOf(f.body) : null]; })));
    return Buffer.from(text.replace(ASSET_REF, (all, attr, p) => (hashes.get(p) ? `${attr}="${p}?v=${hashes.get(p)}"` : all)), 'utf8');
  }

  /**
   * Answers a GET for a static file. Returns false (nothing sent) when the path is not a static file.
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url
   * @param {(res, status, body, extra) => void} send the module's own sender (keeps its security headers)
   */
  async function serve(req, res, url, send) {
    const file = await resolve(url.pathname);
    if (!file) return false;
    const body = url.pathname === '/' ? await versionedIndex(file.body) : file.body;
    const hash = hashOf(body);
    const cacheControl = url.pathname !== '/' && url.searchParams.get('v') === hashOf(file.body) ? IMMUTABLE : 'no-cache';
    const enc = COMPRESSIBLE.test(file.type) ? pickEncoding(req.headers['accept-encoding']) : null;
    const common = { 'Content-Type': file.type, 'Cache-Control': cacheControl, ETag: `"${hash}${enc ? `-${enc}` : ''}"`, ...(COMPRESSIBLE.test(file.type) ? { Vary: 'Accept-Encoding' } : {}) };
    if (notModified(req.headers['if-none-match'], hash)) { send(res, 304, '', common); return true; }
    if (!enc) { send(res, 200, body, common); return true; }
    send(res, 200, await encode(body, hash, enc), { ...common, 'Content-Encoding': enc });
    return true;
  }
  return { serve };
}
