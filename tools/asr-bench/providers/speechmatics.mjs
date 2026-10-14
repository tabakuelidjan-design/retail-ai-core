// Speechmatics Real-time v2 adapter (WebSocket). Protocol: https://docs.speechmatics.com/api-ref/realtime-transcription-websocket (read 2026-10-07).
//   wss://eu.rt.speechmatics.com/v2/, Authorization: Bearer <api key> (or ?jwt=<temporary key>); first message StartRecognition { audio_format raw pcm_s16le, transcription_config { language, operating_point,
//   enable_partials, max_delay, additional_vocab [{ content, sounds_like[] }] } }; wait RecognitionStarted; AddAudio = binary frames; EndOfStream { last_seq_no };
//   results = AddTranscript { metadata{start_time,end_time}, results[{ type, start_time, end_time, alternatives[{content,confidence}] }] }, EndOfTranscript.
import { PROVIDER_META, validateResult, lagMsOf } from '../provider.mjs';
import { openSocket, paceAudio } from '../ws.mjs';

export const DEFAULT_URL = 'wss://eu.rt.speechmatics.com/v2/';
export function buildRequest({ context, language = 'cmn_en', sampleRate = 16000, baseUrl = DEFAULT_URL } = {}) {
  const p = context?.payload ?? {};
  const start = { message: 'StartRecognition', audio_format: { type: 'raw', encoding: 'pcm_s16le', sample_rate: sampleRate }, transcription_config: { language, operating_point: 'enhanced', enable_partials: false, max_delay: 2.0, ...(p.additional_vocab?.length ? { additional_vocab: p.additional_vocab } : {}) } };
  return { url: baseUrl, headers: { Authorization: 'Bearer <SPEECHMATICS_API_KEY>' }, firstMessage: start, audio: 'AddAudio binary frames (100 ms), EndOfStream with last_seq_no', contextApplied: { mechanism: context?.mechanism ?? 'none', payload: p } };
}

export default {
  id: 'speechmatics', model: 'enhanced (cmn_en by default)', meta: PROVIDER_META.speechmatics, buildRequest,
  async transcribe(audio, { pass, context, language = 'cmn_en', pace = 1, apiKey = process.env.SPEECHMATICS_API_KEY, baseUrl = process.env.SPEECHMATICS_WS_URL ?? DEFAULT_URL } = {}) {
    if (!apiKey) throw new Error('SPEECHMATICS_API_KEY is not set');
    const req = buildRequest({ context, language, sampleRate: audio.sampleRate, baseUrl }); const startedAt = new Date().toISOString(); const s = await openSocket(req.url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const errors = []; const segs = []; let events = 0; let started = null; let ended = false; const t0 = s.t0;
    s.send(JSON.stringify(req.firstMessage));
    const reader = (async () => { for (;;) { const m = await s.next(60000); if (!m || m.timeout) break; events += 1; const j = m.json; if (!j) continue; if (j.message === 'Error') { errors.push({ type: j.type, reason: j.reason }); break; } if (j.message === 'RecognitionStarted') started = j.id; else if (j.message === 'AddTranscript') {
      const words = []; for (const r of j.results ?? []) { const alt = r.alternatives?.[0]; if (!alt) continue; if (r.type === 'punctuation') { if (words.length) words[words.length - 1].text += alt.content; } else words.push({ text: alt.content, startSec: r.start_time, endSec: r.end_time, confidence: alt.confidence, finalWallMs: Math.round(m.wall) }); }
      const text = (j.transcript ?? words.map((w) => w.text).join(' ')).replace(/\s+/g, ' ').trim(); if (text) segs.push({ text, startSec: j.metadata?.start_time ?? words[0]?.startSec ?? 0, endSec: j.metadata?.end_time ?? words.at(-1)?.endSec ?? 0, isFinal: true, words, lagMs: lagMsOf(m.wall, j.metadata?.end_time ?? words.at(-1)?.endSec ?? 0, pace) }); } else if (j.message === 'EndOfTranscript') { ended = true; break; } } })();
    for (let i = 0; i < 50 && !started && !errors.length; i++) await new Promise((r) => setTimeout(r, 100));
    let seq = 0; await paceAudio((b) => { s.send(b); seq += 1; }, audio.pcm16, audio.sampleRate, { chunkMs: 100, pace, isAborted: () => errors.length > 0 || !!s.closed() });
    s.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: seq })); await Promise.race([reader, new Promise((r) => setTimeout(r, 60000))]); s.close();
    const finishedAt = new Date().toISOString();
    return validateResult({ provider: 'speechmatics', model: `enhanced/${language}`, mode: 'streaming', pass, audioSha256: audio.sha256, startedAt, finishedAt, wallMs: Math.round(performance.now() - t0), audioSec: audio.durationSec, pace, rawTranscript: segs.map((x) => x.text).join(' '), segments: segs, contextApplied: req.contextApplied, providerMeta: { language, session: started, ended, closed: s.closed() }, events: { messages: events, audioChunks: seq }, errors });
  },
};
