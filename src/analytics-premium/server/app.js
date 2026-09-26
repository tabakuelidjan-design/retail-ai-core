// Analytics Premium (Nordla) - Brief page only, Step 1. A plain node:http request handler, no
// framework, following the same "framework-free, static UI + small JSON API" convention as
// src/finance/server/app.js. Read-only: this page never writes anything, so there is no
// auth/session/CSRF layer here yet - it is a local preview server, not a deployed multi-tenant app.

import { readFile } from 'node:fs/promises';
import { loadBrief } from './brief.js';
import { loadWhatChanged } from './what-changed.js';
import { loadExplorer } from './explorer.js';
import { loadCustomers, loadCustomerDetail } from './customers.js';
import { loadProducts, loadProductDetail } from './products.js';
import { readNordlaShared } from '../../shared/nordla-static.js';
import { periodReport } from './period-engine.js';

const UI = new URL('../ui/', import.meta.url);
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/ask.js': ['ask.js', 'text/javascript; charset=utf-8'],
  '/speech.js': ['speech.js', 'text/javascript; charset=utf-8'],
  '/period.js': ['period.js', 'text/javascript; charset=utf-8'],
  '/explorer.js': ['explorer.js', 'text/javascript; charset=utf-8'],
  '/customers.js': ['customers.js', 'text/javascript; charset=utf-8'],
  '/customers.css': ['customers.css', 'text/css; charset=utf-8'],
  '/products.js': ['products.js', 'text/javascript; charset=utf-8'],
  '/products.css': ['products.css', 'text/css; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/nordla-tokens.css': ['nordla-tokens.css', 'text/css; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/assets/nordla-mic.png': ['assets/nordla-mic.png', 'image/png'],
  '/assets/nordla-mic@2x.png': ['assets/nordla-mic@2x.png', 'image/png'],
  '/account-menu.js': ['account-menu.js', 'text/javascript; charset=utf-8'],
  '/lang-fr.js': ['lang-fr.js', 'text/javascript; charset=utf-8'],
  '/lang-nl.js': ['lang-nl.js', 'text/javascript; charset=utf-8'],
  '/lang-en.js': ['lang-en.js', 'text/javascript; charset=utf-8'],
};

export function createAnalyticsPremiumApp({ reportsDir, guard, syncStatus, reportStatus, ask, now = () => new Date(), onDatasetMissing = null }) {
  /** Explorer / Produits / Clients accept ?period=<preset>|custom&from=&to=. With no period parameter the fixed-30-day report is served as before. */
  async function periodGiven(url) {
    const period = url.searchParams.get('period'); const from = url.searchParams.get('from'); const to = url.searchParams.get('to');
    if (!period && !from && !to) return { given: null };
    const r = await periodReport(reportsDir, { period: period || (from || to ? 'custom' : undefined), from, to }, { now: now() });
    // The dataset snapshot is a rebuildable cache: when a request finds it missing, a rebuild from the synchronised data is started (no manual step).
    if (!r.ok && r.code === 'DATASET_UNAVAILABLE' && onDatasetMissing) { try { onDatasetMissing(); } catch { /* the periodic check will rebuild it anyway */ } }
    // Right after a deploy the dataset snapshot may not exist yet: the default 30 days is still served from the generated report; other periods say so.
    if (!r.ok && r.code === 'DATASET_UNAVAILABLE' && (!period || period === 'last_30_days') && !from && !to) return { given: null };
    return r.ok ? { given: r.report } : { error: { status: r.status, code: r.code } };
  }
  return async function handle(req, res) {
    try {
      // Hosted staging: host allow-list + access token, before anything (pages, static files, api) is served.
      if (guard && !(await guard(req, res))) return;
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        const body = await readFile(new URL(file, UI));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(body);
        return;
      }
      if (req.method === 'GET') {
        const shared = await readNordlaShared(url.pathname);
        if (shared) { res.writeHead(200, { 'Content-Type': shared.type, 'Cache-Control': 'no-store' }); res.end(shared.body); return; }
      }
      if (req.method === 'POST' && url.pathname === '/api/ask') {
        // "Parle à Nordla": JSON only, same-origin only (the browser sends the access credentials automatically, so cross-site posts are refused).
        const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
        const origin = req.headers.origin;
        if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; } if (!ok) return json(403, { error: { code: 'ORIGIN_NOT_ALLOWED' } }); }
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: { code: 'JSON_REQUIRED' } });
        if (!ask) return json(503, { error: { code: 'ASSISTANT_NOT_AVAILABLE' } });
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 4096) return json(413, { error: { code: 'BODY_TOO_LARGE' } }); chunks.push(c); }
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: { code: 'INVALID_JSON' } }); }
        const sel = body?.period && typeof body.period === 'object' ? { period: String(body.period.period ?? '').slice(0, 30), from: typeof body.period.from === 'string' ? body.period.from.slice(0, 10) : undefined, to: typeof body.period.to === 'string' ? body.period.to.slice(0, 10) : undefined } : null;
        const r = await ask({ question: body?.question, lang: ['fr', 'nl', 'en'].includes(body?.lang) ? body.lang : 'fr', selected: sel, history: Array.isArray(body?.history) ? body.history.slice(-3).map((h) => ({ role: h?.role, text: typeof h?.text === 'string' ? h.text.slice(0, 300) : '' })) : [] });
        return json(r.status, r.body);
      }
      if (req.method === 'GET' && url.pathname === '/api/sync-status') {
        // Two separate facts, never mixed: the last Shopify -> Supabase SYNCHRONISATION, and the last REPORT generation from the synced data.
        let sync = { available: false, reason: 'NOT_CONFIGURED' };
        try { if (syncStatus) sync = await syncStatus(); } catch { sync = { available: false, reason: 'STATUS_UNAVAILABLE' }; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ sync, report: reportStatus ? reportStatus() : null }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/brief') {
        const brief = await loadBrief(reportsDir);
        if (!brief) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NO_REPORT_AVAILABLE' } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(brief));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/what-changed') {
        const data = await loadWhatChanged(reportsDir);
        if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NO_REPORT_AVAILABLE' } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/explorer') {
        const pg = await periodGiven(url); if (pg.error) { res.writeHead(pg.error.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: pg.error.code } })); return; }
        const data = await loadExplorer(reportsDir, pg.given);
        if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NO_REPORT_AVAILABLE' } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/customers') {
        const pg = await periodGiven(url); if (pg.error) { res.writeHead(pg.error.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: pg.error.code } })); return; }
        const data = await loadCustomers(reportsDir, pg.given);
        if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NO_REPORT_AVAILABLE' } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/customers/detail') {
        const pg = await periodGiven(url); if (pg.error) { res.writeHead(pg.error.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: pg.error.code } })); return; }
        const data = await loadCustomerDetail(reportsDir, url.searchParams.get('id'), pg.given);
        if (data.error) { res.writeHead(data.error === 'INVALID_CUSTOMER_ID' ? 400 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: data.error } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/products') {
        const pg = await periodGiven(url); if (pg.error) { res.writeHead(pg.error.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: pg.error.code } })); return; }
        const data = await loadProducts(reportsDir, pg.given);
        if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NO_REPORT_AVAILABLE' } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/products/detail') {
        const pg = await periodGiven(url); if (pg.error) { res.writeHead(pg.error.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: pg.error.code } })); return; }
        const data = await loadProductDetail(reportsDir, url.searchParams.get('id'), pg.given);
        if (data.error) { res.writeHead(data.error === 'INVALID_PRODUCT_ID' ? 400 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: data.error } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: String(e?.message ?? e) } }));
    }
  };
}
