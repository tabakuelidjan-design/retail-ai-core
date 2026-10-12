// FIELD VOICE - the microphone lifecycle (voice.js) with TEST DOUBLES for the browser APIs and the engine: permission, denial, preparing/listening honesty, pause/resume/stop, final lines with
// capture provenance, release of the microphone, no audio leaving the module. These do NOT replace the physical test on the phone (see docs / the e2e with a real engine and a fake capture device).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoice, resampleTo16k, ENGINE } from '../src/sourcing/ui/voice.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
function rig({ media = 'ok', engineFail = false, silent = false, firstAudioMs = 60 } = {}) {
  const log = { states: [], finals: [], partials: [], gum: 0, trackStops: 0, ctxClosed: 0, engineLoads: 0, streams: 0, fed: [], flushes: 0, wakeAcquired: 0, wakeReleased: 0 };
  let port = null; let cur = null;
  const stream = { getTracks: () => [{ stop: () => { log.trackStops += 1; } }] };
  const getMedia = () => ({ getUserMedia: async () => { log.gum += 1; if (media === 'denied') throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); if (media === 'none') throw Object.assign(new Error('no'), { name: 'NotFoundError' }); return stream; } });
  const makeContext = () => ({ sampleRate: 48000, audioWorklet: { addModule: async () => {} }, createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), destination: {}, close: async () => { log.ctxClosed += 1; } });
  const makeNode = () => { const n = { port: { onmessage: null }, connect() {}, disconnect() {} }; port = n.port; return n; };
  const loadEngine = async () => { log.engineLoads += 1; if (engineFail) throw new Error('model files missing'); return { newStream({ onResult }) { log.streams += 1; cur = onResult; return { feed(pcm) { log.fed.push(pcm.length); }, flush: async () => { log.flushes += 1; return { finals: ['  And the delivery is thirty days.  '], partial: '' }; }, backlog: 0 }; } }; };
  const wake = { acquire: async () => { log.wakeAcquired += 1; return { release: async () => { log.wakeReleased += 1; } }; } };
  const v = createVoice({ onChange: (x) => log.states.push(x.state), onFinal: (x) => log.finals.push(x), onPartial: (t) => log.partials.push(t), loadEngine, getMedia, makeContext, makeNode, wake, firstAudioMs, uid: () => 'abc123', now: () => Date.parse('2026-10-06T10:00:00.000Z') });
  const chunk = () => port.onmessage({ data: new Float32Array(2048).fill(silent ? 0 : 0.1) });
  return { v, log, chunk, result: (r) => cur(r), port: () => port };
}

test('permission DENIED: state "denied", no engine is loaded or downloaded, nothing listens', async () => {
  const r = rig({ media: 'denied' }); await r.v.start();
  assert.equal(r.v.state, 'denied'); assert.equal(r.v.message, 'Micro refusé'); assert.equal(r.log.engineLoads, 0, 'no ~66 MB load for a microphone that was refused'); assert.ok(!r.log.states.includes('listening'));
});

test('no microphone / other errors are reported as errors, never as listening', async () => {
  const r = rig({ media: 'none' }); await r.v.start(); assert.equal(r.v.state, 'error'); assert.match(r.v.message, /Aucun micro/);
});

test('"listening" is announced ONLY after the microphone really delivers audio to a loaded engine: preparing -> (engine loaded) -> still preparing -> first chunk -> listening', async () => {
  const r = rig(); await r.v.start(); assert.equal(r.v.state, 'preparing', 'microphone granted and engine loaded, but no sound yet: NOT listening'); assert.equal(r.log.engineLoads, 1); assert.ok(!r.log.states.includes('listening'));
  r.chunk(); assert.equal(r.v.state, 'listening'); assert.equal(r.log.states.filter((s) => s === 'listening').length, 1);
});

test('the engine is only asked AFTER the microphone is granted (explicit permission first, load on demand)', async () => {
  const r = rig({ media: 'denied' }); await r.v.start(); assert.equal(r.log.gum, 1); assert.equal(r.log.engineLoads, 0);
});

test('engine failure: state error with the reason, the microphone is released', async () => {
  const r = rig({ engineFail: true }); await r.v.start(); assert.equal(r.v.state, 'error'); assert.match(r.v.message, /Voix indisponible/); assert.equal(r.log.trackStops, 1, 'microphone released');
});

test('no sound within the timeout: error, microphone released (never a silent "listening")', async () => {
  const r = rig({ firstAudioMs: 30 }); await r.v.start(); await tick(80); assert.equal(r.v.state, 'error'); assert.match(r.v.message, /Aucun son/); assert.ok(r.log.trackStops >= 1);
});

test('audio goes 48 kHz -> 16 kHz mono -> engine; final lines become onFinal with capture provenance (session, turn, times, provider, version, language)', async () => {
  const r = rig(); await r.v.start(); r.chunk(); assert.equal(r.log.fed[0], Math.floor(2048 / 3), 'resampled 48 kHz -> 16 kHz');
  r.result({ finals: ['  The model number is X25.  ', ''], partial: 'the minimum' });
  assert.deepEqual(r.log.partials.at(-1), 'the minimum'); assert.equal(r.log.finals.length, 1); const f = r.log.finals[0];
  assert.equal(f.text, 'The model number is X25.'); assert.equal(f.lang, 'en'); assert.equal(f.provider, ENGINE.id); assert.equal(f.version, ENGINE.version);
  assert.deepEqual({ sessionId: f.capture.sessionId, turn: f.capture.turn }, { sessionId: 'cap-abc123', turn: 1 }); assert.ok(f.capture.startedAt && f.capture.endedAt);
  assert.ok(!('audio' in f) && !('pcm' in f), 'only text leaves the module');
  r.result({ finals: ['Okay.', '.', ' '], partial: '' }); assert.deepEqual(r.log.finals.map((x) => x.capture.turn), [1, 2], 'noise-only lines are dropped, turns are consecutive');
});

test('PAUSE releases the microphone and the engine stream, flushes what was pending as a final line, keeps the engine loaded', async () => {
  const r = rig(); await r.v.start(); r.chunk(); await r.v.pause();
  assert.equal(r.v.state, 'paused'); assert.equal(r.log.trackStops, 1, 'the microphone is OFF while paused'); assert.equal(r.log.ctxClosed, 1); assert.equal(r.log.flushes, 1); assert.equal(r.log.finals.at(-1).text, 'And the delivery is thirty days.'); assert.equal(r.log.wakeReleased, 1); assert.equal(r.v.engineLoaded, true);
});

test('RESUME asks the microphone again, reuses the loaded engine (no second load), starts a NEW stream, keeps the same capture session and turn counter', async () => {
  const r = rig(); await r.v.start(); r.chunk(); r.result({ finals: ['One.'], partial: '' }); await r.v.pause(); const turnBefore = r.log.finals.at(-1).capture.turn;
  await r.v.resume(); assert.equal(r.v.state, 'preparing'); r.chunk(); assert.equal(r.v.state, 'listening'); assert.equal(r.log.engineLoads, 1); assert.equal(r.log.streams, 2); assert.equal(r.log.gum, 2);
  r.result({ finals: ['Two.'], partial: '' }); const last = r.log.finals.at(-1); assert.equal(last.capture.sessionId, 'cap-abc123'); assert.equal(last.capture.turn, turnBefore + 1);
});

test('STOP releases everything and ends idle; audio arriving after stop is ignored', async () => {
  const r = rig(); await r.v.start(); r.chunk(); await r.v.stop(); assert.equal(r.v.state, 'idle'); assert.equal(r.log.trackStops, 1); assert.equal(r.log.ctxClosed, 1);
  assert.equal(r.port().onmessage, null, 'the capture handler is detached: a late chunk cannot reach the engine'); const n = r.log.fed.length; r.result({ finals: ['late'], partial: '' }); assert.equal(r.log.finals.filter((x) => x.text === 'late').length, 0, 'a late engine result is ignored'); assert.equal(r.log.fed.length, n);
});

test('stopping while still preparing cancels cleanly: the microphone is released and nothing listens', async () => {
  const r = rig(); const p = r.v.start(); await r.v.stop(); await p; assert.equal(r.v.state, 'idle'); assert.ok(r.log.trackStops >= 1);
});

test('a retry after a refusal works (denied -> resume -> listening) once the permission is given', async () => {
  const r = rig({ media: 'denied' }); await r.v.start(); assert.equal(r.v.state, 'denied');
  const ok = rig(); await ok.v.start(); await ok.v.pause(); await ok.v.resume(); ok.chunk(); assert.equal(ok.v.state, 'listening');
});

test('resampling: 48 kHz -> 16 kHz is linear and length-exact; 16 kHz passes through untouched', () => {
  const inp = Float32Array.from({ length: 4800 }, (_, i) => i / 4800); const out = resampleTo16k(inp, 48000); assert.equal(out.length, 1600); assert.ok(Math.abs(out[800] - inp[2400]) < 1e-6);
  const same = new Float32Array(10); assert.equal(resampleTo16k(same, 16000), same);
});
