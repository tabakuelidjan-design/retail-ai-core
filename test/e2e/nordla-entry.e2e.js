// REAL-BROWSER proof of the single NORDLA entry (Chromium, 390 px; engine-level, NOT the physical Xiaomi, NOT Railway itself), on ISOLATED
// SYNTHETIC Finance and Analytics data: sign-in -> menu "Nordla" -> 7 modules with their real state -> Finance and Analytics answers with
// sources -> brand check (indicative, rules not approved) -> campaign proposal with its blockers -> owner decision. Same set-up as the sign-in proof:
//   browser --HTTPS--> local TLS proxy that behaves like Railway (X-Real-IP, X-Forwarded-Proto/Host) --> hosted sourcing server (Core identity)
// The public name sourcing.nordla-test.example is resolved to 127.0.0.1 by Chromium itself (--host-resolver-rules); the proxy's certificate
// is a throw-away self-signed one (--ignore-certificate-errors). The identity tables and Supabase Auth are the in-memory test doubles of the
// identity suite (same rules as the SQL functions). Nothing here reaches the network.
//   npm run nordla:e2e
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityDb } from '../fixtures/identity-db.js';
import { createFakeGoTrue } from '../fixtures/fake-gotrue.js';
import { createIdentityService } from '../../src/identity/service.js';
import { createMemberService } from '../../src/identity/members.js';
import { createModuleProvisioning } from '../../src/identity/provisioning.js';
import { loadIdentityConfig, loadRateLimitConfig } from '../../src/identity/config.js';
import { createHttpSecurity } from '../../src/security/index.js';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { accWorld } from '../finance-acceptance-world.js';
import { writeDataset, NOW as AN_NOW } from '../fixtures/analytics-dataset.js';
import { createFinanceReader } from '../../src/core-pilot/finance-reader.js';
import { createAnalyticsReader } from '../../src/core-pilot/analytics-reader.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND: the hosted sign-in e2e was NOT run.'); process.exit(2); }
const results = []; const check = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); } catch (e) { results.push([name, `FAIL: ${e.message}`]); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const M = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OWNER = { id: '00000001-2222-4222-8222-000000000001', email: 'owner@nordla-test.example', password: 'synthetic passphrase for owner' };
const HOST = 'sourcing.nordla-test.example';

// ---- identity doubles + hosted server
const db = createIdentityDb({ merchants: [M], users: [OWNER.id] });
const gotrue = createFakeGoTrue({ users: [OWNER] });
const rlKey = randomBytes(32).toString('hex'); const csrfKey = randomBytes(32).toString('hex');
await createMemberService({ supabase: db.supabase, merchantId: M }).bootstrapOwner({ userId: OWNER.id });
await createModuleProvisioning({ supabase: db.supabase }).enableModule({ merchantId: M, moduleCode: 'sourcing', source: 'provisioning:manual' });
const tmp = mkdtempSync(join(tmpdir(), 'nordla-entry-e2e-'));
const proxyPort = await freePort(); const ORIGIN = `https://${HOST}:${proxyPort}`;
const identity = createIdentityService({ merchantId: M, moduleCode: 'sourcing', supabase: db.supabase, auth: { baseUrl: 'https://ref.supabase.example', anonKey: 'anon-test' }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: rlKey, fetchImpl: gotrue.fetchImpl });
// a non-default port is part of the exact origin here (the real deployment serves 443); hostedConfig is bypassed only for that port
const security = createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [`${HOST}:${proxyPort}`], allowedOrigins: [ORIGIN], moduleCode: 'sourcing', csrfKey, rateLimitKey: rlKey, loginTiming: { minMs: 200, jitterMs: 0 } });
const env = { SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: M, SOURCING_PUBLIC_ORIGIN: `https://${HOST}`, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'x', SUPABASE_ANON_KEY: 'anon-test', NORDLA_IDENTITY_RATE_LIMIT_KEY: rlKey, NORDLA_CSRF_KEY: csrfKey, SOURCING_MERCHANT_ID: 'habb', SOURCING_HOST: '127.0.0.1', SOURCING_DATA_DIR: join(tmp, 'data') };
const fw = accWorld({ merchantId: M });
const inv = await fw.supplier(121000, { dueDate: '2026-09-28', supplierName: 'Yiwu Greenline', invoiceNumber: 'YG-1' }); await fw.supplier(48400, { dueDate: '2026-10-08', supplierName: 'Dongguan Pioneer', invoiceNumber: 'DP-7' }); await fw.paySupplier(21000, [[inv.id, 21000]]);
const readers = { finance: createFinanceReader({ store: fw.st, merchantId: M, timeZone: 'Europe/Brussels', now: () => '2026-10-03T10:00:00.000Z', source: 'Finance · données de test isolées' }), analytics: createAnalyticsReader({ reportsDir: await writeDataset(), now: () => AN_NOW, source: 'Analytics · données de test isolées' }) };
const srv = await startSourcingServer({ env, log: () => {}, port: 0, services: { identity, security, readers }, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) });

// ---- the "Railway" proxy: TLS, then the headers the hosted security layer trusts
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tmp, 'k.pem'), '-out', join(tmp, 'c.pem'), '-days', '1', '-subj', `/CN=${HOST}`], { stdio: 'ignore' });
const proxy = https.createServer({ key: readFileSync(join(tmp, 'k.pem')), cert: readFileSync(join(tmp, 'c.pem')) }, (req, res) => {
  const up = http.request({ host: '127.0.0.1', port: srv.port, path: req.url, method: req.method, headers: { ...req.headers, host: HOST, 'x-forwarded-host': `${HOST}:${proxyPort}`, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
});
await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));
// the hosted server's Host allow-list is the public name without port; the proxy sends that Host, the security layer checks X-Forwarded-Host

const HELPERS = `window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }; 'ok'`;
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && document.body.innerText.length > 20", 20000); await t.eval(HELPERS); };
const text = (t) => t.eval('document.body.innerText');
const browser = await new Browser(exe, null, ['--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`]).launch(); let tab;
console.log(`Browser engine: ${exe}`);

// NORDLA_E2E_SHOTS=<dir>: phone-size screenshots of each step (the isolated-data demo); off by default
const SHOTS = process.env.NORDLA_E2E_SHOTS || null;
const shot = async (t, name, sel) => { if (!SHOTS) return; const { mkdirSync, writeFileSync } = await import('node:fs'); mkdirSync(SHOTS, { recursive: true }); if (sel) await t.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'start' }); 1`); await sleep(250); const r = await t.b.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64')); };
const click = async (t, sel) => t.run(`document.querySelector(${JSON.stringify(sel)}).click(); await __t.sleep(400); return 1;`);
try {
  await check('1. sign in, open the menu, open Nordla: the 7 modules with the state the server reports', async () => {
    tab = await browser.tab(`${ORIGIN}/`); await ready(tab); await tab.waitFor("!!document.querySelector('#login-email')", 15000);
    await tab.run(`document.querySelector('#login-email').value = ${JSON.stringify(OWNER.email)}; document.querySelector('#login-password').value = ${JSON.stringify(OWNER.password)}; document.querySelector('[data-act="login-go"]').click(); await __t.sleep(1500); return 1;`);
    await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    await click(tab, '#btn-cases'); await tab.waitFor("!!document.querySelector('[data-act=\"nx-load\"]')", 10000);
    await click(tab, '[data-act="nx-load"]'); await tab.waitFor("document.querySelectorAll('[data-nx-module]').length === 7", 10000);
    const states = await tab.eval("[...document.querySelectorAll('[data-nx-module] summary')].map((s) => s.innerText.replace(/\\s+/g, ' ').trim()).join(' | ')");
    await shot(tab, '1-modules', 'h2');
    for (const s of ['Nordla Core DISPONIBLE', 'Finance LECTURE SEULE', 'Analytics LECTURE SEULE', 'China Sourcing DISPONIBLE', 'Branding À APPROUVER', 'Marketing LIMITÉ', 'Création BLOQUÉ']) ok(states.includes(s), `missing "${s}" in ${states}`);
  });
  await check('2. Finance: "invoices to pay" answers with Finance\'s figures, due dates and its source', async () => {
    await tab.run(`document.querySelector('[data-nx-module="finance"]').open = true; document.querySelector('[data-nx-module="finance"] [data-act="nx-ask"]').click(); await __t.sleep(800); return 1;`);
    await tab.waitFor("!!document.querySelector('[data-nx-answer]')", 10000);
    const a = await tab.eval("document.querySelector('[data-nx-answer]').innerText");
    await shot(tab, '2-finance', '[data-nx-answer]');
    ok(/EN RETARD de 5 j — Yiwu Greenline/.test(a) && /Sources : .*Finance · données de test isolées/.test(a) && /aucun paiement/.test(a), a);
  });
  await check('3. Analytics: sales evolution vs the previous period, facts only, with source and period', async () => {
    await tab.run(`document.querySelector('[data-nx-module="analytics"]').open = true; document.querySelector('[data-nx-module="analytics"] [data-act="nx-ask"]').click(); await __t.sleep(800); return 1;`);
    await tab.waitFor("(document.querySelector('[data-nx-answer]')?.innerText || '').includes('Ventes du')", 10000);
    const a = await tab.eval("document.querySelector('[data-nx-answer]').innerText");
    await shot(tab, '3-analytics', '[data-nx-answer]');
    ok(/Chiffre d’affaires net HT : 489,25 €/.test(a) && /pas la cause/.test(a) && /Analytics · données de test isolées/.test(a), a);
  });
  await check('4. Branding check is labelled INDICATIVE while the rules are not approved; the campaign proposal lists its blockers', async () => {
    await tab.run(`document.querySelector('[data-nx-module="marketing"]').open = true; const f = (id, v) => { document.getElementById(id).value = v; }; f('nx-product', 'Fixture Widget'); f('nx-objective', 'ventes en boutique'); f('nx-audience', 'parents'); f('nx-channel', 'Instagram'); f('nx-copy', 'Dernière chance !!! Le meilleur cadeau de Namur.'); document.querySelector('[data-act="nx-check"]').click(); await __t.sleep(800); return 1;`);
    await tab.waitFor("!!document.querySelector('[data-nx-check]')", 10000);
    const chk = await tab.eval("document.querySelector('[data-nx-check]').textContent"); ok(/Aperçu indicatif/.test(chk), chk);
    await tab.run(`document.querySelector('[data-nx-module="marketing"]').open = true; document.getElementById('nx-product').value = 'Fixture Widget'; document.getElementById('nx-objective').value = 'ventes en boutique'; document.getElementById('nx-audience').value = 'parents'; document.getElementById('nx-channel').value = 'Instagram'; document.getElementById('nx-copy').value = 'Un cadeau personnalisé, imprimé avec soin à Namur.'; document.querySelector('[data-act="nx-campaign"]').click(); await __t.sleep(1000); return 1;`);
    await tab.waitFor("!!document.querySelector('[data-nx-campaign]')", 15000);
    await shot(tab, '4-campaign', '[data-nx-campaign]');
    const c = await tab.eval("document.querySelector('[data-nx-campaign]').innerText");
    ok(/aucun fournisseur de génération/.test(c) && /Diffusion : impossible/.test(c), c);
  });
  await check('5. the owner decides with a reason; the decision is on the server volume', async () => {
    await tab.run(`document.querySelector('[data-nx-module="marketing"]').open = true; document.getElementById('nx-reason-0').value = 'attendre les affirmations vérifiées'; document.querySelector('[data-act="nx-decide"][data-decision="DEFERRED"]').click(); await __t.sleep(1000); return 1;`);
    await tab.waitFor("(document.querySelector('[data-nx-campaign]')?.innerText || '').includes('Décision : DEFERRED')", 10000);
    const lines = readFileSync(join(tmp, 'data', 'core', 'campaigns.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(lines.some((l) => l.kind === 'DECISION' && l.decision === 'DEFERRED' && l.by === `user:${OWNER.id}`), 'decision journaled with the signed-in owner');
  });
} finally {
  await browser.close(); await new Promise((r) => proxy.close(r)); proxy.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
