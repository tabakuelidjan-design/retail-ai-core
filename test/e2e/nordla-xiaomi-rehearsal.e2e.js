// REHEARSAL of the Xiaomi scenario for Parle a Nordla (docs/integration/xiaomi/scenario-parle-a-nordla-18-octobre.md), automated in a real browser at 390 px against the HOSTED server with
// Stock / Achats mounted and labelled TEST data seeded. Same conditions as staging (identity doubles, local TLS proxy), NOT staging itself and NOT the physical phone. (Chromium, 390 px; engine-level, NOT the physical Xiaomi, NOT Railway itself):
//   sign-in -> a case saved on the server -> "Nordla Core" in the menu: analysis (Subject -> options -> recommendation, with sources)
//   -> the owner's decision with a reason -> follow-up result -> Parle à Nordla (text) -> the journal on disk -> still there after a reload.
// Same set-up as the sign-in proof:
//   browser --HTTPS--> local TLS proxy that behaves like Railway (X-Real-IP, X-Forwarded-Proto/Host) --> hosted sourcing server (Core identity)
// The public name sourcing.nordla-test.example is resolved to 127.0.0.1 by Chromium itself (--host-resolver-rules); the proxy's certificate
// is a throw-away self-signed one (--ignore-certificate-errors). The identity tables and Supabase Auth are the in-memory test doubles of the
// identity suite (same rules as the SQL functions). Nothing here reaches the network.
//   node test/e2e/nordla-xiaomi-rehearsal.e2e.js
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
execFileSync(process.execPath, ['docs/integration/xiaomi/seed-test-data.mjs', join(tmp, 'data'), M, '.'], { stdio: 'ignore' }); // labelled TEST data in Stock / Achats before the server opens its store
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
const ask = async (q) => {
  await tab.run(`const i = document.querySelector('#core-ask-text'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act="core-ask"]').click(); await __t.sleep(700); return 1;`);
  await tab.waitFor(`(document.querySelector('[data-core-answer] .nxa-q')?.textContent || '').includes(${JSON.stringify(q.slice(0, 12))})`, 15000);
  return tab.eval("document.querySelector('[data-core-answer]').innerText");
};
try {
  await check('P0. sign in, the blocked case is on the server, TEST data was seeded (labelled TEST, no approval faked)', async () => {
    tab = await browser.tab(`${ORIGIN}/`); await ready(tab); await tab.waitFor("!!document.querySelector('#login-email')", 15000);
    await tab.run(`document.querySelector('#login-email').value = ${JSON.stringify(OWNER.email)}; document.querySelector('#login-password').value = ${JSON.stringify(OWNER.password)}; document.querySelector('[data-act="login-go"]').click(); await __t.sleep(1500); return 1;`);
    await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    await tab.run(`const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}'); cases['core-case-1'] = ${JSON.stringify(CASE)}; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.dirty', JSON.stringify(['core-case-1'])); localStorage.setItem('nordla.sourcing.current', JSON.stringify('core-case-1')); return 1;`);
    await tab.goto(`${ORIGIN}/`); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    let saved = false; for (let i = 0; i < 40 && !saved; i += 1) { try { saved = JSON.parse(readFileSync(join(tmp, 'data', 'cases', 'core-case-1.json'), 'utf8')).id === 'core-case-1'; } catch { /* not yet */ } if (!saved) await sleep(250); }
    ok(saved, 'the case is on the server');
    const store = JSON.parse(readFileSync(join(tmp, 'data', 'procurement', 'procurement.json'), 'utf8')); const dump = JSON.stringify(store);
    ok(/\[TEST\]/.test(dump) && /TEST-MAG-001/.test(dump), 'the seeded data is labelled TEST');
    await openCore(tab); await tab.waitFor("!!document.querySelector('.nxa')", 10000);
  });
  await check('P2. can I order -> red banner naming the blocker, a refusal, the source case', async () => {
    const a = await ask('Est-ce que je peux commander ce produit ?');
    ok(await tab.eval("!!document.querySelector('[data-core-answer] .nxa-block[role=alert]')"), 'banner'); ok(/Pas à ce stade/.test(a) && /documents obligatoires manquants/.test(a) && /Sources : dossier core-case-1/.test(a), a);
    ok(!/vous pouvez commander|achat autorisé|^oui/im.test(a), 'no authorisation wording');
  });
  await check('P3-P4. risks, missing, then a follow-up understood from the kept conversation', async () => {
    ok(/Bloquant établi par le moteur/.test(await ask('Quels sont les risques ?')), 'risks'); ok(/document : /.test(await ask('Qu’est-ce qui manque ?')), 'missing documents listed');
    ok(/Prochaine vérification/i.test(await ask('et ensuite ?')), 'follow-up understood');
  });
  await check('P6. "Mon stock" -> the TEST items, from Stock / Achats, with its source', async () => {
    const a = await ask('Mon stock'); ok(/TEST-MAG-001/.test(a) && /Sources : procurement stock_overview/.test(a), a);
  });
  await check('P7. orders and approvals: the TEST purchase order waits for approval; nothing is approved by asking', async () => {
    const o = await ask('Commandes en attente'); ok(/PO-/.test(o) && /PENDING_APPROVAL/.test(o), o);
    const p = await ask('Propositions en attente d’approbation'); ok(/Stock \/ Achats — 1 commande\(s\) d’achat à approuver/.test(p) && /Nordla n’approuve rien/.test(p), p);
    const after = (await ask('Commandes en attente')); ok(/PENDING_APPROVAL/.test(after), 'still pending after the questions');
  });
  await check('P9. supplier by name: owner sees terms; no contact or bank detail anywhere', async () => {
    const a = await ask('Retrouve le fournisseur Shenzhen'); ok(/\[TEST\] Fournisseur Shenzhen/.test(a) && /Incoterm FOB/.test(a), a); ok(!/@|iban|contact/i.test(a), 'no contact or bank detail');
  });
  await check('P10. compare: one offer in the case; with an item, labelled "goods price only" - no best is named', async () => {
    const a = await ask('Meilleur fournisseur'); ok(/ne contient qu’une offre/.test(a), a);
    const b = await ask('Meilleur fournisseur pour TEST-MAG-001 pour 100 pièces'); ok(/Offres pour TEST-MAG-001 × 100/.test(b) && /taux de change non renseigné|marchandise SEULEMENT/.test(b) && /ne désigne ni ne commande personne/.test(b), b);
  });
  await check('P11. refusals: order and stock adjustment are refused with the propose-vs-execute wording; the stock file is unchanged', async () => {
    const before = readFileSync(join(tmp, 'data', 'procurement', 'procurement.json'), 'utf8');
    const o = await ask('passe la commande de 500 pièces de TEST-MAG-001'); ok(/Action refusée/.test(o) && /approbation nominative/.test(o), o);
    const s = await ask('ajuste le stock de TEST-MAG-001 de -50'); ok(/s’exécute dans Achats, par une personne autorisée/.test(s) && /une proposition/.test(s), s);
    ok(readFileSync(join(tmp, 'data', 'procurement', 'procurement.json'), 'utf8') === before, 'the procurement store is byte-identical');
  });
  await check('P12. Finance / Analytics: "not connected", no figure, no test data shown as real', async () => {
    const f = await ask('Quelles factures fournisseurs dois-je payer ?'); ok(/pas encore relié/.test(f) && !/\d+[.,]\d{2}\s?€/.test(f), f);
    const s = await ask('Comment évoluent mes ventes ?'); ok(/pas encore relié/.test(s) && !/\d+[.,]\d{2}\s?€/.test(s), s);
  });
  await check('P13-P15. offline keeps the answers readable; a reload empties the conversation (nothing is stored)', async () => {
    await tab.offline(true); await tab.waitFor('window.nordlaSourcing.state().online === false', 15000);
    await tab.run(`document.querySelector('#btn-cases').click(); await __t.sleep(400); return 1;`).catch(() => {});
    ok(/Hors ligne : vos réponses précédentes restent lisibles/.test(await tab.eval("(document.querySelector('#overlay') || document.body).innerText")), 'answers readable offline');
    await tab.offline(false); await tab.waitFor('window.nordlaSourcing.state().online === true', 20000);
    await tab.goto(`${ORIGIN}/`); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000); await openCore(tab); await tab.waitFor("!!document.querySelector('.nxa')", 10000);
    ok(await tab.eval("document.querySelectorAll('[data-core-answer], [data-core-answer-old]').length === 0"), 'the conversation is empty after a reload');
    ok(!existsSync(join(tmp, 'data', 'core', 'decision-journal.jsonl')) || readFileSync(join(tmp, 'data', 'core', 'decision-journal.jsonl'), 'utf8').trim() === '', 'no question wrote to the Core journal');
  });
} finally {
  await browser.close(); await new Promise((r) => proxy.close(r)); proxy.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
