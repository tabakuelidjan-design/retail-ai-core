// Analyses behind the Nordla gateway: a direct call without the shared proxy secret is refused before anything else; with it, the page answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';

const SECRET = 'proxy-secret-for-analyses-test-32chars';

async function boot() {
  const app = createAnalyticsPremiumApp({ reportsDir: null, guard: null, syncStatus: async () => null, reportStatus: () => ({}), ask: async () => null, proxySecret: SECRET, basePath: '/analyses/' });
  const srv = http.createServer((req, res) => app(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

test('a direct call to the Analyses service without the proxy secret is refused (403 PROXY_SECRET_REQUIRED)', async () => {
  const { srv, base } = await boot();
  try {
    const r = await fetch(`${base}/version`);
    assert.equal(r.status, 403); assert.equal((await r.json()).error.code, 'PROXY_SECRET_REQUIRED');
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 403);
  } finally { await new Promise((r) => srv.close(r)); }
});

test('through the gateway (secret present) the version route answers, and the page base is the module prefix', async () => {
  const { srv, base } = await boot();
  try {
    const v = await fetch(`${base}/version`, { headers: { 'x-nordla-proxy-secret': SECRET } });
    assert.equal(v.status, 200);
    const page = await fetch(`${base}/`, { headers: { 'x-nordla-proxy-secret': SECRET } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<base href="\/analyses\/">/);
  } finally { await new Promise((r) => srv.close(r)); }
});
