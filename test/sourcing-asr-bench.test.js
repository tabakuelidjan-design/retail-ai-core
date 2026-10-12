// ASR PHYSICAL BENCHMARK infrastructure (tools/asr-bench, LAB). These tests prove the METHOD, not any engine: one immutable canonical recording, reproducible derivation, two passes with recorded context,
// exact (no partial credit) identifier scoring, critical facts through Nordla's extractor, context lift, hallucination, raw-vs-resolved identifiers (the ASR text is never rewritten), hard gates, and that
// nothing is sent to a provider without an explicit approval. No network, no key, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, chmodSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseWav, writeWav16, deriveForProvider, sha256Hex, resampleLinear } from '../tools/asr-bench/audio.mjs';
import { buildScript, syntheticIdentifiers, KEY_REFERENCES, canonId } from '../tools/asr-bench/corpus.mjs';
import { buildContext, spokenVariants, nordlaTerms, NO_CONTEXT } from '../tools/asr-bench/context.mjs';
import { storeCanonical, verifyCanonical, loadCanonical, saveReferences, sessionDir, FILES } from '../tools/asr-bench/canonical.mjs';
import { scoreRun, contextLift, verdict, overall, windowsOf, hasLoop, wer, GATES, factHolds } from '../tools/asr-bench/score.mjs';
import { resolveIdentifier } from '../tools/asr-bench/resolve.mjs';
import { PROVIDERS, loadProvider, REQUIREMENTS, PROVIDER_META, validateResult } from '../tools/asr-bench/provider.mjs';
import { openSocket } from '../tools/asr-bench/ws.mjs';
import fake from '../tools/asr-bench/providers/fake.mjs';
import { buildReport } from '../tools/asr-bench/report.mjs';

const script = buildScript();
/** a synthetic canonical recording: low-level noise (the tests never need real speech), markers laid out from the script's own durations */
function makeCanonical(root, session = 'test-session') {
  const rate = 48000; let t = 0; const items = script.items.map((it) => { const m = { itemId: it.id, startSec: Math.round(t * 1000) / 1000 }; t += it.seconds; return m; }); const stopSec = t;
  const x = new Float32Array(Math.round(rate * stopSec)); for (let i = 0; i < x.length; i++) x[i] = 0.01 * Math.sin(i / 37);
  const wav = writeWav16([x], rate); const r = storeCanonical(root, session, { wav, markers: { unit: 'seconds', items, stopSec }, script, device: { userAgent: 'test' }, browserAudioProcessing: { echoCancellation: true } });
  return { dir: r.dir, wav, markers: { items, stopSec }, rate, sha: r.sha256 };
}
const tmp = () => mkdtempSync(join(tmpdir(), 'asr-bench-'));

test('audio: WAV round trip is lossless at 16 bits; the derivation for providers is mono, 16 kHz, reproducible (same SHA-256) and written down', () => {
  const x = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 20) * 0.5); const wav = writeWav16([x], 48000); const p = parseWav(wav); assert.equal(p.sampleRate, 48000); assert.equal(p.channels, 1); assert.equal(p.frames, 4800); assert.ok(Math.abs(p.data[0][100] - x[100]) < 1 / 32000);
  const d1 = deriveForProvider(wav); const d2 = deriveForProvider(wav); assert.equal(d1.sha256, d2.sha256); assert.equal(d1.sampleRate, 16000); assert.equal(d1.pcm16.length, 1600); assert.equal(d1.transformation.from.sha256, sha256Hex(wav)); assert.ok(d1.transformation.steps.some((s) => /resample 48000 -> 16000/.test(s))); assert.equal(d1.transformation.deterministic, true);
  const st = writeWav16([x, x.map((v) => -v)], 16000); const m = deriveForProvider(st); assert.ok(m.transformation.steps.includes('mono = average of channels')); assert.equal(resampleLinear(x, 16000, 16000).length, x.length);
});

test('script: deterministic, 30 synthetic identifiers in 6 patterns, none equal to a key reference, all the required controlled facts and spoken forms, natural topics, silence and noise windows', () => {
  assert.deepEqual(buildScript(), buildScript()); const syn = syntheticIdentifiers(); assert.equal(syn.length, 30); assert.equal(new Set(syn.map((s) => canonId(s.id))).size, 30); assert.equal(new Set(syn.map((s) => s.pattern)).size, 6);
  for (const k of KEY_REFERENCES) assert.ok(!syn.some((s) => canonId(s.id) === canonId(k)));
  assert.ok(syn.every((s) => !/[IO]/.test(s.id.replace(/-/g, ''))), 'no ambiguous I/O in references');
  const kinds = script.items.reduce((a, i) => ({ ...a, [i.kind]: (a[i.kind] ?? 0) + 1 }), {}); assert.ok(kinds.fact >= 14 && kinds.identifier >= 42 && kinds.mixed === 6 && kinds.natural === 8 && kinds.silence === 2 && kinds.noise === 1, JSON.stringify(kinds));
  const types = new Set(script.items.flatMap((i) => (i.expect.facts ?? []).map((f) => f.type))); for (const t of ['moq', 'unitPrice', 'currency', 'incoterm', 'port', 'leadTime', 'deposit', 'balance', 'colourCount', 'cartonQty', 'token', 'power', 'claim', 'capacity', 'tier', 'identifier']) assert.ok(types.has(t), t);
  const says = script.items.map((i) => i.say).filter(Boolean).join(' | '); for (const f of ['R B nine eight zero H B', 'the model is RB nine eighty H B', 'Z F zero twenty four', 'Z F zero four one', 'eight seven five five C', 'eight seven zero nine C', 'The model is RB-980HB and the minimum order quantity is one hundred pieces.']) assert.ok(says.includes(f), f);
  assert.ok(script.estimatedMinutes >= 10 && script.estimatedMinutes <= 16);
});

test('context: PASS A sends NOTHING; PASS B uses each provider\'s documented mechanism only, within its limits, never includes the synthetic identifiers, and records exactly what is sent', () => {
  assert.equal(buildContext('soniox', 'A'), NO_CONTEXT); assert.deepEqual(NO_CONTEXT.payload, {});
  const syn = syntheticIdentifiers().map((s) => s.id); const all = nordlaTerms().all; for (const k of KEY_REFERENCES) assert.ok(all.includes(k)); for (const w of ['MOQ', 'FOB', 'EXW', 'CIF', 'CE', 'RoHS', 'REACH', 'UN38.3', 'USB-C', 'PD']) assert.ok(all.includes(w)); assert.ok(syn.every((s) => !all.includes(s)));
  const so = buildContext('soniox', 'B'); assert.ok(so.payload.context.terms.includes('RB-980HB') && so.payload.context.general.length && typeof so.payload.context.text === 'string');
  const aa = buildContext('assemblyai', 'B'); assert.ok(aa.payload.keyterms_prompt.length <= 100 && aa.payload.keyterms_prompt.every((t) => t.length <= 50) && aa.payload.prompt.length <= 1750);
  const sm = buildContext('speechmatics', 'B'); const rb = sm.payload.additional_vocab.find((v) => v.content === 'RB-980HB'); assert.ok(rb.sounds_like.some((s) => /R B nine eight zero H B/.test(s)), JSON.stringify(rb)); assert.ok(sm.payload.additional_vocab.every((v) => v.content.split(/\s+/).length <= 6));
  const al = buildContext('alibaba', 'B'); assert.ok(al.payload.vocabulary.every((v) => v.weight >= 1 && v.weight <= 5 && v.text.split(/\s+/).length <= 7)); const qw = buildContext('qwen3', 'B'); assert.match(qw.payload.prompt, /RB-980HB/);
  for (const p of ['soniox', 'assemblyai', 'speechmatics', 'alibaba', 'qwen3']) assert.ok(!JSON.stringify(buildContext(p, 'B').payload).match(new RegExp(syn.slice(0, 5).join('|'))), `${p}: synthetic identifiers leaked`);
  assert.throws(() => buildContext('soniox', 'C'), /unknown pass/); assert.throws(() => buildContext('nope', 'B'), /no documented context mechanism/);
  assert.ok(spokenVariants('RB-980HB').some((s) => /^R B nine eight zero H B$/.test(s)) && spokenVariants('RB-980HB').some((s) => /nine eighty/.test(s))); assert.ok(spokenVariants('ZF-024').some((s) => /zero twenty four/.test(s)));
});

test('provider requests are PURE, match the documented shapes, never contain a key, and carry the context verbatim', async () => {
  const ctxB = (p) => buildContext(p, 'B'); const so = (await loadProvider('soniox')).buildRequest({ context: ctxB('soniox') }); assert.equal(so.url, 'wss://stt-rt.soniox.com/transcribe-websocket'); assert.equal(so.firstMessage.model, 'stt-rt-v5'); assert.equal(so.firstMessage.audio_format, 's16le'); assert.equal(so.firstMessage.sample_rate, 16000); assert.ok(so.firstMessage.context.terms.includes('ZF-024')); assert.match(so.headers.Authorization, /<SONIOX/);
  const aa = (await loadProvider('assemblyai')).buildRequest({ context: ctxB('assemblyai') }); const u = new URL(aa.url); assert.equal(u.hostname, 'streaming.eu.assemblyai.com'); assert.equal(u.searchParams.get('speech_model'), 'universal-3-6-pro'); assert.equal(u.searchParams.get('encoding'), 'pcm_s16le'); assert.ok(JSON.parse(u.searchParams.get('keyterms_prompt')).includes('8755C')); assert.ok(!/key=/i.test(aa.url));
  const aA = (await loadProvider('assemblyai')).buildRequest({ context: NO_CONTEXT }); assert.ok(!new URL(aA.url).searchParams.has('keyterms_prompt'), 'PASS A carries no key terms');
  const sm = (await loadProvider('speechmatics')).buildRequest({ context: ctxB('speechmatics') }); assert.equal(sm.url, 'wss://eu.rt.speechmatics.com/v2/'); assert.equal(sm.firstMessage.message, 'StartRecognition'); assert.equal(sm.firstMessage.transcription_config.language, 'cmn_en'); assert.equal(sm.firstMessage.transcription_config.operating_point, 'enhanced'); assert.equal(sm.firstMessage.audio_format.encoding, 'pcm_s16le'); assert.ok(sm.firstMessage.transcription_config.additional_vocab.length > 10);
  const smA = (await loadProvider('speechmatics')).buildRequest({ context: NO_CONTEXT }); assert.ok(!('additional_vocab' in smA.firstMessage.transcription_config));
  const al = (await loadProvider('alibaba')).buildRequest({ context: ctxB('alibaba'), vocabularyId: 'vocab-1', env: { ALIBABA_WORKSPACE_ID: 'ws123' } }); assert.equal(al.url, 'wss://ws123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference'); assert.equal(al.firstMessage.header.action, 'run-task'); assert.equal(al.firstMessage.payload.model, 'fun-asr-realtime'); assert.equal(al.firstMessage.payload.parameters.vocabulary_id, 'vocab-1'); assert.equal(al.finishMessage.header.action, 'finish-task'); assert.equal(al.vocabularyRequest.body.input.action, 'create_vocabulary');
  const qw = (await loadProvider('qwen3')).buildRequest({ context: ctxB('qwen3') }); assert.equal(qw.local, true); const { buildCommand, toWslPath } = await import('../tools/asr-bench/providers/qwen3.mjs'); const cmd = buildCommand({ bin: './qwen_asr', modelDir: 'C:\\m', wavPath: 'C:\\t\\a.wav', prompt: 'Vocabulary: RB-980HB', wsl: true, prefix: 'wsl' }); assert.equal(cmd.cmd, 'wsl'); assert.ok(cmd.args.includes('/mnt/c/m') && cmd.args.includes('--prompt')); assert.equal(toWslPath('C:\\a\\b.wav'), '/mnt/c/a/b.wav');
  for (const r of [so, aa, sm, al]) assert.ok(!JSON.stringify(r).match(/sk-|api[_-]?key["':\s]+[A-Za-z0-9]{20}/i));
});

test('websocket helper: custom headers (Authorization) really reach the server, so the adapters can authenticate without a dependency', async () => {
  const server = http.createServer(); let seen = null; server.on('upgrade', (req, sock) => { seen = req.headers.authorization; const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`); setTimeout(() => sock.destroy(), 80); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const s = await openSocket(`ws://127.0.0.1:${server.address().port}/x`, { headers: { Authorization: 'Bearer k-test' } }); await new Promise((r) => setTimeout(r, 200)); s.close(); server.close(); assert.equal(seen, 'Bearer k-test');
});

test('canonical recording: stored once, read-only, hashed; a second write is refused; a wrong browser hash is refused; any change is detected before a run; the derivation is verified', () => {
  const root = tmp(); try {
    const c = makeCanonical(root); const meta = JSON.parse(readFileSync(join(c.dir, FILES.meta), 'utf8')); assert.equal(meta.audio.sha256, sha256Hex(c.wav)); assert.equal(meta.audio.sampleRate, 48000); assert.equal(meta.audio.channels, 1); assert.equal(meta.audio.format, 'WAVE pcm16'); assert.equal(meta.immutable, true); assert.equal(meta.derivedForProviders.sampleRate, 16000); assert.ok(existsSync(join(c.dir, FILES.sums)));
    assert.throws(() => makeCanonical(root), (e) => e.code === 'EXISTS'); assert.throws(() => storeCanonical(root, 'other', { wav: c.wav, markers: c.markers, script, clientSha256: 'bad' }), (e) => e.code === 'HASH_MISMATCH');
    assert.equal(verifyCanonical(c.dir).ok, true); const loaded = loadCanonical(c.dir); assert.equal(loaded.audio.sha256, c.sha); assert.equal(loaded.audio.sampleRate, 16000); assert.equal(loaded.windows.length, script.items.length); assert.equal(loaded.windows[0].id, 'S1');
    const before = loaded.audio.derivedSha256; assert.equal(loadCanonical(c.dir).audio.derivedSha256, before, 'every provider run gets the same derived audio');
    chmodSync(join(c.dir, FILES.markers), 0o666); writeFileSync(join(c.dir, FILES.markers), '{"items":[]}'); assert.equal(verifyCanonical(c.dir).ok, false); assert.throws(() => loadCanonical(c.dir), /not intact/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- scoring --------------------------------------------------------------------------------------------------------------------------------------------------------------------
const NATURAL_REF = Object.fromEntries(script.items.filter((i) => i.kind === 'natural').map((i, n) => [i.id, `we talk about topic number ${n + 1} and the price is six dollars for five hundred pieces`]));
const win = (markers) => windowsOf(markers.items, markers.stopSec);
async function run(behavior, pass, root) {
  const c = makeCanonical(root, `s-${Math.random().toString(36).slice(2, 8)}`); const loaded = loadCanonical(c.dir); const ctx = buildContext('fake', pass);
  const res = await fake.transcribe(loaded.audio, { pass, context: ctx, windows: loaded.windows, script, references: NATURAL_REF, behavior }); return { res, loaded, ctx };
}
const scoreOf = (x) => scoreRun({ script, windows: x.loaded.windows, references: NATURAL_REF, result: x.res });

test('an oracle engine scores 100% on identifiers (raw and resolved), critical facts and natural speech, no hallucination: the scorer measures what it claims to', async () => {
  const root = tmp(); try { const x = await run({}, 'B', root); const s = scoreOf(x); const m = s.metrics;
    assert.equal(m.identifiers.keyReferences.rate, 1); assert.equal(m.identifiers.synthetic.rate, 1); assert.equal(m.criticalFacts.overall.rate, 1, JSON.stringify(m.criticalFacts.byType)); assert.equal(m.natural.wer, 0); assert.equal(m.hallucination.words, 0); assert.equal(m.stability.loops, 0); assert.equal(m.resolved.keyReferences.rate, 1); assert.equal(m.resolved.confidentWrongKey, 0);
    assert.equal(verdict(s).verdict, 'STRONG CANDIDATE'); assert.equal(overall(['STRONG CANDIDATE']), 'AT LEAST ONE STRONG CANDIDATE'); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('EXACT identifier accuracy has NO partial credit: RB-9808B, RB-98HB and RB-9800HB are all wrong for RB-980HB; spoken forms are read, spacing and hyphens are not errors', () => {
  const fx = (heard) => { const items = [{ id: 'X', kind: 'identifier', section: 'B_KEY_IDENTIFIERS', expect: { identifier: 'RB-980HB' } }]; const r = { provider: 't', model: 'm', pass: 'A', audioSha256: 'x', audioSec: 10, errors: [], rawTranscript: heard, providerMeta: {}, segments: [{ text: heard, startSec: 1, endSec: 2 }] }; return scoreRun({ script: { items }, windows: [{ id: 'X', startSec: 0, endSec: 5 }], references: {}, result: r }).items[0].identifier.rawCorrect; };
  for (const bad of ['RB-9808B', 'RB-98HB', 'RB-9800HB', 'RB 9808B', 'R B nine eight zero H P', 'RB-980H', 'nothing here']) assert.equal(fx(`the model is ${bad}`), false, bad);
  for (const good of ['RB-980HB', 'RB 980 HB', 'rb980hb', 'R B nine eight zero H B', 'RB nine eighty H B', 'the model is RB-980HB.']) assert.equal(fx(good), true, good);
});

test('critical facts are read through Nordla\'s own extractor: a transcript can look fluent and still fail', () => {
  assert.equal(factHolds('The MOQ is one hundred pieces.', { type: 'moq', value: '100' }), true); assert.equal(factHolds('The MOQ is one hundred ten pieces.', { type: 'moq', value: '100' }), false);
  assert.equal(factHolds('Six dollars, FOB Shenzhen.', { type: 'incoterm', value: 'FOB' }), true); assert.equal(factHolds('Six dollars, FOB Shenzen.', { type: 'port', value: 'Shenzhen' }), false);
  assert.equal(factHolds('Payment is thirty percent deposit and seventy percent before shipment.', { type: 'deposit', value: '30' }), true); assert.equal(factHolds('It supports PD sixty five watts.', { type: 'power', value: '65' }), true); assert.equal(factHolds('It supports PD fifteen watts.', { type: 'power', value: '65' }), false);
  assert.equal(factHolds('The battery has UN38.3.', { type: 'claim', value: 'UN383' }), true); assert.equal(factHolds('We have CE, RoHS and REACH.', { type: 'claim', value: 'ROHS' }), true); assert.equal(factHolds('The capacity is twenty thousand milliamp hours.', { type: 'capacity', value: '20000' }), true);
  assert.equal(factHolds('The price for five hundred pieces is six dollars FOB Shenzhen.', { type: 'tier', value: '500', unitPrice: '6' }), true);
});

test('degraded engine: identifier errors are counted exactly; PASS B with working context LIFTS the score and the lift is computed; spillover on never-seen identifiers is reported separately', async () => {
  const root = tmp(); try { const beh = { identifierErrorRate: 0.7, contextLift: 0.9, seed: 3 }; const A = scoreOf(await run(beh, 'A', root)); const B = scoreOf(await run(beh, 'B', root)); const lift = contextLift(A, B);
    assert.ok(A.metrics.identifiers.keyReferences.rate < 0.6, `A ${A.metrics.identifiers.keyReferences.rate}`); assert.ok(B.metrics.identifiers.keyReferences.rate > A.metrics.identifiers.keyReferences.rate); assert.ok(lift.keyReferenceExact > 0.2, JSON.stringify(lift)); assert.ok(Math.abs(lift.syntheticExactSpillover) < 0.2, 'the synthetic identifiers are not in the context: no lift expected');
    assert.notEqual(verdict(B).verdict, 'STRONG CANDIDATE'); assert.equal(overall([verdict(A).verdict, verdict(B).verdict]), 'NO WINNER'); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hallucination in silence/noise windows, loops and errors are measured and block the STRONG verdict; the verdict ladder is REJECT / PROMISING / STRONG CANDIDATE, never "production ready"', async () => {
  const root = tmp(); try { const chat = scoreOf(await run({ silenceChatter: true }, 'B', root)); assert.ok(chat.metrics.hallucination.words >= 3 && chat.metrics.hallucination.events >= 3 && chat.metrics.hallucination.wordsPerMinute > 0); assert.notEqual(verdict(chat).verdict, 'STRONG CANDIDATE'); assert.ok(verdict(chat).reasons.some((r) => /hallucination/.test(r)));
    const loop = scoreOf(await run({ loop: true }, 'B', root)); assert.equal(loop.metrics.stability.loops, 1); assert.ok(verdict(loop).reasons.some((r) => /noLoops/.test(r))); assert.equal(verdict(loop).verdict, 'REJECT');
    assert.equal(hasLoop('the model is the model is the model is the model is x'), true); assert.equal(hasLoop('we have black white blue and pink'), false);
    const bad = scoreOf(await run({ identifierErrorRate: 1, seed: 1 }, 'B', root)); assert.ok(verdict(bad).reasons.some((r) => /keyReferenceExact/.test(r))); assert.notEqual(verdict(bad).verdict, 'STRONG CANDIDATE'); const worst = { metrics: { ...bad.metrics, identifiers: { ...bad.metrics.identifiers, keyReferences: { rate: 0.2 } }, criticalFacts: { ...bad.metrics.criticalFacts, overall: { rate: 0.5 } } } }; assert.equal(verdict(worst).verdict, 'REJECT'); const mid = { metrics: { ...worst.metrics, identifiers: { ...worst.metrics.identifiers, keyReferences: { rate: 0.8 } } } }; assert.equal(verdict(mid).verdict, 'PROMISING'); assert.ok(!/production/i.test(JSON.stringify(verdict(mid))));
    assert.equal(GATES.strong.keyReferenceExactPassB, 0.95); assert.equal(GATES.strong.criticalFactsPassB, 0.95); assert.match(GATES.note, /Do not lower/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('natural speech is scored only against the owner\'s reference transcript: WER from the reference, "referenceMissing" otherwise', async () => {
  const root = tmp(); try { const x = await run({ dropNatural: 0.25 }, 'A', root); const withRef = scoreOf(x); assert.ok(withRef.metrics.natural.wer > 0.1 && withRef.metrics.natural.items === 8); const noRef = scoreRun({ script, windows: x.loaded.windows, references: {}, result: x.res }); assert.equal(noRef.metrics.natural.items, 0); assert.equal(noRef.metrics.natural.referenceMissing, 8); assert.equal(noRef.metrics.natural.wer, null);
    assert.equal(wer('we have four colours', 'we have four colours').wer, 0); assert.equal(wer('price is six dollars', 'price is sixty dollars').errors, 1); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('IDENTIFIER RESOLUTION is a separate metric and never rewrites the ASR: the known reference is only a CANDIDATE to confirm; ambiguity proposes nothing; a confident WRONG proposal is counted', () => {
  const known = [...KEY_REFERENCES]; const r = resolveIdentifier('the model is RB 9808B', known); assert.equal(r.asrEvidence.text, 'the model is RB 9808B'); assert.throws(() => { 'use strict'; r.asrEvidence.text = 'x'; }); assert.equal(r.asrUnchanged, true);
  const near = r.candidates.find((c) => c.source === 'KNOWN_NEAR'); assert.ok(near && near.canonical === 'RB980HB' && near.needsConfirmation === true && /not a correction/.test(near.evidence[0]), JSON.stringify(r.candidates)); assert.equal(r.top.canonical, 'RB980HB');
  const wrong = resolveIdentifier('Z F zero two four', known); assert.equal(wrong.top.canonical, 'ZF024'); // heard ZF-024 exactly: right for ZF-024, a confident-wrong proposal when the expected one was ZF-041
  const items = [{ id: 'X', kind: 'identifier', section: 'B_KEY_IDENTIFIERS', expect: { identifier: 'ZF-041' } }]; const sc = scoreRun({ script: { items }, windows: [{ id: 'X', startSec: 0, endSec: 5 }], references: {}, result: { provider: 't', model: 'm', pass: 'A', audioSha256: 'x', audioSec: 5, errors: [], rawTranscript: '', providerMeta: {}, segments: [{ text: 'Z F zero two four', startSec: 1, endSec: 2 }] } });
  assert.equal(sc.metrics.identifiers.keyReferences.rate, 0); assert.equal(sc.metrics.resolved.keyReferences.rate, 0); assert.equal(sc.metrics.resolved.confidentWrongKey, 1);
  const amb = resolveIdentifier('AB 100', ['AB-101', 'AB-102']); assert.ok(amb.ambiguous && !amb.candidates.some((c) => c.source === 'KNOWN_NEAR')); const none = resolveIdentifier('hello there', known); assert.equal(none.top, null);
  const items2 = [{ id: 'Y', kind: 'identifier', section: 'B_KEY_IDENTIFIERS', expect: { identifier: 'RB-980HB' } }]; const ok = scoreRun({ script: { items: items2 }, windows: [{ id: 'Y', startSec: 0, endSec: 5 }], references: {}, result: { provider: 't', model: 'm', pass: 'A', audioSha256: 'x', audioSec: 5, errors: [], rawTranscript: '', providerMeta: {}, segments: [{ text: 'RB 9808B', startSec: 1, endSec: 2 }] } });
  assert.equal(ok.metrics.identifiers.keyReferences.rate, 0, 'RAW ASR is wrong'); assert.equal(ok.metrics.resolved.keyReferences.rate, 1, 'the RESOLVED candidate is right'); assert.equal(ok.items[0].heard, 'RB 9808B', 'the heard text is untouched');
});

test('report: scores every stored run, states NO WINNER when nothing is STRONG, lists the context actually sent and the data-flow / China table with UNKNOWN left as UNKNOWN', async () => {
  const root = tmp(); try { const c = makeCanonical(root, 'rep'); saveReferences(root, 'rep', NATURAL_REF); const loaded = loadCanonical(c.dir); const beh = { identifierErrorRate: 0.6, contextLift: 0.5, seed: 9 };
    const runs = []; for (const pass of ['A', 'B']) { const r = await fake.transcribe(loaded.audio, { pass, context: buildContext('fake', pass), windows: loaded.windows, script, references: NATURAL_REF, behavior: beh }); runs.push({ ...r, provider: 'soniox' }); }
    const out = buildReport({ canonicalDir: c.dir, runs }); assert.match(out.markdown, /Overall: NO WINNER/); assert.match(out.markdown, /No engine is declared production-ready/); assert.match(out.markdown, /Context actually sent/); assert.match(out.markdown, /\[UNKNOWN\]/); assert.match(out.markdown, /soniox \| PROMISING|soniox \| \*\*(REJECT|PROMISING)\*\*/);
    assert.match(out.markdown, /Raw ASR vs resolved/); assert.equal(out.verdicts[0].lift !== null, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('providers: five candidates, each with its requirements and its privacy / China record where UNKNOWN stays UNKNOWN; the result contract is enforced', () => {
  assert.deepEqual([...PROVIDERS].sort(), ['alibaba', 'assemblyai', 'qwen3', 'soniox', 'speechmatics']);
  for (const p of PROVIDERS) { const m = PROVIDER_META[p]; for (const k of ['executionLocation', 'audioDestination', 'apiRegion', 'retention', 'training', 'dpa', 'euEndpoint', 'chinaAccess', 'account', 'pricing', 'streaming', 'contextMechanism', 'selfHosting']) assert.ok(m[k] && ['VERIFIED', 'DOCUMENTED CLAIM', 'UNKNOWN'].includes(m[k].label), `${p}.${k}`); assert.ok(REQUIREMENTS[p].env.length >= 1); }
  assert.equal(PROVIDER_META.soniox.chinaAccess.label, 'UNKNOWN'); assert.equal(PROVIDER_META.qwen3.audioDestination.v.startsWith('none'), true); assert.deepEqual(REQUIREMENTS.qwen3.env, ['QWEN_ASR_BIN', 'QWEN_ASR_MODEL_DIR']); assert.ok(REQUIREMENTS.qwen3.downloads.length);
  assert.throws(() => validateResult({ provider: 'x' }), /missing/); assert.throws(() => validateResult({ provider: 'x', model: 'm', mode: 'm', pass: 'Z', audioSha256: 'a', startedAt: '', finishedAt: '', wallMs: 0, audioSec: 1, pace: 1, rawTranscript: '', segments: [], contextApplied: {}, providerMeta: {}, events: {}, errors: [] }), /pass/);
});

test('NOTHING IS SENT without explicit approval: the runner prints the exact request (key redacted) and exits 3; with approval but without the key it exits 4; the requirements command touches nothing', () => {
  const root = tmp(); try { const c = makeCanonical(root, 'gate'); void c; const env = { ...process.env, VOICE_BENCH_DATA: root }; for (const k of Object.keys(env)) if (/SONIOX|ASSEMBLY|SPEECHMATICS|ALIBABA|QWEN/.test(k)) delete env[k];
    const run1 = spawnSync(process.execPath, ['tools/asr-bench/run.mjs', 'run', '--provider', 'soniox', '--pass', 'B', '--session', 'gate'], { env, encoding: 'utf8' }); assert.equal(run1.status, 3, run1.stderr); assert.match(run1.stdout, /DRY RUN: no audio was sent/); assert.match(run1.stdout, /RB-980HB/); assert.ok(!/Bearer [A-Za-z0-9]{10,}/.test(run1.stdout));
    const run2 = spawnSync(process.execPath, ['tools/asr-bench/run.mjs', 'run', '--provider', 'soniox', '--pass', 'A', '--session', 'gate', '--approve-send', 'soniox'], { env, encoding: 'utf8' }); assert.equal(run2.status, 4); assert.match(run2.stdout, /MISSING: SONIOX_API_KEY.*Nothing was sent/);
    const run3 = spawnSync(process.execPath, ['tools/asr-bench/run.mjs', 'run', '--provider', 'soniox', '--pass', 'A', '--session', 'gate', '--approve-send', 'assemblyai'], { env: { ...env, SONIOX_API_KEY: 'k' }, encoding: 'utf8' }); assert.equal(run3.status, 3, 'approval for ANOTHER provider does not authorise this one');
    const req = spawnSync(process.execPath, ['tools/asr-bench/run.mjs', 'requirements'], { env, encoding: 'utf8' }); const j = JSON.parse(req.stdout); assert.equal(j.length, 5); assert.ok(j.every((p) => p.missingEnv.length > 0)); assert.ok(j.find((p) => p.provider === 'qwen3').downloads.length);
    const plan = spawnSync(process.execPath, ['tools/asr-bench/run.mjs', 'plan', '--session', 'gate'], { env, encoding: 'utf8' }); const pj = JSON.parse(plan.stdout.split('\nDRY RUN')[0]); assert.equal(pj.length, 10); assert.ok(pj.every((x) => x.audio.sha256 === JSON.parse(readFileSync(join(sessionDir(root, 'gate'), FILES.meta), 'utf8')).audio.sha256), 'every provider/pass is planned on the SAME canonical sample');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the benchmark never touches production: no import from Nordla\'s providers, no new dependency, secrets only from the environment', () => {
  const files = ['run.mjs', 'provider.mjs', 'ws.mjs', 'providers/soniox.mjs', 'providers/assemblyai.mjs', 'providers/speechmatics.mjs', 'providers/alibaba.mjs', 'providers/qwen3.mjs']; for (const f of files) { const src = readFileSync(new URL(`../tools/asr-bench/${f}`, import.meta.url), 'utf8'); assert.ok(!/^import .*(core\/providers|ui\/field|ui\/app)/m.test(src), f); assert.ok(!/from '(ws|node-fetch|axios|undici)'/.test(src), `${f}: no dependency`); assert.ok(!/(api[_-]?key|token)\s*[:=]\s*['"][A-Za-z0-9]{16,}/i.test(src), `${f}: no embedded secret`); }
  assert.ok(!readFileSync(new URL('../package.json', import.meta.url), 'utf8').match(/"(ws|assemblyai|speechmatics|soniox)"\s*:/), 'no provider SDK added');
});
