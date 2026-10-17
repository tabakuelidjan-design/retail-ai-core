// REAL-BROWSER proof of the Nordla Design System v1 screen (/nordla) on the hosted server, ISOLATED SYNTHETIC Finance and Analytics data
// (same set-up as nordla-entry.e2e.js: local TLS proxy behaving like Railway -> hosted sourcing server with the identity test doubles;
// nothing reaches the network). What it proves: the screen shows what the server answers and nothing else (status honesty, module states,
// indicator values), Parle à Nordla answers with sources and refuses actions, no horizontal overflow at 360/390/430 px and 1440 px desktop,
// sidebar only on desktop, the 5-entry mobile bar, official icons load, keyboard-reachable controls with names, sign-out -> login state.
// NOT the physical Xiaomi, NOT Railway.   npm run nordla:design:e2e   (NORDLA_E2E_SHOTS=<dir> saves desktop + mobile screenshots)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND: the design e2e was NOT run.'); process.exit(2); }
const results = []; const check = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); } catch (e) { results.push([name, `FAIL: ${e.message}`]); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const M = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OWNER = { id: '00000001-2222-4222-8222-000000000001', email: 'owner@nordla-test.example', password: 'synthetic passphrase for owner' };
const HOST = 'sourcing.nordla-test.example';

const db = createIdentityDb({ merchants: [M], users: [OWNER.id] });
const gotrue = createFakeGoTrue({ users: [OWNER] });
const rlKey = randomBytes(32).toString('hex'); const csrfKey = randomBytes(32).toString('hex');
await createMemberService({ supabase: db.supabase, merchantId: M }).bootstrapOwner({ userId: OWNER.id });
await createModuleProvisioning({ supabase: db.supabase }).enableModule({ merchantId: M, moduleCode: 'sourcing', source: 'provisioning:manual' });
const tmp = mkdtempSync(join(tmpdir(), 'nordla-design-e2e-'));
const proxyPort = await freePort(); const ORIGIN = `https://${HOST}:${proxyPort}`;
const identity = createIdentityService({ merchantId: M, moduleCode: 'sourcing', supabase: db.supabase, auth: { baseUrl: 'https://ref.supabase.example', anonKey: 'anon-test' }, sessions: loadIdentityConfig({}), rateLimits: loadRateLimitConfig({}), rateLimitKey: rlKey, fetchImpl: gotrue.fetchImpl });
const security = createHttpSecurity({ environment: 'hosted', proxy: 'railway', allowedHosts: [`${HOST}:${proxyPort}`], allowedOrigins: [ORIGIN], moduleCode: 'sourcing', csrfKey, rateLimitKey: rlKey, loginTiming: { minMs: 200, jitterMs: 0 } });
const env = { SOURCING_HOSTED: '1', NORDLA_MERCHANT_ID: M, SOURCING_PUBLIC_ORIGIN: `https://${HOST}`, SUPABASE_URL: 'https://ref.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'x', SUPABASE_ANON_KEY: 'anon-test', NORDLA_IDENTITY_RATE_LIMIT_KEY: rlKey, NORDLA_CSRF_KEY: csrfKey, SOURCING_MERCHANT_ID: 'habb', SOURCING_HOST: '127.0.0.1', SOURCING_DATA_DIR: join(tmp, 'data') };
const fw = accWorld({ merchantId: M });
const inv = await fw.supplier(121000, { dueDate: '2026-09-28', supplierName: 'Yiwu Greenline', invoiceNumber: 'YG-1' }); await fw.supplier(48400, { dueDate: '2026-10-08', supplierName: 'Dongguan Pioneer', invoiceNumber: 'DP-7' }); await fw.paySupplier(21000, [[inv.id, 21000]]);
const readers = { finance: createFinanceReader({ store: fw.st, merchantId: M, timeZone: 'Europe/Brussels', now: () => '2026-10-03T10:00:00.000Z', source: 'Finance · données de test isolées' }), analytics: createAnalyticsReader({ reportsDir: await writeDataset(), now: () => AN_NOW, source: 'Analytics · données de test isolées' }) };
const srv = await startSourcingServer({ env, log: () => {}, port: 0, services: { identity, security, readers }, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({}) });

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tmp, 'k.pem'), '-out', join(tmp, 'c.pem'), '-days', '1', '-subj', `/CN=${HOST}`], { stdio: 'ignore' });
const proxy = https.createServer({ key: readFileSync(join(tmp, 'k.pem')), cert: readFileSync(join(tmp, 'c.pem')) }, (req, res) => {
  const up = http.request({ host: '127.0.0.1', port: srv.port, path: req.url, method: req.method, headers: { ...req.headers, host: HOST, 'x-forwarded-host': `${HOST}:${proxyPort}`, 'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.7' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
});
await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));

const HELPERS = `window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }; 'ok'`;
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && document.body.innerText.length > 20", 20000); await t.eval(HELPERS); };
const loaded = (t) => t.waitFor('window.nordlaCore && window.nordlaCore.state().loading === false', 15000);
const browser = await new Browser(exe, null, ['--ignore-certificate-errors', '--no-proxy-server', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`]).launch(); let tab;
console.log(`Browser engine: ${exe}`);

const SHOTS = process.env.NORDLA_E2E_SHOTS || null;
const viewport = (t, width, height, mobile) => t.b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }, t.sessionId);
const shot = async (t, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await sleep(300); const r = await t.b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, t.sessionId); writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64')); };
const go = async (t, hash) => { await t.eval(`location.hash = ${JSON.stringify(hash)}; 1`); await sleep(250); };
const api = (t, p) => t.run(`const r = await fetch(${JSON.stringify(p)}, { credentials: 'same-origin' }); return { status: r.status, body: await r.json().catch(() => null) };`);
const LAYOUT = `(() => { const d = document.documentElement; const sb = document.querySelector('.nd-sidebar'); const mn = document.querySelector('.nd-mnav');
  return { overflow: d.scrollWidth - d.clientWidth, sidebar: !!sb && getComputedStyle(sb).display !== 'none' && sb.getBoundingClientRect().width > 0,
    mnav: !!mn && getComputedStyle(mn).display !== 'none', mnavLinks: mn ? mn.querySelectorAll('a').length : 0,
    wide: [...document.querySelectorAll('#nd-app *')].filter((e) => e.getBoundingClientRect().right > d.clientWidth + 1 && getComputedStyle(e).position !== 'fixed').map((e) => e.className || e.tagName).slice(0, 5) }; })()`;

try {
  await check('1. sign in (field app), open /nordla: dashboard drawn from the server, nothing claimed "Opérationnel" while the backup is not verified', async () => {
    tab = await browser.tab(`${ORIGIN}/`); await ready(tab); await tab.waitFor("!!document.querySelector('#login-email')", 15000);
    await tab.run(`document.querySelector('#login-email').value = ${JSON.stringify(OWNER.email)}; document.querySelector('#login-password').value = ${JSON.stringify(OWNER.password)}; document.querySelector('[data-act="login-go"]').click(); await __t.sleep(1500); return 1;`);
    await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    await tab.goto(`${ORIGIN}/nordla#accueil`); await ready(tab); await loaded(tab);
    const backup = await api(tab, '/healthz/backup');
    ok(backup.body?.status !== 'OK', `test set-up: the backup is not configured here (${JSON.stringify(backup.body)})`);
    const badge = await tab.eval("document.querySelector('.nd-card-head .nd-badge').innerText");
    ok(!/Opérationnel/.test(badge) && /Partiellement vérifié|Core inactif|État non vérifié/.test(badge), `status badge: ${badge}`);
    const shell = (await api(tab, '/shell-manifest.json')).body.files; ok(!shell.some((f) => /nordla-(ds|view|home|mark)|^\/nordla(\.html)?$/.test(f)), `field app offline shell unchanged: ${shell.filter((f) => /nordla/.test(f))}`);
    ok(/Sauvegarde hors serveur/.test(await tab.eval("document.querySelector('[data-nd-system]')?.innerText ?? ''")), 'the missing check is named');
  });
  await check('2. indicators = the server fields; spend IA "Non disponible"; modules = /api/core/modules with their state', async () => {
    const st = (await api(tab, '/api/core/status')).body; const mods = (await api(tab, '/api/core/modules')).body.modules; const dec = (await api(tab, '/api/core/decisions')).body;
    const m = await tab.eval("[...document.querySelectorAll('[data-nd-metric]')].map((e) => [e.querySelector('.nd-metric-label').innerText, e.querySelector('.nd-metric-value').innerText])");
    const val = Object.fromEntries(m);
    if (st.enabled) { ok(val['Décisions à prendre'] === String(st.awaiting_human), `awaiting ${val['Décisions à prendre']} vs ${st.awaiting_human}`); ok(val['Décisions en suivi'] === String(st.in_follow_up), 'in_follow_up'); }
    else ok(val['Décisions à prendre'] === 'Non disponible', 'core off -> Non disponible');
    ok(val['Analyses au journal'] === (Array.isArray(dec?.decisions) ? String(dec.decisions.length) : 'Non disponible'), `journal ${val['Analyses au journal']}`);
    ok(val['Dépenses IA et modèles'] === 'Non disponible', 'no AI spend counter -> Non disponible');
    await go(tab, '#modules');
    const shown = await tab.eval("[...document.querySelectorAll('[data-nd-modules] [data-module]')].map((e) => [e.dataset.module, e.querySelector('.nd-badge').innerText])");
    ok(shown.length === mods.length, `${shown.length} cards vs ${mods.length} modules`);
    for (const x of mods) ok(shown.some(([k, s]) => k === x.key && s === x.state), `module ${x.key} ${x.state} not shown as such: ${JSON.stringify(shown)}`);
  });
  await check('3. Parle à Nordla: a Finance question answered with its source; an action request refused by the server', async () => {
    await go(tab, '#parle');
    await tab.run(`document.getElementById('nd-ask').value = 'quelles factures fournisseurs dois-je payer et quelles sont les échéances ?'; document.querySelector('[data-nd-ask] [type=submit]').click(); await __t.sleep(800); return 1;`);
    await tab.waitFor("!!document.querySelector('[data-nd-answer]') && !window.nordlaCore.state().asking", 10000);
    const a = await tab.eval("document.querySelector('[data-nd-answer]').innerText");
    ok(/Yiwu Greenline/.test(a) && /Sources : .*Finance · données de test isolées/.test(a), a);
    await shot(tab, 'mobile-390-parle');
    await tab.run(`document.getElementById('nd-ask').value = 'paie la facture Yiwu Greenline'; document.querySelector('[data-nd-ask] [type=submit]').click(); await __t.sleep(800); return 1;`);
    await tab.waitFor("(document.querySelector('[data-nd-answer]')?.innerText || '').includes('paie la facture')", 10000);
    const r = await tab.eval("document.querySelector('[data-nd-answer]').innerText");
    ok(/Je ne peux pas faire cela/.test(r), r);
  });
  await check('4. phones 360 / 390 / 430 px: no horizontal overflow, no sidebar, 5-entry bottom bar with Parle à Nordla in the centre', async () => {
    for (const w of [360, 390, 430]) {
      await viewport(tab, w, 860, true);
      for (const h of ['#accueil', '#modules', '#module/finance', '#parle', '#recherche', '#plus']) {
        await go(tab, h); const l = await tab.eval(LAYOUT);
        ok(l.overflow <= 0 && !l.wide.length, `${w}px ${h}: overflow ${l.overflow} ${JSON.stringify(l.wide)}`);
        ok(!l.sidebar && l.mnav && l.mnavLinks === 5, `${w}px ${h}: ${JSON.stringify(l)}`);
      }
      const mid = await tab.eval("[...document.querySelectorAll('.nd-mnav a')][2].classList.contains('is-parle')"); ok(mid, 'Parle à Nordla is the centre entry');
      await go(tab, '#accueil'); await shot(tab, `mobile-${w}-accueil`); await go(tab, '#modules'); await shot(tab, `mobile-${w}-modules`);
    }
  });
  await check('5. desktop 1440 px: sidebar with the validated entries, no bottom bar, no overflow; diagram links only where a screen exists', async () => {
    await viewport(tab, 1440, 960, false); await go(tab, '#accueil');
    const l = await tab.eval(LAYOUT); ok(l.overflow <= 0 && l.sidebar && !l.mnav, JSON.stringify(l));
    const nav = await tab.eval("[...document.querySelectorAll('.nd-sidebar .nd-nav-item')].map((e) => e.childNodes[1]?.textContent?.trim() ?? e.innerText)");
    for (const n of ['Tableau de bord', 'Parle à Nordla', 'China Sourcing', 'Finance', 'Stock & Achats', 'Ventes & CRM', 'Produits', 'Analyses', 'Fournisseurs', 'Conformité', 'Paramètres']) ok(nav.some((x) => x.startsWith(n)), `nav entry ${n} missing: ${nav}`);
    const dead = await tab.eval("[...document.querySelectorAll('.nd-sidebar [aria-disabled=true]')].filter((e) => e.tagName === 'A' || e.hasAttribute('href') || e.tabIndex >= 0).length"); ok(dead === 0, 'disabled entries are not links nor focusable');
    const agents = await tab.eval("document.querySelector('[data-node=agents]').tagName"); ok(agents === 'DIV', 'Agents IA has no destination -> not a link');
    await shot(tab, 'desktop-1440-accueil'); await go(tab, '#module/finance'); await shot(tab, 'desktop-1440-finance'); await go(tab, '#modules'); await shot(tab, 'desktop-1440-modules');
  });
  await check('6. official icons load (none broken); every link/button has a name and is keyboard-reachable with a visible focus', async () => {
    await go(tab, '#accueil');
    await tab.waitFor("[...document.images].every((i) => i.complete)", 10000);
    const broken = await tab.eval("[...document.images].filter((i) => !i.naturalWidth).map((i) => i.src)"); ok(!broken.length, `broken: ${broken}`);
    const unnamed = await tab.eval("[...document.querySelectorAll('#nd-app a, #nd-app button')].filter((e) => !(e.innerText.trim() || e.getAttribute('aria-label') || e.querySelector('img[alt]:not([alt=\"\"])'))).map((e) => e.outerHTML.slice(0, 80))"); ok(!unnamed.length, `unnamed: ${unnamed}`);
    await tab.b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, tab.sessionId); await tab.b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, tab.sessionId);
    const f = await tab.eval("(() => { const e = document.activeElement; return { tag: e.tagName, ring: getComputedStyle(e).boxShadow }; })()");
    ok(['A', 'INPUT', 'BUTTON', 'TEXTAREA'].includes(f.tag) && f.ring !== 'none', `first Tab: ${JSON.stringify(f)}`);
  });
  await check('7. no token in the page; sign-out from Plus -> the screen says "Connexion requise" and shows no module', async () => {
    ok(!/(eyJ|sb_secret|service_role)/.test(await tab.eval('document.documentElement.outerHTML + JSON.stringify(localStorage)')), 'no token of another service');
    await viewport(tab, 390, 860, true); await go(tab, '#plus');
    await tab.run(`document.querySelector('[data-nd-logout]').click(); await __t.sleep(1200); return 1;`);
    await tab.waitFor("document.body.innerText.includes('Connexion requise')", 10000);
    ok(!(await tab.eval("document.querySelectorAll('[data-module]').length")), 'no module after sign-out');
    await shot(tab, 'mobile-390-signed-out');
  });
} finally {
  await browser.close(); await new Promise((r) => proxy.close(r)); proxy.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); srv.server.closeAllConnections?.(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
