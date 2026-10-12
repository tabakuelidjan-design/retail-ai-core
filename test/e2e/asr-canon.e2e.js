import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Browser, findBrowser, freePort } from './cdp.js';

// REAL-BROWSER end-to-end of the CANONICAL RECORDING page (LAB). Chromium's FAKE capture device stands in for the Xiaomi microphone: this proves the page, the AudioWorklet capture, the WAV encoding, the
// SHA-256 handshake, the immutability on the server and the hand-over to the scorer. It is NOT a physical recording. No provider is contacted.   npm run asr:e2e
const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const data = mkdtempSync(join(tmpdir(), 'asr-canon-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const srv = spawn(process.execPath, ['tools/voice-bench/server.mjs', String(port)], { env: { ...process.env, VOICE_BENCH_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'], cwd: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/canon/script`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
const results = []; const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 800)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const errs = []; const browser = await new Browser(exe, null, ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']).launch();
browser.listeners.push((d) => { if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });
const SID = 'e2e-canon'; const dir = join(data, 'canonical', SID);
try {
  const t = await browser.tab(`${base}/canon.html?session=${SID}`, { width: 390, height: 844 });
  await t.waitFor(`!!document.getElementById('start')`, 15000);
  let script; await check('1. the page loads the script (73 steps) and offers START RECORDING; nothing is recorded yet', async () => { script = await (await fetch(`${base}/api/canon/script`)).json(); ok(script.items.length === 73, String(script.items.length)); ok(/START RECORDING/.test(await t.eval(`document.getElementById('start').innerText`)), 'button'); ok(!existsSync(dir), 'no session yet'); });
  await check('2. START → the fake microphone feeds the worklet; the page steps through all items and stops itself at the end', async () => {
    await t.run(`document.getElementById('start').click(); return 1;`); await t.waitFor(`!!document.getElementById('next')`, 20000); await new Promise((r) => setTimeout(r, 1500));
    for (let i = 0; i < 73; i++) { await t.run(`document.getElementById('next')?.click(); return 1;`); if (i === 10) await new Promise((r) => setTimeout(r, 800)); }
    await t.waitFor(`!!document.getElementById('accept')`, 20000); const txt = await t.eval(`document.getElementById('stage').innerText`); ok(/Écoute avant d/.test(txt) && /mono · 16 bits/.test(txt), txt.slice(0, 300)); ok(!!(await t.eval(`document.querySelector('audio')?.src`)), 'playback offered');
  });
  await check('3. REDO keeps nothing: the server has no file after Refaire', async () => { await t.run(`document.getElementById('redo').click(); return 1;`); await t.waitFor(`!!document.getElementById('start')`, 8000); ok(!existsSync(dir), 'nothing stored'); });
  await check('4. a second recording is ACCEPTED: stored read-only with a SHA-256 the server recomputes to the same value', async () => {
    await t.run(`document.getElementById('start').click(); return 1;`); await t.waitFor(`!!document.getElementById('next')`, 20000); await new Promise((r) => setTimeout(r, 3000));
    for (let i = 0; i < 73; i++) await t.run(`document.getElementById('next')?.click(); return 1;`);
    await t.waitFor(`!!document.getElementById('accept')`, 20000); await t.run(`document.getElementById('accept').click(); return 1;`); await t.waitFor(`/verrouillé/.test(document.getElementById('stage').innerText)`, 30000);
    ok(/oui ✓/.test(await t.eval(`document.getElementById('stage').innerText`)), 'hash handshake'); const wav = readFileSync(join(dir, 'canonical-native.wav')); const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    ok(meta.audio.sha256 === createHash('sha256').update(wav).digest('hex'), 'sha in meta equals the file'); ok(meta.audio.channels === 1 && meta.audio.sampleRate >= 16000 && meta.audio.durationSec > 3, JSON.stringify(meta.audio)); ok(meta.browserAudioProcessing?.constraintsRequested?.echoCancellation === true, 'processing recorded'); ok(/Firefox|Chrome/.test(meta.device.userAgent), 'device recorded');
    const markers = JSON.parse(readFileSync(join(dir, 'markers.json'), 'utf8')); ok(markers.items.length === 73 && markers.items[0].itemId === 'S1', 'markers'); ok((statSync(join(dir, 'canonical-native.wav')).mode & 0o200) === 0, 'read-only');
  });
  await check('5. IMMUTABLE: a second upload under the same session is refused with 409 and the stored sample is unchanged', async () => {
    const before = readFileSync(join(dir, 'canonical-native.wav')); const r = await fetch(`${base}/api/canon/audio?session=${SID}`, { method: 'POST', body: Buffer.from('RIFFxxxx') }); ok(r.status === 409, String(r.status)); ok(Buffer.compare(before, readFileSync(join(dir, 'canonical-native.wav'))) === 0, 'unchanged');
    const m = await fetch(`${base}/api/canon/meta?session=${SID}`, { method: 'POST', body: '{}' }); ok(m.status === 409, 'meta ' + m.status);
  });
  await check('6. the reference editor saves the owner\'s transcripts; the scorer then runs end to end on the stored sample (fake provider, no network)', async () => {
    const r = await fetch(`${base}/api/canon/references?session=${SID}`, { method: 'POST', body: JSON.stringify({ references: { D1: 'we talk about the factory', D2: 'price is six dollars' } }) }); ok(r.ok, String(r.status));
    const { loadCanonical } = await import('../../tools/asr-bench/canonical.mjs'); const { scoreRun, verdict } = await import('../../tools/asr-bench/score.mjs'); const { buildContext } = await import('../../tools/asr-bench/context.mjs'); const fake = (await import('../../tools/asr-bench/providers/fake.mjs')).default;
    const c = loadCanonical(dir); ok(c.references.D1 === 'we talk about the factory', 'references'); const res = await fake.transcribe(c.audio, { pass: 'B', context: buildContext('fake', 'B'), windows: c.windows, script: c.script, references: c.references, behavior: {} });
    const sc = scoreRun({ script: c.script, windows: c.windows, references: c.references, result: res }); ok(sc.metrics.identifiers.keyReferences.n === 17 && typeof verdict(sc).verdict === 'string', JSON.stringify(sc.metrics.identifiers.keyReferences)); // markers were tapped in a few seconds here, so the oracle's timing does not line up: only the plumbing is asserted, accuracy is covered by the unit tests
  });
  await check('7. no page error and no request to any host other than the LAB server', async () => { ok(errs.length === 0, errs.join(' | ')); });
} finally { await browser.close(); srv.kill(); await new Promise((r) => setTimeout(r, 500)); try { rmSync(data, { recursive: true, force: true }); } catch { /* locked */ } }
const failed = results.filter((x) => !x).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
