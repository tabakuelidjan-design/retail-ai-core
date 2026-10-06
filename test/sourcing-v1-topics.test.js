// Conversation First, step 1: the CURRENT TOPIC and the compact status chips (pure, derived from the case, never stored). The topic is what is being talked about NOW (the last statement),
// found from the facts the extractor already proposed (HIGH) or, failing that, from fixed keywords (LOW). It only ever reorders what to suggest; it never adds a requirement.
// Chip symbols: ✓ = confirmed BY THE USER (never "verified"), ◐ = partly confirmed, ◌ = the supplier says it (not confirmed by the user), ! = to check, ? = unknown.
// Documents have their own states and NEVER get a ✓.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/sourcing/core/case.js';
import { TOPIC, currentTopic, topicOfItem, topicChips } from '../src/sourcing/core/topics.js';
import { NOW, build, run, importer } from './sourcing-fixtures.js';

const at = (n = 0) => new Date(NOW.getTime() + n * 1000);
const start = (s, n = 1) => dispatch(s, { type: 'CONVERSATION_START', supplierRef: 'Booth 12', lang: 'auto' }, at(n));
const say = (s, text, n = 2, speaker = 'supplier') => dispatch(s, { type: 'CONVERSATION_ITEM', convId: s.conversations.at(-1).id, speaker, lang: 'auto', text }, at(n));
const confirmAll = (s, n = 10) => { for (const c of s.candidates.filter((x) => x.state === 'PROPOSED' && !x.needsCorrection)) { try { s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: c.id }, at(n)); } catch { /* conflicts are handled elsewhere */ } } return s; };
const base = () => start(build([{ type: 'NAME', name: 'Power bank' }, { type: 'CATEGORY', category: 'power_bank' }, ...importer]));
const PHONE = 'PB-X200. MOQ is 50 pcs. Price is USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs. FOB Shenzhen. 30% deposit, 70% balance before shipment. We have black, white, blue and pink. You can mix colors, minimum 25 pcs per color. Production time is 15 days. We have CE, RoHS and UN38.3.';
const chip = (s, t) => topicChips(s, run(s)).find((c) => c.topic === t);

test('no conversation, or a statement with nothing recognisable: the topic is OTHER and no confidence is claimed', () => {
  assert.equal(currentTopic(build([{ type: 'NAME', name: 'Power bank' }])).id, TOPIC.OTHER);
  const t = currentTopic(say(base(), 'Hello, nice to meet you, welcome to our booth.')); assert.equal(t.id, TOPIC.OTHER); assert.equal(t.confidence, 'LOW');
});

test('the topic is the one of the LAST statement, found from facts (HIGH) first', () => {
  let s = say(base(), 'We have black, white, blue and pink.'); let t = currentTopic(s);
  assert.equal(t.id, TOPIC.COLOURS); assert.equal(t.confidence, 'HIGH'); assert.equal(t.source, 'FACTS'); assert.ok(t.evidence.length >= 1); assert.equal(t.itemId, s.conversations[0].items.at(-1).id);
  s = say(s, 'The lead time is 15 days.', 3); t = currentTopic(s); assert.equal(t.id, TOPIC.LEADTIME, 'a new subject replaces the old one');
});

test('an unrecognised extractor result falls back to fixed keywords (LOW), in English and in Chinese', () => {
  const t = currentTopic(say(base(), 'We can put your logo on it, custom packaging is no problem.')); assert.equal(t.id, TOPIC.CUSTOMISATION); assert.equal(t.confidence, 'LOW'); assert.equal(t.source, 'KEYWORDS');
  assert.equal(currentTopic(say(base(), '我们可以做定制包装。')).id, TOPIC.CUSTOMISATION);
  assert.equal(currentTopic(say(base(), '这款里面是锂电池。')).id, TOPIC.COMPLIANCE);
});

test('"since": how long the same subject has been running', () => {
  let s = say(base(), 'We have black, white and blue.', 2); s = say(s, 'Also green is available.', 3); const t = currentTopic(s); assert.equal(t.id, TOPIC.COLOURS);
  assert.equal(t.sinceItem, s.conversations[0].items[0].id, 'the subject started with the first colour statement');
});

test('a long multi-subject statement has ONE main topic and lists the others as "also"', () => {
  const t = currentTopic(say(base(), PHONE)); assert.ok(Object.values(TOPIC).includes(t.id)); assert.ok(t.also.length >= 3, `also: ${t.also}`); assert.ok(!t.also.includes(t.id));
});

test('a rejected candidate does not decide the topic', () => {
  let s = say(base(), 'We have black, white, blue and pink.'); for (const c of s.candidates) s = dispatch(s, { type: 'CANDIDATE_REJECT', id: c.id }, at(5));
  const it = s.conversations[0].items.at(-1); assert.equal(topicOfItem(s, it).source, 'KEYWORDS');
});

test('purity: the case is not modified and the answer is deterministic', () => {
  const s = say(base(), PHONE); const before = JSON.stringify(s); const a = currentTopic(s); const b = currentTopic(s); topicChips(s, run(s));
  assert.equal(JSON.stringify(s), before); assert.deepEqual(a, b);
});

test('chips: what the supplier said is ◌ until the USER confirms it, then ✓ (confirmed by the user, never "verified")', () => {
  let s = say(base(), PHONE);
  assert.equal(chip(s, TOPIC.PRICE).symbol, '◌'); assert.equal(chip(s, TOPIC.MOQ).symbol, '◌'); assert.equal(chip(s, TOPIC.LEADTIME).symbol, '◌');
  s = confirmAll(s);
  for (const t of [TOPIC.PRICE, TOPIC.MOQ, TOPIC.LEADTIME, TOPIC.PAYMENT]) { const c = chip(s, t); assert.equal(c.symbol, '✓', t); assert.match(c.meaning.fr, /confirm/i); assert.doesNotMatch(c.meaning.fr, /v[ée]rifi/i, 'never "verified"'); }
});

test('chips: unknown stays ?, partial is ◐, a contradiction or an ambiguous value is !', () => {
  let s = base(); assert.equal(chip(s, TOPIC.PRICE).symbol, '?'); assert.equal(chip(s, TOPIC.COLOURS).symbol, '?');
  s = confirmAll(say(s, 'We have black, white, blue and pink.')); assert.equal(chip(s, TOPIC.COLOURS).symbol, '◐', 'colours known, mixing unknown');
  s = confirmAll(say(s, 'You can mix colors, minimum 25 pcs per color.', 3)); assert.equal(chip(s, TOPIC.COLOURS).symbol, '✓');
  let c = confirmAll(say(base(), 'MOQ is 50 pcs.')); c = say(c, 'Sorry, MOQ is 100 pcs.', 4); assert.equal(chip(c, TOPIC.MOQ).symbol, '!', 'a contradicting statement is to check');
});

test('chips: documents have their OWN states and NEVER a ✓, even after the user confirmed the claim', () => {
  let s = say(base(), 'We have CE, RoHS and UN38.3.'); assert.equal(chip(s, TOPIC.DOCUMENTS).symbol, '◌'); assert.equal(chip(s, TOPIC.DOCUMENTS).kind, 'DOCUMENT');
  s = confirmAll(s); const d = chip(s, TOPIC.DOCUMENTS); assert.notEqual(d.symbol, '✓'); assert.equal(d.symbol, '◌'); assert.match(d.meaning.fr, /annonc/i);
  assert.equal(chip(base(), TOPIC.DOCUMENTS).symbol, '?');
});

test('chips come in a fixed, short order the screen can rely on', () => {
  const ids = topicChips(base(), run(base())).map((c) => c.topic); assert.deepEqual(ids, [TOPIC.IDENTITY, TOPIC.PRICE, TOPIC.MOQ, TOPIC.COLOURS, TOPIC.LEADTIME, TOPIC.PAYMENT, TOPIC.DOCUMENTS]);
  for (const c of topicChips(base(), run(base()))) { assert.ok(c.label.fr && c.meaning.fr); assert.ok(['✓', '◐', '◌', '!', '?'].includes(c.symbol)); }
});
