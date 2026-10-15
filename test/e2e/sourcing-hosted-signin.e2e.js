// REAL-BROWSER proof of the HOSTED China Sourcing sign-in (Chromium, 390 px; engine-level, NOT the physical Xiaomi, NOT Railway itself):
//   browser --HTTPS--> local TLS proxy that behaves like Railway (X-Real-IP, X-Forwarded-Proto/Host) --> hosted sourcing server (Core identity)
// The public name sourcing.nordla-test.example is resolved to 127.0.0.1 by Chromium itself (--host-resolver-rules); the proxy's certificate
// is a throw-away self-signed one (--ignore-certificate-errors). The identity tables and Supabase Auth are the in-memory test doubles of the
// identity suite (same rules as the SQL functions). Nothing here reaches the network.
//   npm run sourcing:e2e:signin
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
const tmp = mkdtempSync(join(tmpdir(), 'nordla-signin-e2e-'));
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
try {
  await check('1. the hosted address shows a SIGN-IN screen (e-mail + password), never a token field', async () => {
    tab = await browser.tab(`${ORIGIN}/`);
    await ready(tab); await tab.waitFor("!!document.querySelector('#login-email')", 15000);
    const t = await text(tab); ok(/Connexion/.test(t) && /Mot de passe/.test(t), 'sign-in screen'); ok(!(await tab.eval("!!document.querySelector('#gate-tok')")), 'no token field');
  });
  await check('2. a wrong password is refused with the generic message; nothing is stored', async () => {
    await tab.run(`document.querySelector('#login-email').value = ${JSON.stringify(OWNER.email)}; document.querySelector('#login-password').value = 'wrong'; document.querySelector('[data-act="login-go"]').click(); await __t.sleep(1200); return 1;`);
    ok(/Impossible de vous connecter/.test(await text(tab)), 'generic refusal shown');
    ok(!(await tab.eval("document.cookie.includes('nordla_sourcing_csrf')")), 'no session cookie');
  });
  await check('3. the right password signs in: the app opens, the server is verified (session cookie + CSRF, no token)', async () => {
    await tab.run(`document.querySelector('#login-email').value = ${JSON.stringify(OWNER.email)}; document.querySelector('#login-password').value = ${JSON.stringify(OWNER.password)}; document.querySelector('[data-act="login-go"]').click(); await __t.sleep(1500); return 1;`);
    await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    ok(await tab.eval("document.cookie.includes('__Host-nordla_sourcing_csrf=')"), 'CSRF cookie readable by the page');
    ok(!(await tab.eval("document.cookie.includes('nordla_sourcing_sid')")), 'the session cookie is HttpOnly (not readable)');
    ok(!(await tab.eval("(localStorage.getItem('nordla.sourcing.token') || '').length > 10")), 'no token stored on the phone');
  });
  await check('4. a case changed on the phone is saved on the server through the session (CSRF accepted), with its photo backed up', async () => {
    let c = newCase({ id: 'hosted-case-1', name: 'gourde', now: new Date('2026-10-18T08:00:00Z') }); c = dispatch(c, { type: 'PHOTO', ref: 'photo-0', note: 'face.jpg' }, new Date('2026-10-18T08:00:00Z'));
    await tab.run(`const s = await import('/storage.js'); await s.putBlob('photo:hosted-case-1.0', 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='); const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}'); cases['hosted-case-1'] = ${JSON.stringify(c)}; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.dirty', JSON.stringify(['hosted-case-1'])); return 1;`);
    await tab.goto(`${ORIGIN}/`); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    // the hosted server answers nothing without a session: the proof is read from its data directory
    let saved = false; for (let i = 0; i < 40 && !saved; i += 1) { try { saved = JSON.parse(readFileSync(join(tmp, 'data', 'cases', 'hosted-case-1.json'), 'utf8')).id === 'hosted-case-1'; } catch { /* not yet */ } if (!saved) await sleep(250); }
    ok(saved, 'the case file is on the server');
    let photo = false; for (let i = 0; i < 40 && !photo; i += 1) { try { photo = readFileSync(join(tmp, 'data', 'photos', 'hosted-case-1', 'photo__hosted-case-1.0.json'), 'utf8').includes('"sha256"'); } catch { /* not yet */ } if (!photo) await sleep(250); }
    ok(photo, 'the photo is on the server');
  });
  await check('5. sign-out on the server side (session revoked) brings the sign-in back; the phone keeps its cases', async () => {
    await tab.run(`await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-nordla-csrf': (document.cookie.match(/__Host-nordla_sourcing_csrf=([^;]+)/) || [])[1] || '' } }); return 1;`);
    await tab.goto(`${ORIGIN}/`); await ready(tab); await tab.waitFor("!!document.querySelector('#login-email')", 15000);
    ok(await tab.eval("Object.keys(JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}')).includes('hosted-case-1')"), 'the case is still on the phone');
    ok(db.table('app_sessions').some((s) => s.revoked_at), 'the session is revoked server-side');
  });
} finally {
  await browser.close(); await new Promise((r) => proxy.close(r)); proxy.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
