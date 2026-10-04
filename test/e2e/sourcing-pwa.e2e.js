// REAL-BROWSER end-to-end of the field application, driven through the DevTools Protocol against a real Edge / Chrome engine (Service Worker, Cache Storage, IndexedDB):
//   install online -> app shell cached -> app CLOSED -> network gone (server stopped AND browser offline) -> browser RESTARTED (cold start) -> installed entry opens ->
//   existing case, calculations, rulebook and Safety Gate copy are there -> edit offline -> network returns -> sync -> server and phone converge; durability and conflicts.
// This is an engine-level proof. It is NOT a physical phone: no touch, camera, install prompt or mobile OS. Run:  npm run sourcing:e2e
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser();
if (!exe) { console.log('NO BROWSER FOUND (Edge / Chrome / Chromium): set SOURCING_E2E_BROWSER. The offline cold-start test was NOT run.'); process.exit(2); }
const TOKEN = 'e2e-field-token-0123456789-abcdef-xyz';
const results = []; const check = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); } catch (e) { results.push([name, `FAIL: ${e.message}`]); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IDX = '<?xml version="1.0"?><Safety-Gate><weeklyReport><reference>Report-2026-39</reference><publicationDate>02/10/2026</publicationDate><URL>https://x.test/api/download/weeklyReport/detail/xml/10000325?language=en,</URL></weeklyReport></Safety-Gate>';
const REP = '<?xml version="1.0"?><alerts><alert><caseNumber>SR/00001/26</caseNumber><category>Electrical appliances</category><product>Power bank</product><brand>Voltix</brand><name>Portable battery charger</name><type_numberOfModel>VX-10K</type_numberOfModel><riskType>Fire</riskType><danger>The lithium battery can overheat.</danger><countryOfOrigin>China</countryOfOrigin><level>Serious risk</level></alert></alerts>';
const fakeFetch = async (u) => ({ ok: true, status: 200, text: async () => (/list\/xml/.test(u) ? IDX : REP) });

const dir = mkdtempSync(join(tmpdir(), 'nordla-e2e-data-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
let server = null;
const startServer = async () => { server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: fakeFetch, ecb: async () => ({ date: '2026-10-02', perEur: { USD: 1.08 } }) }); await server.safety.refresh({ maxReports: 3 }); };
const stopServer = async () => { await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); server = null; };
const api = async (path, opts = {}) => { const r = await fetch(base + path, { ...opts, headers: { 'x-sourcing-token': TOKEN, 'content-type': 'application/json' } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const cases = async () => (await api('/api/cases')).body.cases;

// in-page helpers (re-installed after every navigation)
const HELPERS = `window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), click: (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('missing ' + sel); e.click(); },
  fill: (form, vals) => { const f = document.querySelector('form[data-form="' + form + '"]'); if (!f) throw new Error('no form ' + form); for (const [k, v] of Object.entries(vals)) f.elements[k].value = v; f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); },
  auto: (form, vals) => { const f = document.querySelector('form[data-form="' + form + '"]'); let last; for (const [k, v] of Object.entries(vals)) { f.elements[k].value = v; last = f.elements[k]; } last.dispatchEvent(new Event('change', { bubbles: true })); },
  idb: (key) => new Promise((res, rej) => { const r = indexedDB.open('nordla-sourcing', 1); r.onsuccess = () => { const q = r.result.transaction('blobs').objectStore('blobs').get(key); q.onsuccess = () => res(q.result ?? null); q.onerror = () => rej(q.error); }; r.onerror = () => rej(r.error); }) };
  'ok'`;
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && !!document.querySelector('#tabs') && document.querySelector('#tabs').children.length > 0", 20000); await t.eval(HELPERS); };
const openCase = (t, id) => t.run(`document.querySelector('#btn-cases').click(); await __t.sleep(250); document.querySelector('[data-act="opencase"][data-key="${id}"]').click(); await __t.sleep(400); __t.click('[data-act="tab"][data-key="money"]'); await __t.sleep(300);`);
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);

console.log(`Browser engine: ${exe}`);
await startServer();
let browser = await new Browser(exe).launch(); console.log(`Browser version: ${browser.version}\n`);
const profile = browser.profile; let tab;
let caseName = 'Power bank 10000mAh E2E'; let caseId = null;

await check('1. online install through the pairing link: token taken from the URL fragment, fragment cleared, server reachable', async () => {
  tab = await browser.tab(`${base}/#t=${TOKEN}`); await ready(tab);
  await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
  ok(await tab.eval("location.hash === ''"), 'the token must not stay in the address bar');
  ok(await tab.eval("JSON.parse(localStorage.getItem('nordla.sourcing.token')).length >= 24"), 'token stored');
});

await check('2. service worker installed and the whole app shell + every decision-engine module is in the cache', async () => {
  await tab.waitFor("navigator.serviceWorker.ready.then(() => true)", 20000);
  const m = await (await fetch(`${base}/shell-manifest.json`)).json();
  const n = await tab.waitFor(`caches.keys().then(async (ks) => { let n = 0; for (const k of ks) n += (await (await caches.open(k)).keys()).length; return n >= ${m.files.length} ? n : 0; })`, 20000);
  ok(n >= m.files.length, `cached ${n} of ${m.files.length}`); ok(m.files.includes('/core/rulebook/review.js') && m.files.includes('/storage.js') && m.files.includes('/icon-192.png'), 'manifest completeness');
});

await check('3. manifest + icons are installable (id, scope, standalone, 192/512/maskable PNG) and respond', async () => {
  const mf = await (await fetch(`${base}/manifest.webmanifest`)).json();
  ok(mf.display === 'standalone' && mf.scope === '/' && mf.start_url && mf.id, 'manifest fields');
  const sizes = mf.icons.map((i) => `${i.sizes}/${i.purpose}`); ok(sizes.includes('192x192/any') && sizes.includes('512x512/any') && sizes.includes('512x512/maskable'), sizes.join());
  for (const i of mf.icons) { const r = await fetch(base + i.src); ok(r.status === 200, `${i.src} -> ${r.status}`); if (i.type === 'image/png') ok(Buffer.from(await r.arrayBuffer()).subarray(1, 4).toString() === 'PNG', 'PNG signature'); }
});

await check('4. quick answer: six fields give a preliminary verdict from the SAME engine; the case is created and saved on the phone', async () => {
  await tab.run(`__t.click('[data-act="tab"][data-key="quick"]'); await __t.sleep(200);
    __t.fill('quick', { name: ${JSON.stringify(caseName)}, category: 'power_bank', unitPrice: '4.20', currency: 'USD', moq: '500', qty: '1000', price: '19.99', target: '30', dest: 'own', freight: '600', duty: '2.7', fxRate: '0.92', incoterm: 'FOB' }); await __t.sleep(300); 'ok'`);
  const v = await tab.waitFor("document.querySelector('.verdict .v')?.innerText || ''", 8000); ok(/GO|INFORMATION|INSUFFICIENT/.test(v), `verdict shown: ${v}`);
  const st = JSON.parse(await tab.eval("localStorage.getItem('nordla.sourcing.cases')")); const c = Object.values(st)[0]; caseId = c.id; ok(c.quotes.length === 1 && c.sale?.sellingPriceGross, 'quote and sale stored');
});

await check('5. large phone photo (4000x3000) is kept as evidence, downscaled, in IndexedDB (not in localStorage)', async () => {
  await tab.run(`__t.click('[data-act="tab"][data-key="case"]'); await __t.sleep(250);
    const cv = document.createElement('canvas'); cv.width = 4000; cv.height = 3000; const g = cv.getContext('2d'); for (let i = 0; i < 300; i++) { g.fillStyle = 'hsl(' + (i * 7 % 360) + ',60%,50%)'; g.fillRect(Math.random() * 4000, Math.random() * 3000, 400, 300); }
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.95)); window.__bigBytes = blob.size; const file = new File([blob], 'camera.jpg', { type: 'image/jpeg' });
    const inp = document.querySelector('input[data-act="photo"]'); const dt = new DataTransfer(); dt.items.add(file); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); 'ok'`);
  const url = await tab.waitFor(`__t.idb(${JSON.stringify(`photo:${caseId}.0`)})`, 15000);
  const dims = await tab.eval(`new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.src = ${JSON.stringify(url)}; })`);
  ok(Math.max(...dims) <= 640, `downscaled to ${dims}`); ok(url.length < 250000, `stored size ${url.length}`);
  ok(!(await tab.eval("Object.keys(localStorage).some((k) => /photo/.test(k))")), 'no photo in localStorage');
  ok(await tab.eval('window.__bigBytes') > 200000, 'the source photo was large');
  const flash = await text(tab); ok(/EVIDENCE/.test(flash) && !/AI SUGGESTED/.test(flash), 'a photo is evidence, never an identification');
});

await check('6. Safety Gate copy downloaded to the phone (IndexedDB) and matched locally', async () => {
  await tab.run(`__t.click('[data-act="tab"][data-key="compliance"]'); await __t.sleep(250); __t.click('[data-act="safety"]'); 'ok'`);
  const blob = await tab.waitFor("__t.idb('safety').then((b) => (b && b.alerts && b.alerts.length ? b.alerts.length : 0))", 15000); ok(blob >= 1, 'alerts stored');
  const t = await text(tab); ok(/EU SAFETY GATE/.test(t) && /LIVE VERIFIED/.test(t), 'live while the server is reachable');
});

await check('7. the case reached the server (sync online)', async () => { const t0 = Date.now(); let l; while (Date.now() - t0 < 12000) { l = await cases(); if (l.length === 1 && l[0].name === caseName) break; await sleep(300); } ok(l.length === 1 && l[0].name === caseName, JSON.stringify(l)); });

// ---- the cold start ---------------------------------------------------------------------------------------------------------------------------------------------------------
await check('8. APP CLOSED, SERVER STOPPED, BROWSER RESTARTED: the installed entry opens and shows the case (true cold start)', async () => {
  await tab.close(); await browser.close({ keepProfile: true }); await stopServer();
  let down = false; try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }); } catch { down = true; } ok(down, 'the server must really be down');
  browser = await new Browser(exe, profile).launch();
  tab = await browser.tab('about:blank'); await tab.offline(true); await tab.goto(`${base}/?source=pwa`); await ready(tab);
  const name = await text(tab, '#case-name'); ok(name === caseName, `case name after cold start: "${name}"`);
  ok(await tab.eval("!!navigator.serviceWorker.controller"), 'the page is controlled by the service worker');
  ok(!(await tab.eval("document.body.innerText.includes('ERR_') || document.title === ''")), 'a browser error page was shown');
});

await check('9. offline: calculations, verdict, rulebook (with review dates) and the cached Safety Gate are all accessible; nothing shows LIVE', async () => {
  await tab.run(`__t.click('[data-act="tab"][data-key="decision"]'); await __t.sleep(300); 'ok'`);
  const d = await text(tab); ok(/MAXIMUM PURCHASE PRICE/.test(d) && /AT A GLANCE/.test(d), 'verdict screen'); ok(/CONDITIONAL GO|GO|INFORMATION/.test(d), 'a verdict');
  const badge = await text(tab, '#mode'); const bar = await text(tab, '#statusbar'); ok(badge === 'NO SERVER' && /SAFETY GATE CACHED/.test(bar) && !/LIVE|VERIFIED/.test(`${badge} ${bar}`), `header: ${badge} / ${bar}`);
  await tab.run(`__t.click('[data-act="tab"][data-key="compliance"]'); await __t.sleep(300); 'ok'`);
  const r = await text(tab); ok(/Data\s+CACHED/i.test(r) && !/LIVE VERIFIED/.test(r), 'Safety Gate shown as CACHED'); ok(/rule review/i.test(r), 'rulebook review is visible');
  ok(await tab.eval("[...document.querySelectorAll('#screen details')].some((x) => /consolidated/.test(x.innerText) || /Instruments:/.test(x.innerHTML))"), 'rule instruments and consolidation dates');
  const mx = await tab.run(`document.querySelector('#btn-cases').click(); await __t.sleep(200); document.querySelector('[data-act="what-works"]').click(); await __t.sleep(200); return document.querySelector('#overlay').innerText;`);
  ok(/What works right now/.test(mx) && /NOT reachable/.test(mx) && /AVAILABLE OFFLINE/.test(mx) && /REQUIRES SERVER/.test(mx), 'capability matrix explains the state');
  await tab.eval("document.querySelector('#overlay [data-act=\"close-overlay\"]').click(); 'ok'");
});

await check('10. edit offline: the price changes, the results update in place, the change stays local and is marked as waiting to sync', async () => {
  await tab.run(`__t.click('[data-act="tab"][data-key="money"]'); await __t.sleep(250); 'ok'`);
  const before = await text(tab, '#money-live');
  await tab.run(`__t.auto('quote', { unitPrice: '3.60' }); await __t.sleep(400); 'ok'`);
  const after = await text(tab, '#money-live'); ok(after !== before, 'results strip must change with the supplier price'); ok(/3\.60/.test(after), `strip shows the new price: ${after.slice(0, 120)}`);
  const dirty = JSON.parse(await tab.eval("localStorage.getItem('nordla.sourcing.dirty')")); ok(dirty.includes(caseId), 'case waiting to sync');
  ok((await tab.eval("document.querySelector('#screen form[data-form=\"quote\"] [name=\"unitPrice\"]').value")) === '3.60', 'the field kept its value (no re-render)');
});

await check('11. a case CREATED offline exists and is editable', async () => {
  await tab.run(`document.querySelector('#btn-cases').click(); await __t.sleep(200); document.querySelector('[data-act="newcase"]').click(); await __t.sleep(400);
    __t.click('[data-act="tab"][data-key="quick"]'); await __t.sleep(200); __t.fill('quick', { name: 'Offline case E2E', category: 'household_general', unitPrice: '1.50', currency: 'USD', moq: '1000', qty: '1000', price: '9.99', target: '30', dest: 'own', freight: '300', duty: '3', fxRate: '0.92', incoterm: 'FOB' }); await __t.sleep(300); 'ok'`);
  const st = JSON.parse(await tab.eval("localStorage.getItem('nordla.sourcing.cases')")); ok(Object.values(st).some((c) => c.identity.workingName === 'Offline case E2E'), 'created offline');
});

await check('12. NETWORK RETURNS: both changes sync, server and phone converge, nothing lost, no duplicate', async () => {
  await startServer(); await tab.offline(false);
  for (let i = 0; i < 3; i++) { await tab.eval("window.dispatchEvent(new Event('online')); 'ok'"); await sleep(150); } // repeated reconnects / duplicate sync triggers
  const t0 = Date.now(); let l; while (Date.now() - t0 < 20000) { l = await cases(); if (l.length === 2) break; await sleep(400); } ok(l.length === 2, `cases on the server: ${l.length}`);
  const srv = (await api(`/api/cases/${caseId}`)).body; ok(srv.quotes.at(-1).unitPrice === '3.60', `server has the offline edit: ${srv.quotes.at(-1).unitPrice}`);
  await tab.waitFor("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]').length === 0", 15000);
  const local = JSON.parse(await tab.eval("localStorage.getItem('nordla.sourcing.cases')")); ok(local[caseId].quotes.at(-1).unitPrice === '3.60' && local[caseId].quotes.length === srv.quotes.length, 'phone and server converge');
  await tab.waitFor("document.querySelector('#mode').innerText === 'SERVER VERIFIED' && /SAFETY GATE LIVE/.test(document.querySelector('#statusbar').innerText)", 20000); ok(true, 'verified and live again only after an authenticated check succeeded');
});

await check('13. server RESTART mid-use does not lose the case; an interrupted sync is retried', async () => {
  await stopServer(); await sleep(400); await openCase(tab, caseId); await tab.run(`__t.auto('quote', { unitPrice: '3.55' }); await __t.sleep(100); 'ok'`); await tab.eval("window.dispatchEvent(new Event('online')); 'ok'"); await sleep(1500);
  ok(JSON.parse(await tab.eval("localStorage.getItem('nordla.sourcing.dirty')")).includes(caseId), 'the change waits while the server is down');
  await startServer(); await tab.eval("window.dispatchEvent(new Event('online')); 'ok'");
  const t0 = Date.now(); let q; while (Date.now() - t0 < 20000) { q = (await api(`/api/cases/${caseId}`)).body?.quotes?.at(-1)?.unitPrice; if (q === '3.55') break; await sleep(400); } ok(q === '3.55', `server quote after restart: ${q}`);
});

await check('14. CONFLICT: a case changed on another device is never overwritten; both copies can be kept', async () => {
  const srv = (await api(`/api/cases/${caseId}`)).body; srv.notes.push({ at: new Date().toISOString(), text: 'edited on the other device' });
  const put = await api(`/api/cases/${caseId}`, { method: 'PUT', body: JSON.stringify(srv) }); ok(put.status === 200, 'other device saved');
  await openCase(tab, caseId); await tab.run(`__t.auto('quote', { unitPrice: '3.40' }); await __t.sleep(1800); 'ok'`);
  const menu = await tab.run(`document.querySelector('#btn-cases').click(); await __t.sleep(300); return document.querySelector('#overlay').innerText;`); ok(/Conflict:/.test(menu) && /Nothing was overwritten/.test(menu), 'conflict reported');
  const s2 = (await api(`/api/cases/${caseId}`)).body; ok(s2.notes.some((n) => n.text === 'edited on the other device') && s2.quotes.at(-1).unitPrice !== '3.40', 'the other device\'s evidence is intact on the server');
  await tab.run(`document.querySelector('[data-act="keep-both"]').click(); await __t.sleep(2500);`);
  const l = await cases(); ok(l.length === 3 && l.some((c) => /\(my copy\)/.test(c.name)), `both copies on the server: ${l.map((c) => c.name).join(' | ')}`);
  const mine = (await api(`/api/cases/${l.find((c) => /\(my copy\)/.test(c.name)).id}`)).body; ok(mine.quotes.at(-1).unitPrice === '3.40', 'my edit is preserved in my copy');
});

await check('15. nothing sensitive leaks: no server path or token in any API response; the phone stores only field data (no analytics keys)', async () => {
  const bodies = []; for (const p of ['/api/health', '/api/cases', `/api/cases/${caseId}`, '/api/safety/alerts', '/api/ai/status', '/shell-manifest.json']) bodies.push(JSON.stringify((await api(p)).body));
  const all = bodies.join('\n'); ok(!all.includes(TOKEN) && !all.includes(dir) && !/[A-Z]:\\\\Users/.test(all) && !/node_modules/.test(all), 'a path or secret appeared in a response');
  ok((await fetch(`${base}/api/health`)).status === 401, 'no token = refused (fail closed)'); ok((await fetch(`${base}/src/sourcing/server/app.js`)).status === 404, 'source files are not served');
  const keys = await tab.eval("Object.keys(localStorage)"); ok(keys.every((k) => k.startsWith('nordla.sourcing.')), keys.join()); ok(!(await tab.eval("document.documentElement.innerHTML.includes('google-analytics') || document.querySelectorAll('script[src^=\"http\"]').length > 0")), 'no third-party script');
});

await check('16. layout: every screen fits 375 / 390 / 430 wide, portrait and landscape: no sideways scrolling, tab bar reachable, tap targets large enough', async () => {
  await openCase(tab, caseId);
  const bad = [];
  for (const [w, h] of [[375, 812], [390, 844], [430, 932], [844, 390], [932, 430]]) {
    await tab.resize(w, h); await sleep(300);
    for (const key of ['field', 'quick', 'decision', 'case', 'ask', 'docs', 'compliance', 'market', 'money']) {
      const r = await tab.run(`__t.click('[data-act="tab"][data-key="${key}"]'); await __t.sleep(250);
        const over = [...document.querySelectorAll('#screen *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('table, pre')).length;
        const small = [...document.querySelectorAll('#screen button.btn, #screen .seg button, #tabs button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 36 || r.width < 36); }).length;
        const bar = document.querySelector('#tabs').getBoundingClientRect(); const tabsVisible = bar.bottom <= window.innerHeight + 1 && bar.height > 30;
        return { sideways: document.documentElement.scrollWidth > window.innerWidth + 1, over, small, tabsVisible };`);
      if (r.sideways || r.over || r.small || !r.tabsVisible) bad.push(`${w}x${h} ${key}: ${JSON.stringify(r)}`);
    }
  }
  await tab.resize(390, 844); ok(bad.length === 0, bad.slice(0, 6).join(' | '));
});

await check('17. REGRESSION (physical phone): through a Cloudflare-like HTTPS proxy the server is VERIFIED and the header never says offline; the Safety Gate state is separate and downloads by itself', async () => {
  // a proxy that behaves like the tunnel: the peer is loopback, the Host header is the public name, the client address arrives in cf-connecting-ip
  const FAKE_HOST = 'fake-tunnel-1234.trycloudflare.com'; const dir2 = mkdtempSync(join(tmpdir(), 'nordla-e2e-tunnel-')); const TOKEN2 = 'tunnel-field-token-0123456789-abcdef';
  const srv2 = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN2 }, log: () => {}, port: 0, dir: dir2, fetchImpl: fakeFetch, ecb: async () => ({ date: '2026-10-04', perEur: { USD: 1.08 } }), allowedHosts: [FAKE_HOST] }); await srv2.safety.refresh({ maxReports: 3 });
  const http = await import('node:http');
  const proxy = http.createServer((req, res) => { const up = http.request({ port: srv2.port, host: '127.0.0.1', method: req.method, path: req.url, headers: { ...req.headers, host: FAKE_HOST, 'cf-connecting-ip': '203.0.113.50', 'x-forwarded-proto': 'https', 'cf-ray': 'test-ray' } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); req.pipe(up); up.on('error', () => { res.writeHead(502); res.end(); }); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r)); const pport = proxy.address().port;
  const b2 = await new Browser(exe).launch();
  try {
    const t = await b2.tab(`http://127.0.0.1:${pport}/#t=${TOKEN2}`); await ready(t);
    await t.waitFor("window.nordlaSourcing?.state().online === true", 20000);
    const mode = await text(t, '#mode'); ok(mode === 'SERVER VERIFIED', `header: "${mode}"`);
    const bar = await t.waitFor("document.querySelector('#statusbar')?.innerText.includes('SAFETY GATE') && !document.querySelector('#statusbar').innerText.includes('NONE') ? document.querySelector('#statusbar').innerText : ''", 25000);
    ok(/SAFETY GATE LIVE/.test(bar), `status line: "${bar}"`); ok(!/OFFLINE/i.test(`${mode} ${bar}`), 'nothing says offline while the server is verified');
    const sg = await t.waitFor("__t = window.__t || null, (async () => { const r = indexedDB.open('nordla-sourcing', 1); return await new Promise((res) => { r.onsuccess = () => { const q = r.result.transaction('blobs').objectStore('blobs').get('safety'); q.onsuccess = () => res(q.result && q.result.alerts ? q.result.alerts.length : 0); }; }); })()", 15000); ok(sg >= 1, 'the copy was downloaded without pressing anything');
    // fail closed: a wrong token behind the same proxy is refused and never shown as verified
    await t.eval("localStorage.setItem('nordla.sourcing.token', JSON.stringify('wrong-wrong-wrong-wrong-wrong-xx')); 'ok'"); await t.goto(`http://127.0.0.1:${pport}/`); await t.waitFor("document.querySelector('#screen')?.innerText.length > 0 && !!window.nordlaSourcing", 20000);
    await t.waitFor("window.nordlaSourcing.state().server === 'TOKEN_REFUSED' || /SIGN IN/.test(document.querySelector('#screen').innerText)", 15000);
    const bad = await text(t); const badMode = await text(t, '#mode'); ok(/SIGN IN/.test(bad) || /TOKEN REFUSED/.test(badMode), `a refused token is shown as refused: "${badMode}" / ${bad.slice(0, 40)}`); ok(!/SERVER VERIFIED/.test(badMode), 'never verified with a wrong token');
  } finally { await b2.close(); await new Promise((r) => proxy.close(r)); proxy.closeAllConnections?.(); await new Promise((r) => srv2.server.close(r)); rmSync(dir2, { recursive: true, force: true }); }
});

await check('18. REGRESSION (physical phone, Firefox): a NEW case typed into Quick survives background re-renders; blank freight/duty/FX/Incoterm stay UNKNOWN; a refused server save is visible and loses nothing', async () => {
  const dir3 = mkdtempSync(join(tmpdir(), 'nordla-e2e-quick-')); const TOKEN3 = 'quick-field-token-0123456789-abcdef-x'; const errs = [];
  const srv3 = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN3 }, log: () => {}, port: 0, dir: dir3, fetchImpl: fakeFetch, ecb: async () => ({ date: '2026-10-04', perEur: { USD: 1.08 } }) });
  const b3 = await new Browser(exe).launch(); b3.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
  try {
    const t = await b3.tab(`http://127.0.0.1:${srv3.port}/#t=${TOKEN3}`); await ready(t); await t.waitFor('window.nordlaSourcing?.state().server === "VERIFIED"', 20000);
    const QUICK = { name: 'Power bank', category: 'power_bank', unitPrice: '8', currency: 'USD', moq: '100', qty: '100', price: '21', target: '30', dest: 'own', freight: '', duty: '', fxRate: '', incoterm: '' };
    const typed = `const f = document.querySelector('form[data-form="quick"]'); for (const [k, v] of Object.entries(${JSON.stringify(QUICK)})) f.elements[k].value = v;`;
    const values = () => t.eval(`JSON.stringify(Object.fromEntries([...document.querySelector('form[data-form="quick"]').elements].filter((e) => e.name).map((e) => [e.name, e.value])))`);
    await t.run(`document.querySelector('#btn-cases').click(); await __t.sleep(300); __t.click('[data-act="newcase"]'); await __t.sleep(300); __t.click('[data-act="tab"][data-key="quick"]'); await __t.sleep(300); ${typed} 'ok'`);
    // what happens by itself on a phone while the owner is typing: a connection blip (offline/online events), a status re-check, the Safety Gate download
    await t.run(`window.dispatchEvent(new Event('offline')); await __t.sleep(200); window.dispatchEvent(new Event('online')); await __t.sleep(1500); 'ok'`);
    await t.eval(`document.querySelector('[data-act="safety"]')?.click(); 'ok'`); await new Promise((r) => setTimeout(r, 1500));
    const kept = JSON.parse(await values()); for (const [k, v] of Object.entries(QUICK)) ok(kept[k] === v, `typed field "${k}" was wiped by a background re-render: "${kept[k]}" instead of "${v}"`);
    // submit: the case is kept, the verdict is fail-closed, nothing is invented
    await t.run(`document.querySelector('form[data-form="quick"] button.btn').click(); await __t.sleep(1200); 'ok'`);
    const head = await text(t, '#case-name'); ok(head === 'Power bank', `case name after submit: "${head}"`);
    const v = await text(t, '.verdict'); ok(/INSUFFICIENT INFORMATION/.test(v) && /Max purchase price: UNKNOWN/.test(v) && /landed UNKNOWN/.test(v), `verdict: ${v.slice(0, 200)}`);
    const after = JSON.parse(await values()); ok(after.name === 'Power bank' && after.unitPrice === '8' && after.moq === '100' && after.price === '21' && after.freight === '' && after.duty === '' && after.fxRate === '' && after.incoterm === '', `form after submit: ${JSON.stringify(after)}`);
    const saved = await t.eval(`(() => { const all = JSON.parse(localStorage.getItem('nordla.sourcing.cases')); const c = Object.values(all).find((x) => x.identity.workingName === 'Power bank'); return JSON.stringify({ q: c.quotes.at(-1), freight: c.costs.costs?.freight ?? null, duty: c.customs?.duty ?? null, fx: c.costs.fx ?? null }); })()`);
    const sv = JSON.parse(saved); ok(sv.q.unitPrice === '8' && sv.q.incoterm === null && sv.freight === null && sv.duty === null && sv.fx === null, `stored case: ${saved}`);
    // the server REFUSES the save: the case stays on the phone, the screen does not reset
    await t.eval(`(() => { const of = window.fetch; window.fetch = (u, o) => (String(u).includes('/api/cases/') && o?.method === 'PUT') ? Promise.resolve(new Response(JSON.stringify({ error: 'refused' }), { status: 500 })) : of(u, o); })(); 'ok'`);
    await t.run(`const f = document.querySelector('form[data-form="quick"]'); f.elements.unitPrice.value = '7.5'; f.elements.name.value = 'Power bank v2'; f.querySelector('button.btn').click(); await __t.sleep(2500); 'ok'`);
    ok((await text(t, '#case-name')) === 'Power bank v2', 'the case must stay on screen when the server refuses the save');
    ok(JSON.parse(await values()).unitPrice === '7.5', 'the entered price must survive a refused server save');
    ok(await t.eval(`Object.values(JSON.parse(localStorage.getItem('nordla.sourcing.cases'))).some((x) => x.identity.workingName === 'Power bank v2' && x.quotes.at(-1).unitPrice === '7.5')`), 'the edit must be kept on the phone');
    ok(errs.length === 0, `uncaught client errors: ${errs.join(' | ')}`);
  } finally { await b3.close(); await new Promise((r) => srv3.server.close(r)); rmSync(dir3, { recursive: true, force: true }); }
});

await tab.close(); await browser.close(); if (server) await stopServer(); rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
