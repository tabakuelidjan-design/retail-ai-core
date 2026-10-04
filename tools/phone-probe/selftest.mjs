// Self-test of the phone probe in a REAL Chromium engine (Edge/Chrome headless). The ONLY simulated thing is the microphone: headless has no audio device, so getUserMedia is replaced
// by a generated tone track (MediaStreamTrackGenerator). MediaRecorder, IndexedDB, the service worker and the page are real. This is NOT the phone: it proves the probe works before it is sent
// to the phone. Run:  node tools/phone-probe/selftest.mjs
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { startProbe } from './server.js';
import { Browser, findBrowser } from '../../test/e2e/cdp.js';

const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER)'); process.exit(2); }
const dir = mkdtempSync(join(tmpdir(), 'probe-selftest-')); const results = join(dir, 'results.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = () => (existsSync(results) ? readFileSync(results, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const out = []; const check = async (n, fn) => { try { await fn(); out.push(true); console.log(`PASS  ${n}`); } catch (e) { out.push(false); console.log(`FAIL  ${n}\n      ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const waitRow = async (step, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = rows().find((x) => x.step === step); if (r) return r; await sleep(200); } throw new Error(`no report "${step}" within ${ms} ms`); };

let probe = await startProbe({ resultsFile: results, log: () => {} }); const { token, port } = probe;
const b = await new Browser(exe).launch(); const errs = [];
b.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
const t = await b.tab('about:blank', { width: 390, height: 844 });
const FAKE_MIC = `navigator.mediaDevices.getUserMedia = async () => { const gen = new MediaStreamTrackGenerator({ kind: 'audio' }); const w = gen.writable.getWriter(); let ts = 0; setInterval(() => { const n = 4800; const buf = new Float32Array(n); for (let i = 0; i < n; i++) buf[i] = Math.sin((ts + i) / 20) * 0.2; w.write(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round(ts / 48000 * 1e6), data: buf })); ts += n; }, 100); return new MediaStream([gen]); };`;
await b.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_MIC }, t.sessionId);
const base = `http://127.0.0.1:${port}`;

await check('1. page loads, token taken from the fragment and removed, environment report reaches the PC', async () => {
  await t.goto(`${base}/#t=${token}`); await t.waitFor('!!window.__probe && !!document.querySelector("#app button")', 15000);
  ok(await t.eval("location.hash === ''"), 'fragment must be removed'); const r = await waitRow('env'); ok(r.data.mediaRecorder === true && r.data.indexedDB === true, JSON.stringify(r.data).slice(0, 200));
  ok(!JSON.stringify(rows()).includes(token), 'the token must never be written to the results file');
});
await check('2. service worker caches the probe so it can reload offline', async () => { await t.waitFor('navigator.serviceWorker.ready.then(() => caches.keys()).then((k) => k.length > 0)', 15000); });
await check('3. microphone permission step reports granted with track settings', async () => { await t.run('await window.__probe.askMic(); return 1;'); const r = await waitRow('mic-permission'); ok(r.data.granted === true, JSON.stringify(r.data)); });
await check('4. record 3.5 s WHILE a re-render storm runs: chunks stored every second, no gap, storm did not stop the recorder', async () => {
  await t.run('window.__probe.startStorm(); await window.__probe.startRec(); await new Promise((r) => setTimeout(r, 3600)); window.__probe.stopRec(); return 1;');
  const r = await waitRow('record-online'); const d = r.data;
  ok(d.bytes > 0 && d.chunks >= 3, `bytes ${d.bytes} chunks ${d.chunks}`); ok(d.maxGapMs < 3000, `gap ${d.maxGapMs}`); ok(d.stormTicksDuringRecording >= 5, `storm ticks ${d.stormTicksDuringRecording}`); ok(d.verdict === 'CLEAN', d.verdict);
  console.log(`      mime=${d.mime} bytes=${d.bytes} ms=${d.durationMs} kb/min=${d.kbPerMinute}`);
  await t.run('window.__probe.stopStorm(); return 1;');
});
await check('5. the recording is kept in IndexedDB and plays back (loadedmetadata, no error)', async () => {
  await t.run('await window.__probe.loadList(); return 1;'); ok((await t.eval('window.__probe.state().recs')) === 1, 'one saved recording');
  await t.run("document.querySelector('[data-act=play]').click(); return 1;"); await t.waitFor("document.querySelector('#aud') && document.querySelector('#aud').readyState >= 1 && !document.querySelector('#aud').error", 8000);
});
await check('6. RELOAD: the recording is recovered from storage', async () => { await t.goto(`${base}/`); await t.waitFor('!!window.__probe && window.__probe.state().recs === 1', 15000); });
await check('7. server stopped + browser offline: page reloads from the cache, recording works offline, results wait in the queue', async () => {
  await probe.stop(); await t.offline(true); await t.goto(`${base}/`); await t.waitFor('!!window.__probe && !!document.querySelector("#app button")', 15000);
  ok((await t.eval('document.body.innerText')).includes('OFFLINE'), 'offline indicator');
  await t.run('await window.__probe.startRec(); await new Promise((r) => setTimeout(r, 2600)); window.__probe.stopRec(); await new Promise((r) => setTimeout(r, 800)); return 1;');
  await t.waitFor('window.__probe.state().recs === 2', 8000); ok(!rows().some((r) => r.step === 'record-offline'), 'must not be delivered while the server is unreachable');
});
await check('8. network + server return: the queued offline results are delivered, nothing lost', async () => {
  probe = await startProbe({ resultsFile: results, token, port, log: () => {} }); await t.offline(false);
  await t.run("window.dispatchEvent(new Event('online')); return 1;"); const r = await waitRow('record-offline', 15000); ok(r.data.startedOnline === false && r.data.bytes > 0, JSON.stringify(r.data).slice(0, 160));
  await waitRow('reconnect', 10000);
});
await check('9. 5 MB storage write test reports ok and removes its data', async () => { await t.run('await window.__probe.storageWrite(5); return 1;'); const r = await waitRow('storage-write-5MB'); ok(r.data.ok === true && r.data.writtenMB === 5, JSON.stringify(r.data).slice(0, 200)); });
await check('10. server refuses a missing/wrong token (401) and a foreign Host (421)', async () => {
  const call = (headers, p = '/report') => new Promise((res) => { const q = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (r) => { r.resume(); res(r.statusCode); }); q.end('{"step":"x"}'); });
  ok((await call({})) === 401, 'no token'); ok((await call({ 'x-probe-token': 'wrong' })) === 401, 'wrong token'); ok((await call({ 'x-probe-token': token, host: 'evil.example' })) === 421, 'host check');
});
await check('11. delete-all removes every test recording; no uncaught page errors during the whole run', async () => { await t.run('await window.__probe.deleteAll(); return 1;'); ok((await t.eval('window.__probe.state().recs')) === 0, 'cleared'); ok(errs.length === 0, errs.join(' | ')); });

await b.close(); await probe.stop(); rmSync(dir, { recursive: true, force: true });
console.log(`\n${out.filter(Boolean).length}/${out.length} passed`); process.exit(out.every(Boolean) ? 0 : 1);
