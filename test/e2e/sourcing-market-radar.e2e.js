// Market radar on a phone-sized REAL browser engine (Chrome / Edge through the DevTools Protocol; NOT a physical phone), with a SIMULATED search provider behind the real server route: the product sheet,
// "Rechercher les prix en Europe", the listings (seller, price, source, date, honest link), Amazon.be / bol.com checked separately, flags kept visible, evidence stored in the case, error and offline behaviour.
//   node test/e2e/sourcing-market-radar.e2e.js        (SOURCING_E2E_SHOTS=<dir> for screenshots)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { createMarketRadar } from '../../src/sourcing/server/market-radar-service.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'market-radar-token-0123456789-abcdef'; const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 900)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const SECRET = 'e2e-Secret-Pa55';
const fakeFetch = async (url) => {
  if (url.endsWith('/appendix/user_data')) return json({ tasks: [{ result: [{ money: { balance: 1 } }] }] });
  if (url.endsWith('/locations')) return json({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] });
  if (url.endsWith('/products/task_post')) return json({ tasks: [{ id: 'e2e1', status_code: 20100, cost: 0.002 }] });
  if (url.includes('/task_get/advanced/')) return json({ tasks: [{ status_code: 20000, result: [{ datetime: '2026-10-19 15:02:34 +00:00', items: [
    { type: 'google_shopping_serp', title: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L', price: 55, currency: 'EUR', seller: 'Stanley 1913 EU', url: 'https://google.be/search?ibp=oshop&q=a&prds=1' },
    { type: 'google_shopping_serp', title: 'Stanley 1913 Quencher H2.0 FlowState Tumbler 1,18 L', price: 54.63, currency: 'EUR', seller: 'Amazon.com.be', url: 'https://google.be/search?ibp=oshop&q=a&prds=2' },
    { type: 'google_shopping_serp', title: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L Blue', price: 60, currency: 'EUR', seller: 'bol', url: 'https://google.be/search?ibp=oshop&q=a&prds=3' },
    { type: 'google_shopping_serp', title: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L Cream', price: 52, currency: 'EUR', seller: 'Giftable', url: 'https://google.be/search?ibp=oshop&q=a&prds=4' },
    { type: 'google_shopping_serp', title: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L Rose', price: 58, currency: 'EUR', seller: 'Miracle Cups', url: 'https://google.be/search?ibp=oshop&q=a&prds=5' },
    { type: 'google_shopping_serp', title: 'Stanley Quencher H2.0 Tumbler 1.18L 50 pcs promotional', price: 3810.29, currency: 'EUR', seller: 'dereklameshop', url: 'https://google.be/search?ibp=oshop&q=a&prds=6' },
    { type: 'google_shopping_serp', title: 'Stanley Quencher straws replacement', price: 15, currency: 'EUR', seller: 'Stanley 1913 EU', url: 'https://google.be/search?ibp=oshop&q=a&prds=7' }] }] }] });
  throw new Error(`unexpected ${url}`);
};
const dirA = mkdtempSync(join(tmpdir(), 'nordla-radar-e2e-')); const dirB = mkdtempSync(join(tmpdir(), 'nordla-radar-e2e-b-'));
const mkRadar = () => createMarketRadar({ env: { DATAFORSEO_LOGIN: 'owner@example.com', DATAFORSEO_PASSWORD: SECRET, MARKET_MIN_INTERVAL_SEC: '0.001' }, fetchImpl: fakeFetch, ecb: async () => ({ date: '2026-10-19', perEur: { USD: 1.1 } }), sleep: async () => {}, pollMs: 1 });
const port = await freePort(); const base = `http://127.0.0.1:${port}`;
let server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir: dirA, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({ date: '2026-10-19', perEur: { USD: 1.1 } }), services: { market: mkRadar() } });
const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch();
const errs = []; browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const ready = (t) => t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000);
const store = async (t) => JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases') ?? '{}'"));
let shotN = 0; const shot = async (t, name) => { if (!SHOTS) return; await sleep(250); const r = await browser.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`), Buffer.from(r.data, 'base64')); };
// reach the REAL market screen (fiche > "Prix en Europe") through the real click handler (data-act="sl-embed" data-key="market")
const openMarket = async (t, caseId = 'radar-1') => { await t.eval(`(() => { const CASEID = ${JSON.stringify(caseId)}; const b = document.createElement('button'); b.setAttribute('data-act', 'sl-embed'); b.setAttribute('data-key', 'market'); b.setAttribute('data-case', CASEID); b.id = '__open_market'; document.body.appendChild(b); b.click(); b.remove(); })()`); await sleep(500); };
const clickRun = async (t, ms = 900) => { await t.eval(`document.querySelector('[data-act="market-run"]').click()`); await sleep(ms); };
const noOverflow = async (t, label) => { const r = await t.eval('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })'); ok(r.sw <= r.cw, `${label}: horizontal overflow ${r.sw} > ${r.cw}`); };

try {
  const t = await browser.tab(`${base}/#t=${TOKEN}`, { width: 390, height: 844 }); await ready(t); await sleep(900);
  await t.eval(`(async () => { const m = await import('/core/case.js'); const T0 = new Date('2026-10-20T08:00:00Z'); const at = (k) => new Date(T0.getTime() + k * 60000);
    let c = m.newCase({ id: 'radar-1', name: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L', now: T0 }); c = m.dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Fournisseur Test' } }, at(0)); c = m.dispatch(c, { type: 'IDENTIFIER', name: 'brand', value: 'Stanley', source: { kind: 'OWNER' } }, at(1)); c = m.dispatch(c, { type: 'QUOTE', quote: { unitPrice: '11', currency: 'USD' } }, at(2));
    const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') ?? '{}'); cases[c.id] = c; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.current', JSON.stringify(c.id)); })()`); await sleep(400);
  await t.eval('location.reload()'); await ready(t); await sleep(1200);

  await check('1. the market sheet offers "Rechercher les prix en Europe", states text-only (no photo), and shows no result before a search', async () => {
    await openMarket(t); const s = await text(t); await shot(t, 'sheet-before-390');
    ok(/Rechercher les prix en Europe/.test(s), `button missing: ${s.slice(0, 500)}`); ok(/aucune photo n’est envoyée/i.test(s), 'photo statement'); ok(!/Résultat de la recherche/.test(s), 'no result yet'); ok(/Texte seulement/.test(s), 'text-only statement');
  });

  await check('2. the search runs by itself from the case: listings with price, seller, source, date; Amazon.be and bol.com checked separately and found', async () => {
    await clickRun(t, 1400); const s = await text(t); await shot(t, 'result-390');
    ok(/Résultat de la recherche/.test(s), `no result block: ${s.slice(0, 600)}`); ok(/55,00 €/.test(s) && /54,63 €/.test(s), 'prices'); ok(/Amazon\\.com\\.be|Amazon\.com\.be/.test(s) || /Amazon\.be/.test(s), 'Amazon seller shown');
    ok(/Amazon\.be\s*:\s*trouvé/.test(s) && /bol\.com\s*:\s*trouvé/.test(s), `marketplace lines: ${s.slice(s.indexOf('Amazon.be et bol'), s.indexOf('Amazon.be et bol') + 400)}`);
    ok(/relevé le/.test(s) && /Google Shopping \(via DataForSEO\)/.test(s), 'date and source on the cards'); ok(/Belgique/.test(s), 'market');
  });

  await check('3. links are honest: Google Shopping pages are labelled as such, https only, opened safely; nothing claims a direct Amazon / bol link', async () => {
    const links = JSON.parse(await t.eval(`JSON.stringify([...document.querySelectorAll('.fm-rl-l a')].map((a) => ({ h: a.href, t: a.textContent, rel: a.rel, tg: a.target })))`));
    ok(links.length >= 5, `links: ${links.length}`); ok(links.every((l) => /^https:\/\/google\.be\//.test(l.h) && /Google Shopping/.test(l.t) && /noopener/.test(l.rel) && l.tg === '_blank'), JSON.stringify(links.slice(0, 2)));
    ok(!(await text(t)).match(/page directe (d’Amazon|d'Amazon) disponible/i), 'no direct-link claim'); ok(/pas une page directe d’Amazon ou de bol\.com/.test(await text(t)), 'the honest sentence is there');
  });

  await check('4. the lot (3 810 €), the accessory and any aberrant price are FLAGGED and kept out of the range, still listed with their reason; classes are never EXACT without the model', async () => {
    const s = await t.eval(`(() => { document.querySelectorAll('.fm-rg').forEach((d) => d.open = true); return document.querySelector('#screen').innerText; })()`);
    ok(/Lots et packs/.test(s) && /3810,29/.test(s) && /lot ou pack/.test(s), 'lot listed + flagged, in its own group'); ok(/76,21/.test(s) && /la pièce/.test(s) && /estimation/.test(s), 'per-piece price is an ESTIMATE, outside the range'); ok(/Accessoires — exclus des prix/.test(s) && /accessoire/.test(s), 'accessory flagged, in its own group'); ok(/disponibilité non vérifiée/.test(s), 'availability is never claimed');
    const range = await t.eval(`document.querySelector('.fm-rbig')?.innerText ?? ''`); ok(!/3810/.test(range), `the lot must not be in the range: ${range}`); ok(!/Correspondances exactes/.test(s), 'no EXACT section: the case has no model');
    await shot(t, 'flags-390');
  });

  await check('5. the case keeps the evidence with provenance and date; nothing is confirmed or written to the ledger', async () => {
    const c = (await store(t))['radar-1']; const ms = c.marketSearches ?? []; ok(ms.length === 1 && ms[0].status === 'DONE' && ms[0].radar, 'one DONE search with radar block');
    ok(ms[0].evidence.length === 7 && ms[0].evidence.every((e) => e.url && e.observedAt && e.source === 'google-shopping' && e.country === 'BE'), 'seven listings with url, date, source, country');
    ok(ms[0].evidence.some((e) => e.specs.excluded) && ms[0].evidence.some((e) => e.specs.marketplace === 'amazon.be') && ms[0].evidence.some((e) => e.specs.marketplace === 'bol.com'), 'flags and marketplaces stored');
    ok(c.ledger.length === 0, 'no ledger entry'); ok(!JSON.stringify(c).includes(SECRET), 'no credential in the case');
  });

  await check('6. comparison with the supplier price: dated ECB conversion and the missing costs named', async () => {
    const s = await text(t); ok(/Comparaison avec le prix fournisseur/.test(s) && /10,00 €/.test(s) && /taux BCE du 2026-10-19/.test(s), s.slice(s.indexOf('Comparaison'), s.indexOf('Comparaison') + 300));
    ok(/TVA/.test(s) && /importation/.test(s) && /Transport/.test(s), 'limits named');
  });

  await check('7. the same search again is not paid again (cache) and says so', async () => {
    await clickRun(t, 1200); const s = await text(t); ok(/aucune nouvelle recherche/i.test(s), s.slice(0, 400)); const c = (await store(t))['radar-1']; ok(c.marketSearches.length === 2 && c.marketSearches[1].radar.cached === true, 'second entry marked cached');
  });

  await check('8. 390 px: nothing overflows horizontally', async () => { await noOverflow(t, 'market sheet'); });

  await check('9. server unreachable: explicit message, the case is not modified, the earlier results stay readable', async () => {
    const before = JSON.stringify((await store(t))['radar-1']); await new Promise((r) => server.server.close(r)); server.server.closeAllConnections?.(); await sleep(300);
    await clickRun(t, 1200); const s = await text(t); ok(/Pas de connexion au serveur/.test(s) && /rien n’a été perdu/.test(s), s.slice(0, 500)); ok(JSON.stringify((await store(t))['radar-1']) === before, 'case untouched'); ok(/Résultat de la recherche/.test(s), 'earlier evidence still readable offline');
    await shot(t, 'offline-390');
  });

  await check('10. search not configured on the server: explicit message, nothing sent, nothing stored', async () => {
    const portB = await freePort(); const baseB = `http://127.0.0.1:${portB}`; const b = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port: portB, dir: dirB, fetchImpl: async () => { throw new Error('no network'); }, services: { market: createMarketRadar({ env: {} }) } });
    try {
      const t2 = await browser.tab(`${baseB}/#t=${TOKEN}`, { width: 390, height: 844 }); await ready(t2); await sleep(800);
      await t2.eval(`(async () => { const m = await import('/core/case.js'); const T0 = new Date('2026-10-20T08:00:00Z'); let c = m.newCase({ id: 'radar-2', name: 'Bottle', now: T0 }); const cases = {}; cases[c.id] = c; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.current', JSON.stringify(c.id)); })()`); await t2.eval('location.reload()'); await ready(t2); await sleep(1000);
      await openMarket(t2, 'radar-2'); await clickRun(t2, 900); const s = await text(t2); ok(/La recherche de prix n’est pas configurée|La recherche de prix n'est pas configurée/.test(s) && /rien n’a été cherché ni envoyé|rien n'a été cherché ni envoyé/.test(s), s.slice(0, 500));
      ok(((await store(t2))['radar-2'].marketSearches ?? []).length === 0, 'nothing stored');
    } finally { await new Promise((r) => b.server.close(r)); b.server.closeAllConnections?.(); }
  });

  await check('11. no uncaught error in the whole session', async () => { ok(errs.length === 0, errs.join(' | ').slice(0, 500)); });
} finally {
  try { await browser.close?.(); } catch { /* gone */ } try { await new Promise((r) => server.server.close(r)); } catch { /* closed */ }
  rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true });
  const passed = results.filter(Boolean).length; console.log(`\n${passed}/${results.length} passed`); process.exit(passed === results.length ? 0 : 1);
}
