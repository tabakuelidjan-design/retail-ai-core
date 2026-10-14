// NORDLA: a model number the owner accepted is never reported as missing. The blocker names the real gap (technical identification: the category), with the category decision one tap away; the real blockers (documents, costs) stay.
// REAL browser engine (Chromium-family through the DevTools Protocol; not a physical phone). Cases: Remax "Batterie externe" (Fc-02) and Sonny (AB521).   Set SOURCING_E2E_SHOTS=<dir> for the screenshots.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'identification-token-0123456789-abcdef'; const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 700)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const dir = mkdtempSync(join(tmpdir(), 'nordla-ident-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => { throw new Error('no network in this test'); }, ecb: async () => ({ date: '2026-10-19', rates: {} }) });
const errs = []; const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch();
browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const click = async (t, sel, ms = 450) => { await t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ${sel.replace(/'/g, '')}'); e.click(); })()`); await sleep(ms); };
const clickText = async (t, scope, label, ms = 450) => { await t.eval(`(() => { const r = [...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => e.innerText.trim().replace(/\\s+/g, ' ').includes(${JSON.stringify(label)})); if (!r) throw new Error('missing ' + ${JSON.stringify(label)}); r.click(); })()`); await sleep(ms); };
const ready = (t) => t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000);
const store = async (t) => JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases') ?? '{}'")); const byName = async (t, n) => Object.values(await store(t)).find((c) => c.supplier?.name === n);
const noOverflow = async (t, label) => { const r = await t.eval('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })'); ok(r.sw <= r.cw, `${label}: horizontal overflow ${r.sw} > ${r.cw}`); };
const small = (t) => t.eval(`[...document.querySelectorAll('#screen button, #screen select, #tabs button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44; }).map((b) => (b.innerText || b.id).trim().slice(0, 30))`);
let shotN = 0; const shot = async (t, name) => { if (!SHOTS) return; await sleep(250); const r = await browser.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`), Buffer.from(r.data, 'base64')); };

try {
  const t = await browser.tab(`${base}/#t=${TOKEN}`, { width: 390, height: 844 }); await ready(t); await sleep(900);
  await t.eval(`(async () => { const m = await import('/core/case.js'); const T0 = new Date('2026-10-20T08:00:00Z'); const at = (k) => new Date(T0.getTime() + k * 60000); const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') ?? '{}');
    const mk = (id, supplier, product, text) => { let c = m.newCase({ id, name: product, now: T0 }); c = m.dispatch(c, { type: 'SUPPLIER', supplier: { name: supplier } }, at(0)); c = m.dispatch(c, { type: 'CONVERSATION_START', supplierRef: supplier, lang: 'auto' }, at(1)); c = m.dispatch(c, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'auto', text }, at(2)); for (const k of c.candidates) c = m.dispatch(c, { type: 'CANDIDATE_CONFIRM', id: k.id }, at(3)); return c; };
    for (const c of [mk('remax-id', 'Remax', 'Batterie externe', 'price 11.68 USD, MOQ 60, model Fc-02'), mk('sonny-id', 'Sonny', 'batterie externe', 'prix 12$, MOQ 60, modele AB521')]) cases[c.id] = c; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); })()`); await sleep(500);
  await t.eval('location.reload()'); await ready(t); await sleep(1200);
  const openFiche = async (name) => { await click(t, '#tabs [data-key="suppliers"]', 600); await clickText(t, '.nx-cardmain', name, 700); };
  const strip = (t2) => t2.eval("[...document.querySelectorAll('.nx-strip > div')].map((d) => d.innerText.replace(/\\s+/g, ' ').trim()).join(' | ')");

  await check('1. REMAX: the strip shows the model Fc-02; the blocker does NOT say "Modèle exact"; it says "Identification technique incomplète" and explains why in French, with the model named as known', async () => {
    await openFiche('Remax'); await t.eval("window.scrollTo(0, 0)"); await sleep(200); await shot(t, 'remax-fiche-haut'); const s = await strip(t); ok(/11\.68 USD/.test(s) && /60/.test(s) && /Fc-02/.test(s), s); const row = await text(t, '.nx-block summary'); ok(/points? bloquants?/.test(row) && /Identification technique incomplète/.test(row) && !/Modèle exact|Numéro de modèle|Modèle à confirmer/.test(row), row);
    await click(t, '.nx-block summary', 400); const body = await text(t, '.nx-block .body'); ok(/Numéro de modèle Fc-02 : connu/.test(body) && /Identification technique incomplète : la catégorie du produit n'est pas confirmée/.test(body) && /10 caractéristiques de sécurité/.test(body) && /ne prouve ni l'identification technique ni la conformité/.test(body), body);
    ok(!/modèle exact manquant/i.test(await text(t)), 'no "modèle exact manquant" anywhere'); ok(/Coûts d'import/.test(row) && /Documents de conformité/.test(row), 'the other real gaps stay: ' + row); await noOverflow(t, 'remax'); await t.eval("document.querySelector('.nx-block summary').scrollIntoView({block:'start'})"); await t.eval('window.scrollBy(0, -140)'); await shot(t, 'remax-bandeau-detail'); await t.eval("document.getElementById('nx-cat').scrollIntoView({block:'center'})"); await shot(t, 'remax-categorie-a-confirmer');
  });

  await check('2. the category decision is one tap away, suggested from the product name but NOT applied by itself; confirming it removes the identification gap and keeps the real blockers; the model is not asked again', async () => {
    const before = await byName(t, 'Remax'); ok(!before.identity.evidence.category, 'no category yet: nothing was decided for the owner'); const sel = await t.eval("(() => { const s = document.getElementById('nx-cat'); return { v: s.value, t: s.selectedOptions[0].innerText }; })()"); ok(sel.v === 'power_bank' && /suggérée/.test(sel.t), JSON.stringify(sel));
    await click(t, 'form[data-form="sl-category"] button[type="submit"]', 800); const after = await byName(t, 'Remax'); const ev = after.identity.evidence.category.at(-1); ok(ev.value === 'power_bank' && ev.level === 'USER_STATED', JSON.stringify(ev)); ok(after.candidates.filter((k) => k.key === 'identifier.model').every((k) => k.state === 'CONFIRMED'), 'the model is not asked again');
    ok(/Catégorie confirmée/.test(await text(t)), 'feedback'); const row = await text(t, '.nx-block summary'); ok(!/Identification|Modèle/.test(row) && /Documents de conformité/.test(row) && /Coûts d'import/.test(row), 'real blockers remain: ' + row); ok(!(await t.eval("!!document.getElementById('nx-cat')")), 'the category form is gone');
    await click(t, '.nx-block summary', 400); const body = await text(t, '.nx-block .body'); ok(!/Identification technique incomplète/.test(body) && /documents à obtenir/i.test(await text(t, '.nx-block')), body.slice(0, 300)); await t.eval("document.querySelector('.nx-block summary').scrollIntoView({block:'start'})"); await t.eval('window.scrollBy(0, -140)'); await shot(t, 'remax-categorie-confirmee');
  });

  await check('3. SONNY (AB521) gets the same treatment', async () => {
    await openFiche('Sonny'); const row = await text(t, '.nx-block summary'); ok(/Identification technique incomplète/.test(row) && !/Modèle exact/.test(row), row); await click(t, '.nx-block summary', 400); ok(/Numéro de modèle AB521 : connu/.test(await text(t, '.nx-block .body')), 'AB521 named as known');
  });

  await check('4. WIDTHS 360 / 375 / 390 / 430 px: the blocker detail with the category form has no horizontal overflow and no control under 44 px', async () => {
    for (const W of [360, 375, 390, 430]) { await t.resize(W, 812); await sleep(400); await openFiche('Sonny'); await click(t, '.nx-block summary', 400); await noOverflow(t, `sonny@${W}`); const sm = await small(t); ok(sm.length === 0, `small targets @${W}: ${sm.join(', ')}`); }
    await t.resize(390, 844);
  });

  await check('5. no uncaught error in the whole session', async () => { ok(errs.length === 0, errs.slice(0, 3).join(' | ')); });
} finally {
  await browser.close(); await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter((x) => !x).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
