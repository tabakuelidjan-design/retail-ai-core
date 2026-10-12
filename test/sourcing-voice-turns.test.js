// FIELD VOICE - ASR SEGMENT -> CONVERSATION TURN. A recogniser delivers many small FINAL segments; the thread shows TURNS. Every segment is kept immutable (text, engine timing, receive time, stream),
// the turn is their accumulation, and each fact points back to the exact segment ids. The timing numbers are uncalibrated defaults (core/turns.js): these tests pin the BEHAVIOUR, not the calibration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { DEFAULT_TURN_CONFIG, decideTurn, gapMs, segmentsOf, isTurnOpen, normalizeTurnConfig } from '../src/sourcing/core/turns.js';
import { planContext } from '../src/sourcing/core/context-engine.js';
import { assess } from '../src/sourcing/core/case.js';

const T0 = Date.parse('2026-10-07T10:00:00.000Z'); const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const started = () => dispatch(newCase({ id: 'c1', name: 'Case' }), { type: 'CONVERSATION_START', supplierRef: null, lang: 'auto' });
/** one FINAL segment as the engine reports it: startTime/duration on the stream's own clock, received a moment after it ended */
const seg = (s, text, { start, dur = 1, stream = 'cap-1-st1', session = 'cap-1', cfg } = {}) => dispatch(s, { type: 'SPEECH_SEGMENT', convId: s.conversations.at(-1).id, text, lang: 'en', provider: 'any-asr', version: 'v1', segment: { startTime: start, duration: dur, streamId: stream, receivedAt: iso(start + dur + 0.3) }, capture: { sessionId: session }, ...(cfg ? { turnConfig: cfg } : {}) });
const items = (s) => s.conversations.at(-1).items;

test('the four Moonshine finals of ONE spoken turn become ONE conversation turn, every segment preserved with its timing and ids', () => {
  let s = started();
  s = seg(s, 'We have', { start: 0, dur: 0.8 }); s = seg(s, 'black white and blue', { start: 1.6, dur: 1.4 }); s = seg(s, 'MOQ is', { start: 3.4, dur: 0.7 }); s = seg(s, 'one hundred pieces', { start: 4.5, dur: 1.2 });
  assert.equal(items(s).length, 1, 'one turn, not four messages'); const it = items(s)[0];
  assert.equal(it.modality, 'SPEECH'); assert.equal(it.speaker, 'unknown'); assert.equal(it.turn.status, 'OPEN'); assert.equal(it.segments.length, 4);
  assert.deepEqual(it.segments.map((x) => x.text), ['We have', 'black white and blue', 'MOQ is', 'one hundred pieces']); assert.deepEqual(it.segments.map((x) => x.id), ['conv-1-i1-s1', 'conv-1-i1-s2', 'conv-1-i1-s3', 'conv-1-i1-s4']);
  assert.deepEqual(it.segments.map((x) => [x.startTime, x.duration]), [[0, 0.8], [1.6, 1.4], [3.4, 0.7], [4.5, 1.2]]); assert.ok(it.segments.every((x) => x.streamId === 'cap-1-st1' && x.receivedAt && x.provider === 'any-asr' && x.version === 'v1'));
  assert.equal(it.derived[0].text, 'We have black white and blue MOQ is one hundred pieces', 'the stored transcription is the accumulation, untouched'); assert.deepEqual(it.derived[0].segmentIds, it.segments.map((x) => x.id)); assert.equal(it.derived[0].review, 'MACHINE');
});

test('two genuinely separated spoken turns are NOT merged (long silence), and a finished sentence followed by a pause starts a new turn', () => {
  let s = started(); s = seg(s, 'The model number is X25.', { start: 0, dur: 2 }); s = seg(s, 'And what is the price', { start: 12, dur: 2 }); assert.equal(items(s).length, 2, 'a silence above breakGapMs');
  assert.equal(items(s)[0].turn.status, 'CLOSED'); assert.equal(items(s)[0].turn.closedBy, 'SILENCE');
  let t = started(); t = seg(t, 'This is from Artemax.', { start: 0, dur: 1.5 }); t = seg(t, 'Do you want a sample', { start: 3.2, dur: 1.5 }); assert.equal(items(t).length, 2, 'sentence end + 1.7 s pause'); assert.equal(items(t)[0].turn.closedBy, 'SENTENCE_END_AND_PAUSE');
  let u = started(); u = seg(u, 'This is from Artemax.', { start: 0, dur: 1.5 }); u = seg(u, 'and we have stock', { start: 2.1, dur: 1.5 }); assert.equal(items(u).length, 1, 'sentence end but only a 0.6 s breath: same turn');
});

test('a segment from ANOTHER capture session never joins an open turn; segments of the same session on a different engine stream join by reception time', () => {
  let s = started(); s = seg(s, 'We have', { start: 0, dur: 1 }); s = seg(s, 'blue', { start: 1.5, dur: 1, session: 'cap-2', stream: 'cap-2-st1' }); assert.equal(items(s).length, 2); assert.equal(items(s)[0].turn.closedBy, 'OTHER_CAPTURE_SESSION');
  let r = started(); r = seg(r, 'We have', { start: 0, dur: 1 }); r = seg(r, 'black and blue', { start: 0, dur: 1, stream: 'cap-1-st2' }); // a resumed stream restarts its clock: the receive times decide
  assert.equal(items(r).length, 1);
});

test('deterministic closers: pause/stop (TURN_CLOSE), typed input, a question shown, an established speaker, the end of the conversation', () => {
  const open = () => seg(started(), 'We have black', { start: 0, dur: 1 });
  const more = (s) => seg(s, 'and blue', { start: 2, dur: 1 });
  let s = dispatch(open(), { type: 'TURN_CLOSE', convId: 'conv-1', by: 'PAUSE' }); assert.equal(items(s)[0].turn.closedBy, 'PAUSE'); assert.equal(items(more(s)).length, 2);
  s = dispatch(open(), { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'me', text: 'noted' }); assert.equal(items(s)[0].turn.closedBy, 'TYPED_INPUT');
  s = dispatch(open(), { type: 'QUESTION_SHOWN', questionId: 'model', via: 'SHOWN_TO_SUPPLIER' }); assert.equal(items(s)[0].turn.closedBy, 'QUESTION_SHOWN'); assert.equal(items(more(s)).length, 2);
  s = dispatch(open(), { type: 'CONVERSATION_ATTRIBUTE', convId: 'conv-1', itemId: 'conv-1-i1', speaker: 'supplier' }); assert.equal(items(s)[0].turn.closedBy, 'SPEAKER_ESTABLISHED'); assert.equal(items(s)[0].speaker, 'supplier');
  s = dispatch(open(), { type: 'CONVERSATION_FINISH', convId: 'conv-1' }); assert.equal(items(s)[0].turn.closedBy, 'CONVERSATION_FINISHED');
});

test('facts are derived INCREMENTALLY from the accumulated turn and point back to the exact segments; a number split across segments is read', () => {
  let s = started(); s = seg(s, 'We have', { start: 0, dur: 0.8 }); assert.equal(s.candidates.length, 0);
  s = seg(s, 'black white and blue', { start: 1.6, dur: 1.4 }); const col = s.candidates.find((c) => c.key === 'variant.colours'); assert.ok(col); assert.deepEqual(col.value, ['black', 'white', 'blue']); assert.equal(col.basis, 'TRANSCRIPTION'); assert.equal(col.speaker, 'unknown'); assert.ok(col.flags.includes('MACHINE_DERIVED'));
  s = seg(s, 'MOQ is', { start: 3.4, dur: 0.7 }); s = seg(s, 'one hundred pieces', { start: 4.5, dur: 1.2 }); const moq = s.candidates.find((c) => c.key === 'quote.moq'); assert.equal(moq.value, '100');
  assert.ok(moq.segmentIds.includes('conv-1-i1-s4'), JSON.stringify(moq.segmentIds)); assert.ok(['EXACT', 'APPROX'].includes(moq.segmentMapping)); assert.ok(s.candidates.every((c) => c.segmentIds.every((id) => items(s)[0].segments.some((x) => x.id === id))), 'every pointer is a real segment');
  assert.equal(s.ledger.length, 0, 'nothing confirmed');
});

test('re-deriving never touches what the owner already decided, never duplicates, and keeps candidate ids unique', () => {
  let s = started(); s = seg(s, 'We have black white and blue', { start: 0, dur: 1.4 }); s = dispatch(s, { type: 'CONVERSATION_ATTRIBUTE', convId: 'conv-1', itemId: 'conv-1-i1', speaker: 'supplier' });
  const col = s.candidates.find((c) => c.key === 'variant.colours'); s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: col.id }); assert.equal(s.ledger.length, 1);
  s = seg(s, 'MOQ is one hundred pieces', { start: 2, dur: 2 }); // a NEW turn (the attribution closed the first one)
  assert.equal(items(s).length, 2); assert.equal(s.candidates.filter((c) => c.key === 'variant.colours').length, 1); assert.equal(s.candidates.find((c) => c.id === col.id).state, 'CONFIRMED');
  let t = started(); t = seg(t, 'MOQ is fifty', { start: 0, dur: 1 }); t = seg(t, 'one hundred pieces', { start: 1.8, dur: 1 }); const ids = t.candidates.map((c) => c.id); assert.equal(new Set(ids).size, ids.length, 'unique candidate ids after a replacement');
});

test('the turn limits: a turn never grows without bound (characters, speech duration); the configuration is isolated and overridable', () => {
  let s = started(); for (let i = 0; i < 30; i++) s = seg(s, 'we can do that for you at a good price', { start: i * 2, dur: 1.5 }); assert.ok(items(s).length > 1, 'split by the length / duration limits'); assert.ok(items(s).slice(0, -1).every((i) => ['TOO_LONG'].includes(i.turn.closedBy)), items(s).map((i) => i.turn.closedBy).join());
  let t = started(); t = seg(t, 'We have', { start: 0, dur: 1, cfg: { breakGapMs: 500 } }); t = seg(t, 'blue', { start: 2.5, dur: 1, cfg: { breakGapMs: 500 } }); assert.equal(items(t).length, 2, 'a per-event configuration changes the boundary');
  assert.deepEqual(normalizeTurnConfig({ breakGapMs: -5, junk: 1 }), { ...DEFAULT_TURN_CONFIG }); assert.ok(Object.isFrozen(DEFAULT_TURN_CONFIG));
});

test('decideTurn is pure: same input, same answer; unknown timing falls back to reception times and never throws', () => {
  const open = { segments: [{ id: 'a', text: 'We have', startTime: null, duration: null, streamId: null, receivedAt: iso(0) }], sessionId: 's', speaker: 'unknown' }; const next = { id: 'b', text: 'blue', startTime: null, duration: null, streamId: null, receivedAt: iso(2) };
  assert.deepEqual(decideTurn({ open, segment: next, sessionId: 's' }), decideTurn({ open, segment: next, sessionId: 's' })); assert.equal(decideTurn({ open, segment: next, sessionId: 's' }).action, 'APPEND'); assert.equal(gapMs(open.segments[0], next), 2000);
  assert.equal(decideTurn({ open: null, segment: next, sessionId: 's' }).action, 'NEW');
});

test('BACKWARD COMPATIBILITY: voice items stored before turns (one transcription, no segments, no turn) still read as a closed single-segment turn and keep working through every engine', () => {
  const old = started(); old.conversations[0].items.push({ id: 'conv-1-i1', at: iso(0), speaker: 'unknown', speakerBy: 'UNKNOWN', lang: 'en', modality: 'SPEECH', original: null, capture: { sessionId: 'cap-0', turn: 1, startedAt: null, endedAt: iso(0) }, derived: [{ id: 'conv-1-i1-d1', kind: 'TRANSCRIPTION', lang: 'en', text: 'The minimum order quantity is 100 pieces.', provider: 'p', review: 'MACHINE', at: iso(0) }] });
  const segs = segmentsOf(old.conversations[0].items[0]); assert.equal(segs.length, 1); assert.equal(segs[0].text, 'The minimum order quantity is 100 pieces.'); assert.equal(isTurnOpen(old.conversations[0].items[0], T0 + 1e9), false);
  const s = seg(old, 'Lead time is twenty days', { start: 0, dur: 2 }); assert.equal(items(s).length, 2, 'a new segment never joins a legacy item'); const ctx = planContext(s, assess(s)); assert.ok(ctx.plan.timeline.filter((e) => e.kind === 'HEARD').length === 2);
  const att = dispatch(s, { type: 'CONVERSATION_ATTRIBUTE', convId: 'conv-1', itemId: 'conv-1-i1', speaker: 'supplier' }); assert.equal(att.conversations[0].items[0].speaker, 'supplier');
});

test('display: an open turn looks open only while the silence is shorter than silenceCloseMs; a closed turn never does', () => {
  let s = started(); s = seg(s, 'We have', { start: 0, dur: 1 }); const it = items(s)[0]; const last = Date.parse(it.turn.lastSegmentAt);
  assert.equal(isTurnOpen(it, last + 1000), true); assert.equal(isTurnOpen(it, last + DEFAULT_TURN_CONFIG.silenceCloseMs + 1), false);
  s = dispatch(s, { type: 'TURN_CLOSE', convId: 'conv-1', by: 'PAUSE' }); assert.equal(isTurnOpen(items(s)[0], last + 1000), false);
});
