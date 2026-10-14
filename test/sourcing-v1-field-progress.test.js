// The early field workflow shell (Discover -> Talk -> Capture -> Complete -> Analyze -> Decide -> Negotiate) is an HONEST view over the existing engines: it never states more than
// the engines know, never hides a blocker, and labels everything that is not built yet "NOT AVAILABLE YET". These tests pin that down on the pure helper behind the screens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newCase, dispatch } from '../src/sourcing/core/case.js';
import { fieldProgress, UNAVAILABLE_ENGINES, STEP_IDS } from '../src/sourcing/core/field-progress.js';
import { NOW, MFR, build, run, ident, traits, importer, commercial, docsFor } from './sourcing-fixtures.js';

const at = (n = 0) => new Date(NOW.getTime() + n * 1000);
const progress = (s) => fieldProgress(s, run(s));
const step = (p, id) => p.steps.find((x) => x.id === id);

test('the seven steps exist in the field order, for an empty case too, with honest statuses', () => {
  const p = progress(newCase({ id: 'e', now: NOW })); assert.deepEqual(p.steps.map((x) => x.id), ['discover', 'talk', 'capture', 'complete', 'analyze', 'decide', 'negotiate']); assert.deepEqual(STEP_IDS, p.steps.map((x) => x.id));
  assert.equal(step(p, 'discover').status, 'TODO'); assert.equal(step(p, 'capture').status, 'TODO'); assert.equal(step(p, 'negotiate').status, 'NOT_AVAILABLE');
  assert.equal(p.nextStep.step, 'discover'); assert.ok(p.nextStep.text.length > 5);
  for (const x of p.steps) { assert.ok(x.label && typeof x.summary === 'string'); assert.ok(['DONE', 'IN_PROGRESS', 'TODO', 'NOT_AVAILABLE'].includes(x.status)); }
});

test('Decide shows the EXISTING compliance + economics verdict and says plainly that the business decision is not available yet', () => {
  const s = build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...importer, ...commercial()]); const a = run(s); const p = fieldProgress(s, a); const d = step(p, 'decide');
  assert.equal(d.verdict, a.decision.verdict); assert.match(d.summary, /compliance/i); assert.equal(p.businessDecision.status, 'NOT_AVAILABLE_YET'); assert.match(p.businessDecision.label, /not available yet/i);
  assert.ok(!/\b(BUY|WAIT|PASS)\b/.test(d.summary) || /not available/i.test(d.summary), 'no BUY/NEGOTIATE/WAIT/PASS is ever invented');
  assert.deepEqual(d.hardBlockers, a.decision.hardBlockers.map((b) => b.code), 'blockers are listed, never hidden by the stepper');
});

test('Negotiate is only shown when the engine really has a maximum purchase price; otherwise it says why it is not available', () => {
  const none = progress(build([{ type: 'NAME', name: 'Mystery' }])); assert.equal(step(none, 'negotiate').status, 'NOT_AVAILABLE'); assert.match(step(none, 'negotiate').summary, /not available/i);
  const s = build([...ident({ name: 'Power bank', category: 'power_bank' }), ...importer, ...commercial()]); const a = run(s); assert.notEqual(a.maxPurchasePrice.maxUnitPriceMinor, null);
  const n = step(fieldProgress(s, a), 'negotiate'); assert.notEqual(n.status, 'NOT_AVAILABLE'); assert.ok(n.summary.includes(a.maxPurchasePrice.display));
});

test('Talk and Complete count what is open from the engines (P1 questions), not from guesses; a conversation moves Capture forward', () => {
  let s = build([...ident({ name: 'Power bank', category: 'power_bank' }), ...importer]); const a0 = run(s); const p0 = fieldProgress(s, a0);
  const p1 = a0.questions.filter((q) => q.priority === 'P1').length; assert.ok(p1 > 0); assert.equal(step(p0, 'talk').open, p1); assert.equal(step(p0, 'talk').status, 'TODO'); assert.equal(step(p0, 'complete').status, 'IN_PROGRESS');
  s = dispatch(s, { type: 'CONVERSATION_START', supplierRef: 'Booth 4' }, at(1)); s = dispatch(s, { type: 'CONVERSATION_ITEM', convId: s.conversations[0].id, speaker: 'supplier', lang: 'auto', text: 'MOQ 100 pcs, USD 7.20, FOB Shenzhen' }, at(2));
  const p1b = progress(s); assert.equal(step(p1b, 'capture').status, 'IN_PROGRESS'); assert.ok(step(p1b, 'capture').pending >= 3); assert.equal(p1b.nextStep.step, 'capture', 'unreviewed candidates come first');
  assert.match(step(p1b, 'capture').summary, /to review/i);
  for (const c of s.candidates) s = dispatch(s, { type: 'CANDIDATE_REJECT', id: c.id }, at(3)); s = dispatch(s, { type: 'CONVERSATION_FINISH', convId: s.conversations[0].id }, at(4)); assert.equal(step(progress(s), 'capture').status, 'DONE');
});

test('an open conflict, a document that names another model and a claimed-but-not-received document are listed under Complete (contradictions are never hidden)', () => {
  let s = build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...importer]);
  s = dispatch(s, { type: 'CONVERSATION_START' }, at(1)); s = dispatch(s, { type: 'CONVERSATION_ITEM', convId: 'conv-1', speaker: 'supplier', lang: 'en', text: 'Model: PB-X180. We have UN38.3.' }, at(2));
  for (const k of ['identifier.model', 'docClaim.UN383']) s = dispatch(s, { type: 'CANDIDATE_CONFIRM', id: s.candidates.find((c) => c.key === k).id }, at(3));
  const c = step(progress(s), 'complete'); assert.equal(c.status, 'IN_PROGRESS'); assert.equal(c.conflicts, 1); assert.deepEqual(c.claimsNotReceived, ['UN383']); assert.ok(c.items.some((i) => i.kind === 'CONFLICT' && /PB-X180/.test(i.text)));
  assert.equal(progress(s).nextStep.step, 'complete'); assert.match(progress(s).nextStep.text, /contradiction|conflict|clarif/i);
  s = dispatch(s, { type: 'DOCUMENT', id: 'd1', text: `UN 38.3 test summary\nModel: PB-X180\nManufacturer: ${MFR}\nAll tests passed. Date of issue: 2026-02-20`, fileName: 'un.txt', docType: 'UN383' }, at(5));
  assert.ok(step(progress(s), 'complete').items.some((i) => i.kind === 'DOCUMENT_MODEL'), 'the mismatching document is listed');
});

test('engines that are not built yet are listed as NOT AVAILABLE YET (never faked, never hidden)', () => {
  const p = progress(build([{ type: 'NAME', name: 'x' }])); assert.deepEqual(p.unavailable.map((u) => u.id), UNAVAILABLE_ENGINES.map((u) => u.id));
  for (const u of p.unavailable) assert.equal(u.status, 'NOT_AVAILABLE_YET'); for (const id of ['market', 'supplierIntel', 'customsLookup', 'purchasePlan', 'businessDecision']) assert.ok(p.unavailable.some((u) => u.id === id), id);
  assert.match(JSON.stringify(p.unavailable), /trade activity|not consumer demand/i, 'the market line carries the TRADE_ACTIVITY warning');
});

test('field progress is pure and deterministic and uses plain, non-technical wording', () => {
  const s = build([...ident({ name: 'Power bank', category: 'power_bank', model: 'PB-X200' }), ...importer, ...commercial(), ...docsFor.powerbank('PB-X200')]); const a = run(s);
  assert.deepEqual(fieldProgress(s, a), fieldProgress(s, a)); const text = JSON.stringify(fieldProgress(s, a));
  assert.ok(!/CANDIDATE_|_EVENT|undefined|\[object|NaN|JSON/.test(text), 'no developer jargon or broken values in the visible text');
});
