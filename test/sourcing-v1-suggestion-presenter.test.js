// Conversation First, step 3: WHEN to show a suggestion. A pure state machine with an injected clock (milliseconds): Nordla never interrupts. At most one suggestion is on screen; it is not shown while the
// owner is typing or just after the supplier spoke; it is not replaced just because another one became better; it goes away at once when it is answered, put aside or no longer about the subject;
// there is a pause before the next one; "Que dois-je demander maintenant ?" overrides the timing. The delays are configurable defaults (1.5 s / 8 s / 10 s), not business rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/sourcing/core/case.js';
import { planContext } from '../src/sourcing/core/context-engine.js';
import { presentSuggestion, DEFAULT_TIMING, normalizeTiming } from '../src/sourcing/core/suggestion-presenter.js';
import { NOW, build, run, importer } from './sourcing-fixtures.js';

const sug = (id, origin = 'ADJACENT') => ({ id, origin, audience: 'SUPPLIER', state: 'OPEN', text: { fr: id } });
const ctxOf = (list, topic = 'COLOURS', alerts = []) => ({ topic: { id: topic }, suggestion: list[0] ?? null, all: list, others: list.slice(1), alerts });
const T0 = 1_000_000;

test('defaults: silence 1.5 s, dwell 8 s, pause 10 s; configurable, bad values ignored', () => {
  assert.deepEqual(DEFAULT_TIMING, { quietMs: 1500, dwellMs: 8000, cooldownMs: 10000 });
  assert.deepEqual(normalizeTiming({ quietMs: 500 }), { quietMs: 500, dwellMs: 8000, cooldownMs: 10000 });
  assert.deepEqual(normalizeTiming({ quietMs: -1, dwellMs: 'x', cooldownMs: NaN }), DEFAULT_TIMING); assert.deepEqual(normalizeTiming(null), DEFAULT_TIMING);
});

test('never while the owner is typing (mid-sentence): held until the typing stops', () => {
  const r = presentSuggestion(null, ctxOf([sug('a')]), { composing: true, lastUtteranceAt: null }, T0); assert.equal(r.show, null); assert.equal(r.hold.reason, 'COMPOSING');
  assert.equal(presentSuggestion(r.state, ctxOf([sug('a')]), { composing: false, lastUtteranceAt: null }, T0 + 10).show.id, 'a');
});

test('not right after the supplier spoke: waits for the silence, tells when to look again; pasted text (no streaming) is immediate', () => {
  const sig = { composing: false, lastUtteranceAt: T0 - 500 }; const r = presentSuggestion(null, ctxOf([sug('a')]), sig, T0);
  assert.equal(r.show, null); assert.equal(r.hold.reason, 'QUIET'); assert.equal(r.hold.until, T0 + 1000);
  assert.equal(presentSuggestion(r.state, ctxOf([sug('a')]), sig, T0 + 1000).show.id, 'a'); assert.equal(presentSuggestion(null, ctxOf([sug('a')]), { composing: false, lastUtteranceAt: null }, T0).show.id, 'a');
});

test('one at a time, and stable: a better suggestion does NOT replace the one on screen', () => {
  const idle = { composing: false, lastUtteranceAt: null }; const r1 = presentSuggestion(null, ctxOf([sug('a'), sug('b')]), idle, T0); assert.equal(r1.show.id, 'a');
  for (const dt of [1000, 5000, 7999, 12000, 60000]) { const r = presentSuggestion(r1.state, ctxOf([sug('b'), sug('a')]), idle, T0 + dt); assert.equal(r.show.id, 'a', `still a at +${dt}`); }
});

test('answered (no longer listed): it disappears silently; the next one waits for the pause counted from the previous one', () => {
  const idle = { composing: false, lastUtteranceAt: null }; const r1 = presentSuggestion(null, ctxOf([sug('a'), sug('b')]), idle, T0);
  const r2 = presentSuggestion(r1.state, ctxOf([sug('b')]), idle, T0 + 3000); assert.equal(r2.show, null, 'a is gone and b is not shown yet'); assert.equal(r2.hold.reason, 'COOLDOWN'); assert.equal(r2.hold.until, T0 + 10000);
  assert.equal(presentSuggestion(r2.state, ctxOf([sug('b')]), idle, T0 + 10000).show.id, 'b');
});

test('the subject moved on: an adjacent suggestion about the old subject stays for the dwell time (no flicker), then is dropped', () => {
  const idle = { composing: false, lastUtteranceAt: null }; const r1 = presentSuggestion(null, ctxOf([sug('s:mixed_colours')], 'COLOURS'), idle, T0);
  const r2 = presentSuggestion(r1.state, ctxOf([sug('s:mixed_colours')], 'LEADTIME'), idle, T0 + 1000); assert.equal(r2.show.id, 's:mixed_colours', 'time to read and tap');
  assert.equal(presentSuggestion(r2.state, ctxOf([sug('s:mixed_colours')], 'LEADTIME'), idle, T0 + 8000).show, null, 'dropped after the dwell time');
  const g = presentSuggestion(null, ctxOf([sug('model', 'GLOBAL')], 'COLOURS'), idle, T0); const g2 = presentSuggestion(g.state, ctxOf([sug('model', 'GLOBAL')], 'LEADTIME'), idle, T0 + 1000); assert.equal(g2.show.id, 'model', 'a global question is not about a subject');
});

test('an opener (GLOBAL) shown before anyone spoke gives way, after the dwell time, to a suggestion that fits what is now being said', () => {
  const idle = { composing: false, lastUtteranceAt: null }; const r1 = presentSuggestion(null, ctxOf([sug('model', 'GLOBAL')], 'OTHER'), idle, T0); assert.equal(r1.show.id, 'model');
  const talk = ctxOf([sug('s:price_tiers', 'ADJACENT'), sug('model', 'GLOBAL')], 'PRICE');
  const r2 = presentSuggestion(r1.state, talk, idle, T0 + 2000); assert.equal(r2.show.id, 'model', 'not replaced at once'); assert.equal(r2.wake, T0 + 8000, 'the screen is told when to look again');
  const r3 = presentSuggestion(r1.state, talk, idle, T0 + 8000); assert.equal(r3.show, null, 'dropped after the dwell time'); assert.equal(r3.hold.reason, 'COOLDOWN');
  assert.equal(presentSuggestion(r3.state, talk, idle, T0 + 10000).show.id, 's:price_tiers');
});

test('"Que dois-je demander maintenant ?" overrides typing, silence, dwell and pause', () => {
  const r1 = presentSuggestion(null, ctxOf([sug('a'), sug('b')]), { composing: false, lastUtteranceAt: null }, T0);
  const r = presentSuggestion(r1.state, ctxOf([sug('b'), sug('a')]), { composing: true, lastUtteranceAt: T0 + 900, explicit: true }, T0 + 1000); assert.equal(r.show.id, 'b');
  assert.equal(presentSuggestion(null, ctxOf([]), { explicit: true }, T0).show, null, 'nothing to ask: nothing invented');
});

test('alerts are never held back and never modal', () => {
  const alerts = [{ kind: 'CONFLICT', text: { fr: 'MOQ : avant 50, maintenant 100.' } }]; const r = presentSuggestion(null, ctxOf([sug('a')], 'MOQ', alerts), { composing: true, lastUtteranceAt: T0 }, T0);
  assert.deepEqual(r.alerts, alerts); assert.equal(r.show, null); assert.ok(!('modal' in r) && r.alerts.every((a) => !a.modal));
});

test('purity: inputs are not mutated and the result is deterministic', () => {
  const prev = { shownId: 'a', shownAt: T0, topicId: 'COLOURS', origin: 'ADJACENT', lastShownAt: T0 }; const c = ctxOf([sug('a')]); const before = JSON.stringify([prev, c]);
  const a = presentSuggestion(prev, c, { composing: false, lastUtteranceAt: null }, T0 + 5); const b = presentSuggestion(prev, c, { composing: false, lastUtteranceAt: null }, T0 + 5);
  assert.equal(JSON.stringify([prev, c]), before); assert.deepEqual(a, b);
});

test('integration with the real engine: "Pas maintenant" (QUESTION_SKIP) removes the suggestion on screen', () => {
  const at = (n) => new Date(NOW.getTime() + n * 1000); const idle = { composing: false, lastUtteranceAt: null };
  let s = dispatch(build([{ type: 'NAME', name: 'Power bank' }, { type: 'CATEGORY', category: 'power_bank' }, ...importer]), { type: 'CONVERSATION_START', supplierRef: 'x', lang: 'auto' }, at(1));
  s = dispatch(s, { type: 'CONVERSATION_ITEM', convId: s.conversations[0].id, speaker: 'supplier', lang: 'auto', text: 'We have black, white, blue and pink.' }, at(2));
  const r1 = presentSuggestion(null, planContext(s, run(s)), idle, T0); assert.equal(r1.show.id, 's:mixed_colours');
  s = dispatch(s, { type: 'QUESTION_SKIP', questionId: 's:mixed_colours' }, at(5)); const r2 = presentSuggestion(r1.state, planContext(s, run(s)), idle, T0 + 2000); assert.notEqual(r2.show?.id, 's:mixed_colours');
});
