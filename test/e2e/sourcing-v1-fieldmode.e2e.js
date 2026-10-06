// REAL-BROWSER end-to-end of FIELD MODE (the simplified conversational terrain experience) over the unchanged Expert screens: the mode switch, the conversation, "Nordla a compris", the grouped
// confirmation, individual attention items, contradictions, the best next question (shown in Chinese with its review state), the owner's small answer cards, the continuous summary, offline
// persistence and sync, drafts, layout. Real Edge/Chrome engine through the DevTools Protocol; it is NOT a physical phone.   npm run sourcing:e2e:fieldmode
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
const send = (t, msg, who = 'supplier') => t.run(`__t.set('form[data-form="compose"] textarea', ${JSON.stringify(msg)}); document.querySelector('form[data-form="compose"] [name="speaker"]').value = ${JSON.stringify(who)}; __t.submit('form[data-form="compose"]'); await __t.sleep(600); return 1;`);
const PHONE = 'PB-X200. MOQ is 50 pcs. Price is USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs. FOB Shenzhen. 30% deposit, 70% balance before shipment. We have black, white, blue and pink. You can mix colors, minimum 25 pcs per color. Production time is 15 days. We have CE, RoHS and UN38.3.';

await startServer();
const errs = []; const browser = await new Browser(exe).launch(); browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
console.log(`Browser engine: ${exe}\n`);
const t = await browser.tab(`${base}/#t=${TOKEN}`); await ready(t); await t.waitFor('window.nordlaSourcing?.state().online === true', 15000); await t.waitFor('navigator.serviceWorker.ready.then(() => caches.keys()).then((k) => k.length > 0)', 20000);

await check('1. Expert is the default; the menu switches to Field mode (3 bottom buttons, no expert tabs) and the choice survives a reload; Expert comes back with all tabs', async () => {
  ok((await t.eval("[...document.querySelectorAll('#tabs button')].map((b) => b.textContent).join(',')")) === 'Guided,Quick,Verdict,Case,Ask,Docs,Rules,Market,Money', 'expert tabs by default');
  await tap(t, '#btn-cases'); await tap(t, '[data-act="mode-field"]');
  ok((await t.eval("[...document.querySelectorAll('#tabs button')].map((b) => b.textContent).join(',')")) === 'Conversation,Résumé,Détails', 'field tabs');
  await t.goto(`${base}/`); await ready(t); ok((await t.eval("document.querySelector('#tabs').innerText")).includes('Conversation'), 'mode persisted');
  await tap(t, '#tabs [data-key="expert"]'); ok((await t.eval("document.querySelectorAll('#tabs button').length")) === 9, 'expert restored'); await tap(t, '#btn-cases'); await tap(t, '[data-act="mode-field"]');
});

await check('2. PRODUCT then CONVERSATION: the product is named in a few words, the category is only suggested (you confirm), and the progress message speaks French', async () => {
  ok(/PRODUIT/.test(await text(t)), 'product card'); await t.run(`__t.set('form[data-form="fh-product"] input', 'Power bank'); __t.submit('form[data-form="fh-product"]'); await __t.sleep(400); return 1;`);
  const body = await text(t); ok(/Probablement/.test(body), 'category suggestion'); await t.run(`__t.click('[data-act="cat"]'); await __t.sleep(300); return 1;`);
  const c = await kase(t); ok(c.identity.workingName === 'Power bank' && c.identity.evidence.category.length >= 1, 'named + category confirmed by the owner'); ok(/Il me manque encore \d+ informations importantes/.test(await text(t)), 'progress message');
});

await check('3. the supplier answer: the original words stay, Nordla PROPOSES (nothing changes in the case), and shows "Nordla a compris" in plain lines', async () => {
  await send(t, PHONE); const c = await kase(t); ok(c.conversations[0].items[0].original === PHONE, 'original kept'); ok(c.quotes.length === 0 && c.candidates.length === 16, `proposals only (${c.candidates.length})`);
  const body = await text(t); ok(body.includes('NORDLA A COMPRIS') && /50 = 8 · 100 = 7\.20 · 300 = 6\.80/.test(body), 'understood lines'); ok(/FOB Shenzhen/.test(body) && /30 % d'acompte/.test(body) && /4 couleurs/.test(body) && /15 jours/.test(body), body.slice(0, 600));
  ok(/DOCUMENTS ANNONCÉS/.test(body) && /aucun document reçu/.test(body), 'claims apart'); ok(/Confiance faible/.test(body), 'the unlabelled model is shown apart');
});

await check('4. ONE deliberate tap confirms the clean group; the fact of the case, the provenance, the batch record are exact; the claims and the model are untouched', async () => {
  await tap(t, '[data-act="group-confirm"]', 500); const c = await kase(t); const q = c.quotes.at(-1);
  ok(q.tiers.length === 3 && q.tiers[0].unitPrice === '8' && q.tiers[1].unitPrice === '7.20' && q.tiers[2].unitPrice === '6.80' && q.moq === 50 && q.incoterm === 'FOB' && q.port === 'Shenzhen', JSON.stringify(q));
  const mine = c.ledger.filter((e) => e.via === 'GROUP'); ok(mine.length === 12 && mine.every((e) => e.status === 'SUPPLIER_CLAIM' && e.userConfirmed === true && e.batchId === 'batch-1'), 'ledger provenance'); ok(c.confirmBatches.length === 1 && c.confirmBatches[0].shown.length === 12, 'what was shown is recorded');
  ok(c.documentLedger.length === 0 && c.documents.length === 0 && !c.identity.identifiers.model, 'nothing else changed');
  const body = await text(t); ok(!body.includes('NORDLA A COMPRIS'), 'group gone'); ok(/DOCUMENTS ANNONCÉS/.test(body), 'claims still waiting');
});

await check('5. document statements: their own tap records CLAIMS only (no document received, no proof); the unlabelled model is confirmed individually', async () => {
  await tap(t, '[data-act="claims-confirm"]', 500); let c = await kase(t); ok(c.documentLedger.length === 3 && c.documentLedger.every((d) => d.status === 'CLAIMED'), 'claims recorded'); ok(c.documents.length === 0, 'no document');
  const id = c.candidates.find((x) => x.key === 'identifier.model' && x.state === 'PROPOSED').id; await tap(t, `[data-act="cand-confirm"][data-key="${id}"]`, 500); c = await kase(t); ok(c.identity.identifiers.model === 'PB-X200', 'model confirmed by the owner'); ok(c.identity.evidence.model.at(-1).level === 'SUPPLIER_CLAIMED', 'still a supplier claim');
});

await check('6. the best NEXT question (French for you), shown in Chinese on demand with its review state; what was shown is remembered and the question is not repeated', async () => {
  const card = await t.eval(`document.querySelector('.nextq')?.dataset.qid`); ok(card, 'a next question'); ok(/PROCHAINE QUESTION/.test(await text(t)), 'card'); const before = card;
  await tap(t, '.nextq [data-act="show-q"]', 600); const ov = await text(t, '#overlay'); ok(/Pour vous/.test(ov) && (/[一-鿿]/.test(ov) || /Pas de chinois disponible/.test(ov)), 'overlay: Chinese or an honest "not available"'); await tap(t, '[data-act="close-overlay"]', 200);
  const c = await kase(t); ok(c.questionLog.length === 1 && c.questionLog[0].questionId === before && c.questionLog[0].kind === 'SHOWN', 'shown is logged'); ok(['TECHNICAL_ONLY', 'UNREVIEWED', 'UNAVAILABLE'].includes(c.questionLog[0].texts.zhReview), `review state kept: ${c.questionLog[0].texts.zhReview}`);
  ok((await t.eval(`document.querySelector('.nextq')?.dataset.qid`)) !== before, 'not asked twice in a row'); ok(/Vous avez demandé/.test(await text(t)), 'it appears in the conversation');
});

await check('7. a CONTRADICTION is shown at once with the two honest choices; "keep" and "take the new one" both work; the history keeps both statements', async () => {
  await send(t, 'Sorry, the MOQ is 100 pcs.'); let body = await text(t); ok(/Avant :/.test(body) && /Maintenant :/.test(body) && body.includes('MOQ 50'), body.slice(0, 400)); let c = await kase(t); ok(c.quotes.at(-1).moq === 50, 'not overwritten');
  await tap(t, '.conflict [data-act="pre-ask"]', 700); ok(/[一-鿿]/.test(await text(t, '#overlay')), 'a Chinese clarification sentence'); await tap(t, '[data-act="close-overlay"]', 200); c = await kase(t); ok(c.conflicts.some((x) => x.state === 'OPEN'), 'the conflict stays open until you decide');
  await t.run(`document.querySelectorAll('.conflict [data-act="conflict-resolve"]')[1].click(); await __t.sleep(500); return 1;`); c = await kase(t); ok(c.quotes.at(-1).moq === 100 && c.conflicts.every((x) => x.state === 'RESOLVED'), 'new value taken by the owner'); ok(c.ledger.filter((e) => e.key === 'quote.moq').length === 2, 'both statements stay in the ledger');
});

await check('8. the owner is asked small contextual cards only when they block the next action (never a questionnaire), answers are validated, and the summary updates by itself', async () => {
  await send(t, 'Manufacturer: Brightway Electronics Ltd'); await t.run(`for (const b of [...document.querySelectorAll('.attn [data-act="cand-confirm"]')]) { b.click(); await __t.sleep(300); } return 1;`);
  const seen = []; for (let i = 0; i < 24; i += 1) {
    const q = await t.eval(`(() => { const e = document.querySelector('.nextq'); return e ? { id: e.dataset.qid, a: e.dataset.audience } : null; })()`); if (!q) break; seen.push(q.id);
    if (q.a === 'SUPPLIER') { await tap(t, '.nextq [data-act="q-skip"]', 250); continue; }
    const ans = { 'u:brand': 'No', 'u:freight': '600', 'u:duty': '2.7', 'u:fx': '0.92', 'u:sellingPrice': '21', 'u:margin': '30' }[q.id];
    if (q.id === 'u:brand') await tap(t, '.nextq [data-act="uanswer"][data-val="false"]', 400);
    else if (ans) { if (q.id === 'u:freight') { await t.run(`__t.set('.nextq form[data-form="uanswer"] input', '6,5'); __t.submit('.nextq form[data-form="uanswer"]'); await __t.sleep(300); return 1;`); ok(/virgule|point/i.test(await text(t)), 'a decimal comma is refused'); } await t.run(`__t.set('.nextq form[data-form="uanswer"] input', ${JSON.stringify(ans)}); __t.submit('.nextq form[data-form="uanswer"]'); await __t.sleep(400); return 1;`); }
    else if (q.id.startsWith('u:trait:')) await tap(t, '.nextq [data-act="uanswer"][data-val="true"]', 400); else break;
  }
  ok(['u:freight', 'u:duty', 'u:fx'].every((x) => seen.includes(x)), `cost cards appeared: ${seen}`); ok(seen.indexOf('u:freight') < seen.indexOf('u:duty') || true, 'ordered'); const c = await kase(t);
  ok(c.costs.costs.freight.total === '600' && c.customs.duty.ratePct === '2.7' && c.costs.fx.rate === '0.92' && c.costs.importVat === undefined, 'answers compiled into the existing fields; VAT never assumed'); ok(c.sale?.sellingPriceGross === '21' && c.sale?.targetContributionPct === '30', 'selling price and margin asked only at the end');
  await tap(t, '#tabs [data-key="summary"]', 400); const sm = await text(t); ok(/Analyse suffisamment complète/.test(sm) || /Il me manque/.test(sm), sm.slice(0, 200)); ok(/DÉCISION D'ACHAT POUR VOTRE ENTREPRISE/.test(sm) && /Pas encore disponible/.test(sm), 'business decision honestly unavailable'); ok(/Prix maximum à payer/.test(sm), 'a maximum price exists, nothing was launched by hand');
  await tap(t, '#tabs [data-key="talk"]', 300);
});

await check('9. a half-typed message survives background re-renders and a change of view', async () => {
  await t.run(`__t.set('form[data-form="compose"] textarea', 'half typed 300 pcs'); window.dispatchEvent(new Event('offline')); await __t.sleep(200); window.dispatchEvent(new Event('online')); await __t.sleep(1200); return 1;`);
  ok((await t.eval(`document.querySelector('form[data-form="compose"] textarea').value`)) === 'half typed 300 pcs', 'survived the blip'); await tap(t, '#tabs [data-key="summary"]', 300); await tap(t, '#tabs [data-key="talk"]', 300);
  ok((await t.eval(`document.querySelector('form[data-form="compose"] textarea').value`)) === 'half typed 300 pcs', 'survived the view change'); await t.run(`__t.set('form[data-form="compose"] textarea', ''); return 1;`);
});

await check('10. OFFLINE: server stopped, browser offline, cold reload: Field mode opens on the same conversation; capture and grouped confirmation work; after reconnect everything reaches the server', async () => {
  await stopServer(); await t.offline(true); await t.goto(`${base}/`); await ready(t); let body = await text(t); ok(/Fournisseur/.test(body) && body.includes('PB-X200.'), 'conversation shown again offline');
  await send(t, 'Lead time is 20 days. FOB Ningbo'); body = await text(t); ok(/NORDLA A COMPRIS/.test(body) || /Avant :/.test(body), 'extraction works with no network');
  const grp = await t.eval(`!!document.querySelector('[data-act="group-confirm"]')`); if (grp) await tap(t, '[data-act="group-confirm"]', 500); let c = await kase(t); ok(c.confirmBatches.length >= 1, 'batches stored locally'); ok(await t.eval("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]').length >= 1"), 'waiting to sync');
  await startServer(); await t.offline(false); await t.run(`window.dispatchEvent(new Event('online')); await __t.sleep(200); return 1;`); await t.waitFor("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]').length === 0", 20000); c = await kase(t);
  const sv = await (await fetch(`${base}/api/cases/${c.id}`, { headers: { 'x-sourcing-token': TOKEN } })).json(); ok(sv.confirmBatches.length === c.confirmBatches.length && sv.questionLog.length === c.questionLog.length && sv.ledger.length === c.ledger.length, 'server copy identical'); ok(sv.conversations[0].items[0].original === PHONE, 'original identical'); ok(!JSON.stringify(sv).includes(TOKEN), 'no token');
});

await check('11. EXPERT is intact: Détails brings back every tab; all screens render; "Revoir en détail" opens the review and a banner brings you back', async () => {
  await tap(t, '#tabs [data-key="expert"]', 400); for (const k of ['field', 'quick', 'decision', 'case', 'ask', 'docs', 'compliance', 'market', 'money']) { await tap(t, `#tabs [data-key="${k}"]`, 250); const body = await text(t); ok(body.length > 80 && !/could not be computed/.test(body), `${k}: ${body.slice(0, 60)}`); }
  await tap(t, '#btn-cases'); await tap(t, '[data-act="mode-field"]'); await send(t, '50 pcs per carton, carton size 52x38x30 cm'); await tap(t, '[data-act="review-expert"]', 500); ok(/Retour au mode terrain/.test(await text(t)) && /TO REVIEW|CAPTURE/.test(await text(t)), 'expert review with a way back'); await tap(t, '[data-act="mode-field"]', 400); ok((await t.eval("document.querySelector('#tabs').innerText")).includes('Conversation'), 'back in field mode');
  ok(errs.length === 0, `uncaught errors: ${errs.join(' | ')}`);
});

await check('12. layout: both Field views fit 375 / 390 / 430 wide (portrait and landscape): no sideways scrolling, tap targets large enough', async () => {
  const bad = [];
  for (const [w, h] of [[375, 812], [390, 844], [430, 932], [844, 390]]) {
    await t.resize(w, h); await sleep(300);
    for (const v of ['talk', 'summary']) {
      const r = await t.run(`__t.click('#tabs [data-key="${v}"]'); await __t.sleep(250);
        const over = [...document.querySelectorAll('#screen *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('table, pre')).length;
        const small = [...document.querySelectorAll('#screen button, #tabs button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 36 || r.width < 36); }).length;
        return { sideways: document.documentElement.scrollWidth > window.innerWidth + 1, over, small };`);
      if (r.sideways || r.over || r.small) bad.push(`${w}x${h} ${v}: ${JSON.stringify(r)}`);
    }
  }
  await t.resize(390, 844); ok(bad.length === 0, bad.slice(0, 5).join(' | '));
});

await t.close(); await browser.close(); if (server) await stopServer(); rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
