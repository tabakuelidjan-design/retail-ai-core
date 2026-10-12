// FIELD VOICE (first vertical slice): microphone -> on-device Moonshine (the runtime and model that were benchmarked, run in a Worker) -> final transcription lines. English only.
// This module knows NOTHING about Nordla's case: it reports lines through callbacks (onFinal), and app.js turns each one into a SPEECH item (speaker UNKNOWN, machine transcription) that the
// existing extraction / conversation pipeline consumes. No audio is stored or sent anywhere: samples go microphone -> worklet -> engine worker and are dropped; only text leaves this module.
// States: idle | preparing | listening | paused | denied | error. "listening" is announced ONLY once the microphone has really delivered audio to a loaded engine.
// The capture glue (getUserMedia + AudioWorklet + linear resampling to 16 kHz) replaces the package's MicrophoneTranscriber, which builds its worklet from a blob: URL (forbidden by our
// Content-Security-Policy); the engine itself (Transcriber/Stream) is the benchmarked one (the benchmark ran it on the main thread; here it runs in a Worker). EXPERIMENTAL until the physical test.

export const ENGINE = Object.freeze({ id: 'moonshine-tiny-streaming-en', version: 'moonshine-wasm@0.1.5 / tiny-streaming-en quantized_26_08_21', lang: 'en' });
export const TARGET_RATE = 16000;
const FIRST_AUDIO_TIMEOUT_MS = 5000;
const LOAD_TIMEOUT_MS = 180000; // the first start downloads ~65 MB (then the browser keeps them)

/** Linear resampling to 16 kHz mono (same method as the package's own helper). */
export function resampleTo16k(input, inputRate) {
  if (inputRate === TARGET_RATE) return input;
  const ratio = inputRate / TARGET_RATE; const n = Math.floor(input.length / ratio); const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const pos = i * ratio; const idx = Math.floor(pos); const frac = pos - idx; const a = input[idx] ?? 0; const b = input[idx + 1] ?? a; out[i] = a + (b - a) * frac; }
  return out;
}
const rmsOf = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length || 1)); };

/** The benchmarked engine in a Worker. Loaded ONLY when voice is really needed (first tap on "Démarrer"). Contract: newStream(onResult) -> { feed(pcm16k), flush(): Promise<{finals, partial}> }. */
export async function loadMoonshine({ makeWorker = () => new Worker('/voice-engine-worker.js', { type: 'module' }) } = {}) {
  const w = makeWorker(); let onReady = null; let onFail = null; let current = null; let flushWaiter = null; let fail = null; let inflight = 0; let lastSeq = 0;
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'ready') onReady?.(); else if (m.type === 'error') { const err = new Error(`${m.where}: ${m.message}`); if (onFail) onFail(err); else { fail = err; current?.onError?.(err); } }
    else if (m.type === 'result') { inflight = Math.max(0, lastSeq - m.seq); current?.onResult({ finals: m.finals, partial: m.partial }); }
    else if (m.type === 'flushed') { flushWaiter?.({ finals: m.finals, partial: m.partial }); flushWaiter = null; }
  };
  w.onerror = (e) => { const err = new Error(e?.message || 'le moteur vocal a échoué'); if (onFail) onFail(err); else { fail = err; current?.onError?.(err); } };
  try { await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('chargement trop long')), LOAD_TIMEOUT_MS); onReady = () => { clearTimeout(timer); resolve(); }; onFail = (e) => { clearTimeout(timer); reject(e); }; w.postMessage({ type: 'init' }); }); }
  catch (e) { try { w.terminate?.(); } catch { /* gone */ } throw e; }
  onFail = null; onReady = null;
  return {
    /** One continuous stream (START .. STOP). onResult receives {finals, partial}; flush() ends the stream and returns what was still pending. */
    newStream({ onResult, onError }) {
      current = { onResult, onError }; if (fail) onError?.(fail); w.postMessage({ type: 'start' });
      return {
        feed(pcm) { lastSeq += 1; inflight += 1; w.postMessage({ type: 'audio', seq: lastSeq, pcm }, [pcm.buffer]); },
        flush() { return new Promise((resolve) => { const t = setTimeout(() => { flushWaiter = null; resolve({ finals: [], partial: '' }); }, 4000); flushWaiter = (r) => { clearTimeout(t); resolve(r); }; w.postMessage({ type: 'flush' }); }); },
        /** how many chunks the engine has not answered yet (diagnostic: a growing number means the phone cannot keep up) */
        get backlog() { return inflight; },
      };
    },
  };
}

const defaultWake = { async acquire() { try { return (await navigator.wakeLock?.request('screen')) ?? null; } catch { return null; } } };

export function createVoice({ onChange = () => {}, onPartial = () => {}, onFinal = () => {}, onLevel = () => {}, loadEngine = loadMoonshine, getMedia = () => navigator.mediaDevices, makeContext = () => new AudioContext(), makeNode = (ctx) => new AudioWorkletNode(ctx, 'nordla-capture'), workletUrl = '/voice-worklet.js', firstAudioMs = FIRST_AUDIO_TIMEOUT_MS, wake = defaultWake, now = () => Date.now(), uid = () => Math.random().toString(36).slice(2, 10) } = {}) {
  let state = 'idle'; let message = ''; let engine = null; let gen = 0; let sessionId = null; let turn = 0; let startedAt = null;
  let rig = null; let wakeLock = null; let partial = ''; let voiced = false; let streamSeq = 0; let streamId = null;
  const set = (s, m = '') => { state = s; message = m; onChange({ state, message }); };
  const releaseWake = async () => { try { await wakeLock?.release?.(); } catch { /* gone */ } wakeLock = null; };

  /** Each FINAL line of the engine is ONE ASR SEGMENT (text + the engine's own start/duration + when it was received + which engine stream it came from). Grouping segments into turns is core/turns.js. */
  function emitFinals(finals, sid = streamId) {
    for (const f of finals) {
      const raw = typeof f === 'string' ? { text: f } : f; const text = String(raw.text ?? '').replace(/\s+/g, ' ').trim(); if (text.length < 2 || !/[a-z0-9]/i.test(text)) continue; turn += 1; const received = new Date(now()).toISOString();
      onFinal({ text, lang: ENGINE.lang, provider: ENGINE.id, version: ENGINE.version, segment: { startTime: raw.startTime ?? null, duration: raw.duration ?? null, streamId: sid, receivedAt: received }, capture: { sessionId, turn, startedAt, endedAt: received } }); startedAt = received;
    }
  }
  const apply = (my) => (r) => { if (my !== gen) return; if (r.partial !== partial) { partial = r.partial; onPartial(partial); } if (r.finals.length) emitFinals(r.finals); };

  /** Closes the capture graph and the engine stream. `flush` delivers what the engine still holds as final lines. Never throws. */
  async function teardown(flush) {
    const r = rig; rig = null; if (!r) return;
    try { r.node.port.onmessage = null; r.src.disconnect(); r.node.disconnect(); } catch { /* ignore */ }
    try { r.media.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { const fl = await r.session.flush(); if (flush) emitFinals(fl.finals, r.streamId); } catch { /* the engine had nothing */ }
    try { await r.ctx.close(); } catch { /* ignore */ }
    if (partial) { partial = ''; onPartial(''); } if (voiced) { voiced = false; onLevel(false); }
  }
  const failNow = async (my, msg) => { if (my !== gen) return; gen += 1; await teardown(false); set('error', msg); };

  async function open() {
    const my = ++gen; set('preparing', 'Autorisez le micro…');
    let media;
    try { media = await getMedia().getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { if (my !== gen) return; const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError'; return set(denied ? 'denied' : 'error', denied ? 'Micro refusé' : e?.name === 'NotFoundError' ? 'Aucun micro trouvé' : `Micro indisponible (${e?.name ?? e})`); }
    const stopMedia = () => { try { media.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ } };
    if (my !== gen) { stopMedia(); return; }
    set('preparing', engine ? 'Démarrage de l’écoute…' : 'Préparation de la voix… (le premier démarrage télécharge ~65 Mo)');
    try { engine ??= await loadEngine(); } catch (e) { stopMedia(); if (my !== gen) return; return set('error', `Voix indisponible (${String(e?.message ?? e).slice(0, 140)})`); }
    if (my !== gen) { stopMedia(); return; }
    let ctx; let node; let src; let session;
    try {
      streamSeq += 1; streamId = `${sessionId}-st${streamSeq}`; ctx = makeContext(); await ctx.audioWorklet.addModule(workletUrl); session = engine.newStream({ onResult: apply(my), onError: (e) => failNow(my, `La transcription s’est arrêtée (${String(e?.message ?? e).slice(0, 120)})`) }); startedAt = new Date(now()).toISOString();
      src = ctx.createMediaStreamSource(media); node = makeNode(ctx);
    } catch (e) { stopMedia(); try { await ctx?.close(); } catch { /* ignore */ } return my === gen ? set('error', `Capture impossible (${String(e?.message ?? e).slice(0, 140)})`) : undefined; }
    if (my !== gen) { stopMedia(); try { await ctx.close(); } catch { /* ignore */ } return; }
    let heard = false; const timer = setTimeout(() => { if (!heard) failNow(my, 'Aucun son reçu du micro (est-il utilisé par une autre application ?)'); }, firstAudioMs);
    node.port.onmessage = (ev) => {
      if (my !== gen) return;
      try {
        const pcm = resampleTo16k(ev.data, ctx.sampleRate);
        if (!heard) { heard = true; clearTimeout(timer); set('listening', 'Écoute en cours'); }
        const v = rmsOf(pcm) > 0.012; if (v !== voiced) { voiced = v; onLevel(v); }
        session.feed(pcm);
      } catch (e) { clearTimeout(timer); failNow(my, `La transcription s’est arrêtée (${String(e?.message ?? e).slice(0, 120)})`); }
    };
    src.connect(node); node.connect(ctx.destination); rig = { media, ctx, src, node, session, streamId };
    wakeLock = await wake.acquire();
  }

  return {
    get state() { return state; }, get message() { return message; }, get sessionId() { return sessionId; }, get backlog() { return rig?.session?.backlog ?? 0; },
    /** Must be called from the tap itself (user gesture): the microphone permission is asked here, explicitly. */
    async start() { if (state === 'preparing' || state === 'listening') return; sessionId = `cap-${uid()}`; turn = 0; await open(); },
    async pause() { if (state !== 'listening' && state !== 'preparing') return; gen += 1; await teardown(true); await releaseWake(); set('paused', 'Écoute en pause'); },
    async resume() { if (state !== 'paused' && state !== 'denied' && state !== 'error') return; if (!sessionId) sessionId = `cap-${uid()}`; await open(); },
    async stop() { gen += 1; await teardown(true); await releaseWake(); if (state !== 'idle') set('idle', ''); },
    /** The engine stays loaded between sessions (no second download). */
    get engineLoaded() { return !!engine; },
  };
}
