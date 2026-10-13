// REAL-BROWSER (390 px) proof that RECOVERING or IMPORTING a case never makes the app write to the server by itself:
// open it, cut the network, restore it, let the sync cycle run, switch case, restart the app, start from an old phone (no change list): no PUT leaves the phone,
// the server revision and the server file fingerprint stay identical. An explicit edit still syncs; a stale save is still refused (409); offline editing still works.
// Engine-level proof only. It is NOT the physical Xiaomi. Run:  npm run sourcing:e2e:reconnect
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { newCase, dispatch } from '../../src/sourcing/core/case.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND: the reconnect e2e was NOT run.'); process.exit(2); }
const TOKEN = 'e2e-reconnect-token-0123456789-abcdef-xyz';
const results = []; const check = async (name, fn) => { try { await fn(); results.push([name, 'PASS']); console.log(`PASS  ${name}`); } catch (e) { results.push([name, `FAIL: ${e.message}`]); console.log(`FAIL  ${name}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SONNY = 'prix 12$, MOQ 60, puissance 10000mAp. variante 4 couleur blanc, blue, rouge et noir. puissance 45W. nom de Modele AB521';
const T0 = new Date('2026-10-20T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000);
function sonny(id, name = 'batterie externe') {
  let c = newCase({ id, name, now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Sonny' } }, at(0)); c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Sonny', lang: 'auto' }, at(1));
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations.at(-1).id, speaker: 'supplier', lang: 'auto', text: SONNY }, at(2));
  return dispatch(c, { type: 'CANDIDATE_CONFIRM', id: c.candidates.find((x) => x.key === 'quote.moq').id }, at(3));
}
const dir = mkdtempSync(join(tmpdir(), 'nordla-reco-e2e-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
let server = null;
const startServer = async () => { server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }), ecb: async () => ({ date: '2026-10-02', perEur: { USD: 1.08 } }) }); };
const stopServer = async () => { await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); server = null; };
const api = async (path, opts = {}) => { const r = await fetch(base + path, { ...opts, headers: { 'x-sourcing-token': TOKEN, 'content-type': 'application/json' } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const fileOf = (id) => join(dir, 'cases', `${id}.json`);
const hash = (id) => existsSync(fileOf(id)) ? createHash('sha256').update(readFileSync(fileOf(id))).digest('hex') : null;
await startServer();
await api('/api/cases/sonny', { method: 'PUT', body: JSON.stringify(sonny('sonny')) }); await api('/api/cases/trip2', { method: 'PUT', body: JSON.stringify(sonny('trip2', 'tasse UV')) });
const serverState = () => ({ sonny: hash('sonny'), trip2: hash('trip2'), never: hash('never-synced') });
const baseline = serverState();

const PRELOAD = `try { localStorage.setItem('nordla.sourcing.modeDefault', '"field-v1"'); localStorage.setItem('nordla.sourcing.mode', '"expert"'); } catch (e) {}
  (() => { const of = window.fetch; window.fetch = function (u, o) { try { const m = (o && o.method) || 'GET'; if (m !== 'GET' && String(u).includes('/api/cases')) { const a = JSON.parse(sessionStorage.getItem('__w') || '[]'); a.push([m, String(u)]); sessionStorage.setItem('__w', JSON.stringify(a)); } } catch (e) {} return of.apply(this, arguments); }; })();`;
const HELPERS = `window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), fill: (form, vals) => { const f = document.querySelector('form[data-form="' + form + '"]'); for (const [k, v] of Object.entries(vals)) f.elements[k].value = v; f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); } }; 'ok'`;
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && !!document.querySelector('#tabs') && document.querySelector('#tabs').children.length > 0", 20000); await t.eval(HELPERS); };
const writes = (t) => t.eval("JSON.parse(sessionStorage.getItem('__w') || '[]')");
const phoneCases = (t) => t.eval("Object.values(JSON.parse(localStorage.getItem('nordla.sourcing.cases') || '{}'))");
const click = (t, sel) => t.run(`document.querySelector(${JSON.stringify(sel)}).click(); await __t.sleep(450); return 1;`);
const openMenu = (t) => click(t, '#btn-cases');
const openCase = async (t, id) => { await openMenu(t); await click(t, `[data-act="opencase"][data-key="${id}"]`); };
const importFile = (t, text) => t.run(`const f = new File([${JSON.stringify(text)}], 'x.json', { type: 'application/json' }); const dt = new DataTransfer(); dt.items.add(f); const i = document.querySelector('input[data-act="rec-file"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(800); return 1;`);
const recover = async (t, id) => { await openMenu(t); await click(t, '[data-act="rec-list"]'); await click(t, `input[data-key="${id}"]`); await click(t, '[data-act="rec-go"]'); await click(t, '[data-act="close-overlay"]'); };
/** network cut -> back -> the sync cycle gets time to run */
async function bounce(t, { stop = false } = {}) {
  await t.offline(true); if (stop) await stopServer(); await t.eval("window.dispatchEvent(new Event('offline'))"); await sleep(1500);
  if (stop) await startServer(); await t.offline(false); await t.eval("window.dispatchEvent(new Event('online'))"); await sleep(6000);
}
const noWrites = async (t, label) => { const w = await writes(t); ok(w.length === 0, `${label}: the phone sent ${JSON.stringify(w)}`); ok(JSON.stringify(serverState()) === JSON.stringify(baseline), `${label}: a server file changed`); };

console.log(`Browser engine: ${exe}`);
const browser = await new Browser(exe).launch(); let tab;
try {
  tab = await browser.tab(`${base}/#t=${TOKEN}`, { preload: PRELOAD }); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
  await check('0. a freshly paired empty phone (blank starter case, no edit) sends nothing to the server', async () => {
    await sleep(3000); const w = await writes(tab); ok(w.length === 0, `the phone sent ${JSON.stringify(w)}`);
    ok(!(await api('/api/cases')).body.cases.some((c) => !['sonny', 'trip2'].includes(c.id)), 'no starter case was created on the server');
  });

  await check('1. Sonny recovered from the server, opened, network cut and restored (server restarted): no PUT, same revision, same file fingerprint', async () => {
    await recover(tab, 'sonny'); await openCase(tab, 'sonny'); ok((await phoneCases(tab)).some((c) => c.id === 'sonny'), 'recovered');
    await bounce(tab, { stop: true });
    await noWrites(tab, 'after reconnection'); ok((await api('/api/cases/sonny')).body.rev === 1, 'revision still 1');
  });
  await check('2. a case imported from JSON that does not exist on the server: opened, network cut/restored: nothing is created on the server', async () => {
    const never = sonny('never-synced', 'cas jamais synchronisé'); await openMenu(tab);
    await importFile(tab, JSON.stringify({ format: 'nordla-case-export', version: 1, case: never, photos: {} })); await click(tab, '[data-act="close-overlay"]'); await openCase(tab, 'never-synced');
    await bounce(tab); await noWrites(tab, 'imported case'); ok(!existsSync(fileOf('never-synced')), 'no file created on the server');
  });
  await check('3. switching between cases, then reloading the app (restart): still no PUT', async () => {
    await openCase(tab, 'sonny'); await openCase(tab, 'never-synced'); await openCase(tab, 'sonny');
    await tab.eval('location.reload()'); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000); await sleep(6000);
    await noWrites(tab, 'after switch and restart');
  });
  await check('4. an OLD phone (cases stored, no change list, as before this feature): opening and restarting sends nothing', async () => {
    await tab.eval("localStorage.removeItem('nordla.sourcing.dirty')"); await tab.eval('location.reload()'); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000);
    await openCase(tab, 'sonny'); await bounce(tab); await noWrites(tab, 'old phone');
  });
  await check('5. a change list left by an older version still counts: a case really marked as changed is sent once, with its revision', async () => {
    const srv = (await api('/api/cases/trip2')).body; ok(srv.rev === 1);
    await tab.eval(`(() => { const c = JSON.parse(localStorage.getItem('nordla.sourcing.cases')); c.trip2 = ${JSON.stringify({ ...sonny('trip2', 'tasse UV'), rev: 1, notes: [{ at: '2026-10-21T10:00:00Z', text: 'modifié hors ligne' }], updatedAt: '2026-10-21T10:00:00.000Z' })}; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(c)); localStorage.setItem('nordla.sourcing.dirty', JSON.stringify(['trip2'])); })()`);
    await tab.eval('location.reload()'); await ready(tab); await tab.waitFor('window.nordlaSourcing?.state().online === true', 15000); await sleep(5000);
    const w = await writes(tab); ok(w.length === 1 && w[0][0] === 'PUT' && /trip2/.test(w[0][1]), `exactly one PUT for trip2: ${JSON.stringify(w)}`);
    const after = (await api('/api/cases/trip2')).body; ok(after.rev === 2 && after.notes.some((n) => n.text === 'modifié hors ligne'), 'the offline edit reached the server');
    ok(hash('sonny') === baseline.sonny, 'the other case was not touched'); await tab.eval("sessionStorage.setItem('__w', '[]')"); baseline.trip2 = hash('trip2');
  });
  await check('6. an explicit edit on a recovered case still syncs (revision + 1), and only that case is sent', async () => {
    await openCase(tab, 'sonny'); await click(tab, '[data-act="tab"][data-key="case"]');
    await tab.run(`__t.fill('supplier', { name: 'Sonny Electronics' }); await __t.sleep(3500); return 1;`);
    const w = await writes(tab); ok(w.length >= 1 && w.every((x) => x[0] === 'PUT' && /sonny/.test(x[1])), `only sonny sent: ${JSON.stringify(w)}`);
    const after = (await api('/api/cases/sonny')).body; ok(after.rev === 2 && after.supplier.name === 'Sonny Electronics', `server updated: rev ${after.rev}`);
    ok(JSON.stringify(after.conversations).includes(SONNY), 'conversation still whole on the server'); baseline.sonny = hash('sonny');
    const n = (await writes(tab)).length; await bounce(tab); ok((await writes(tab)).length === n, 'no further PUT after the edit is synced');
  });
  await check('7. OFFLINE editing still works: the edit is kept on the phone, then sent once when the network returns', async () => {
    await tab.offline(true); await tab.eval("window.dispatchEvent(new Event('offline'))"); await sleep(500);
    await tab.run(`__t.fill('supplier', { name: 'Sonny hors ligne' }); await __t.sleep(1200); return 1;`);
    ok((await phoneCases(tab)).find((c) => c.id === 'sonny').supplier.name === 'Sonny hors ligne', 'kept locally while offline'); ok((await api('/api/cases/sonny')).body.supplier.name === 'Sonny Electronics', 'server unchanged while offline');
    await tab.offline(false); await tab.eval("window.dispatchEvent(new Event('online'))"); await sleep(6000);
    const after = (await api('/api/cases/sonny')).body; ok(after.supplier.name === 'Sonny hors ligne' && after.rev === 3, `sent on reconnection: rev ${after.rev}`); baseline.sonny = hash('sonny');
  });
  await check('8. CONFLICT 409 still protects the server: another device saved meanwhile, the phone edit is refused and the server copy survives', async () => {
    const srv = (await api('/api/cases/sonny')).body; await api('/api/cases/sonny', { method: 'PUT', body: JSON.stringify({ ...srv, notes: [...srv.notes, { at: '2026-10-22T09:00:00Z', text: 'autre appareil' }] }) });
    const h = hash('sonny');
    await tab.run(`__t.fill('supplier', { name: 'Sonny depuis le téléphone' }); await __t.sleep(3500); return 1;`);
    ok(hash('sonny') === h, 'server file untouched by the stale save'); const s = (await api('/api/cases/sonny')).body; ok(s.notes.some((n) => n.text === 'autre appareil') && s.supplier.name === 'Sonny hors ligne', 'other device\'s data intact');
    ok((await phoneCases(tab)).find((c) => c.id === 'sonny').supplier.name === 'Sonny depuis le téléphone', 'my edit is still on the phone');
    ok(/Conflict:/.test(await (async () => { await openMenu(tab); return tab.eval("document.querySelector('#overlay').innerText"); })()), 'the conflict is reported to the owner');
  });
} finally {
  await tab?.close(); await browser.close(); if (server) await stopServer(); rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter(([, r]) => r !== 'PASS'); console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(([n]) => n.split('.')[0]).join(', ')}` : ''}. Engine-level proof; NOT the physical Xiaomi.`);
process.exit(failed.length ? 1 : 0);
