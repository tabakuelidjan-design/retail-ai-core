// Finance page in its two real modes, checked on the URLs the BROWSER would request (resolved against the page's <base>):
//   A. standalone: the page is served at /, every script and style resolves to /<file>, and each one is served;
//   B. behind the Nordla Core gateway: the page is served at /finance/, every script and style resolves to /finance/<file>,
//      and each request goes through Core to the Finance service with the prefix removed (the file it gets is the same).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { startApp } from './finance-dashboard-helpers.js';
import { createGateway } from '../src/shared/nordla-gateway.js';

const SECRET = 'synthetic-proxy-secret-0123456789';

/** Raw GET of an absolute URL (no redirects followed, nothing decoded). */
function fetchRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); }).on('error', reject);
  });
}

/** The URLs a browser would request for the page's scripts and styles: resolved against the page URL and the <base> it declares. */
function requestedAssets(html, pageUrl) {
  const base = /<base href="([^"]*)">/.exec(html);
  const baseUrl = base ? new URL(base[1], pageUrl).href : pageUrl;
  const refs = [...html.matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/g)].map((m) => m[1]);
  return { baseHref: base ? base[1] : null, urls: refs.map((r) => new URL(r, baseUrl)) };
}

const sourceOf = async (name) => readFile(new URL(`../src/finance/ui/${name}`, import.meta.url));

test('A. standalone: the page is served at /, its <base> is /, and every script and style resolves to /<file> and is served', async () => {
  const h = await startApp();
  try {
    const page = await fetchRaw(`${h.base}/`);
    assert.equal(page.status, 200);
    const html = page.body.toString('utf8');
    const { baseHref, urls } = requestedAssets(html, `${h.base}/`);
    assert.equal(baseHref, '/', 'standalone base is the root');
    assert.ok(urls.length >= 10, `found ${urls.length} assets`);
    for (const u of urls) {
      assert.equal(u.origin, h.base, `${u.href} stays on the Finance origin`);
      assert.ok(u.pathname.match(/^\/[A-Za-z0-9_.-]+\.(js|css)$/), `no sub-path in standalone: ${u.pathname}`);
    }
    const app = urls.find((u) => u.pathname === '/app.js');
    assert.ok(app, 'app.js is requested at the root');
    const got = await fetchRaw(app.href, { 'accept-encoding': 'identity' });
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, await sourceOf('app.js'), 'the file served is the Finance app.js');
  } finally { await h.server.close(); }
});

test('B. behind the Core gateway: the page is served at /finance/, its <base> is /finance/, and every asset is requested under /finance/ and reaches Finance without the prefix', async () => {
  const fin = await startApp({ deps: { proxySecret: SECRET } });
  const forwarded = [];
  // Core's origin: the gateway forwards /finance/* to the Finance service (with the proxy secret) and answers nothing else here.
  let gateway;
  const core = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://core.test');
    forwarded.push(url.pathname);
    gateway(req, res, url).then((handled) => { if (!handled) { res.writeHead(404); res.end('core'); } });
  });
  await new Promise((r) => core.listen(0, '127.0.0.1', r));
  const coreBase = `http://127.0.0.1:${core.address().port}`;
  gateway = createGateway({
    publicOrigin: coreBase,
    services: { finance: { enabled: true, upstream: fin.base, secret: SECRET } },
    authorize: async () => ({ ok: true }),
  });
  try {
    const page = await fetchRaw(`${coreBase}/finance/`);
    assert.equal(page.status, 200, 'the page answers under /finance/');
    const html = page.body.toString('utf8');
    const { baseHref, urls } = requestedAssets(html, `${coreBase}/finance/`);
    assert.equal(baseHref, '/finance/', 'the base is the module prefix');
    assert.ok(urls.length >= 10);
    for (const u of urls) assert.ok(u.pathname.startsWith('/finance/'), `asset requested under /finance/: ${u.pathname}`);
    const app = urls.find((u) => u.pathname.startsWith('/finance/app.js'));
    assert.ok(app, 'app.js is requested under /finance/');
    const before = forwarded.length;
    const got = await fetchRaw(app.href, { 'accept-encoding': 'identity' });
    assert.equal(got.status, 200, 'the gateway serves it');
    assert.deepEqual(got.body, await sourceOf('app.js'), 'Finance returns its own app.js through the gateway');
    assert.equal(forwarded[before], '/finance/app.js', 'Core received the prefixed address');
  } finally { core.close(); await fin.server.close(); }
});

test('B. behind the gateway: a direct call to the Finance service without the proxy secret is refused', async () => {
  const fin = await startApp({ deps: { proxySecret: SECRET } });
  try {
    const r = await fetchRaw(`${fin.base}/app.js`);
    assert.equal(r.status, 403, 'the service refuses a call that did not come through Core');
  } finally { await fin.server.close(); }
});
