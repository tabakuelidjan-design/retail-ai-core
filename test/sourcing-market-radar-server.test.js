// Market radar HTTP route (real China Sourcing server, SIMULATED provider). Split out of market-radar.test.js: starting the Sourcing server requires Node 24
// (src/sourcing/runtime.js), and the file name `sourcing-*` makes the Node 20 matrix of nordla-integration-pre-china skip it by its existing rule.
// The test body below is moved unchanged from market-radar.test.js; the helpers are the same definitions it used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketRadar } from '../src/sourcing/server/market-radar-service.js';
import { startSourcingServer } from '../src/sourcing/server/index.js';

const SECRET = 'S3cr3t-Pa55word-XYZ'; const LOGIN = 'owner@example.com';
const ENV = { DATAFORSEO_LOGIN: LOGIN, DATAFORSEO_PASSWORD: SECRET };
const ECB = { date: '2026-10-19', perEur: { USD: 1.1, CNY: 7.8 } };
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const items = (...rows) => rows.map((r) => ({ type: 'google_shopping_serp', ...r }));
function fakeProvider({ balance = 1, listings = null, taskStatus = 20000, postHttp = 200, locHttp = 200, onCall = () => {}, hang = false } = {}) {
  const calls = []; let n = 0;
  const f = async (url, opt = {}) => {
    calls.push(url); onCall(url, opt);
    if (url.endsWith('/appendix/user_data')) return balance === null ? json({}, 500) : json({ tasks: [{ result: [{ money: { balance } }] }] });
    if (url.endsWith('/locations')) return locHttp !== 200 ? json({}, locHttp) : json({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] });
    if (url.endsWith('/products/task_post')) return postHttp !== 200 ? json({}, postHttp) : json({ tasks: [{ id: `t${++n}`, status_code: 20100, cost: 0.002 }] });
    if (url.includes('/task_get/advanced/')) return hang ? json({ tasks: [{ status_code: 40602, status_message: 'Task In Queue.' }] }) : json({ tasks: [{ status_code: taskStatus, result: [{ datetime: '2026-10-19 15:02:34 +00:00', items: listings ?? items(
      { title: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L', price: 55, currency: 'EUR', seller: 'Stanley 1913 EU', url: 'https://google.be/search?ibp=oshop&q=x&prds=1' },
      { title: 'Stanley 1913 Quencher H2.0 FlowState Tumbler 1,18 L', price: 54.63, currency: 'EUR', seller: 'Amazon.com.be', url: 'https://google.be/search?ibp=oshop&q=x&prds=2' },
      { title: 'Stanley Quencher H2.0 40oz', price: 109.95, currency: 'EUR', seller: 'bol', url: 'https://google.be/search?ibp=oshop&q=x&prds=3' }) }] }] });
    throw new Error(`unexpected ${url}`);
  };
  return { f, calls };
}
const body = (over = {}) => ({ input: { name: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L', brand: 'Stanley' }, supplier: { price: 11, currency: 'USD' }, ...over });

// ---------- the HTTP route (real server, fake radar)
test('HTTP: token required, status and search answer, error codes reach the client, no credential in the body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nordla-radar-')); const TOKEN = 'radar-token-0123456789-abcdef'; const p = fakeProvider();
  const market = createMarketRadar({ env: ENV, fetchImpl: p.f, ecb: async () => ECB, sleep: async () => {}, pollMs: 1, now: () => new Date('2026-10-19T12:00:00Z') });
  const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port: 0, dir, fetchImpl: async () => { throw new Error('no network'); }, services: { market } });
  const base = `http://127.0.0.1:${server.port}`; const H = { 'x-sourcing-token': TOKEN, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/market/status`)).status, 401);
    const st = await (await fetch(`${base}/api/market/status`, { headers: H })).json(); assert.equal(st.enabled, true); assert.equal(st.photoIdentification.enabled, false);
    const ok = await fetch(`${base}/api/market/search`, { method: 'POST', headers: H, body: JSON.stringify(body()) }); const txt = await ok.text(); assert.equal(ok.status, 200); assert.ok(!txt.includes(SECRET) && !txt.includes(LOGIN)); assert.equal(JSON.parse(txt).listings.length, 3);
    const bad = await fetch(`${base}/api/market/search`, { method: 'POST', headers: H, body: JSON.stringify({ input: {} }) }); assert.equal(bad.status, 400); assert.equal((await bad.json()).error, 'INVALID_INPUT');
    const soon = await fetch(`${base}/api/market/search`, { method: 'POST', headers: H, body: JSON.stringify(body({ input: { name: 'Different thing', brand: 'Acme' } })) }); assert.equal(soon.status, 429); assert.ok(soon.headers.get('retry-after'));
  } finally { await new Promise((r) => server.server.close(r)); rmSync(dir, { recursive: true, force: true }); }
});
