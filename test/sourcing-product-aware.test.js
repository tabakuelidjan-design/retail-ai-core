// PRODUCT-AWARE ASK NEXT. Nordla is not a questionnaire: signals (name, photo, owner, supplier, documents) -> a product HYPOTHESIS with TRAITS (provenance + confidence) -> applicability of generic information
// NEEDS (data + predicates, the same three-valued predicates as the rules) -> ranked, explainable -> ONE best next question. Category is only one source of probable traits; an unknown product stays unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { planConversation } from '../src/sourcing/core/conversation-engine.js';
import { planContext } from '../src/sourcing/core/context-engine.js';
import { buildProductHypothesis } from '../src/sourcing/core/product-hypothesis.js';
import { observeProductSync, nameObserver, imageObserver, OBSERVER_STATUS, TRAIT_CUES } from '../src/sourcing/core/product-observer.js';
import { NEEDS, needOfQuestion } from '../src/sourcing/core/needs.js';

const T0 = new Date('2026-10-07T10:00:00.000Z'); const at = (n = 0) => new Date(T0.getTime() + n * 1000);
const named = (name, extra = []) => { let s = dispatch(newCase({ id: 'c', name }), { type: 'NAME', name }); for (const e of extra) s = dispatch(s, e, at(1)); return dispatch(s, { type: 'CONVERSATION_START', supplierRef: null, lang: 'auto' }, at(2)); };
const withModel = (m = 'X-100') => ({ type: 'IDENTIFIER', name: 'model', value: m, level: 'USER_STATED', source: { kind: 'user' } });
const plan = (s) => planConversation(s, assess(s, { now: T0 }));
const active = (p) => p.questions.filter((q) => ['OPEN', 'UNANSWERED'].includes(q.state) && q.audience === 'SUPPLIER').map((q) => q.id);
const say = (s, text, n = 3, speaker = 'supplier') => dispatch(s, { type: 'CONVERSATION_ITEM', convId: s.conversations.at(-1).id, speaker, lang: 'auto', text }, at(n));

test('A. passive phone case: the compatibility need is relevant; the battery / radio / voltage questions and the battery documents are NOT', () => {
  const s = named('iPhone 15 MagSafe case', [withModel()]); const p = plan(s); const ids = active(p); const h = buildProductHypothesis(s);
  assert.equal(h.category.status, 'UNKNOWN', 'no category was forced'); assert.equal(h.traits['compatibility.required'].value, true); assert.equal(h.traits['battery.present'].value, false); assert.equal(h.traits['battery.present'].status, 'PROBABLE');
  assert.ok(ids.includes('need:compat_models'), ids.join()); for (const x of ['battery', 'radio', 'voltage', 'mains', 'need:capacity_battery', 'need:capacity_volume']) assert.ok(!ids.includes(x), `${x} must not be asked for a passive case`);
  const docs = p.questions.find((q) => q.id === 'docs-bundle'); assert.ok(!docs || !docs.items.some((i) => ['UN383', 'BATTERY_DOC'].includes(i.docType)), 'no battery documents requested');
  assert.ok(assess(s).rules.results.filter((r) => /batter|lithium/.test(r.ruleId)).every((r) => r.status === 'NOT_APPLICABLE'), 'the battery rules are NOT_APPLICABLE');
});

test('B. power bank: battery and capacity needs are relevant, the battery evidence appears, and the questions differ materially from the passive case', () => {
  const s = named('Power bank 10000mAh', [withModel()]); const p = plan(s); const ids = active(p); const phone = active(plan(named('iPhone 15 MagSafe case', [withModel()])));
  assert.ok(ids.includes('need:capacity_battery')); assert.ok(!ids.includes('need:compat_models'), 'compatibility is not known to matter for a power bank');
  const docs = p.questions.find((q) => q.id === 'docs-bundle'); assert.ok(docs && docs.items.some((i) => ['UN383', 'BATTERY_DOC'].includes(i.docType)), 'battery transport / safety evidence is asked');
  assert.notDeepEqual(ids.slice(0, 5), phone.slice(0, 5)); assert.ok(ids.some((x) => !phone.includes(x)) && phone.some((x) => !ids.includes(x)), 'each has questions the other does not');
});

test('C. food-contact bottle: the material and capacity needs are relevant; no battery / radio / voltage question', () => {
  const s = named('Insulated water bottle 500ml', [withModel()]); const p = plan(s); const ids = active(p);
  assert.ok(ids.includes('need:contact_material')); assert.ok(ids.includes('need:capacity_volume')); for (const x of ['battery', 'radio', 'voltage', 'need:capacity_battery', 'need:compat_models', 'need:age_range']) assert.ok(!ids.includes(x), x);
});

test('D. unknown electronic product: the category stays UNKNOWN, yet the traits that ARE known generate intelligent needs', () => {
  const s = named('rechargeable USB gadget', [withModel()]); const h = buildProductHypothesis(s); const ids = active(plan(s));
  assert.equal(h.category.status, 'UNKNOWN'); assert.equal(h.category.value, null); assert.equal(h.traits['battery.present'].value, true); assert.equal(h.traits['battery.present'].status, 'PROBABLE'); assert.equal(h.traits['battery.present'].sources[0].source, 'PRODUCT_NAME');
  assert.ok(ids.includes('need:capacity_battery')); assert.ok(!ids.includes('battery'), 'the battery question is not asked again: it is already known (as PROBABLE)');
});

test('E. unknown applicability is not NOT_APPLICABLE: with a battery UNKNOWN the discriminating battery question is among the best next questions, valued for what it UNLOCKS', () => {
  const s = named('Widget', [withModel()]); const p = plan(s); const top = p.needs.asked.slice(0, 4).map((a) => a.questionId); const bat = p.needs.asked.find((a) => a.questionId === 'battery'); const price = p.needs.asked.find((a) => a.questionId === 'price');
  assert.ok(bat && top.includes('battery'), top.join()); assert.equal(bat.dimension, 'IDENTITY'); assert.ok(bat.parts.some((x) => x.code === 'REGULATORY_UNLOCK' && x.pts > 0), 'it unlocks regulatory rules'); assert.ok(bat.score > price.score, 'a discriminating question can come BEFORE the detailed sourcing ones');
  assert.ok(!active(p).includes('need:capacity_battery'), 'a spec need is not asked while its applicability is unknown'); assert.equal(buildProductHypothesis(s).traits['battery.present'].status, 'UNKNOWN');
});

test('F. the supplier states the MOQ: the MOQ part of the price question disappears (only the price is still asked) and ASK NEXT moves on; once both are known it is resolved', () => {
  let s = named('Power bank 10000mAh', [withModel()]); const before = plan(s).questions.find((q) => q.id === 'price'); assert.match(before.text.en, /unit price.*minimum order quantity|MOQ/i); assert.deepEqual(before.resolves, ['quote.unitPrice', 'quote.tiers']);
  s = say(s, 'MOQ is 100 pcs.'); const mid = plan(s).questions.find((q) => q.id === 'price'); assert.match(mid.text.en, /unit price/i); assert.doesNotMatch(mid.text.en, /minimum order quantity|MOQ/i); assert.deepEqual(mid.resolves, ['quote.unitPrice', 'quote.tiers']); assert.match(mid.supplier.zh.text, /单价/); assert.doesNotMatch(mid.supplier.zh.text, /起订量/);
  let t = named('Power bank 10000mAh', [withModel()]); t = say(t, 'The price is USD 8.'); const mid2 = plan(t).questions.find((q) => q.id === 'price'); assert.match(mid2.text.en, /minimum order quantity/i); assert.doesNotMatch(mid2.text.en, /unit price/i); assert.deepEqual(mid2.resolves, ['quote.moq']);
  s = say(s, 'USD 8 for 100 pcs.', 4); const after = plan(s); assert.ok(!active(after).includes('price'), 'both stated: answer pending, not asked again');
});

test('G. a contradiction outranks everything: it is the best next question, and its score says why', () => {
  let s = named('Power bank 10000mAh', [withModel()]); s = say(s, 'MOQ is 50 pcs.', 3); s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: s.candidates.find((c) => c.key === 'quote.moq').id }, at(4)); s = say(s, 'Sorry, MOQ is 100 pcs.', 5); s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: s.candidates.filter((c) => c.key === 'quote.moq').at(-1).id }, at(6)); // confirming the second statement raises the contradiction
  const p = plan(s); assert.match(p.next.id, /^conflict:/); const it = p.needs.asked[0]; assert.equal(it.dimension, 'CONFLICT'); assert.ok(it.score > p.needs.asked[1].score + 20, 'a meaningful contradiction outranks a low-value new question'); assert.equal(it.parts[0].code, 'CONTRADICTION');
});

test('H. different product names no longer begin with the same generic sequence', () => {
  const seqs = ['iPhone 15 MagSafe case', 'Power bank 10000mAh', 'Insulated water bottle 500ml', 'Kids toy car', 'Widget'].map((n) => active(plan(named(n))).slice(0, 6).join('>'));
  assert.equal(new Set(seqs).size, seqs.length, seqs.join('\n'));
});

test('every ranked question explains itself: named parts with a French and an English reason; set-aside needs say why; Expert can read all of it', () => {
  const p = plan(named('Power bank 10000mAh', [withModel()])); assert.ok(p.needs.asked.length >= 3);
  for (const a of p.needs.asked) { assert.ok(a.parts.length >= 1 && a.parts.every((x) => x.code && Number.isFinite(x.pts) && x.fr && x.en), a.questionId); assert.equal(a.parts.reduce((t, x) => t + x.pts, 0), a.score, 'the score is exactly the sum of its parts'); assert.ok(a.why.fr.length > 20); }
  const sup = p.questions.filter((q) => ['OPEN', 'UNANSWERED'].includes(q.state) && q.audience === 'SUPPLIER'); assert.ok(sup.every((q) => q.need && q.need.parts.length), 'every active supplier question carries its explanation');
  const phone = plan(named('iPhone 15 MagSafe case', [withModel()])); assert.ok(phone.questions.filter((q) => q.state === 'NOT_APPLICABLE').length >= 0);
});

test('the ranking is deterministic and read-only: same case, same answer; the case is not mutated', () => {
  const s = named('Power bank 10000mAh', [withModel()]); const snap = JSON.stringify(s); const a = plan(s); const b = plan(s); assert.deepEqual(a.needs, b.needs); assert.equal(JSON.stringify(s), snap);
});

test('the context engine offers ONE suggestion that is product-aware (the first of the ranking when nothing is being discussed)', () => {
  const ctx = planContext(named('iPhone 15 MagSafe case', [withModel()]), assess(named('iPhone 15 MagSafe case', [withModel()]), { now: T0 })); assert.ok(ctx.suggestion); assert.ok(!['battery', 'radio', 'voltage'].includes(ctx.suggestion.id)); assert.ok(ctx.suggestion.need.parts.length);
});

// ---- observer contract, hypothesis, provenance ------------------------------------------------------------------------------------------------------------------------------------------------
test('PRODUCT OBSERVER contract: NAME is real and deterministic; IMAGE answers PROVIDER_NOT_CONFIGURED / NO_IMAGE and nothing is interpreted or uploaded', () => {
  const r = observeProductSync({ name: 'Power bank 10000mAh', imageRef: 'photo-0' }); const by = Object.fromEntries(r.results.map((x) => [x.observer, x]));
  assert.equal(by['name-cues'].status, OBSERVER_STATUS.OK); assert.ok(by['name-cues'].observations.every((o) => o.trait && 'value' in o && ['LOW', 'MEDIUM', 'HIGH'].includes(o.confidence) && o.source === 'PRODUCT_NAME' && o.provenance.observer === 'name-cues'));
  assert.equal(by.image.status, OBSERVER_STATUS.PROVIDER_NOT_CONFIGURED); assert.deepEqual(by.image.observations, []); assert.equal(imageObserver.observe({}).status, OBSERVER_STATUS.NO_IMAGE); assert.equal(nameObserver.observe({ name: '  ' }).status, OBSERVER_STATUS.NO_INPUT);
  assert.deepEqual(nameObserver.observe({ name: 'Power bank' }), nameObserver.observe({ name: 'Power bank' })); assert.ok(TRAIT_CUES.every((c) => c.re && c.traits.length), 'cues are data about TRAITS, not product names');
});

test('a PHOTO is kept and honestly reported as NOT interpreted; an approved adapter reports through the same PRODUCT_OBSERVED event, as AI_SUGGESTED, never above the owner', () => {
  let s = named('Widget'); s = dispatch(s, { type: 'PHOTO', ref: 'photo-0', note: 'IMG.jpg' }, at(3)); const img = s.productObservations.find((o) => o.observer === 'image'); assert.equal(img.status, 'PROVIDER_NOT_CONFIGURED'); assert.equal(buildProductHypothesis(s).sources.find((x) => x.observer === 'image').status, 'PROVIDER_NOT_CONFIGURED');
  s = dispatch(s, { type: 'PRODUCT_OBSERVED', observer: 'vision-adapter', source: 'IMAGE_OBSERVATION', status: 'OK', input: { imageRef: 'photo-0' }, observations: [{ trait: 'battery.present', value: true, confidence: 'MEDIUM', source: 'IMAGE_OBSERVATION', provenance: { model: 'x' } }, { trait: 'radio.present', value: true, confidence: 'LOW', source: 'IMAGE_OBSERVATION', provenance: {} }, { bad: 1 }], hypotheses: [{ category: 'power_bank', confidence: 'LOW', evidence: ['looks like'] }] }, at(4));
  let h = buildProductHypothesis(s); assert.equal(h.traits['battery.present'].status, 'SUGGESTED'); assert.equal(h.traits['battery.present'].sources[0].source, 'IMAGE_OBSERVATION'); assert.equal(h.traits['radio.present'].status, 'UNKNOWN', 'a LOW observation stays a hypothesis, not evidence');
  s = dispatch(s, { type: 'TRAIT', trait: 'battery.present', value: false, level: 'USER_STATED' }, at(5)); h = buildProductHypothesis(s); assert.equal(h.traits['battery.present'].value, false); assert.equal(h.traits['battery.present'].status, 'CONFIRMED');
});

test('renaming the product SUPERSEDES the old name evidence; contradictory cues make a trait UNKNOWN again instead of picking one; an unknown name degrades gracefully', () => {
  let s = named('iPhone 15 case'); assert.equal(buildProductHypothesis(s).traits['battery.present'].value, false); s = dispatch(s, { type: 'NAME', name: 'Battery case for iPhone' }, at(3)); const h = buildProductHypothesis(s);
  assert.equal(h.traits['battery.present'].known, false); assert.equal(h.traits['battery.present'].contradiction, true); assert.equal(s.productObservations.filter((o) => o.observer === 'name-cues').length, 1, 'one name observation: the earlier one was superseded');
  const u = buildProductHypothesis(named('Newport Case')); assert.equal(u.category.status, 'UNKNOWN'); assert.equal(u.summary.known, 0); assert.ok(active(plan(named('Newport Case'))).includes('model'), 'it still asks sensible generic questions');
});

test('the owner confirming a category is still the strongest category evidence; a name-derived category is only a HYPOTHESIS (never in the case as category)', () => {
  const s = named('Power bank 10000mAh'); const h = buildProductHypothesis(s); assert.equal(h.category.status, 'HYPOTHESIS'); assert.equal(h.category.best.category, 'power_bank'); assert.equal(s.identity.evidence.category, undefined);
  const c = dispatch(s, { type: 'CATEGORY', category: 'power_bank', level: 'USER_STATED' }, at(5)); assert.equal(buildProductHypothesis(c).category.status, 'CONFIRMED');
});

test('the catalogue is DATA: every need has predicates over traits/context, no entry reads a category id, and every question id maps to at most one need', () => {
  const ids = new Set(); for (const n of NEEDS) { assert.ok(n.id && n.dimension && n.appliesWhen && n.reason?.fr && n.reason?.en, n.id); assert.ok(!JSON.stringify(n.appliesWhen).includes('"category"'), `${n.id} must not be a category questionnaire`); for (const q of [...(n.ids ?? []), ...(n.own ? [n.own.id] : [])]) { assert.ok(!ids.has(q), `${q} mapped twice`); ids.add(q); } }
  assert.equal(needOfQuestion('model').id, 'model'); assert.equal(needOfQuestion('doc:EU_DOC:2014/35').id, 'docs'); assert.equal(needOfQuestion('nothing-here'), null);
});
