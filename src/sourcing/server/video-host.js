// "Ajouter une vidéo" on the hosted Nordla server (staging), behind the SAME Nordla session as everything else.
//
// ISOLATION. Built only when NORDLA_VIDEO_DRAFTS_MODULE=1 (see server/index.js); without it no route below exists. Page /videos, files /video-assets/*, API /api/videos*.
// A failure here answers 5xx on those paths only. Nothing here talks to TikTok or Instagram: the video and the two captions are DRAFTS, no account is connected, nothing is published.
// RIGHTS. Reading and playing: any session of this merchant. Adding, editing, removing: OWNER or ADMIN only.
import { readFile } from 'node:fs/promises';
import { createVideoStore, VideoError, LIMITS, NETWORKS } from '../../video-drafts/videos.js';
import { readNordlaShared } from '../../shared/nordla-static.js';

const UI = new URL('../../video-drafts/ui/', import.meta.url);
const DS = new URL('../../creative-autonomy/creator/ui/ds/', import.meta.url);
const CSS = 'text/css; charset=utf-8'; const JS = 'text/javascript; charset=utf-8';
const ASSETS = Object.freeze({ 'video.js': [UI, 'video.js', JS], 'video.css': [UI, 'video.css', CSS], 'nordla-ds.css': [DS, 'nordla-ds.css', CSS], 'nordla-tokens.css': [DS, 'nordla-tokens.css', CSS] });
const HEADERS = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra }); res.end(body); };
const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
export const VIDEO_WRITERS = new Set(['OWNER', 'ADMIN']);
const readJson = async (req) => { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 20_000) throw new VideoError('BODY_TOO_LARGE', 413); chunks.push(c); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new VideoError('BODY_INVALID'); } };
const view = (r) => ({ id: r.id, title: r.title, filename: r.filename, size: r.size, sha256: r.sha256, state: r.state, stateLabel: 'Brouillon', createdAt: r.createdAt, createdBy: r.createdBy, captions: r.captions, fileUrl: `/api/videos/${r.id}/file?v=${r.sha256.slice(0, 12)}` });

export async function videosPage() {
  const html = await readFile(new URL('index.html', UI), 'utf8');
  return html.replace(/(href|src)="\/(nordla-ds\.css|nordla-tokens\.css|video\.css|video\.js|nordla-icon\.js)"/g, '$1="/video-assets/$2"');
}

/** @param {{ gate: object, merchantId: string, dataDir: string, now?: () => Date }} o */
export async function createVideoHost({ gate, merchantId, dataDir, now = () => new Date() }) {
  const store = createVideoStore({ dataDir, merchantId, now });
  const list = async () => ({ limits: { videoMaxBytes: LIMITS.VIDEO_MAX_BYTES, captionMax: LIMITS.CAPTION_MAX }, networks: NETWORKS, notice: 'Brouillons : aucune vidéo n’est publiée et aucun compte TikTok ou Instagram n’est connecté. Vous publiez vous-même depuis l’application.', videos: (await store.list()).map(view) });
  return Object.freeze({
    async handle(req, res, url) {
      const p = url.pathname;
      try {
        if (p === '/api/videos' || p.startsWith('/api/videos/')) {
          const a = await gate.authorize(req); if (!a.ok) { json(res, a.status, a.body); return true; }
          const access = a.access; if (access.merchantId !== merchantId) { json(res, 403, { error: { code: 'TENANT_MISMATCH' } }); return true; }
          const method = String(req.method ?? '').toUpperCase(); const writer = VIDEO_WRITERS.has(access.role);
          try {
            if (method === 'GET' && p === '/api/videos') { json(res, 200, await list()); return true; }
            const m = /^\/api\/videos\/(VID-[0-9a-f]{8})(\/file|\/remove)?$/.exec(p);
            if (method === 'GET' && m?.[2] === '/file') { // playback, with Range so the player can seek
              const r = await store.get(m[1]); if (!r) { json(res, 404, { error: { code: 'NOT_FOUND' } }); return true; }
              const f = await store.open(r.id); const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
              let start = 0; let end = f.size - 1; let status = 200;
              if (rg && (rg[1] || rg[2])) {
                if (rg[1] === '') start = Math.max(0, f.size - Number(rg[2])); else { start = Number(rg[1]); if (rg[2]) end = Math.min(end, Number(rg[2])); }
                if (start > end || start >= f.size) { res.writeHead(416, { ...HEADERS, 'Content-Range': `bytes */${f.size}` }); res.end(); return true; }
                status = 206;
              }
              res.writeHead(status, { ...HEADERS, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=3600', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${f.size}` } : {}) });
              f.stream(start, end).on('error', () => res.destroy()).pipe(res); return true;
            }
            if (method === 'POST' && p === '/api/videos') {
              if (!writer) { json(res, 403, { error: { code: 'FORBIDDEN_ROLE' } }); return true; }
              const len = Number(req.headers['content-length'] ?? 0); if (len > LIMITS.VIDEO_MAX_BYTES) { json(res, 413, { error: { code: 'VIDEO_TOO_LARGE' }, maxBytes: LIMITS.VIDEO_MAX_BYTES }); return true; }
              let filename = 'video.mp4'; let title = '';
              try { filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'video.mp4')); title = decodeURIComponent(String(req.headers['x-title'] ?? '')); } catch { /* keep the defaults */ }
              const r = await store.add({ stream: req, filename, title, by: access.userId }); json(res, 201, { video: view(r), ...(await list()) }); return true;
            }
            if (method === 'POST' && m && !m[2]) { // edit the title and/or the captions (POST: same CSRF path as the other modules)
              if (!writer) { json(res, 403, { error: { code: 'FORBIDDEN_ROLE' } }); return true; }
              const r = await store.update(m[1], await readJson(req), access.userId); json(res, 200, { video: view(r), ...(await list()) }); return true;
            }
            if (method === 'POST' && m?.[2] === '/remove') {
              if (!writer) { json(res, 403, { error: { code: 'FORBIDDEN_ROLE' } }); return true; }
              await store.remove(m[1]); json(res, 200, await list()); return true;
            }
          } catch (e) { if (e instanceof VideoError) { json(res, e.status, { error: { code: e.code } }); return true; } throw e; }
          json(res, 404, { error: { code: 'NOT_FOUND' } }); return true;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return false;
        if (p === '/videos' || p === '/videos/') { send(res, 200, 'text/html; charset=utf-8', await videosPage()); return true; }
        const m = /^\/video-assets\/([a-z0-9.-]+)$/.exec(p);
        if (m) {
          if (m[1] === 'nordla-icon.js') { const f = await readNordlaShared('/nordla-icon.js'); if (!f) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; } send(res, 200, f.type, f.body); return true; }
          const a = ASSETS[m[1]]; if (!a) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; }
          send(res, 200, a[2], await readFile(new URL(a[1], a[0]))); return true;
        }
        return false;
      } catch { if (!res.headersSent) json(res, 500, { error: { code: 'VIDEOS_UNAVAILABLE' } }); return true; }
    },
  });
}
