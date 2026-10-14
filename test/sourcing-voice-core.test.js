// FIELD VOICE - provenance of SPOKEN statements in the core (provider-independent): captured speech -> machine transcription -> machine-derived candidates. The speaker is UNKNOWN until the OWNER
// says otherwise; nothing heard by a microphone can become a supplier claim on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { normalizeSpoken } from '../src/sourcing/core/extract/spoken.js';
import { planContext } from '../src/sourcing/core/context-engine.js';
import { planConversation } from '../src/sourcing/core/conversation-engine.js';
import { assess } from '../src/sourcing/core/case.js';
import { groupUnderstanding } from '../src/sourcing/core/understanding.js';

const SAID = 'The model number is X twenty five. The minimum order quantity is one hundred pieces.';
const speech = (s, text = SAID, extra = {}) => dispatch(s, { type: 'CONVERSATION_ITEM', convId: s.conversations.at(-1).id, modality: 'SPEECH', text, lang: 'en', provider: 'any-asr', version: 'v1', capture: { sessionId: 'cap-1', turn: 1, startedAt: '2026-10-06T10:00:00.000Z' }, ...extra });
const started = () => dispatch(newCase({ id: 'c1', name: 'Power bank' }), { type: 'CONVERSATION_START', supplierRef: null, lang: 'auto' });

test('a spoken item is SPEECH with NO original text: capture metadata + ONE machine transcription, speaker UNKNOWN', () => {
  const s = speech(started()); const it = s.conversations[0].items[0];
  assert.equal(it.modality, 'SPEECH'); assert.equal(it.original, null); assert.equal(it.speaker, 'unknown'); assert.equal(it.speakerBy, 'UNKNOWN');
  assert.deepEqual({ sessionId: it.capture.sessionId, turn: it.capture.turn }, { sessionId: 'cap-1', turn: 1 });
  assert.equal(it.derived.length, 1); const d = it.derived[0]; assert.equal(d.kind, 'TRANSCRIPTION'); assert.equal(d.review, 'MACHINE'); assert.equal(d.provider, 'any-asr'); assert.equal(d.version, 'v1'); assert.equal(d.text, SAID, 'the stored transcription is untouched');
  assert.ok(!JSON.stringify(it).match(/audio|pcm|samples|blob/i), 'no audio is kept in the case');
});

test('numbers said as words are read for EXTRACTION only: model and MOQ become MACHINE_DERIVED candidates, capped at MEDIUM, basis TRANSCRIPTION, speaker UNKNOWN', () => {
  const s = speech(started()); const by = Object.fromEntries(s.candidates.map((c) => [c.key, c]));
  assert.equal(by['identifier.model'].value, 'X25'); assert.equal(by['quote.moq'].value, '100');
  for (const c of s.candidates) { assert.equal(c.basis, 'TRANSCRIPTION'); assert.equal(c.speaker, 'unknown'); assert.equal(c.confidence, 'MEDIUM'); assert.ok(c.flags.includes('MACHINE_DERIVED')); assert.equal(c.state, 'PROPOSED'); assert.ok(c.derivedId && c.itemId); }
  assert.equal(s.ledger.length, 0); assert.equal(s.quotes.length, 0, 'nothing reached the case'); assert.equal(s.conversations[0].items[0].derived[0].normalized, 'The model number is X25. The minimum order quantity is 100 pieces.');
});

test('NO direct promotion: a fact heard with an UNKNOWN speaker cannot be confirmed, corrected, grouped or resolved until the OWNER attributes the speaker', () => {
  const s = speech(started()); const id = s.candidates[0].id;
  assert.throws(() => dispatch(s, { type: 'CANDIDATE_CONFIRM', id }), /nobody has said who spoke/);
  assert.throws(() => dispatch(s, { type: 'CANDIDATE_CORRECT', id, value: 'X26' }), /nobody has said who spoke/);
  assert.equal(groupUnderstanding(s).hasGroup, false, 'machine-derived facts never join a grouped confirmation');
  assert.throws(() => dispatch(s, { type: 'CANDIDATES_CONFIRM_BATCH', ids: s.candidates.map((c) => c.id), via: 'GROUP' }), /./);
});

test('the owner attributes the speaker: supplier -> SUPPLIER_CLAIM, me -> USER_PROVIDED; basis stays TRANSCRIPTION, userConfirmed only after the explicit confirm', () => {
  let s = speech(started()); const it = s.conversations[0].items[0];
  const sup = dispatch(s, { type: 'CONVERSATION_ATTRIBUTE', convId: 'conv-1', itemId: it.id, speaker: 'supplier' });
  assert.equal(sup.conversations[0].items[0].speaker, 'supplier'); assert.equal(sup.conversations[0].items[0].speakerBy, 'OWNER_DECISION'); assert.ok(sup.candidates.every((c) => c.speaker === 'supplier')); assert.equal(sup.ledger.length, 0, 'attributing is not confirming');
  const done = dispatch(sup, { type: 'CANDIDATE_CONFIRM', id: sup.candidates.find((c) => c.key === 'quote.moq').id }); const led = done.ledger.at(-1);
  assert.equal(led.status, 'SUPPLIER_CLAIM'); assert.equal(led.basis, 'TRANSCRIPTION'); assert.equal(led.userConfirmed, true);
  const me = dispatch(s, { type: 'CONVERSATION_ATTRIBUTE', convId: 'conv-1', itemId: it.id, speaker: 'me' }); const mine = dispatch(me, { type: 'CANDIDATE_CONFIRM', id: me.candidates[0].id });
  assert.equal(mine.ledger.at(-1).status, 'USER_PROVIDED');
  assert.throws(() => dispatch(s, { type: 'CONVERSATION_ATTRIBUTE', convId: 'conv-1', itemId: it.id, speaker: 'unknown' }), /supplier or me/);
});

test('a speaker claimed by the caller is IGNORED unless it is an explicit owner decision (a microphone never knows who spoke)', () => {
  const s = speech(started(), SAID, { speaker: 'supplier' }); assert.equal(s.conversations[0].items[0].speaker, 'unknown'); assert.ok(s.candidates.every((c) => c.speaker === 'unknown'));
});

test('the conversation engine and the context engine USE the heard facts (pending answers, topic) and the timeline marks them HEARD, never SUPPLIER', () => {
  const s0 = started(); const before = planContext(s0, assess(s0)); const s = speech(s0); const A = assess(s); const ctx = planContext(s, A);
  assert.ok(ctx.plan.timeline.some((e) => e.kind === 'HEARD' && e.modality === 'SPEECH' && e.speaker === 'unknown')); assert.ok(!ctx.plan.timeline.some((e) => e.kind === 'SUPPLIER'));
  assert.notEqual(ctx.suggestion?.id ?? null, before.suggestion?.id ?? null, 'ASK NEXT reacts to what was heard (the model/MOQ questions are now answered-pending)');
  assert.ok(ctx.plan.pending.candidates >= 2); assert.ok(ctx.topic, 'a current topic is derived from the spoken statement');
  assert.ok(planConversation(s, A).summary.pending >= 2);
});

test('typed text is unchanged: ORIGINAL basis, supplier or me, as before', () => {
  const s = dispatch(started(), { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', text: 'MOQ is 50 pcs.' }); const it = s.conversations[0].items[0];
  assert.equal(it.original, 'MOQ is 50 pcs.'); assert.equal(it.speaker, 'supplier'); assert.equal(s.candidates[0].basis, 'ORIGINAL'); assert.ok(!(s.candidates[0].flags ?? []).includes('MACHINE_DERIVED'));
});

test('an empty transcription and a finished conversation are refused', () => {
  assert.throws(() => speech(started(), '   '), /required/);
  const fin = dispatch(started(), { type: 'CONVERSATION_FINISH', convId: 'conv-1' }); assert.throws(() => speech(fin), /finished/);
});

test('spoken-number normalisation is deterministic and never invents a number', () => {
  assert.equal(normalizeSpoken('minimum order quantity is one hundred pieces'), 'minimum order quantity is 100 pieces');
  assert.equal(normalizeSpoken('The model number is X twenty five'), 'The model number is X25');
  assert.equal(normalizeSpoken('thirty eight point three'), '38.3'); assert.equal(normalizeSpoken('the price is seven dollars twenty'), 'the price is $7.20');
  assert.equal(normalizeSpoken('nothing numeric here'), 'nothing numeric here'); assert.equal(normalizeSpoken(normalizeSpoken('one hundred pieces')), '100 pieces', 'idempotent');
});
