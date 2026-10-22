// Market radar CONFIRMATION (model / size) on a phone-sized REAL browser engine (390 px; Chrome or Edge through the DevTools Protocol; NOT a physical phone), with a SIMULATED search provider behind the real server routes.
// Proves: after the search, at most ONE one-tap question built from evidence (none preselected, "Je ne sais pas" always there); the answer re-reads the listings already obtained WITHOUT any provider call
// (the simulated provider counts every call); non-comparable listings leave the median but stay listed with their reason; fewer than 3 comparable listings = "Prix de référence non fiable", no median.
//   SOURCING_E2E_BROWSER="C:/Program Files/Google/Chrome/Application/chrome.exe" node test/e2e/sourcing-market-refine.e2e.js        (SOURCING_E2E_SHOTS=<dir> for screenshots)
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { createMarketRadar } from '../../src/sourcing/server/market-radar-service.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'market-refine-token-0123456789-abcdef'; const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 900)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const it = (title, price, id) => ({ type: 'google_shopping_serp', title, price, currency: 'EUR', seller: `Shop ${id}`, url: `https://google.be/search?ibp=oshop&q=a&prds=${id}` });
const SCENARIOS = {
  sizes: [it('Stanley Quencher H2.0 tumbler 1.18L Rose', 55, 1), it('Stanley Quencher H2.0 tumbler 1,18 L Blue', 54, 2), it('Stanley Quencher H2.0 tumbler 1.18L Cream', 56, 3), it('Stanley Quencher H2.0 tumbler 1.18L Black', 58, 4), it('Stanley Quencher H2.0 tumbler 1.18L Green', 57, 5),
    it('Stanley Quencher H2.0 tumbler 887ml Rose', 40, 6), it('Stanley Quencher H2.0 tumbler 0.887 L Blue', 41, 7), it('Stanley Quencher H2.0 tumbler', 52, 8), it('Yeti Rambler tumbler 1.18L', 70, 9), it('Stanley Quencher H2.0 tumbler 1.18L 2 pack', 110, 10)],
  real: JSON.parse(readFileSync(new URL('../fixtures/market-hydroflask-53.json', import.meta.url), 'utf8')).map((x, i) => it(x.title, x.price, 300 + i)),
  acme: [['Wide Mouth', 'insulated bottle', '710 ml', ['Black', 'Blue', 'Green', 'White'], [62, 64, 60, 63]], ['Standard Mouth', 'insulated bottle', '710 ml', ['Black', 'Blue', 'Green', 'White'], [46, 48, 45, 47]], ['Wide Mouth', 'insulated bottle', '946 ml', ['v0', 'v1', 'v2'], [74, 75, 76]]]
    .flatMap(([v, k, size, cs, ps], g) => cs.map((c, i) => it(`ACME ${v} ${k} ${size} ${c}`, ps[i], 100 + g * 10 + i)))
    .concat([it('ACME Wide Mouth replacement cap lid', 14, 150), it('6 pcs ACME Wide Mouth insulated bottle 710 ml', 330, 151), it('ZETA Wide Mouth insulated bottle 710 ml', 40, 152)]),
  few: [it('Acme steel bottle 500ml Blue', 20, 21), it('Acme steel bottle 500ml Red', 22, 22), it('Acme steel bottle replacement cap', 5, 23), it('Generic bottle 750ml', 9, 24)],
};
let scenario = 'sizes'; const counts = { post: 0, balance: 0 };
const fakeFetch = async (url) => {
  if (url.endsWith('/appendix/user_data')) { counts.balance += 1; return json({ tasks: [{ result: [{ money: { balance: 1 } }] }] }); }
  if (url.endsWith('/locations')) return json({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] });
  if (url.endsWith('/products/task_post')) { counts.post += 1; return json({ tasks: [{ id: `e${counts.post}`, status_code: 20100, cost: 0.002 }] }); }
  if (url.includes('/task_get/advanced/')) return json({ tasks: [{ status_code: 20000, result: [{ datetime: '2026-10-19 15:02:34 +00:00', items: SCENARIOS[scenario] }] }] });
  throw new Error(`unexpected ${url}`);
};
const dirA = mkdtempSync(join(tmpdir(), 'nordla-refine-e2e-'));
const radar = createMarketRadar({ env: { DATAFORSEO_LOGIN: 'owner@example.com', DATAFORSEO_PASSWORD: 'e2e-Secret-Pa55', MARKET_MIN_INTERVAL_SEC: '0.001' }, fetchImpl: fakeFetch, ecb: async () => ({ date: '2026-10-19', perEur: { USD: 1.1 } }), sleep: async () => {}, pollMs: 1 });
const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir: dirA, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({ date: '2026-10-19', perEur: { USD: 1.1 } }), services: { market: radar } });
const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch();
const errs = []; browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const ready = (t) => t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000);
const store = async (t) => JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases') ?? '{}'"));
let shotN = 0; const shot = async (t, name, sel = null) => { if (!SHOTS) return; if (sel) await t.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) { e.scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); } })()`); await sleep(350); const r = await browser.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`), Buffer.from(r.data, 'base64')); };
const openMarket = async (t, caseId) => { await t.eval(`(() => { const b = document.createElement('button'); b.setAttribute('data-act', 'sl-embed'); b.setAttribute('data-key', 'market'); b.setAttribute('data-case', ${JSON.stringify(caseId)}); document.body.appendChild(b); b.click(); b.remove(); })()`); await sleep(500); };
const click = async (t, sel, ms = 700) => { await t.eval(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(ms); };
const noOverflow = async (t, label) => { const r = await t.eval('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })'); ok(r.sw <= r.cw, `${label}: horizontal overflow ${r.sw} > ${r.cw}`); };
const seed = (id, name, brand) => `(async () => { const m = await import('/core/case.js'); const T0 = new Date('2026-10-20T08:00:00Z'); const at = (k) => new Date(T0.getTime() + k * 60000);
  let c = m.newCase({ id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, now: T0 }); c = m.dispatch(c, { type: 'SUPPLIER', supplier: { name: 'Fournisseur Test' } }, at(0)); c = m.dispatch(c, { type: 'IDENTIFIER', name: 'brand', value: ${JSON.stringify(brand)}, source: { kind: 'OWNER' } }, at(1)); c = m.dispatch(c, { type: 'QUOTE', quote: { unitPrice: '11', currency: 'USD' } }, at(2));
  const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') ?? '{}'); cases[c.id] = c; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.current', JSON.stringify(c.id)); })()`;
const reload = async (t) => { await t.eval('location.reload()'); await ready(t); await sleep(1200); };

try {
  const t = await browser.tab(`${base}/#t=${TOKEN}`, { width: 390, height: 844 }); await ready(t); await sleep(900);
  await t.eval(seed('r-size', 'Stanley Quencher H2.0 tumbler', 'Stanley')); await sleep(300); await reload(t);

  await check('1. the search shows ONE question about the size (the case does not say it): options with their evidence, "Je ne sais pas", nothing preselected; exactly one paid search was made', async () => {
    await openMarket(t, 'r-size'); await click(t, '[data-act="market-run"]', 1500); const s = await text(t); await shot(t, 'question-390', '.fm-q');
    ok(/Une précision \(une touche\)/.test(s) && /Quelle est la taille de votre produit/.test(s), `question missing: ${s.slice(0, 700)}`);
    const opts = await t.eval(`[...document.querySelectorAll('[data-act="market-answer"]')].map((b) => ({ k: b.getAttribute('data-key'), t: b.innerText.replace(/\\s+/g, ' '), sel: b.classList.contains('active') || b.getAttribute('aria-pressed') === 'true' || b.hasAttribute('data-selected') }))`);
    ok(opts.length === 3, JSON.stringify(opts)); ok(opts.every((o) => !o.sel), 'an option is preselected'); ok(/1,18 L/.test(opts[0].t) && /vu dans 6 annonce/.test(opts[0].t) && /prix médian/.test(opts[0].t), opts[0].t); ok(/887 ml/.test(opts[1].t) && /vu dans 2 annonce/.test(opts[1].t), opts[1].t); ok(/Je ne sais pas/.test(opts[2].t) && opts[2].k === 'unknown', opts[2].t);
    ok(counts.post === 1, `paid searches: ${counts.post}`); ok(/aucune recherche payante/.test(s), 'the free-answer statement');
    ok(/Prix de référence en attente de votre précision/.test(s) && !/Prix constatés/.test(s) && !/médiane observée/.test(s), 'no median (and no supplier ratio) while the question is pending: the sizes are mixed'); await noOverflow(t, 'question');
  });

  await check('2. the option buttons are real touch targets (>= 44 px) and fit the 390 px screen', async () => {
    const r = await t.eval(`[...document.querySelectorAll('[data-act="market-answer"]')].map((b) => { const x = b.getBoundingClientRect(); return { h: Math.round(x.height), w: Math.round(x.width), right: Math.round(x.right) }; })`);
    ok(r.every((x) => x.h >= 44 && x.right <= 390), JSON.stringify(r));
  });

  await check('3. one tap on "1,18 L": no provider call at all; the median now uses only comparable listings; the others stay listed with their reason', async () => {
    const before = { ...counts }; await click(t, '[data-act="market-answer"][data-key="0"]', 1200); const s = await text(t); await shot(t, 'after-answer-390', '.fm-q, .fm-rbig');
    ok(counts.post === before.post && counts.balance === before.balance, `provider called: ${JSON.stringify(counts)} vs ${JSON.stringify(before)}`);
    ok(!/Une précision \(une touche\)/.test(s), 'the question must be gone'); ok(/Précision confirmée par vous : taille 1,18 L/.test(s), s.slice(0, 600));
    ok(/Prix constatés/.test(s) && !/Prix de référence non fiable/.test(s), 'a reliable range is expected');
    const big = await text(t, '.fm-rbig'); ok(/54,00 € – 56,00 € – 58,00 €/.test(big), big); ok(/sur 5 annonce/.test(s), 'five comparable listings');
    await t.eval(`document.querySelectorAll('details.fm-rg').forEach((d) => { d.open = true; })`); await sleep(200); const all = await text(t);
    ok(/capacité différente/.test(all) && /capacité non indiquée/.test(all) && /lot ou pack/.test(all), 'exclusion reasons listed'); ok(/Yeti Rambler/.test(all), 'the other brand stays consultable');
    const rec = (await store(t))['r-size'].marketSearches; ok(rec.length === 2 && rec[1].radar.confirmation.answered === 'capacity' && rec[1].radar.confirmation.value.capacityMl === 1180 && rec[1].radar.refinedFromId === rec[0].id, 'answer recorded with its source search');
    await noOverflow(t, 'after answer');
  });

  await check('4. the refined result survives a reload and is not counted twice in the case summary', async () => {
    await reload(t); await openMarket(t, 'r-size'); const s = await text(t); ok(/Précision confirmée par vous : taille 1,18 L/.test(s) && /54,00 €/.test(s), s.slice(0, 400));
    const n = await t.eval(`(async () => { const m = await import('/core/market-search.js'); const c = JSON.parse(localStorage.getItem('nordla.sourcing.cases'))['r-size']; const sm = m.summarizeMarketEvidence(c.marketSearches); return JSON.stringify(sm); })()`); ok(!/"exact":(\d{2,})/.test(n), n.slice(0, 300));
  });

  await check('5. "Je ne sais pas" changes nothing: same search (cached, free), no extra paid call, the answer is recorded as unknown', async () => {
    await t.eval(seed('r-unk', 'Stanley Quencher H2.0 tumbler', 'Stanley')); await sleep(300); await reload(t); await openMarket(t, 'r-unk'); const before = { ...counts };
    await click(t, '[data-act="market-run"]', 1500); ok(/Une précision \(une touche\)/.test(await text(t)), 'question expected again'); const afterSearch = { ...counts };
    await click(t, '[data-act="market-answer"][data-key="unknown"]', 1200); const s = await text(t); await shot(t, 'unknown-390', '.fm-note.fm-warnline, .fm-rbox');
    ok(counts.post === afterSearch.post && counts.balance === afterSearch.balance, 'no provider call for the answer'); ok(afterSearch.post === before.post, 'the repeated search came from the cache (not paid twice)');
    ok(/vous ne savez pas/.test(s) && /par groupe/.test(s) && /jamais mélangés/.test(s) && !/Une précision \(une touche\)/.test(s), s.slice(0, 500)); const rec = (await store(t))['r-unk'].marketSearches.at(-1); ok(rec.radar.confirmation.unknown === true, 'unknown recorded');
  });

  await check('6. fewer than 3 really comparable listings: "Prix de référence non fiable", no median, prices readable one by one, no supplier ratio; excluded ones stay listed', async () => {
    scenario = 'few'; await t.eval(seed('r-few', 'Acme steel bottle 500ml', 'Acme')); await sleep(300); await reload(t); await openMarket(t, 'r-few'); await click(t, '[data-act="market-run"]', 1500); const s = await text(t); await shot(t, 'unreliable-390', '.fm-unrel');
    ok(/Prix de référence non fiable/.test(s), s.slice(0, 700)); ok(!/Prix constatés/.test(s), 'no reference range'); ok(/Nordla ne donne pas de médiane/.test(s), 'says it gives no median'); ok(/20,00 € · 22,00 €/.test(s), 'the two comparable prices are readable');
    ok(/aucune comparaison avec le prix fournisseur/.test(s), 'no supplier ratio'); ok(!/Une précision \(une touche\)/.test(s), 'no useless question when nothing can be chosen'); await noOverflow(t, 'unreliable');
    await t.eval(`document.querySelectorAll('details.fm-rg').forEach((d) => { d.open = true; })`); await sleep(200); ok(/accessoire/.test(await text(t)), 'excluded listings keep their reason');
  });

  await check('9. TWO questions at most, one at a time, each with "Autre" and "Je ne sais pas": size, then variant; each answer is free (no provider call); the final range is ONE homogeneous group; lots, accessories, other brands are listed apart', async () => {
    scenario = 'acme'; await t.eval(seed('r-acme', 'water bottle', 'ACME')); await sleep(300); await reload(t); await openMarket(t, 'r-acme'); await click(t, '[data-act="market-run"]', 1500); const paid = counts.post;
    let s = await text(t); ok(/Quelle est la taille de votre produit/.test(s), s.slice(0, 600)); ok(/Si la bonne n’y est pas, écrivez-la dans « Autre »/.test(s), 'H1: the sentence is shown when an Autre field exists'); ok(await t.eval(`!!document.querySelector('[data-other-input]') && !!document.querySelector('[data-act="market-other"]')`), '"Autre" free text present'); ok(/Aucun produit exact trouvé/.test(s), 'explicit: no exact product'); ok(!/Prix constatés/.test(s), 'no price while pending');
    const labels = await t.eval(`[...document.querySelectorAll('[data-act="market-answer"] b')].map((b) => b.innerText)`); ok(JSON.stringify(labels) === JSON.stringify(['710 ml', '946 ml', 'Je ne sais pas']), JSON.stringify(labels));
    await click(t, '[data-act="market-answer"][data-key="0"]', 1200); s = await text(t); await shot(t, 'variant-question-390', '.fm-q');
    ok(counts.post === paid, 'the size answer is free'); ok(/Quelle variante est votre produit/.test(s), s.slice(0, 700)); ok(/taille 710 ml/.test(s), 'first answer recorded');
    const vl = await t.eval(`[...document.querySelectorAll('[data-act="market-answer"]')].map((b) => b.innerText.replace(/\\s+/g, ' '))`); ok(vl.length === 3 && vl.some((x) => /^Wide .*prix médian/.test(x)) && vl.some((x) => /^Standard .*prix médian/.test(x)), JSON.stringify(vl));
    const wide = await t.eval(`[...document.querySelectorAll('[data-act="market-answer"]')].findIndex((b) => /^Wide/.test(b.innerText))`); await click(t, `[data-act="market-answer"][data-key="${wide}"]`, 1200); s = await text(t); await shot(t, 'variant-final-390', '.fm-rbig');
    ok(counts.post === paid, 'the variant answer is free'); ok(!/Une précision \(une touche\)/.test(s), 'no third question'); ok(/taille 710 ml/.test(s) && /variante Wide/.test(s), 'both answers recorded');
    const big = await text(t, '.fm-rbig'); ok(/60,00 € – 62,50 € – 64,00 €/.test(big), big); ok(/sur 4 annonce/.test(s), 'four comparable listings');
    await t.eval(`document.querySelectorAll('details.fm-rg').forEach((d) => { d.open = true; })`); await sleep(200); const all = await text(t);
    ok(/Lots et packs — hors prix de référence/.test(all) && /55,00 € la pièce/.test(all) && /estimation/.test(all), 'lot apart with a per-piece ESTIMATE'); ok(/Accessoires — exclus des prix/.test(all), 'accessories apart'); ok(/autre variante/.test(all) && /capacité différente/.test(all) && /autre marque/.test(all), 'reasons for the excluded');
    ok((all.match(/disponibilité non vérifiée/g) ?? []).length >= 5, 'availability is never claimed on any listing'); await noOverflow(t, 'final variant screen');
  });

  await check('10. "Autre": a typed size (64 oz) is understood (1,89 L), costs nothing, and with no comparable listing gives "Prix de référence non fiable"; an unreadable size is refused with a message and changes nothing', async () => {
    await t.eval(seed('r-free', 'water bottle', 'ACME')); await sleep(300); await reload(t); await openMarket(t, 'r-free'); const before = counts.post; await click(t, '[data-act="market-run"]', 1500); ok(counts.post === before, 'the search itself came from the cache');
    const n0 = (await store(t))['r-free'].marketSearches.length;
    await t.eval(`(() => { const i = document.querySelector('[data-other-input]'); i.value = 'beaucoup'; })()`); await click(t, '[data-act="market-other"]', 900); let s = await text(t); ok(/Taille non comprise/.test(s), s.slice(0, 500)); ok((await store(t))['r-free'].marketSearches.length === n0, 'nothing stored for an unreadable size');
    await t.eval(`(() => { const i = document.querySelector('[data-other-input]'); i.value = '64 oz'; })()`); await click(t, '[data-act="market-other"]', 1200); s = await text(t); await shot(t, 'autre-64oz-390', '.fm-unrel');
    ok(counts.post === before, 'a typed size costs nothing'); ok(/taille 1,89 L/.test(s), s.slice(0, 600)); ok(/Prix de référence non fiable/.test(s) && !/Prix constatés/.test(s), 'no comparable listing at 1,89 L: honest'); await noOverflow(t, 'autre');
  });

  await check('11. "Je ne sais pas" on size AND variant: prices are given PER GROUP (never one mixed median); the questions are not asked again', async () => {
    await t.eval(seed('r-unk2', 'insulated bottle', 'ACME')); await sleep(300); await reload(t); await openMarket(t, 'r-unk2'); await click(t, '[data-act="market-run"]', 1500); let s = await text(t);
    for (let i = 0; i < 2 && /Une précision \(une touche\)/.test(s); i += 1) { await click(t, '[data-act="market-answer"][data-key="unknown"]', 1100); s = await text(t); }
    await shot(t, 'groups-390', '.fm-rbox'); ok(!/Une précision \(une touche\)/.test(s), 'no more question after two "Je ne sais pas"'); const titles = await t.eval(`[...document.querySelectorAll('.fm-rbox .fm-k2')].map((e) => e.innerText)`);
    ok(titles.filter((x) => /^Prix constatés/.test(x)).length >= 2, `one box per homogeneous group: ${JSON.stringify(titles)}`); ok(!/médiane observée/.test(s) || /non fiable|aucune comparaison/.test(s), 'no supplier ratio on a mixed set'); await noOverflow(t, 'groups');
  });

  await check('12. G2 on 53 REAL listings: the case does not say the KIND of product -> ONE type question (bottle / travel tumbler); the answer is free; tumblers leave the bottle price and stay listed as "autre type de produit"', async () => {
    scenario = 'real'; await t.eval(seed('r-real', 'Hydro Flask', 'Hydro Flask')); await sleep(300); await reload(t); await openMarket(t, 'r-real'); await click(t, '[data-act="market-run"]', 1800); const paid = counts.post;
    let s = await text(t); await shot(t, 'type-question-390', '.fm-q'); ok(/De quel type de produit/.test(s), s.slice(0, 600)); ok(!(await t.eval(`!!document.querySelector('[data-other-input]')`)), 'no free text for a closed list of kinds'); ok(!/écrivez-la dans « Autre »/.test(s), 'H1: the sentence about Autre is not shown when there is no Autre field');
    const promised = await t.eval(`[...document.querySelectorAll('[data-act="market-answer"]')].map((b) => b.innerText.replace(/\\s+/g, ' '))`); ok(promised.some((x) => /^gourde \/ bouteille 4 annonce\(s\) retenue\(s\) · prix médian indicatif 42,68 €/.test(x)), JSON.stringify(promised)); ok(/Aucun produit exact trouvé/.test(s), 'no exact product, said'); ok(!/Prix constatés/.test(s), 'no price while pending');
    const labels = await t.eval(`[...document.querySelectorAll('[data-act="market-answer"] b')].map((b) => b.innerText)`); ok(JSON.stringify(labels) === JSON.stringify(['gobelet de voyage', 'gourde / bouteille', 'Je ne sais pas']), JSON.stringify(labels));
    const bottle = await t.eval(`[...document.querySelectorAll('[data-act="market-answer"] b')].findIndex((b) => b.innerText === 'gourde / bouteille')`); await click(t, `[data-act="market-answer"][data-key="${bottle}"]`, 1300); s = await text(t);
    ok(counts.post === paid, 'the type answer is free'); ok(/Prix de référence non fiable/.test(s) && !/Prix constatés/.test(s), 'a case named with the brand alone and no verified size: no price at all, said honestly');
    ok(/Prix indicatifs par famille — pas un prix de référence/.test(s) && /gourde \/ bouteille : 31,10 € – 42,68 € – 44,95 € sur 4 annonce\(s\) similaires/.test(s), `H3: the indicative price equals what the question promised: ${s.slice(0, 900)}`); ok(/pas le même produit/.test(s) && /jamais comme un prix de référence/.test(s), 'H3: labelled as context only'); ok(/type gourde \/ bouteille/.test(s), s.slice(0, 500));
    await t.eval(`document.querySelectorAll('details.fm-rg').forEach((d) => { d.open = true; })`); await sleep(200); const all = await text(t); ok(/autre type de produit/.test(all), 'tumblers listed with their reason'); ok(/Travel Tumbler/i.test(all), 'the tumbler listings stay consultable'); await shot(t, 'type-answered-390', '.fm-k2'); await noOverflow(t, 'type answered');
  });

  await check('13. "Je ne sais pas" on the kind of product: prices are given per TYPE group, a Travel Tumbler is never averaged with a bottle', async () => {
    await t.eval(seed('r-real2', 'Hydro Flask', 'Hydro Flask')); await sleep(300); await reload(t); await openMarket(t, 'r-real2'); await click(t, '[data-act="market-run"]', 1500); let s = await text(t);
    for (let i = 0; i < 2 && /Une précision \(une touche\)/.test(s); i += 1) { await click(t, '[data-act="market-answer"][data-key="unknown"]', 1100); s = await text(t); }
    const titles = await t.eval(`[...document.querySelectorAll('.fm-rbox .fm-k2')].map((e) => e.innerText)`); const typed = titles.filter((x) => /gobelet de voyage|gourde \/ bouteille|type non précisé/.test(x));
    ok(titles.every((x) => !/^Prix constatés$/.test(x)) || typed.length === 0, `no mixed single box: ${JSON.stringify(titles)}`); ok(!/médiane observée/.test(s), 'no supplier ratio on mixed types'); await noOverflow(t, 'types grouped');
  });

  await check('14. H2 "Préciser": with NO automatic question (a bottle case, nothing to choose), the owner can still type the size / variant; unreadable values are refused; it is free, replaces an earlier value, and survives', async () => {
    await t.eval(seed('r-prec', 'water bottle', 'Hydro Flask')); await sleep(300); await reload(t); await openMarket(t, 'r-prec'); await click(t, '[data-act="market-run"]', 1800); const paid = counts.post; let s = await text(t);
    ok(!/Une précision \(une touche\)/.test(s), 'no automatic question for a bottle case'); ok(await t.eval(`!!document.querySelector('details.fm-prec')`), 'the Préciser section is permanent');
    ok(/gourde \/ bouteille : 31,10 € – 42,68 € – 44,95 € sur 4 annonce\(s\) similaires/.test(s) && /Marque Hydro Flask : seules les annonces qui la nomment sont retenues ; 2 annonce\(s\) d’autres marques sont laissées de côté/.test(s), `H4: a known brand is respected and said: ${s.slice(0, 900)}`); await t.eval(`document.querySelector('details.fm-prec').open = true`); await sleep(200); await shot(t, 'preciser-390', 'details.fm-prec');
    const h = await t.eval(`[...document.querySelectorAll('[data-prec], [data-act="market-precise"]')].map((e) => Math.round(e.getBoundingClientRect().height))`); ok(h.length === 4 && h.every((x) => x >= 44), `touch targets: ${JSON.stringify(h)}`);
    const n0 = (await store(t))['r-prec'].marketSearches.length;
    await click(t, '[data-act="market-precise"]', 600); s = await text(t); ok(/Écrivez au moins une valeur/.test(s), 'empty submit explained'); await t.eval(`document.querySelector('details.fm-prec').open = true; document.querySelector('[data-prec="capacity"]').value = 'beaucoup'`); await click(t, '[data-act="market-precise"]', 900); s = await text(t);
    ok(/Non compris : taille/.test(s), s.slice(0, 500)); ok((await store(t))['r-prec'].marketSearches.length === n0, 'nothing stored for an unreadable size');
    await t.eval(`document.querySelector('details.fm-prec').open = true; document.querySelector('[data-prec="capacity"]').value = '946 ml'; document.querySelector('[data-prec="variant"]').value = 'wide mouth'`); await click(t, '[data-act="market-precise"]', 1200); s = await text(t);
    ok(counts.post === paid, 'Préciser is free: no provider call'); ok(/Précision confirmée par vous : taille 946 ml · variante wide mouth/.test(s), s.slice(0, 700)); let rec = (await store(t))['r-prec'].marketSearches.at(-1); ok(rec.radar.confirmation.answered === 'precise' && rec.radar.confirmation.accumulated.capacityMl === 946 && rec.radar.confirmation.asked === 0, 'recorded, no question consumed');
    await t.eval(`document.querySelector('details.fm-prec').open = true; document.querySelector('[data-prec="capacity"]').value = '64 oz'`); await click(t, '[data-act="market-precise"]', 1200); s = await text(t); ok(/taille 1,89 L/.test(s) && !/taille 946 ml/.test(s), 'a newly typed size replaces the earlier one'); ok(counts.post === paid, 'still free');
    await reload(t); await openMarket(t, 'r-prec'); s = await text(t); ok(/taille 1,89 L/.test(s), 'survives a reload'); await noOverflow(t, 'preciser');
  });

  await check('15. H4 brand UNKNOWN: nothing is filtered by brand and the screen says the comparison mixes brands', async () => {
    await t.eval(`(async () => { const c = JSON.parse(localStorage.getItem('nordla.sourcing.cases')); const k = 'r-nobrand'; const m = await import('/core/case.js'); let x = m.newCase({ id: k, name: 'water bottle', now: new Date('2026-10-20T08:00:00Z') }); c[k] = x; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(c)); localStorage.setItem('nordla.sourcing.current', JSON.stringify(k)); })()`); await sleep(300); await reload(t); await openMarket(t, 'r-nobrand'); const before = counts.post; await click(t, '[data-act="market-run"]', 1800); const s = await text(t); await shot(t, 'brand-unknown-390', '.fm-ind');
    ok(counts.post === before + 1, 'one paid search (a different query)'); ok(/Prix indicatifs par famille — pas un prix de référence/.test(s), s.slice(0, 600)); ok(/Marque inconnue : ces prix peuvent mélanger plusieurs marques/.test(s), 'the limit of the comparison is shown'); ok(!/laissées de côté/.test(s), 'nothing was left out by brand'); await noOverflow(t, 'brand unknown');
  });

  await check('7. the free step really is free: provider calls over the whole session = exactly the distinct searches that were pressed (answers and repeated searches add none)', async () => {
    ok(counts.post === 7, `paid searches ${counts.post}`); // r-size, r-few, r-acme, r-unk2 and r-real, r-prec and r-nobrand are seven DIFFERENT queries (r-real2 repeats r-real: cache); r-unk, r-free repeat an earlier one (cache) and every answer is free
  });

  await check('8. no uncaught error in the whole session', async () => { ok(errs.length === 0, errs.join(' | ').slice(0, 500)); });
} finally {
  try { await browser.close?.(); } catch { /* gone */ } try { await new Promise((r) => server.server.close(r)); } catch { /* closed */ }
  rmSync(dirA, { recursive: true, force: true });
  const passed = results.filter(Boolean).length; console.log(`\n${passed}/${results.length} passed`); process.exit(passed === results.length ? 0 : 1);
}
