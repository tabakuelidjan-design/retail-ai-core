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

const UI = new URL('../ui/', import.meta.url);
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/explorer.js': ['explorer.js', 'text/javascript; charset=utf-8'],
  '/customers.js': ['customers.js', 'text/javascript; charset=utf-8'],
  '/customers.css': ['customers.css', 'text/css; charset=utf-8'],
  '/products.js': ['products.js', 'text/javascript; charset=utf-8'],
  '/products.css': ['products.css', 'text/css; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/nordla-tokens.css': ['nordla-tokens.css', 'text/css; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/account-menu.js': ['account-menu.js', 'text/javascript; charset=utf-8'],
  '/lang-fr.js': ['lang-fr.js', 'text/javascript; charset=utf-8'],
  '/lang-nl.js': ['lang-nl.js', 'text/javascript; charset=utf-8'],
  '/lang-en.js': ['lang-en.js', 'text/javascript; charset=utf-8'],
};

export function createAnalyticsPremiumApp({ reportsDir, guard, syncStatus, reportStatus }) {
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
        const data = await loadExplorer(reportsDir);
        if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NO_REPORT_AVAILABLE' } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/customers') {
        const data = await loadCustomers(reportsDir);
        if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NO_REPORT_AVAILABLE' } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/customers/detail') {
        const data = await loadCustomerDetail(reportsDir, url.searchParams.get('id'));
        if (data.error) { res.writeHead(data.error === 'INVALID_CUSTOMER_ID' ? 400 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: data.error } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/products') {
        const data = await loadProducts(reportsDir);
        if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NO_REPORT_AVAILABLE' } })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/products/detail') {
        const data = await loadProductDetail(reportsDir, url.searchParams.get('id'));
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
