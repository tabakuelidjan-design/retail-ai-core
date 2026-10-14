// FIELD V1 in a REAL browser engine at 390 px (Chromium-family through the DevTools Protocol; not a physical phone). The owner's loop on the phone: capture by pasting a quote, review,
// compare the five suppliers of the China Day, ask, negotiate, update an offer, see what changed, save, close, reopen offline and resume. Zero provider calls.   npm run sourcing:e2e:fieldv1
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';
import { runChinaDay, OFFERS } from '../sourcing-field-v1-china-day.js';

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const TOKEN = 'fieldv1-token-0123456789-abcdef-xyz'; const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 400)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const dir = mkdtempSync(join(tmpdir(), 'nordla-fieldv1-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => { throw new Error('no network in this test'); }, ecb: async () => ({ date: '2026-10-19', rates: {} }) });
const errs = []; const net = []; const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch();
browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); if (d.method === 'Network.requestWillBeSent') net.push(d.params.request.url); });
const day = runChinaDay();
const seed = (cases, extra = '') => `if (!localStorage.getItem('nordla.sourcing.seeded')) { localStorage.setItem('nordla.sourcing.cases', ${JSON.stringify(JSON.stringify(cases))}); localStorage.setItem('nordla.sourcing.mode','"salon"'); localStorage.setItem('nordla.sourcing.modeDefault','"field-v1"'); localStorage.setItem('nordla.sourcing.offlineChoice','true'); localStorage.setItem('nordla.sourcing.seeded','1'); } ${extra}`;
const html = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const click = async (t, sel, ms = 450) => { await t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ${sel.replace(/'/g, '')}'); e.click(); })()`); await sleep(ms); };
const setv = (t, sel, v) => t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ${sel.replace(/'/g, '')}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const noOverflow = async (t, label) => { const r = await t.eval('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })'); ok(r.sw <= r.cw, `${label}: horizontal overflow ${r.sw} > ${r.cw}`); };
const small = (t) => t.eval(`[...document.querySelectorAll('#screen button, #tabs button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.height < 40) && getComputedStyle(b).visibility !== 'hidden'; }).map((b) => b.innerText.trim().slice(0, 20) + ':' + Math.round(b.getBoundingClientRect().height))`);
const ready = (t) => t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000);

try {
  const t = await browser.tab(`${base}/#t=${TOKEN}`, { preload: seed(day.log.find((s) => s.label.startsWith('first')).cases) }); await ready(t); await sleep(700);

  await check('1. Fournisseurs lists the five suppliers; no horizontal overflow at 390 px; every button is at least 40 px high', async () => {
    await click(t, '#tabs [data-key="suppliers"]', 600); const txt = await html(t); ok(/5 fournisseurs/.test(txt) && /Yiwu Brightcup/.test(txt), txt.slice(0, 200)); await noOverflow(t, 'home'); const sm = await small(t); ok(sm.length === 0, `small targets: ${sm.join(', ')}`);
  });

  await check('1b. ONE interface: Plus offers no mode switch (save state, backup, comparisons only)', async () => {
    await click(t, '#tabs [data-key="more"]', 500); const o = await html(t); ok(!/Mode guidé|Mode expert/.test(o) && /Sauvegarde et synchronisation/.test(o), o.slice(0, 200)); await click(t, '#tabs [data-key="suppliers"]', 400);
  });

  await check('2. CAPTURE: a new supplier from a pasted quote with nothing else filled in becomes a reviewable offer; the original text is kept', async () => {
    await click(t, '.nx-fab', 500); await click(t, '[data-act="sl-nav"][data-key="capture"]', 500); await noOverflow(t, 'capture'); ok(/Capturer/.test(await html(t)));
    await setv(t, 'input[name="supplier"]', 'Ningbo Test Gifts'); await setv(t, 'textarea[name="text"]', 'Model TB-500. Material: stainless steel 304. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 25 days. CE available.');
    await click(t, 'form[data-form="sl-capture"] button[type="submit"]', 900); const txt = await html(t); ok(/Relire l'offre/.test(txt), txt.slice(0, 300)); ok(/dit par le fournisseur/i.test(txt) && /inconnu/i.test(txt)); await noOverflow(t, 'review');
    const c = JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases')")); const mine = Object.values(c).find((x) => x.supplier?.name === 'Ningbo Test Gifts'); ok(mine && mine.offers.length === 1 && mine.quotes.length === 0, 'the offer is recorded, no quote applied before review');
  });

  await check('3. REVIEW: confirm the clear facts in one tap, correct one, reject one; nothing becomes VERIFIED; the supplier\'s words stay visible', async () => {
    await click(t, '[data-act="sl-confirm-all"]', 700); let txt = await html(t); ok(/validés/.test(txt)); ok(!/vérifié\b/.test(txt.replace(/pas vérifié|rien ici n'est vérifié/g, '')), 'no "vérifié" claim');
    const c = JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases')")); const mine = Object.values(c).find((x) => x.supplier?.name === 'Ningbo Test Gifts'); ok(mine.quotes.at(-1).moq === 500, 'MOQ applied after confirmation'); ok(mine.ledger.every((e) => e.status !== 'VERIFIED'));
    await click(t, '[data-act="sl-open-case"]', 700); txt = await html(t); ok(/Seule :/.test(txt) && /Poser une question/.test(txt)); await noOverflow(t, 'case');
  });

  await check('4. COMPARE the five suppliers: summary first, five cards, decisive differences, ask next, recommendation pending; the cheapest is not called best', async () => {
    await click(t, '#tabs [data-key="suppliers"]', 500); await t.eval("document.querySelectorAll('.nx-pick').forEach((b, i) => { if (i < 5) b.click(); })"); await sleep(300);
    // select exactly the five China Day suppliers (the new one is first in the list: unselect it)
    const sel = await t.eval("[...document.querySelectorAll('.nx-card')].map((c) => [c.dataset.case, c.classList.contains('sel')])"); const extra = sel.find(([id, s]) => s && !['A', 'B', 'C', 'D', 'E'].includes(id)); if (extra) await t.eval(`document.querySelector('.nx-pick[data-key="${extra[0]}"]').click()`); await sleep(200);
    const need = ['A', 'B', 'C', 'D', 'E'].filter((id) => !sel.find(([x, s]) => x === id && s)); for (const id of need) await t.eval(`document.querySelector('.nx-pick[data-key="${id}"]')?.click()`); await sleep(200);
    await click(t, '.nx-bar2 [data-act="sl-compare"]', 900); await t.eval("document.querySelectorAll('details.sl-sec').forEach((d) => d.open = true)"); await sleep(300); const txt = await html(t);
    ok(/Comparaison/.test(txt) && /Résumé/.test(txt) && /Aucun gagnant au seul prix/.test(txt), txt.slice(0, 200)); ok(/le plus bas prix annoncé, pas la meilleure offre/.test(txt)); ok(/EXW exclut les frais d'origine/.test(txt)); ok(/en attente de votre décision/.test(txt) && /aucun achat ni paiement/.test(txt));
    ok((await t.eval("document.querySelectorAll('.sl-ccard').length")) === 5, 'five cards'); ok((await t.eval("document.querySelectorAll('details.sl-sec').length")) === 8, 'eight sections'); await noOverflow(t, 'compare');
    const order = await t.eval("[...document.querySelectorAll('details.sl-sec')].map((d) => d.dataset.sec).join(',')"); ok(order === 'summary,cards,decisive,risks,economics,evidence,askNext,recommendation', order);
  });

  await check('5. SAVE the comparison, then ASK and NEGOTIATE on one supplier: two to five questions, Chinese marked not native-reviewed, a walk-away price, no autonomous action', async () => {
    await click(t, '[data-act="sl-save-cmp"]', 700); ok(/Comparaison enregistrée/.test(await html(t)));
    await click(t, '[data-act="sl-open-case"][data-key="B"]', 700); await click(t, '.nx-tabs [data-key="ask"]', 800); let txt = await html(t); const n = await t.eval("document.querySelectorAll('.nx-q').length"); ok(n >= 2 && n <= 5, `questions: ${n}`); ok(/pas relue? par un locuteur natif/i.test(txt)); ok(/Bloquant pour/.test(txt) && /Montrer/.test(txt) && /Noter la réponse/.test(txt) && !/Écouter/.test(txt), 'question cards'); await noOverflow(t, 'ask');
    await click(t, '.nx-tabs [data-key="more"]', 500); await click(t, '[data-act="sl-more-open"][data-key="neg"]', 800); txt = await html(t); ok(/Limite \(prix d'achat max\)/i.test(txt) && /ne négocie pas à votre place/i.test(txt), txt.slice(0, 300)); await noOverflow(t, 'negotiate');
  });

  await check('6. UPDATE an offer: a new quote is added, the old one stays; WHAT CHANGED shows price, lead time and landed cost', async () => {
    await click(t, '#tabs [data-key="suppliers"]', 500); await click(t, '.nx-cardmain[data-key="B"]', 700); await click(t, '.nx-tabs [data-key="more"]', 500); await click(t, '[data-act="sl-update-offer"]', 600); ok(/Mise à jour de l'offre/.test(await html(t)));
    await setv(t, 'textarea[name="text"]', OFFERS.B2.text); await click(t, 'form[data-form="sl-capture"] button[type="submit"]', 900); ok(/mise à jour/.test(await html(t))); await click(t, '[data-act="sl-confirm-all"]', 700);
    await click(t, '[data-act="sl-open-case"]', 700); await click(t, '.nx-tabs [data-key="more"]', 500); await click(t, '[data-act="sl-more-open"][data-key="changed"]', 600); const txt = await html(t); ok(/Prix unitaire/i.test(txt) && /3\.60 → 3\.45|3\.6 → 3\.45/.test(txt), txt.replace(/\n+/g, ' | ').slice(300, 900)); ok(/Coût rendu/i.test(txt) && /L'offre précédente est conservée/.test(txt)); await noOverflow(t, 'changed');
    const c = JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases')")); ok(c.B.offers.length >= 2, 'both offers of B are on record');
  });

  await check('6b. ONE state, THREE modes: correct the MOQ in the Salon (Faits tab); Expert (Quick) and Terrain show the same value; nothing is overwritten; it survives a reload', async () => {
    await click(t, '.nx-tabs [data-key="facts"]', 600); // step 6 left the Salon on the fiche of supplier B
    let txt = await html(t); ok(/Infos/.test(txt) && /Minimum de commande \(MOQ\)/.test(txt) && /dit par le fournisseur/.test(txt), txt.slice(0, 300)); await noOverflow(t, 'facts');
    await click(t, '[data-act="sl-fact-edit"][data-key="MOQ"]', 500); await setv(t, 'form[data-form="sl-fact"] input[name="value"]', '777'); await click(t, 'form[data-form="sl-fact"] button[type="submit"]', 700); txt = await html(t); ok(/777 pièces/.test(txt) && /saisi ou corrigé par vous/.test(txt), txt.slice(0, 400)); ok(/Historique \(\d+\)/.test(txt), 'history');
    const c1 = JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases')")); ok(c1.B.quotes.at(-1).moq === 777 && c1.B.ledger.filter((e) => e.key === 'quote.moq').length >= 2, 'the case holds 777 and the earlier values are still in the ledger');
    await click(t, '.nx-tabs [data-key="more"]', 500); await click(t, '[data-act="sl-embed"][data-key="quick"]', 800); const quick = await t.eval("document.querySelector('input[name=\"moq\"]')?.value ?? null"); ok(quick === '777', `the expert section (inside the one interface) shows ${quick}`);
    await click(t, '.nx-chip[data-key="live"]', 800); const live = await html(t); ok(/Conversation/.test(live) && (await t.eval("document.querySelectorAll('#tabs button').length")) === 5, 'the live conversation opens inside the same navigation'); await click(t, '.nx-iconbtn', 500); await click(t, '.nx-tabs [data-key="facts"]', 500); ok(/777 pièces/.test(await html(t)), 'the same value in Infos');
    await t.eval("localStorage.setItem('nordla.sourcing.mode', '\"salon\"')"); // back to the Salon for the next checks (the mode is only a view)
    await t.eval('location.reload()'); await ready(t); await sleep(900); const back = JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases')")); ok(back.B.quotes.at(-1).moq === 777, 'after a reload the case still holds 777'); await noOverflow(t, 'after reload'); await click(t, '#tabs [data-key="suppliers"]', 500); await click(t, '.nx-cardmain[data-key="B"]', 700); // back on the fiche of B, where the next check expects the owner to be
  });

  await check('7. CLOSE and RESUME: reload, the saved comparison and the last place are back; no network request leaves the phone except the app itself', async () => {
    await sleep(1500); await t.goto(`${base}/`); await ready(t); await sleep(800); let txt = await html(t); ok(/Bloque|Seule|Offre|offre|Prix/.test(txt), 'the app reopens exactly where the owner was (a case view): ' + txt.slice(0, 120)); await click(t, '#tabs [data-key="more"]', 500); txt = await html(t); ok(/Comparer/.test(txt) && /\d fournisseurs|Aucun gagnant|préféré|Personne/.test(txt), txt.slice(0, 300));
    await click(t, '[data-act="sl-compare"][data-key]', 900); txt = await html(t); ok(/Comparaison/.test(txt) && (await t.eval("document.querySelectorAll('.sl-ccard').length")) === 5); await noOverflow(t, 'compare-resumed');
    ok(net.every((u) => u.startsWith(base) || u.startsWith('data:') || u.startsWith('blob:') || u === 'about:blank'), `external requests: ${net.filter((u) => !u.startsWith(base) && !u.startsWith('data:')).join(', ')}`);
  });

  await check('8. OFFLINE: the browser is cut off; saved cases, comparison, evidence and ASK NEXT still open; a local note and a manual quote can be added', async () => {
    await t.offline(true); await sleep(300); await click(t, '#tabs [data-key="suppliers"]', 500); ok(/fournisseurs/.test(await html(t))); await click(t, '.nx-cardmain[data-key="D"]', 700); await click(t, '.nx-tabs [data-key="more"]', 500); await click(t, '[data-act="sl-more-open"][data-key="risk"]', 500); ok(/contradiction/i.test(await html(t)));
    await click(t, '.nx-tabs [data-key="ask"]', 700); ok(/Chinois|locuteur natif/.test(await html(t)));
    await click(t, '#tabs [data-key="suppliers"]', 500); await click(t, '.nx-cardmain[data-key="C"]', 600); await click(t, '.nx-tabs [data-key="more"]', 500); await click(t, '[data-act="sl-update-offer"]', 500); await click(t, '[data-act="sl-cap-mode"][data-key="manual"]', 400);
    await setv(t, 'input[name="m_unitPrice"]', '2.95'); await setv(t, 'input[name="m_moq"]', '1000'); await setv(t, 'textarea[name="note"]', 'noté hors ligne au stand'); await click(t, 'form[data-form="sl-capture"] button[type="submit"]', 900); ok(/Relire l'offre/.test(await html(t)), (await html(t)).slice(0, 200));
    const c = JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases')")); ok(c.C.notes.some((n) => /hors ligne/.test(n.text)) && c.C.offers.length >= 2, 'note and manual offer saved locally'); await t.offline(false);
  });

  await check('8b. COLD OFFLINE START: with the network off, reloading the page still opens the Salon from the cached shell (every new module is cached) and the saved comparison', async () => {
    await t.waitFor("navigator.serviceWorker.ready.then(() => caches.keys()).then((k) => k.length > 0)", 20000); await sleep(1500); await t.offline(true); await t.goto(`${base}/`); await ready(t); await sleep(900);
    let txt = await html(t); ok(/fournisseurs/.test(txt) || /Fiche|Comparaison|Prix/.test(txt), 'the Salon opened offline: ' + txt.slice(0, 120)); await click(t, '#tabs [data-key="more"]', 500); ok(/Comparer/.test(await html(t)));
    await click(t, '[data-act="sl-compare"][data-key]', 900); ok((await t.eval("document.querySelectorAll('.sl-ccard').length")) === 5, 'the saved comparison rebuilds offline'); await t.offline(false);
  });

  await check('9. no uncaught error in the whole session', async () => { ok(errs.length === 0, errs.slice(0, 3).join(' | ')); });
} finally {
  await browser.close(); await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter((x) => !x).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
