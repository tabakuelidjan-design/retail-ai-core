// NORDLA: a French supplier note shows its proposals on the phone (real browser engine through the DevTools Protocol; not a physical phone): minimum order, lead time, offered quantity, price and currency
// are listed as "à confirmer", labelled in French, readable at 360, 375, 390 and 430 px without horizontal overflow, nothing is confirmed, and the original note stays visible.
// Set SOURCING_E2E_SHOTS=<dir> for the screenshots.   node test/e2e/sourcing-french-note.e2e.js
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'french-note-token-0123456789-abcdef'; const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 900)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const dir = mkdtempSync(join(tmpdir(), 'nordla-frnote-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => { throw new Error('no network in this test'); }, ecb: async () => ({ date: '2026-10-19', rates: {} }) });
const errs = []; const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch();
browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const click = async (t, sel, ms = 450) => { await t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing element'); e.click(); })()`); await sleep(ms); };
const clickText = async (t, scope, label, ms = 450) => { await t.eval(`(() => { const r = [...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => e.innerText.trim().replace(/\\s+/g, ' ').includes(${JSON.stringify(label)})); if (!r) throw new Error('missing label'); r.click(); })()`); await sleep(ms); };
const ready = (t) => t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000);
const store = async (t) => JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases') ?? '{}'"));
const noOverflow = async (t, label) => { const r = await t.eval('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })'); ok(r.sw <= r.cw, `${label}: horizontal overflow ${r.sw} > ${r.cw}`); };
let shotN = 0; const shot = async (t, name) => { if (!SHOTS) return; await sleep(250); const r = await browser.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`), Buffer.from(r.data, 'base64')); };
const NOTE = 'Nous proposons 100 gourdes en acier inoxydable à 5 € pièce. Quantité minimale : 100 unités. Livraison en Belgique non précisée. Délai de fabrication : 15 jours.';

try {
  const t = await browser.tab(`${base}/#t=${TOKEN}`, { width: 390, height: 844 }); await ready(t); await sleep(900);
  await t.eval(`(async () => { const m = await import('/core/case.js'); const T0 = new Date('2026-10-20T08:00:00Z'); const at = (k) => new Date(T0.getTime() + k * 60000);
    let c = m.newCase({ id: 'gourdes-fr', name: 'gourdes inox', now: T0 }); c = m.dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Fournisseur Gourdes' } }, at(0)); c = m.dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Fournisseur Gourdes', lang: 'auto' }, at(1));
    c = m.dispatch(c, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'auto', text: ${JSON.stringify(NOTE)} }, at(2));
    const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') ?? '{}'); cases[c.id] = c; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); })()`); await sleep(500);
  await t.eval('location.reload()'); await ready(t); await sleep(1200);
  const openNote = async () => { await click(t, '#tabs [data-key="suppliers"]', 600); await clickText(t, '.nx-cardmain', 'Fournisseur Gourdes', 700); await click(t, '#tabs [data-key="note"]', 700); await click(t, '[data-act="sl-note-mode"][data-key="text"]', 500); await clickText(t, 'button, a, [data-act]', 'Voir dans la fiche', 900); };

  await check('1. the five proposals are listed in French, "à confirmer", with the supplier words; the original note is still there', async () => {
    await openNote(); const s = await text(t); await shot(t, 'note-francaise-390');
    for (const re of [/Quantité proposée/, /100 pièces/, /Minimum de commande/, /Prix unitaire/, /Devise/, /Délai/, /15 jours/, /Proposée · à confirmer/]) ok(re.test(s), `${re} missing in: ${s.slice(0, 900)}`);
    ok(/« 100 gourdes »/.test(s) && /dit par le fournisseur/.test(s), 'each proposal shows the supplier words it comes from');
    ok(!/quote\.(moq|offeredQty|leadTime)/.test(s), 'no raw technical key leaks into the screen');
  });

  await check('2. nothing is confirmed by displaying it: no ledger entry, no quote, the original note is byte for byte the same', async () => {
    const c = Object.values(await store(t)).find((x) => x.id === 'gourdes-fr'); ok(c.ledger.length === 0 && c.quotes.length === 0, 'no ledger, no quote');
    ok(c.candidates.length >= 5 && c.candidates.every((k) => k.state === 'PROPOSED'), 'every candidate is still PROPOSED');
    ok(c.conversations[0].items[0].original === NOTE, 'the original note is untouched');
  });

  await check('2b. WIDTHS 360 / 375 / 390 / 430 px: the French labels are readable and nothing overflows horizontally', async () => {
    for (const w of [360, 375, 390, 430]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 2, mobile: true }, t.sessionId); await sleep(600);
      const s = await text(t); ok(/Quantité proposée/.test(s) && /Minimum de commande/.test(s), `${w}px: labels present`); await noOverflow(t, `${w}px`); await shot(t, `note-francaise-${w}`);
      const cut = await t.eval(`[...document.querySelectorAll('#screen *')].filter((e) => e.children.length === 0 && /Quantité proposée|Minimum de commande/.test(e.textContent)).map((e) => { const r = e.getBoundingClientRect(); return { right: Math.round(r.right), left: Math.round(r.left) }; })`);
      ok(cut.length > 0 && cut.every((r) => r.left >= 0 && r.right <= w), `${w}px: a label is cut off: ${JSON.stringify(cut)}`);
    }
  });

  await check('3. CORRIGER the offered quantity: a bad entry is refused in French and nothing changes; "120" is recorded as a correction (original kept) and never becomes the MOQ', async () => {
    const submit = (v) => t.eval(`(() => { const f = [...document.querySelectorAll('form[data-form="sl-correct"]')].pop(); if (!f) throw new Error('no correction form'); const i = f.querySelector('input[name="value"]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); f.requestSubmit(); })()`);
    await t.eval(`(() => { const b = [...document.querySelectorAll('[data-act="sl-correct-open"]')].find((e) => /Quantité proposée/.test((e.closest('li') ?? e.parentElement).innerText)); if (!b) throw new Error('no Corriger on the offered quantity card'); b.click(); })()`); await sleep(700);
    await shot(t, 'corriger-quantite-proposee'); await submit('1 000'); await sleep(700); const s1 = await t.eval('document.body.innerText'); ok(/Tapez uniquement des chiffres entiers/.test(s1), 'French refusal shown: ' + s1.slice(0, 300));
    let c = Object.values(await store(t)).find((x) => x.id === 'gourdes-fr'); ok(c.candidates.find((k) => k.key === 'quote.offeredQty').state === 'PROPOSED' && c.ledger.length === 0, 'nothing changed after a refusal');
    await submit('120'); await sleep(900); c = Object.values(await store(t)).find((x) => x.id === 'gourdes-fr'); const k = c.candidates.find((x) => x.key === 'quote.offeredQty');
    ok(k.state === 'CORRECTED' && k.original.value === '100' && k.correctedValue === '120', JSON.stringify([k.state, k.original, k.correctedValue]));
    const led = c.ledger.filter((e) => e.key === 'quote.offeredQty'); ok(led.length === 1 && led[0].value === '120' && led[0].original.value === '100', 'ledger keeps the original'); ok(c.quotes.every((q) => q.moq === undefined) && c.candidates.find((x) => x.key === 'quote.moq').state === 'PROPOSED', 'the MOQ is untouched and still proposed');
    ok(c.conversations[0].items[0].original === NOTE, 'the original note is untouched'); await shot(t, 'quantite-proposee-corrigee');
  });

  await check('4. no uncaught error in the whole session', async () => { ok(errs.length === 0, errs.slice(0, 3).join(' | ')); });
} finally {
  await browser.close(); await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}
const failed = results.filter((x) => !x).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
