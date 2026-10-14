// CANONICAL RECORDING page (LAB, Xiaomi Firefox Android). The owner presses START RECORDING, goes through the whole script once (the "Suivant" tap only drops a marker: the recording is never cut), presses STOP,
// listens, and either redoes it or ACCEPTS it. Accepting uploads ONE lossless WAV to the LAB server, which stores it read-only with its SHA-256; every provider later receives audio derived from THAT sample.
// The page records the raw PCM the browser delivers (after the browser's own processing, the setting is recorded) at the device sample rate, as 16-bit WAV. Nothing is sent to any provider from here.
const $ = (id) => document.getElementById(id); const log = (m) => { $('log').textContent += `${new Date().toISOString().slice(11, 23)} ${m}\n`; $('log').scrollTop = 1e9; };
const q = new URLSearchParams(location.search); const session = q.get('session') || `canon-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
let script = null; let chunks = []; let samples = 0; let rate = 48000; let ctx = null; let stream = null; let wake = null; let peak = 0; let markers = []; let cur = -1; let timer = null; let t0 = 0; let wavBlob = null; let wavBytes = null; let settings = null;
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function intro() {
  script = await (await fetch('/api/canon/script')).json();
  $('stage').innerHTML = `<div class="card"><p><b>${script.items.length} étapes</b> (≈ ${script.estimatedMinutes} min) : silence, phrases de sourcing, références produit (dont 30 inventées), phrases mixtes, bruit, puis ~4 min de conversation naturelle.</p>
    <p>Parle <b>naturellement</b>, comme à un fournisseur : ne prononce rien « pour la machine ». Si tu te trompes, <b>continue</b> : les erreurs font partie du test (tu pourras corriger la référence après).</p>
    <p>Mets le téléphone à l'endroit et à la distance où tu le tiendrais au stand. Le micro reste le même du début à la fin.</p>
    <label><input type="checkbox" id="proc" checked> Réduction de bruit, annulation d'écho et gain automatique du navigateur (comme dans l'application)</label>
    <label>Nom de la session <input type="text" id="sid" value="${esc(session)}"></label>
    <button class="go" id="start">● START RECORDING</button><p class="small">Le navigateur demandera l'accès au micro. L'écran restera allumé pendant l'enregistrement.</p></div>`;
  $('start').onclick = startRecording;
}

async function startRecording() {
  $('start').disabled = true; window.__sid = ($('sid').value || session).replace(/[^A-Za-z0-9_.-]/g, '_'); const processed = $('proc').checked; chunks = []; samples = 0; peak = 0; markers = []; cur = -1;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: processed, noiseSuppression: processed, autoGainControl: processed, channelCount: 1 } }); } catch (e) { log('micro refusé: ' + e); $('start').disabled = false; return; }
  ctx = new AudioContext(); rate = ctx.sampleRate; const code = 'class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("cap",C)';
  const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' })); await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
  const src = ctx.createMediaStreamSource(stream); const node = new AudioWorkletNode(ctx, 'cap'); node.port.onmessage = (ev) => { const a = ev.data; chunks.push(a); samples += a.length; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > peak) peak = v; } $('lvl') && ($('lvl').style.width = `${Math.min(100, Math.round(Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) * 400))}%`); };
  src.connect(node); node.connect(ctx.destination); try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not held */ }
  const track = stream.getAudioTracks()[0]; settings = { constraintsRequested: { echoCancellation: processed, noiseSuppression: processed, autoGainControl: processed, channelCount: 1 }, trackSettings: track.getSettings?.() ?? {}, trackLabel: track.label, audioContextSampleRate: rate, baseLatency: ctx.baseLatency ?? null };
  log(`micro prêt: ${rate} Hz, traitement navigateur ${processed ? 'ON' : 'OFF'}, ${track.label}`); t0 = performance.now(); next();
  timer = setInterval(() => { const e = $('clock'); if (e) e.textContent = mmss(samples / rate); }, 250);
}
const nowSec = () => Math.round((samples / rate) * 1000) / 1000;
function next() {
  cur += 1; if (cur >= script.items.length) return stop(); const it = script.items[cur]; markers.push({ itemId: it.id, startSec: nowSec() });
  const isLast = cur === script.items.length - 1; const spoken = it.kind === 'identifier' && !it.say ? `<div class="say">${esc(it.display.replace(/^Référence\s+/, ''))}</div><div class="small">Lis cette référence comme tu la dirais au fournisseur.</div>` : it.say ? `<div class="hint">${esc(it.display)}</div><div class="say">${esc(it.say)}</div>` : `<div class="say" style="font-size:24px">${esc(it.display)}</div>${it.kind === 'natural' ? '<div class="small">Parle librement (≈ 30 à 40 s), avec tes mots. Pas de lecture.</div>' : ''}`;
  $('stage').innerHTML = `<div class="bar"><span><span class="dot">●</span> REC <b id="clock">${mmss(samples / rate)}</b></span><span>${cur + 1} / ${script.items.length}</span></div><div class="meter"><i id="lvl"></i></div>
    <div class="card"><div class="cat">${esc(it.section.replace(/_/g, ' '))}</div>${spoken}</div>
    <button class="go" id="next">${isLast ? 'Terminer ▸' : 'Suivant ▸'}</button><button id="stop">STOP RECORDING</button>`;
  $('next').onclick = next; $('stop').onclick = () => { if (confirm('Arrêter maintenant ? Les étapes restantes ne seront pas dans l’enregistrement.')) stop(); };
}

function encodeWav() {
  const n = samples; const b = new ArrayBuffer(44 + n * 2); const v = new DataView(b); const w = (o, s) => [...s].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44; for (const c of chunks) for (let i = 0; i < c.length; i++) { v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 32767, true); o += 2; } return b;
}
async function stop() {
  clearInterval(timer); const stopSec = nowSec(); try { stream.getTracks().forEach((t) => t.stop()); await ctx.close(); await wake?.release(); } catch { /* ignore */ }
  wavBytes = encodeWav(); wavBlob = new Blob([wavBytes], { type: 'audio/wav' }); const url = URL.createObjectURL(wavBlob); const dur = stopSec; const warn = peak < 0.03 ? '<p style="color:#c0392b"><b>Niveau très faible</b> : le micro n’a presque rien capté. Refais l’enregistrement.</p>' : peak > 0.99 ? '<p style="color:#9a5b00"><b>Saturation détectée</b> : tu étais peut-être trop près du micro.</p>' : '';
  window.__stopSec = stopSec; $('stage').innerHTML = `<div class="card"><b>Écoute avant d’accepter</b><audio controls src="${url}"></audio><p>Durée ${mmss(dur)} (${dur.toFixed(1)} s) · ${rate} Hz · mono · 16 bits · ${(wavBytes.byteLength / 1048576).toFixed(1)} Mo · niveau max ${(peak * 100).toFixed(0)} %</p>${warn}
    <button class="ok" id="accept">Accepter : cet enregistrement devient la référence immuable</button><button id="redo">Refaire l’enregistrement (rien n’est gardé)</button></div>`;
  $('redo').onclick = () => { URL.revokeObjectURL(url); wavBlob = null; wavBytes = null; intro(); }; $('accept').onclick = accept;
}
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function accept() {
  $('accept').disabled = true; $('redo').disabled = true; const sid = window.__sid || session; log('calcul du SHA-256…'); const sha = hex(await crypto.subtle.digest('SHA-256', wavBytes)); log(`SHA-256 ${sha}`);
  const meta = { markers: { unit: 'seconds', items: markers, stopSec: window.__stopSec }, device: { userAgent: navigator.userAgent, platform: navigator.platform, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory ?? null, recordedAt: new Date().toISOString() }, browserAudioProcessing: settings, clientSha256: sha };
  let r = await fetch(`/api/canon/meta?session=${encodeURIComponent(sid)}`, { method: 'POST', body: JSON.stringify(meta) }); if (!r.ok) { log('échec meta: ' + await r.text()); return; }
  r = await fetch(`/api/canon/audio?session=${encodeURIComponent(sid)}`, { method: 'POST', body: wavBytes }); const txt = await r.text(); if (!r.ok) { log(`REFUSÉ (${r.status}): ${txt}`); $('stage').innerHTML += `<div class="card" style="border-color:#c0392b"><b>Refusé</b><br>${esc(txt)}</div>`; return; }
  const j = JSON.parse(txt); log(`serveur: sha256 ${j.sha256}`);
  $('stage').innerHTML = `<div class="card"><b>Enregistrement accepté et verrouillé.</b><p class="small">SHA-256 : ${sha}<br>Le serveur a recalculé le même : ${j.sha256 === sha ? 'oui ✓' : '<b style="color:#c0392b">NON</b>'}<br>Session : ${esc(sid)}</p>
    <p><b>Étape suivante :</b> corriger le texte de référence de la conversation naturelle.</p><button class="go" onclick="location.href='ref.html?session=${encodeURIComponent(sid)}'">Corriger les références →</button></div>`;
}
intro().catch((e) => log('fatal ' + e));
