// Nordla Growth - Growth Overview (step 1). A plain node:http request handler, no framework, same
// "framework-free, static UI + small JSON API" convention as src/analytics-premium/server/app.js.
//
// Isolation: this module only READS files from the shared design system (src/shared via readNordlaShared)
// and the Analytics Premium stylesheet + typography tokens + i18n runtime, which it serves as-is so Growth
// uses exactly the same cards, tabs, KPI tiles, tables and rail instead of a copy. It never writes to them,
// imports no Analytics/Finance server code, and neither of those modules depends on anything here.
//
// Data (owner decision 2026-09-28: real data or honest states only, no demonstration data):
//   Opportunités = the priorities aggregated from the four real engines (server/priorities.js), recomputed on every request;
//   Vue d'ensemble = the real store sales + the same priorities + explicit "source non connectée" states (server/overview.js);
//   Produits Potentiels / Audience / Contenu / Croissance magasin read the tenant's real synced data.
// Campagnes is not part of this version (no advertising connector): no page, no script, no endpoint.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readNordlaShared } from '../../shared/nordla-static.js';
import { buildOverview } from './overview.js';
import { createPrioritiesSource } from './priorities.js';

const UI = new URL('../ui/', import.meta.url);
// Reused as-is from Analytics Premium (same design system; see header note).
const ANALYTICS_UI = new URL('../../analytics-premium/ui/', import.meta.url);
const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const STATIC = {
  '/': [UI, 'index.html', 'text/html; charset=utf-8'],
  '/app.js': [UI, 'app.js', JS],
  '/persist.js': [UI, 'persist.js', JS],
  '/guide.js': [UI, 'guide.js', JS],
  '/pipeline.js': [UI, 'pipeline.js', JS],
  '/inbox.js': [UI, 'inbox.js', JS],
  '/opportunities.js': [UI, 'opportunities.js', JS],
  '/potential.js': [UI, 'potential.js', JS],
  '/audience.js': [UI, 'audience.js', JS],
  '/content.js': [UI, 'content.js', JS],
  '/store.js': [UI, 'store.js', JS],
  '/dropoff.js': [UI, 'dropoff.js', JS],
  '/growth.css': [UI, 'growth.css', CSS],
  '/lang-fr.js': [UI, 'lang-fr.js', JS],
  '/lang-nl.js': [UI, 'lang-nl.js', JS],
  '/lang-en.js': [UI, 'lang-en.js', JS],
  '/style.css': [UI, 'style.css', CSS],
  '/i18n.js': [ANALYTICS_UI, 'i18n.js', JS],
};

// Same-origin only; images/fonts/scripts/styles are all served by this server. Inline style *attributes* are
// never used by the UI (styles are set through the CSSOM), so no 'unsafe-inline' is needed.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://cdn.shopify.com; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// Growth's own assets: Growth icons (src/growth/ui/assets/icons/) and channel logo
// files (src/growth/ui/assets/channels/). Plain file names only, no traversal.
const GROWTH_ASSETS = new URL('../ui/assets/', import.meta.url);
const GROWTH_ASSET = /^\/growth-assets\/(icons|channels)\/([a-z0-9-]+\.(svg|png|webp))$/;
const IMG = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' };

// productPotential: the tenant's Potentiel produits source (server/products.js), created from the Growth server's context
// (NORDLA_MERCHANT_ID). Nothing in a request can choose or change the merchant: the route reads no parameter at all.
// audience / content / store: the tenant's Audience, Contenu and Croissance magasin sources (server/*.js), same contract.
export function createGrowthApp({ now = () => new Date(), generalContext = null, productPotential = null, audience = null, content = null, store = null, merchantId = null, review = null, corrections = null, ads = null, site = null, siteReview = null, social = null, socialReview = null, inbox = null, inboxReview = null, dropoff = null, guide = null, hosted = false } = {}) {
  const historyScope = merchantId ? createHash('sha256').update(String(merchantId)).digest('hex') : null;
  const priorities = createPrioritiesSource({ productPotential, audience, content, store, ads, site, social, inbox, general: generalContext, now });
  const send = (res, status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(body); };
  const json = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));
  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      // HOSTED (hosted.js): the sign-in and server-side follow-up script is in the page and served only then
      if (hosted && url.pathname === '/session.js') return send(res, 200, JS, await readFile(new URL('session.js', UI)));
      if (STATIC[url.pathname]) {
        const [base, file, type] = STATIC[url.pathname];
        const body = await readFile(new URL(file, base));
        return send(res, 200, type, hosted && url.pathname === '/' ? String(body).replace(/<script src="\/?app\.js"><\/script>/, '<script src="session.js"></script>\n<script src="app.js"></script>') : body);
      }
      const shared = await readNordlaShared(url.pathname);
      if (shared) return send(res, 200, shared.type, shared.body);
      const asset = GROWTH_ASSET.exec(url.pathname);
      if (asset) { try { return send(res, 200, IMG[asset[3]], await readFile(new URL(`${asset[1]}/${asset[2]}`, GROWTH_ASSETS))); } catch { return json(res, 404, { error: { code: 'NOT_FOUND' } }); } }
      if (url.pathname === '/api/growth/overview') {
        // Real figures only: Croissance magasin's store sales and the Opportunités priorities; each is null when unavailable.
        let st = null; let pr = null;
        if (store) { try { st = await store(); } catch (e) { console.error('growth overview store failed:', e?.message ?? e); } }
        if (priorities) { try { pr = await priorities(); } catch (e) { console.error('growth overview priorities failed:', e?.message ?? e); } }
        return json(res, 200, buildOverview({ now: now(), store: st, priorities: pr }));
      }
      if (url.pathname === '/api/growth/opportunities') {
        if (!priorities) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } });
        try { return json(res, 200, { ...await priorities(), ...(historyScope && { historyScope }), ...(guide && { guide }) }); } catch (e) { console.error('growth opportunities failed:', e?.message ?? e); return json(res, 503, { error: { code: 'DATA_UNAVAILABLE' } }); }
      }
      if (url.pathname === '/api/growth/products') {
        if (!productPotential) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } });
        try { return json(res, 200, await productPotential()); } catch (e) { console.error('growth products failed:', e?.message ?? e); return json(res, 503, { error: { code: 'DATA_UNAVAILABLE' } }); }
      }
      if (url.pathname === '/api/growth/audience') {
        if (!audience) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } });
        try { return json(res, 200, await audience()); } catch (e) { console.error('growth audience failed:', e?.message ?? e); return json(res, 503, { error: { code: 'DATA_UNAVAILABLE' } }); }
      }
      if (url.pathname === '/api/growth/content') {
        if (!content) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } });
        try { return json(res, 200, await content()); } catch (e) { console.error('growth content failed:', e?.message ?? e); return json(res, 503, { error: { code: 'DATA_UNAVAILABLE' } }); }
      }
      if (url.pathname === '/api/growth/corrections') {
        // The "dossier de correction": a Markdown download built from what was already read. READ ONLY, merchant = server context (no merchant parameter).
        if (!corrections) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } });
        const category = url.searchParams.get('category') ?? 'all';
        try {
          const f = await corrections({ category });
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
          return res.end(f.markdown);
        } catch (e) {
          if (e?.code === 'BAD_CATEGORY') return json(res, 400, { error: { code: 'BAD_REQUEST' } });
          console.error('growth corrections failed:', e?.message ?? e); return json(res, 503, { error: { code: 'DATA_UNAVAILABLE' } });
        }
      }
      if (url.pathname === '/api/growth/review') {
        // Before / after net units of an applied product or variant action. The merchant is the server's context: the route accepts no merchant parameter.
        if (!review && !['page', 'post', 'inbox'].includes(url.searchParams.get('type'))) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } });
        const q = Object.fromEntries(url.searchParams);
        const date = /^\d{4}-\d{2}-\d{2}$/;
        if (!['product', 'variant', 'page', 'post', 'inbox'].includes(q.type) || !q.id || q.id.length > 200 || !date.test(q.applied ?? '') || !date.test(q.review ?? '')) return json(res, 400, { error: { code: 'BAD_REQUEST' } });
        try { if (q.type === 'inbox') { if (!inboxReview) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } }); if (!['instagram', 'tiktok'].includes(q.network) || !q.account || q.account.length > 200 || !/^\d{1,3}$/.test(q.days ?? '') || !date.test(q.from ?? '') || (q.qualified ?? '').length > 4000 || (q.notQualified ?? '').length > 4000 || (q.declared ?? '').length > 4000) return json(res, 400, { error: { code: 'BAD_REQUEST' } }); return json(res, 200, await inboxReview({ id: q.id, network: q.network, account: q.account, days: q.days, from: q.from, type: q.type2 ?? q.requestType, qualified: q.qualified, notQualified: q.notQualified, declared: q.declared })); } if (q.type === 'post') { if (!socialReview) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } }); if (!['instagram', 'tiktok'].includes(q.network) || !q.account || q.account.length > 200 || !/^\d{1,3}$/.test(q.days ?? '')) return json(res, 400, { error: { code: 'BAD_REQUEST' } }); return json(res, 200, await socialReview({ id: q.id, network: q.network, account: q.account, days: q.days })); } if (q.type === 'page') { if (!siteReview) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } }); return json(res, 200, await siteReview({ id: q.id, applied: q.applied, review: q.review })); } return json(res, 200, await review({ type: q.type, id: q.id, applied: q.applied, review: q.review })); } catch (e) { console.error('growth review failed:', e?.message ?? e); return json(res, 503, { error: { code: 'DATA_UNAVAILABLE' } }); }
      }
      if (url.pathname === '/api/growth/dropoff') {
        if (!dropoff) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } });
        try { return json(res, 200, await dropoff()); } catch (e) { console.error('growth dropoff failed:', e?.message ?? e); return json(res, 503, { error: { code: 'DATA_UNAVAILABLE' } }); }
      }
      if (url.pathname === '/api/growth/store') {
        if (!store) return json(res, 503, { error: { code: 'TENANT_NOT_CONFIGURED' } });
        try { return json(res, 200, await store()); } catch (e) { console.error('growth store failed:', e?.message ?? e); return json(res, 503, { error: { code: 'DATA_UNAVAILABLE' } }); }
      }
      return json(res, 404, { error: { code: 'NOT_FOUND' } });
    } catch (e) {
      return json(res, 500, { error: { code: 'INTERNAL_ERROR' } });
    }
  };
}
