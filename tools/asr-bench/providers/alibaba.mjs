// Alibaba Cloud Model Studio Fun-ASR-Realtime adapter (DashScope WebSocket, Singapore). Documentation read 2026-10-07: https://www.alibabacloud.com/help/en/model-studio/fun-asr-realtime-websocket-api
// WHAT IS VERIFIED: endpoint form wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference, header "Authorization: Bearer <key>", flow run-task -> task-started -> binary mono audio -> result-generated -> finish-task -> task-finished;
//   hotwords = vocabulary (text <= 7 ASCII words, weight 1-5, optional lang) created through the vocabulary service and referenced by id.
// WHAT IS NOT: the exact JSON field names below follow the DashScope SDK conventions (header.action/task_id/streaming, payload.task_group/task/function/model/parameters/input; output.sentence{begin_time,end_time,text,words,sentence_end})
//   and the vocabulary HTTP body (model "speech-biasing", input.action create_vocabulary): the official pages with the JSON could not be fetched. They stay UNVERIFIED until the first live run, and any task-failed is reported as it is.
import { randomBytes } from 'node:crypto';
import { PROVIDER_META, validateResult, lagMsOf } from '../provider.mjs';
import { openSocket, paceAudio } from '../ws.mjs';

const MODEL = 'fun-asr-realtime';
export const wsUrl = (env = process.env) => env.ALIBABA_WS_URL ?? (env.ALIBABA_WORKSPACE_ID ? `wss://${env.ALIBABA_WORKSPACE_ID}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference` : 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference');
export const httpBase = (env = process.env) => env.ALIBABA_HTTP_BASE ?? (env.ALIBABA_WORKSPACE_ID ? `https://${env.ALIBABA_WORKSPACE_ID}.ap-southeast-1.maas.aliyuncs.com/api/v1` : 'https://dashscope-intl.aliyuncs.com/api/v1');
export const taskId = () => randomBytes(16).toString('hex');
/** PURE */
export function buildRequest({ context, language = ['en'], sampleRate = 16000, vocabularyId = null, task = taskId(), env = process.env } = {}) {
  const run = { header: { action: 'run-task', task_id: task, streaming: 'duplex' }, payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: MODEL, parameters: { format: 'pcm', sample_rate: sampleRate, language_hints: language, ...(vocabularyId ? { vocabulary_id: vocabularyId } : {}) }, input: {} } };
  const vocab = context?.payload?.vocabulary?.length ? { method: 'POST', url: `${httpBase(env)}/services/audio/asr/customization`, body: { model: 'speech-biasing', input: { action: 'create_vocabulary', target_model: MODEL, prefix: 'nordb', vocabulary: context.payload.vocabulary } } } : null;
  return { url: wsUrl(env), headers: { Authorization: 'Bearer <ALIBABA_API_KEY>' }, firstMessage: run, finishMessage: { header: { action: 'finish-task', task_id: task, streaming: 'duplex' }, payload: { input: {} } }, vocabularyRequest: vocab, audio: 'binary mono pcm frames (100 ms), then finish-task', contextApplied: { mechanism: context?.mechanism ?? 'none', payload: context?.payload ?? {} } };
}

export default {
  id: 'alibaba', model: MODEL, meta: PROVIDER_META.alibaba, buildRequest,
  async transcribe(audio, { pass, context, language = ['en'], pace = 1, apiKey = process.env.ALIBABA_API_KEY, env = process.env } = {}) {
    if (!apiKey) throw new Error('ALIBABA_API_KEY is not set');
    const startedAt = new Date().toISOString(); let vocabularyId = null; const errors = [];
    let req = buildRequest({ context, language, sampleRate: audio.sampleRate, env });
    if (req.vocabularyRequest) { const r = await fetch(req.vocabularyRequest.url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(req.vocabularyRequest.body) }); const j = await r.json().catch(() => ({})); vocabularyId = j?.output?.vocabulary_id ?? null; if (!vocabularyId) throw new Error(`vocabulary creation failed (${r.status}): ${JSON.stringify(j).slice(0, 300)}`); req = buildRequest({ context, language, sampleRate: audio.sampleRate, vocabularyId, env }); }
    const s = await openSocket(req.url, { headers: { Authorization: `Bearer ${apiKey}` } }); const sentences = new Map(); let events = 0; let started = false; let finished = false; const t0 = s.t0;
    const reader = (async () => { for (;;) { const m = await s.next(60000); if (!m || m.timeout) break; events += 1; const j = m.json; if (!j) continue; const ev = j.header?.event; if (ev === 'task-failed') { errors.push({ code: j.header.error_code, message: j.header.error_message }); break; } if (ev === 'task-started') started = true; else if (ev === 'result-generated') { const sen = j.payload?.output?.sentence; if (sen && !sen.heartbeat && sen.sentence_end) sentences.set(sen.begin_time, { ...sen, wall: Math.round(m.wall) }); } else if (ev === 'task-finished') { finished = true; break; } } })();
    s.send(JSON.stringify(req.firstMessage)); for (let i = 0; i < 100 && !started && !errors.length; i++) await new Promise((r) => setTimeout(r, 100));
    if (started) await paceAudio((b) => s.send(b), audio.pcm16, audio.sampleRate, { chunkMs: 100, pace, isAborted: () => errors.length > 0 || !!s.closed() });
    s.send(JSON.stringify(req.finishMessage)); await Promise.race([reader, new Promise((r) => setTimeout(r, 60000))]); s.close();
    if (vocabularyId) { try { await fetch(`${httpBase(env)}/services/audio/asr/customization`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'speech-biasing', input: { action: 'delete_vocabulary', vocabulary_id: vocabularyId } }) }); } catch { /* the list is only a temporary benchmark artefact */ } }
    const segs = [...sentences.values()].sort((a, b) => a.begin_time - b.begin_time).map((x) => { const words = (x.words ?? []).map((w) => ({ text: `${w.text ?? ''}${w.punctuation ?? ''}`, startSec: w.begin_time / 1000, endSec: w.end_time / 1000, finalWallMs: x.wall })); return { text: String(x.text ?? '').trim(), startSec: x.begin_time / 1000, endSec: x.end_time / 1000, isFinal: true, words, lagMs: lagMsOf(x.wall, x.end_time / 1000, pace) }; }).filter((x) => x.text);
    const finishedAt = new Date().toISOString();
    return validateResult({ provider: 'alibaba', model: MODEL, mode: 'streaming', pass, audioSha256: audio.sha256, startedAt, finishedAt, wallMs: Math.round(performance.now() - t0), audioSec: audio.durationSec, pace, rawTranscript: segs.map((x) => x.text).join(' '), segments: segs, contextApplied: { ...req.contextApplied, vocabularyId }, providerMeta: { language, started, finished, protocolStatus: PROVIDER_META.alibaba.protocolStatus, closed: s.closed() }, events: { messages: events }, errors });
  },
};
