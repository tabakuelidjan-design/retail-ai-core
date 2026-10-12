// FIELD COMPARISON HARNESS (LAB). ONE microphone path feeds the SAME audio to two engines at once:
//   A. Moonshine tiny-streaming-en (streaming, in a Worker)      B. Whisper tiny int8 (utterance by utterance: energy end-pointing, then one pass, in a Worker)
// For every prompt of tools/voice-bench/corpus/field-prompts.json it keeps the EXACT transcripts, the segmentation, timing and backlog; attribution to a prompt is by AUDIO time (not by when a result arrives).
// Nothing here is Nordla. Results go to this LAB server only (POST /api/result); audio only if the owner ticks the box (POST /api/audio). `?selftest=1&auto=1` replays synthetic prompts through the SAME pipeline
// (a plumbing check, NOT a field result).
import { envReport } from './engines.js';
const RATE = 16000; const q = new URLSearchParams(location.search); const SELFTEST = q.get('selftest') === '1'; const AUTO = q.has('auto');
const $ = (id) => document.getElementById(id); const log = (m) => { $('log').textContent += `${new Date().toISOString().slice(11, 23)} ${m}\n`; $('log').scrollTop = 1e9; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = q.get('session') || `fc-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
const VAD = { frame: 320, endSilenceMs: 700, preRollMs: 300, tailMs: 150, maxSegSec: 20, minSpeechMs: 200, minThr: 0.015, thrFactor: 3 };

// ---- growing PCM buffer (absolute sample positions) ----------------------------------------------------------------------------------------------------------------------------------
let pcm = new Float32Array(RATE * 120); let len = 0;
const append = (a) => { if (len + a.length > pcm.length) { const n = new Float32Array(Math.max(pcm.length * 2, len + a.length)); n.set(pcm.subarray(0, len)); pcm = n; } pcm.set(a, len); len += a.length; };
const slice = (a, b) => pcm.slice(Math.max(0, a), Math.min(len, b));
const rms = (o, n) => { let s = 0; for (let i = o; i < o + n; i++) s += pcm[i] * pcm[i]; return Math.sqrt(s / n); };

// ---- energy end-pointing (feeds Whisper; also gives the audio-based "speech end" for latency) ---------------------------------------------------------------------------------------
class Segmenter {
  constructor(onSegment) { this.on = onSegment; this.pos = 0; this.floor = 0.004; this.active = false; this.start = 0; this.lastLoud = 0; this.run = 0; }
  push() {
    while (this.pos + VAD.frame <= len) {
      const e = rms(this.pos, VAD.frame); const thr = Math.max(VAD.minThr, this.floor * VAD.thrFactor); const loud = e > thr; const endPos = this.pos + VAD.frame;
      if (!this.active) { this.floor = Math.max(0.002, this.floor * 0.97 + e * 0.03); this.run = loud ? this.run + 1 : 0; if (this.run >= 2) { this.active = true; this.start = Math.max(0, endPos - VAD.frame * 2 - (VAD.preRollMs / 1000) * RATE); this.lastLoud = endPos; } }
      else { if (loud) this.lastLoud = endPos; if (((endPos - this.lastLoud) / RATE) * 1000 >= VAD.endSilenceMs || (endPos - this.start) / RATE >= VAD.maxSegSec) this.cut(endPos); }
      this.pos = endPos;
    }
  }
  cut(now = this.pos) { if (!this.active) return; const end = Math.min(len, Math.min(now, this.lastLoud + (VAD.tailMs / 1000) * RATE)); const speechMs = ((this.lastLoud - this.start) / RATE) * 1000; this.active = false; this.run = 0; if (speechMs >= VAD.minSpeechMs && end > this.start) this.on({ startSample: this.start, endSample: Math.max(end, this.start + RATE * 0.2), speechEndSample: this.lastLoud }); }
}

// ---- engines -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
const E = { ms: null, wh: null, loadMs: {}, errors: [] };
const msLog = { finals: [], partials: [], passMs: [], seq: 0, acked: 0, maxBacklog: 0 }; const whLog = { segs: [], jobs: new Map(), queue: [], busy: false, maxQueue: 0, nextId: 1 };
let captureStartWall = 0; const chunkWall = []; /* [endSample, wall the chunk arrived] */ const audioT = () => len / RATE;
/** wall-clock moment a given sample was captured: the arrival of the chunk that contained it, minus its position inside the chunk (exact for a live microphone, also across pauses between prompts in the self-test) */
function wallOf(sample) { let lo = 0; let hi = chunkWall.length - 1; if (hi < 0) return captureStartWall; while (lo < hi) { const mid = (lo + hi) >> 1; if (chunkWall[mid][0] >= sample) hi = mid; else lo = mid + 1; } const [end, wall] = chunkWall[lo]; return wall - ((end - sample) / RATE) * 1000; }
function startWorkers() {
  E.ms = new Worker('/compare-moonshine-worker.js', { type: 'module' }); E.wh = new Worker('/compare-whisper-worker.js', { type: 'module' });
  const ready = (w, name) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${name}: chargement trop long`)), 240000); w.addEventListener('message', function h(ev) { if (ev.data.type === 'ready') { clearTimeout(t); E.loadMs[name] = ev.data.loadMs; log(`${name} chargé en ${ev.data.loadMs} ms`); w.removeEventListener('message', h); res(); } else if (ev.data.type === 'error') { clearTimeout(t); rej(new Error(`${name}: ${ev.data.message}`)); } }); w.postMessage({ type: 'init' }); });
  return Promise.all([ready(E.ms, 'moonshine'), ready(E.wh, 'whisper')]);
}
function wireWorkers() {
  E.ms.onmessage = (ev) => { const m = ev.data; const wall = performance.now();
    if (m.type === 'result') { msLog.acked = Math.max(msLog.acked, m.seq); msLog.passMs.push(m.passMs); msLog.maxBacklog = Math.max(msLog.maxBacklog, msLog.seq - m.seq); for (const f of m.finals) msLog.finals.push({ ...f, recvWall: wall, recvAudioT: audioT(), seq: m.seq }); if (m.partial !== (msLog.partials.at(-1)?.text ?? '')) msLog.partials.push({ text: m.partial, wall, audioT: audioT() }); render(); }
    else if (m.type === 'flushed') { for (const f of m.finals) msLog.finals.push({ ...f, recvWall: wall, recvAudioT: audioT(), seq: msLog.seq, flushed: true }); msLog.flushDone?.(); }
    else if (m.type === 'error') { E.errors.push({ engine: 'moonshine', ...m }); log(`moonshine ERREUR ${m.message}`); } };
  E.wh.onmessage = (ev) => { const m = ev.data; const wall = performance.now();
    if (m.type === 'done') { const j = whLog.jobs.get(m.id); whLog.segs.push({ ...j, text: m.text, passMs: m.passMs, audioSec: m.audioSec, doneWall: wall }); whLog.jobs.delete(m.id); whLog.busy = false; pumpWhisper(); render(); }
    else if (m.type === 'error') { E.errors.push({ engine: 'whisper', ...m }); log(`whisper ERREUR ${m.message}`); whLog.busy = false; pumpWhisper(); } };
}
function pumpWhisper() { if (whLog.busy || !whLog.queue.length) return; const j = whLog.queue.shift(); whLog.busy = true; const p = slice(j.startSample, j.endSample); j.postedWall = performance.now(); whLog.jobs.set(j.id, j); E.wh.postMessage({ type: 'run', id: j.id, pcm: p }, [p.buffer]); }
const segmenter = new Segmenter((s) => { const j = { id: whLog.nextId++, ...s, queuedWall: performance.now() }; whLog.queue.push(j); whLog.maxQueue = Math.max(whLog.maxQueue, whLog.queue.length + (whLog.busy ? 1 : 0)); pumpWhisper(); });

// ---- one chunk of 16 kHz audio goes to BOTH engines ----------------------------------------------------------------------------------------------------------------------------------
function feed(chunk) { append(chunk); chunkWall.push([len, performance.now()]); msLog.seq += 1; const c = chunk.slice(); E.ms.postMessage({ type: 'audio', seq: msLog.seq, pcm: c }, [c.buffer]); segmenter.push(); }
let micCtx = null; let micStream = null; let wake = null;
async function startMic(processed) {
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: processed, noiseSuppression: processed, autoGainControl: processed } });
  micCtx = new AudioContext(); const code = `class C extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0}process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===2048){this.port.postMessage(this.b.slice(0));this.n=0}}}return true}}registerProcessor('cap',C)`;
  const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' })); await micCtx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
  const src = micCtx.createMediaStreamSource(micStream); const node = new AudioWorkletNode(micCtx, 'cap'); const rate = micCtx.sampleRate;
  node.port.onmessage = (ev) => { const a = ev.data; if (rate === RATE) return feed(a); const r = rate / RATE; const n = Math.floor(a.length / r); const o = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * r; const k = Math.floor(p); const f = p - k; o[i] = a[k] + ((a[k + 1] ?? a[k]) - a[k]) * f; } feed(o); };
  src.connect(node); node.connect(micCtx.destination); try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not held */ }
  log(`micro prêt (AudioContext ${rate} Hz, traitement navigateur ${processed ? 'OUI' : 'NON'}, ${micStream.getAudioTracks()[0]?.label ?? ''})`);
}

// ---- prompts, marks and attribution ---------------------------------------------------------------------------------------------------------------------------------------------------
let prompts = []; const marks = {}; let cur = -1;
const winOf = (m) => [m.startSample / RATE - 0.3, m.stopSample / RATE + 0.6];
function perPrompt(p) {
  const m = marks[p.id]; if (!m || m.stopSample === undefined) return null; const [a, b] = winOf(m);
  const finals = msLog.finals.filter((f) => { const mid = f.startTime !== null ? f.startTime + (f.duration ?? 0) / 2 : f.recvAudioT; return mid >= a && mid <= b; });
  const segs = whLog.segs.filter((s) => { const mid = (s.startSample + s.endSample) / 2 / RATE; return mid >= a && mid <= b; }).sort((x, y) => x.startSample - y.startSample);
  const speechEnd = Math.max(0, ...segs.map((s) => s.speechEndSample)); const endWall = speechEnd ? wallOf(speechEnd) : null;
  const firstPartial = msLog.partials.find((x) => x.text && x.audioT >= a && x.audioT <= b + 3);
  return { id: p.id, cat: p.cat, say: p.say, marks: m, speechEndSample: speechEnd || null,
    moonshine: { text: finals.map((f) => f.text).join(' ').replace(/\s+/g, ' ').trim(), finals: finals.map(({ text, startTime, duration, recvWall, recvAudioT, seq }) => ({ text, startTime, duration, recvWall: Math.round(recvWall), recvAudioT: Math.round(recvAudioT * 1000) / 1000, seq })), nFinals: finals.length, finalLatencyMs: finals.length && endWall ? Math.round(Math.max(...finals.map((f) => f.recvWall)) - endWall) : null, firstPartialLagMs: firstPartial && m.startWall ? Math.round(firstPartial.wall - m.startWall) : null },
    whisper: { text: segs.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(), segments: segs.map(({ id, startSample, endSample, speechEndSample, text, passMs, audioSec, queuedWall, postedWall, doneWall }) => ({ id, startSample, endSample, speechEndSample, text, passMs, audioSec, queueWaitMs: Math.round(postedWall - queuedWall), doneWall: Math.round(doneWall) })), nSegments: segs.length, finalLatencyMs: segs.length && endWall ? Math.round(Math.max(...segs.map((s) => s.doneWall)) - endWall) : null } };
}
function render() {
  if (cur < 0 || !prompts[cur]) return; const p = perPrompt(prompts[cur]); const el = $('res'); if (!el) return;
  const m = msLog.partials.at(-1)?.text; const done = p ?? { moonshine: { text: '' }, whisper: { text: '' } };
  el.innerHTML = `<div class="two"><div class="eng"><b>MOONSHINE</b>${esc(done.moonshine.text) || '<span class="part">…</span>'}${m ? ` <span class="part">${esc(m)}</span>` : ''}<div class="meta">${done.moonshine.nFinals ?? 0} segments${done.moonshine.finalLatencyMs != null ? ` · fin ${done.moonshine.finalLatencyMs} ms` : ''}</div></div><div class="eng"><b>WHISPER</b>${esc(done.whisper.text) || '<span class="part">…</span>'}<div class="meta">${done.whisper.nSegments ?? 0} segment(s)${done.whisper.finalLatencyMs != null ? ` · fin ${done.whisper.finalLatencyMs} ms` : ''}</div></div></div><div class="meta">retard Moonshine ${msLog.seq - msLog.acked} · file Whisper ${whLog.queue.length + (whLog.busy ? 1 : 0)}</div>`;
}
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function showPrompt(i) {
  cur = i; const p = prompts[i]; const st = $('stage');
  if (!p) { st.innerHTML = '<div class="card"><b>Terminé.</b> <button class="go" id="send">Envoyer les résultats</button></div>'; $('send').onclick = finish; return; }
  const cont = p.cat === 'CONTINUOUS';
  st.innerHTML = `<div class="card"><span class="cat">${p.cat} · ${i + 1}/${prompts.length}</span><div class="say">${cont ? 'Parle librement de ce produit pendant 30 à 60 secondes, sans t’arrêter' : esc(p.say)}</div>${cont ? `<p class="sub">Sujets possibles (au choix, dans l’ordre que tu veux) : ${p.topics.join(' · ')}. Lis rien : parle comme au stand. <b id="tm">0 s</b></p>` : '<p class="sub">Dis la phrase une fois, naturellement.</p>'}<button class="go" id="rec">● Parler</button><button id="stop" disabled>■ Fini</button><button id="next" disabled>Suivant →</button><div id="res"></div></div>`;
  $('rec').onclick = () => { marks[p.id] = { startSample: len, startWall: performance.now() }; $('rec').disabled = true; $('rec').classList.add('rec'); $('stop').disabled = false; if (cont) { const t0 = performance.now(); marks[p.id].timer = setInterval(() => { $('tm').textContent = `${Math.round((performance.now() - t0) / 1000)} s`; }, 500); } };
  $('stop').onclick = async () => { const m = marks[p.id]; clearInterval(m.timer); delete m.timer; m.stopSample = len; m.stopWall = performance.now(); segmenter.cut(len); $('stop').disabled = true; $('rec').classList.remove('rec'); $('next').disabled = true; if ($('keep').checked) uploadAudio(p.id, m); setTimeout(() => { if ($('next')) $('next').disabled = false; render(); }, 3500); };
  $('next').onclick = () => showPrompt(i + 1); render();
}
async function uploadAudio(id, m) {
  const a = slice(m.startSample - RATE * 0.5, m.stopSample + RATE * 1); const b = new ArrayBuffer(44 + a.length * 2); const v = new DataView(b); const w = (o, s) => [...s].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + a.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, a.length * 2, true);
  for (let i = 0; i < a.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, a[i])) * 32767, true);
  try { await fetch(`/api/audio?name=${encodeURIComponent(`${session}-${id}`)}`, { method: 'POST', body: b }); log(`audio ${id} gardé sur le PC`); } catch (e) { log(`audio ${id} non gardé: ${e}`); }
}

// ---- finish: flush, wait, build the result, send --------------------------------------------------------------------------------------------------------------------------------------
async function finish() {
  $('stage').innerHTML = '<div class="card">Fin du test : traitement des derniers segments…</div>';
  segmenter.cut(len); await new Promise((res) => { msLog.flushDone = res; E.ms.postMessage({ type: 'flush' }); setTimeout(res, 4000); });
  for (let i = 0; i < 120 && (whLog.queue.length || whLog.busy); i++) await sleep(500);
  const per = prompts.map(perPrompt).filter(Boolean); const cont = per.find((x) => x.cat === 'CONTINUOUS');
  const gaps = cont ? cont.moonshine.finals.slice(1).map((f, i) => Math.round((f.recvAudioT - cont.moonshine.finals[i].recvAudioT) * 1000) / 1000) : [];
  const result = { session, startedAt: new Date(Date.now() - audioT() * 1000).toISOString(), finishedAt: new Date().toISOString(), mode: SELFTEST ? 'SELFTEST_SYNTHETIC_PLUMBING_ONLY' : 'REAL_SPEAKER_REAL_MICROPHONE', speaker: SELFTEST ? 'synthetic voice' : 'owner (own accent); Chinese-accented English: NOT TESTED (UNKNOWN); Mandarin: not supported',
    env: await envReport(), engines: { moonshine: { id: 'moonshine-tiny-streaming-en', runtime: 'moonshine-wasm 0.1.5', model: 'tiny-streaming-en quantized_26_08_21', loadMs: E.loadMs.moonshine }, whisper: { id: 'whisper-tiny-int8', runtime: 'transformers.js 4.3.0 + onnxruntime-web', model: 'whisper-tiny-onnx int8', loadMs: E.loadMs.whisper, segmentation: VAD } },
    micProcessing: SELFTEST ? null : $('proc').checked, audioKept: SELFTEST ? false : $('keep').checked, totalAudioSec: Math.round(audioT() * 10) / 10,
    stats: { moonshine: { finals: msLog.finals.length, passMsMedian: median(msLog.passMs), passMsP90: pct(msLog.passMs, 0.9), passMsMax: Math.max(0, ...msLog.passMs), maxBacklogChunks: msLog.maxBacklog, chunkSec: 2048 / RATE, rtfMedianApprox: median(msLog.passMs) / 1000 / (2048 / RATE) }, whisper: { segments: whLog.segs.length, passMsMedian: median(whLog.segs.map((s) => s.passMs)), passMsP90: pct(whLog.segs.map((s) => s.passMs), 0.9), rtf: whLog.segs.length ? Math.round((whLog.segs.reduce((a, s) => a + s.passMs, 0) / 1000 / whLog.segs.reduce((a, s) => a + s.audioSec, 0)) * 1000) / 1000 : null, maxQueue: whLog.maxQueue } },
    memory: { jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e5) / 10 : null, note: 'WASM and worker memory are not observable from the page in Firefox; battery and temperature were not measured.' },
    continuous: cont ? { seconds: Math.round(((cont.marks.stopSample - cont.marks.startSample) / RATE) * 10) / 10, moonshineFinals: cont.moonshine.nFinals, moonshineFinalGapsSec: gaps, whisperSegments: cont.whisper.nSegments } : null,
    prompts: per, errors: E.errors };
  const body = JSON.stringify(result); try { await fetch(`/api/result?name=compare-${encodeURIComponent(session)}`, { method: 'POST', body }); log('résultat envoyé au PC'); } catch (e) { log('envoi impossible: ' + e); }
  window.__result = result; $('stage').innerHTML = `<div class="card"><b>DONE</b> · résultat envoyé (${session}). Rien d'autre à faire : dis-moi que c'est fini.</div>`; $('st').textContent = 'DONE';
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }; const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// ---- self-test feeder (synthetic voice through the SAME pipeline, real-time pace) -------------------------------------------------------------------------------------------------------
async function wavPcm(url) { const b = await (await fetch(url)).arrayBuffer(); const v = new DataView(b); let o = 12; while (o < b.byteLength) { const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)); const sz = v.getUint32(o + 4, true); if (id === 'data') { const n = sz / 2; const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = v.getInt16(o + 8 + i * 2, true) / 32768; return a; } o += 8 + sz + (sz % 2); } throw new Error('no data chunk'); }
async function feedRealtime(a) { const n = 1600; const t0 = performance.now(); for (let off = 0; off < a.length; off += n) { const wait = t0 + (off / RATE) * 1000 - performance.now(); if (wait > 1) await sleep(wait); feed(a.slice(off, off + n)); } }
async function selftest() {
  for (let i = 0; i < prompts.length; i++) { const p = prompts[i]; cur = i; await feedRealtime(new Float32Array(RATE * 1.2)); marks[p.id] = { startSample: len, startWall: performance.now() }; await feedRealtime(await wavPcm(`/field-selftest/${p.id}.wav`)); marks[p.id].stopSample = len; marks[p.id].stopWall = performance.now(); segmenter.cut(len); await feedRealtime(new Float32Array(RATE * 3)); log(`selftest ${p.id} fait`); }
  await finish();
}

// ---- boot --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function boot() {
  $('start').disabled = true; $('st').textContent = ' chargement des moteurs…'; $('bar').style.width = '15%';
  prompts = (await (await fetch('/bench/field-prompts.json')).json()).prompts;
  try { await startWorkers(); } catch (e) { $('st').textContent = ' ÉCHEC: ' + e.message; log('FATAL ' + e.message); return; }
  wireWorkers(); $('bar').style.width = '60%'; captureStartWall = performance.now(); E.ms.postMessage({ type: 'start' });
  if (SELFTEST) { $('st').textContent = ' auto-test synthétique…'; return selftest(); }
  try { await startMic($('proc').checked); } catch (e) { $('st').textContent = ' micro refusé ou indisponible: ' + e.name; log('micro: ' + e); return; }
  captureStartWall = performance.now(); $('bar').style.width = '100%'; $('st').textContent = ' prêt'; $('setup').style.display = 'none'; showPrompt(0);
}
$('start').addEventListener('click', () => boot().catch((e) => { log('fatal ' + e); }));
if (AUTO) boot().catch((e) => log('fatal ' + e));
