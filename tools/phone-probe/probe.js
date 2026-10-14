// Nordla phone probe (TEMPORARY, ISOLATED). Measures what this phone browser can really do with audio. Nothing here is China Sourcing code.
// Design points under test: (1) recorder state lives OUTSIDE the DOM, the screen is re-rendered from state (as the real app does), (2) every 1 s chunk is written to IndexedDB as it
// arrives, so an interrupted recording can be recovered, (3) reports (metadata only, never audio) are queued in IndexedDB and sent when the PC is reachable.
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const T0 = performance.now(); const since = () => Math.round(performance.now() - T0);
  const S = { token: '', stream: null, mic: null, rec: null, storm: null, stormTicks: 0, recs: [], steps: {}, events: [], reportsSent: 0, sw: 'n/a', storage: null, formatChoice: 'default', last: '', player: null };

  // ---- token: from the URL fragment, removed at once --------------------------------------------------------------------------------------------------------------------------
  try {
    const m = /[#&]t=([A-Za-z0-9_-]{16,})/.exec(location.hash);
    if (m) { localStorage.setItem('probe.token', m[1]); history.replaceState(null, '', location.pathname + location.search); }
    S.token = localStorage.getItem('probe.token') || '';
  } catch { /* storage blocked: reports will stay local */ }

  const ev = (msg) => { S.events.push({ t: since(), msg }); if (S.events.length > 300) S.events.shift(); if (S.rec) S.rec.events.push({ t: since(), msg }); };

  // ---- IndexedDB ---------------------------------------------------------------------------------------------------------------------------------------------------------------
  let dbp = null;
  const db = () => dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('nordla-probe', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('chunks', { keyPath: ['recId', 'seq'] }); d.createObjectStore('recordings', { keyPath: 'id' }); d.createObjectStore('reports', { autoIncrement: true }); d.createObjectStore('scratch', { autoIncrement: true }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const run = async (store, mode, fn) => { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(store, mode); const st = tx.objectStore(store); let out; try { out = fn(st); } catch (e) { rej(e); return; } tx.oncomplete = () => res(out && 'result' in out ? out.result : out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error ?? new Error('aborted')); }); };
  const getAll = (store) => run(store, 'readonly', (st) => st.getAll());
  const getAllKeys = (store) => run(store, 'readonly', (st) => st.getAllKeys());

  // ---- reports (metadata only; queued while the PC is unreachable) ------------------------------------------------------------------------------------------------------------
  let flushing = false;
  async function report(step, data) {
    S.steps[step] = { at: new Date().toISOString(), ...summaryOf(data) };
    const entry = { step, at: new Date().toISOString(), online: navigator.onLine, ua: navigator.userAgent, data };
    try { await run('reports', 'readwrite', (st) => st.add(entry)); } catch { /* ignore */ }
    flush(); render();
  }
  const summaryOf = (d) => (d && typeof d === 'object' && 'verdict' in d ? { verdict: d.verdict } : {});
  let again = false;
  async function flush() {
    if (!S.token) return; if (flushing) { again = true; return; } flushing = true;
    try {
      do { again = false; await flushOnce(); } while (again);
    } finally { flushing = false; render(); }
  }
  async function flushOnce() {
    {
      const keys = await getAllKeys('reports'); const vals = await getAll('reports');
      for (let i = 0; i < keys.length; i++) {
        let ok = false;
        try { const r = await fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json', 'x-probe-token': S.token }, body: JSON.stringify(vals[i]) }); ok = r.ok; } catch { ok = false; }
        if (!ok) break;
        await run('reports', 'readwrite', (st) => st.delete(keys[i])); S.reportsSent += 1;
      }
    }
  }
  const queued = async () => (await getAllKeys('reports')).length;

  // ---- environment and storage ---------------------------------------------------------------------------------------------------------------------------------------------
  const MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/mpeg', 'audio/wav', 'audio/aac'];
  function formats() {
    const supported = typeof MediaRecorder === 'undefined' ? null : Object.fromEntries(MIMES.map((m) => [m, MediaRecorder.isTypeSupported(m)]));
    return supported;
  }
  async function storageInfo() {
    const out = { estimateApi: !!navigator.storage?.estimate };
    try { const e = await navigator.storage.estimate(); out.usageMB = +(e.usage / 1048576).toFixed(2); out.quotaMB = +(e.quota / 1048576).toFixed(0); } catch (x) { out.estimateError = String(x); }
    try { out.persisted = await navigator.storage.persisted(); } catch { /* n/a */ }
    return out;
  }
  async function envReport() {
    S.storage = await storageInfo();
    const data = {
      userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language, onLine: navigator.onLine, secureContext: isSecureContext,
      getUserMedia: !!navigator.mediaDevices?.getUserMedia, mediaRecorder: typeof MediaRecorder !== 'undefined', formats: formats(), indexedDB: !!window.indexedDB, serviceWorker: 'serviceWorker' in navigator, swState: S.sw,
      webSpeech: ('SpeechRecognition' in window) || ('webkitSpeechRecognition' in window), wasm: typeof WebAssembly, cores: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory ?? null,
      screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, storage: S.storage,
    };
    try { const p = await navigator.permissions?.query({ name: 'microphone' }); data.micPermissionState = p?.state ?? 'unknown'; } catch (e) { data.micPermissionState = `query not supported (${e.name})`; }
    await report('env', data);
  }
  async function persistRequest() {
    let r = 'n/a'; try { r = await navigator.storage.persist(); } catch (e) { r = `error ${e.name}`; }
    S.storage = await storageInfo(); await report('storage-persist', { persistResult: r, storage: S.storage });
  }
  async function storageWrite(mb) {
    const before = await storageInfo(); const t0 = performance.now(); let ok = true; let err = null; const keys = [];
    try {
      for (let i = 0; i < mb; i++) { const a = new Uint8Array(1048576); for (let o = 0; o < a.length; o += 65536) crypto.getRandomValues(a.subarray(o, o + 65536)); const k = await run('scratch', 'readwrite', (st) => st.add(new Blob([a]))); keys.push(k); }
    } catch (e) { ok = false; err = `${e.name}: ${e.message}`; }
    const ms = Math.round(performance.now() - t0); const after = await storageInfo();
    for (const k of keys) { try { await run('scratch', 'readwrite', (st) => st.delete(k)); } catch { /* ignore */ } }
    S.storage = await storageInfo(); await report(`storage-write-${mb}MB`, { ok, error: err, writtenMB: keys.length, ms, before, after });
  }

  // ---- microphone ----------------------------------------------------------------------------------------------------------------------------------------------------------------
  async function askMic() {
    if (S.stream && S.stream.active) return S.stream;
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tr = S.stream.getAudioTracks()[0]; const st = tr.getSettings?.() ?? {};
      tr.addEventListener('ended', () => ev('track ENDED (the browser or OS stopped the microphone)')); tr.addEventListener('mute', () => ev('track MUTED')); tr.addEventListener('unmute', () => ev('track unmuted'));
      S.mic = { granted: true, label: tr.label ? 'present' : 'empty', settings: { sampleRate: st.sampleRate, channelCount: st.channelCount, echoCancellation: st.echoCancellation, noiseSuppression: st.noiseSuppression, autoGainControl: st.autoGainControl } };
      let perm = 'n/a'; try { perm = (await navigator.permissions.query({ name: 'microphone' })).state; } catch { /* n/a */ }
      await report('mic-permission', { ...S.mic, permissionState: perm, verdict: 'GRANTED' });
    } catch (e) { S.mic = { granted: false, error: `${e.name}: ${e.message}` }; await report('mic-permission', { ...S.mic, verdict: 'DENIED_OR_FAILED' }); throw e; }
    return S.stream;
  }

  // ---- recording (state OUTSIDE the DOM; chunks persisted as they arrive) ------------------------------------------------------------------------------------------------
  const FORMAT_CHOICES = { default: undefined, 'webm-opus': 'audio/webm;codecs=opus', 'ogg-opus': 'audio/ogg;codecs=opus', mp4: 'audio/mp4' };
  async function startRec() {
    if (S.rec) return;
    await askMic();
    const want = FORMAT_CHOICES[S.formatChoice]; const opts = want ? { mimeType: want } : undefined;
    let mr; try { mr = new MediaRecorder(S.stream, opts); } catch (e) { await report('record-start', { ok: false, error: `${e.name}: ${e.message}`, requested: want ?? 'browser default', verdict: 'FAILED' }); return; }
    const id = `rec-${Date.now().toString(36)}`;
    const rec = { id, mr, mime: mr.mimeType, requested: want ?? 'browser default', startedAt: performance.now(), startedWall: Date.now(), startedOnline: navigator.onLine, seq: 0, bytes: 0, chunks: 0, blobs: [], lastChunkAt: performance.now(), maxGapMs: 0, events: [], hidden: 0, stormTicksAtStart: S.stormTicks, error: null };
    S.rec = rec; ev(`record START mime=${rec.mime || '(empty)'} requested=${rec.requested} online=${rec.startedOnline}`);
    mr.ondataavailable = async (e) => {
      const now = performance.now(); rec.maxGapMs = Math.max(rec.maxGapMs, Math.round(now - rec.lastChunkAt)); rec.lastChunkAt = now;
      if (!e.data || !e.data.size) return;
      const seq = rec.seq++; rec.chunks += 1; rec.bytes += e.data.size; rec.blobs.push(e.data); rec.chunkType = e.data.type;
      try { await run('chunks', 'readwrite', (st) => st.put({ recId: id, seq, blob: e.data, at: Date.now(), online: navigator.onLine, visible: document.visibilityState === 'visible' })); } catch (x) { rec.error = `chunk write failed: ${x.name}`; ev(rec.error); }
    };
    mr.onerror = (e) => { rec.error = `MediaRecorder error: ${e.error?.name ?? 'unknown'}`; ev(rec.error); };
    mr.onpause = () => ev('recorder paused (by the browser?)'); mr.onresume = () => ev('recorder resumed'); mr.onstart = () => ev('recorder started');
    mr.onstop = () => finalizeRec(rec);
    mr.start(1000); render();
  }
  function stopRec() { const rec = S.rec; if (!rec) return; try { if (rec.mr.state !== 'inactive') rec.mr.stop(); } catch (e) { ev(`stop failed ${e.name}`); } }
  async function finalizeRec(rec) {
    const ms = Math.round(performance.now() - rec.startedAt); const type = rec.mr.mimeType || rec.chunkType || '';
    const blob = new Blob(rec.blobs, { type }); const perMin = ms > 0 ? Math.round(blob.size / (ms / 60000)) : null;
    const out = { id: rec.id, mime: type, requested: rec.requested, chunkType: rec.chunkType ?? null, bytes: blob.size, durationMs: ms, chunks: rec.chunks, expectedChunks: Math.floor(ms / 1000), maxGapMs: rec.maxGapMs, bytesPerMinute: perMin, kbPerMinute: perMin == null ? null : Math.round(perMin / 1024), startedOnline: rec.startedOnline, endedOnline: navigator.onLine, hiddenDuringRecording: rec.hidden, stormTicksDuringRecording: S.stormTicks - rec.stormTicksAtStart, error: rec.error, events: rec.events.slice(-40) };
    out.verdict = out.error ? 'ERROR' : (out.maxGapMs > 3000 ? 'GAPS' : 'CLEAN');
    try { await run('recordings', 'readwrite', (st) => st.put({ id: rec.id, mime: type, bytes: blob.size, durationMs: ms, chunks: rec.chunks, savedAt: Date.now(), startedOnline: rec.startedOnline, endedOnline: navigator.onLine })); } catch (x) { out.error = `final record write failed: ${x.name}`; out.verdict = 'ERROR'; }
    S.last = rec.id; S.rec = null; ev(`record STOP bytes=${blob.size} ms=${ms}`);
    await loadList(); play(blob, rec.id, 'just recorded'); await report(rec.startedOnline ? 'record-online' : 'record-offline', out);
  }

  // ---- list / recovery / playback ----------------------------------------------------------------------------------------------------------------------------------------------
  async function loadList() {
    const [chunks, finals] = await Promise.all([getAll('chunks'), getAll('recordings')]); const by = new Map();
    for (const c of chunks) { const e = by.get(c.recId) ?? { id: c.recId, chunks: 0, bytes: 0, mime: c.blob.type, final: false, firstAt: c.at }; e.chunks += 1; e.bytes += c.blob.size; by.set(c.recId, e); }
    for (const f of finals) { const e = by.get(f.id); if (e) { e.final = true; e.durationMs = f.durationMs; e.startedOnline = f.startedOnline; } }
    S.recs = [...by.values()].sort((a, b) => b.firstAt - a.firstAt); render();
  }
  async function blobOf(id) { const all = (await getAll('chunks')).filter((c) => c.recId === id).sort((a, b) => a.seq - b.seq); return new Blob(all.map((c) => c.blob), { type: all[0]?.blob.type ?? '' }); }
  function play(blob, id, why) {
    if (S.player) { try { URL.revokeObjectURL(S.player); } catch { /* ignore */ } }
    S.player = URL.createObjectURL(blob);
    const box = $('#player'); box.innerHTML = `<div>${esc(id)} (${esc(why)}): ${Math.round(blob.size / 1024)} KB, <code>${esc(blob.type || '(no type)')}</code></div><audio id="aud" controls preload="metadata" src="${S.player}" style="width:100%;margin-top:6px"></audio><div id="audinfo" class="muted"></div><div><button data-act="heard" data-id="${esc(id)}">I heard my voice</button> <button data-act="silent" data-id="${esc(id)}">No sound / broken</button></div>`;
    const a = $('#aud'); const info = $('#audinfo');
    a.addEventListener('loadedmetadata', () => { info.textContent = `duration: ${a.duration} s${a.duration === Infinity ? ' (Infinity is normal for MediaRecorder files)' : ''}`; });
    a.addEventListener('error', () => { info.textContent = `PLAYBACK ERROR code ${a.error?.code}`; report('playback-error', { id, code: a.error?.code, message: a.error?.message ?? '', mime: blob.type, verdict: 'ERROR' }); });
  }
  async function playId(id) { const b = await blobOf(id); play(b, id, 'from storage'); }
  async function deleteAll() {
    for (const s of ['chunks', 'recordings', 'scratch']) await run(s, 'readwrite', (st) => st.clear());
    S.recs = []; $('#player').textContent = 'Deleted. Nothing loaded.'; await report('deleted-all', { verdict: 'DONE' }); await loadList();
  }
  async function recoveredReport(label) {
    await loadList(); const total = S.recs.reduce((n, r) => n + r.bytes, 0);
    await report(label, { count: S.recs.length, totalBytes: total, items: S.recs.map((r) => ({ id: r.id, bytes: r.bytes, chunks: r.chunks, mime: r.mime, final: r.final })), swState: S.sw, onLine: navigator.onLine, verdict: S.recs.length ? 'RECOVERED' : 'NOTHING_FOUND' });
  }

  // ---- re-render storm (what a status update does in the real app) -----------------------------------------------------------------------------------------------------------
  function startStorm() { if (S.storm) return; S.stormTicks = 0; S.storm = setInterval(() => { S.stormTicks += 1; render(); }, 400); ev('re-render storm START'); render(); }
  function stopStorm() { if (!S.storm) return; clearInterval(S.storm); S.storm = null; ev(`re-render storm STOP after ${S.stormTicks} renders`); report('rerender-storm', { ticks: S.stormTicks, note: 'see the record-* report for gaps during the storm', verdict: 'DONE' }); render(); }

  // ---- connectivity and lifecycle events -------------------------------------------------------------------------------------------------------------------------------------
  document.addEventListener('visibilitychange', () => { ev(`visibility ${document.visibilityState}`); if (S.rec && document.visibilityState === 'hidden') S.rec.hidden += 1; });
  window.addEventListener('pagehide', () => ev('pagehide')); window.addEventListener('pageshow', () => ev('pageshow')); document.addEventListener('freeze', () => ev('freeze')); document.addEventListener('resume', () => ev('resume'));
  window.addEventListener('online', () => { ev('ONLINE'); flush(); report('reconnect', { onLine: true, note: 'browser reported the network came back', verdict: 'ONLINE' }); }); window.addEventListener('offline', () => { ev('OFFLINE'); render(); });
  setInterval(() => { if (S.rec) render(); }, 1000);

  // ---- screen (rebuilt from state every time) -----------------------------------------------------------------------------------------------------------------------------------
  const STEPS = [['env', '1. Environment'], ['mic-permission', '2. Microphone permission'], ['record-online', '3. Record 30-60 s (online)'], ['playback', '4. Playback'], ['reload-recovered', '5. Reload keeps recordings'], ['record-offline', '6. Record in airplane mode'], ['offline-recovered', '7. Recordings still there offline'], ['reconnect', '8. Back online: results sent'], ['rerender-storm', '9. Re-render storm during recording'], ['storage-write-25MB', '10. Storage write test']];
  let qCount = 0; queued().then((n) => { qCount = n; });
  function render() {
    const rec = S.rec; const elapsed = rec ? Math.round((performance.now() - rec.startedAt) / 1000) : 0;
    const f = formats(); const fmtRows = f ? Object.entries(f).map(([m, v]) => `<tr><td>${esc(m)}</td><td class="${v ? 'ok' : 'bad'}">${v ? 'yes' : 'no'}</td></tr>`).join('') : '<tr><td colspan="2" class="bad">MediaRecorder not available</td></tr>';
    const st = S.storage; queued().then((n) => { if (n !== qCount) { qCount = n; const el = $('#qcount'); if (el) el.textContent = n; } });
    $('#app').innerHTML = `
    <div class="card"><h2>Status</h2>
      <div>Network: <b class="${navigator.onLine ? 'ok' : 'warn'}">${navigator.onLine ? 'ONLINE' : 'OFFLINE'}</b> - app files: <b>${esc(S.sw)}</b> - results sent to PC: <b>${S.reportsSent}</b>, waiting: <b id="qcount">${qCount}</b></div>
      <div class="muted">Storage: ${st ? `${st.usageMB} MB used of about ${st.quotaMB} MB, persistent: ${st.persisted}` : 'not read yet'}</div>
      <div class="muted">Re-render counter: ${S.stormTicks}${S.storm ? ' (running)' : ''}</div></div>
    <div class="card"><h2>Do these in order</h2><table>${STEPS.map(([k, l]) => `<tr><td>${S.steps[k] ? '<span class="ok">done</span>' : '<span class="muted">todo</span>'}</td><td>${esc(l)}</td></tr>`).join('')}</table>
      <p class="muted">Airplane mode: switch it on yourself (steps 6-7), then off (step 8). Keep this page open or reopen it from the browser.</p></div>
    <div class="card"><h2>A. Setup</h2><button data-act="env" class="primary">Run environment check</button><button data-act="mic">Ask for microphone</button><button data-act="persist">Ask browser to keep storage</button>
      <table><tr><td colspan="2" class="muted">Recording formats this browser says it supports</td></tr>${fmtRows}</table></div>
    <div class="card"><h2>B. Record</h2>
      <label class="muted">Format to record with <select data-act="fmt">${Object.keys(FORMAT_CHOICES).map((k) => `<option value="${k}" ${S.formatChoice === k ? 'selected' : ''}>${k === 'default' ? 'browser default (recommended first)' : k}</option>`).join('')}</select></label><br>
      ${rec ? `<button data-act="stop" class="stop">Stop recording</button> <b>${elapsed} s</b> - ${Math.round(rec.bytes / 1024)} KB - ${rec.chunks} chunks - biggest gap ${rec.maxGapMs} ms<div class="muted">Format in use: <code>${esc(rec.mime || '(empty)')}</code></div>` : `<button data-act="start" class="primary">Start recording</button> <span class="muted">Talk for 30-60 seconds, then Stop.</span>`}
      <div class="muted">While recording: try switching to another app, locking the screen for 10 s, then coming back. The report will show any gap.</div>
      <button data-act="${S.storm ? 'stormoff' : 'storm'}">${S.storm ? 'Stop re-render storm' : 'Start re-render storm (simulates status updates)'}</button></div>
    <div class="card"><h2>C. Saved recordings (kept in this browser)</h2>
      ${S.recs.length ? `<table>${S.recs.map((r) => `<tr><td><code>${esc(r.id)}</code><br><span class="muted">${Math.round(r.bytes / 1024)} KB, ${r.chunks} chunks, ${esc(r.mime || '?')}${r.final ? '' : ' <b class="warn">interrupted (recovered)</b>'}</span></td><td><button data-act="play" data-id="${esc(r.id)}">Play</button></td></tr>`).join('')}</table>` : '<div class="muted">None yet.</div>'}
      <button data-act="reload">Reload this page now</button><button data-act="recovered">Report: recordings are here</button><button data-act="recoveredoffline">Report: recordings here (airplane mode)</button></div>
    <div class="card"><h2>D. Storage</h2><button data-act="w5">Write 5 MB test</button><button data-act="w25">Write 25 MB test</button><span class="muted"> (written, timed, then removed)</span></div>
    <div class="card"><h2>E. Results and cleanup</h2><button data-act="flush">Send waiting results now</button><button data-act="delete" class="stop">Delete ALL test recordings</button>
      <pre>${esc(S.events.slice(-14).map((e) => `${(e.t / 1000).toFixed(1)}s ${e.msg}`).join('\n'))}</pre></div>`;
  }

  // ---- events (delegation: survives any re-render) ------------------------------------------------------------------------------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return; const a = b.dataset.act; const id = b.dataset.id;
    try {
      if (a === 'env') await envReport(); else if (a === 'mic') await askMic(); else if (a === 'persist') await persistRequest(); else if (a === 'start') await startRec(); else if (a === 'stop') stopRec();
      else if (a === 'storm') startStorm(); else if (a === 'stormoff') stopStorm(); else if (a === 'play') await playId(id);
      else if (a === 'heard') await report('playback', { id, heard: true, verdict: 'HEARD' }); else if (a === 'silent') await report('playback', { id, heard: false, verdict: 'NO_SOUND' });
      else if (a === 'reload') { await report('reload-requested', { n: S.recs.length }); location.reload(); }
      else if (a === 'recovered') await recoveredReport('reload-recovered'); else if (a === 'recoveredoffline') await recoveredReport('offline-recovered');
      else if (a === 'w5') await storageWrite(5); else if (a === 'w25') await storageWrite(25); else if (a === 'flush') await flush(); else if (a === 'delete') await deleteAll();
    } catch (x) { ev(`${a} failed: ${x.name} ${x.message}`); await report(`error-${a}`, { error: `${x.name}: ${x.message}`, verdict: 'ERROR' }); }
    render();
  });
  document.addEventListener('change', (e) => { const s = e.target.closest('select[data-act="fmt"]'); if (s) { S.formatChoice = s.value; render(); } });

  // ---- start ----------------------------------------------------------------------------------------------------------------------------------------------------------------------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(() => { S.sw = 'cached for offline'; render(); }).catch((e) => { S.sw = `no offline cache (${e.name})`; render(); });
  window.__probe = { askMic, startRec, stopRec, startStorm, stopStorm, loadList, storageWrite, envReport, recoveredReport, flush, deleteAll, state: () => ({ rec: !!S.rec, recs: S.recs.length, steps: Object.keys(S.steps), stormTicks: S.stormTicks, sent: S.reportsSent, sw: S.sw }) };
  render(); loadList().then(() => { if (S.recs.length) ev(`${S.recs.length} saved recording(s) found at page load`); }); envReport(); flush();
})();
