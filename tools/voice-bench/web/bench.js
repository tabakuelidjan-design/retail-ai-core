// Voice benchmark runner (isolated). It produces ONLY raw engine outputs and timings; understanding metrics are computed afterwards by tools/voice-bench/eval.mjs with the real Nordla modules.
// Modes (query string):  mode=acc  (fast replay of every clip x condition: transcripts)   mode=lat (real-time replay of the clean clips: latency, first partial, speed factor)
//                        mode=endurance&minutes=10 (continuous real-time scenario loop: speed drift, heap)   mode=all (acc, then lat, then endurance for each engine, in one page load)
//                        engines=moonshine-en,whisper-en   tag=<name>   auto (start by itself)   conds=...
import { loadMoonshine, loadWhisper, fetchWav, envReport } from './engines.js';
const q = new URLSearchParams(location.search); const mode = q.get('mode') || 'acc'; const tag = q.get('tag') || `bench-${mode}`; const engines = (q.get('engines') || 'moonshine-en,whisper-en').split(','); const minutes = Number(q.get('minutes') || 10);
const conds = (q.get('conds') || 'clean,babble-snr20,babble-snr10,babble-snr5,machine-snr10,machine-snr5').split(',');
const BOOST = q.get('boost'); // Moonshine key-term boost (string), measured in the LAB sweep; absent = the engine default
const KEYTERMS = ['FOB', 'EXW', 'DDP', 'MOQ', 'USD', 'RoHS', 'CE', 'UN38.3', 'power bank', 'deposit', 'balance', 'lead time'];
const log = (m) => { const e = document.getElementById('log'); e.textContent += m + '\n'; e.scrollTop = e.scrollHeight; };
const st = (m) => { document.getElementById('st').textContent = m; };
const outs = {}; const boostNote = BOOST ? `moonshine key-term boost ${BOOST}` : 'default boost'; const newOut = (name, m) => (outs[name] = { tag: name, mode: m, config: boostNote, startedAt: new Date().toISOString(), engines, runs: [], samples: [], errors: [] });
const send = async (o, final = false) => { o.finishedAt = final ? new Date().toISOString() : null; try { await fetch(`/api/result?name=${encodeURIComponent(o.tag)}`, { method: 'POST', body: JSON.stringify(o) }); } catch (e) { log('send failed ' + e); } };
let wake = null; try { wake = await navigator.wakeLock?.request('screen'); log(wake ? 'screen wake lock held' : 'no wake lock api'); } catch (e) { log('wake lock refused: ' + e); }
async function getEngine(name) { return name.startsWith('moonshine') ? loadMoonshine(name.endsWith('zh') ? 'zh' : 'en', log, BOOST ? { keyterm_boost: BOOST } : {}) : loadWhisper(log); }
const optsFor = (name, extra = {}) => (name.startsWith('moonshine') ? { keyterms: KEYTERMS, ...extra } : { language: 'english', ...extra });

async function runClips(o, eng, name, use, realtime, ids) {
  let n = 0; const total = use.length * ids.length;
  for (const cond of use) for (const id of ids) {
    st(`${name} ${realtime ? 'lat' : 'acc'} ${cond} ${id} (${++n}/${total})`);
    try { const pcm = await fetchWav(`/corpus-audio/${cond}/${id}.wav`); const r = await eng.run(pcm, optsFor(name, { realtime })); o.runs.push({ engine: name, cond, id, ...r, lines: undefined, nLines: r.lines.length }); }
    catch (e) { o.errors.push({ engine: name, cond, id, error: String(e?.message ?? e) }); log(`FAIL ${name} ${cond} ${id}: ${e}`); }
    if (o.runs.length % 15 === 0) await send(o);
  }
}
async function endurance(o, eng, name, ids) {
  const t0 = performance.now(); let pass = 0; let bucket = []; let lastSample = t0;
  while ((performance.now() - t0) / 60000 < minutes) {
    for (const id of ids) {
      if ((performance.now() - t0) / 60000 >= minutes) break;
      const pcm = await fetchWav(`/corpus-audio/clean/${id}.wav`); const r = await eng.run(pcm, optsFor(name, { realtime: true, tailSilenceS: 0.6 })); bucket.push(r);
      const now = performance.now();
      if (now - lastSample > 30000) { const heap = eng.raw?.module?.HEAPU8?.length ?? null; const f = bucket.filter((b) => b.finalMs != null); o.samples.push({ engine: name, tSec: Math.round((now - t0) / 1000), rtfAvg: +(bucket.reduce((s, b) => s + b.rtf, 0) / bucket.length).toFixed(3), finalMsAvg: f.length ? Math.round(f.reduce((s, b) => s + b.finalMs, 0) / f.length) : null, utterances: bucket.length, wasmHeapMB: heap ? +(heap / 1048576).toFixed(1) : null }); bucket = []; lastSample = now; st(`${name} endurance ${Math.round((now - t0) / 1000)} s`); await send(o); }
    }
    pass++;
  }
  o.endurancePasses = (o.endurancePasses ?? 0) + pass; o.enduranceMinutes = minutes;
}
async function main() {
  st('loading'); const env = await envReport(); const utter = await (await fetch('/bench/utterances.json')).json(); const ids = [...utter.items.map((i) => i.id), ...utter.scenarioB.map((i) => i.id)]; const scenarioIds = utter.items.map((i) => i.id);
  const modes = mode === 'all' ? ['acc', 'lat', 'endurance'] : [mode];
  for (const m of modes) newOut(mode === 'all' ? `${tag}-${m}` : tag, m);
  for (const o of Object.values(outs)) o.env = env;
  for (const name of engines) {
    let eng; try { eng = await getEngine(name); for (const o of Object.values(outs)) o[`${name}:loadMs`] = Math.round(eng.loadMs); } catch (e) { for (const o of Object.values(outs)) o.errors.push({ engine: name, stage: 'load', error: String(e?.message ?? e) }); log(`FAIL load ${name}: ${e}`); continue; }
    for (const m of modes) {
      const o = outs[mode === 'all' ? `${tag}-${m}` : tag];
      if (m === 'acc') await runClips(o, eng, name, conds, false, ids); else if (m === 'lat') await runClips(o, eng, name, ['clean'], true, ids); else await endurance(o, eng, name, scenarioIds);
      await send(o);
    }
  }
  for (const o of Object.values(outs)) await send(o, true);
  st('DONE'); log('finished');
}
document.getElementById('go').addEventListener('click', () => main().catch((e) => { log('fatal ' + e); for (const o of Object.values(outs)) { o.errors.push({ fatal: String(e) }); send(o, true); } }));
if (q.has('auto')) main().catch((e) => { log('fatal ' + e); for (const o of Object.values(outs)) { o.errors.push({ fatal: String(e) }); send(o, true); } });
