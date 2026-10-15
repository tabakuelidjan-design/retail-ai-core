// REAL-BROWSER proof of the data path from the temporary tunnel address to the permanent address (app.nordla.app): what is on the phone today is
// kept, and it can be carried to the new address without loss. Engine-level proof only (Chromium, 390 px); it is NOT the physical Xiaomi.
//   Origin A = http://127.0.0.1:<port>  stands for the current tunnel address (where the phone's cases and photos live today)
//   Origin B = http://localhost:<port>  stands for the new permanent address (a different origin: its storage starts EMPTY)
// Same browser, same profile, two origins: exactly the situation of the phone when the address changes. Nothing here deletes anything.
//   npm run sourcing:e2e:migration
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { newCase, dispatch } from '../../src/sourcing/core/case.js';
import { MAX_IMPORT_BYTES } from '../../src/sourcing/core/recovery.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND: the origin-migration e2e was NOT run.'); process.exit(2); }
const TOKEN = 'e2e-migration-token-0123456789-abcdef-xyz';
const results = []; const check = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); } catch (e) { results.push([name, `FAIL: ${e.message}`]); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const T0 = new Date('2026-10-18T08:00:00Z');

// The phone's case, as the app stores it: a supplier note, two product photos and one document photo (never synced: the photos only live on the phone).
let kase = newCase({ id: 'xiaomi-case-1', name: 'gourde isotherme', now: T0 });
kase = dispatch(kase, { type: 'SUPPLIER', supplier: { name: 'Yiwu Bottle Co' } }, T0);
kase = dispatch(kase, { type: 'CONVERSATION_START', supplierRef: 'Yiwu Bottle Co', lang: 'auto' }, T0);
kase = dispatch(kase, { type: 'CONVERSATION_ITEM', convId: kase.conversations.at(-1).id, speaker: 'supplier', lang: 'auto', text: 'prix 3.2$, MOQ 500, inox 304, 500 ml' }, T0);
kase = dispatch(kase, { type: 'PHOTO', ref: 'photo-0', note: 'face.jpg' }, T0);
kase = dispatch(kase, { type: 'PHOTO', ref: 'photo-1', note: 'dos.jpg' }, T0);
kase = { ...kase, documents: [...(kase.documents ?? []), { id: 'doc-1', fileName: 'devis.jpg', text: '', textSource: 'PHOTO_ONLY', photoRef: 'docphoto-doc-1' }] };

const dir = mkdtempSync(join(tmpdir(), 'nordla-mig-e2e-')); const port = await freePort();
const A = `http://127.0.0.1:${port}`; const B = `http://localhost:${port}`;
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }), ecb: async () => ({ date: '2026-10-02', perEur: { USD: 1.08 } }) });

const HELPERS = `window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }; 'ok'`;
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && document.body.innerText.length > 20", 20000); await t.eval(HELPERS); };
const phoneCases = (t) => t.eval("Object.values(JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}'))");
const blob = (t, key) => t.eval(`new Promise((res) => { const r = indexedDB.open('nordla-sourcing', 1); r.onupgradeneeded = () => r.result.createObjectStore('blobs'); r.onsuccess = () => { const q = r.result.transaction('blobs').objectStore('blobs').get(${JSON.stringify(key)}); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); }; r.onerror = () => res(null); })`);
const sha = (t, text) => t.eval(`crypto.subtle.digest('SHA-256', new TextEncoder().encode(${JSON.stringify(text)})).then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''))`);
const openMenu = (t) => t.run(`(document.querySelector('[data-act="fm-menu"]') ?? document.querySelector('#btn-cases')).click(); await __t.sleep(400); return 1;`);
const KEYS = ['photo:xiaomi-case-1.0', 'photo:xiaomi-case-1.1', 'docphoto:xiaomi-case-1.doc-1'];

console.log(`Browser engine: ${exe}`);
const browser = await new Browser(exe).launch(); let a; let b; let exported = null; const shaA = {};
try {
  await check('1. ORIGIN A (today\'s tunnel address) holds a case and three real JPEG photos, stored the way the app stores them (localStorage + IndexedDB)', async () => {
    a = await browser.tab(`${A}/#t=${TOKEN}`); await ready(a);
    // three real photos drawn by the browser (noise, so the JPEGs have a realistic size), written through the app's own storage module
    await a.run(`const s = await import('/storage.js'); await s.initStorage();
      const jpeg = (w, h, seed) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); const d = g.createImageData(w, h); let x = seed; for (let i = 0; i < d.data.length; i += 4) { x = (x * 1103515245 + 12345) & 0x7fffffff; d.data[i] = x & 255; d.data[i + 1] = (x >> 8) & 255; d.data[i + 2] = (x >> 16) & 255; d.data[i + 3] = 255; } g.putImageData(d, 0, 0); return c.toDataURL('image/jpeg', 0.7); };
      await s.putBlob('photo:xiaomi-case-1.0', jpeg(640, 480, 1)); await s.putBlob('photo:xiaomi-case-1.1', jpeg(640, 480, 2)); await s.putBlob('docphoto:xiaomi-case-1.doc-1', jpeg(1200, 1600, 3));
      const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}'); cases['xiaomi-case-1'] = ${JSON.stringify(kase)};
      localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.current', JSON.stringify('xiaomi-case-1')); return 1;`);
    await a.goto(`${A}/`); await ready(a);
    ok((await phoneCases(a)).some((c) => c.id === 'xiaomi-case-1'), 'the case is on origin A');
    for (const k of KEYS) { const v = await blob(a, k); ok(typeof v === 'string' && v.startsWith('data:image/jpeg'), `${k} on origin A`); shaA[k] = await sha(a, v); }
  });

  await check('2. ORIGIN B (the new address) starts EMPTY: nothing of origin A is visible there (why a new address needs a migration)', async () => {
    b = await browser.tab(`${B}/#t=${TOKEN}`); await ready(b);
    ok(!(await phoneCases(b)).some((c) => c.id === 'xiaomi-case-1'), 'the case is NOT on origin B');
    for (const k of KEYS) ok((await blob(b, k)) === null, `${k} is NOT on origin B`);
  });

  await check('3. the REAL export button on origin A produces one file holding the case and its three photos', async () => {
    // the button builds a Blob, makes an object URL and clicks a download link (then revokes the URL): keep the Blob and the file name, skip the real download
    await a.run(`window.__dl = null; window.__blob = null; const mk = URL.createObjectURL.bind(URL); URL.createObjectURL = (b) => { window.__blob = b; return mk(b); }; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl = { name: this.download }; return; } return orig.call(this); }; return 1;`);
    await openMenu(a);
    await a.run(`const btn = [...document.querySelectorAll('[data-act="export"]')].find((x) => x.offsetParent !== null) ?? document.querySelector('[data-act="export"]'); btn.click(); await __t.sleep(600); return 1;`);
    const dl = await a.eval('window.__dl'); ok(dl && /nordla-case-xiaomi-case-1\.json$/.test(dl.name), `an export file was produced (${JSON.stringify(dl)})`);
    exported = await a.eval('window.__blob.text()');
    const doc = JSON.parse(exported); ok(doc.format === 'nordla-case-export' && doc.case.id === 'xiaomi-case-1', 'export format');
    const said = await a.eval("document.querySelector('#overlay')?.innerText || ''"); ok(/3 photo\(s\) sur 3/.test(said) && !/ATTENTION/.test(said), `the screen states the photo count of the file: ${said.slice(0, 200)}`);
    ok(KEYS.every((k) => typeof doc.photos[k] === 'string'), `the three photos are in the file (${Object.keys(doc.photos).join(', ')})`);
    console.log(`      export size: ${Math.round(exported.length / 1024)} KB (import limit ${Math.round(MAX_IMPORT_BYTES / 1024)} KB)`);
  });

  await check('4. importing that file on origin B restores the case whole and every photo BYTE FOR BYTE', async () => {
    await openMenu(b);
    await b.run(`const f = new File([${JSON.stringify(exported)}], 'nordla-case-xiaomi-case-1.json', { type: 'application/json' }); const dt = new DataTransfer(); dt.items.add(f); const i = document.querySelector('input[data-act="rec-file"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(1200); return 1;`);
    const got = (await phoneCases(b)).find((c) => c.id === 'xiaomi-case-1'); ok(got, 'the case arrived on origin B');
    ok(got.conversations?.[0]?.items?.[0]?.original === kase.conversations[0].items[0].original, 'the supplier note is intact');
    ok((got.identity?.photos ?? []).length === 2 && (got.documents ?? []).some((d) => d.id === 'doc-1'), 'photo and document references intact');
    for (const k of KEYS) { const v = await blob(b, k); ok(typeof v === 'string', `${k} restored on origin B`); ok((await sha(b, v)) === shaA[k], `${k} identical (sha256)`); }
  });

  await check('5. the OLD installation is untouched: origin A still holds the case and the same three photos', async () => {
    await a.goto(`${A}/`); await ready(a);
    ok((await phoneCases(a)).some((c) => c.id === 'xiaomi-case-1'), 'the case is still on origin A');
    for (const k of KEYS) ok((await sha(a, await blob(a, k))) === shaA[k], `${k} unchanged on origin A`);
  });

  await check('6. importing the same file again on origin B creates no duplicate', async () => {
    await openMenu(b);
    await b.run(`const f = new File([${JSON.stringify(exported)}], 'again.json', { type: 'application/json' }); const dt = new DataTransfer(); dt.items.add(f); const i = document.querySelector('input[data-act="rec-file"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(1000); return 1;`);
    ok((await phoneCases(b)).filter((c) => c.id.startsWith('xiaomi-case-1')).length === 1, 'still one copy');
  });

  await check('7. the owner\'s "Sauvegarder sur le serveur" (origin A): the case JSON carries no image; its photos are stored separately, byte for byte', async () => {
    await a.goto(`${A}/`); await ready(a); await a.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    await openMenu(a); await a.run(`document.querySelector('[data-act="backup-all"]').click(); await __t.sleep(1500); return 1;`);
    let photos = []; for (let k = 0; k < 60 && photos.length < 3; k += 1) { photos = (await (await fetch(`${A}/api/cases/xiaomi-case-1/photos`, { headers: { 'x-sourcing-token': TOKEN } })).json()).photos ?? []; if (photos.length < 3) await new Promise((r) => setTimeout(r, 250)); }
    const back = await (await fetch(`${A}/api/cases/xiaomi-case-1`, { headers: { 'x-sourcing-token': TOKEN } })).json();
    ok(back.id === 'xiaomi-case-1' && !/data:image\//.test(JSON.stringify(back)), 'the case is on the server, without image data inside');
    ok(photos.length === 3, `the three photos are on the server (${photos.length})`);
    for (const k of KEYS) { const g = await (await fetch(`${A}/api/cases/xiaomi-case-1/photos/${encodeURIComponent(k)}`, { headers: { 'x-sourcing-token': TOKEN } })).json(); ok(g.dataUrl === await blob(a, k), `${k}: the server copy equals the phone copy`); }
  });
} finally {
  await browser.close(); await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
