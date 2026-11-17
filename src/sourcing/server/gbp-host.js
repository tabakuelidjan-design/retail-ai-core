// The Google Business Profile post drafts on the hosted Nordla server (staging), behind the SAME Nordla session as everything else.
//
// ISOLATION. Built only when NORDLA_GBP_DRAFTS_MODULE=1 (see server/index.js); without it no route below exists. Page /gbp, files /gbp-assets/*, API /api/gbp/*. A failure here answers
// 5xx on those paths only. Nothing here talks to Google: the owner reads each draft (text, image, button), approves ONE version, copies it into his listing himself, and attests it.
// "Publier" from Nordla does not exist while Google has not granted API access (case 8-1074000042712): the screen says so instead of pretending.
// RIGHTS. Reading: any session of this merchant. Approving, withdrawing an approval, attesting a publication: OWNER or ADMIN only (a read-only role is refused with FORBIDDEN_ROLE).
import { readFile } from 'node:fs/promises';
import { loadDrafts, createDraftStore, stateOf, STATE, STATE_FR } from '../../gbp-drafts/drafts.js';
import { readNordlaShared } from '../../shared/nordla-static.js';

const UI = new URL('../../gbp-drafts/ui/', import.meta.url);
const DS = new URL('../../creative-autonomy/creator/ui/ds/', import.meta.url);
const DRAFTS_DIR = new URL('../../../config/gbp-drafts/habb/', import.meta.url);
const CSS = 'text/css; charset=utf-8'; const JS = 'text/javascript; charset=utf-8';
const ASSETS = Object.freeze({ 'gbp.js': [UI, 'gbp.js', JS], 'gbp.css': [UI, 'gbp.css', CSS], 'nordla-ds.css': [DS, 'nordla-ds.css', CSS], 'nordla-tokens.css': [DS, 'nordla-tokens.css', CSS] });
const HEADERS = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra }); res.end(body); };
const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
export const GBP_WRITERS = new Set(['OWNER', 'ADMIN']);
export const GOOGLE_CASE = '8-1074000042712';
const readBody = async (req) => { const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 10_000) throw Object.assign(new Error('too large'), { code: 'BODY_TOO_LARGE' }); chunks.push(c); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad json'), { code: 'BODY_INVALID' }); } };

export async function gbpPage() {
  const html = await readFile(new URL('index.html', UI), 'utf8');
  return html.replace(/(href|src)="\/(nordla-ds\.css|nordla-tokens\.css|gbp\.css|gbp\.js|nordla-icon\.js)"/g, '$1="/gbp-assets/$2"');
}

/** @param {{ gate: object, merchantId: string, dataDir: string, draftsDir?: URL, now?: () => Date }} o */
export async function createGbpHost({ gate, merchantId, dataDir, draftsDir = DRAFTS_DIR, now = () => new Date() }) {
  const content = await loadDrafts({ dir: draftsDir }); // fails at build time (the module is then not built), never per request
  const store = createDraftStore({ dataDir, merchantId });
  const view = async () => {
    const events = await store.list();
    return {
      network: content.network, listing: content.listing,
      publish: { available: false, reason: 'GOOGLE_API_ACCESS_NOT_GRANTED', case: GOOGLE_CASE, message: `Nordla ne peut pas publier sur Google tant que Google n'a pas accordé l'accès à l'API (dossier ${GOOGLE_CASE}). Copiez le texte, enregistrez l'image, publiez dans votre fiche, puis cliquez « J'ai publié ».` },
      drafts: content.drafts.map((d) => { const s = stateOf(events, d); return { id: d.id, title: d.title, kind: d.kind, text: d.text, cta: d.cta, imageUrl: `/api/gbp/drafts/${d.id}/image?v=${d.imageSha.slice(0, 12)}`, imageNote: d.image_note, checks: d.checks, version: d.version, state: s.state, stateLabel: STATE_FR[s.state], approvedAt: s.approvedAt ?? null, approvedBy: s.approvedBy ?? null, publishedAt: s.publishedAt ?? null, publishedUrl: s.publishedUrl ?? null }; }),
    };
  };
  return Object.freeze({
    async handle(req, res, url) {
      const p = url.pathname;
      try {
        if (p.startsWith('/api/gbp/')) {
          const a = await gate.authorize(req); if (!a.ok) { json(res, a.status, a.body); return true; }
          const access = a.access; if (access.merchantId !== merchantId) { json(res, 403, { error: { code: 'TENANT_MISMATCH' } }); return true; }
          const method = String(req.method ?? '').toUpperCase();
          if (method === 'GET' && p === '/api/gbp/drafts') { json(res, 200, await view()); return true; }
          const img = /^\/api\/gbp\/drafts\/(GBP-POST-\d{1,3})\/image$/.exec(p);
          if (method === 'GET' && img) { const d = content.drafts.find((x) => x.id === img[1]); if (!d) { json(res, 404, { error: { code: 'NOT_FOUND' } }); return true; } send(res, 200, 'image/jpeg', d.imageBytes, { 'Cache-Control': 'private, max-age=3600' }); return true; }
          const act = /^\/api\/gbp\/drafts\/(GBP-POST-\d{1,3})\/(approve|revoke|published)$/.exec(p);
          if (method === 'POST' && act) {
            if (!GBP_WRITERS.has(access.role)) { json(res, 403, { error: { code: 'FORBIDDEN_ROLE' } }); return true; }
            const d = content.drafts.find((x) => x.id === act[1]); if (!d) { json(res, 404, { error: { code: 'NOT_FOUND' } }); return true; }
            let body; try { body = await readBody(req); } catch (e) { json(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: { code: e.code ?? 'BODY_INVALID' } }); return true; }
            const events = await store.list(); const cur = stateOf(events, d); const kind = act[2];
            if (kind === 'approve') {
              if (body.expected_version !== d.version) { json(res, 409, { error: { code: 'VERSION_CHANGED' }, current: d.version }); return true; } // the screen the owner read is not the current version
              if (cur.state !== STATE.REVIEW) { json(res, 409, { error: { code: 'ALREADY_APPROVED' } }); return true; }
              await store.append({ type: 'approve', draft: d.id, version: d.version, by: access.userId, role: access.role, at: now().toISOString() });
            } else if (kind === 'revoke') {
              if (cur.state === STATE.REVIEW) { json(res, 409, { error: { code: 'NOT_APPROVED' } }); return true; }
              await store.append({ type: 'revoke', draft: d.id, version: d.version, by: access.userId, role: access.role, at: now().toISOString() });
            } else {
              if (cur.state !== STATE.APPROVED) { json(res, cur.state === STATE.PUBLISHED ? 409 : 409, { error: { code: cur.state === STATE.PUBLISHED ? 'ALREADY_PUBLISHED' : 'NOT_APPROVED' } }); return true; } // only an APPROVED version can be attested as published
              const link = typeof body.url === 'string' ? body.url.trim().slice(0, 300) : '';
              if (link && !/^https:\/\/[^\s]+$/.test(link)) { json(res, 400, { error: { code: 'URL_INVALID' } }); return true; }
              await store.append({ type: 'published', draft: d.id, version: d.version, by: access.userId, role: access.role, at: now().toISOString(), ...(link ? { url: link } : {}) });
            }
            json(res, 200, await view()); return true;
          }
          json(res, 404, { error: { code: 'NOT_FOUND' } }); return true;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return false;
        if (p === '/gbp' || p === '/gbp/') { send(res, 200, 'text/html; charset=utf-8', await gbpPage()); return true; }
        const m = /^\/gbp-assets\/([a-z0-9.-]+)$/.exec(p);
        if (m) {
          if (m[1] === 'nordla-icon.js') { const f = await readNordlaShared('/nordla-icon.js'); if (!f) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; } send(res, 200, f.type, f.body); return true; }
          const a = ASSETS[m[1]]; if (!a) { send(res, 404, 'application/json', '{"error":"NOT_FOUND"}'); return true; }
          send(res, 200, a[2], await readFile(new URL(a[1], a[0]))); return true;
        }
        if (p.startsWith('/nordla-assets/')) { const f = await readNordlaShared(p); if (!f) return false; send(res, 200, f.type, f.body); return true; } // fonts + brand marks (static, no data); another module may serve the same files
        return false;
      } catch { if (!res.headersSent) json(res, 500, { error: { code: 'GBP_UNAVAILABLE' } }); return true; }
    },
  });
}
