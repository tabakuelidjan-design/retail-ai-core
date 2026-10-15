// REAL-BROWSER proof of NORDLA CORE on the hosted server (Chromium, 390 px; engine-level, NOT the physical Xiaomi, NOT Railway itself):
//   sign-in -> a case saved on the server -> "Nordla Core" in the menu: analysis (Subject -> options -> recommendation, with sources)
//   -> the owner's decision with a reason -> follow-up result -> Parle à Nordla (text) -> the journal on disk -> still there after a reload.
// Same set-up as the sign-in proof:
//   browser --HTTPS--> local TLS proxy that behaves like Railway (X-Real-IP, X-Forwarded-Proto/Host) --> hosted sourcing server (Core identity)
// The public name sourcing.nordla-test.example is resolved to 127.0.0.1 by Chromium itself (--host-resolver-rules); the proxy's certificate
// is a throw-away self-signed one (--ignore-certificate-errors). The identity tables and Supabase Auth are the in-memory test doubles of the
// identity suite (same rules as the SQL functions). Nothing here reaches the network.
//   npm run core:e2e
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
import { newCase, dispatch } from '../../src/sourcing/core/case.js';
import { ident, traits, importer, commercial, NOW } from '../sourcing-fixtures.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND: the hosted sign-in e2e was NOT run.'); process.exit(2); }
const results = []; const check = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); } catch (e) { results.push([name, `FAIL: ${e.message}`]); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const M = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OWNER = { id: '00000001-2222-4222-8222-000000000001', email: 'owner@nordla-test.example', password: 'synthetic passphrase for owner' };
const HOST = 'sourcing.nordla-test.example';
let CASE = newCase({ id: 'core-case-1', name: 'x', now: NOW }); for (const e of [...ident({ name: 'Bamboo kitchen organiser', category: 'household_general' }), ...traits({}), ...importer, { type: 'SUPPLIER', supplier: { name: 'Yiwu Greenline' } }, ...commercial({ unitPrice: 4.2, qty: 1000, moq: 500 })]) CASE = dispatch(CASE, e, NOW);

// ---- identity doubles + hosted server
const db = createIdentityDb({ merchants: [M], users: [OWNER.id] });
const gotrue = createFakeGoTrue({ users: [OWNER] });
const rlKey = randomBytes(32).toString('hex'); const csrfKey = randomBytes(32).toString('hex');
await createMemberService({ supabase: db.supabase, merchantId: M }).bootstrapOwner({ userId: OWNER.id });
await createModuleProvisioning({ supabase: db.supabase }).enableModule({ merchantId: M, moduleCode: 'sourcing', source: 'provisioning:manual' });
const tmp = mkdtempSync(join(tmpdir(), 'nordla-core-e2e-'));
const proxyPort = await freePort(); const ORIGIN = `https://${HOST}:${proxyPort}`;
const identity = createIdentityService({ merchantId: M, moduleCode: 'sourcing', supabase: db.supabase, auth: { baseUrl: 'https://ref.supabase.example', anonKey: 'anon-test' }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: rlKey, fetchImpl: gotrue.fetchImpl });
// a non-default port is part of the exact origin here (the real deployment serves 443); hostedConfig is bypassed only for that port
const security = createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [`${HOST}:${proxyPort}`], allowedOrigins: [ORIGIN], moduleCode: 'sourcing', csrfKey, rateLimitKey: rlKey, loginTiming: { minMs: 200, jitterMs: 0 } });
const env = { SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: M, SOURCING_PUBLIC_ORIGIN: `https://${HOST}`, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'x', SUPABASE_ANON_KEY: 'anon-test', NORDLA_IDENTITY_RATE_LIMIT_KEY: rlKey, NORDLA_CSRF_KEY: csrfKey, SOURCING_MERCHANT_ID: 'habb', SOURCING_HOST: '127.0.0.1', SOURCING_DATA_DIR: join(tmp, 'data') };
const srv = await startSourcingServer({ env, log: () => {}, port: 0, services: { identity, security }, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) });

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

const openCore = async (t) => {
  await t.run(`document.querySelector('#btn-cases').click(); await __t.sleep(300); return 1;`);
  await t.waitFor("!!document.querySelector('[data-act=\"core-load\"]') || !!document.querySelector('[data-act=\"core-analyse\"]')", 10000);
  if (await t.eval("!!document.querySelector('[data-act=\"core-load\"]')")) await t.run(`document.querySelector('[data-act="core-load"]').click(); await __t.sleep(800); return 1;`);
};
try {
  await check('1. sign in, a case changed on the phone reaches the server', async () => {
    tab = await browser.tab(`${ORIGIN}/`); await ready(tab); await tab.waitFor("!!document.querySelector('#login-email')", 15000);
    await tab.run(`document.querySelector('#login-email').value = ${JSON.stringify(OWNER.email)}; document.querySelector('#login-password').value = ${JSON.stringify(OWNER.password)}; document.querySelector('[data-act="login-go"]').click(); await __t.sleep(1500); return 1;`);
    await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    await tab.run(`const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}'); cases['core-case-1'] = ${JSON.stringify(CASE)}; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.dirty', JSON.stringify(['core-case-1'])); localStorage.setItem('nordla.sourcing.current', JSON.stringify('core-case-1')); return 1;`);
    await tab.goto(`${ORIGIN}/`); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    let saved = false; for (let i = 0; i < 40 && !saved; i += 1) { try { saved = JSON.parse(readFileSync(join(tmp, 'data', 'cases', 'core-case-1.json'), 'utf8')).id === 'core-case-1'; } catch { /* not yet */ } if (!saved) await sleep(250); }
    ok(saved, 'the case is on the server');
  });
  await check('2. Nordla Core analyses the purchase of the open case: recommendation, options with reasons, facts with their source', async () => {
    await openCore(tab);
    await tab.waitFor("!!document.querySelector('[data-act=\"core-analyse\"]')", 10000);
    await tab.run(`document.querySelector('[data-act="core-analyse"]').click(); await __t.sleep(300); return 1;`);
    await tab.waitFor("!!document.querySelector('[data-core-decision]')", 15000);
    const t = await text(tab);
    ok(/Recommandation : Tester petit/.test(t), 'the recommendation is shown');
    ok(/Commander 1000 unités/.test(t) && /can_commit_money eq true \(actual false\)/.test(t), 'the eliminated orders are shown with their reason');
    ok(/Nordla ne commande et ne paie rien/.test(t), 'the screen says nothing is executed');
    ok(await tab.eval("document.querySelector('[data-core-decision] details').textContent.includes('sourcing-case:core-case-1@')"), 'facts carry their source case and version');
  });
  await check('3. the owner decides WITH a reason (none = refused); the follow-up result is recorded', async () => {
    await tab.run(`document.querySelector('[data-act="core-approve"]').click(); await __t.sleep(300); return 1;`);
    ok(/Écrivez la raison de votre décision/.test(await text(tab)), 'a decision without a reason is refused on the phone');
    await tab.run(`document.querySelector('[id^="core-reason-"]').value = 'échantillon et documents avant tout acompte'; document.querySelector('[data-act="core-approve"]').click(); await __t.sleep(300); return 1;`);
    await tab.waitFor("document.body.innerText.includes('Validé le')", 10000);
    await tab.run(`document.querySelector('[data-act="core-result"][data-result="NOT_MEASURABLE"]').click(); await __t.sleep(300); return 1;`);
    await tab.waitFor("document.body.innerText.includes('Résultat : Pas mesurable')", 10000);
  });
  await check('4. Parle à Nordla (text): answers from the journal; Analyses is said NOT connected, without any figure', async () => {
    await tab.run(`document.querySelector('#core-ask-text').value = 'suivi des décisions'; document.querySelector('[data-act="core-ask"]').click(); await __t.sleep(300); return 1;`);
    await tab.waitFor("!!document.querySelector('[data-core-answer]')", 10000);
    ok(/résultat : NOT_MEASURABLE/.test(await tab.eval("document.querySelector('[data-core-answer]').innerText")), 'the follow-up is answered from the journal');
    ok(/Sources : journal/.test(await tab.eval("document.querySelector('[data-core-answer]').innerText")), 'the source is named');
    await tab.run(`document.querySelector('#core-ask-text').value = 'pourquoi mes ventes ont baissé ?'; document.querySelector('[data-act="core-ask"]').click(); await __t.sleep(600); return 1;`);
    const a = await tab.eval("document.querySelector('[data-core-answer]').innerText");
    ok(/Analyses n’est pas encore relié/.test(a) && !/\d+ ?€/.test(a), 'not connected, no figure');
  });
  await check('5. the journal on the server holds the three steps with the signed-in person; a reload shows the same decision', async () => {
    const lines = readFileSync(join(tmp, 'data', 'core', 'decision-journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(lines.map((e) => e.kind).join(',') === 'ANALYSED,HUMAN_DECISION,RESULT', `journal: ${lines.map((e) => e.kind)}`);
    ok(lines.every((e) => e.actor.user_id === OWNER.id && e.actor.auth === 'NORDLA_SESSION' && e.merchant_id === M), 'who did it comes from the session');
    await tab.goto(`${ORIGIN}/`); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    await openCore(tab); await tab.waitFor("document.body.innerText.includes('Résultat : Pas mesurable')", 10000);
  });
} finally {
  await browser.close(); await new Promise((r) => proxy.close(r)); proxy.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
