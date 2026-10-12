// Plumbing self-test of the comparison harness in desktop Edge/Chrome: synthetic prompts through the SAME pipeline, real-time pace. NOT a field result.   node tools/voice-bench/run-compare-selftest.mjs [port]
import { Browser, findBrowser } from '../../test/e2e/cdp.js';
const port = Number(process.argv[2] || 8801); const b = await new Browser(findBrowser()).launch(); const t = await b.tab(`http://127.0.0.1:${port}/compare.html?selftest=1&auto=1&session=fc-selftest`);
const logs = []; b.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text)); });
try { await t.waitFor('!!window.__result', 600000); console.log('selftest DONE'); } catch (e) { console.log('selftest did not finish:', e.message, logs.slice(0, 3)); console.log(await t.eval("document.getElementById('log').textContent.slice(-1500)")); }
await b.close(); process.exit(0);
