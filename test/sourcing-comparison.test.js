// P11-LITE: multi-offer comparison. Everything synthetic. No provider, no network. The comparison reads cases; it never changes them, never ranks on price alone,
// never turns UNKNOWN into a value, and never takes a company decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build, run, ident, traits, extraTraits, importer, commercial, doc, docsFor, LIVE_CLEAN, NOW } from './sourcing-fixtures.js';
import { dispatch } from '../src/sourcing/core/case.js';
import { compareCases, comparisonDefinition, recomputeComparison, toMobileView, dominates, ComparisonError, CELL, ROLE, RECOMMENDATION, DIMENSIONS, MAX_CANDIDATES } from '../src/sourcing/core/comparison.js';

const EXT = { safety: LIVE_CLEAN };
const cmp = (cases, o = {}) => compareCases(cases, { now: NOW, externals: EXT, ...o });
const withId = (c, id) => ({ ...c, id });

/** A household offer: complete, low regulatory risk (GO by itself). */
const household = (id, { supplier = `Supplier ${id}`, price = 1.85, moq = 1000, model = 'BK-220', qty = 1200, quote = true, freight = true, extra = [] } = {}) => withId(build([
  ...ident({ name: 'Bamboo organiser', category: 'household_general', model, manufacturer: 'Yiwu Greenline Housewares Co., Ltd' }), ...traits({}), ...importer, { type: 'SUPPLIER', supplier: { name: supplier } },
  ...(quote ? commercial({ unitPrice: price, qty, moq, price: 9.99, target: 30, duty: 0, code: '4421.99' }) : []), ...extra]), id);
/** A USB charger offer with its documents (a model other than the case's makes the documents contradict the case). */
const charger = (id, { price = 4.2, docModel = 'PD-65', supplier = `Supplier ${id}`, docs = true, extra = [] } = {}) => withId(build([
  ...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer,
  { type: 'SUPPLIER', supplier: { name: supplier } }, ...commercial({ unitPrice: price, price: 24.99 }), ...(docs ? docsFor.charger(docModel) : []), ...extra]), id);
const frozen = (x) => JSON.stringify(x);
const cand = (set, id) => set.candidates.find((c) => c.caseId === id);
const dim = (set, key) => set.dimensions.find((d) => d.key === key);
const cellOf = (set, key, id) => dim(set, key).cells.find((c) => c.caseId === id);

test('size: 2 to 5 distinct cases, nothing else', () => {
  const a = household('A'); const b = household('B');
  assert.throws(() => cmp([a]), (e) => e instanceof ComparisonError && e.code === 'COMPARISON_SIZE');
  assert.throws(() => cmp([]), { code: 'COMPARISON_SIZE' });
  assert.throws(() => cmp(['A', 'B', 'C', 'D', 'E', 'F'].map((i) => household(i))), { code: 'COMPARISON_SIZE' });
  assert.throws(() => cmp([a, a]), { code: 'COMPARISON_DUPLICATE' });
  assert.throws(() => cmp([a, { ...b, id: undefined }]), { code: 'COMPARISON_DUPLICATE' });
  assert.equal(MAX_CANDIDATES, 5);
  assert.equal(cmp([a, b]).candidates.length, 2);
});

test('two suppliers with complete data: a preferred offer only through multi-dimension dominance, with a PENDING recommendation', () => {
  const A = household('A', { price: 1.85 }); const B = household('B', { price: 2.6 });
  const set = cmp([A, B]);
  assert.equal(set.summary.preferredCaseId, 'A'); assert.equal(cand(set, 'A').role, ROLE.PREFERRED); assert.equal(cand(set, 'B').role, ROLE.VIABLE);
  assert.equal(set.summary.priceOnlyWinner, false);
  const r = cand(set, 'A').recommendation;
  assert.equal(r.value, RECOMMENDATION.BUY_CANDIDATE); assert.equal(r.status, 'RECOMMENDATION_PENDING_APPROVAL'); assert.equal(r.businessDecision, 'NOT_DECIDED'); assert.equal(r.requiresMerchantApproval, true); assert.equal(r.canCommitMoney, false); assert.equal(r.authority, 'SOURCING_EVALUATION');
  assert.equal(cand(set, 'B').recommendation.value, RECOMMENDATION.INVESTIGATE);
});

test('no price-only winner: the cheapest offer with a weaker evidence base does not win; trade-offs are reported, not resolved', () => {
  const cheap = charger('cheap', { price: 3.0, docs: false }); // cheap, no documents
  const solid = charger('solid', { price: 4.2 }); // dearer, documents match
  const set = cmp([cheap, solid]);
  assert.notEqual(set.summary.preferredCaseId, 'cheap');
  assert.ok(cellOf(set, 'unitPrice', 'cheap').value.unitPrice < cellOf(set, 'unitPrice', 'solid').value.unitPrice);
  assert.equal(set.summary.priceOnlyWinner, false);
  // two viable offers where neither is at least as good everywhere: no winner, with the reason
  const lowPrice = household('low', { price: 1.4, moq: 3000 }); const lowMoq = household('lowmoq', { price: 1.9, moq: 500 });
  const t = cmp([lowPrice, lowMoq]);
  assert.equal(t.summary.preferredCaseId, null); assert.match(t.summary.noWinnerReason, /trade-offs/); assert.ok(t.candidates.every((c) => c.role !== ROLE.PREFERRED));
  assert.equal(dominates(t.candidates[0] && { landedCost: cellOf(t, 'landedCost', 'low'), margin: cellOf(t, 'margin', 'low'), evidenceStrength: cellOf(t, 'evidenceStrength', 'low'), missingEvidence: cellOf(t, 'missingEvidence', 'low'), moq: cellOf(t, 'moq', 'low') }, { landedCost: cellOf(t, 'landedCost', 'lowmoq'), margin: cellOf(t, 'margin', 'lowmoq'), evidenceStrength: cellOf(t, 'evidenceStrength', 'lowmoq'), missingEvidence: cellOf(t, 'missingEvidence', 'lowmoq'), moq: cellOf(t, 'moq', 'lowmoq') }), false);
});

test('one cheap but non-compliant supplier is BLOCKED and recommended PASS; the well-evidenced expensive one is not penalised for being expensive', () => {
  const cheap = charger('cheap', { price: 2.0, docModel: 'PD-99' }); // documents name another model: they contradict the case
  const solid = charger('solid', { price: 4.2 });
  assert.ok(run(cheap).decision.hardBlockers.some((b) => b.code === 'DOCUMENT_CONTRADICTS_CASE'));
  const set = cmp([cheap, solid]);
  assert.equal(cand(set, 'cheap').role, ROLE.BLOCKED); assert.equal(cand(set, 'cheap').recommendation.value, RECOMMENDATION.PASS);
  assert.ok(cand(set, 'cheap').sourcingEvaluation.blockers.includes('DOCUMENT_CONTRADICTS_CASE'));
  assert.equal(cellOf(set, 'compliance', 'cheap').status, CELL.CONFLICT);
  assert.notEqual(cand(set, 'solid').role, ROLE.BLOCKED);
  assert.equal(set.summary.preferredCaseId, cand(set, 'solid').role === ROLE.PREFERRED ? 'solid' : null);
  assert.ok(cellOf(set, 'compliance', 'solid').status !== CELL.VERIFIED, 'a computed compliance assessment is never VERIFIED');
});

test('five suppliers: every offer is classified, the table has one cell per offer per dimension, and blocked or unknown offers cannot be preferred', () => {
  const cases = [household('A', { price: 1.85 }), household('B', { price: 2.4 }), household('C', { quote: false }), charger('D', { price: 2.0, docModel: 'PD-99' }), charger('E', { price: 4.2 })];
  const set = cmp(cases);
  assert.equal(set.candidates.length, 5); assert.equal(set.dimensions.length, DIMENSIONS.length);
  for (const d of set.dimensions) assert.equal(d.cells.length, 5);
  assert.equal(cand(set, 'D').role, ROLE.BLOCKED); assert.equal(cand(set, 'C').role, ROLE.INVESTIGATE);
  assert.equal(set.summary.counts.PREFERRED + set.summary.counts.VIABLE + set.summary.counts.INVESTIGATE + set.summary.counts.BLOCKED, 5);
  assert.equal(set.summary.preferredCaseId, null, 'an unknown offer is still open: nobody is named the winner');
  assert.match(set.summary.noWinnerReason, /unknown or in conflict|trade-offs/);
});

test('incomplete data: UNKNOWN is shown as UNKNOWN, never as a guessed number, and never counts against the case', () => {
  const A = household('A'); const noQuote = household('B', { quote: false });
  const set = cmp([A, noQuote]);
  for (const k of ['unitPrice', 'moq', 'landedCost', 'maxPurchasePrice', 'margin', 'leadTime', 'terms']) { const c = cellOf(set, k, 'B'); assert.equal(c.status, CELL.UNKNOWN, k); assert.equal(c.value, null, k); }
  assert.equal(cand(set, 'B').role, ROLE.INVESTIGATE); assert.notEqual(cand(set, 'B').role, ROLE.BLOCKED);
  assert.equal(dim(set, 'landedCost').comparable, false); assert.equal(dim(set, 'unitPrice').comparable, false);
  assert.equal(set.summary.preferredCaseId, null); assert.match(set.summary.noWinnerReason, /investigate/);
});

test('unknown landed cost: not computed, not ranked, and the next question asks for what blocks it', () => {
  const noFreight = household('B', { extra: [{ type: 'COSTS', costs: { fx: { rate: 0.92, date: '2026-10-02', source: 'USER_ENTERED' }, costs: {}, importVat: { ratePct: 21, recoverable: true } } }] });
  const set = cmp([household('A'), noFreight]);
  const c = cellOf(set, 'landedCost', 'B'); assert.equal(c.status, CELL.UNKNOWN); assert.equal(c.value, null); assert.match(c.display, /cannot be calculated/);
  assert.equal(cand(set, 'B').role, ROLE.INVESTIGATE);
  assert.ok(cand(set, 'B').askNext); assert.ok(['landedCost', 'terms', 'unitPrice', 'moq'].includes(cand(set, 'B').askNext.dimension));
});

test('MOQ mismatch: both MOQs are shown as supplier claims and compared as a dimension, not hidden', () => {
  const set = cmp([household('A', { moq: 500 }), household('B', { moq: 5000 })]);
  assert.equal(cellOf(set, 'moq', 'A').status, CELL.SUPPLIER_CLAIM); assert.equal(cellOf(set, 'moq', 'A').value, 500); assert.equal(cellOf(set, 'moq', 'B').value, 5000);
  assert.equal(dim(set, 'moq').comparable, true);
  assert.ok(dim(set, 'moq').cells.every((c) => c.evidence.length > 0), 'each MOQ keeps its provenance');
});

test('a missing certificate: listed as missing evidence for that offer, which can still not be called verified', () => {
  const noDocs = charger('A', { docs: false }); const withDocs = charger('B');
  const set = cmp([noDocs, withDocs]);
  assert.ok(cellOf(set, 'missingEvidence', 'A').value.missing.length > 0); assert.equal(cellOf(set, 'missingEvidence', 'A').status, CELL.UNKNOWN);
  assert.ok(cellOf(set, 'missingEvidence', 'A').value.missing.length > cellOf(set, 'missingEvidence', 'B').value.missing.length);
  assert.notEqual(cellOf(set, 'compliance', 'A').status, CELL.VERIFIED);
  assert.ok(cand(set, 'A').sourcingEvaluation.missing.length > 0);
  const ask = cand(set, 'A').askNext; assert.ok(ask); assert.ok(['missingEvidence', 'compliance'].includes(ask.dimension));
});

/** Two different statements about the product MOQ: the conflict stays OPEN until the owner chooses (the established P1 scenario). */
function withMoqConflict(id) {
  let c = household(id, { quote: false });
  const at = (n) => new Date(NOW.getTime() + n * 1000); const say = (t, n) => dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations.at(-1).id, speaker: 'supplier', lang: 'auto', text: t }, at(n));
  const moqs = () => c.candidates.filter((x) => x.key === 'quote.moq' && x.context === 'product');
  c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'Booth 12', lang: 'auto' }, at(1));
  c = say('MOQ is 100 pcs for the standard model.', 2); c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: moqs().at(-1).id }, at(3));
  c = say('Actually the MOQ is 300 pcs.', 6); return dispatch(c, { type: 'CANDIDATE_CONFIRM', id: moqs().at(-1).id }, at(7));
}

test('conflicting supplier claims: the MOQ is CONFLICT (not overwritten, not averaged), the offer is INVESTIGATE, and ASK NEXT is that very conflict', () => {
  const c = withMoqConflict('B'); assert.ok(c.conflicts.some((x) => x.state === 'OPEN' && x.key === 'quote.moq'), 'fixture: an open MOQ conflict');
  const set = cmp([household('A'), c]);
  const p = cellOf(set, 'moq', 'B'); assert.equal(p.status, CELL.CONFLICT); assert.equal(p.value, null);
  assert.equal(cellOf(set, 'contradictions', 'B').status, CELL.CONFLICT);
  assert.equal(cand(set, 'B').role, ROLE.INVESTIGATE);
  assert.equal(cand(set, 'B').askNext.source, 'CONFLICT'); assert.equal(cand(set, 'B').askNext.dimension, 'contradictions');
  assert.ok(set.conflicts.some((x) => x.kind === 'CASE_CONFLICT' && x.caseIds[0] === 'B' && x.dimension === 'quote.moq' && x.status === CELL.CONFLICT));
  assert.equal(set.summary.preferredCaseId, null);
});

test('the same supplier and model quoted differently in two cases is a cross-case CONFLICT, never resolved by the comparison', () => {
  const a = household('A', { supplier: 'Yiwu Greenline', price: 1.85 }); const b = household('B', { supplier: ' yiwu  greenline ', price: 2.1 });
  const set = cmp([a, b]);
  const x = set.conflicts.find((c) => c.kind === 'CROSS_CASE_CLAIM'); assert.ok(x); assert.equal(x.dimension, 'unitPrice'); assert.deepEqual(x.caseIds, ['A', 'B']); assert.match(x.resolution, /NOT_RESOLVED/);
  const other = cmp([household('A', { supplier: 'S1' }), household('B', { supplier: 'S2', price: 2.1 })]); assert.equal(other.conflicts.filter((c) => c.kind === 'CROSS_CASE_CLAIM').length, 0);
});

test('provenance is retained: supplier quote fields stay SUPPLIER_CLAIM (with their ledger origin), calculations stay ESTIMATED, none is VERIFIED', () => {
  const set = cmp([household('A'), household('B', { price: 2.4 })]);
  for (const id of ['A', 'B']) {
    assert.equal(cellOf(set, 'unitPrice', id).status, CELL.SUPPLIER_CLAIM); assert.ok(cellOf(set, 'unitPrice', id).evidence.length > 0);
    assert.equal(cellOf(set, 'landedCost', id).status, CELL.ESTIMATED); assert.equal(cellOf(set, 'maxPurchasePrice', id).status, CELL.ESTIMATED); assert.equal(cellOf(set, 'margin', id).status, CELL.ESTIMATED);
    for (const k of ['unitPrice', 'moq', 'leadTime', 'terms', 'landedCost', 'maxPurchasePrice', 'margin', 'compliance']) assert.notEqual(cellOf(set, k, id).status, CELL.VERIFIED, k);
    for (const d of set.dimensions) assert.ok(Object.values(CELL).includes(cellOf(set, d.key, id).status));
  }
  // a confirmed conversation fact keeps its ledger provenance in the evidence
  const talked = (() => { let c = household('T', { quote: false }); const at = (n) => new Date(NOW.getTime() + n * 1000); c = dispatch(c, { type: 'CONVERSATION_START', supplierRef: 'B1', lang: 'auto' }, at(1)); c = dispatch(c, { type: 'CONVERSATION_ITEM', convId: c.conversations.at(-1).id, speaker: 'supplier', lang: 'auto', text: 'MOQ is 100 pcs, unit price USD 6.80 for 300 pcs, FOB Shenzhen' }, at(2)); for (const x of c.candidates.filter((y) => ['quote.moq', 'quote.unitPrice', 'quote.incoterm'].includes(y.key))) c = dispatch(c, { type: 'CANDIDATE_CONFIRM', id: x.id }, at(3)); return c; })();
  const s2 = cmp([household('A'), talked]);
  assert.equal(cellOf(s2, 'moq', 'T').status, CELL.SUPPLIER_CLAIM); assert.match(cellOf(s2, 'moq', 'T').evidence[0].note, /ledger: SUPPLIER_CLAIM/);
});

test('ASK NEXT is deterministic and decision-relevant: the largest unknown wins, never a generic question', () => {
  const noQuote = household('B', { quote: false });
  const s1 = cmp([household('A'), noQuote]); const s2 = cmp([household('A'), noQuote]);
  assert.deepEqual(s1.candidates.map((c) => c.askNext), s2.candidates.map((c) => c.askNext));
  const ask = cand(s1, 'B').askNext; assert.equal(ask.dimension, 'unitPrice'); assert.ok(ask.en && ask.zh, 'the supplier question exists in English and in Chinese (phrasebook)'); assert.ok(ask.alternatives.length <= 2);
  assert.equal(cand(s1, 'A').askNext === null || typeof cand(s1, 'A').askNext.dimension === 'string', true);
  // a conflict outranks a missing lead time
  const set = cmp([household('A'), withMoqConflict('C')]); assert.equal(cand(set, 'C').askNext.source, 'CONFLICT');
  // an offer with a contradicting document is asked about it before anything commercial
  const bad = charger('X', { docModel: 'PD-99', price: 2.0 }); const t = cmp([bad, charger('Y')]);
  assert.equal(cand(t, 'X').askNext.dimension, 'compliance');
});

test('the comparison never changes a case, and recomputing gives the same set (resume later)', () => {
  const cases = [household('A'), charger('B', { docModel: 'PD-99' }), withMoqConflict('C')];
  const before = frozen(cases);
  const set = cmp(cases);
  assert.equal(frozen(cases), before, 'case data unchanged by the comparison');
  assert.equal(frozen(cmp(cases)), frozen(set), 'deterministic');
  const def = JSON.parse(JSON.stringify(comparisonDefinition(set)));
  assert.deepEqual(Object.keys(def).sort(), ['asOf', 'caseIds', 'id', 'schema']);
  const byId = Object.fromEntries(cases.map((c) => [c.id, JSON.parse(JSON.stringify(c))]));
  assert.equal(frozen(recomputeComparison(def, byId, { externals: EXT })), frozen(set), 'resume later: the recomputed set equals the original');
  assert.throws(() => recomputeComparison(def, { A: byId.A }, { externals: EXT }), { code: 'COMPARISON_CASE_MISSING' });
  assert.equal(frozen(JSON.parse(JSON.stringify(set))), frozen(set), 'the set is plain JSON');
});

test('a later change in a case is reflected: the offer that gains evidence moves, and nothing else is guessed', () => {
  const a = household('A'); const b0 = household('B', { quote: false });
  const s0 = cmp([a, b0]); assert.equal(cand(s0, 'B').role, ROLE.INVESTIGATE);
  const b1 = withId(dispatch(b0, { type: 'QUOTE', quote: { unitPrice: 2.2, currency: 'USD', qty: 1200, moq: 1000, incoterm: 'FOB', leadTimeDays: 25, carton: '40x30x30 cm / 12 kg / 50 units' } }, NOW), 'B');
  const withCosts = commercial({ unitPrice: 2.2, qty: 1200, moq: 1000, price: 9.99, target: 30, duty: 0, code: '4421.99' }); let b2 = b0; for (const e of withCosts) b2 = dispatch(b2, e, NOW); b2 = withId(b2, 'B');
  const s1 = cmp([a, b2]); assert.notEqual(cand(s1, 'B').role, ROLE.INVESTIGATE); assert.ok(b1.quotes.length === 1);
});

test('mobile-readable contract: one short card per offer (no table), one status marker per line, a legend, both languages', () => {
  const set = cmp([household('A'), charger('B', { docModel: 'PD-99' }), withMoqConflict('C')]);
  for (const lang of ['fr', 'en']) {
    const v = toMobileView(set, { lang });
    assert.equal(v.cards.length, 3); assert.ok(v.legend.includes('?')); assert.equal(v.maxLineLength, 78);
    const all = [v.title, v.legend, v.summary, ...v.cards.flatMap((c) => [c.headline, c.role, c.recommendation, ...c.lines.flatMap((l) => [l.label, l.text]), ...(c.askNext ? [c.askNext.text] : [])])];
    for (const s of all) if (s !== v.legend) assert.ok(s.length <= 78, `too long for a phone: ${s}`);
    for (const c of v.cards) { assert.equal(c.lines.length, DIMENSIONS.length); for (const l of c.lines) assert.match(l.text, /^[✓◐≈?!] /); assert.match(c.recommendation, lang === 'fr' ? /à valider/ : /pending approval/); }
  }
  assert.equal(toMobileView(set).cards.find((c) => c.caseId === 'B').role, 'Bloqué');
  assert.equal(JSON.stringify(toMobileView(set)), JSON.stringify(toMobileView(set)));
});

test('boundaries: the module imports nothing from the Core / decision layer and makes no network or provider call', async () => {
  const { readFile } = await import('node:fs/promises'); const src = await readFile(new URL('../src/sourcing/core/comparison.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '(.*)';/gm)].map((m) => m[1]); assert.deepEqual(imports.sort(), ['./case.js', './offers.js']);
  assert.ok(!/socle|decision-ledger|fetch\(|https?:\/\/|process\.env/.test(src.replace(/\/\/.*$/gm, '')), 'no decision layer, network or environment access');
});
