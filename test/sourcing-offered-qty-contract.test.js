// CONTRACT of the fact quote.offeredQty ("the quantity the supplier says it offers / quotes for"): it is stored, returned, exported, recovered and shown like any other fact, it never leaks into the
// MOQ / the quote / the planned quantity, and cases that never heard of it are unaffected. Complements sourcing-extract-fr-terms.test.js (extraction).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourcingApp } from '../src/sourcing/server/app.js';
import { createFileStore } from '../src/sourcing/store/file-store.js';
import { newCase, dispatch, assess } from '../src/sourcing/core/case.js';
import { validateCase, parseImportText, buildExport, planRecovery, applyRecovery } from '../src/sourcing/core/recovery.js';
import { describeCandidate, validateCorrection, labelOf } from '../src/sourcing/core/candidate-view.js';
import { factStatusBoard, caseFacts } from '../src/sourcing/core/case-facts.js';
import { fieldSummaryText } from '../src/sourcing/core/field-summary.js';
import { supplierTruthCard } from '../src/sourcing/core/field/truth-card.js';
import { conflictPhrases } from '../src/sourcing/core/phrases.js';
import { findCandidateConflict } from '../src/sourcing/core/conflicts.js';

const NOTE = 'Nous proposons 100 gourdes en acier inoxydable à 5 € pièce. Quantité minimale : 100 unités. Livraison en Belgique non précisée. Délai de fabrication : 15 jours.';
const TOKEN = 'unit-test-token-0123456789-abcdef';
const T0 = new Date('2026-10-17T08:00:00Z'); const at = (m) => new Date(T0.getTime() + m * 60000);
const copy = (x) => JSON.parse(JSON.stringify(x));
const idOf = (c, k) => c.candidates.find((x) => x.key === k).id;

function withNote(text = NOTE, id = 'case-oq') {
  let c = newCase({ id, name: 'gourdes', now: T0 }); c = dispatch(c, { type: 'SUPPLIER', supplier: { name: 'FR' } }, at(0));
  c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'FR', lang: 'auto' }, at(1)); const conv = c.conversations.at(-1);
  return dispatch(c, { type: 'CONVERSATION_ITEM', convId: conv.id, speaker: 'supplier', lang: 'auto', text }, at(2));
}
/** the case as the owner leaves it: offered quantity confirmed, MOQ left PROPOSED */
function decided() { let c = withNote(); c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: idOf(c, 'quote.offeredQty') }, at(3)); c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: idOf(c, 'quote.unitPrice') }, at(4)); return c; }

test('1. persistence: a proposed and a confirmed offered quantity survive the file store byte for byte, with the original note', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nordla-oq-'));
  try {
    const store = createFileStore(dir); const c = decided(); const saved = await store.save(c); const back = await store.get('case-oq');
    assert.deepEqual(back, saved);
    assert.equal(back.candidates.find((x) => x.key === 'quote.offeredQty').state, 'CONFIRMED');
    assert.equal(back.candidates.find((x) => x.key === 'quote.moq').state, 'PROPOSED', 'the unconfirmed proposals stay proposals');
    const led = back.ledger.filter((e) => e.key === 'quote.offeredQty'); assert.equal(led.length, 1); assert.equal(led[0].value, '100'); assert.equal(led[0].rawText, '100 gourdes'); assert.equal(led[0].userConfirmed, true);
    assert.equal(back.conversations.at(-1).items.at(-1).original, NOTE);
    assert.ok((await readFile(join(dir, 'case-oq.json'), 'utf8')).includes('"quote.offeredQty"'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('2. the offered quantity never touches the MOQ, the quote or the planned quantity (confirmed or not)', () => {
  const c = decided(); const q = c.quotes.at(-1);
  assert.equal(q?.moq, undefined); assert.equal(q?.qty, undefined); assert.equal(c.context?.plannedQty, undefined);
  assert.equal(caseFacts(c).some((f) => f.key === 'quote.moq'), false, 'no MOQ fact exists');
  assert.equal(caseFacts(c).some((f) => f.key === 'quote.offeredQty'), false, 'it is not an actionable fact type either: the engines never read it');
  const board = factStatusBoard(c, { locale: 'fr' }); const moq = board.find((b) => b.key === 'quote.moq'); assert.equal(moq.state, 'PROPOSED'); assert.equal(moq.value, null);
  assert.ok(assess(c), 'the assessment still runs');
});

test('3. restitution through the HTTP API: the case comes back whole, and the candidate view is labelled in French and English', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nordla-oq-api-')); const store = createFileStore(dir);
  const app = createSourcingApp({ token: TOKEN, store, workspace: null, merchantProfile: null, uiDir: fileURLToPath(new URL('../src/sourcing/ui/', import.meta.url)), coreDir: fileURLToPath(new URL('../src/sourcing/core/', import.meta.url)) });
  const server = http.createServer(app.handler); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await store.save(decided());
    const r = await fetch(`${base}/api/cases/case-oq`, { headers: { 'x-sourcing-token': TOKEN } }); assert.equal(r.status, 200); const got = await r.json();
    assert.deepEqual(got.candidates.map((x) => x.key).sort(), copy(decided()).candidates.map((x) => x.key).sort());
    assert.equal(got.ledger.find((e) => e.key === 'quote.offeredQty').value, '100');
    const cand = got.candidates.find((x) => x.key === 'quote.offeredQty');
    const fr = describeCandidate(cand, 'fr'); const en = describeCandidate(cand, 'en');
    assert.deepEqual([fr.label, fr.valueText, fr.from], ['Quantité proposée', '100 pièces', '100 gourdes']); assert.deepEqual([en.label, en.valueText], ['Quantity offered', '100 pieces']);
    assert.equal(describeCandidate({ ...cand, value: '1' }, 'fr').valueText, '1 pièce');
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); await rm(dir, { recursive: true, force: true }); }
});

test('4. export / import / recovery carry the new fact unchanged and nothing is rewritten', () => {
  const c = decided(); const text = buildExport(c, () => null, T0); const parsed = parseImportText(text); assert.ok(parsed.ok ?? parsed.case, JSON.stringify(parsed).slice(0, 200));
  const v = validateCase(parsed.case ?? parsed); assert.ok(v.ok, v.error);
  assert.deepEqual(v.case.candidates.map((x) => [x.key, x.state, x.value]), c.candidates.map((x) => [x.key, x.state, x.value]));
  assert.deepEqual(v.case.ledger, c.ledger);
  const r = applyRecovery({}, v.case, { choice: 'skip' }); assert.equal(r.action, 'ADDED'); assert.deepEqual(r.cases[c.id].candidates, c.candidates);
  assert.equal(planRecovery({ [c.id]: copy(c) }, [v.case])[0].status, 'ALREADY_HERE');
});

test('5. views and summaries: the offered quantity appears as supplier information, never as the MOQ or a verified fact', () => {
  const c = decided(); const A = assess(c);
  const txt = fieldSummaryText(c, A, { now: T0 }); assert.equal(typeof txt, 'string'); assert.ok(!/MOQ\s*:?\s*100/i.test(txt), 'the summary does not invent a MOQ of 100 from the offered quantity');
  assert.ok(supplierTruthCard(c, A), 'the truth card is built');
  assert.equal(labelOf('quote.offeredQty', 'product', 'fr'), 'Quantité proposée'); assert.equal(labelOf('quote.offeredQty', 'product', 'en'), 'Quantity offered');
});

test('6. the owner can correct a misread offered quantity (whole numbers only, in French) without it ever becoming the MOQ; a rejection also works', () => {
  let c = withNote(); const id = idOf(c, 'quote.offeredQty');
  assert.equal(describeCandidate(c.candidates.find((x) => x.id === id), 'fr').canCorrect, true);
  assert.deepEqual(validateCorrection('quote.offeredQty', '120', 'fr'), { ok: true, value: '120' });
  for (const bad of ['1 000', '12.5', '0', 'abc', '']) { const r = validateCorrection('quote.offeredQty', bad, 'fr'); assert.equal(r.ok, false, bad); assert.match(r.error, /Tapez/, 'the refusal is in French'); }
  c = dispatch(c, { type: 'CANDIDATE_CORRECT', id, value: '120' }, at(5));
  const cand = c.candidates.find((x) => x.id === id); assert.equal(cand.state, 'CORRECTED'); assert.equal(cand.original.value, '100'); assert.equal(cand.correctedValue, '120');
  const led = c.ledger.filter((e) => e.key === 'quote.offeredQty'); assert.equal(led.length, 1); assert.equal(led[0].value, '120'); assert.equal(led[0].corrected, true); assert.equal(led[0].original.value, '100');
  assert.equal(c.quotes.at(-1)?.moq, undefined, 'a corrected offered quantity is still not the MOQ'); assert.equal(c.quotes.at(-1)?.qty, undefined);
  assert.equal(validateCorrection('quote.moq', '120', 'en').ok, true, 'the MOQ stays correctable, unchanged');
  const c0 = withNote(); const c1 = dispatch(c0, { type: 'CANDIDATE_REJECT', id: idOf(c0, 'quote.offeredQty') }, at(5)); assert.equal(c1.candidates.find((x) => x.key === 'quote.offeredQty').state, 'REJECTED'); assert.equal(c1.ledger.length, 0);
});

test('7. a supplier who later offers another quantity raises the usual question (a changed supplier statement is never absorbed silently)', () => {
  let c = decided(); const conv = c.conversations.at(-1);
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: conv.id, speaker: 'supplier', lang: 'auto', text: 'Finalement nous proposons 300 gourdes à 4,50 € pièce.' }, at(10));
  const second = c.candidates.filter((x) => x.key === 'quote.offeredQty').at(-1); assert.equal(second.value, '300'); assert.equal(second.state, 'PROPOSED');
  const k = findCandidateConflict(c, second, second.value); assert.ok(k && k.key === 'quote.offeredQty' && k.existing === '100', JSON.stringify(k));
  const p = conflictPhrases({ key: 'quote.offeredQty', entries: [{ value: '100' }, { value: '300' }] }); assert.ok(JSON.stringify(p).includes('100') && JSON.stringify(p).includes('300'));
});

test('8. cases that never heard of the fact are unaffected: no key is added, no state changes', () => {
  let c = newCase({ id: 'old-1', name: 'x', now: T0 }); c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'S', lang: 'auto' }, at(1));
  c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations.at(-1).id, speaker: 'supplier', lang: 'auto', text: 'prix 12$, MOQ 60, delai 20 days' }, at(2));
  const before = copy(c); assert.equal(c.candidates.some((x) => x.key === 'quote.offeredQty'), false);
  const v = validateCase(copy(before)); assert.ok(v.ok); assert.deepEqual(v.case.candidates, before.candidates); assert.deepEqual(v.case.ledger, before.ledger);
  assert.ok(factStatusBoard(v.case, { locale: 'fr' }).length > 0); assert.ok(assess(v.case));
});
