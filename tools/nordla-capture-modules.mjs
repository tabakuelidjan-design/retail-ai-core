// Real-browser screenshots of Nordla Core and of every module on ISOLATED SYNTHETIC data (no network, no real account, no secret), desktop 1440 px and phone 390 px.
//   node tools/nordla-capture-modules.mjs <outDir>          (browser: set SOURCING_E2E_BROWSER to a Chrome / Edge executable if the default one does not start)
// Core and the field app, Stock & Achats and the module detail screens come from the hosted server (Nordla session, identity test doubles, local TLS proxy like Railway); Finance (demo
// server), Analytics (synthetic report), Growth (demonstration pages) and Social Publishing (in-memory posts) run on loopback. A compose step (tools/nordla-compose-captures.py) puts
// Core and each module side by side.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityDb } from '../test/fixtures/identity-db.js';
import { createFakeGoTrue } from '../test/fixtures/fake-gotrue.js';
import { createIdentityService } from '../src/identity/service.js';
import { createMemberService } from '../src/identity/members.js';
import { createModuleProvisioning } from '../src/identity/provisioning.js';
import { loadIdentityConfig, loadRateLimitConfig } from '../src/identity/config.js';
import { createHttpSecurity } from '../src/security/index.js';
import { startSourcingServer } from '../src/sourcing/server/index.js';
import { accWorld } from '../test/finance-acceptance-world.js';
import { writeDataset } from '../test/fixtures/analytics-dataset.js';
import { createFinanceReader } from '../src/core-pilot/finance-reader.js';
import { createAnalyticsReader } from '../src/core-pilot/analytics-reader.js';
import { Browser, findBrowser, freePort } from '../test/e2e/cdp.js';
import { startDemo, DEMO_TOKEN } from '../src/finance/server/demo.js';
import { createAnalyticsPremiumApp } from '../src/analytics-premium/server/app.js';
import { createGrowthApp } from '../src/growth/server/app.js';
import { createSocialApp } from '../src/social/server/app.js';
import { createSocialService } from '../src/social/service.js';
import { createMemoryStore } from '../src/social/store.js';

const OUT = process.argv[2]; if (!OUT) { console.error('usage: node tools/nordla-capture-modules.mjs <outDir>'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const exe = findBrowser(); if (!exe) { console.error('no browser'); process.exit(3); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const M = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'; const OWNER = { id: '00000001-2222-4222-8222-000000000001', email: 'owner@nordla-test.example', password: 'synthetic passphrase for owner' };
const HOST = 'sourcing.nordla-test.example';
const db = createIdentityDb({ merchants: [M], users: [OWNER.id] }); const gotrue = createFakeGoTrue({ users: [OWNER] });
const rlKey = randomBytes(32).toString('hex'); const csrfKey = randomBytes(32).toString('hex');
await createMemberService({ supabase: db.supabase, merchantId: M }).bootstrapOwner({ userId: OWNER.id });
await createModuleProvisioning({ supabase: db.supabase }).enableModule({ merchantId: M, moduleCode: 'sourcing', source: 'provisioning:manual' });
const tmp = mkdtempSync(join(tmpdir(), 'nordla-capture-'));
const proxyPort = await freePort(); const ORIGIN = `https://${HOST}:${proxyPort}`;
const identity = createIdentityService({ merchantId: M, moduleCode: 'sourcing', supabase: db.supabase, auth: { baseUrl: 'https://ref.supabase.example', anonKey: 'anon-test' }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: rlKey, fetchImpl: gotrue.fetchImpl });
const security = createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [`${HOST}:${proxyPort}`], allowedOrigins: [ORIGIN], moduleCode: 'sourcing', csrfKey, rateLimitKey: rlKey, loginTiming: { minMs: 200, jitterMs: 0 } });
const env = { SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: M, SOURCING_PUBLIC_ORIGIN: `https://${HOST}`, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'x', SUPABASE_ANON_KEY: 'anon-test', NORDLA_IDENTITY_RATE_LIMIT_KEY: rlKey, NORDLA_CSRF_KEY: csrfKey, SOURCING_MERCHANT_ID: 'habb', SOURCING_HOST: '127.0.0.1', SOURCING_DATA_DIR: join(tmp, 'data') };
const fw = accWorld({ merchantId: M });
await fw.supplier(121000, { dueDate: '2026-09-28', supplierName: 'Yiwu Greenline', invoiceNumber: 'YG-1' }); await fw.supplier(48400, { dueDate: '2026-10-08', supplierName: 'Dongguan Pioneer', invoiceNumber: 'DP-7' });
const reportsDir = await writeDataset();
const readers = { finance: createFinanceReader({ store: fw.st, merchantId: M, timeZone: 'Europe/Brussels', now: () => '2026-10-03T10:00:00.000Z', source: 'Finance · données de test isolées' }), analytics: createAnalyticsReader({ reportsDir, now: () => new Date('2026-09-26T10:00:00Z'), source: 'Analytics · données de test isolées' }) };
const srv = await startSourcingServer({ env, log: () => {}, port: 0, services: { identity, security, readers }, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tmp, 'k.pem'), '-out', join(tmp, 'c.pem'), '-days', '1', '-subj', `/CN=${HOST}`], { stdio: 'ignore' });
const proxy = https.createServer({ key: readFileSync(join(tmp, 'k.pem')), cert: readFileSync(join(tmp, 'c.pem')) }, (req, res) => {
  const up = http.request({ host: '127.0.0.1', port: srv.port, path: req.url, method: req.method, headers: { ...req.headers, host: HOST, 'x-forwarded-host': `${HOST}:${proxyPort}`, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
});
await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));

// loopback modules
const finance = await startDemo(await freePort()); const financePort = finance.port;
const loop = async (handler) => { const s = http.createServer(handler); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s; };
const analytics = await loop(createAnalyticsPremiumApp({ reportsDir, syncStatus: async () => ({ available: false, reason: 'NO_SALES_SOURCE' }), reportStatus: () => ({}), ask: null }));
const growth = await loop(createGrowthApp({}));
const social = createSocialService({ store: createMemoryStore() });
const ACTOR = { id: 'chantier-d', role: 'agent' };
const post = (n, over = {}) => ({ platform: 'instagram', format: 'IMAGE', subject: { kind: 'product', ref: `shopify://product/p${n}`, label: `Coque modèle ${n}` }, asset: { ref: `asset://habb/c${n}`, version: 1, sha256: `${String(n).repeat(64)}`.slice(0, 64), content_type: 'image/jpeg', width: 1080, height: 1350 }, caption: `Coque personnalisée, modèle ${n}. Fabriquée à Namur.`, hashtags: ['habb', 'namur'], publish_at: `2026-10-${20 + n}T17:00:00Z`, ...over });
try { for (const n of [1, 2, 3]) { const p = await social.createPost(post(n), ACTOR); if (n < 3) await social.act(p.id, 'submit', ACTOR); } } catch (e) { console.log('social sample posts:', e.message); }
const SOCIAL_TOKEN = 't'.repeat(40);
const socialApp = createSocialApp({ token: SOCIAL_TOKEN, service: social, assets: null, uiDir: new URL('../src/social/ui', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
const socialSrv = await loop(socialApp.handler);

const browser = await new Browser(exe, null, ['--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`]).launch();
const VIEWS = { desktop: { width: 1440, height: 900, mobile: false }, tablet: { width: 768, height: 1024, mobile: false }, mobile: { width: 390, height: 844, mobile: true }, small: { width: 360, height: 740, mobile: true } };
const shot = async (t, name, view) => { const v = VIEWS[view]; await t.b.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.mobile }, t.sessionId); await sleep(900); const r = await t.b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, t.sessionId); writeFileSync(join(OUT, `${name}-${view}.png`), Buffer.from(r.data, 'base64')); console.log('saved', `${name}-${view}`); };
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && document.body.innerText.length > 10", 20000); };
try {
  const tab = await browser.tab(`${ORIGIN}/`, { width: 1440, height: 900 }); await ready(tab); await tab.waitFor("!!document.querySelector('#login-email')", 15000);
  await tab.run(`document.querySelector('#login-email').value = ${JSON.stringify(OWNER.email)}; document.querySelector('#login-password').value = ${JSON.stringify(OWNER.password)}; document.querySelector('[data-act="login-go"]').click(); await new Promise((r) => setTimeout(r, 1500)); return 1;`);
  await tab.waitFor('window.nordlaSourcing?.state().online === true', 20000);
  const view = async (name, url, wait = 900) => { for (const v of Object.keys(VIEWS)) { await tab.b.send('Emulation.setDeviceMetricsOverride', { width: VIEWS[v].width, height: VIEWS[v].height, deviceScaleFactor: 1, mobile: VIEWS[v].mobile }, tab.sessionId); await tab.goto(url); await ready(tab); await sleep(wait); await shot(tab, name, v); } };
  await view('core-accueil', `${ORIGIN}/nordla#accueil`, 1800); await view('core-modules', `${ORIGIN}/nordla#modules`, 1200); await view('core-parle', `${ORIGIN}/nordla#parle`, 1200);
  for (const k of ['social', 'validations', 'branding', 'marketing', 'creative', 'procurement']) await view(`core-module-${k}`, `${ORIGIN}/nordla#module/${k}`, 1200);
  await view('china-sourcing', `${ORIGIN}/`, 1500); await view('stock-achats', `${ORIGIN}/procurement/`, 1500);
  // loopback modules (own browser tab per module)
  const plain = async (name, url, prepare) => { const t = await browser.tab('about:blank', { width: 1440, height: 900 }); for (const v of Object.keys(VIEWS)) { await t.b.send('Emulation.setDeviceMetricsOverride', { width: VIEWS[v].width, height: VIEWS[v].height, deviceScaleFactor: 1, mobile: VIEWS[v].mobile }, t.sessionId); await t.goto(url); await ready(t); if (prepare) await prepare(t); await sleep(1200); await shot(t, name, v); } };
  await plain('finance', `http://127.0.0.1:${financePort}/`, async (t) => { await t.waitFor("!!document.querySelector('input[type=password]')", 10000).catch(() => {}); await t.run(`const i = document.querySelector('input[type=password]'); if (i) { i.value = ${JSON.stringify(DEMO_TOKEN)}; i.dispatchEvent(new Event('input', { bubbles: true })); (i.form?.querySelector('button') ?? document.querySelector('button.btn, .login button'))?.click(); await new Promise((r) => setTimeout(r, 1800)); } return 1;`); });
  await plain('analyses', `http://127.0.0.1:${analytics.address().port}/`);
  await plain('developpement-des-ventes', `http://127.0.0.1:${growth.address().port}/`);
  await plain('social-publishing', `http://127.0.0.1:${socialSrv.address().port}/#t=${SOCIAL_TOKEN}`);
} finally {
  await browser.close(); for (const s of [proxy, socialSrv, analytics, growth]) { await new Promise((r) => s.close(r)); s.closeAllConnections?.(); }
  await new Promise((r) => { finance.server.close(r); finance.server.closeAllConnections?.(); }); await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
console.log('done');
process.exit(0);
