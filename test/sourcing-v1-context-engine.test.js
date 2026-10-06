// Conversation First, step 2: the CONTEXTUAL engine. On top of P5 (unchanged) it knows what is being talked about NOW and brings forward, at most ONE suggestion for the SUPPLIER that is adjacent to the
// current topic. The topic only reorders: it never adds a requirement P5 does not have. A statement that answers a suggestion makes it disappear silently. Owner cards (transport, duty, selling price...)
// never become conversation suggestions (they live in a sheet, on demand). A contradiction or a safety blocker is an ALERT, not a suggestion. Nothing here is stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/sourcing/core/case.js';
import { planContext } from '../src/sourcing/core/context-engine.js';
import { planConversation, REVIEW } from '../src/sourcing/core/conversation-engine.js';
import { TOPIC } from '../src/sourcing/core/topics.js';
import { NOW, build, run, ident, importer, commercial } from './sourcing-fixtures.js';

const at = (n = 0) => new Date(NOW.getTime() + n * 1000);
const start = (s, n = 1) => dispatch(s, { type: 'CONVERSATION_START', supplierRef: 'Booth 12', lang: 'auto' }, at(n));
const say = (s, text, n = 2, speaker = 'supplier') => dispatch(s, { type: 'CONVERSATION_ITEM', convId: s.conversations.at(-1).id, speaker, lang: 'auto', text }, at(n));
const confirmAll = (s, n = 10) => { for (const c of s.candidates.filter((x) => x.state === 'PROPOSED' && !x.needsCorrection)) { try { s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: c.id }, at(n)); } catch { /* conflicts are handled elsewhere */ } } return s; };
const base = () => start(build([{ type: 'NAME', name: 'Power bank' }, { type: 'CATEGORY', category: 'power_bank' }, ...importer]));
const ctx = (s, o) => planContext(s, run(s), o);
const PHONE = 'PB-X200. MOQ is 50 pcs. Price is USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs. FOB Shenzhen. 30% deposit, 70% balance before shipment. We have black, white, blue and pink. You can mix colors, minimum 25 pcs per color. Production time is 15 days. We have CE, RoHS and UN38.3.';

test('colours: the supplier lists colours -> ONE adjacent suggestion for the SUPPLIER (mix colours / minimum per colour), before anything is confirmed', () => {
  const c = ctx(say(base(), 'We have black, white, blue and pink.'));
  assert.equal(c.topic.id, TOPIC.COLOURS); assert.ok(c.suggestion, 'a suggestion'); assert.ok(!Array.isArray(c.suggestion), 'exactly one, never a list');
  assert.equal(c.suggestion.id, 's:mixed_colours'); assert.equal(c.suggestion.origin, 'ADJACENT'); assert.equal(c.suggestion.audience, 'SUPPLIER'); assert.equal(c.suggestion.state, 'OPEN');
  assert.match(c.suggestion.text.fr, /couleurs/i); assert.equal(c.suggestion.supplier.zh.review, REVIEW.UNREVIEWED, 'new Chinese is never presented as reviewed');
});

test('the supplier then answers BY HIMSELF: the suggestion disappears silently and the next action is recomputed', () => {
  let s = say(base(), 'We have black, white, blue and pink.'); assert.equal(ctx(s).suggestion.id, 's:mixed_colours');
  s = say(s, 'You can mix colors, minimum 25 pcs per color.', 3); const c = ctx(s);
  assert.notEqual(c.suggestion?.id, 's:mixed_colours', 'resolved: not suggested any more'); assert.ok(c.plan.questions.find((q) => q.id === 's:mixed_colours')?.state === 'ANSWER_PENDING' || !c.plan.questions.find((q) => q.id === 's:mixed_colours'));
  assert.notEqual(c.suggestion?.id, 's:colours');
});

test('price: ONE tier given -> suggest the other tiers; the three tiers given at once -> no useless question', () => {
  const one = ctx(say(base(), 'USD 8 for 50 pcs.')); assert.equal(one.topic.id, TOPIC.PRICE); assert.equal(one.suggestion.id, 's:price_tiers'); assert.equal(one.suggestion.origin, 'ADJACENT');
  const three = ctx(say(base(), 'USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs.')); assert.notEqual(three.suggestion?.id, 's:price_tiers');
});

test('at most ONE suggestion, never an owner card, never a question P5 does not know', () => {
  let s = confirmAll(say(base(), PHONE)); const c = ctx(s);
  assert.ok(c.suggestion === null || c.suggestion.audience === 'SUPPLIER');
  assert.ok(c.ownerCards.every((q) => q.audience === 'USER'), 'owner cards are listed apart, for the sheet');
  const known = new Set(c.plan.questions.map((q) => q.id)); for (const o of [c.suggestion, ...c.others].filter(Boolean)) assert.ok(known.has(o.id) || o.origin === 'ADJACENT', `${o.id} comes from P5 or is an adjacent suggested question`);
  s = confirmAll(say(s, 'Sample price is USD 15.', 5)); assert.ok(ctx(s).suggestion === null || ctx(s).suggestion.audience === 'SUPPLIER');
});

test('with no recognisable topic the suggestion is simply the best SUPPLIER question of P5 (GLOBAL)', () => {
  const s = say(base(), 'Hello, nice to meet you, welcome to our booth.'); const c = ctx(s); const p5 = planConversation(s, run(s)).questions.find((q) => q.audience === 'SUPPLIER' && ['OPEN', 'UNANSWERED'].includes(q.state) && q.source !== 'CONFLICT');
  assert.equal(c.topic.id, TOPIC.OTHER); assert.equal(c.suggestion.id, p5.id); assert.equal(c.suggestion.origin, 'GLOBAL');
});

test('a contradiction is an ALERT (banner), not the suggestion; the suggestion stays calm', () => {
  let s = confirmAll(say(base(), 'MOQ is 50 pcs.')); s = say(s, 'Sorry, MOQ is 100 pcs.', 4); const c = ctx(s);
  assert.ok(c.alerts.some((a) => a.kind === 'CONFLICT'), 'the contradiction is an alert'); assert.ok(c.alerts[0].text.fr.length > 5);
  assert.ok(!c.suggestion || !c.suggestion.id.startsWith('conflict:'), 'the conflict question is not forced into the suggestion strip');
});

test('"Pas maintenant" (QUESTION_SKIP) puts the suggestion aside until the supplier speaks again', () => {
  let s = say(base(), 'We have black, white, blue and pink.'); const id = ctx(s).suggestion.id; s = dispatch(s, { type: 'QUESTION_SKIP', questionId: id }, at(5));
  const c = ctx(s); assert.notEqual(c.suggestion?.id, id, 'put aside'); s = say(s, 'Also we can add green.', 8); assert.equal(ctx(s).suggestion?.id, id, 'comes back after a new supplier message');
});

test('a question already SHOWN to the supplier is not suggested again; if the supplier ignores it, it comes back flagged as a repeat', () => {
  let s = say(base(), 'We have black, white, blue and pink.'); const id = ctx(s).suggestion.id; s = dispatch(s, { type: 'QUESTION_SHOWN', questionId: id, texts: { fr: 'x' } }, at(5));
  assert.notEqual(ctx(s).suggestion?.id, id); s = say(s, 'The lead time is 15 days.', 9); const c = ctx(s);
  const again = c.all.find((q) => q.id === id); assert.ok(again, 'comes back'); assert.equal(again.state, 'UNANSWERED'); assert.equal(again.repeat, true);
});

test('compact messages: cost incomplete / documents announced but not received, factual and short', () => {
  const s = confirmAll(say(base(), PHONE)); const c = ctx(s); const codes = c.messages.map((m) => m.code);
  assert.ok(codes.includes('DOCS_ANNOUNCED'), codes.join()); assert.ok(c.messages.every((m) => m.fr.length < 80));
  const full = ctx(build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...importer, ...commercial()]));
  assert.ok(Array.isArray(full.messages));
});

test('purity: the case is untouched and the answer is deterministic', () => {
  const s = confirmAll(say(base(), PHONE)); const before = JSON.stringify(s); const a = ctx(s); const b = ctx(s); assert.equal(JSON.stringify(s), before); assert.deepEqual(a, b);
});
