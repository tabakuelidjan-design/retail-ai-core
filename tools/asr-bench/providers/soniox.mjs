// Soniox stt-rt-v5 real-time adapter (WebSocket). Protocol: https://soniox.com/docs/stt/api-reference/websocket-api (read 2026-10-07).
//   wss://stt-rt.soniox.com/transcribe-websocket, Authorization: Bearer <key>; first message = JSON configuration; audio = binary frames; an EMPTY TEXT frame ends the stream;
//   responses = { tokens: [{ text, start_ms, end_ms, confidence, is_final }], ... } and finally { finished: true }.
import { LABEL, PROVIDER_META, validateResult, wordsToSegments, lagMsOf } from '../provider.mjs';
import { openSocket, paceAudio } from '../ws.mjs';

export const URL_RT = 'wss://stt-rt.soniox.com/transcribe-websocket';
/** PURE: exactly what is sent (the API key is never part of it). */
export function buildRequest({ context, language = ['en'], sampleRate = 16000 } = {}) {
  const config = { model: 'stt-rt-v5', audio_format: 's16le', sample_rate: sampleRate, num_channels: 1, language_hints: language, enable_endpoint_detection: false, ...(context?.payload ?? {}) };
  return { url: URL_RT, headers: { Authorization: 'Bearer <SONIOX_API_KEY>' }, firstMessage: config, audio: 'binary frames of s16le mono, then an empty text frame', contextApplied: { mechanism: context?.mechanism ?? 'none', payload: context?.payload ?? {} } };
}

export default {
  id: 'soniox', model: 'stt-rt-v5', meta: PROVIDER_META.soniox, buildRequest,
  async transcribe(audio, { pass, context, language = ['en'], pace = 1, apiKey = process.env.SONIOX_API_KEY } = {}) {
    if (!apiKey) throw new Error('SONIOX_API_KEY is not set');
    const req = buildRequest({ context, language, sampleRate: audio.sampleRate }); const startedAt = new Date().toISOString(); const s = await openSocket(req.url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const tokens = []; const errors = []; let finished = false; let events = 0; const t0 = s.t0;
    s.send(JSON.stringify(req.firstMessage));
    const reader = (async () => { for (;;) { const m = await s.next(60000); if (!m || m.timeout) break; events += 1; const j = m.json; if (!j) continue; if (j.error_code) { errors.push({ code: j.error_code, type: j.error_type, message: j.error_message }); break; } for (const t of j.tokens ?? []) if (t.is_final && t.text !== undefined) tokens.push({ text: t.text, startSec: (t.start_ms ?? 0) / 1000, endSec: (t.end_ms ?? 0) / 1000, confidence: t.confidence, finalWallMs: Math.round(m.wall), isEnd: t.text === '<end>' }); if (j.finished) { finished = true; break; } } })();
    await paceAudio((b) => s.send(b), audio.pcm16, audio.sampleRate, { chunkMs: 100, pace, isAborted: () => errors.length > 0 || !!s.closed() });
    s.send(''); await Promise.race([reader, new Promise((r) => setTimeout(r, 60000))]); s.close();
    const words = tokens.filter((t) => !t.isEnd); // Soniox tokens are sub-words: text is concatenated as delivered (leading spaces are part of the token text)
    const segments = []; let cur = null; for (const w of words) { if (!cur || w.startSec - cur.endSec > 1.0) { if (cur) segments.push(cur); cur = { startSec: w.startSec, endSec: w.endSec, parts: [], words: [] }; } cur.parts.push(w.text); cur.words.push(w); cur.endSec = Math.max(cur.endSec, w.endSec); } if (cur) segments.push(cur);
    const segs = segments.map((c) => ({ text: c.parts.join('').replace(/\s+/g, ' ').trim(), startSec: c.startSec, endSec: c.endSec, isFinal: true, words: c.words.map((w) => ({ text: w.text, startSec: w.startSec, endSec: w.endSec, confidence: w.confidence, finalWallMs: w.finalWallMs })), lagMs: lagMsOf(Math.max(...c.words.map((w) => w.finalWallMs)), c.endSec, pace) }));
    const finishedAt = new Date().toISOString(); void LABEL; void wordsToSegments;
    return validateResult({ provider: 'soniox', model: 'stt-rt-v5', mode: 'streaming', pass, audioSha256: audio.sha256, startedAt, finishedAt, wallMs: Math.round(performance.now() - t0), audioSec: audio.durationSec, pace, rawTranscript: segs.map((x) => x.text).join(' '), segments: segs, contextApplied: req.contextApplied, providerMeta: { language, finished, closed: s.closed(), joinMode: "concat" }, events: { messages: events }, errors });
  },
};
