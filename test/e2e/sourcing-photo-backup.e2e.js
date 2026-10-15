// REAL-BROWSER proof of the server backup of photos (Chromium, 390 px; engine-level, NOT the physical Xiaomi):
//   1. a phone holds a case that was NEVER synced and three photos that exist only on the phone (the situation found on the Xiaomi);
//   2. once the server is verified, the automatic backup creates NO case by itself (the existing rule); the owner's "Sauvegarder sur le serveur"
//      sends the case and its three photos, byte for byte; afterwards the photos of a case already on the server are backed up automatically;
//   3. the phone keeps everything (nothing deleted, nothing marked as changed);
//   4. a brand-new address (empty storage) recovers the case FROM THE SERVER with its three photos, byte for byte, without any file;
//   5. a different photo already on the server under the same key is never written over: the backup reports the conflict, both copies stay.
//   npm run sourcing:e2e:photos
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { newCase, dispatch } from '../../src/sourcing/core/case.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND: the photo-backup e2e was NOT run.'); process.exit(2); }
const TOKEN = 'e2e-photo-backup-token-0123456789-abcdef';
const results = []; const check = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); } catch (e) { results.push([name, `FAIL: ${e.message}`]); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const T0 = new Date('2026-10-18T08:00:00Z');
let kase = newCase({ id: 'xiaomi-photos-1', name: 'lampe frontale', now: T0 });
kase = dispatch(kase, { type: 'SUPPLIER', supplier: { name: 'Ningbo Light' } }, T0);
kase = dispatch(kase, { type: 'PHOTO', ref: 'photo-0', note: 'face.jpg' }, T0);
kase = dispatch(kase, { type: 'PHOTO', ref: 'photo-1', note: 'dos.jpg' }, T0);
kase = { ...kase, documents: [...(kase.documents ?? []), { id: 'doc-1', fileName: 'devis.jpg', text: '', textSource: 'PHOTO_ONLY', photoRef: 'docphoto-doc-1' }] };
const KEYS = ['photo:xiaomi-photos-1.0', 'photo:xiaomi-photos-1.1', 'docphoto:xiaomi-photos-1.doc-1'];
const shaOfDataUrl = (d) => createHash('sha256').update(Buffer.from(d.split(',')[1], 'base64')).digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'nordla-photo-e2e-')); const port = await freePort();
const A = `http://127.0.0.1:${port}`; const B = `http://localhost:${port}`;
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }), ecb: async () => ({ date: '2026-10-02', perEur: { USD: 1.08 } }) });
const api = async (path, opts = {}) => { const r = await fetch(A + path, { ...opts, headers: { 'x-sourcing-token': TOKEN, 'content-type': 'application/json' } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELPERS = `window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }; 'ok'`;
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && document.body.innerText.length > 20", 20000); await t.eval(HELPERS); };
const phoneCases = (t) => t.eval("Object.values(JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}'))");
const blob = (t, key) => t.eval(`new Promise((res) => { const r = indexedDB.open('nordla-sourcing', 1); r.onupgradeneeded = () => r.result.createObjectStore('blobs'); r.onsuccess = () => { const q = r.result.transaction('blobs').objectStore('blobs').get(${JSON.stringify(key)}); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); }; r.onerror = () => res(null); })`);
const openMenu = (t) => t.run(`(document.querySelector('[data-act="fm-menu"]') ?? document.querySelector('#btn-cases')).click(); await __t.sleep(400); return 1;`);
const click = (t, sel) => t.run(`document.querySelector(${JSON.stringify(sel)}).click(); await __t.sleep(700); return 1;`);

console.log(`Browser engine: ${exe}`);
const browser = await new Browser(exe).launch(); let a; let b; const phoneSha = {};
try {
  await check('1. the phone holds a NEVER-synced case and three photos that exist only on the phone; the server has neither', async () => {
    a = await browser.tab(`${A}/`); await ready(a); // no token yet: the phone works alone, as before pairing
    await a.run(`const s = await import('/storage.js'); await s.initStorage();
      const jpeg = (w, h, seed) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); const d = g.createImageData(w, h); let x = seed; for (let i = 0; i < d.data.length; i += 4) { x = (x * 1103515245 + 12345) & 0x7fffffff; d.data[i] = x & 255; d.data[i + 1] = (x >> 8) & 255; d.data[i + 2] = (x >> 16) & 255; d.data[i + 3] = 255; } g.putImageData(d, 0, 0); return c.toDataURL('image/jpeg', 0.7); };
      await s.putBlob('photo:xiaomi-photos-1.0', jpeg(640, 480, 11)); await s.putBlob('photo:xiaomi-photos-1.1', jpeg(640, 480, 12)); await s.putBlob('docphoto:xiaomi-photos-1.doc-1', jpeg(1200, 1600, 13));
      const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}'); cases['xiaomi-photos-1'] = ${JSON.stringify(kase)};
      localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.current', JSON.stringify('xiaomi-photos-1')); localStorage.setItem('nordla.sourcing.dirty', '[]'); return 1;`);
    for (const k of KEYS) { const v = await blob(a, k); ok(typeof v === 'string', k); phoneSha[k] = shaOfDataUrl(v); }
    ok((await api('/api/cases/xiaomi-photos-1')).status === 404, 'the server does not have the case');
  });

  await check('2a. paired with the server, the AUTOMATIC backup creates no case by itself (only what the owner changed is ever sent)', async () => {
    await a.close?.(); a = await browser.tab(`${A}/#t=${TOKEN}`); await ready(a); await a.waitFor('window.nordlaSourcing?.state().online === true', 15000); // a fresh load reads the pairing link
    let rep = null; for (let i = 0; i < 40 && !rep; i += 1) { rep = await a.eval("JSON.parse(localStorage.getItem('nordla.sourcing.backup') || 'null')"); if (!rep) await sleep(250); }
    ok(rep && rep.notSent >= 1 && rep.byOwner === false, `the automatic run reports the never-sent case as waiting (${JSON.stringify(rep)})`);
    ok((await api('/api/cases/xiaomi-photos-1')).status === 404, 'no case was created on the server without the owner');
  });

  await check('2b. the owner taps "Sauvegarder sur le serveur": the case and its three photos are on the server, byte-identical', async () => {
    await openMenu(a); ok(/Sauvegarde sur le serveur/.test(await a.eval("document.querySelector('#overlay').innerText")), 'the section is in the menu');
    await click(a, '[data-act="backup-all"]');
    let list = []; for (let i = 0; i < 60 && list.length < 3; i += 1) { list = (await api('/api/cases/xiaomi-photos-1/photos')).body.photos ?? []; if (list.length < 3) await sleep(250); }
    ok((await api('/api/cases/xiaomi-photos-1')).status === 200, 'the case is on the server');
    ok(list.length === 3, `three photos on the server (${list.length})`);
    for (const k of KEYS) { const g = await api(`/api/cases/xiaomi-photos-1/photos/${encodeURIComponent(k)}`); ok(g.status === 200 && shaOfDataUrl(g.body.dataUrl) === phoneSha[k] && g.body.sha256 === phoneSha[k], `${k} identical on the server`); }
    await sleep(500); ok(/Dernière vérification/.test(await a.eval("document.querySelector('#overlay').innerText")), 'the owner sees the result');
  });

  await check('3. the phone keeps everything: the case, the three photos, and nothing is marked as changed by the backup', async () => {
    ok((await phoneCases(a)).some((c) => c.id === 'xiaomi-photos-1'), 'case still on the phone');
    for (const k of KEYS) ok(shaOfDataUrl(await blob(a, k)) === phoneSha[k], `${k} still on the phone, unchanged`);
    ok((await a.eval("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]').length")) === 0, 'nothing marked');
    ok((await a.eval("JSON.parse(localStorage.getItem('nordla.sourcing.backup') || 'null')?.ok")) === true, 'the backup reports success');
  });

  await check('4. a NEW address (empty storage) recovers the case from the server WITH its three photos, byte for byte, no file needed', async () => {
    b = await browser.tab(`${B}/#t=${TOKEN}`); await ready(b); await b.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    ok(!(await phoneCases(b)).some((c) => c.id === 'xiaomi-photos-1'), 'empty at first');
    await openMenu(b); await click(b, '[data-act="rec-list"]'); await click(b, 'input[data-key="xiaomi-photos-1"]'); await click(b, '[data-act="rec-go"]');
    await sleep(800);
    ok((await phoneCases(b)).some((c) => c.id === 'xiaomi-photos-1'), 'the case is back');
    for (const k of KEYS) { const v = await blob(b, k); ok(typeof v === 'string' && shaOfDataUrl(v) === phoneSha[k], `${k} back, identical`); }
  });

  await check('5. a DIFFERENT photo already on the server under a key is never written over: conflict reported, both copies kept', async () => {
    let c2 = newCase({ id: 'clash-1', name: 'clash', now: T0 }); c2 = dispatch(c2, { type: 'PHOTO', ref: 'photo-0', note: 'x.jpg' }, T0);
    ok((await api('/api/cases/clash-1', { method: 'PUT', body: JSON.stringify(c2) })).status === 200, 'server case');
    const serverPhoto = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64')}`;
    ok((await api(`/api/cases/clash-1/photos/${encodeURIComponent('photo:clash-1.0')}`, { method: 'PUT', body: JSON.stringify({ dataUrl: serverPhoto }) })).body.status === 'STORED', 'server photo');
    // the phone has the same case with ANOTHER photo under the same key (the server holds the case, so the backup only checks the photos)
    await a.run(`const s = await import('/storage.js'); await s.putBlob('photo:clash-1.0', 'data:image/jpeg;base64,/9j/BBBB'); const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases')); cases['clash-1'] = ${JSON.stringify(c2)}; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); return 1;`);
    a = await browser.tab(`${A}/`); await ready(a); await a.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    let rep = null; for (let i = 0; i < 40; i += 1) { rep = await a.eval("JSON.parse(localStorage.getItem('nordla.sourcing.backup') || 'null')"); if (rep?.conflicts?.includes('photo:clash-1.0')) break; await sleep(250); }
    ok(rep?.conflicts?.includes('photo:clash-1.0'), `conflict reported (${JSON.stringify(rep)})`);
    ok((await api(`/api/cases/clash-1/photos/${encodeURIComponent('photo:clash-1.0')}`)).body.dataUrl === serverPhoto, 'the server copy is unchanged');
    ok((await blob(a, 'photo:clash-1.0')) === 'data:image/jpeg;base64,/9j/BBBB', 'the phone copy is unchanged');
  });
} finally {
  await browser.close(); await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
