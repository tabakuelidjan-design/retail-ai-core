// AssemblyAI Universal-3.6 Pro Streaming adapter (WebSocket v3). Protocol: https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api (read 2026-10-07).
//   wss://streaming.eu.assemblyai.com/v3/ws?speech_model=universal-3-6-pro&sample_rate=16000&encoding=pcm_s16le[&keyterms_prompt=<JSON array>][&prompt=...]; Authorization: <key> (no "Bearer");
//   audio = binary frames of 50-1000 ms paced at about real time; server messages Begin / Turn { transcript, end_of_turn, words[{text,start,end,confidence}] } / Termination; client messages ForceEndpoint, Terminate.
import { PROVIDER_META, validateResult, lagMsOf } from '../provider.mjs';
import { openSocket, paceAudio } from '../ws.mjs';

export const DEFAULT_URL = 'wss://streaming.eu.assemblyai.com/v3/ws';
/** PURE: the connection URL carries the context; the API key is only in the header. */
export function buildRequest({ context, sampleRate = 16000, baseUrl = DEFAULT_URL } = {}) {
  const q = new URLSearchParams({ speech_model: 'universal-3-6-pro', sample_rate: String(sampleRate), encoding: 'pcm_s16le', format_turns: 'false' });
  const p = context?.payload ?? {}; if (p.keyterms_prompt?.length) q.set('keyterms_prompt', JSON.stringify(p.keyterms_prompt)); if (p.prompt) q.set('prompt', p.prompt);
  return { url: `${baseUrl}?${q.toString()}`, headers: { Authorization: '<ASSEMBLYAI_API_KEY>' }, audio: 'binary frames of pcm_s16le, 100 ms, real-time pace; ForceEndpoint then Terminate at the end', contextApplied: { mechanism: context?.mechanism ?? 'none', payload: p } };
}

export default {
  id: 'assemblyai', model: 'universal-3-6-pro', meta: PROVIDER_META.assemblyai, buildRequest,
  async transcribe(audio, { pass, context, pace = 1, apiKey = process.env.ASSEMBLYAI_API_KEY, baseUrl = process.env.ASSEMBLYAI_WS_URL ?? DEFAULT_URL } = {}) {
    if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY is not set');
    const req = buildRequest({ context, sampleRate: audio.sampleRate, baseUrl }); const startedAt = new Date().toISOString(); const s = await openSocket(req.url, { headers: { Authorization: apiKey } });
    const turns = new Map(); const errors = []; let events = 0; let term = null; let begin = null; const t0 = s.t0;
    const reader = (async () => { for (;;) { const m = await s.next(60000); if (!m || m.timeout) break; events += 1; const j = m.json; if (!j) continue; if (j.error || j.type === 'Error') { errors.push({ message: j.error ?? j.message ?? JSON.stringify(j).slice(0, 200) }); break; } if (j.type === 'Begin') begin = { id: j.id, configuration: j.configuration }; else if (j.type === 'Turn' && j.end_of_turn) turns.set(j.turn_order, { text: j.transcript ?? '', words: (j.words ?? []).map((w) => ({ text: w.text, startSec: w.start / 1000, endSec: w.end / 1000, confidence: w.confidence, finalWallMs: Math.round(m.wall) })), wall: Math.round(m.wall) }); else if (j.type === 'Termination') { term = j; break; } } })();
    await paceAudio((b) => s.send(b), audio.pcm16, audio.sampleRate, { chunkMs: 100, pace, isAborted: () => errors.length > 0 || !!s.closed() });
    s.send(JSON.stringify({ type: 'ForceEndpoint' })); await new Promise((r) => setTimeout(r, 1500)); s.send(JSON.stringify({ type: 'Terminate' })); await Promise.race([reader, new Promise((r) => setTimeout(r, 30000))]); s.close();
    const segs = [...turns.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => { const w = t.words; const st = w.length ? w[0].startSec : 0; const en = w.length ? w[w.length - 1].endSec : st; return { text: t.text.trim(), startSec: st, endSec: en, isFinal: true, words: w, lagMs: lagMsOf(t.wall, en, pace) }; }).filter((x) => x.text);
    const finishedAt = new Date().toISOString();
    return validateResult({ provider: 'assemblyai', model: 'universal-3-6-pro', mode: 'streaming', pass, audioSha256: audio.sha256, startedAt, finishedAt, wallMs: Math.round(performance.now() - t0), audioSec: audio.durationSec, pace, rawTranscript: segs.map((x) => x.text).join(' '), segments: segs, contextApplied: req.contextApplied, providerMeta: { session: begin, termination: term, closed: s.closed(), billedNote: 'AssemblyAI bills the open WebSocket time, idle included' }, events: { messages: events }, errors });
  },
};
