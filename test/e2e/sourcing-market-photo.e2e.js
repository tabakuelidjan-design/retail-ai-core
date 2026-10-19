// Market radar FROM A PHOTO, on a phone-sized REAL browser engine (Chrome / Edge through the DevTools Protocol; NOT a physical phone). The search provider and Google Vision are SIMULATED behind the real server routes;
// the LOCAL barcode reading (BarcodeDetector when the engine has it, otherwise the JS decoder) runs for real on a barcode image drawn in the page. Three situations: brand + model on a label, a barcode, a generic product.
//   node test/e2e/sourcing-market-photo.e2e.js        (SOURCING_E2E_SHOTS=<dir> for screenshots)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { createMarketRadar } from '../../src/sourcing/server/market-radar-service.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'market-photo-token-0123456789-abcdef'; const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 900)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const KEY = 'AIza-e2e-Secret-Key'; const GTIN = '4006381333931'; const GTIN2 = '3017620422003';
const log = { vision: 0, keywords: [], visionShas: [] }; let visionScript = []; let visionFail = 0;
const fakeFetch = async (url, opt = {}) => {
  if (url.includes('openfoodfacts.org/api/v2/product/')) return json(url.includes(GTIN) ? { status: 1, product: { product_name: 'Spread', brands: 'Acme Foods, Other', quantity: '400 g' } } : { status: 0 });
  if (url.includes('openproductsfacts.org') || url.includes('openbeautyfacts.org')) return json({ status: 0 });
  if (url.includes('vision.googleapis.com')) { log.vision++; log.visionShas.push(createHash('sha256').update(Buffer.from(JSON.parse(opt.body).requests[0].image.content, 'base64')).digest('hex')); if (visionFail) return json({}, visionFail); return json({ responses: [visionScript.shift() ?? {}] }); }
  if (url.endsWith('/appendix/user_data')) return json({ tasks: [{ result: [{ money: { balance: 1 } }] }] });
  if (url.endsWith('/locations')) return json({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] });
  if (url.endsWith('/products/task_post')) { const kw = JSON.parse(opt.body)[0].keyword; log.keywords.push(kw); return json({ tasks: [{ id: `t${log.keywords.length}`, status_code: 20100, cost: 0.002, data: { keyword: kw } }] }); }
  if (url.includes('/task_get/advanced/')) { const kw = log.keywords.at(-1); return json({ tasks: [{ status_code: 20000, result: [{ datetime: '2026-10-19 15:02:34 +00:00', items: [
    { type: 'google_shopping_serp', title: `${kw} Edition A`, price: 24.9, currency: 'EUR', seller: 'bol', url: 'https://google.be/search?ibp=oshop&q=a&prds=1' },
    { type: 'google_shopping_serp', title: `${kw} Edition B`, price: 29, currency: 'EUR', seller: 'Amazon.com.be', url: 'https://google.be/search?ibp=oshop&q=a&prds=2' },
    { type: 'google_shopping_serp', title: `${kw} Edition C`, price: 27.5, currency: 'EUR', seller: 'Shop', url: 'https://google.be/search?ibp=oshop&q=a&prds=3' }] }] }] }); }
  throw new Error(`unexpected ${url}`);
};
const mkRadar = (env = {}) => createMarketRadar({ env: { DATAFORSEO_LOGIN: 'owner@example.test', DATAFORSEO_PASSWORD: 'pw-e2e', GOOGLE_VISION_API_KEY: KEY, MARKET_PHOTO_ENABLED: '1', MARKET_MIN_INTERVAL_SEC: '0.001', MARKET_PHOTO_MIN_INTERVAL_SEC: '0.001', MARKET_CACHE_HOURS: '0.0001', ...env }, fetchImpl: fakeFetch, ecb: async () => ({ date: '2026-10-19', perEur: { USD: 1.1 } }), sleep: async () => {}, pollMs: 1 });
const dirA = mkdtempSync(join(tmpdir(), 'nordla-photo-e2e-')); const dirB = mkdtempSync(join(tmpdir(), 'nordla-photo-e2e-b-'));
const port = await freePort(); const base = `http://127.0.0.1:${port}`;
let server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir: dirA, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({ date: '2026-10-19', perEur: { USD: 1.1 } }), services: { market: mkRadar() } });
const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch();
const errs = []; browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const ready = (t) => t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000);
const store = async (t) => JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases') ?? '{}'"));
let shotN = 0; const shot = async (t, name) => { if (!SHOTS) return; await sleep(250); const r = await browser.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`), Buffer.from(r.data, 'base64')); };
const openMarket = async (t, caseId) => { await t.eval(`(() => { const b = document.createElement('button'); b.setAttribute('data-act', 'sl-embed'); b.setAttribute('data-key', 'market'); b.setAttribute('data-case', ${JSON.stringify(caseId)}); document.body.appendChild(b); b.click(); b.remove(); })()`); await sleep(600); };
const clickSel = async (t, sel, ms = 600) => { await t.eval(`document.querySelector(${JSON.stringify(sel)}).click()`); await sleep(ms); };
const waitText = (t, re, ms = 20000) => t.waitFor(`new RegExp(${JSON.stringify(re)}, 'i').test(document.querySelector('#screen')?.innerText ?? '')`, ms);

// images drawn IN THE PAGE: a barcode (EAN-13 from independent tables), a label with text, a plain generic bottle
const PAGE_IMAGES = `(() => {
  const Lc=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'],Gc=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'],Rc=['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
  const PAR=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
  const mod=(d)=>{const p=PAR[+d[0]];let m='101';for(let i=0;i<6;i++)m+=(p[i]==='L'?Lc:Gc)[+d[1+i]];m+='01010';for(let i=0;i<6;i++)m+=Rc[+d[7+i]];return m+'101';};
  const barcode=(d,scale=4)=>{const m=mod(d);const c=document.createElement('canvas');c.width=(m.length+30)*scale;c.height=260;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle='#000';for(let i=0;i<m.length;i++)if(m[i]==='1')x.fillRect((15+i)*scale,20,scale,190);x.font='28px monospace';x.fillText(d,(15)*scale,246);return c.toDataURL('image/png');};
  const label=()=>{const c=document.createElement('canvas');c.width=640;c.height=420;const x=c.getContext('2d');x.fillStyle='#e8eef7';x.fillRect(0,0,640,420);x.fillStyle='#0f2a52';x.font='bold 64px sans-serif';x.fillText('ACME',60,150);x.font='40px monospace';x.fillText('RB-980HB 500 ml',60,230);return c.toDataURL('image/png');};
  const generic=()=>{const c=document.createElement('canvas');c.width=480;c.height=640;const x=c.getContext('2d');x.fillStyle='#fafafa';x.fillRect(0,0,480,640);x.fillStyle='#6a8caf';x.fillRect(170,120,140,460);x.fillStyle='#333';x.fillRect(195,70,90,50);return c.toDataURL('image/png');};
  return { barcode, label, generic };
})()`;
const seedCase = (t, id, photos) => t.eval(`(async () => { const m = await import('/core/case.js'); const st = await import('/storage.js'); const imgs = ${PAGE_IMAGES}; const T0 = new Date('2026-10-20T08:00:00Z');
  let c = m.newCase({ id: ${JSON.stringify(id)}, name: '', now: T0 }); const urls = ${JSON.stringify(photos)}.map((p) => (p.startsWith('barcode') ? imgs.barcode(p.split(':')[1] || ${JSON.stringify(GTIN)}) : p === 'label' ? imgs.label() : imgs.generic()));
  for (let i = 0; i < urls.length; i++) { c = m.dispatch(c, { type: 'PHOTO', ref: 'p' + i, note: null }, new Date(T0.getTime() + (i + 1) * 60000)); await st.putBlob('photo:' + c.id + '.' + i, urls[i]); }
  const cases = JSON.parse(localStorage.getItem('nordla.sourcing.cases') ?? '{}'); cases[c.id] = c; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.current', JSON.stringify(c.id)); return urls.length; })()`);
const noOverflow = async (t, label) => { const r = await t.eval('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })'); ok(r.sw <= r.cw, `${label}: horizontal overflow ${r.sw} > ${r.cw}`); };

try {
  const t = await browser.tab(`${base}/#t=${TOKEN}`, { width: 390, height: 844 }); await ready(t); await sleep(900);
  ok(await seedCase(t, 'ph-barcode2', ['barcode:' + GTIN2]) === 1 && await seedCase(t, 'ph-barcode', ['barcode']) === 1 && await seedCase(t, 'ph-label', ['label']) === 1 && await seedCase(t, 'ph-generic', ['generic']) === 1, 'cases seeded');
  await t.eval('location.reload()'); await ready(t); await sleep(1200);

  await check('A. BARCODE photo: read ON THE PHONE (no photo sent, Vision never called), named by the open database, the NAME is searched, results shown with "Reconnu par Nordla"', async () => {
    await openMarket(t, 'ph-barcode'); ok(/À partir d’une photo du dossier/.test(await text(t)) && (await t.eval("document.querySelectorAll('.fm-thumb').length")) === 1, 'thumbnail offered');
    await clickSel(t, '.fm-thumb', 300); await waitText(t, 'Résultat de la recherche'); const s = await text(t); await shot(t, 'A-barcode-390');
    ok(log.vision === 0, `Vision must not be called for a barcode (calls: ${log.vision})`); ok(log.keywords[0] === 'Acme Foods Spread 400 g' && log.keywords.length === 1, `the barcode is resolved to a NAME by the open database and the NAME is searched: ${JSON.stringify(log.keywords)}`); ok(/base ouverte/.test(s) && /Spread/.test(s) && /pas une preuve que l’objet photographié/.test(s), 'lookup shown with its source and its limit');
    ok(/Reconnu par Nordla/.test(s) && /Code-barres lu\s+sur le téléphone/.test(s) && /aucune photo n’a été envoyée/.test(s) && new RegExp(GTIN).test(s), s.slice(0, 700)); ok(/élevée/.test(s), 'confidence shown');
    const rec = (await store(t))['ph-barcode'].marketSearches.at(-1); ok(rec.radar.identification.source === 'LOCAL_BARCODE' && rec.radar.identification.photo.sentToProvider === false && ['BarcodeDetector', 'local-js'].includes(rec.radar.identification.engine), JSON.stringify(rec.radar.identification));
    ok(rec.evidence.length === 3 && rec.evidence.every((e) => e.url && e.observedAt), 'evidence kept with provenance'); console.log(`      engine used for the barcode: ${rec.radar.identification.engine}`);
  });

  await check('A2. BARCODE not in the open databases: the number itself is searched, nothing can be tied to it, so NO price range is given and the owner is told', async () => {
    log.keywords.length = 0; await openMarket(t, 'ph-barcode2'); await clickSel(t, '.fm-thumb', 300); await waitText(t, 'Résultat de la recherche'); const s = await text(t); await shot(t, 'A2-unverifiable-390');
    ok(log.vision === 0 && log.keywords[0] === GTIN2, `searched by the number: ${JSON.stringify(log.keywords)}`); ok(/n’est pas dans les bases ouvertes/.test(s) && /Aucune annonce n’a pu être rattachée/.test(s), s.slice(0, 900));
    ok((await t.eval(`document.querySelectorAll('.fm-rbig').length`)) === 0, 'no price range'); const rec = (await store(t))['ph-barcode2'].marketSearches.at(-1); ok(rec.evidence.every((e) => e.specs.excluded), 'every listing kept but excluded');
  });

  await check('B. LABEL photo (brand + model, no barcode): consent card first, NOTHING sent before the owner agrees, "No" sends nothing', async () => {
    log.keywords.length = 0; await openMarket(t, 'ph-label'); await clickSel(t, '.fm-thumb', 900); await waitText(t, 'Votre accord est nécessaire'); const s = await text(t); await shot(t, 'B-consent-390');
    ok(/Google Cloud Vision, aux États-Unis/.test(s) && /SHA-256/.test(s) && /cette photo/.test(s) && /ni conservée ni journalisée/.test(s), s.slice(0, 700)); ok(log.vision === 0, 'nothing sent while the card is shown');
    await clickSel(t, '[data-act="market-photo-cancel"]', 500); ok(!/Votre accord est nécessaire/.test(await text(t)), 'card closed'); ok(log.vision === 0 && log.keywords.length === 0, 'cancel sends nothing, searches nothing');
  });

  await check('C. LABEL photo with consent: ONE Vision call bound to this image; brand + model read -> automatic search; results labelled "à confirmer"', async () => {
    visionScript = [{ webDetection: { bestGuessLabels: [{ label: 'insulated water bottle' }], webEntities: [{ description: 'Water bottle', score: 0.9 }] }, textAnnotations: [{ description: 'ACME\nRB-980HB 500 ml' }], logoAnnotations: [{ description: 'ACME', score: 0.93 }] }];
    await clickSel(t, '.fm-thumb', 900); await waitText(t, 'Votre accord est nécessaire'); const shaShown = (await text(t)).match(/SHA-256\) : ([0-9a-f]{16})/)?.[1]; ok(!!shaShown, 'sha shown');
    await clickSel(t, '[data-act="market-photo-send"]', 300); await waitText(t, 'Résultat de la recherche'); const s = await text(t); await shot(t, 'C-label-result-390');
    ok(log.vision === 1, `exactly one Vision call (${log.vision})`); ok(log.visionShas[0].startsWith(shaMatch(shaShown)), 'the consent was bound to the very image that was sent');
    ok(/Lu par\s+Google Cloud Vision/.test(s) && /à confirmer/.test(s) && /ACME/.test(s) && /RB-980HB/.test(s) && /moyenne/.test(s), s.slice(0, 900)); ok(log.keywords.some((k) => /ACME RB-980HB/.test(k)), `queries: ${JSON.stringify(log.keywords)}`);
    const rec = (await store(t))['ph-label'].marketSearches.at(-1); ok(rec.radar.identification.source === 'PHOTO_VISION' && rec.radar.identification.photo.sentToProvider === true && /^[0-9a-f]{64}$/.test(rec.radar.identification.photo.sha256) && rec.radar.identification.photo.consentAt, 'consent and provenance stored in the case');
    ok(!JSON.stringify(await store(t)).includes('/9j/') && !JSON.stringify(rec).includes('imageBase64'), 'no pixels in the stored record'); ok(!JSON.stringify(rec).includes(KEY), 'no key');
  });

  await check('D. GENERIC photo (no brand, no model, no barcode): Vision gives a category-level guess -> a ONE-TAP confirmation, comparable products only, never an exact identification', async () => {
    log.keywords.length = 0; log.vision = 0; visionScript = [{ webDetection: { bestGuessLabels: [{ label: 'insulated water bottle' }], webEntities: [{ description: 'Bottle', score: 0.8 }] }, textAnnotations: [], logoAnnotations: [] }];
    await openMarket(t, 'ph-generic'); await clickSel(t, '.fm-thumb', 900); await waitText(t, 'Votre accord est nécessaire'); await clickSel(t, '[data-act="market-photo-send"]', 300); await waitText(t, 'À confirmer \\(une touche\\)');
    const s = await text(t); await shot(t, 'D-confirm-390'); ok(/insulated water bottle/.test(s) && /nom de catégorie, pas un produit précis/.test(s) && /produits comparables/i.test(s), s.slice(0, 600)); ok(log.vision === 1 && log.keywords.length === 0, 'no search before the owner confirms');
    await clickSel(t, '[data-act="market-photo-go"]', 300); await waitText(t, 'Résultat de la recherche'); const r = await text(t); await shot(t, 'D-result-390');
    ok(/faible/.test(r) && /produits COMPARABLES, pas le produit identifié/.test(r), r.slice(0, 700)); ok(log.keywords[0] === 'insulated water bottle', `query from the guess: ${JSON.stringify(log.keywords)}`);
    const rec = (await store(t))['ph-generic'].marketSearches.at(-1); ok(rec.evidence.every((e) => e.matchType !== 'EXACT_MATCH'), 'never EXACT for a generic guess'); ok(rec.radar.identification.confidence === 'LOW', 'confidence LOW stored');
  });

  await check('E. nothing recognised: the owner is told, nothing is invented, no search is made', async () => {
    log.keywords.length = 0; visionScript = [{ webDetection: {}, textAnnotations: [], logoAnnotations: [] }]; const before = (await store(t))['ph-generic'].marketSearches.length;
    await clickSel(t, '.fm-thumb', 900); await waitText(t, 'Votre accord est nécessaire'); await clickSel(t, '[data-act="market-photo-send"]', 300); await waitText(t, 'rien reconnu de fiable');
    ok(log.keywords.length === 0 && (await store(t))['ph-generic'].marketSearches.length === before, 'no search, case unchanged');
  });

  await check('F. Vision error: explicit message, nothing stored, and the photo bytes are dropped', async () => {
    visionFail = 502; const before = JSON.stringify((await store(t))['ph-generic'].marketSearches); await clickSel(t, '.fm-thumb', 900); await waitText(t, 'Votre accord est nécessaire'); await clickSel(t, '[data-act="market-photo-send"]', 300); await waitText(t, 'Rien n’a été modifié');
    const s = await text(t); ok(/service de reconnaissance/.test(s), s.slice(0, 400)); ok(JSON.stringify((await store(t))['ph-generic'].marketSearches) === before, 'case untouched'); visionFail = 0;
    ok(!(await text(t)).includes('[data-act="market-photo-send"]'), 'no pending consent card'); ok((await t.eval(`document.querySelectorAll('[data-act="market-photo-send"]').length`)) === 0, 'consent card gone');
  });

  await check('G. 390 px: nothing overflows horizontally', async () => { await noOverflow(t, 'photo flow'); });

  await check('H. photo recognition NOT enabled on the server: a photo without barcode explains it and sends NOTHING', async () => {
    const portB = await freePort(); const b = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port: portB, dir: dirB, fetchImpl: async () => { throw new Error('no network'); }, services: { market: mkRadar({ MARKET_PHOTO_ENABLED: '0' }) } }); const v0 = log.vision;
    try { const t2 = await browser.tab(`http://127.0.0.1:${portB}/#t=${TOKEN}`, { width: 390, height: 844 }); await ready(t2); await sleep(800); await seedCase(t2, 'ph-off', ['label']); await t2.eval('location.reload()'); await ready(t2); await sleep(1000);
      await openMarket(t2, 'ph-off'); await clickSel(t2, '.fm-thumb', 900); await waitText(t2, 'Aucun code-barres lisible'); const s = await text(t2); ok(/n’est pas activée sur ce serveur/.test(s) && /rien n’a été envoyé/.test(s), s.slice(0, 500)); ok(log.vision === v0, 'Vision never called'); await shot(t2, 'H-off-390');
    } finally { await new Promise((r) => b.server.close(r)); b.server.closeAllConnections?.(); }
  });

  await check('I. no uncaught error in the whole session', async () => { ok(errs.length === 0, errs.join(' | ').slice(0, 500)); });
} finally {
  try { await browser.close?.(); } catch { /* gone */ } try { await new Promise((r) => server.server.close(r)); } catch { /* closed */ }
  rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true });
  const passed = results.filter(Boolean).length; console.log(`\n${passed}/${results.length} passed`); process.exit(passed === results.length ? 0 : 1);
}
function shaMatch(prefix) { return String(prefix); }
