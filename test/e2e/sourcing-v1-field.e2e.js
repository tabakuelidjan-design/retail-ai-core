// REAL-BROWSER end-to-end of the V1 field foundation: the Field workflow shell, conversation capture, candidate review (confirm / correct / reject), conflicts, finish-conversation summary,
// free questions, drafts surviving background re-renders, OFFLINE capture and review, and sync after reconnect. Real Edge/Chrome engine through the DevTools Protocol; it is NOT a physical phone.
//   npm run sourcing:e2e:v1
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const TOKEN = 'v1-field-token-0123456789-abcdef-xyz-1';
const results = []; const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 600)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = async () => ({ ok: true, status: 200, text: async () => '<x/>' });
const dir = mkdtempSync(join(tmpdir(), 'nordla-v1-e2e-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
let server = null;
const startServer = async () => { server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: fake, ecb: async () => ({ date: '2026-10-05', perEur: { USD: 1.08 } }) }); };
const stopServer = async () => { await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); server = null; };
const HELPERS = `window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), click: (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('missing ' + sel); e.click(); },
  set: (sel, v) => { const e = document.querySelector(sel); if (!e) throw new Error('missing ' + sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); },
  submit: (sel) => { const f = document.querySelector(sel); if (!f) throw new Error('missing ' + sel); f.requestSubmit(); },
  kase: () => { const all = JSON.parse(localStorage.getItem('nordla.sourcing.cases')); return all[JSON.parse(localStorage.getItem('nordla.sourcing.current'))]; } }; 'ok'`;
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && !!document.querySelector('#tabs') && document.querySelector('#tabs').children.length > 0", 20000); await t.eval(HELPERS); };
const kase = async (t) => JSON.parse(await t.eval('JSON.stringify(__t.kase())'));
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const go = async (t, step) => { await t.run(`__t.click('[data-act="fstep"][data-key="${step}"]'); await __t.sleep(250); return 1;`); };
const candId = (c, key, ctx) => c.candidates.find((x) => x.key === key && (ctx === undefined || x.context === ctx)).id;
const act = (t, a, key, val) => { const sel = `[data-act="${a}"][data-key="${key}"]${val ? `[data-val='${val}']` : ''}`; return t.run(`__t.click(${JSON.stringify(sel)}); await __t.sleep(300); return 1;`); };

await startServer();
const errs = []; const browser = await new Browser(exe).launch(); browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
console.log(`Browser engine: ${exe}\n`);
const t = await browser.tab(`${base}/#t=${TOKEN}`); await ready(t); await t.waitFor('window.nordlaSourcing?.state().online === true', 15000);
await t.waitFor('navigator.serviceWorker.ready.then(() => caches.keys()).then((k) => k.length > 0)', 20000);
const EN = 'For 300 pcs we can do USD 6.80, FOB Shenzhen, 30% deposit and balance before shipment. MOQ is 100 pcs for the standard model. With your logo the MOQ is 300 pcs. We have CE and UN38.3. Model: PB-X200';

await check('1. the Field tab shows the seven steps, the next best step, and lists what is NOT AVAILABLE YET', async () => {
  await t.run(`__t.click('[data-act="tab"][data-key="field"]'); await __t.sleep(300); return 1;`);
  const n = await t.eval("document.querySelectorAll('.fsteps .fstep').length"); ok(n === 7, `${n} steps`);
  const labels = await t.eval("[...document.querySelectorAll('.fsteps .l')].map((x) => x.textContent).join(',')"); ok(labels === 'Discover,Talk,Capture,Complete,Analyze,Decide,Negotiate', labels);
  const body = await text(t); ok(/NEXT BEST STEP/.test(body), 'next best step'); ok(/NOT AVAILABLE YET \(5\)/.test(body), 'unavailable engines listed');
  await go(t, 'decide'); const d = await text(t); ok(/BUSINESS DECISION/.test(d) && /NOT AVAILABLE YET/.test(d), 'the business decision is honestly not available'); ok(!/\bBUY\b|\bPASS\b/.test(d), 'no invented BUY/PASS');
});

await check('2. CAPTURE: the original text is kept exactly, facts are only PROPOSED and the case is unchanged until the owner confirms', async () => {
  await go(t, 'capture'); await t.run(`__t.click('[data-act="conv-start"]'); await __t.sleep(300); return 1;`);
  await t.run(`__t.set('form[data-form="capture"] textarea', ${JSON.stringify(EN)}); __t.submit('form[data-form="capture"]'); await __t.sleep(500); return 1;`);
  const c = await kase(t); ok(c.schema === 2 && c.conversations.length === 1, 'conversation stored'); ok(c.conversations[0].items[0].original === EN, 'original is byte-for-byte');
  ok(c.candidates.length >= 8 && c.candidates.every((x) => x.state === 'PROPOSED'), `candidates ${c.candidates.length}`); ok(c.quotes.length === 0 && !c.identity.identifiers.model, 'the case itself is unchanged');
  const body = await text(t); ok(/TO REVIEW \(\d+\)/.test(body), 'review list'); ok(body.includes('THE ORIGINAL WORDS') && body.includes('For 300 pcs we can do USD 6.80'), 'the original words are shown');
  ok(/not proof/i.test(body), 'a document statement is labelled as not proof');
});

await check('3. the half-typed text and an open correction survive background re-renders (offline blip, online, Safety Gate status) and a change of step', async () => {
  await t.run(`__t.set('form[data-form="capture"] textarea', '300 pcs half typed, MOQ 5'); return 1;`);
  await t.run(`window.dispatchEvent(new Event('offline')); await __t.sleep(200); window.dispatchEvent(new Event('online')); await __t.sleep(1200); return 1;`);
  ok((await t.eval(`document.querySelector('form[data-form="capture"] textarea').value`)) === '300 pcs half typed, MOQ 5', 'textarea survived the blip');
  await go(t, 'talk'); await go(t, 'capture'); ok((await t.eval(`document.querySelector('form[data-form="capture"] textarea').value`)) === '300 pcs half typed, MOQ 5', 'textarea survived a change of step');
  await t.run(`__t.set('form[data-form="capture"] textarea', ''); return 1;`);
});

await check('4. CONFIRM turns candidates into the existing quote fields; a supplier document statement does NOT become a received document', async () => {
  let c = await kase(t);
  for (const [k, ctx] of [['quote.tiers'], ['quote.currency'], ['quote.incoterm'], ['quote.port'], ['quote.moq', 'product'], ['payment.depositPct'], ['docClaim.UN383'], ['identifier.model']]) { await act(t, 'cand-confirm', candId(c, k, ctx)); c = await kase(t); }
  const q = c.quotes.at(-1); ok(q.incoterm === 'FOB' && q.currency === 'USD' && q.port === 'Shenzhen' && q.moq === 100 && q.tiers.length === 1 && q.tiers[0].unitPrice === '6.80', JSON.stringify(q));
  ok(c.identity.identifiers.model === 'PB-X200', 'model'); ok(c.documents.length === 0, 'no document was received'); ok(c.documentLedger.some((d) => d.claim === 'UN383' && d.status === 'CLAIMED'), 'the claim is recorded as a claim');
  ok(c.ledger.every((e) => e.status === 'SUPPLIER_CLAIM' && e.userConfirmed === true), 'every confirmed supplier statement stays a claim');
  await t.run(`__t.click('[data-act="tab"][data-key="docs"]'); await __t.sleep(300); return 1;`); const docsText = await text(t); ok(/WHAT THE SUPPLIER SAYS ABOUT DOCUMENTS/.test(docsText) && /NOT RECEIVED/.test(docsText) && /No document yet/.test(docsText), 'Docs shows the claim as NOT RECEIVED and still no document');
  await t.run(`__t.click('[data-act="tab"][data-key="money"]'); await __t.sleep(300); return 1;`);
  const price = await t.eval(`document.querySelector('form[data-form="quote"] [name="unitPrice"]').value`); ok(price === '6.80', `the quote form shows the tier price for the quantity: ${price}`);
  await t.run(`__t.click('[data-act="tab"][data-key="field"]'); await __t.sleep(300); return 1;`);
});

await check('5. REJECT changes nothing; a custom-logo MOQ is kept apart from the product MOQ (no conflict)', async () => {
  let c = await kase(t); const before = JSON.stringify(c.quotes); await go(t, 'capture');
  await act(t, 'cand-confirm', candId(c, 'quote.moq', 'custom_logo')); c = await kase(t); ok(c.quotes.at(-1).moq === 100, 'product MOQ untouched'); ok(c.conflicts.length === 0, 'no conflict');
  const left = c.candidates.filter((x) => x.state === 'PROPOSED'); if (left.length) { await act(t, 'cand-reject', left[0].id); c = await kase(t); ok(c.candidates.find((x) => x.id === left[0].id).state === 'REJECTED', 'rejected'); }
  ok(JSON.stringify(c.quotes) === before, 'the quote is unchanged by confirm of a logo MOQ and by a rejection');
});

await check('6. an ambiguous number must be corrected (not guessed); a bad correction is refused and keeps what was typed; a good one applies', async () => {
  await t.run(`__t.set('form[data-form="capture"] textarea', 'price USD 6,8 per piece'); __t.submit('form[data-form="capture"]'); await __t.sleep(500); return 1;`);
  let c = await kase(t); const amb = c.candidates.find((x) => x.key === 'quote.unitPrice' && x.needsCorrection); ok(amb && amb.value === null, 'ambiguous candidate'); ok(!(await t.eval(`!!document.querySelector('[data-act="cand-confirm"][data-key="${amb.id}"]')`)), 'no Confirm button for it');
  await act(t, 'cand-correct-open', amb.id); await t.run(`__t.set('form[data-form="cand-correct"] input', '6,8'); window.dispatchEvent(new Event('offline')); await __t.sleep(200); window.dispatchEvent(new Event('online')); await __t.sleep(1200); return 1;`);
  ok((await t.eval(`document.querySelector('form[data-form="cand-correct"] input').value`)) === '6,8', 'an open correction survives a background re-render');
  await t.run(`__t.submit('form[data-form="cand-correct"]'); await __t.sleep(300); return 1;`);
  ok(/dot/i.test(await text(t)), 'the comma is refused with a clear message'); ok((await t.eval(`document.querySelector('form[data-form="cand-correct"] input').value`)) === '6,8', 'the typed value is still in the field');
  await t.run(`__t.set('form[data-form="cand-correct"] input', '6.80'); __t.submit('form[data-form="cand-correct"]'); await __t.sleep(400); return 1;`);
  c = await kase(t); const done = c.candidates.find((x) => x.id === amb.id); ok(done.state === 'CORRECTED' && done.original.value === null && done.correctedValue === '6.80', 'corrected, original kept'); ok(c.ledger.some((e) => e.key === 'quote.unitPrice' && e.value === '6.80' && e.status === 'USER_PROVIDED' && e.corrected === true && e.original.value === null), 'recorded as the owner own value, with the original proposal kept'); ok(c.quotes.at(-1).tiers.length === 1, 'the same price as the tier changes nothing');
});

await check('7. Chinese is kept as written; a model that contradicts the case becomes a visible clarification, never an overwrite', async () => {
  const ZH = '型号：PB-X180，起订量300个，单价6.8美金';
  await t.run(`__t.set('form[data-form="capture"] textarea', ${JSON.stringify(ZH)}); __t.submit('form[data-form="capture"]'); await __t.sleep(500); return 1;`);
  let c = await kase(t); ok(c.conversations[0].items.at(-1).original === ZH && c.conversations[0].items.at(-1).lang === 'zh', 'Chinese original preserved'); ok((await text(t)).includes('型号：PB-X180'), 'shown unchanged');
  const model = c.candidates.filter((x) => x.key === 'identifier.model' && x.state === 'PROPOSED').at(-1); ok(model.value === 'PB-X180', 'model preserved exactly');
  await act(t, 'cand-confirm', model.id); c = await kase(t); ok(c.identity.identifiers.model === 'PB-X200', 'the case model is NOT replaced'); ok(c.conflicts.some((x) => x.type === 'MODEL_MISMATCH' && x.state === 'OPEN'), 'conflict raised');
  const body = await text(t); ok(/NEEDS CLARIFICATION/.test(body) && body.includes('PB-X180') && body.includes('PB-X200'), 'both models shown to the owner');
  const cf = c.conflicts.find((x) => x.state === 'OPEN'); await act(t, 'conflict-resolve', cf.id, '"OLD"'); c = await kase(t); ok(c.identity.identifiers.model === 'PB-X200' && c.conflicts.find((x) => x.id === cf.id).state === 'RESOLVED', 'kept the earlier model');
});

await check('8. FINISH: summary says what was learned, what is missing and what contradicts; only confirmed facts reached the case', async () => {
  await act(t, 'conv-finish', 'conv-1'); const body = await text(t);
  ok(/SUPPLIER CONVERSATION - SUMMARY/.test(body) && /found/.test(body) && /confirmed/.test(body) && /still to review/.test(body), body.slice(0, 300)); ok(/What we learned/.test(body) && /Still missing/.test(body) && /Contradictions and risks/.test(body), 'three sections');
  const c = await kase(t); ok(c.conversations[0].status === 'FINISHED', 'finished'); ok(c.candidates.some((x) => x.state === 'PROPOSED'), 'unreviewed facts stay unreviewed');
});

await check('9. a free question keeps the owner\'s words and says plainly that no Chinese translation exists', async () => {
  await go(t, 'talk'); const Q = 'How many colours are available and can I mix colours in the 100-piece MOQ?';
  await t.run(`__t.set('form[data-form="free-question"] textarea', ${JSON.stringify(Q)}); __t.submit('form[data-form="free-question"]'); await __t.sleep(400); return 1;`);
  const c = await kase(t); ok(c.userQuestions.length === 1 && c.userQuestions[0].text === Q && c.userQuestions[0].translation === null, 'stored as written'); const body = await text(t); ok(/No Chinese translation is available/.test(body), 'honest about the missing translation');
});

await check('10. OFFLINE: server stopped, browser offline, cold reload: the conversation is still there; capture and review keep working', async () => {
  await t.run(`__t.click('[data-act="tab"][data-key="field"]'); await __t.sleep(200); return 1;`); await go(t, 'capture');
  await stopServer(); await t.offline(true); await t.goto(`${base}/`); await ready(t);
  let c = await kase(t); ok(c.conversations[0].items.length >= 3, 'conversation survived the reload'); await t.run(`__t.click('[data-act="tab"][data-key="field"]'); await __t.sleep(200); __t.click('[data-act="fstep"][data-key="capture"]'); await __t.sleep(250); return 1;`); const shown = await text(t); ok(shown.includes('THE ORIGINAL WORDS') && shown.includes('For 300 pcs we can do USD 6.80') && shown.includes('型号：PB-X180'), 'the original words are shown again after a cold offline reload');
  await t.run(`__t.click('[data-act="tab"][data-key="field"]'); await __t.sleep(200); __t.click('[data-act="fstep"][data-key="capture"]'); await __t.sleep(200); __t.click('[data-act="conv-start"]'); await __t.sleep(300); return 1;`);
  await t.run(`__t.set('form[data-form="capture"] textarea', 'Lead time 15-20 days, colours: black, white and blue'); __t.submit('form[data-form="capture"]'); await __t.sleep(500); return 1;`);
  c = await kase(t); const lt = c.candidates.find((x) => x.key === 'quote.leadTime' && x.state === 'PROPOSED'); ok(lt, 'extraction works with no network'); await act(t, 'cand-confirm', lt.id); c = await kase(t); ok(c.quotes.at(-1).leadTimeDays === '20', 'confirmed offline');
  ok(await t.eval("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]').length >= 1"), 'the change is marked as waiting to sync');
});

await check('11. NETWORK RETURNS: the conversation, candidates and ledger reach the server unchanged', async () => {
  await startServer(); await t.offline(false); await t.run(`window.dispatchEvent(new Event('online')); await __t.sleep(200); return 1;`);
  const c = await kase(t); await t.waitFor("JSON.parse(localStorage.getItem('nordla.sourcing.dirty') || '[]').length === 0", 20000);
  const r = await fetch(`${base}/api/cases/${c.id}`, { headers: { 'x-sourcing-token': TOKEN } }); const sv = await r.json();
  ok(r.status === 200 && sv.conversations.length === 2, `server conversations ${sv.conversations?.length}`); ok(sv.conversations[0].items[0].original === EN, 'original text identical on the server'); ok(sv.ledger.length >= 8 && sv.candidates.length >= 10, 'ledger and candidates synced');
  ok(sv.conversations[0].items.at(-1).original.includes('型号：PB-X180'), 'Chinese original identical on the server'); ok(!JSON.stringify(sv).includes(TOKEN), 'no token in the stored case');
});

await check('12. every specialist screen still renders (Case, Ask, Docs, Rules, Market, Money, Verdict, Quick) with no uncaught error', async () => {
  for (const k of ['quick', 'decision', 'case', 'ask', 'docs', 'compliance', 'market', 'money', 'field']) { await t.run(`__t.click('[data-act="tab"][data-key="${k}"]'); await __t.sleep(250); return 1;`); const body = await text(t); ok(body.length > 80 && !/could not be computed/.test(body), `${k} rendered: ${body.slice(0, 80)}`); }
  ok(errs.length === 0, `uncaught errors: ${errs.join(' | ')}`);
});

await check('13. layout: the Field shell fits 375 / 390 / 430 wide (portrait and landscape): no sideways scrolling, tap targets large enough', async () => {
  const bad = [];
  for (const [w, h] of [[375, 812], [390, 844], [430, 932], [844, 390]]) {
    await t.resize(w, h); await sleep(300);
    for (const step of ['discover', 'talk', 'capture', 'complete', 'analyze', 'decide', 'negotiate']) {
      const r = await t.run(`__t.click('[data-act="tab"][data-key="field"]'); await __t.sleep(120); __t.click('[data-act="fstep"][data-key="${step}"]'); await __t.sleep(200);
        const over = [...document.querySelectorAll('#screen *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('table, pre, .fsteps')).length;
        const small = [...document.querySelectorAll('#screen button.btn, #tabs button, .fstep')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 36 || r.width < 36); }).length;
        return { sideways: document.documentElement.scrollWidth > window.innerWidth + 1, over, small };`);
      if (r.sideways || r.over || r.small) bad.push(`${w}x${h} ${step}: ${JSON.stringify(r)}`);
    }
  }
  await t.resize(390, 844); ok(bad.length === 0, bad.slice(0, 5).join(' | '));
});

await t.close(); await browser.close(); if (server) await stopServer(); rmSync(dir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
