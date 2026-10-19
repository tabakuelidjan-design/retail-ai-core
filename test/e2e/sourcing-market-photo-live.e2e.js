// LIVE DEMO (manual, NOT part of CI; spends the real DataForSEO trial credit; sends NO photo anywhere and never calls Google Vision): a barcode image DRAWN BY THIS SCRIPT (synthetic, labelled as such) is attached to a case as its photo;
// the phone-sized app reads the barcode LOCALLY (real decoding), then the real server route runs a REAL DataForSEO Google Shopping search on that GTIN and the results appear in the case.
// Credentials come from the .nordla env file and are never printed.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { createMarketRadar } from '../../src/sourcing/server/market-radar-service.js';
import { loadEnv } from '../../tools/market-proof/lib.mjs';
import { dfsBalance } from '../../src/sourcing/adapters/market-dataforseo.js';
import { fetchEcb } from '../../src/sourcing/adapters/fx.js';
import { Browser, findBrowser, freePort } from './cdp.js';

const GTIN = process.env.LIVE_GTIN || '3017620422003'; // a real, widely sold consumer product (Nutella 400 g): the IMAGE is synthetic, the reading and the search are real
const exe = findBrowser() ?? (process.env.SOURCING_E2E_BROWSER || null); if (!exe) { console.log('NO BROWSER'); process.exit(2); }
const env = loadEnv(); if (!(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD)) { console.log('NO CREDENTIALS: nothing was run.'); process.exit(2); }
const SHOTS = process.env.SOURCING_E2E_SHOTS || null; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const TOKEN = 'live-photo-token-0123456789-abcdef';
const before = await dfsBalance({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD });
const visionCalls = []; const radar = createMarketRadar({ env: { DATAFORSEO_LOGIN: env.DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD: env.DATAFORSEO_PASSWORD, MARKET_MAX_COST_USD: '0.05', MARKET_DAILY_MAX: '3' }, ecb: () => fetchEcb(), fetchImpl: async (u, o) => { if (String(u).includes('vision.googleapis.com')) { visionCalls.push(u); throw new Error('Vision must never be called in this demo'); } return fetch(u, o); } });
const dir = mkdtempSync(join(tmpdir(), 'nordla-photo-live-')); const port = await freePort();
const server = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port, dir, fetchImpl: async () => { throw new Error('no network'); }, ecb: () => fetchEcb(), services: { market: radar } });
const browser = await new Browser(exe, null, process.getuid?.() === 0 ? ['--no-sandbox'] : []).launch(); const errs = []; browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? ''); });
const text = (t) => t.eval(`document.querySelector('#screen')?.innerText ?? ''`);
let n = 0; const shot = async (t, name) => { if (!SHOTS) return; await sleep(300); const r = await browser.send('Page.captureScreenshot', { format: 'png' }, t.sessionId); writeFileSync(join(SHOTS, `${++n}-${name}.png`), Buffer.from(r.data, 'base64')); };
let ok = false;
try {
  const t = await browser.tab(`http://127.0.0.1:${port}/#t=${TOKEN}`, { width: 390, height: 844 }); await t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000); await sleep(900);
  await t.eval(`(async () => { const m = await import('/core/case.js'); const st = await import('/storage.js'); const T0 = new Date();
    const Lc=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'],Gc=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'],Rc=['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];const PAR=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
    const mod=(d)=>{const p=PAR[+d[0]];let mm='101';for(let i=0;i<6;i++)mm+=(p[i]==='L'?Lc:Gc)[+d[1+i]];mm+='01010';for(let i=0;i<6;i++)mm+=Rc[+d[7+i]];return mm+'101';};
    const d=${JSON.stringify(GTIN)},scale=4,mm=mod(d);const c0=document.createElement('canvas');c0.width=(mm.length+30)*scale;c0.height=300;const x=c0.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c0.width,c0.height);x.fillStyle='#000';for(let i=0;i<mm.length;i++)if(mm[i]==='1')x.fillRect((15+i)*scale,20,scale,200);x.font='28px monospace';x.fillText(d+'   (image synthétique de test)',60,270);
    let c = m.newCase({ id: 'photo-live', name: '', now: T0 }); c = m.dispatch(c, { type: 'PHOTO', ref: 'p0', note: null }, T0); await st.putBlob('photo:photo-live.0', c0.toDataURL('image/png'));
    const cases = {}; cases[c.id] = c; localStorage.setItem('nordla.sourcing.cases', JSON.stringify(cases)); localStorage.setItem('nordla.sourcing.current', JSON.stringify(c.id)); })()`);
  await t.eval('location.reload()'); await t.waitFor("document.readyState === 'complete' && document.querySelector('#screen')?.innerText.length > 20", 20000); await sleep(1200);
  await t.eval(`(() => { const b = document.createElement('button'); b.setAttribute('data-act', 'sl-embed'); b.setAttribute('data-key', 'market'); b.setAttribute('data-case', 'photo-live'); document.body.appendChild(b); b.click(); b.remove(); })()`); await sleep(700); await shot(t, 'before');
  const t0 = Date.now(); await t.eval(`document.querySelector('.fm-thumb').click()`);
  await t.waitFor("!!document.querySelector('.fm-rbig') || /Aucune annonce fiable|Pas de connexion|échoué|insuffisant|limite|refuse|Aucun code-barres/i.test(document.querySelector('#screen').innerText)", 120000); await sleep(600); await shot(t, 'result');
  const store = JSON.parse(await t.eval("localStorage.getItem('nordla.sourcing.cases')")); const rec = store['photo-live'].marketSearches?.[0];
  console.log(`LIVE (photo -> local barcode -> real search): ${Math.round((Date.now() - t0) / 1000)} s; Vision calls: ${visionCalls.length}`);
  console.log(`barcode read: ${rec?.radar?.identification?.eans?.[0]} (engine ${rec?.radar?.identification?.engine}, photo sent: ${rec?.radar?.identification?.photo?.sentToProvider}); queries ${JSON.stringify(rec?.radar?.queries?.map((q) => q.text))}`);
  if (rec) { const r = rec.radar; console.log(`observed ${r.observedAt}; classes exact ${r.summary.exact}, probable ${r.summary.probable}, similar ${r.summary.similar}; excluded ${r.summary.excluded}; flags ${JSON.stringify(r.summary.flags)}`); console.log(`reference ${JSON.stringify(r.reference)}; marketplaces ${JSON.stringify(r.marketplaces)}`);
    for (const e of rec.evidence.slice(0, 12)) console.log(`- ${e.specs.excluded ? '[ecartee] ' : ''}${e.matchType.slice(0, 5)} | ${e.seller} | ${e.price ? e.price.amount + ' ' + e.price.currency : 'n/a'} | ${(e.specs.title ?? '').slice(0, 58)} | ${e.specs.linkKind}`); } else console.log('SCREEN:', (await text(t)).slice(0, 500));
  ok = !!rec && rec.evidence.length > 0 && visionCalls.length === 0 && rec.radar.identification?.source === 'LOCAL_BARCODE' && errs.length === 0; console.log(ok ? 'PASS  LIVE photo demo' : 'FAIL  LIVE photo demo');
} finally {
  const after = await dfsBalance({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD }); console.log(`balance before ${before} USD, after ${after} USD, spent ${before != null && after != null ? (before - after).toFixed(4) : '?'} USD; no top-up path exists`);
  try { await browser.close?.(); } catch { /* gone */ } try { await new Promise((r) => server.server.close(r)); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); process.exit(ok ? 0 : 1);
}
