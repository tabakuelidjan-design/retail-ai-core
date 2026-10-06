// P5 = the conversation engine (pure). From the case + its assessment it works out: what is known, what is missing, what contradicts, what matters, and the best next question - for the
// SUPPLIER (with a French reading version for the owner and a Chinese version for the supplier) or for the OWNER (small answer cards). It accepts answers out of order: one supplier message
// can settle many questions; questions that became useless disappear; new gaps appear. It never invents Chinese, never turns a supplier statement into evidence, never asks the owner
// something that does not block the next action. Every analysis is recomputed from the case: there is nothing to "launch".
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { upgradeCase } from '../src/sourcing/core/upgrade.js';
import { planConversation, REVIEW } from '../src/sourcing/core/conversation-engine.js';
import { NOW, build, run, ident, traits, importer, commercial, doc, eudoc, MFR } from './sourcing-fixtures.js';

const at = (n = 0) => new Date(NOW.getTime() + n * 1000);
const plan = (s, opts) => planConversation(s, run(s), opts);
const start = (s, n = 1) => dispatch(s, { type: 'CONVERSATION_START', supplierRef: 'Booth 12', lang: 'auto' }, at(n));
const say = (s, text, n = 2, speaker = 'supplier') => dispatch(s, { type: 'CONVERSATION_ITEM', convId: s.conversations.at(-1).id, speaker, lang: 'auto', text }, at(n));
const confirmAll = (s, n = 10) => { for (const c of s.candidates.filter((x) => x.state === 'PROPOSED' && !x.needsCorrection)) { try { s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: c.id }, at(n)); } catch { /* conflicts are handled elsewhere */ } } return s; };
const q = (p, id) => p.questions.find((x) => x.id === id);
const PHONE = 'Model: PB-X200. MOQ is 50 pcs. Price is USD 8 for 50 pcs, USD 7.20 for 100 pcs and USD 6.80 for 300 pcs. FOB Shenzhen. 30% deposit, 70% balance before shipment. Production time is 15 days. We have CE, RoHS and UN38.3.';
const base = () => build([{ type: 'NAME', name: 'Power bank' }, { type: 'CATEGORY', category: 'power_bank' }, ...importer]);

test('a named product with nothing else: the best next question is the model, for the SUPPLIER, in French for the owner and in Chinese for the supplier', () => {
  const p = plan(base()); const n = p.next;
  assert.equal(n.id, 'model'); assert.equal(n.audience, 'SUPPLIER'); assert.equal(n.dimension, 'IDENTITY'); assert.equal(n.priority, 'P1');
  assert.match(n.text.fr, /mod[eè]le/i); assert.match(n.text.en, /model/i); assert.match(n.supplier.zh.text, /型号/);
  assert.equal(n.supplier.zh.review, REVIEW.TECHNICAL_ONLY, 'the V0 phrasebook is technically checked but not yet reviewed by a native speaker'); assert.equal(n.state, 'OPEN');
  assert.ok(n.reason.fr.length > 10 && n.reason.en.length > 10);
});

test('every question the engine can ask has a French text; every Chinese text carries an explicit review state; nothing is presented as certified', () => {
  const s = build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...traits({ 'battery.present': true, 'electrical.present': true }), ...importer]);
  const p = plan(start(s)); assert.ok(p.questions.length > 5);
  for (const x of p.questions) {
    assert.ok(x.text.fr && x.text.fr.length > 8, `${x.id} has French`); assert.ok(!/undefined|\{\w+\}/.test(x.text.fr), `${x.id}: no unfilled placeholder in "${x.text.fr}"`);
    if (x.audience === 'SUPPLIER') { assert.ok(Object.values(REVIEW).includes(x.supplier.zh.review), `${x.id} review state`); if (x.supplier.zh.text) assert.notEqual(x.supplier.zh.review, REVIEW.NATIVE_REVIEWED, 'nothing is native-reviewed yet'); else assert.equal(x.supplier.zh.review, REVIEW.UNAVAILABLE); }
  }
});

test('document questions are bundled into ONE question for the supplier (no wall of 5 questions), listing every document with the model', () => {
  const p = plan(build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...traits({ 'battery.present': true, 'electrical.present': true }), ...importer, ...commercial()]));
  const b = q(p, 'docs-bundle'); assert.ok(b, 'a documents bundle'); assert.equal(b.audience, 'SUPPLIER'); assert.equal(b.dimension, 'DOCUMENTS'); assert.ok(b.items.length >= 4); assert.match(b.text.fr, /PB-X200/); assert.match(b.supplier.zh.text, /PB-X200/);
  assert.equal(p.questions.filter((x) => x.id.startsWith('doc:')).length, 0, 'the individual document questions are inside the bundle');
  assert.ok(b.items.every((i) => i.fr && i.zh), 'each item has both languages'); assert.ok(b.resolves.some((k) => k.startsWith('docClaim.')));
});

test('ONE supplier message settles several questions at once, out of order: they become ANSWER_PENDING, then disappear when confirmed, and new gaps appear', () => {
  let s = start(base()); const p0 = plan(s); const open0 = p0.questions.filter((x) => x.priority === 'P1' && x.audience === 'SUPPLIER').map((x) => x.id);
  assert.ok(['model', 'price', 'incoterm'].every((id) => open0.includes(id)), `P1 before: ${open0}`);
  s = say(s, PHONE); const p1 = plan(s);
  for (const id of ['model', 'price', 'incoterm', 'lead_time']) assert.equal(q(p1, id)?.state, 'ANSWER_PENDING', `${id} is answered but not yet confirmed`);
  assert.ok(p1.next && !['model', 'price', 'incoterm', 'lead_time'].includes(p1.next.id), `next is not a question that was just answered: ${p1.next?.id}`);
  s = confirmAll(s); const p2 = plan(s);
  for (const id of ['model', 'price', 'incoterm', 'lead_time']) assert.equal(q(p2, id), undefined, `${id} is gone once confirmed`);
  assert.ok(p2.resolved.some((r) => r.id === 'price' && r.by.some((k) => k === 'quote.tiers')), 'resolved with the fact that settled it'); assert.ok(p2.summary.missingSupplier < p0.summary.missingSupplier, `fewer important SUPPLIER gaps than before: ${p2.summary.missingSupplier} < ${p0.summary.missingSupplier}`); assert.ok(p2.questions.some((x) => x.id === 'u:freight' && x.audience === 'USER'), 'the answers revealed new needs on the owner side (freight, duty, rate), shown as small cards');
  const b2 = q(p2, 'docs-bundle'); assert.ok(b2, 'the documents are still asked for'); assert.ok(['CE', 'ROHS', 'UN383'].every((c) => b2.waiting.some((w) => w.claim === c && w.status === 'CLAIMED')), 'claimed documents are WAITING, never resolved by a statement'); assert.ok(b2.items.every((i) => !['UN383', 'ROHS_EVIDENCE', 'EU_DOC'].includes(i.docType)), 'the claimed ones are not asked for again as if nothing had been said');
});

test('a supplier CLAIM is not evidence for the engine either: the claimed documents stay open as WAITING and are listed as claims, never as known verified facts', () => {
  let s = start(base()); s = say(s, 'We have CE, RoHS and UN38.3.'); s = confirmAll(s); const p = plan(s);
  assert.ok(p.known.filter((k) => k.key.startsWith('docClaim.')).every((k) => k.status === 'SUPPLIER_CLAIM')); assert.ok(p.known.every((k) => !['VERIFIED', 'DOCUMENT_RECEIVED', 'DOCUMENT_MATCHED'].includes(k.status)));
  assert.ok(q(p, 'docs-bundle').waiting.length >= 3, 'the claimed documents are WAITING'); assert.equal(run(s).documents.length, 0);
});

test('memory: a question shown to the supplier is ASKED and is not proposed again; an answer that does not address it makes it UNANSWERED (repeat, lower rank); "later" snoozes it until the next supplier message', () => {
  let s = start(base()); let p = plan(s); assert.equal(p.next.id, 'model');
  s = dispatch(s, { type: 'QUESTION_SHOWN', questionId: 'model', via: 'SHOWN_TO_SUPPLIER', texts: { fr: p.next.text.fr, zh: p.next.supplier.zh.text, zhReview: p.next.supplier.zh.review } }, at(3)); p = plan(s);
  assert.equal(q(p, 'model').state, 'ASKED'); assert.notEqual(p.next.id, 'model', 'not asked twice in a row'); assert.ok(s.questionLog.at(-1).texts.zh, 'what was shown (both languages) is kept');
  s = say(s, 'Thank you, nice product, very popular.', 4); p = plan(s); assert.equal(q(p, 'model').state, 'UNANSWERED'); assert.equal(q(p, 'model').repeat, true);
  s = dispatch(s, { type: 'QUESTION_SKIP', questionId: 'manufacturer' }, at(5)); p = plan(s); assert.equal(q(p, 'manufacturer').state, 'SKIPPED'); assert.notEqual(p.next.id, 'manufacturer');
  s = say(s, 'ok', 6); p = plan(s); assert.equal(q(p, 'manufacturer').state, 'OPEN', 'a new supplier message wakes a skipped question');
  assert.deepEqual(s.questionLog.map((e) => e.kind), ['SHOWN', 'SKIPPED']);
});

test('a contradiction becomes the FIRST thing to clarify, with French for the owner and a Chinese sentence marked UNREVIEWED (or none when no sentence exists)', () => {
  let s = start(build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...importer, { type: 'QUOTE', quote: { unitPrice: '8', currency: 'USD', qty: 50, moq: 50 } }]));
  s = say(s, 'Actually the MOQ is 100 pcs.'); s = confirmAll(s); const p = plan(s);
  assert.equal(p.contradictions.length, 1); assert.equal(p.next.source, 'CONFLICT'); assert.match(p.next.text.fr, /50/); assert.match(p.next.text.fr, /100/); assert.match(p.next.supplier.zh.text, /50.*100|100.*50/); assert.equal(p.next.supplier.zh.review, REVIEW.UNREVIEWED);
  assert.equal(p.summary.conflicts, 1); assert.match(p.summary.message.fr, /contradiction|clarifier/i);
  s = start(s, 20); s = say(s, 'Model: PB-X180', 21, 'supplier'); s = confirmAll(s); const m = plan(s).contradictions.find((c) => c.key === 'identifier.model'); assert.ok(m); assert.ok(plan(s).questions.find((x) => x.id === m.questionId).supplier.zh.review === REVIEW.UNREVIEWED);
});

test('free questions of the owner are kept as written; their Chinese is UNAVAILABLE (nothing is simulated) unless a translation provider is plugged in, and then it is labelled as machine output', () => {
  let s = dispatch(base(), { type: 'QUESTION_ADD', text: 'Combien de couleurs avez-vous et puis-je les mélanger ?', lang: 'fr' }, at(1)); const x = plan(s).questions.find((y) => y.source === 'USER_FREE');
  assert.equal(x.audience, 'SUPPLIER'); assert.equal(x.text.fr, 'Combien de couleurs avez-vous et puis-je les mélanger ?'); assert.equal(x.supplier.zh.text, null); assert.equal(x.supplier.zh.review, REVIEW.UNAVAILABLE); assert.notEqual(plan(s).next?.id, x.id, 'a free question is never pushed as the "next question"');
  const fake = { translate: ({ text }) => ({ text: `[ZH]${text}`, provider: 'test-double' }) }; const y = plan(s, { providers: { translation: fake } }).questions.find((z) => z.source === 'USER_FREE');
  assert.equal(y.supplier.zh.text, '[ZH]Combien de couleurs avez-vous et puis-je les mélanger ?'); assert.equal(y.supplier.zh.review, REVIEW.MACHINE); assert.equal(y.supplier.zh.provider, 'test-double');
});

test('the owner card questions are contextual: no cost, no selling price and no margin question while the supplier basics are missing', () => {
  const p = plan(start(base())); assert.deepEqual(p.questions.filter((x) => x.audience === 'USER' && x.dimension !== 'ROLE').map((x) => x.id), [], 'no owner cost cards before the supplier price and Incoterm exist');
  assert.equal(p.questions.some((x) => ['u:freight', 'u:duty', 'u:fx', 'u:sellingPrice', 'u:margin'].includes(x.id)), false);
});

test('the progress message follows the case: many missing -> a few missing before an evaluation -> "analysis complete enough" with what remains; it never hides UNKNOWN', () => {
  let s = start(base()); let m = plan(s).summary; assert.equal(m.stage, 'GATHERING'); assert.match(m.message.fr, /^Il me manque encore \d+ informations importantes\./); assert.ok(m.missingImportant >= 5);
  const named = plan(build([])).summary; assert.equal(named.stage, 'START'); assert.match(named.message.fr, /produit/i);
  s = say(s, PHONE); s = confirmAll(s); const m2 = plan(s).summary; assert.ok(m2.missingSupplier < m.missingSupplier); assert.equal(m2.stage, 'GATHERING'); assert.match(m2.message.fr, /^Il me manque encore 2 informations importantes du fournisseur et 3 choses à saisir de votre côté\./);
  const full = build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...traits({ 'battery.present': true, 'electrical.present': true }), ...importer, ...commercial()]); const f = plan(full).summary;
  assert.equal(run(full).decision.verdict !== 'INSUFFICIENT_INFORMATION', true); assert.equal(f.stage, 'EVALUABLE'); assert.match(f.message.fr, /^Analyse suffisamment complète/); assert.ok(f.residual.some((r) => r.code === 'REGULATORY'), 'a regulatory risk remains'); assert.match(f.message.fr, /risque réglementaire/);
  assert.ok(f.residual.some((r) => r.code === 'TRANSPORT'), 'freight in the V0 form is an estimate: the transport is still to be determined'); assert.match(f.message.fr, /transport/);
  const near = build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...importer, { type: 'QUOTE', quote: { unitPrice: '4.2', currency: 'USD', qty: 500, moq: 500, incoterm: 'FOB' } }]); const n = plan(near).summary;
  assert.equal(run(near).decision.verdict, 'INSUFFICIENT_INFORMATION'); assert.match(n.message.fr, /avant de pouvoir évaluer|Il me manque encore/);
});

test('no manual "analyze": the plan is recomputed from the case alone; one confirmed fact changes it without calling anything else', () => {
  let s = start(base()); const before = JSON.stringify(plan(s).summary); s = say(s, 'Model: PB-X200'); const mid = JSON.stringify(plan(s).summary); s = confirmAll(s); const after = plan(s);
  assert.notEqual(before, JSON.stringify(after.summary)); assert.equal(q(after, 'model'), undefined); assert.deepEqual(plan(s), plan(s), 'pure and deterministic'); void mid;
});

test('timeline: supplier words (original), what was shown to the supplier and the confirmation batches in order; the original text is never replaced by a translation', () => {
  let s = start(base()); s = dispatch(s, { type: 'QUESTION_SHOWN', questionId: 'model', via: 'SHOWN_TO_SUPPLIER', texts: { fr: 'Quel est le modèle ?', zh: '请问这款产品的准确型号(Model No.)是多少?', zhReview: REVIEW.TECHNICAL_ONLY } }, at(2));
  s = say(s, '型号：PB-X200，起订量50个', 3); const t = plan(s).timeline;
  assert.deepEqual(t.map((e) => e.kind), ['ASKED', 'SUPPLIER']); assert.equal(t[1].original, '型号：PB-X200，起订量50个'); assert.equal(t[0].texts.fr, 'Quel est le modèle ?');
});

test('V0/V1 compatibility: an older schema-2 case without the new collections plans fine and is upgraded losslessly; a V0 case plans too', () => {
  const s = start(base()); const legacy = JSON.parse(JSON.stringify(s)); delete legacy.questionLog; delete legacy.confirmBatches;
  assert.ok(planConversation(legacy, run(legacy)).questions.length > 3); const up = upgradeCase(legacy); assert.deepEqual(up.questionLog, []); assert.deepEqual(up.confirmBatches, []);
  const v0 = JSON.parse(JSON.stringify(base())); for (const k of ['conversations', 'candidates', 'ledger', 'conflicts', 'documentLedger', 'userQuestions', 'questionLog', 'confirmBatches']) delete v0[k]; v0.schema = 1;
  assert.equal(planConversation(v0, run(v0)).next.id, 'model');
});

test('the engine is origin-market aware without hard-coding China: the supplier language and phrasebook come from a market profile; an unknown profile gives UNAVAILABLE, never a guess', () => {
  const s = start(base()); assert.equal(plan(s).profile.id, 'CN'); assert.equal(plan(s).profile.supplierLang, 'zh');
  const other = plan(s, { profile: { id: 'XX', supplierLang: 'xx', phrasebook: null } }); assert.equal(other.next.supplier.zh.text, null); assert.equal(other.next.supplier.zh.review, REVIEW.UNAVAILABLE); assert.ok(other.next.text.fr, 'the owner still reads French');
});

import { answerEvents, validateAnswer } from '../src/sourcing/core/conversation-engine.js';

test('OWNER cards appear one at a time, in the right order, only when they block the next action; each answer compiles into the existing events and the card disappears', () => {
  let s = start(base()); s = say(s, `${PHONE} Manufacturer: Brightway Electronics Ltd`); let p = plan(s);
  assert.equal(p.questions.some((x) => x.audience === 'USER'), false, 'nothing for the owner while the supplier answers are only proposed (not confirmed)');
  s = confirmAll(s); p = plan(s); assert.equal(p.next.id, 'docs-bundle', 'the supplier documents come before any owner card'); assert.equal(p.questions.filter((x) => x.audience === 'USER' && x.priority === 'P1').map((x) => x.id).join(), 'u:freight,u:duty,u:fx'); assert.ok(p.questions.filter((x) => x.id.startsWith('u:trait:')).length <= 2, 'at most two confirmation cards for what was only assumed from the category');
  s = dispatch(s, { type: 'QUESTION_SHOWN', questionId: 'docs-bundle', via: 'SHOWN_TO_SUPPLIER', texts: { fr: p.next.text.fr, zh: p.next.supplier.zh.text } }, at(11)); p = plan(s);
  assert.equal(p.next.id, 'u:freight'); assert.equal(p.next.audience, 'USER'); assert.equal(p.next.answer.kind, 'NUMBER'); assert.match(p.next.text.fr, /transport/i); assert.equal(p.next.supplier, undefined, 'an owner card has no supplier text');
  const apply = (q, v, n) => { for (const e of answerEvents(s, q, v, at(n))) s = dispatch(s, e, at(n)); return plan(s); };
  p = apply(p.next, '600', 12); assert.equal(p.questions.some((x) => x.id === 'u:freight'), false); assert.equal(s.costs.costs.freight.total, '600'); assert.equal(s.costs.importVat, undefined, 'the VAT treatment is never assumed by a card');
  p = apply(q(p, 'u:duty'), '2.7', 13); assert.equal(s.customs.duty.ratePct, '2.7'); assert.equal(s.customs.duty.kind, 'USER_ENTERED');
  assert.equal(p.questions.some((x) => ['u:sellingPrice', 'u:margin'].includes(x.id)), false, 'no selling price / margin question while the landed cost cannot be computed');
  p = apply(q(p, 'u:fx'), '0.92', 14); assert.equal(s.costs.fx.rate, '0.92'); assert.equal(run(s).landed.status !== 'INFORMATION_INSUFFICIENT', true);
  assert.equal(p.next.id, 'u:sellingPrice', 'only now, because the next action (the margin) is blocked by it'); p = apply(p.next, '21', 15); assert.equal(s.sale.sellingPriceGross, '21'); assert.equal(p.next.id, 'u:margin');
  p = apply(p.next, '30', 16); assert.equal(s.sale.targetContributionPct, '30'); assert.equal(p.questions.some((x) => x.audience === 'USER' && x.priority === 'P1'), false, 'no blocking owner card left'); assert.equal(p.summary.stage, 'EVALUABLE'); assert.match(p.summary.message.fr, /^Analyse suffisamment complète/);
  assert.ok(run(s).maxPurchasePrice.maxUnitPriceMinor !== null, 'the deterministic engines recomputed silently: a maximum purchase price exists');
});

test('owner answers are validated: no decimal comma, no zero, no percentage above 100; a yes/no card accepts only a boolean', () => {
  const nq = { answer: { kind: 'NUMBER', field: 'freight', unit: 'EUR' } }; const pq = { answer: { kind: 'NUMBER', field: 'margin', unit: '%' } }; const yq = { answer: { kind: 'YESNO', trait: 'battery.present' } };
  assert.deepEqual(validateAnswer(nq, ' 600 '), { ok: true, value: '600' }); for (const bad of ['6,8', '0', '-5', 'abc', '']) assert.equal(validateAnswer(nq, bad).ok, false, bad);
  assert.equal(validateAnswer(pq, '130').ok, false); assert.equal(validateAnswer(pq, '30').ok, true); assert.equal(validateAnswer(yq, true).ok, true); assert.equal(validateAnswer(yq, 'yes').ok, false);
  assert.throws(() => answerEvents(newCase({ now: NOW }), nq, '6,8'), /virgule|point/i);
});

test('trait and brand cards: asked only after the supplier basics, never more than two traits, confirmed traits become USER_STATED and the card disappears', () => {
  let s = build([{ type: 'NAME', name: 'Power bank' }, { type: 'CATEGORY', category: 'power_bank' }]); s = start(s); let p = plan(s);
  assert.equal(p.questions.some((x) => x.audience === 'USER'), false);
  s = say(s, `${PHONE} Manufacturer: Brightway Electronics Ltd`); s = confirmAll(s); p = plan(s); const u = p.questions.filter((x) => x.audience === 'USER');
  assert.ok(u.some((x) => x.id === 'u:brand'), 'the role question comes with the basics known'); assert.ok(u.filter((x) => x.id.startsWith('u:trait:')).length <= 2);
  const brand = q(p, 'u:brand'); for (const e of answerEvents(s, brand, true, at(30))) s = dispatch(s, e, at(30)); assert.equal(s.placing.underOwnNameOrBrand, true); assert.equal(q(plan(s), 'u:brand'), undefined);
  const trait = plan(s).questions.find((x) => x.id.startsWith('u:trait:')); if (trait) { for (const e of answerEvents(s, trait, true, at(31))) s = dispatch(s, e, at(31)); assert.equal(s.identity.evidence[trait.answer.trait].at(-1).level, 'USER_STATED'); assert.equal(q(plan(s), trait.id), undefined); }
  assert.ok(q(plan(s), 's:logo') && q(plan(s), 's:packaging'), 'private label makes the logo and packaging questions useful');
});

test('suggested commercial questions appear only when useful and disappear once answered by a CONFIRMED fact', () => {
  let s = start(base()); assert.equal(plan(s).questions.some((x) => x.source === 'SUGGESTED'), false, 'nothing suggested before a price exists');
  s = say(s, 'USD 8 for 50 pcs. MOQ is 50 pcs. FOB Shenzhen. We have black, white and blue.'); s = confirmAll(s); const p = plan(s);
  assert.ok(q(p, 's:payment'), 'payment terms are useful once a price exists'); assert.equal(q(p, 's:colours'), undefined, 'colours were answered by a confirmed fact'); assert.ok(q(p, 's:mixed_colours'), 'with several colours, mixing is worth asking'); assert.match(q(p, 's:mixed_colours').supplier.zh.text, /混批/); assert.equal(q(p, 's:mixed_colours').supplier.zh.review, REVIEW.UNREVIEWED);
});
