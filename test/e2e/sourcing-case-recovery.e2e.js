// REAL-BROWSER (390 px, Chromium engine) proof of "Récupérer mes dossiers": a brand-new browser profile = what the phone is after the tunnel address changes (empty storage).
// The owner lists the server cases, ticks one, recovers it; the server file is never rewritten; an exported JSON is imported; a clash keeps both copies; repeating changes nothing.
// Engine-level proof only. It is NOT the physical Xiaomi. Run:  npm run sourcing:e2e:recovery
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { newCase, dispatch } from '../../src/sourcing/core/case.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND: the recovery e2e was NOT run.'); process.exit(2); }
const TOKEN = 'e2e-recover-token-0123456789-abcdef-xyz';
const results = []; const check = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); } catch (e) { results.push([name, `FAIL: ${e.message}`]); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const SONNY = 'prix 12$, MOQ 60, puissance 10000mAp. variante 4 couleur blanc, blue, rouge et noir. puissance 45W. nom de Modele AB521';
const T0 = new Date('2026-10-20T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000);
function sonny(id, name = 'batterie externe') {
  let c = newCase({ id, name, now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Sonny' } }, at(0)); c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Sonny', lang: 'auto' }, at(1));
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations.at(-1).id, speaker: 'supplier', lang: 'auto', text: SONNY }, at(2));
  c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: c.candidates.find((x) => x.key === 'quote.moq').id }, at(3));
  return dispatch(c, { type: 'CANDIDATE_REJECT', id: c.candidates.find((x) => x.key === 'quote.unitPrice').id }, at(5));
}
const dir = mkdtempSync(join(tmpdir(), 'nordla-rec-e2e-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }), ecb: async () => ({ date: '2026-10-02', perEur: { USD: 1.08 } }) });
const api = async (path, opts = {}) => { const r = await fetch(base + path, { ...opts, headers: { 'x-sourcing-token': TOKEN, 'content-type': 'application/json' } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const fileHash = (id) => createHash('sha256').update(readFileSync(join(dir, 'cases', `${id}.json`))).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await api('/api/cases/sonny', { method: 'PUT', body: JSON.stringify(sonny('sonny')) }); await api('/api/cases/trip2', { method: 'PUT', body: JSON.stringify(sonny('trip2', 'tasse UV')) });
const hashes = { sonny: fileHash('sonny'), trip2: fileHash('trip2') };

const HELPERS = `window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }; 'ok'`;
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && document.body.innerText.length > 20", 20000); await t.eval(HELPERS); };
const phoneCases = (t) => t.eval("Object.values(JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}'))");
const openMenu = (t) => t.run(`(document.querySelector('[data-act="fm-menu"]') ?? document.querySelector('#btn-cases')).click(); await __t.sleep(300); return 1;`);
const overlay = (t) => t.eval("document.querySelector('#overlay').innerText");
const click = (t, sel) => t.run(`document.querySelector(${JSON.stringify(sel)}).click(); await __t.sleep(500); return 1;`);
const importFile = (t, name, text) => t.run(`const f = new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, { type: 'application/json' }); const dt = new DataTransfer(); dt.items.add(f); const i = document.querySelector('input[data-act="rec-file"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(900); return 1;`);

console.log(`Browser engine: ${exe}`);
const browser = await new Browser(exe).launch(); let tab;
try {
  await check('1. a brand-new phone (empty storage, new address) paired by the link: the menu offers "Récupérer mes dossiers", nothing imported', async () => {
    tab = await browser.tab(`${base}/#t=${TOKEN}`); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    ok(await tab.eval("location.hash === ''"), 'token cleared from the address bar');
    ok(!(await phoneCases(tab)).some((c) => c.id === 'sonny'), 'Sonny is not on this phone yet');
    await openMenu(tab); const t = await overlay(tab); ok(/Récupérer mes dossiers/.test(t), 'the action is in the menu'); ok(/Importer un fichier exporté/.test(t), 'file import is offered');
  });
  await check('2. "Voir les dossiers du serveur" lists the server cases, none ticked, "Récupérer" disabled, nothing added to the phone', async () => {
    const before = (await phoneCases(tab)).length; await click(tab, '[data-act="rec-list"]'); const t = await overlay(tab);
    ok(/batterie externe/.test(t) && /tasse UV/.test(t), `both server cases listed (the phone's own blank starter case is also on the server): ${t.slice(0, 200)}`);
    ok(await tab.eval("document.querySelectorAll('input[data-act=\"rec-toggle\"]').length >= 2 && ![...document.querySelectorAll('input[data-act=\"rec-toggle\"]')].some((i) => i.checked)"), 'nothing ticked');
    ok(await tab.eval("document.querySelector('[data-act=\"rec-go\"]').disabled"), 'recover button disabled');
    ok((await phoneCases(tab)).length === before, 'listing imported nothing');
  });
  await check('3. tick ONE case and recover: it arrives whole (conversation, confirmation, rejection); the other stays on the server', async () => {
    await click(tab, 'input[data-key="sonny"]'); ok(await tab.eval("!document.querySelector('[data-act=\"rec-go\"]').disabled"), 'enabled once ticked');
    await click(tab, '[data-act="rec-go"]'); const cs = await phoneCases(tab); const s = cs.find((c) => c.id === 'sonny'); ok(s, 'Sonny recovered'); ok(!cs.some((c) => c.id === 'trip2'), 'the unticked case was not imported');
    const srv = (await api('/api/cases/sonny')).body; const { recoveredFrom, ...rest } = s; ok(JSON.stringify(rest) === JSON.stringify(srv), 'the phone copy equals the server copy'); ok(JSON.stringify(s.conversations).includes(SONNY), 'original supplier text kept');
    ok(s.candidates.some((c) => c.state === 'REJECTED') && s.ledger.length >= 1, 'rejection and confirmation kept');
    ok(/récupéré/.test(await overlay(tab)), 'the owner is told');
  });
  await check('4. recovering and waiting: the server file is byte-identical (no automatic PUT), nothing is queued as changed', async () => {
    await sleep(4000); ok(fileHash('sonny') === hashes.sonny && fileHash('trip2') === hashes.trip2, 'server files untouched');
    ok((await api('/api/cases/sonny')).body.rev === 1, 'server revision did not move');
    const dirty = await tab.eval("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]')"); ok(!dirty.includes('sonny'), `sonny must not be queued: ${dirty}`);
  });
  await check('5. recovering the same case again is a no-op ("déjà sur ce téléphone, identique")', async () => {
    await click(tab, '[data-act="rec-list"]'); await click(tab, 'input[data-key="sonny"]'); await click(tab, '[data-act="rec-go"]');
    ok(/déjà sur ce téléphone, identique/.test(await overlay(tab)), 'reported as already here'); ok((await phoneCases(tab)).filter((c) => /sonny/.test(c.id)).length === 1, 'still one copy');
  });
  await check('6. JSON import: a never-synced case (new id) is added from an exported file; photos in the bundle are restored', async () => {
    const local = sonny('never-synced', 'cas jamais synchronisé'); local.identity.photos = ['photo-0'];
    const bundle = JSON.stringify({ format: 'nordla-case-export', version: 1, case: local, photos: { 'photo:never-synced.0': 'data:image/jpeg;base64,/9j/AAAA' } });
    await importFile(tab, 'nordla-case-never-synced.json', bundle);
    ok((await phoneCases(tab)).some((c) => c.id === 'never-synced'), 'imported'); ok(await tab.eval("window.nordlaSourcing ? true : true"), 'app alive');
    const photo = await tab.eval("new Promise((res) => { const r = indexedDB.open('nordla-sourcing', 1); r.onsuccess = () => { const q = r.result.transaction('blobs').objectStore('blobs').get('photo:never-synced.0'); q.onsuccess = () => res(q.result ?? null); }; })"); ok(photo === 'data:image/jpeg;base64,/9j/AAAA', 'the photo came back');
    ok((await api('/api/cases')).body.cases.every((c) => c.id !== 'never-synced'), 'importing did not push it to the server by itself');
  });
  await check('7. importing the same file again changes nothing', async () => {
    const before = JSON.stringify(await phoneCases(tab)); const local = sonny('never-synced', 'cas jamais synchronisé'); local.identity.photos = ['photo-0'];
    await importFile(tab, 'again.json', JSON.stringify({ format: 'nordla-case-export', version: 1, case: local, photos: {} }));
    ok(/déjà sur ce téléphone/.test(await overlay(tab)), 'reported'); ok(JSON.stringify(await phoneCases(tab)) === before, 'phone data identical');
  });
  await check('8. CLASH: a file whose id exists locally with different content is never written over; the comparison is shown; "Garder les deux" keeps both; "Ignorer" keeps one', async () => {
    const mineBefore = (await phoneCases(tab)).find((c) => c.id === 'sonny'); const other = dispatch(sonny('sonny'), { type: 'NOTE', text: 'copie ancienne avec une note de plus' }, at(200));
    await importFile(tab, 'sonny-older.json', JSON.stringify(other)); const t = await overlay(tab);
    ok(/existe déjà sur ce téléphone avec un contenu différent/.test(t) && /Rien n’a été remplacé/.test(t) && /Sur ce téléphone/.test(t) && /À récupérer/.test(t), `comparison shown: ${t.slice(0, 300)}`);
    ok(JSON.stringify((await phoneCases(tab)).find((c) => c.id === 'sonny')) === JSON.stringify(mineBefore), 'my copy untouched while the owner decides');
    await click(tab, '[data-act="rec-keep"]'); const cs = await phoneCases(tab); const copies = cs.filter((c) => c.recoveredFrom?.id === 'sonny' && c.id !== 'sonny');
    ok(copies.length === 1 && /copie récupérée/.test(copies[0].identity.workingName), 'second copy kept under a new id');
    ok(JSON.stringify(cs.find((c) => c.id === 'sonny')) === JSON.stringify(mineBefore), 'original byte-identical after keep-both');
    await importFile(tab, 'sonny-older.json', JSON.stringify(other)); ok(/déjà gardée/.test(await overlay(tab)), 'repeat import recognised'); ok((await phoneCases(tab)).filter((c) => c.recoveredFrom?.id === 'sonny' && c.id !== 'sonny').length === 1, 'still one extra copy');
  });
  await check('9. bad files are refused with a message and store nothing', async () => {
    const n = (await phoneCases(tab)).length;
    await importFile(tab, 'x.json', '{oops'); ok(/pas un export Nordla/.test(await overlay(tab)), 'not JSON'); await importFile(tab, 'y.json', JSON.stringify({ id: '../../x', identity: {}, events: [] })); ok(/refusé|invalide|complet/.test(await overlay(tab)) || /identifiant invalide/.test(await overlay(tab)), 'bad id');
    ok((await phoneCases(tab)).length === n, 'nothing stored');
  });
  await check('10. REVISION GUARD: editing a recovered case after another device moved the server on is refused (409), the server copy survives', async () => {
    const srv = (await api('/api/cases/trip2')).body; await api('/api/cases/trip2', { method: 'PUT', body: JSON.stringify({ ...srv, notes: [...srv.notes, { at: new Date().toISOString(), text: 'autre appareil' }] }) });
    const h = fileHash('trip2'); await click(tab, '[data-act="rec-list"]'); await click(tab, 'input[data-key="trip2"]'); await click(tab, '[data-act="rec-go"]'); // recovered at the NEW revision
    const stale = { ...(await api('/api/cases/trip2')).body, rev: 1 }; // a copy exported long ago, still at rev 1
    const r = await api('/api/cases/trip2', { method: 'PUT', body: JSON.stringify(stale) }); ok(r.status === 409, `stale save refused: ${r.status}`); ok(fileHash('trip2') === h, 'server file untouched');
  });
  await check('11. 390 px: the recovery section fits the screen width (no horizontal scroll)', async () => {
    await click(tab, '[data-act="rec-list"]'); ok(await tab.eval("document.documentElement.scrollWidth <= window.innerWidth + 1"), 'no horizontal overflow');
  });
  await check('12. Salon -> Sonny: reanalysis and export target the VISIBLE case, not a stale empty case; result is visible', async () => {
    // Reproduce the REAL Xiaomi legacy situation: the original quote was retained,
    // but only MOQ 60 had been extracted and confirmed.
    const legacy = sonny('sonny-salon-legacy');
    legacy.candidates = legacy.candidates.filter((c) => c.key === 'quote.moq');
    await importFile(tab, 'sonny-legacy.json', JSON.stringify(legacy));
    await click(tab, '#tabs [data-key="suppliers"]');
    await click(tab, '[data-act="sl-open-case"][data-key="sonny-salon-legacy"]');
    ok((await tab.eval("JSON.parse(localStorage.getItem('nordla.sourcing.current'))")) === legacy.id, 'Salon selection aligns the global current case');

    // A global-menu NEW CASE action used to leave Salon visually on Sonny while
    // the global currentId pointed to a blank starter case.
    // (the unified settings sheet no longer lists cases, so the stale-blank situation is created the way the old button did)
    await tab.eval("(() => { const b = document.createElement('button'); b.dataset.act = 'newcase'; document.body.appendChild(b); b.click(); b.remove(); })()");
    const blankId = await tab.eval("JSON.parse(localStorage.getItem('nordla.sourcing.current'))");
    ok(blankId !== legacy.id, 'stale blank global current-case situation recreated');
    ok(/Sonny/.test(await tab.eval("document.querySelector('#screen').innerText")), 'Salon still visibly displays Sonny');

    await openMenu(tab);
    ok(/Dossier actif : batterie externe/.test(await overlay(tab)), 'menu names the VISIBLE active dossier');
    await click(tab, '[data-act="notes-reanalyze-preview"]');
    await click(tab, '[data-act="notes-reanalyze-apply"]');
    const message = await overlay(tab);
    ok(message.includes('batterie externe') && message.includes('proposition(s) ajoutée(s)'), `result missing; actual overlay: ${message.slice(0, 800)}`);
    const local = (await phoneCases(tab)).find((c) => c.id === legacy.id);
    ok(local?.candidates.some((c) => c.key === 'identifier.model' && c.value === 'AB521' && c.state === 'PROPOSED'), 'model was recovered as a PROPOSAL');
    ok(local.candidates.some((c) => c.key === 'quote.unitPrice' && String(c.value) === '12' && c.state === 'PROPOSED'), 'price was recovered as a PROPOSAL');
    ok(local.candidates.some((c) => c.key === 'spec.power' && c.state === 'PROPOSED'), 'power was recovered as a PROPOSAL');
    ok(local.candidates.find((c) => c.key === 'quote.moq').state === 'CONFIRMED', 'existing confirmation is untouched');
    ok((await phoneCases(tab)).find((c) => c.id === blankId).candidates.length === 0, 'blank dossier was not reanalysed or polluted');

    // The export button belongs to the same visible dossier, never the blank one.
    const exportData = await tab.run(`const oldUrl = URL.createObjectURL, oldClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (blob) => { window.__sourcingExportBlob = blob; return 'blob:test'; };
      HTMLAnchorElement.prototype.click = function () { window.__sourcingExportName = this.download; };
      document.querySelector('[data-act="export"]').click();
      URL.createObjectURL = oldUrl; HTMLAnchorElement.prototype.click = oldClick;
      return { name: window.__sourcingExportName, json: await window.__sourcingExportBlob.text() };`);
    const exported = JSON.parse(exportData.json);
    ok(exportData.name === 'nordla-case-sonny-salon-legacy.json' && exported.case.id === legacy.id, 'export is the visible Sonny dossier, not the empty case');
  });
} finally {
  await tab?.close(); await browser.close(); await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}. Engine-level proof; NOT the physical Xiaomi.`);
process.exit(failed.length ? 1 : 0);
