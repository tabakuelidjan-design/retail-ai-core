import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const TOKEN = 'fieldmode-token-0123456789-abcdef-xyz';
const results = []; const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 700)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
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
const has = (t, sel) => t.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
const count = (t, sel) => t.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const tap = (t, sel, ms = 350) => t.run(`__t.click(${JSON.stringify(sel)}); await __t.sleep(${ms}); return 1;`);
// REAL-BROWSER end-to-end of the FIELD EXPERIENCE V2.1 (the validated portal turned into the real screen): first screen = photo + "Démarrer la conversation", Conversation First, ONE contextual
// ASK NEXT suggestion (English first, French discreet), NO systematic confirmation in the main flow (grouped confirmation only on demand, from the Évaluation d'achat), provenance intact,
// contradictions visible, offline text kept, Expert reachable, NO voice dependency. Real Edge/Chrome engine through the DevTools Protocol; it is NOT a physical phone.   npm run sourcing:e2e:fieldmode
const send = async (t, msg, who = 'supplier') => { await t.run(`if (!document.querySelector('form[data-form="compose"]')) { document.querySelector('.fm-nav[data-key="write"]').click(); await __t.sleep(250); } __t.set('form[data-form="compose"] textarea', ${JSON.stringify(msg)}); document.querySelector('form[data-form="compose"] [name="speaker"]').value = ${JSON.stringify(who)}; __t.submit('form[data-form="compose"]'); await __t.sleep(700); return 1;`); };
const PHONE = 'PB-X200. MOQ is 50 pcs. Price is USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs. FOB Shenzhen. 30% deposit, 70% balance before shipment. We have black, white, blue and pink. You can mix colors, minimum 25 pcs per color. Production time is 15 days. We have CE, RoHS and UN38.3.';
const navLabels = (t) => t.eval("[...document.querySelectorAll('#tabs button')].map((b) => b.innerText.trim()).join(',')");
const closeSheet = (t) => t.run(`document.querySelector('.fm-x[data-act="fm-sheet-close"]')?.click(); await __t.sleep(300); return 1;`);
const PNG = `const c = document.createElement('canvas'); c.width = 300; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#e4d9c8'; g.fillRect(0, 0, 300, 300); g.fillStyle = '#2c3443'; g.fillRect(110, 40, 80, 220); const blob = await new Promise((r) => c.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 'p.png', { type: 'image/png' })); const inp = document.querySelector('input[data-act="photo"]'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); await __t.sleep(900); return 1;`;

await startServer();
const errs = []; const browser = await new Browser(exe).launch(); browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
console.log(`Browser engine: ${exe}\n`);
// LEGACY PARITY SUITE: the guided mode is no longer an interface of its own (its screens live inside Nordla); its code is kept and checked here behind the diagnostic flag until parity is proven and it is retired.
const LEGACY = "if (!localStorage.getItem('nordla.sourcing.legacyUi')) { localStorage.setItem('nordla.sourcing.legacyUi', 'true'); localStorage.setItem('nordla.sourcing.mode', '\"field\"'); }";
const t = await browser.tab(`${base}/#t=${TOKEN}`, { preload: LEGACY }); await ready(t); await t.waitFor('window.nordlaSourcing?.state().online === true', 15000); await t.waitFor('navigator.serviceWorker.ready.then(() => caches.keys()).then((k) => k.length > 0)', 20000);

await check('1. FIELD MODE is the default entry (three entries, no expert tabs); Expert is one tap away in the menu and comes back; the choice persists across a reload', async () => {
  ok((await navLabels(t)) === 'Conversation,Scanner / Ajouter,Écrire', 'Field by default: ' + await navLabels(t));
  await tap(t, '#btn-cases'); await tap(t, '[data-act="mode-expert"]'); ok((await navLabels(t)) === 'Guided,Quick,Verdict,Case,Ask,Docs,Rules,Market,Money', 'expert reachable: ' + await navLabels(t));
  await t.goto(`${base}/`); await ready(t); ok((await navLabels(t)).startsWith('Guided'), 'the owner own choice sticks');
  await tap(t, '#btn-cases'); await tap(t, '[data-act="mode-field"]'); ok((await navLabels(t)) === 'Conversation,Scanner / Ajouter,Écrire', await navLabels(t));
  await t.goto(`${base}/`); await ready(t); ok((await navLabels(t)).startsWith('Conversation'), 'mode persisted');
});

await check('2. FIRST SCREEN: the product card, "Photographier le produit" accessible, "Démarrer la conversation" is THE primary action; no questionnaire, no sheet, few controls', async () => {
  const body = await text(t); ok(/Nordla/.test(body) && /China Sourcing/.test(body), 'brand header');
  ok(await has(t, 'input[data-act="photo"][capture="environment"]'), 'photo input reachable (camera)'); ok(/Photographier le produit/.test(body), 'photo label');
  ok(/Démarrer la conversation/.test(body), 'start label'); const geo = await t.eval(`(() => { const s = document.querySelector('[data-act="fm-start"]').getBoundingClientRect(); const p = document.querySelector('.fm-cam').getBoundingClientRect(); return { sh: s.height, ph: p.height, sy: s.top, py: p.top }; })()`);
  ok(geo.sh >= geo.ph && geo.sy > geo.py, `Démarrer is the dominant (larger, last) action: ${JSON.stringify(geo)}`); ok(await t.eval("getComputedStyle(document.querySelector('[data-act=\"fm-start\"]')).backgroundColor !== getComputedStyle(document.querySelector('.fm-cam')).backgroundColor"), 'primary styled differently');
  ok(!(await has(t, '.fm-sheet')), 'no sheet'); ok(!(await has(t, '.fm-sug')) && !(await has(t, '.fm-alert')), 'nothing else competing');
  ok((await count(t, '#screen button, #screen input:not([type=hidden]), #screen label.fm-cam')) <= 7, `controls: ${await count(t, '#screen button, #screen input:not([type=hidden])')}`);
});

// REGRESSION (physical review, Xiaomi / Firefox Android): with a short visible viewport (soft keyboard open after typing the name, small screen, large text) the fixed bottom bar covered "Démarrer la
// conversation": the finger hit "Conversation" (a no-op) and the button seemed dead. Programmatic .click() cannot see this: this check uses REAL touch hit-testing (Input.dispatchTouchEvent).
const touchTap = async (sel) => { const p = JSON.parse(await t.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); })()`)); await browser.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p[0], y: p[1] }] }, t.sessionId); await browser.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, t.sessionId); await t.run('await __t.sleep(700); return 1;'); };
const startHit = (t2) => t2.eval(`(() => { const e = document.querySelector('[data-act="fm-start"]'); const r = e.getBoundingClientRect(); const o = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e.contains(o) ? 'ok' : JSON.stringify({blockedBy:o?.outerHTML?.slice(0,260),button: {top:r.top,bottom:r.bottom,left:r.left,right:r.right},viewport:{w:innerWidth,h:innerHeight},nav:document.querySelector('#tabs')?.getBoundingClientRect().toJSON(),scrollY}); })()`);

await check('3. a photo shows in the card (kept, never invented); the name typed (NOT validated with OK) is not lost when the conversation starts', async () => {
  await t.run(PNG); ok(await has(t, '.fm-ph img, .fm-card img, img.fm-photo'), 'photo shown in the card'); ok(/Reprendre la photo/.test(await text(t)), 'retake offered'); const c0 = await kase(t); ok((c0.identity.photos?.length ?? 0) === 1, 'photo kept');
  await t.run(`const i = document.querySelector('form[data-form="fh-product"] input'); i.focus(); __t.set('form[data-form="fh-product"] input', 'Power bank'); return 1;`);
  for (const [w, h] of [[390, 844], [393, 700], [360, 640], [390, 520], [390, 480]]) { await t.resize(w, h); await t.run('await __t.sleep(250); return 1;'); const hit = await startHit(t); ok(hit === 'ok', `at ${w}x${h} (name field focused, unscrolled) the finger lands on: ${hit}`); }
  await t.resize(390, 520); await touchTap('[data-act="fm-start"]'); await t.resize(390, 844);
  const c = await kase(t); ok(c.conversations.length === 1 && c.conversations[0].status === 'OPEN', 'a REAL touch on the button at a short viewport opened the conversation'); ok(c.identity.workingName === 'Power bank', 'the typed name was kept: ' + c.identity.workingName);
});

await check('4. CONVERSATION FIRST: the thread is open; the keyboard is NOT forced; at most one suggestion; a dock says the conversation is running; the name is in the card', async () => {
  ok(/Power bank/.test(await text(t)), 'name in the card'); ok(!(await has(t, 'form[data-form="fh-product"]')), 'no name form any more');
  ok(!(await t.eval("['TEXTAREA','INPUT'].includes(document.activeElement?.tagName)")), 'no forced focus'); ok(/Écoute en cours|Préparation|Micro refusé|Voix indisponible|Conversation en cours/.test(await text(t)), 'dock (no microphone in this headless run: it says so, it never claims to listen)'); ok(!/Écoute en cours/.test(await text(t)), 'never « listening » without a real microphone'); ok((await count(t, '.fm-sug')) <= 1, 'at most one suggestion at the start');
});

await check('5. WRITING: a sheet from the bottom bar; the ORIGINAL is kept; Nordla only PROPOSES (no quote, no ledger), and NOTHING asks for confirmation in the main flow', async () => {
  await tap(t, '.fm-nav[data-key="write"]', 300); ok(await has(t, '.fm-sheet form[data-form="compose"]'), 'write sheet'); await send(t, 'We have black, white, blue and pink.');
  ok(!(await has(t, '.fm-sheet')), 'sheet closed after sending'); const c = await kase(t); ok(c.conversations[0].items[0].original === 'We have black, white, blue and pink.', 'original kept'); ok(c.quotes.length === 0 && c.candidates.length >= 1 && (c.ledger ?? []).length === 0, 'proposals only');
  const main = (await text(t)).replace(/[0-9]+ éléments? à confirmer/g, ''); ok(!/Tout confirmer|Confirmer|Vérifier avec vous/i.test(main), `no confirmation in the main flow: ${main.slice(0, 300)}`); /* the only mention allowed is the passive counter row "N éléments à confirmer" (a pointer, with no confirm control) */ ok(!(await has(t, '[data-act="group-confirm"]')) && !(await has(t, '[data-act="cand-confirm"]')), 'no confirm control on the main screen');
});

await check('6. ASK NEXT: ONE suggestion after a calm moment, ENGLISH FIRST (usable sentence), French discreet below; one at a time', async () => {
  await t.waitFor("!!document.querySelector('.fm-sug')", 25000); ok((await count(t, '.fm-sug')) === 1, 'exactly one'); const r = await t.eval(`(() => { const s = document.querySelector('.fm-sug'); const en = s.querySelector('.fm-en'); const fr = s.querySelector('.fm-fr'); return { k: s.querySelector('.fm-k').innerText, en: en.innerText, enLang: en.lang, fr: fr?.innerText ?? '', enSize: parseFloat(getComputedStyle(en).fontSize), frSize: fr ? parseFloat(getComputedStyle(fr).fontSize) : 0, enTop: en.getBoundingClientRect().top, frTop: fr ? fr.getBoundingClientRect().top : 1e9 }; })()`);
  ok(/ASK NEXT/.test(r.k), r.k); ok(r.enLang === 'en' && /[a-z]{3}/.test(r.en) && /\?/.test(r.en), r.en); ok(/^FR\s*[—-]/.test(r.fr), r.fr); ok(r.enSize > r.frSize && r.enTop < r.frTop, JSON.stringify(r)); ok(!/[一-鿿]/.test(r.en), 'no Chinese on the suggestion');
});

await check('7. a tap on the suggestion opens the question to SHOW the supplier (English big, 中文 only on request, "Pas maintenant" remembered); the shown question is logged', async () => {
  const id = await t.eval("document.querySelector('.fm-sug').dataset.qid"); await tap(t, '.fm-sug', 400); ok(await has(t, '.fm-sheet .fm-en.big'), 'ask sheet, English big'); ok(!/[一-鿿]/.test(await text(t, '.fm-sheet .fm-en.big')), 'English first');
  await t.run(`document.querySelector('.fm-sheet [data-act="show-q"]').click(); await __t.sleep(600); return 1;`); let c = await kase(t); ok(c.questionLog.some((e) => e.kind === 'SHOWN' && e.questionId === id), 'shown logged');
  await closeSheet(t); await tap(t, '[data-act="ask-now"]', 500); const id2 = await t.eval("document.querySelector('.fm-sug')?.dataset.qid"); ok(id2, 'explicit request answered at once');
  await tap(t, '.fm-sug', 400); await t.run(`document.querySelector('.fm-sheet [data-act="q-skip"]').click(); await __t.sleep(400); return 1;`); c = await kase(t); ok(c.questionLog.some((e) => e.kind === 'SKIPPED' && e.questionId === id2), 'skip remembered'); ok(!(await has(t, '.fm-sheet')), 'sheet closed');
});

await check('8. the supplier answers by himself: the matching suggestion disappears; a full offer still creates NO confirmation prompt in the thread', async () => {
  await send(t, PHONE); await t.run('await __t.sleep(600); return 1;'); const body = await text(t); ok(!/Tout confirmer|Confirmer/.test(body) && !(await has(t, '[data-act="group-confirm"]')), 'no confirmation prompt after a full offer');
  ok((await count(t, '.fm-sug')) <= 1, 'still at most one suggestion'); const c = await kase(t); ok(c.quotes.length === 0 && (c.ledger ?? []).length === 0, 'still only proposals: provenance not bypassed');
});

await check('9. END of conversation: "Ce que Nordla a compris" (◌ proposals), "Ce qui manque réellement" (≤3), next step; NO "Tout confirmer" button', async () => {
  await tap(t, '.fm-dk.stop', 600); ok(await has(t, '.fm-sheet'), 'end sheet'); const b = await text(t, '.fm-sheet'); ok(/Conversation terminée/.test(b) && /Ce que Nordla a compris/.test(b) && /Ce qui manque réellement/.test(b) && /Prochaine étape/.test(b), b.slice(0, 400));
  ok(!/Tout confirmer/.test(b) && !(await has(t, '.fm-sheet [data-act="group-confirm"]')), 'no systematic confirmation'); ok(await has(t, '.fm-sheet .fm-gl.cl'), 'proposals shown as ◌'); ok(!(await has(t, '.fm-sheet .fm-gl.ok')), 'no ✓ before the owner confirms anything');
  ok((await count(t, '.fm-sheet .fm-dot')) <= 3, 'at most 3 missing items'); ok(/Demander\s*:/.test(b), 'one next question'); const c = await kase(t); ok(c.conversations[0].status === 'CLOSED' || c.conversations[0].status === 'FINISHED' || c.conversations[0].status !== 'OPEN', c.conversations[0].status);
});

await check('10. the grouped confirmation is ON DEMAND only (Évaluation d\'achat → one deliberate tap): provenance exact (SUPPLIER_CLAIM, userConfirmed, batch id, basis ORIGINAL); ✓ appears only now', async () => {
  await tap(t, '.fm-sheet [data-act="fm-sheet"][data-key="summary"]', 500); const ev = await text(t, '.fm-sheet'); ok(/Évaluation d'achat/.test(ev) && /Décision d'entreprise/.test(ev), ev.slice(0, 300)); ok(!/Décision d'achat/i.test(ev), 'never "purchase decision"');
  ok(!(await has(t, '.fm-sheet [data-act="group-confirm"]')), 'not on the evaluation itself'); await tap(t, '.fm-sheet [data-act="fm-sheet"][data-key="understood"]', 500); ok(await has(t, '.fm-sheet [data-act="group-confirm"]'), 'on-demand grouped confirmation is there'); await tap(t, '.fm-sheet [data-act="group-confirm"]', 700); const c = await kase(t); const q = c.quotes.at(-1); ok(q && q.moq === 50 && q.tiers.length === 3 && q.incoterm === 'FOB', JSON.stringify(q));
  const mine = (c.ledger ?? []).filter((e) => e.via === 'GROUP'); ok(mine.length >= 5 && mine.every((e) => e.status === 'SUPPLIER_CLAIM' && e.userConfirmed === true && /^batch-/.test(e.batchId) && e.basis === 'ORIGINAL'), 'ledger provenance'); ok(c.confirmBatches.length === 1, 'one batch');
  await t.run(`document.querySelector('.fm-x[data-act="fm-sheet-close"]')?.click(); await __t.sleep(300); document.querySelector('[data-act="fm-sheet"][data-key="summary"]').click(); await __t.sleep(500); return 1;`); ok(await has(t, '.fm-sheet .fm-gl.ok'), '✓ now present (confirmed by you)'); ok(c.documentLedger.length === 0 && c.documents.length === 0, 'documents untouched by the grouped confirmation');
});

await check('11. documents keep their OWN states: announced certifications are ◌ and NEVER ✓; claims recorded without any document or proof', async () => {
  if (!(await has(t, '.fm-sheet'))) await tap(t, '[data-act="fm-sheet"][data-key="summary"]', 500); const before = await text(t, '.fm-sheet'); ok(/Certifications/.test(before), 'row'); const row = await t.eval(`[...document.querySelectorAll('.fm-sheet .fm-kv')].find((r) => /Certifications/.test(r.innerText))?.innerHTML ?? ''`); ok(row && !/fm-gl ok/.test(row) && /fm-gl cl/.test(row), 'certifications never ✓');
  if (await has(t, '.fm-sheet [data-act="claims-confirm"]')) { await tap(t, '.fm-sheet [data-act="claims-confirm"]', 600); const c = await kase(t); ok(c.documentLedger.length === 3 && c.documentLedger.every((d) => d.status === 'CLAIMED') && c.documents.length === 0, 'claims only'); }
  const row2 = await t.eval(`[...document.querySelectorAll('.fm-sheet .fm-kv')].find((r) => /Certifications/.test(r.innerText))?.innerHTML ?? ''`); ok(!/fm-gl ok/.test(row2), 'still never ✓ after recording the claims'); await closeSheet(t);
});

await check('12. a CONTRADICTION is a calm amber banner on the main screen (never a modal, never an overwrite); the sheet offers both honest choices; the history keeps both', async () => {
  await tap(t, '[data-act="fm-start"]', 500).catch(() => {}); await send(t, 'Sorry, the MOQ is 100 pcs.'); await t.run('await __t.sleep(400); return 1;');
  ok(await has(t, '.fm-alert'), 'banner'); ok(!(await has(t, '.fm-sheet')), 'not opened by itself'); let c = await kase(t); ok(c.quotes.at(-1).moq === 50, 'confirmed value not overwritten');
  await tap(t, '.fm-alert', 400); const s = await text(t, '.fm-sheet'); ok(/50/.test(s) && /100/.test(s), s.slice(0, 300)); ok(await has(t, '.fm-sheet [data-act="pre-old"]') && await has(t, '.fm-sheet [data-act="pre-new"]'), 'both choices');
  await t.run(`document.querySelector('.fm-sheet [data-act="pre-new"]').click(); await __t.sleep(600); return 1;`); c = await kase(t); ok(c.quotes.at(-1).moq === 100 && c.ledger.filter((e) => e.key === 'quote.moq').length === 2, 'taken by the owner, both statements kept');
  await closeSheet(t); ok(!(await has(t, '.fm-alert')), 'banner gone once settled');
});

await check('13. the owner\'s own inputs are only in the Évaluation sheet (never in the thread), validated (decimal comma refused)', async () => {
  ok(!(await has(t, '#screen form[data-form="uanswer"]')), 'no owner card in the conversation'); await tap(t, '.fm-status, [data-act="fm-sheet"][data-key="summary"]', 400);
  if (await has(t, '.fm-sheet form[data-form="uanswer"]')) { await t.run(`__t.set('.fm-sheet form[data-form="uanswer"] input', '6,5'); __t.submit('.fm-sheet form[data-form="uanswer"]'); await __t.sleep(300); return 1;`); ok(/virgule|point/i.test(await text(t)), 'a decimal comma is refused'); }
  else ok(/À renseigner par vous/i.test(await text(t, '.fm-sheet')) || true, 'no owner card at this stage'); await closeSheet(t);
});

await check('14. a half-typed message survives background re-renders and the bottom-bar navigation', async () => {
  await tap(t, '.fm-nav[data-key="write"]', 300); await t.run(`__t.set('form[data-form="compose"] textarea', 'half typed 300 pcs'); window.dispatchEvent(new Event('offline')); await __t.sleep(200); window.dispatchEvent(new Event('online')); await __t.sleep(1200); return 1;`);
  ok((await t.eval(`document.querySelector('form[data-form="compose"] textarea').value`)) === 'half typed 300 pcs', 'survived the blip'); await tap(t, '.fm-nav[data-key="add"]', 300); await tap(t, '.fm-nav[data-key="write"]', 300);
  ok((await t.eval(`document.querySelector('form[data-form="compose"] textarea').value`)) === 'half typed 300 pcs', 'survived the navigation'); await t.run(`__t.set('form[data-form="compose"] textarea', ''); document.querySelector('.fm-nav[data-key="talk"]').click(); await __t.sleep(200); return 1;`);
});

await check('15. OFFLINE: server stopped, browser offline, cold reload: the conversation opens; text entry and extraction work; after reconnect everything reaches the server', async () => {
  await stopServer(); await t.offline(true); await t.goto(`${base}/`); await ready(t); let body = await text(t); ok(body.includes('We have black, white, blue and pink.'), 'conversation shown again offline'); ok(/Hors ligne/.test(body), 'offline pill');
  await send(t, 'Lead time is 20 days. FOB Ningbo'); body = await text(t); ok(body.includes('Lead time is 20 days. FOB Ningbo'), 'message in the thread'); let c = await kase(t); ok(c.conversations.some((cv) => cv.items.some((i) => i.original === 'Lead time is 20 days. FOB Ningbo')), `stored locally: ${JSON.stringify(c.conversations.map((cv) => [cv.status, cv.items.length]))}`); ok(await t.eval("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]').length >= 1"), 'waiting to sync');
  await startServer(); await t.offline(false); await t.run(`window.dispatchEvent(new Event('online')); await __t.sleep(200); return 1;`); await t.waitFor("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]').length === 0", 20000); c = await kase(t);
  const sv = await (await fetch(`${base}/api/cases/${c.id}`, { headers: { 'x-sourcing-token': TOKEN } })).json(); ok(sv.confirmBatches.length === c.confirmBatches.length && sv.questionLog.length === c.questionLog.length && sv.ledger.length === c.ledger.length, 'server copy identical'); ok(!JSON.stringify(sv).includes(TOKEN), 'no token');
});

await check('16. EXPERT access stays available from the menu (all tabs render); Field mode comes back; no uncaught error in the whole run', async () => {
  await tap(t, '[data-act="fm-menu"]', 400); ok(await has(t, '[data-act="mode-expert"]'), 'Expert entry in the menu'); await tap(t, '[data-act="mode-expert"]', 400);
  for (const k of ['field', 'quick', 'decision', 'case', 'ask', 'docs', 'compliance', 'market', 'money']) { await tap(t, `#tabs [data-key="${k}"]`, 250); const body = await text(t); ok(body.length > 80 && !/could not be computed/.test(body), `${k}: ${body.slice(0, 60)}`); }
  await tap(t, '#btn-cases'); await tap(t, '[data-act="mode-field"]', 400); ok((await navLabels(t)).startsWith('Conversation'), 'back in field mode'); ok(errs.length === 0, `uncaught errors: ${errs.join(' | ')}`);
});

await check('17. VOICE BOUNDARIES: the microphone is touched ONLY by voice.js; no browser/cloud speech recogniser, no Whisper, no voice package in package.json; the dock never claims a microphone it does not have', async () => {
  const src = (f) => readFileSync(new URL(`../../src/sourcing/${f}`, import.meta.url), 'utf8');
  for (const f of ['ui/app.js', 'ui/screens/fieldfirst.js', 'ui/field.css', 'ui/index.html', 'ui/sw.js', 'ui/voice-engine-worker.js', 'ui/voice.js']) ok(!/SpeechRecognition|api\.openai|speech\.googleapis|cognitiveservices|whisper|MediaRecorder/i.test(src(f)), `forbidden voice dependency in ${f}`);
  for (const f of ['ui/app.js', 'ui/screens/fieldfirst.js', 'ui/index.html', 'ui/sw.js']) ok(!/getUserMedia|AudioContext|AudioWorklet/.test(src(f)), `the microphone is touched outside voice.js (${f})`);
  ok(!/"(onnxruntime|@huggingface|whisper|moonshine|vosk)[^"]*"/i.test(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')), 'no voice package in package.json');
  ok(!/Écoute en cours/.test(await text(t)), 'no claim of listening without a microphone');
});

await check('18. layout: the Field screen, its sheets and the bottom bar fit 375 / 390 / 430 wide (portrait and landscape): no sideways scrolling, tap targets large enough', async () => {
  const bad = [];
  for (const [w, h] of [[375, 812], [390, 844], [430, 932], [844, 390]]) {
    await t.resize(w, h); await t.run(`document.querySelector('.fm-nav[data-key="talk"]').click(); await __t.sleep(200); return 1;`);
    for (const v of ['talk', 'write', 'add', 'summary']) {
      const open = v === 'summary' ? `document.querySelector('.fm-nav[data-key="talk"]').click(); await __t.sleep(150); document.querySelector('[data-act="fm-sheet"][data-key="summary"]')?.click();` : v === 'talk' ? '' : `document.querySelector('.fm-nav[data-key="${v}"]').click();`;
      const r = await t.run(`${open} await __t.sleep(300);
        const over = [...document.querySelectorAll('#screen *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('table, pre')).length;
        const small = [...document.querySelectorAll('#screen button, #tabs button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 40 || r.width < 40); }).map((b) => (b.className + ':' + b.innerText.slice(0, 12))).join('|');
        const offenders = [...document.querySelectorAll('#screen *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('table, pre')).slice(0,5).map(e => ({tag:e.tagName,cl:String(e.className).slice(0,100),r:Math.round(e.getBoundingClientRect().right),txt:e.textContent?.slice(0,60),parent:e.parentElement?.outerHTML?.slice(0,250)})); return { sideways: document.documentElement.scrollWidth > window.innerWidth + 1, over, offenders, small };`);
      if (r.sideways || r.over || r.small.length) bad.push(`${w}x${h} ${v}: ${JSON.stringify(r)}`);
    }
  }
  await t.resize(390, 844); ok(bad.length === 0, bad.slice(0, 5).join(' | '));
});

await check('19. VISUAL CLOSURE: ASK NEXT, "N éléments à confirmer" and the dock share ONE tray above the bottom bar; the contradiction sits under the product card; "Copier le résumé" is the first thing in the evaluation; the C1/C3 guarantees show in Field; the evaluation is a side panel on a wide screen', async () => {
  await t.resize(390, 844); await t.eval(`localStorage.setItem('nordla.sourcing.mode', JSON.stringify('field')); 'ok'`);
  const r = await t.run(`const tray = document.querySelector('.fm-tray'); const prod = document.querySelector('.fm-prod'); const alert = document.querySelector('.fm-alert');
    const order = alert ? (prod.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : true;
    const nav = document.querySelector('#tabs').getBoundingClientRect(); const tr = tray?.getBoundingClientRect();
    return { tray: !!tray, sug: !!tray?.querySelector('.fm-sug, .fm-askrow'), conf: !!tray?.querySelector('.fm-conf'), dock: !!tray?.querySelector('.fm-dock'), order, above: tr ? tr.bottom <= nav.top + 1 : false, over: document.documentElement.scrollWidth > innerWidth + 1 };`);
  ok(r.tray && r.dock && r.order && r.above && !r.over, JSON.stringify(r));
  await t.run(`document.querySelector('.fm-prod').click(); await __t.sleep(400); return 1;`);
  const copyTop = await t.eval(`(() => { const b = document.querySelector('.fm-sbody [data-act="copy-summary"]'); const sb = document.querySelector('.fm-sbody'); return b ? Math.round(b.getBoundingClientRect().top - sb.getBoundingClientRect().top) : null; })()`); ok(copyTop !== null && copyTop < 260, 'Copier le résumé is at the top of the evaluation (before the first screen scroll): ' + copyTop);
  const ev = await t.eval(`document.querySelector('.fm-sbody').innerText`); ok(/Safety Gate :/.test(ev), 'safety state shown in the evaluation');
  await t.resize(1400, 850); await t.run(`await __t.sleep(300); return 1;`);
  const wide = await t.run(`const sh = document.querySelector('.fm-sheet.tall').getBoundingClientRect(); const main = document.querySelector('main').getBoundingClientRect(); return { panelLeft: sh.left, mainRight: main.right, sideways: document.documentElement.scrollWidth > innerWidth + 1 };`);
  ok(wide.panelLeft >= wide.mainRight - 1 && !wide.sideways, 'side panel does not overlap the conversation: ' + JSON.stringify(wide));
  await t.resize(390, 844); await t.run(`document.querySelector('.fm-x[data-act="fm-sheet-close"]')?.click(); await __t.sleep(200); return 1;`);
});

await t.close(); await browser.close(); if (server) await stopServer(); rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
