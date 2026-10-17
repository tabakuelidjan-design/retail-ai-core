// REAL-BROWSER proof of PARLE A NORDLA VOICE (V2) on the hosted server (Chromium, 390 px; a FAKE microphone and speaker are injected - this proves the screen, the consent, the fallbacks and the safety, NOT Chrome's real recognition on a Xiaomi nor Railway):
//   sign-in -> a case saved on the server -> "Nordla Core" in the menu: analysis (Subject -> options -> recommendation, with sources)
//   -> the owner's decision with a reason -> follow-up result -> Parle à Nordla (text) -> the journal on disk -> still there after a reload.
// Same set-up as the sign-in proof:
//   browser --HTTPS--> local TLS proxy that behaves like Railway (X-Real-IP, X-Forwarded-Proto/Host) --> hosted sourcing server (Core identity)
// The public name sourcing.nordla-test.example is resolved to 127.0.0.1 by Chromium itself (--host-resolver-rules); the proxy's certificate
// is a throw-away self-signed one (--ignore-certificate-errors). The identity tables and Supabase Auth are the in-memory test doubles of the
// identity suite (same rules as the SQL functions). Nothing here reaches the network.
//   node test/e2e/nordla-voice.e2e.js   (writes a 390 px screenshot to docs/integration/core-field-assistant-eval/screens/)
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
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && document.body.innerText.length > 20", 60000); await t.eval(HELPERS); };
const text = (t) => t.eval('document.body.innerText');
const browser = await new Browser(exe, null, ['--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`]).launch(); let tab;
console.log(`Browser engine: ${exe}`);

const openCore = async (t) => {
  await t.run(`document.querySelector('#btn-cases').click(); await __t.sleep(300); return 1;`);
  await t.waitFor("!!document.querySelector('[data-act=\"core-load\"]') || !!document.querySelector('[data-act=\"core-analyse\"]')", 10000);
  if (await t.eval("!!document.querySelector('[data-act=\"core-load\"]')")) await t.run(`document.querySelector('[data-act="core-load"]').click(); await __t.sleep(800); return 1;`);
};

const FAKE = "(() => {\n  if (localStorage.getItem('__nosr') === '1') { for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) Object.defineProperty(window, k, { value: undefined, configurable: true }); return; }\n  const log = window.__voice = { starts: 0, spoken: [], cancels: 0, mode: 'ok', cur: null, inst: null };\n  class SR {\n    start() { log.starts += 1; log.inst = this; if (log.mode === 'denied') { setTimeout(() => { this.onerror && this.onerror({ error: 'not-allowed' }); this.onend && this.onend(); }, 40); return; } setTimeout(() => this.onaudiostart && this.onaudiostart(), 30); }\n    stop() { setTimeout(() => this.onend && this.onend(), 10); }\n    abort() {}\n  }\n  for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) Object.defineProperty(window, k, { value: SR, configurable: true });\n  log.interim = (t) => log.inst.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: false })] });\n  log.say = (t) => { log.inst.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] }); log.inst.onend(); };\n  class U { constructor(t) { this.text = t; } }\n  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: U, configurable: true });\n  Object.defineProperty(window, 'speechSynthesis', { value: { speak(u) { log.spoken.push(u.text); log.cur = u; u.onstart && u.onstart(); }, cancel() { log.cancels += 1; if (log.cur) { const c = log.cur; log.cur = null; c.onend && c.onend(); } }, getVoices() { return [{ lang: 'fr-FR' }]; } }, configurable: true });\n})();\n";
const reload = async (flags = {}) => { await tab.run("localStorage.setItem('__nosr', '" + (flags.nosr ? '1' : '0') + "'); return 1;"); await tab.goto(`${ORIGIN}/`); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 20000); await openCore(tab); await tab.waitFor("!!document.querySelector('.nxa')", 10000); };
const click = (sel) => tab.run(`document.querySelector(${JSON.stringify(sel)}).click(); await __t.sleep(250); return 1;`);
const typed = (q) => tab.run(`const i = document.querySelector('#core-ask-text'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
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
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE }, tab.sessionId);
  await check('2. the hosted pages are not served with a Permissions-Policy that blocks the microphone (none sent = same-origin default allows it)', async () => {
    await reload(); const pp = await tab.eval("fetch('/', { cache: 'no-store' }).then((r) => r.headers.get('permissions-policy') || '')");
    ok(pp === '' || /microphone=(self)/.test(pp), 'the microphone is not blocked for the page: ' + pp);
  });
  await check('3. one big microphone button above the keyboard box; the first tap shows the consent notice and starts NO microphone', async () => {
    ok(await tab.eval("(() => { const b = document.querySelector('.nxa-mic'); if (!b) return false; const r = b.getBoundingClientRect(); return r.height >= 64 && r.width >= 300 && r.right <= window.innerWidth + 1; })()"), 'a big, full-width, thumb-sized button');
    ok(await tab.eval("!!(document.querySelector('.nxa-mic').compareDocumentPosition(document.querySelector('#core-ask-text')) & Node.DOCUMENT_POSITION_FOLLOWING)"), 'the microphone comes before the keyboard box');
    await click('.nxa-mic'); const t = await text(tab);
    ok(/Avant de parler/.test(t) && /n’enregistre aucun son/.test(t) && /Google sur Chrome/.test(t), 'consent notice, with the third-party disclosure');
    ok(await tab.eval('window.__voice.starts === 0'), 'no recognition before consent');
  });
  await check('4. accept: "J’écoute…" only when audio flows; interim words shown; the final text lands in the box and is NOT sent; the person corrects it, then asks', async () => {
    await click('[data-act="core-ask-mic-consent"]'); await tab.waitFor("/J’écoute/.test(document.querySelector('.nxa-mic')?.innerText || '')", 5000);
    await tab.run("window.__voice.interim('qu’est-ce qu'); await __t.sleep(150); return 1;"); ok(/qu’est-ce qu/.test(await tab.eval("document.getElementById('nxa-interim').innerText")), 'interim transcript visible');
    await tab.run("window.__voice.say('quelle est la mage'); await __t.sleep(300); return 1;");
    ok(await tab.eval("document.querySelector('#core-ask-text').value === 'quelle est la mage'"), 'the transcript is in the question box'); ok(/Relisez et corrigez/.test(await text(tab)), 'the instruction to review');
    ok(await tab.eval("!/mage/.test(document.querySelector('[data-core-answer] .nxa-q')?.textContent || '')"), 'nothing was sent yet');
    await typed('quelle est la marge ?'); await click('.nxa [data-act="core-ask"]');
    await tab.waitFor("/marge/i.test(document.querySelector('[data-core-answer] .nxa-q')?.textContent || '')", 10000);
  });
  await check('5. a spoken order is refused (banner); with reading on, the refusal is what is read aloud; stop interrupts it; the written answer stays', async () => {
    await click('[data-act="core-ask-autosend"]'); await click('[data-act="core-ask-speak-toggle"]');
    await click('.nxa-mic'); await tab.waitFor("/J’écoute/.test(document.querySelector('.nxa-mic')?.innerText || '')", 5000);
    await tab.run("window.__voice.say('Nordla, passe la commande de 500 pièces'); await __t.sleep(700); return 1;");
    await tab.waitFor("/Action refusée/.test(document.querySelector('[data-core-answer]')?.innerText || '')", 10000);
    ok(await tab.eval("document.querySelector('[data-core-answer] .nxa-block').getAttribute('role') === 'alert'"), 'the refusal banner is announced');
    ok(await tab.eval("window.__voice.spoken.length === 1 && /^Action refusée/.test(window.__voice.spoken[0]) && !/oui|vous pouvez commander/i.test(window.__voice.spoken[0])"), 'the refusal is read aloud, short, without any authorisation');
    ok(/Arrêter la lecture/.test(await text(tab)), 'a stop button while speaking'); await click('[data-act="core-ask-stop-speech"]');
    ok(await tab.eval("window.__voice.cancels >= 1 && !document.querySelector('[data-act=\"core-ask-stop-speech\"]')"), 'reading interrupted'); ok(/Action refusée/.test(await tab.eval("document.querySelector('[data-core-answer]').innerText")), 'the written answer is still there');
  });
  await check('6. 390 px screenshot of the voice screen; no horizontal scroll', async () => {
    await tab.resize(390, 844); await sleep(300); ok(await tab.eval('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'no horizontal scroll');
    await tab.run("document.querySelector('.nxa').scrollIntoView(); return 1;"); const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, tab.sessionId);
    const dir = 'docs/integration/core-field-assistant-eval/screens'; mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'parle-a-nordla-voix-390px.png'), Buffer.from(shot.data, 'base64'));
  });
  await check('7. microphone refused: a clear alert, no retry loop, the keyboard question still works', async () => {
    await tab.run("window.__voice.mode = 'denied'; window.__voice.starts = 0; return 1;"); await click('.nxa-mic'); await tab.waitFor("/Le micro est refusé/.test(document.body.innerText)", 5000);
    ok(await tab.eval('window.__voice.starts === 1'), 'one attempt, no loop'); ok(await tab.eval("!!document.querySelector('.nxa-voice [role=\"alert\"]')"), 'announced as an alert');
    await typed('quels sont les risques ?'); await click('.nxa [data-act="core-ask"]'); await tab.waitFor("/risques/i.test(document.querySelector('[data-core-answer] .nxa-q')?.textContent || '')", 10000);
  });
  await check('8. no speech recognition in the browser: no microphone button, a sentence pointing to the keyboard key, typing still works', async () => {
    await reload({ nosr: true }); const t = await text(tab);
    ok(await tab.eval("!document.querySelector('.nxa-mic')"), 'no microphone button'); ok(/dictée vocale n’est pas disponible/.test(t) && /touche micro du clavier/.test(t), 'the limit is stated');
    await typed('qu’est-ce qui manque ?'); await click('.nxa [data-act="core-ask"]'); await tab.waitFor("/manque/i.test(document.querySelector('[data-core-answer] .nxa-q')?.textContent || '')", 10000);
  });
  await check('9. network cut: answers stay readable, no microphone offered, back online the screen is complete', async () => {
    await tab.offline(true); await tab.waitFor('window.nordlaSourcing.state().online === false', 15000); await tab.run("document.querySelector('#btn-cases').click(); await __t.sleep(400); return 1;").catch(() => {});
    const t = await tab.eval("(document.querySelector('#overlay') || document.body).innerText"); ok(/Hors ligne/.test(t) && /manque/.test(t), 'previous answers readable with the reason'); ok(await tab.eval("!document.querySelector('#overlay .nxa-mic')"), 'no microphone offline');
    await tab.offline(false); await tab.waitFor('window.nordlaSourcing.state().online === true', 20000);
  });
} finally {
  await browser.close(); await new Promise((r) => proxy.close(r)); proxy.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
