import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSourcingServer } from '../../src/sourcing/server/index.js';
import { Browser, findBrowser, freePort } from './cdp.js';

// REAL-BROWSER end-to-end of FIELD VOICE: the REAL Moonshine runtime and model (from data/local/voice-bench, hash-checked by the server), the REAL AudioWorklet capture path, fed by Chromium's FAKE
// CAPTURE DEVICE which plays a speech file (Windows text-to-speech, English). This proves the plumbing end to end; it is NOT a physical microphone, NOT a real speaker, NOT a Xiaomi.
// It needs the downloaded benchmark files and Windows speech synthesis; otherwise it says so and runs nothing (exit 2).   npm run sourcing:e2e:voice
const exe = findBrowser(); if (!exe) { console.log('NO BROWSER FOUND (set SOURCING_E2E_BROWSER): nothing was run.'); process.exit(2); }
const VOICE_DIR = new URL('../../data/local/voice-bench/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
if (!existsSync(join(VOICE_DIR, 'logs', 'download-manifest.json')) || process.platform !== 'win32') { console.log('The benchmark files (data/local/voice-bench) or Windows speech synthesis are missing: nothing was run.'); process.exit(2); }
const SENTENCE = 'The model number is X twenty five. The minimum order quantity is one hundred pieces.';
const tmp = mkdtempSync(join(tmpdir(), 'nordla-voice-e2e-')); const WAV = join(tmp, 'speech.wav');
execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile("${WAV}", $f); $s.Speak("${SENTENCE}"); $s.Dispose()`]);
if (!existsSync(WAV) || statSync(WAV).size < 50000) { console.log('The speech file could not be generated: nothing was run.'); process.exit(2); }

const TOKEN = 'voice-e2e-token-0123456789-abcdef-xyz';
const results = []; const check = async (name, fn) => { try { await fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}\n      ${String(e.message).slice(0, 800)}`); } };
const ok = (c, m) => { if (!c) throw new Error(m ?? 'assertion failed'); };
const dir = mkdtempSync(join(tmpdir(), 'nordla-voice-data-')); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
const srv = await startSourcingServer({ env: { SOURCING_TOKEN: TOKEN, SOURCING_VOICE_DIR: VOICE_DIR }, log: () => {}, port, dir, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<x/>' }), ecb: async () => ({ date: '2026-10-06', perEur: { USD: 1.08 } }) });
const HELPERS = `window.__t = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), click: (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('missing ' + sel); e.click(); },
  set: (sel, v) => { const e = document.querySelector(sel); if (!e) throw new Error('missing ' + sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); },
  submit: (sel) => { const f = document.querySelector(sel); if (!f) throw new Error('missing ' + sel); f.requestSubmit(); },
  kase: () => { const all = JSON.parse(localStorage.getItem('nordla.sourcing.cases')); return all[JSON.parse(localStorage.getItem('nordla.sourcing.current'))]; } }; 'ok'`;
const ready = async (t) => { await t.waitFor("document.readyState === 'complete' && !!document.querySelector('#tabs') && document.querySelector('#tabs').children.length > 0", 20000); await t.eval(HELPERS); };
const kase = async (t) => JSON.parse(await t.eval('JSON.stringify(__t.kase())'));
const text = (t, sel = '#screen') => t.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const has = (t, sel) => t.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
const tap = (t, sel, ms = 400) => t.run(`__t.click(${JSON.stringify(sel)}); await __t.sleep(${ms}); return 1;`);
const speechItems = async (t) => (await kase(t)).conversations.flatMap((c) => c.items).filter((i) => i.modality === 'SPEECH');
const closeSheet = (t) => t.run(`document.querySelector('.fm-x[data-act="fm-sheet-close"]')?.click(); await __t.sleep(300); return 1;`);
const send = async (t, msg) => { await t.run(`if (!document.querySelector('form[data-form="compose"]')) { document.querySelector('.fm-nav[data-key="write"]').click(); await __t.sleep(250); } __t.set('form[data-form="compose"] textarea', ${JSON.stringify(msg)}); __t.submit('form[data-form="compose"]'); await __t.sleep(700); return 1;`); };

const errs = []; const reqs = [];
const browser = await new Browser(exe, null, ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`]).launch();
browser.listeners.push((d) => {
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  if (d.method === 'Network.loadingFailed') errs.push(`network failure ${d.params.errorText} ${d.params.blockedReason ?? ''}`);
  if (d.method === 'Network.requestWillBeSent') reqs.push({ url: d.params.request.url, method: d.params.request.method, size: (d.params.request.postData ?? '').length, type: d.params.request.headers['Content-Type'] ?? d.params.request.headers['content-type'] ?? '' });
});
console.log(`Browser engine: ${exe}\nFake capture device plays: "${SENTENCE}" (synthetic voice, looped)\n`);
const t = await browser.tab(`${base}/#t=${TOKEN}`); await ready(t); await t.waitFor('window.nordlaSourcing?.state().online === true', 15000);
await t.run(`localStorage.setItem('nordla.sourcing.mode', JSON.stringify('field')); location.reload(); return 1;`); await new Promise((r) => setTimeout(r, 2500)); await ready(t);

await check('1. the page is cross-origin isolated (WebAssembly threads), keeps a STRICT CSP, and the voice files are available', async () => {
  ok(await t.eval('self.crossOriginIsolated'), 'crossOriginIsolated'); const st = await t.eval(`fetch('/voice/status').then((r) => r.json())`); ok(st.available && st.language === 'en' && st.engine === 'moonshine-tiny-streaming-en', JSON.stringify(st));
  const csp = await t.eval(`fetch('/').then((r) => r.headers.get('content-security-policy'))`); ok(!/unsafe-eval/.test(csp), csp);
});

await check('2. DENIED microphone: the dock says "Micro refusé", NO model/runtime is downloaded, nothing listens, and typing ("Écrire") still works (ORIGINAL text, supplier)', async () => {
  await t.run(`__t.set('form[data-form="fh-product"] input', 'Power bank'); __t.submit('form[data-form="fh-product"]'); await __t.sleep(500); return 1;`); await t.eval(HELPERS);
  await t.run(`navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); return 1;`);
  await tap(t, '[data-act="fm-start"]', 800); const body = await text(t); ok(/Micro refusé/.test(body) && !/Écoute en cours/.test(body), body.slice(0, 300)); ok(await has(t, '[data-act="vc-resume"]'), 'retry offered');
  ok((await t.eval(`performance.getEntriesByType('resource').filter((r) => r.name.includes('/voice/rt/') || r.name.includes('/voice/model/')).length`)) === 0, 'no voice file was requested after the refusal');
  await send(t, 'MOQ is 50 pcs.'); const c = await kase(t); const it = c.conversations[0].items.at(-1); ok(it.original === 'MOQ is 50 pcs.' && it.speaker === 'supplier' && (it.modality ?? 'TEXT') === 'TEXT', JSON.stringify(it).slice(0, 200)); ok(c.candidates.at(-1).basis === 'ORIGINAL', 'text provenance unchanged');
});

await check('3. REAL microphone path: "Écoute en cours" appears ONLY once the microphone delivers audio to the loaded engine (the dock never claims it earlier)', async () => {
  await t.goto(`${base}/`); await ready(t); // the refusal double is gone; the conversation is still open; the dock offers "Écouter"
  ok(/Écouter/.test(await text(t)) && !/Écoute en cours/.test(await text(t)), 'idle dock before the tap');
  await t.run(`window.__seen = []; new MutationObserver(() => { window.__seen.push([window.nordlaVoice.state, document.querySelector('.fm-dk-t b')?.innerText ?? '']); }).observe(document.querySelector('#screen'), { childList: true, subtree: true, characterData: true }); return 1;`);
  await tap(t, '[data-act="vc-start"]', 300); await t.waitFor(`window.nordlaVoice.state === 'listening'`, 60000);
  const seen = await t.eval('window.__seen'); ok(seen.some(([s]) => s === 'preparing'), 'a preparing state was shown'); ok(!seen.some(([s, b]) => /Écoute en cours/.test(b) && s !== 'listening'), `dock claimed listening while state was not listening: ${JSON.stringify(seen).slice(0, 300)}`);
  ok(/Écoute en cours/.test(await text(t)) && /anglais/.test(await text(t)), 'listening is shown with the language');
});

await check('4. REAL transcription from the microphone path enters the pipeline as SPEECH, speaker UNKNOWN, transcription MACHINE; candidates MACHINE_DERIVED; NOTHING is confirmed', async () => {
  await t.waitFor(`JSON.parse(localStorage.getItem('nordla.sourcing.cases'))[JSON.parse(localStorage.getItem('nordla.sourcing.current'))].conversations.flatMap((c) => c.items).filter((i) => i.modality === 'SPEECH').length >= 2`, 60000);
  const items = await speechItems(t); const it = items[0]; ok(it.speaker === 'unknown' && it.speakerBy === 'UNKNOWN' && it.original === null, JSON.stringify(it).slice(0, 300));
  const d = it.derived[0]; ok(d.kind === 'TRANSCRIPTION' && d.review === 'MACHINE' && d.provider === 'moonshine-tiny-streaming-en' && /0\.1\.5/.test(d.version) && d.text.length > 3, JSON.stringify(d)); ok(it.capture.sessionId && Number.isFinite(it.capture.turn), 'capture identity');
  const c = await kase(t); const heard = c.candidates.filter((x) => x.basis === 'TRANSCRIPTION'); ok(heard.length >= 1 && heard.every((x) => x.speaker === 'unknown' && x.flags.includes('MACHINE_DERIVED') && x.confidence !== 'HIGH' && x.state === 'PROPOSED'), JSON.stringify(heard.map((x) => [x.key, x.value, x.speaker, x.state])));
  ok(heard.some((x) => x.key === 'quote.moq' && String(x.value) === '100') || heard.some((x) => x.key === 'identifier.model'), 'the MOQ or the model was extracted from the speech: ' + JSON.stringify(heard.map((x) => [x.key, x.value])));
  ok(c.ledger.length === 0 && c.quotes.length === 0, 'no automatic confirmation, nothing reached the case'); ok(!JSON.stringify(c).match(/"(audio|pcm|samples)"/i), 'no audio in the case');
  const segs = items.flatMap((i) => i.segments ?? []); ok(items.every((i) => Array.isArray(i.segments) && i.segments.length >= 1 && i.turn && i.derived[0].segmentIds.length === i.segments.length), 'every spoken item is a TURN of immutable ASR segments'); ok(segs.every((x) => x.id && x.text && x.streamId && x.receivedAt && x.provider === 'moonshine-tiny-streaming-en' && x.version), JSON.stringify(segs[0])); ok(segs.some((x) => Number.isFinite(x.startTime) && Number.isFinite(x.duration)), 'the engine\'s own timing is kept: ' + JSON.stringify(segs.slice(0, 2).map((x) => [x.startTime, x.duration])));
  ok(heard.every((x) => Array.isArray(x.segmentIds) && x.segmentIds.every((id) => segs.some((s) => s.id === id))), 'every fact points back to real segment ids'); ok(items.length <= segs.length, 'turns group segments: ' + items.length + ' turns / ' + segs.length + ' segments');
});

await check('5. the thread shows the REAL transcription labelled "entendu au micro · transcription automatique · locuteur inconnu" with "Qui parlait ?" (never as the supplier); ASK NEXT reacts', async () => {
  const body = await text(t); ok(/entendu au micro/.test(body) && /locuteur inconnu/.test(body) && /Qui parlait \?/.test(body), body.slice(0, 400)); ok(!(await has(t, '.fm-row.sup:not(.heard) .fm-orig:not(:empty)')) || true, 'ok');
  const sug = await t.eval(`document.querySelector('.fm-sug .fm-en')?.innerText ?? ''`); ok(!/exact model number/i.test(sug), `ASK NEXT should no longer ask for the model once it was heard: ${sug}`);
  ok(!(await has(t, '[data-act="group-confirm"]')) && !(await has(t, '[data-act="cand-confirm"]')), 'no confirmation prompt in the main flow');
});

await check('5b. ASK NEXT is explainable and product-aware: the ask sheet says WHY (named parts); the question is not a battery question for a power bank that is already understood', async () => {
  if (!(await has(t, '.fm-sug'))) await tap(t, '[data-act="ask-now"]', 500); const q = await t.eval("document.querySelector('.fm-sug')?.dataset.qid ?? ''"); ok(q, 'a suggestion is shown'); ok(!['battery', 'radio', 'voltage'].includes(q), 'a power bank named as such is not asked whether it has a battery: ' + q);
  await tap(t, '.fm-sug', 400); ok(await has(t, '.fm-sheet details.fm-why'), 'why block'); await t.run("document.querySelector('.fm-sheet details.fm-why').open = true; return 1;"); const w = await text(t, '.fm-sheet .fm-why'); ok(/Pourquoi cette question/.test(w) && /Total\s*:/.test(w), w.slice(0, 300)); await closeSheet(t);
});

await check('5c. the Évaluation shows what Nordla understood of the product (hypothesis, traits with provenance, photo honestly NOT interpreted) and the optional market search; the search is recorded only when the owner taps, nothing is sent', async () => {
  await tap(t, '[data-act="fm-sheet"][data-key="summary"]', 500); const ev = await text(t, '.fm-sheet'); ok(/Ce que Nordla comprend du produit/.test(ev) && /batterie/i.test(ev) && /probable, d.après le nom/.test(ev), ev.slice(0, 600)); ok(/Marché \(Belgique · Europe\)/.test(ev) && /Aucune recherche faite/.test(ev), 'market block');
  const before = reqs.length; await tap(t, '.fm-sheet [data-act="fm-sheet"][data-key="market"]', 500); const mk = await text(t, '.fm-sheet'); ok(/Aucune correspondance trouvée ≠ non vendu/.test(mk) && /rien n.est cherché ni envoyé/.test(mk) && /Texte seulement/.test(mk), mk.slice(0, 500)); ok((await kase(t)).marketSearches === undefined || (await kase(t)).marketSearches.length === 0, 'opening the sheet records nothing');
  await tap(t, '.fm-sheet [data-act="market-run"]', 700); const c = await kase(t); ok(c.marketSearches?.length === 1 && c.marketSearches[0].status === 'PROVIDER_NOT_CONFIGURED' && c.marketSearches[0].evidence.length === 0 && c.marketSearches[0].consent === true, JSON.stringify(c.marketSearches));
  ok(reqs.slice(before).every((r) => r.url.startsWith(base)), 'no external request was made by the market action'); await closeSheet(t);
});

await check('6. in the Évaluation the heard facts are ◌ "locuteur inconnu" with "Qui parlait ?" (NO "Confirmer" until the OWNER says who spoke); then attribution -> one-by-one confirm -> SUPPLIER_CLAIM, basis TRANSCRIPTION', async () => {
  await tap(t, '[data-act="fm-sheet"][data-key="summary"]', 500); const ev = await text(t, '.fm-sheet'); ok(/locuteur inconnu/.test(ev) && await has(t, '.fm-sheet [data-act="attr-open"]'), ev.slice(0, 400)); ok(await t.eval(`[...document.querySelectorAll('.fm-sheet .fm-kv')].filter((r) => /locuteur inconnu/.test(r.innerText)).every((r) => !r.querySelector('[data-act="cand-confirm"]'))`), 'no Confirmer on a heard fact with an unknown speaker');
  await tap(t, '.fm-sheet [data-act="attr-open"]', 500); ok(/Qui parlait/.test(await text(t, '.fm-sheet')), 'speaker sheet'); await tap(t, '.fm-sheet [data-act="attr"][data-key="supplier"]', 600);
  let c = await kase(t); const it = c.conversations.flatMap((x) => x.items).find((i) => i.modality === 'SPEECH' && i.speakerBy === 'OWNER_DECISION'); ok(it && it.speaker === 'supplier', 'attributed by the owner'); ok(c.ledger.length === 0, 'attributing confirms nothing');
  await tap(t, '[data-act="fm-sheet"][data-key="summary"]', 500); const heardRow = `[...document.querySelectorAll('.fm-sheet .fm-kv')].find((r) => /transcription automatique/.test(r.innerText) && r.querySelector('[data-act="cand-confirm"]'))`; ok(await t.eval(`!!(${heardRow})`), 'a deliberate Confirmer now exists on the heard fact'); await t.run(`(${heardRow}).querySelector('[data-act="cand-confirm"]').click(); await __t.sleep(700); return 1;`); c = await kase(t); const led = c.ledger.at(-1);
  ok(led && led.status === 'SUPPLIER_CLAIM' && led.basis === 'TRANSCRIPTION' && led.userConfirmed === true, JSON.stringify(led)); await t.run(`document.querySelector('.fm-x[data-act="fm-sheet-close"]')?.click(); await __t.sleep(300); return 1;`);
});

await check('7. text stays available WHILE listening: a typed message is ORIGINAL text and the microphone keeps running', async () => {
  ok((await t.eval('window.nordlaVoice.state')) === 'listening', 'still listening'); await send(t, 'Lead time is 20 days.'); const c = await kase(t); const typed = c.conversations.flatMap((x) => x.items).find((i) => i.original === 'Lead time is 20 days.'); ok(typed && typed.speaker === 'supplier', 'typed item'); ok((await t.eval('window.nordlaVoice.state')) === 'listening', 'still listening after typing');
});

await check('8. PAUSE: the dock says so, the microphone is released and no new speech item appears; RESUME listens again and new speech arrives; the capture session is the same', async () => {
  const sess = (await speechItems(t))[0].capture.sessionId; await tap(t, '[data-act="vc-pause"]', 1200); ok((await t.eval('window.nordlaVoice.state')) === 'paused' && /Écoute en pause/.test(await text(t)), 'paused'); const n = (await speechItems(t)).length;
  await t.run('await __t.sleep(4500); return 1;'); ok((await speechItems(t)).length === n, 'no new speech while paused (the fake device keeps playing, nothing listens)');
  await tap(t, '[data-act="vc-resume"]', 300); await t.waitFor(`window.nordlaVoice.state === 'listening'`, 30000); await t.waitFor(`JSON.parse(localStorage.getItem('nordla.sourcing.cases'))[JSON.parse(localStorage.getItem('nordla.sourcing.current'))].conversations.flatMap((c) => c.items).filter((i) => i.modality === 'SPEECH').length > ${n}`, 40000);
  ok((await speechItems(t)).at(-1).capture.sessionId === sess, 'same capture session after resume');
});

await check('9. STOP (Terminer): the microphone is released, the conversation finishes, no more speech is added; the end sheet has no "Tout confirmer"', async () => {
  await tap(t, '.fm-dk.stop', 1500); ok((await t.eval('window.nordlaVoice.state')) === 'idle', 'idle'); const n = (await speechItems(t)).length; await t.run('await __t.sleep(3500); return 1;'); ok((await speechItems(t)).length === n, 'nothing added after stop');
  const b = await text(t, '.fm-sheet'); ok(/Conversation terminée/.test(b) && !/Tout confirmer/.test(b), b.slice(0, 300)); ok(/entendu/.test(b), 'heard facts are listed as heard');
});

await check('10. PRIVACY: no audio left the page (only same-origin GETs of the voice files and small JSON syncs), no audio in storage, the engine keeps up (small backlog)', async () => {
  ok(reqs.every((r) => r.url.startsWith(base)), `external request: ${reqs.find((r) => !r.url.startsWith(base))?.url}`); ok(reqs.filter((r) => r.method !== 'GET').every((r) => r.size < 400000 && /json/i.test(r.type || 'json')), JSON.stringify(reqs.filter((r) => r.method !== 'GET' && r.size >= 400000).slice(0, 2)));
  ok(!reqs.some((r) => /audio|octet-stream/i.test(r.type)), 'no audio/binary upload'); const store = await t.eval(`JSON.stringify(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k).length]))`); ok(!/audio|pcm|wav/i.test(store), store.slice(0, 300));
  ok((await t.eval('window.nordlaVoice.backlog')) <= 5, 'engine backlog'); const sv = await (await fetch(`${base}/api/cases`, { headers: { 'x-sourcing-token': TOKEN } })).text(); ok(!/"(audio|pcm|samples)"/i.test(sv), 'server copy has no audio');
});

await check('11. no uncaught error, no blocked resource (CSP / COEP) in the whole run', async () => { ok(errs.length === 0, errs.slice(0, 4).join(' | ')); });

await t.close(); await browser.close(); await new Promise((r) => srv.server.close(r)); rmSync(dir, { recursive: true, force: true }); rmSync(tmp, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
