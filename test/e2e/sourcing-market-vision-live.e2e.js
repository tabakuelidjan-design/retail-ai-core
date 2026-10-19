// REAL Google Cloud Vision trial (MANUAL, never part of CI). One photo chosen by the owner, authorised EXPLICITLY by its fingerprint, at most 5 photos a day, nothing is called unless every check below passes.
//   1) node test/e2e/sourcing-market-vision-live.e2e.js --photo "C:\path\product.jpg"                 -> CHECKS ONLY: nothing is sent; prints the exact fingerprint of what WOULD be sent
//   2) node test/e2e/sourcing-market-vision-live.e2e.js --photo "..." --authorize <fingerprint>       -> the owner's go for THAT image: Vision once, then the DataForSEO search, in the phone-sized app
//   --rehearsal  : the whole route with SIMULATED Vision and DataForSEO (no key, no spend, no network) to test this script itself.
// The key (GOOGLE_VISION_API_KEY) and the DataForSEO login/password live in %USERPROFILE%\.nordla\market-proof.env(.txt), outside the repository; they are never printed.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { createMarketRadar } from '../../src/sourcing/server/market-radar-service.js';
import { loadEnv } from '../../tools/market-proof/lib.mjs';
import { dfsBalance } from '../../src/sourcing/adapters/market-dataforseo.js';
import { imageKind, VISION_COST_PER_PHOTO_USD } from '../../src/sourcing/adapters/market-vision.js';
import { fetchEcb } from '../../src/sourcing/adapters/fx.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? null : (process.argv[i + 1]?.startsWith('--') ? true : process.argv[i + 1] ?? true); };
const PHOTO = arg('photo'); const AUTH = arg('authorize'); const REHEARSAL = process.argv.includes('--rehearsal');
const DAILY_MAX = 5; const MIN_DFS_BALANCE = 0.02; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = join(homedir(), '.nordla', 'market-proof-out'); mkdirSync(out, { recursive: true }); const usageFile = join(out, 'vision-usage.json');
const today = new Date().toISOString().slice(0, 10); const usage = (() => { try { const u = JSON.parse(readFileSync(usageFile, 'utf8')); return u.date === today ? u : { date: today, count: 0 }; } catch { return { date: today, count: 0 }; } })();
const env = REHEARSAL ? { DATAFORSEO_LOGIN: 'rehearsal', DATAFORSEO_PASSWORD: 'rehearsal', GOOGLE_VISION_API_KEY: 'rehearsal-key' } : loadEnv();
const checks = []; const check = (label, pass, detail = '') => { checks.push(pass); console.log(`${pass ? 'OK  ' : 'STOP'} ${label}${detail ? ` : ${detail}` : ''}`); return pass; };

// ---- 1. every check BEFORE any network call
const file = typeof PHOTO === 'string' ? PHOTO : null; const bytes = file && existsSync(file) ? readFileSync(file) : null;
check('a photo was chosen explicitly (--photo)', !!file, file ? basename(file) : 'missing'); check('the photo file exists and is readable', !!bytes);
const kind = bytes ? imageKind(bytes) : null; check('the photo is a JPEG, PNG or WebP (read from its bytes)', !!kind, kind ?? 'unknown'); check('the photo is at most 6 MB (it is reduced to 1024 px before sending)', !!bytes && bytes.length <= 6 * 1024 * 1024, bytes ? `${Math.round(bytes.length / 1024)} KB` : '');
check('DataForSEO credentials are present (search step)', !!(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD)); check('GOOGLE_VISION_API_KEY is present (value never shown)', !!env.GOOGLE_VISION_API_KEY, env.GOOGLE_VISION_API_KEY ? 'present' : 'MISSING: create a key limited to the Cloud Vision API and add it to the env file');
check(`daily limit: ${usage.count} photo(s) already used today, maximum ${DAILY_MAX}`, usage.count < DAILY_MAX);
check(`estimated Vision cost per photo ${VISION_COST_PER_PHOTO_USD} USD is under the ceiling (0.02 USD)`, VISION_COST_PER_PHOTO_USD <= 0.02);
let balance = null; if (!REHEARSAL && env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD) balance = await dfsBalance({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD }); if (REHEARSAL) balance = 1;
check(`DataForSEO balance readable and at least ${MIN_DFS_BALANCE} USD (search step, trial credit only)`, balance !== null && balance >= MIN_DFS_BALANCE, balance === null ? 'unreadable' : `${balance} USD`);
if (checks.some((c) => !c)) { console.log('\nNOTHING WAS SENT: at least one check failed. Fix it and rerun.'); process.exit(3); }

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'vision-live-token-0123456789-abcdef'; const calls = { vision: 0, dfs: 0 }; let authorizedNow = false;
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
const rehearsalFetch = async (url, opt = {}) => {
  if (url.includes('vision.googleapis.com')) { calls.vision++; return json({ responses: [{ webDetection: { bestGuessLabels: [{ label: 'rehearsal product' }], webEntities: [{ description: 'Rehearsal', score: 0.5 }] }, textAnnotations: [], logoAnnotations: [] }] }); }
  if (url.includes('facts')) return json({ status: 0 }); if (url.endsWith('/appendix/user_data')) return json({ tasks: [{ result: [{ money: { balance: 1 } }] }] }); if (url.endsWith('/locations')) return json({ tasks: [{ result: [{ location_code: 2056, country_iso_code: 'BE' }] }] });
  if (url.endsWith('/products/task_post')) { calls.dfs++; return json({ tasks: [{ id: 'r1', status_code: 20100, cost: 0 }] }); }
  return json({ tasks: [{ status_code: 20000, result: [{ datetime: '2026-10-19 15:02:34 +00:00', items: [{ type: 'google_shopping_serp', title: 'rehearsal product A', price: 10, currency: 'EUR', seller: 'Rehearsal', url: 'https://google.be/search?ibp=oshop&q=r' }] }] }] });
};
const guardedFetch = async (url, opt) => {
  if (REHEARSAL) return rehearsalFetch(url, opt);
  if (String(url).includes('vision.googleapis.com')) { if (!authorizedNow || calls.vision >= 1) throw new Error('BLOCKED: Vision is called only once, only after the owner authorised this exact image'); calls.vision++; }
  if (String(url).endsWith('/products/task_post')) calls.dfs++;
  return fetch(url, opt);
};
const radar = createMarketRadar({ env: { DATAFORSEO_LOGIN: env.DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD: env.DATAFORSEO_PASSWORD, GOOGLE_VISION_API_KEY: env.GOOGLE_VISION_API_KEY, MARKET_PHOTO_ENABLED: '1', MARKET_PHOTO_DAILY_MAX: '1', MARKET_PHOTO_MAX_COST_USD: '0.02', MARKET_MAX_COST_USD: '0.05', MARKET_DAILY_MAX: '2' }, fetchImpl: guardedFetch, ecb: REHEARSAL ? async () => ({ date: '2026-10-19', perEur: {} }) : () => fetchEcb(), ...(REHEARSAL ? { sleep: async () => {}, pollMs: 1 } : {}) });
const dir = mkdtempSync(join(tmpdir(), 'nordla-vision-live-')); const port = await freePort();
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => { throw new Error('no network'); }, ecb: async () => ({ date: '2026-10-19', perEur: {} }), services: { market: radar } });
const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch(); const errs = []; browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? ''); });
const text = (t) => t.eval(`document.querySelector('#screen')?.innerText ?? ''`); let n = 0;
const shot = async (t, name) => { if (!SHOTS) return; await sleep(300); const r = await browser.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${++n}-${name}.png`), Buffer.from(r.data, 'base64')); };
const before = REHEARSAL ? 1 : balance; let exitCode = 1;
try {
  const t = await browser.tab(`http://127.0.0.1:${port}/#t=${TOKEN}`, { width: 390, height: 844 }); await t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000); await sleep(900);
  const dataUrl = `data:${kind};base64,${bytes.toString('base64')}`; // read locally and injected into the app's own storage: it goes nowhere else
  await t.eval(`(async () => { const m = await import('/core/case.js'); const st = await import('/storage.js'); const T0 = new Date(); let c = m.newCase({ id: 'vision-live', name: '', now: T0 }); c = m.dispatch(c, { type: 'PHOTO', ref: 'p0', note: null }, T0); await st.putBlob('photo:vision-live.0', ${JSON.stringify(dataUrl)});
    const cases = {}; cases[c.id] = c; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.current', JSON.stringify(c.id)); })()`);
  await t.eval('location.reload()'); await t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000); await sleep(1200);
  await t.eval(`(() => { const b = document.createElement('button'); b.setAttribute('data-act', 'sl-embed'); b.setAttribute('data-key', 'market'); b.setAttribute('data-case', 'vision-live'); document.body.appendChild(b); b.click(); b.remove(); })()`); await sleep(700);
  await t.eval(`document.querySelector('.fm-thumb').click()`);
  await t.waitFor("/Votre accord est nécessaire|Résultat de la recherche|Aucun code-barres lisible|n.a pas pu être préparée/i.test(document.querySelector('#screen')?.innerText ?? '')", 60000); await sleep(500);
  let s = await text(t);
  if (/Résultat de la recherche/.test(s) && !/Votre accord est nécessaire/.test(s)) { console.log('\nA BARCODE was read locally on this photo: Vision is not needed and was NOT called. (A photo without barcode is required to test Vision.)'); await shot(t, 'barcode'); exitCode = 0; }
  else if (!/Votre accord est nécessaire/.test(s)) { console.log(`\nNo consent card was shown: ${s.slice(0, 300)}`); }
  else {
    const sha16 = s.match(/SHA-256\) : ([0-9a-f]{16})/)?.[1]; const size = s.match(/réduite à (\d+)×(\d+) px, (\d+) Ko/); await shot(t, 'consent');
    console.log(`\nNo barcode on this photo. Vision would receive ONE image: ${size ? `${size[1]}x${size[2]} px, ${size[3]} KB` : ''}; fingerprint (SHA-256, first 16 hex) = ${sha16}`);
    try { const prep = await t.eval(`import('/barcode-local.js').then((m) => m.prepareForUpload(${JSON.stringify(dataUrl)})).then((u) => JSON.stringify({ b64: u.imageBase64, sha: u.sha256 }))`); const u = JSON.parse(prep); const buf = Buffer.from(u.b64, 'base64'); const full = createHash('sha256').update(buf).digest('hex'); const dst = join(homedir(), '.nordla', 'test-photos', `prepared-${sha16}.jpg`); writeFileSync(dst, buf); console.log(`The EXACT bytes that would be sent are saved for you to open: ${dst} (sha-256 recomputed here: ${full.slice(0, 16)} ${full.startsWith(sha16) ? '= same as the consent card' : '!= MISMATCH'}; no EXIF: the image is re-encoded)`); } catch (e) { console.log('(could not save the prepared image: ' + String(e.message).slice(0, 80) + ')'); }
    console.log(`Cost ceiling: ${VISION_COST_PER_PHOTO_USD} USD (3 Vision features, after the free monthly allowance). Destination: Google Cloud Vision, United States.`);
    if (!AUTH || AUTH === true) { console.log(`\nDRY RUN: nothing was sent. To authorise THIS exact image, rerun with:  --authorize ${sha16}`); exitCode = 0; }
    else if (String(AUTH).toLowerCase().slice(0, 16) !== sha16 || (String(AUTH).length > 16 && String(AUTH).length !== 64)) { console.log(`\nSTOP: the authorised fingerprint (${AUTH}) does not match this image (${sha16}). Nothing was sent.`); exitCode = 4; }
    else {
      if (String(AUTH).length === 64) { const u = JSON.parse(await t.eval(`import('/barcode-local.js').then((m) => m.prepareForUpload(${JSON.stringify(dataUrl)})).then((u) => JSON.stringify({ sha: u.sha256 }))`)); if (u.sha.toLowerCase() !== String(AUTH).toLowerCase()) { console.log(`
STOP: the FULL fingerprint authorised (${String(AUTH).slice(0, 16)}...) does not match the image to be sent (${u.sha.slice(0, 16)}...). Nothing was sent.`); exitCode = 4; throw Object.assign(new Error('full fingerprint mismatch'), { handled: true }); } console.log('Full SHA-256 verified against the authorisation: ' + u.sha); }
      if (!REHEARSAL) writeFileSync(usageFile, JSON.stringify({ date: today, count: usage.count + 1 })); authorizedNow = true; console.log(`\nAUTHORISED by the owner for fingerprint ${sha16}: sending (today: ${usage.count + 1}/${DAILY_MAX})...`);
      const t0 = Date.now(); await t.eval(`document.querySelector('[data-act="market-photo-send"]').click()`);
      await t.waitFor("/Résultat de la recherche|À confirmer \\(une touche\\)|rien reconnu de fiable|Rien n.a été modifié/i.test(document.querySelector('#screen')?.innerText ?? '')", 120000); await sleep(600);
      s = await text(t); if (/À confirmer \(une touche\)/.test(s)) { await shot(t, 'confirm'); console.log('Vision proposed only a category-level guess (LOW confidence): the app asks for a one-tap confirmation before searching.'); await t.eval(`document.querySelector('[data-act="market-photo-go"]').click()`); await t.waitFor("/Résultat de la recherche|Rien n.a été modifié/i.test(document.querySelector('#screen')?.innerText ?? '')", 120000); await sleep(600); s = await text(t); console.log('(the confirmation tap was made by this script ONLY because the owner authorised the search for this photo)'); }
      await shot(t, 'result'); const store = JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases')")); const rec = store['vision-live'].marketSearches?.[0]; console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)} s. Vision calls: ${calls.vision}; DataForSEO tasks: ${calls.dfs}.`);
      if (!rec) console.log('NO SEARCH RESULT STORED. Screen:', s.slice(0, 600));
      else { const i = rec.radar.identification; console.log(`RECOGNISED (machine proposal, to confirm): source ${i.source}, confidence ${i.confidence}`); console.log(`  best guess: ${JSON.stringify(i.bestGuess)}; logos: ${JSON.stringify(i.logos)}; models read: ${JSON.stringify(i.models)}; barcodes in text: ${JSON.stringify(i.eans)}`); console.log(`  entities: ${JSON.stringify((i.entities ?? []).map((e) => `${e.description} (${e.score})`))}`); console.log(`  text read (start): ${JSON.stringify((i.ocrText ?? '').slice(0, 160))}`);
        const r = rec.radar; console.log(`SEARCH: queries ${JSON.stringify(r.queries.map((q) => q.text))}; observed ${r.observedAt}`); console.log(`  listings ${rec.evidence.length}: exact ${r.summary.exact}, probable ${r.summary.probable}, similar ${r.summary.similar}; excluded ${r.summary.excluded}; flags ${JSON.stringify(r.summary.flags)}`); console.log(`  reference ${JSON.stringify(r.reference)}; marketplaces ${JSON.stringify(r.marketplaces)}`);
        for (const e of rec.evidence.filter((x) => !x.specs.excluded).slice(0, 10)) console.log(`  - ${e.matchType.slice(0, 5)} | ${e.seller} | ${e.price ? e.price.amount + ' ' + e.price.currency : 'n/a'} | ${(e.specs.title ?? '').slice(0, 60)}`); }
      exitCode = rec ? 0 : 1; if (errs.length) console.log(`console errors: ${errs.length}`);
    }
  }
} finally {
  const after = REHEARSAL ? 1 : (await dfsBalance({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD })); console.log(`\nCOST: DataForSEO balance ${before} -> ${after} USD (spent ${before != null && after != null ? (before - after).toFixed(4) : '?'} USD). Vision: ${calls.vision} call(s), estimated ${(calls.vision * VISION_COST_PER_PHOTO_USD).toFixed(4)} USD at most (free monthly allowance not counted). No top-up path exists.${REHEARSAL ? ' (REHEARSAL: everything simulated)' : ''}`);
  try { await browser.close?.(); } catch { /* gone */ } try { await new Promise((r) => server.server.close(r)); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); process.exit(exitCode);
}
