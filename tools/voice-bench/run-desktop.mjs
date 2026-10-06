// Runs a bench page in the desktop Edge (Chromium) through the DevTools Protocol and prints its log. Desktop is NOT the target device: it only proves the engines run at all.
// usage: node tools/voice-bench/run-desktop.mjs "<path?query>" [timeoutSeconds]     e.g. "probe.html?auto&tag=probe-edge"
import { Browser, findBrowser } from '../../test/e2e/cdp.js';
const path = process.argv[2] ?? 'probe.html?auto&tag=probe-edge'; const timeout = Number(process.argv[3] ?? 600) * 1000; const base = process.env.VB_BASE ?? 'http://127.0.0.1:8801';
const exe = findBrowser(); if (!exe) { console.log('no Chromium browser found'); process.exit(2); }
const b = await new Browser(exe).launch(); const t = await b.tab(`${base}/${path}`, { width: 1200, height: 900 });
const errs = []; b.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
try { await t.waitFor("/^DONE/.test(document.getElementById('st')?.textContent ?? '')", timeout); } catch (e) { console.log('TIMEOUT', e.message); }
console.log(await t.eval("document.getElementById('log').textContent")); if (errs.length) console.log('UNCAUGHT:', errs.join(' | '));
console.log('status:', await t.eval("document.getElementById('st').textContent")); await b.close(); process.exit(0);
