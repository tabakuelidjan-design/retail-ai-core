// OPTIONAL, manual: the same path the owner's phone uses, through a REAL Cloudflare quick tunnel, with a throw-away server (temp folder, random test token, no owner data).
// It exposes that test server publicly for about a minute: run it only when you accept that. Needs cloudflared and Edge / Chrome. Exit code 2 = a prerequisite is missing (nothing was run).
//   npm run sourcing:e2e:tunnel
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startPhoneMode } from '../../src/sourcing/server/phone.js';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser } from './cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND: set SOURCING_E2E_BROWSER. Nothing was run.'); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), 'nordla-tunnel-')); const TOKEN = randomBytes(24).toString('hex');
const IDX = '<?xml version="1.0"?><Safety-Gate><weeklyReport><reference>Report-2026-39</reference><publicationDate>02/10/2026</publicationDate><URL>https://x.test/api/download/weeklyReport/detail/xml/10000325?language=en,</URL></weeklyReport></Safety-Gate>';
const REP = '<?xml version="1.0"?><alerts><alert><caseNumber>SR/00001/26</caseNumber><category>Toys</category><product>Doll</product><riskType>Choking</riskType><countryOfOrigin>China</countryOfOrigin></alert></alerts>';
const fetchImpl = async (u) => ({ ok: true, status: 200, text: async () => (/list\/xml/.test(u) ? IDX : REP) });
const r = await startPhoneMode({ env: { SOURCING_TOKEN: TOKEN }, log: () => {}, port: 0, startServer: (o) => startSourcingServer({ ...o, dir, port: 0, fetchImpl, ecb: async () => ({ date: '2026-10-04', perEur: { USD: 1.08 } }) }) });
if (!r.tunnel) { console.log(`NO TUNNEL (${r.reason}). Nothing was exposed.`); await r.stop(); rmSync(dir, { recursive: true, force: true }); process.exit(2); }
let code = 1; const b = await new Browser(exe).launch();
try {
  const t = await b.tab('about:blank'); const api = []; b.listeners.push((d) => { if (d.method === 'Network.responseReceived' && /\/api\//.test(d.params.response.url)) api.push(`${d.params.response.status} ${d.params.response.url.replace(/^https:\/\/[^/]+/, '')}`); });
  await t.goto(r.tunnel.link);
  await t.waitFor("window.nordlaSourcing?.state().server === 'VERIFIED'", 60000);
  const mode = await t.eval("document.querySelector('#mode').innerText"); const bar = await t.waitFor("/SAFETY GATE (LIVE|CACHED)/.test(document.querySelector('#statusbar').innerText) ? document.querySelector('#statusbar').innerText : ''", 30000);
  const hashGone = await t.eval("location.hash === ''"); const sw = await t.eval("navigator.serviceWorker.ready.then(() => 'active')");
  console.log(`tunnel host: ${new URL(r.tunnel.url).hostname}\nheader: ${mode}\nstatus line: ${bar}\nfragment removed: ${hashGone}\nservice worker: ${sw}\napi calls: ${api.join(', ')}`);
  code = mode === 'SERVER VERIFIED' && /SAFETY GATE LIVE/.test(bar) && hashGone && api.every((x) => x.startsWith('200')) ? 0 : 1; console.log(code === 0 ? 'PASS' : 'FAIL');
} catch (e) { console.log(`FAIL: ${e.message}`); } finally { await b.close(); await r.stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(code);
