// A small WebSocket session helper for the cloud adapters (Node 24 global WebSocket; custom headers ARE supported and are verified by a test with a local upgrade server). No dependency.
// Audio is paced like a live microphone (pace 1 = real time): the field is a live stream, and some providers require real-time pacing.
import { chunksOf } from './audio.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openSocket(url, { headers = {}, openTimeoutMs = 20000 } = {}) {
  const ws = new WebSocket(url, { headers }); ws.binaryType = 'arraybuffer'; const inbox = []; const waiters = []; let closed = null; let error = null; const t0 = performance.now();
  const push = (m) => { const w = waiters.shift(); if (w) w.res(m); else inbox.push(m); };
  ws.onmessage = (ev) => { const wall = performance.now() - t0; const data = typeof ev.data === 'string' ? ev.data : null; let json = null; if (data) { try { json = JSON.parse(data); } catch { /* not JSON */ } } push({ wall, text: data, json, binary: data === null }); };
  ws.onclose = (ev) => { closed = { code: ev.code, reason: ev.reason }; while (waiters.length) waiters.shift().res(null); };
  ws.onerror = (ev) => { error = ev?.message ?? 'websocket error'; };
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`websocket open timeout: ${url.split('?')[0]}`)), openTimeoutMs); ws.onopen = () => { clearTimeout(t); res(); }; const prev = ws.onclose; ws.onclose = (ev) => { clearTimeout(t); prev(ev); rej(new Error(`websocket closed before open (${ev.code} ${ev.reason}) ${error ?? ''}`)); }; });
  return { ws, t0, closed: () => closed, error: () => error, send: (d) => ws.send(d), next: (timeoutMs = 30000) => new Promise((res) => { if (inbox.length) return res(inbox.shift()); if (closed) return res(null); const w = { res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res({ timeout: true }); } }, timeoutMs); }), close: () => { try { ws.close(); } catch { /* gone */ } } };
}

/** Streams Int16 PCM in `chunkMs` frames at `pace` x real time. `isAborted()` lets a provider stop early (server error). Returns how many bytes/chunks were sent. */
export async function paceAudio(send, pcm16, sampleRate, { chunkMs = 100, pace = 1, isAborted = () => false, onChunk = () => {} } = {}) {
  const start = performance.now(); let sent = 0; let n = 0;
  for (const c of chunksOf(pcm16, sampleRate, chunkMs)) { if (isAborted()) break; const due = start + ((sent / sampleRate) * 1000) / pace; const wait = due - performance.now(); if (wait > 1) await sleep(wait); send(Buffer.from(c.buffer, c.byteOffset, c.byteLength)); sent += c.length; n += 1; onChunk(n, (sent / sampleRate)); }
  return { chunks: n, seconds: sent / sampleRate, startedAtMs: start };
}
