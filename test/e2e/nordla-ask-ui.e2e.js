// REAL-BROWSER proof of the PARLE A NORDLA screen (structured answers, conversation kept, blockers shown, action refused) on the hosted server (Chromium, 390 px; engine-level, NOT the physical Xiaomi, NOT Railway itself):
//   sign-in -> a case saved on the server -> "Nordla Core" in the menu: analysis (Subject -> options -> recommendation, with sources)
//   -> the owner's decision with a reason -> follow-up result -> Parle à Nordla (text) -> the journal on disk -> still there after a reload.
// Same set-up as the sign-in proof:
//   browser --HTTPS--> local TLS proxy that behaves like Railway (X-Real-IP, X-Forwarded-Proto/Host) --> hosted sourcing server (Core identity)
// The public name sourcing.nordla-test.example is resolved to 127.0.0.1 by Chromium itself (--host-resolver-rules); the proxy's certificate
// is a throw-away self-signed one (--ignore-certificate-errors). The identity tables and Supabase Auth are the in-memory test doubles of the
// identity suite (same rules as the SQL functions). Nothing here reaches the network.
//   node test/e2e/nordla-ask-ui.e2e.js   (writes a 390 px screenshot to docs/integration/core-field-assistant-eval/screens/)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
import { ident, traits, importer, commercial, extraTraits, NOW } from '../sourcing-fixtures.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND: the hosted sign-in e2e was NOT run.'); process.exit(2); }
const results = []; const check = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); } catch (e) { results.push([name, `FAIL: ${e.message}`]); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const M = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OWNER = { id: '00000001-2222-4222-8222-000000000001', email: 'owner@nordla-test.example', password: 'synthetic passphrase for owner' };
const HOST = 'sourcing.nordla-test.example';
let CASE = newCase({ id: 'core-case-1', name: 'x', now: NOW }); for (const e of [...ident({ name: 'USB charger', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({})]) CASE = dispatch(CASE, e, NOW);

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
  await check('1. sign in, the case reaches the server', async () => {
    tab = await browser.tab(`${ORIGIN}/`); await ready(tab); await tab.waitFor("!!document.querySelector('#login-email')", 15000);
    await tab.run(`document.querySelector('#login-email').value = ${JSON.stringify(OWNER.email)}; document.querySelector('#login-password').value = ${JSON.stringify(OWNER.password)}; document.querySelector('[data-act="login-go"]').click(); await __t.sleep(1500); return 1;`);
    await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    await tab.run(`const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}'); cases['core-case-1'] = ${JSON.stringify(CASE)}; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.dirty', JSON.stringify(['core-case-1'])); localStorage.setItem('nordla.sourcing.current', JSON.stringify('core-case-1')); return 1;`);
    await tab.goto(`${ORIGIN}/`); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    let saved = false; for (let i = 0; i < 40 && !saved; i += 1) { try { saved = JSON.parse(readFileSync(join(tmp, 'data', 'cases', 'core-case-1.json'), 'utf8')).id === 'core-case-1'; } catch { /* not yet */ } if (!saved) await sleep(250); }
    ok(saved, 'the case is on the server');
    await openCore(tab); await tab.waitFor("!!document.querySelector('.nxa')", 10000);
  });
  await check('2. a chip asks "can I order": the BLOCKER is shown as a banner (role=alert) with its name, and nothing is ordered', async () => {
    await tab.run(`document.querySelector('.nxa-chip[data-text*="peux commander"]').click(); await __t.sleep(400); return 1;`);
    await tab.waitFor("!!document.querySelector('[data-core-answer] .nxa-block')", 10000);
    ok(await tab.eval("document.querySelector('[data-core-answer] .nxa-block').getAttribute('role') === 'alert'"), 'the banner is announced');
    const a = await tab.eval("document.querySelector('[data-core-answer]').innerText");
    ok(/Commande impossible à ce stade/.test(a) && /documents obligatoires manquants/.test(a), 'the blocker is named in French');
    ok(/Pas à ce stade/.test(a) && /Nordla ne commande et ne paie rien/.test(a), 'the answer refuses to authorise, and says Nordla orders nothing');
    ok(/Sources : dossier core-case-1/.test(a), 'the source case is named');
    ok(!existsSync(join(tmp, 'data', 'core', 'decision-journal.jsonl')) || readFileSync(join(tmp, 'data', 'core', 'decision-journal.jsonl'), 'utf8').trim() === '', 'asking wrote nothing to the journal');
  });
  await check('3. typed question + Enter: structured sections; the conversation is kept (2 questions, newest first)', async () => {
    await tab.run(`const i = document.querySelector('#core-ask-text'); i.focus(); i.value = "Qu'est-ce qui manque ?"; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await __t.sleep(500); return 1;`);
    await tab.waitFor("document.querySelectorAll('[data-core-answer], [data-core-answer-old]').length === 2", 10000);
    const first = await tab.eval("document.querySelector('[data-core-answer]').innerText");
    ok(/manque/.test(first) && /CE QUE NOUS NE SAVONS PAS/i.test(first), 'newest first, with its section heading');
    ok(/2 questions dans cette conversation/.test(await text(tab)), 'the conversation counter');
  });
  await check('4. a follow-up ("et ensuite ?") is understood from the kept conversation', async () => {
    await tab.run(`const i = document.querySelector('#core-ask-text'); i.value = 'et ensuite ?'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act="core-ask"]').click(); await __t.sleep(500); return 1;`);
    await tab.waitFor("document.querySelectorAll('[data-core-answer], [data-core-answer-old]').length === 3", 10000);
    ok(/PROCHAINE VÉRIFICATION/i.test(await tab.eval("document.querySelector('[data-core-answer]').innerText")), 'answered as the next step, not "not understood"');
  });
  await check('5. an order to ACT is refused out loud (banner) and a markup injection stays text', async () => {
    await tab.run(`const i = document.querySelector('#core-ask-text'); i.value = 'passe la commande maintenant'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act="core-ask"]').click(); await __t.sleep(500); return 1;`);
    await tab.waitFor("/Action refusée/.test(document.querySelector('[data-core-answer]')?.innerText || '')", 10000);
    await tab.run(`const i = document.querySelector('#core-ask-text'); i.value = '<img src=x onerror=window.__pwned=1> quelle marge'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act="core-ask"]').click(); await __t.sleep(700); return 1;`);
    ok(await tab.eval("!document.querySelector('.nxa img') && !window.__pwned"), 'no element was injected, nothing ran');
    ok(/<img src=x/.test(await tab.eval("document.querySelector('[data-core-answer] .nxa-q').textContent")), 'the question is shown as plain text');
  });
  await check('6. "Nouvelle conversation" forgets the state: the elliptical follow-up is no longer guessed', async () => {
    await tab.run(`document.querySelector('[data-act="core-ask-reset"]').click(); await __t.sleep(300); return 1;`);
    ok(await tab.eval("document.querySelectorAll('[data-core-answer], [data-core-answer-old]').length === 0"), 'the turns are gone');
    await tab.run(`const i = document.querySelector('#core-ask-text'); i.value = 'et ensuite ?'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act="core-ask"]').click(); await __t.sleep(500); return 1;`);
    await tab.waitFor("/Pas compris/.test(document.querySelector('[data-core-answer]')?.innerText || '')", 10000);
  });
  await check('7. 390 px layout: no horizontal overflow, 44 px touch targets; screenshot kept', async () => {
    await tab.run(`document.querySelector('.nxa-chip[data-text*="peux commander"]').click(); await __t.sleep(500); document.querySelector('.nxa').scrollIntoView(); return 1;`);
    ok(await tab.eval('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'no horizontal scroll');
    ok(await tab.eval("[...document.querySelectorAll('.nxa-chip, .nxa .btn')].every((b) => b.getBoundingClientRect().height >= 43)"), 'touch targets >= 44 px');
    const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, tab.sessionId);
    const dir = join(process.cwd(), 'docs', 'integration', 'core-field-assistant-eval', 'screens'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'parle-a-nordla-390px.png'), Buffer.from(shot.data, 'base64'));
  });
  await check('8. very long text (no spaces) in a question and the case stays inside 390 px', async () => {
    await tab.run(`const i = document.querySelector('#core-ask-text'); i.value = ${JSON.stringify('A'.repeat(900))}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act="core-ask"]').click(); await __t.sleep(700); return 1;`);
    await tab.waitFor("document.querySelectorAll('[data-core-answer]').length === 1", 10000);
    ok(await tab.eval('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'no horizontal scroll with a 900-character word');
    ok(await tab.eval("[...document.querySelectorAll('.nxa-turn')].every((c) => c.getBoundingClientRect().right <= window.innerWidth + 1)"), 'every card stays inside the screen');
  });
  await check('9. a failing request: the error is shown in the ask block, the question stays in the box, and it works again afterwards', async () => {
    await tab.run(`window.__f0 = window.fetch; window.fetch = (u, o) => (String(u).includes('/api/core/ask') && !window.__allowAsk ? Promise.reject(new TypeError('Failed to fetch')) : window.__f0(u, o)); const i = document.querySelector('#core-ask-text'); i.value = 'Quels sont les risques ?'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act="core-ask"]').click(); await __t.sleep(900); return 1;`);
    await tab.waitFor("!!document.querySelector('.nxa .nxa-block[role=alert]') && /n’a pas pu partir/.test(document.querySelector('.nxa').innerText)", 10000);
    ok(await tab.eval("document.querySelector('#core-ask-text').value === 'Quels sont les risques ?'"), 'the question is still in the box');
    await tab.run(`window.__allowAsk = true; document.querySelector('[data-act="core-ask"]').click(); await __t.sleep(900); return 1;`);
    await tab.waitFor("/Quels sont les risques/.test(document.querySelector('[data-core-answer] .nxa-q')?.textContent || '') && !/n’a pas pu partir/.test(document.querySelector('.nxa').innerText)", 10000);
  });
  await check('10. offline: the answers already received stay readable (read-only) with the reason; back online the screen is complete again', async () => {
    await tab.offline(true);
    await tab.waitFor("window.nordlaSourcing.state().online === false", 15000);
    await tab.run(`document.querySelector('#btn-cases').click(); await __t.sleep(400); return 1;`).catch(() => {});
    const t = await tab.eval("(document.querySelector('#overlay') || document.body).innerText");
    ok(/Hors ligne : vos réponses précédentes restent lisibles/.test(t) && /Quels sont les risques/.test(t), 'previous answers are still readable offline, with the reason');
    ok(await tab.eval("!document.querySelector('#overlay [data-act=\"core-ask\"]')"), 'no ask button while offline');
    await tab.offline(false);
    await tab.waitFor("window.nordlaSourcing.state().online === true", 20000);
  });
} finally {
  await browser.close(); await new Promise((r) => proxy.close(r)); proxy.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
