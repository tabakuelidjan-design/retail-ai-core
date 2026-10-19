// LIVE DEMO (manual, NOT part of CI, spends the real trial credit): the real server route with the REAL DataForSEO provider; credentials come from the .nordla env file and are never printed.
// Market radar on a phone-sized REAL browser engine (Chrome / Edge through the DevTools Protocol; NOT a physical phone), with a SIMULATED search provider behind the real server route: the product sheet,
// "Rechercher les prix en Europe", the listings (seller, price, source, date, honest link), Amazon.be / bol.com checked separately, flags kept visible, evidence stored in the case, error and offline behaviour.
//   node test/e2e/sourcing-market-radar.e2e.js        (SOURCING_E2E_SHOTS=<dir> for screenshots)
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { createMarketRadar } from '../../src/sourcing/server/market-radar-service.js';
import { loadEnv } from '../../tools/market-proof/lib.mjs';
import { dfsBalance } from '../../src/sourcing/adapters/market-dataforseo.js';
import { fetchEcb } from '../../src/sourcing/adapters/fx.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const TOKEN = 'market-radar-token-0123456789-abcdef'; const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 900)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const env = loadEnv(); if (!(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD)) { console.log('NO CREDENTIALS: nothing was run.'); process.exit(2); }
const before = await dfsBalance({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD });
const dir = mkdtempSync(join(tmpdir(), 'nordla-radar-live-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const market = createMarketRadar({ env: { DATAFORSEO_LOGIN: env.DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD: env.DATAFORSEO_PASSWORD, MARKET_MAX_COST_USD: '0.05', MARKET_DAILY_MAX: '3' }, ecb: () => fetchEcb() });
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => { throw new Error('no network'); }, ecb: () => fetchEcb(), services: { market } });
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
  await t.eval(`(async () => { const m = await import('/core/case.js'); const T0 = new Date(); const at = (k) => new Date(T0.getTime() + k * 60000);
    let c = m.newCase({ id: 'radar-live', name: 'Stanley Quencher H2.0 FlowState Tumbler 1.18L', now: T0 }); c = m.dispatch(c, { type: 'SUPPLIER', supplier: { name: 'TEST - produit du commerce, pas un vrai fournisseur' } }, at(0)); c = m.dispatch(c, { type: 'IDENTIFIER', name: 'brand', value: 'Stanley', source: { kind: 'OWNER' } }, at(1)); c = m.dispatch(c, { type: 'QUOTE', quote: { unitPrice: '11', currency: 'USD' } }, at(2));
    const cases = {}; cases[c.id] = c; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.current', JSON.stringify(c.id)); })()`); await sleep(400);
  await t.eval('location.reload()'); await ready(t); await sleep(1200);
  await openMarket(t, 'radar-live'); await shot(t, 'live-before');
  const t0 = Date.now(); await clickRun(t, 500);
  await t.waitFor("!!document.querySelector('.fm-rbig') || /Pas de connexion|configurée|échoué|insuffisant|limite|refuse|erreur|Aucune annonce fiable/i.test(document.querySelector('#screen').innerText)", 120000);
  const secs = Math.round((Date.now() - t0) / 1000); await sleep(600); const s = await text(t); await shot(t, 'live-result');
  const c = (await store(t))['radar-live']; const rec = (c.marketSearches ?? [])[0];
  try { const { writeFileSync: w, mkdirSync: mk } = await import('node:fs'); const { homedir } = await import('node:os'); const d = join(homedir(), '.nordla', 'market-proof-out'); mk(d, { recursive: true }); w(join(d, `live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(rec ?? null, null, 1)); } catch { /* optional */ }
  console.log(`LIVE search: ${secs} s on the phone-sized screen; stored evidence: ${rec?.evidence?.length ?? 0} listing(s), status ${rec?.status ?? 'none'}, cached=${rec?.radar?.cached}`);
  if (!rec) console.log('SCREEN:', s.slice(0, 700));
  else {
    console.log(`observed ${rec.radar.observedAt}; queries ${JSON.stringify(rec.radar.queries.map((q) => q.text))}`); console.log(`classes: exact ${rec.radar.summary.exact}, probable ${rec.radar.summary.probable}, similar ${rec.radar.summary.similar}; excluded ${rec.radar.summary.excluded}; flags ${JSON.stringify(rec.radar.summary.flags)}`);
    console.log(`reference: ${JSON.stringify(rec.radar.reference)}`); console.log(`marketplaces: ${JSON.stringify(rec.radar.marketplaces)}; comparison: ${rec.radar.comparison.note}`);
    for (const e of rec.evidence) console.log(`- ${e.specs.excluded ? '[ecartee] ' : ''}${e.matchType.slice(0, 5)} | ${e.seller} | ${e.price ? e.price.amount + ' ' + e.price.currency : 'n/a'} | ${(e.specs.title ?? '').slice(0, 60)} | ${e.specs.flags.join(',') || '-'} | ${e.specs.linkKind} | ${e.url.slice(0, 60)}`);
  }
  await check('LIVE: real listings displayed with price, seller, date and an honest link; no uncaught error', async () => { ok(rec?.status === 'DONE' && rec.evidence.length > 0, 'no real result'); ok(/Résultat de la recherche/.test(s) && /relevé le/i.test(s), 'screen'); ok(errs.length === 0, errs.join('|').slice(0, 300)); ok(!JSON.stringify(c).includes(env.DATAFORSEO_PASSWORD), 'no credential in the case'); });
} finally {
  const after = await dfsBalance({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD });
  console.log(`balance before ${before} USD, after ${after} USD, spent ${before != null && after != null ? (before - after).toFixed(4) : '?'} USD; no top-up path exists`);
  try { await browser.close?.(); } catch { /* gone */ } try { await new Promise((r) => server.server.close(r)); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true });
  const passed = results.filter(Boolean).length; console.log(`${passed}/${results.length} passed`); process.exit(passed === results.length ? 0 : 1);
}
