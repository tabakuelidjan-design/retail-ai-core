import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const TOKEN = 'fieldmode-token-0123456789-abcdef-xyz';
const results = []; const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 700)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'nordla-fieldmode-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
let server = null;
const startServer = async () => { server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<x/>' }), ecb: async () => ({ date: '2026-10-06', perEur: { USD: 1.08 } }) }); };
const stopServer = async () => { await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); server = null; };
const HELPERS = `window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), click: (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('missing ' + sel); e.click(); },
  set: (sel, v) => { const e = document.querySelector(sel); if (!e) throw new Error('missing ' + sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); },
  submit: (sel) => { const f = document.querySelector(sel); if (!f) throw new Error('missing ' + sel); f.requestSubmit(); },
  kase: () => { const all = JSON.parse(localStorage.getItem('nordla.sourcing.cases')); return all[JSON.parse(localStorage.getItem('nordla.sourcing.current'))]; } }; 'ok'`;
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && !!document.querySelector('#tabs') && document.querySelector('#tabs').children.length > 0", 20000); await t.eval(HELPERS); };
const kase = async (t) => JSON.parse(await t.eval('JSON.stringify(__t.kase())'));
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const tap = (t, sel, ms = 350) => t.run(`__t.click(${JSON.stringify(sel)}); await __t.sleep(${ms}); return 1;`);
// REAL-BROWSER end-to-end of FIELD MODE, CONVERSATION FIRST: three entries, one calm screen, at most one suggestion at a calm moment, everything else in sheets opened on demand, the grouped
// confirmation only on demand, owner inputs only in the summary sheet, the purchase EVALUATION (never a "decision"), provenance intact, offline, Expert untouched. Real Edge/Chrome engine through
// the DevTools Protocol; it is NOT a physical phone.   npm run sourcing:e2e:fieldmode
const send = async (t, msg, who = 'supplier') => { await t.run(`if (!document.querySelector('form[data-form="compose"]')) { document.querySelector('.fm-nav[data-key="write"]').click(); await __t.sleep(250); } __t.set('form[data-form="compose"] textarea', ${JSON.stringify(msg)}); document.querySelector('form[data-form="compose"] [name="speaker"]').value = ${JSON.stringify(who)}; __t.submit('form[data-form="compose"]'); await __t.sleep(700); return 1;`); };
const PHONE = 'PB-X200. MOQ is 50 pcs. Price is USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs. FOB Shenzhen. 30% deposit, 70% balance before shipment. We have black, white, blue and pink. You can mix colors, minimum 25 pcs per color. Production time is 15 days. We have CE, RoHS and UN38.3.';
const navLabels = (t) => t.eval("[...document.querySelectorAll('#tabs button')].map((b) => b.innerText.trim()).join(',')");
const controls = (t) => t.eval("[...document.querySelectorAll('#screen button, #screen input:not([type=hidden]), #screen select, #screen textarea, #screen a')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length");
const closeSheet = (t) => t.run(`document.querySelector('[data-act="fm-sheet-close"].fm-close')?.click(); await __t.sleep(300); return 1;`);
const chipsOf = (t) => t.eval("[...document.querySelectorAll('.fm-chip')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())");

await startServer();
const errs = []; const browser = await new Browser(exe).launch(); browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
console.log(`Browser engine: ${exe}\n`);
const t = await browser.tab(`${base}/#t=${TOKEN}`); await ready(t); await t.waitFor('window.nordlaSourcing?.state().online === true', 15000); await t.waitFor('navigator.serviceWorker.ready.then(() => caches.keys()).then((k) => k.length > 0)', 20000);

await check('1. Expert is the default; the menu switches to Field mode: exactly THREE entries (Conversation, Scanner / Ajouter, Écrire), persisted across a reload', async () => {
  ok((await navLabels(t)) === 'Guided,Quick,Verdict,Case,Ask,Docs,Rules,Market,Money', 'expert tabs by default');
  await tap(t, '#btn-cases'); await tap(t, '[data-act="mode-field"]'); ok((await navLabels(t)) === 'Conversation,Scanner / Ajouter,Écrire', await navLabels(t));
  await t.goto(`${base}/`); await ready(t); ok((await navLabels(t)).startsWith('Conversation'), 'mode persisted');
});

await check('2. FIRST SCREEN: one question (what is this product?), nothing else; then ONE dominant action "Démarrer la conversation"; calm (few controls)', async () => {
  ok(/Quel est ce produit/.test(await text(t)), 'product first'); ok((await controls(t)) <= 4, `controls: ${await controls(t)}`);
  await t.run(`__t.set('form[data-form="fh-product"] input', 'Power bank'); __t.submit('form[data-form="fh-product"]'); await __t.sleep(500); return 1;`);
  ok(/Démarrer la conversation/.test(await text(t)), 'the one action'); ok((await controls(t)) <= 4, `controls at home: ${await controls(t)}`); ok(!(await t.eval("!!document.querySelector('.fm-sheet')")), 'no sheet open');
  await t.run(`__t.click('[data-act="cat"]'); await __t.sleep(300); return 1;`); const c = await kase(t); ok(c.identity.workingName === 'Power bank' && c.identity.evidence.category.length >= 1, 'named, category confirmed by the owner');
});

await check('3. "Démarrer la conversation" opens the thread (Q1): a conversation starts, the keyboard is NOT forced, at most one suggestion', async () => {
  await tap(t, '[data-act="fm-start"]', 500); const c = await kase(t); ok(c.conversations.length === 1 && c.conversations[0].status === 'OPEN', 'conversation open');
  ok(!(await t.eval("document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.tagName === 'INPUT'")), 'no forced focus'); ok(/Le fournisseur parle/.test(await text(t)), 'hint'); ok((await t.eval("document.querySelectorAll('.fm-suggest').length")) <= 1, 'at most one suggestion');
});

await check('4. WRITING happens in a sheet from the bottom bar; sending closes it; the ORIGINAL is kept; Nordla only PROPOSES (the case is unchanged) and a quiet pill says how many to confirm, WITHOUT opening anything', async () => {
  await tap(t, '.fm-nav[data-key="write"]', 300); ok(await t.eval('!!document.querySelector(\'.fm-sheet form[data-form="compose"]\')'), 'write sheet'); await send(t, 'We have black, white, blue and pink.');
  ok(!(await t.eval("!!document.querySelector('.fm-sheet')")), 'sheet closed after sending'); const c = await kase(t); ok(c.conversations[0].items[0].original === 'We have black, white, blue and pink.', 'original kept'); ok(c.quotes.length === 0 && c.candidates.length >= 1, 'proposals only');
  ok(/à confirmer/.test(await text(t)) && !(await t.eval("!!document.querySelector('.fm-sheet')")), 'pill, nothing opened by itself'); ok(/Fournisseur/.test(await text(t)), 'thread shows the supplier');
});

await check('5. CONTEXT: the colours statement leads, after a calm moment, to ONE adjacent question (mix colours / minimum per colour); the supplier then answers by himself and the suggestion disappears', async () => {
  await t.waitFor(`/mélanger/i.test(document.querySelector('.fm-suggest')?.innerText ?? '')`, 25000); ok((await t.eval("document.querySelectorAll('.fm-suggest').length")) === 1, 'exactly one suggestion');
  await send(t, 'You can mix colors, minimum 25 pcs per color.'); ok(!/mélanger/i.test(await t.eval("document.querySelector('.fm-suggest')?.innerText ?? ''")), 'answered: gone'); ok(/à confirmer/.test(await text(t)), 'still just proposals');
});

await check('6. "Pas maintenant" puts a suggestion aside (remembered); "Que dois-je demander maintenant ?" answers at once', async () => {
  await tap(t, '[data-act="ask-now"]', 400); const id = await t.eval("document.querySelector('.fm-suggest')?.dataset.qid"); ok(id, 'asked explicitly: a suggestion appears at once');
  await t.run(`document.querySelector('.fm-suggest [data-act="q-skip"]').click(); await __t.sleep(400); return 1;`); const c = await kase(t); ok(c.questionLog.some((e) => e.kind === 'SKIPPED' && e.questionId === id), 'skip remembered'); ok(!(await t.eval(`document.querySelector('.fm-suggest')?.dataset.qid === ${JSON.stringify(id)}`)), 'gone from the screen');
});

await check('7. the GROUPED confirmation is ON DEMAND (a sheet from the pill), one deliberate tap; provenance exact (SUPPLIER_CLAIM, confirmed by the user, batch id, basis ORIGINAL); never opens by itself', async () => {
  await send(t, PHONE); ok(!(await t.eval("!!document.querySelector('.fm-sheet')")), 'still closed'); await tap(t, '.fm-pill', 400); const body = await text(t); ok(/NORDLA A COMPRIS/.test(body) && /50 = 8 · 100 = 7\.20 · 300 = 6\.80/.test(body) && /FOB Shenzhen/.test(body), body.slice(0, 500));
  await tap(t, '[data-act="group-confirm"]', 600); const c = await kase(t); const q = c.quotes.at(-1); ok(q.tiers.length === 3 && q.moq === 50 && q.incoterm === 'FOB' && q.port === 'Shenzhen', JSON.stringify(q));
  const mine = c.ledger.filter((e) => e.via === 'GROUP'); ok(mine.length >= 8 && mine.every((e) => e.status === 'SUPPLIER_CLAIM' && e.userConfirmed === true && /^batch-/.test(e.batchId) && e.basis === 'ORIGINAL'), 'ledger provenance'); ok(c.confirmBatches.length === 1, 'batch recorded');
  ok(c.documentLedger.length === 0 && c.documents.length === 0, 'document statements untouched');
});

await check('8. COMPACT STATES: ✓ means confirmed by YOU; documents announced are ◌ and NEVER ✓ (their own tap records claims only: no document, no proof)', async () => {
  await closeSheet(t); const chips = await chipsOf(t); ok(chips.some((x) => /^Prix ✓/.test(x)) && chips.some((x) => /^MOQ ✓/.test(x)), chips.join(' | '));
  await tap(t, '.fm-pill', 400); await tap(t, '[data-act="claims-confirm"]', 600); const c = await kase(t); ok(c.documentLedger.length === 3 && c.documentLedger.every((d) => d.status === 'CLAIMED') && c.documents.length === 0, 'claims only');
  await closeSheet(t); const after = await chipsOf(t); const doc = after.find((x) => /^Documents/.test(x)); ok(doc && doc.includes('◌') && !doc.includes('✓'), after.join(' | '));
  await tap(t, '.fm-status', 400); ok(/confirmé par vous/.test(await text(t)) && /jamais « confirmé »/.test(await text(t)), 'the legend says what ✓ means and that documents differ'); await closeSheet(t);
});

await check('9. a CONTRADICTION is a calm banner (value NOW), never a modal; the sheet shows Avant / Maintenant with both honest choices; the history keeps both', async () => {
  await send(t, 'Sorry, the MOQ is 100 pcs.'); ok(await t.eval("!!document.querySelector('.fm-alert')"), 'banner'); ok(!(await t.eval("!!document.querySelector('.fm-sheet')")), 'not opened by itself'); const al = await t.eval("document.querySelector('.fm-alert').innerText"); ok(/avant 50, maintenant 100/.test(al), al);
  await tap(t, '.fm-alert', 400); ok(/Avant :/.test(await text(t)) && /Maintenant :/.test(await text(t)), 'both values'); let c = await kase(t); ok(c.quotes.at(-1).moq === 50, 'not overwritten');
  await t.run(`document.querySelector('.fm-sheet [data-act="pre-new"]').click(); await __t.sleep(600); return 1;`); c = await kase(t); ok(c.quotes.at(-1).moq === 100 && c.ledger.filter((e) => e.key === 'quote.moq').length === 2, 'new value taken by the owner, both statements kept');
  await closeSheet(t); ok(!(await t.eval("!!document.querySelector('.fm-alert')")), 'banner gone once settled');
});

await check('10. the owner\'s own inputs are NEVER in the conversation: only in the summary sheet, on demand, validated; the purchase EVALUATION is not called a decision', async () => {
  ok(!(await t.eval('!!document.querySelector(\'#screen form[data-form="uanswer"]\')')), 'no owner card in the conversation');
  await tap(t, '.fm-status', 400); const sm = await text(t); ok(/À RENSEIGNER PAR VOUS/.test(sm) && /hypothèses de ce dossier/.test(sm), sm.slice(0, 300)); ok(/DÉCISION D'ENTREPRISE/.test(sm) && /Pas encore disponible/.test(sm) && !/DÉCISION D'ACHAT/.test(sm), 'company decision not available; no "purchase decision"');
  ok(await t.eval('!!document.querySelector(\'.fm-sheet form[data-form="uanswer"]\')'), 'an owner card exists here');
  await t.run(`__t.set('.fm-sheet form[data-form="uanswer"] input', '6,5'); __t.submit('.fm-sheet form[data-form="uanswer"]'); await __t.sleep(300); return 1;`); ok(/virgule|point/i.test(await text(t)), 'a decimal comma is refused'); await closeSheet(t);
});

await check('11. a half-typed message survives background re-renders and the bottom-bar navigation', async () => {
  await tap(t, '.fm-nav[data-key="write"]', 300); await t.run(`__t.set('form[data-form="compose"] textarea', 'half typed 300 pcs'); window.dispatchEvent(new Event('offline')); await __t.sleep(200); window.dispatchEvent(new Event('online')); await __t.sleep(1200); return 1;`);
  ok((await t.eval(`document.querySelector('form[data-form="compose"] textarea').value`)) === 'half typed 300 pcs', 'survived the blip'); await tap(t, '.fm-nav[data-key="add"]', 300); await tap(t, '.fm-nav[data-key="write"]', 300);
  ok((await t.eval(`document.querySelector('form[data-form="compose"] textarea').value`)) === 'half typed 300 pcs', 'survived the navigation'); await t.run(`__t.set('form[data-form="compose"] textarea', ''); document.querySelector('.fm-nav[data-key="talk"]').click(); await __t.sleep(200); return 1;`);
});

await check('12. OFFLINE: server stopped, browser offline, cold reload: the same conversation opens; writing and extraction work; after reconnect everything reaches the server', async () => {
  await stopServer(); await t.offline(true); await t.goto(`${base}/`); await ready(t); let body = await text(t); ok(/Fournisseur/.test(body) && body.includes('We have black, white, blue and pink.'), 'conversation shown again offline');
  await send(t, 'Lead time is 20 days. FOB Ningbo'); body = await text(t); ok(/à confirmer|avant/.test(body), 'extraction works with no network'); let c = await kase(t); ok(c.conversations[0].items.at(-1).original === 'Lead time is 20 days. FOB Ningbo', 'stored locally'); ok(await t.eval("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]').length >= 1"), 'waiting to sync');
  await startServer(); await t.offline(false); await t.run(`window.dispatchEvent(new Event('online')); await __t.sleep(200); return 1;`); await t.waitFor("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]').length === 0", 20000); c = await kase(t);
  const sv = await (await fetch(`${base}/api/cases/${c.id}`, { headers: { 'x-sourcing-token': TOKEN } })).json(); ok(sv.confirmBatches.length === c.confirmBatches.length && sv.questionLog.length === c.questionLog.length && sv.ledger.length === c.ledger.length, 'server copy identical'); ok(!JSON.stringify(sv).includes(TOKEN), 'no token');
});

await check('13. EXPERT is intact: the menu brings back every tab; all screens render; no uncaught error in the whole run', async () => {
  await tap(t, '#btn-cases'); await tap(t, '[data-act="mode-expert"]', 400); for (const k of ['field', 'quick', 'decision', 'case', 'ask', 'docs', 'compliance', 'market', 'money']) { await tap(t, `#tabs [data-key="${k}"]`, 250); const body = await text(t); ok(body.length > 80 && !/could not be computed/.test(body), `${k}: ${body.slice(0, 60)}`); }
  await tap(t, '#btn-cases'); await tap(t, '[data-act="mode-field"]', 400); ok((await navLabels(t)).startsWith('Conversation'), 'back in field mode'); ok(errs.length === 0, `uncaught errors: ${errs.join(' | ')}`);
});

await check('14. layout: the Field screen, its sheets and the bottom bar fit 375 / 390 / 430 wide (portrait and landscape): no sideways scrolling, tap targets large enough', async () => {
  const bad = [];
  for (const [w, h] of [[375, 812], [390, 844], [430, 932], [844, 390]]) {
    await t.resize(w, h); await t.run(`document.querySelector('.fm-nav[data-key="talk"]').click(); await __t.sleep(200); return 1;`);
    for (const v of ['talk', 'write', 'add', 'summary']) {
      const open = v === 'summary' ? `document.querySelector('.fm-nav[data-key="talk"]').click(); await __t.sleep(150); document.querySelector('.fm-status')?.click();` : v === 'talk' ? '' : `document.querySelector('.fm-nav[data-key="${v}"]').click();`;
      const r = await t.run(`${open} await __t.sleep(300);
        const over = [...document.querySelectorAll('#screen *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('table, pre')).length;
        const small = [...document.querySelectorAll('#screen button, #tabs button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 40 || r.width < 40); }).length;
        return { sideways: document.documentElement.scrollWidth > window.innerWidth + 1, over, small };`);
      if (r.sideways || r.over || r.small) bad.push(`${w}x${h} ${v}: ${JSON.stringify(r)}`);
    }
  }
  await t.resize(390, 844); ok(bad.length === 0, bad.slice(0, 5).join(' | '));
});

await t.close(); await browser.close(); if (server) await stopServer(); rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
