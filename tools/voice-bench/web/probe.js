import { envReport, loadMoonshine, loadWhisper, fetchWav } from './engines.js';
const log = (m) => { document.getElementById('log').textContent += m + '\n'; };
const params = new URLSearchParams(location.search); const tag = params.get('tag') || 'probe';
const result = { tag, startedAt: new Date().toISOString(), steps: [], errors: [] };
async function step(name, fn) {
  const t0 = performance.now();
  try { const r = await fn(); result.steps.push({ name, ok: true, ms: Math.round(performance.now() - t0), ...(r ?? {}) }); log(`OK   ${name} ${Math.round(performance.now() - t0)} ms ${JSON.stringify(r ?? {}).slice(0, 400)}`); return r; }
  catch (e) { const err = { name, ok: false, error: String(e?.message ?? e), stack: String(e?.stack ?? '').slice(0, 800) }; result.steps.push(err); result.errors.push(err); log(`FAIL ${name}: ${err.error}`); return null; }
}
async function main() {
  document.getElementById('st').textContent = 'running...';
  result.env = await envReport(); log(JSON.stringify(result.env));
  const pcm = await fetchWav('/corpus-audio/clean/S2.wav');
  let ms = null; await step('moonshine en: load', async () => { ms = await loadMoonshine('en', log); return { loadMs: Math.round(ms.loadMs) }; });
  if (ms) await step('moonshine en: transcribe S2 (real-time)', async () => ms.run(pcm, { realtime: true }));
  // moonshine zh: NOT attempted with this engine (0.1.5 has no tiny-streaming-zh in its catalog and rejects the split-frontend files of that model).
  let wh = null; await step('whisper tiny: load', async () => { wh = await loadWhisper(log); return { loadMs: Math.round(wh.loadMs) }; });
  if (wh) await step('whisper tiny: transcribe S2', async () => wh.run(pcm, { realtime: true }));
  result.finishedAt = new Date().toISOString(); result.ok = result.errors.length === 0;
  document.getElementById('st').textContent = result.ok ? 'DONE: all steps OK' : `DONE with ${result.errors.length} failure(s)`;
  try { await fetch(`/api/result?name=${encodeURIComponent(tag)}`, { method: 'POST', body: JSON.stringify(result) }); log('result sent'); } catch (e) { log('could not send result: ' + e); }
}
document.getElementById('go').addEventListener('click', () => main().catch((e) => log('fatal ' + e)));
if (params.has('auto')) main().catch((e) => log('fatal ' + e));
