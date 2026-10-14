// Field V1 - merchant fit, supplier truth card, behaviour memory, evidence status, external evidence contract, ask list.
// The rules under test: no black-box score; nothing a supplier says is VERIFIED; a missing thing is UNKNOWN; every line has a reason; history is descriptive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, assess } from '../src/sourcing/core/case.js';
import { assessMerchantFit, fitLabel, FIT_RULE, FIT_STATE, DIMENSIONS, unitPhysical } from '../src/sourcing/core/field/merchant-fit.js';
import { supplierTruthCard, HEALTH, RISK_AREAS, PROVIDER_CONTRACT } from '../src/sourcing/core/field/truth-card.js';
import { behaviourMemory, supplierHistory, supplierKey } from '../src/sourcing/core/field/memory.js';
import { decisionEvidenceStatus, EVIDENCE_LEVEL } from '../src/sourcing/core/field/evidence-status.js';
import { attributeNameEvents } from '../src/sourcing/core/field/offer-import.js';
import { normalizeExternalEvidence, REGISTERED_PROVIDERS, ExternalEvidenceError } from '../src/sourcing/core/field/external-evidence.js';
import { askNow, ASK_MAX, IMPACT, CHINESE_NOTE } from '../src/sourcing/core/field/ask-now.js';
import { tumbler, importAndConfirm, withDocs, docsFor, NOW, EXT, PROFILE, t } from './sourcing-field-v1-fixtures.js';

const A = (c) => assess(c, { now: NOW, externals: EXT });
const imp = (c, text, h = 9) => importAndConfirm(c, { source: 'PASTED_QUOTE', text }, t(h));
const GOOD = 'Model TB-500. Material: stainless steel 304. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 25 days. T/T 30% deposit. Packing: gift box. We can do custom logo UV printing. We are a factory. CE and RoHS available.';
const fit = (c, profile = PROFILE) => assessMerchantFit(c, A(c), profile);
const dim = (f, k) => f.dimensions.find((d) => d.key === k);

// ---- merchant fit ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('fit: thirteen explicit dimensions, each SUPPORTED / PARTIAL / UNKNOWN / NOT_APPLICABLE with a reason; a summary label that is only a counting rule', () => {
  const f = fit(imp(tumbler('C'), GOOD)); assert.deepEqual(f.dimensions.map((d) => d.key), [...DIMENSIONS]); assert.equal(f.type, 'MerchantFitAssessment'); assert.equal(f.noScore, true);
  for (const d of f.dimensions) { assert.ok(Object.values(FIT_STATE).includes(d.state), d.key); assert.ok(d.why && d.why.length > 5, `${d.key} has no reason`); if (d.state === 'UNKNOWN') assert.ok(d.needs || /no |not /.test(d.why), `${d.key} UNKNOWN without saying what is needed`); }
  assert.equal(f.rule, FIT_RULE); assert.ok(['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_EVIDENCE'].includes(f.label)); assert.ok(!('score' in f) && !('probability' in f));
  assert.equal(dim(f, 'giftability').state, 'SUPPORTED'); assert.equal(dim(f, 'uvPrint').state, 'SUPPORTED'); assert.match(dim(f, 'uvPrint').why, /stainless steel 304/); assert.equal(dim(f, 'personalization').state, 'SUPPORTED'); assert.match(dim(f, 'personalization').why, /supplier claim|supplier says/);
  assert.equal(f.counts.known, f.counts.supported + f.counts.partial);
});

test('fit: the label follows the printed counting rule exactly', () => {
  assert.equal(fitLabel({ profile: false, known: 13, applicable: 13, supported: 13, against: 0 }), 'INSUFFICIENT_EVIDENCE');
  assert.equal(fitLabel({ profile: true, known: 4, applicable: 6, supported: 4, against: 0 }), 'INSUFFICIENT_EVIDENCE', 'fewer than 5 known');
  assert.equal(fitLabel({ profile: true, known: 5, applicable: 13, supported: 5, against: 0 }), 'INSUFFICIENT_EVIDENCE', 'fewer than half of the applicable ones');
  assert.equal(fitLabel({ profile: true, known: 8, applicable: 12, supported: 6, against: 2 }), 'LOW'); assert.equal(fitLabel({ profile: true, known: 9, applicable: 12, supported: 2, against: 1 }), 'LOW');
  assert.equal(fitLabel({ profile: true, known: 10, applicable: 12, supported: 7, against: 0 }), 'HIGH'); assert.equal(fitLabel({ profile: true, known: 10, applicable: 12, supported: 7, against: 1 }), 'MEDIUM'); assert.equal(fitLabel({ profile: true, known: 10, applicable: 12, supported: 6, against: 0 }), 'MEDIUM');
});

test('fit: without a merchant profile nothing can be judged - every dimension is UNKNOWN and the label is INSUFFICIENT_EVIDENCE', () => {
  const f = fit(imp(tumbler('C'), GOOD), null); assert.ok(f.dimensions.every((d) => d.state === 'UNKNOWN')); assert.equal(f.label, 'INSUFFICIENT_EVIDENCE'); assert.equal(f.profile.present, false);
});

test('fit: a bare case is INSUFFICIENT_EVIDENCE and says what it needs; the merchant data left null is not turned into a default', () => {
  const f = fit(tumbler('C')); assert.equal(f.label, 'INSUFFICIENT_EVIDENCE'); assert.equal(dim(f, 'uvPrint').state, 'UNKNOWN'); assert.match(dim(f, 'uvPrint').needs, /material/); assert.equal(dim(f, 'retailPriceFit').state, 'UNKNOWN'); assert.match(dim(f, 'retailPriceFit').needs, /price band/); assert.equal(dim(f, 'storageFootprint').state, 'UNKNOWN'); assert.equal(dim(f, 'marginPotential').state, 'UNKNOWN', 'no price, no margin: UNKNOWN, never a number'); assert.match(dim(f, 'marginPotential').why, /cannot be calculated/);
  assert.ok(f.missing.length > 0);
});

test('fit: a material the process handles badly leans AGAINST with the profile\'s own reason; a fragile one is a shipping concern; competition is never inferred from nothing', () => {
  const si = fit(imp(tumbler('S'), 'Model TB-500. Material: silicone. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo.')); assert.equal(dim(si, 'uvPrint').state, 'PARTIAL'); assert.equal(dim(si, 'uvPrint').lean, 'AGAINST'); assert.match(dim(si, 'uvPrint').why, /primer or another process/);
  const gl = fit(imp(tumbler('G'), 'Model TB-500. Material: glass. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo.')); assert.equal(dim(gl, 'shippingPracticality').state, 'PARTIAL'); assert.match(dim(gl, 'shippingPracticality').why, /fragile/);
  assert.equal(dim(gl, 'competition').state, 'UNKNOWN'); assert.equal(dim(gl, 'novelty').state, 'UNKNOWN');
  const unk = fit(imp(tumbler('U'), 'Model TB-500. Material: carbon fibre. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo.'));
});

test('fit: the merchant\'s price band, storage limit and weight limit are used only when configured', () => {
  let c = imp(tumbler('C', { sellingPrice: 19.9 }), 'Model TB-500. Material: stainless steel. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo. Size 20x8x8 cm. Carton size 40x30x30cm, gross weight 12kg, 50 pcs/ctn.');
  assert.equal(unitPhysical(c).unitVolumeCm3, 1280, 'product dimensions win'); assert.equal(dim(fit(c), 'storageFootprint').state, 'UNKNOWN'); assert.match(dim(fit(c), 'storageFootprint').why, /not configured/);
  const P = { ...PROFILE, retailPrice: { bandGrossEur: { min: 12, max: 30 } }, storage: { maxVolumePerUnitCm3: 1000 }, shipping: { ...PROFILE.shipping, maxWeightPerUnitG: 300 } };
  assert.equal(dim(fit(c, P), 'retailPriceFit').state, 'SUPPORTED'); assert.equal(dim(fit(c, P), 'storageFootprint').lean, 'AGAINST');
  assert.equal(dim(fit(c, { ...P, retailPrice: { bandGrossEur: { min: 25, max: 40 } } }), 'retailPriceFit').lean, 'AGAINST');
  const noDims = imp(tumbler('D'), 'Model TB-500. Material: stainless steel. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo. Carton size 40x30x30cm, gross weight 12kg, 50 pcs/ctn.'); assert.equal(unitPhysical(noDims).unitVolumeCm3, 720); assert.equal(unitPhysical(noDims).unitWeightG, 240);
});

test('fit: seasonality is a cue found in the words, never assumed; a thin description is UNKNOWN', () => {
  const xmas = fit(dispatch(tumbler('X'), { type: 'NAME', name: 'Christmas tumbler set' }, t(8))); assert.equal(dim(xmas, 'seasonality').state, 'PARTIAL'); assert.match(dim(xmas, 'seasonality').why, /Christmas/);
  let thin = dispatch(tumbler('T'), { type: 'NAME', name: 'Tumbler' }, t(8)); assert.equal(dim(fit(thin), 'seasonality').state, 'UNKNOWN');
});

// ---- truth card ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('truth card: identity, evidence health, six risk areas, behaviour memory; nothing the supplier says is VERIFIED', () => {
  const c = imp(tumbler('C', { supplier: 'Dongguan Metalware' }), GOOD); const card = supplierTruthCard(c, A(c));
  assert.equal(card.type, 'SupplierTruthCard'); assert.equal(card.identity.supplier.name, 'Dongguan Metalware'); assert.equal(card.identity.supplier.status, 'SUPPLIER_CLAIM'); assert.equal(card.identity.kind.value, 'FACTORY'); assert.equal(card.identity.kind.status, 'SUPPLIER_CLAIM');
  assert.deepEqual(Object.keys(card.risk), [...RISK_AREAS]); for (const k of RISK_AREAS) assert.ok(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'].includes(card.risk[k].level) && card.risk[k].why.length > 0, k);
  assert.equal(card.evidenceHealth.counts.VERIFIED, 0); assert.ok(card.evidenceHealth.facts.every((f) => f.status !== 'VERIFIED')); assert.equal(Object.values(card.evidenceHealth.counts).reduce((x, y) => x + y, 0), card.evidenceHealth.facts.length);
  assert.deepEqual(Object.keys(card.evidenceHealth.counts), [...HEALTH]); assert.equal(card.evidenceHealth.facts.find((f) => f.key === 'landedCost').status, 'ESTIMATED'); assert.equal(card.evidenceHealth.facts.find((f) => f.key === 'price').status, 'SUPPLIER_CLAIM');
  assert.equal(card.memory.type, 'BehaviourMemory'); assert.equal(card.external.items.length, 0); assert.match(card.external.note, /nothing here was checked/);
});

test('truth card: a certificate the supplier SAYS it has is a claim; a received document that matches the model is still a supplier document; one for another model is a CONFLICT', () => {
  let c = imp(tumbler('C'), GOOD); let f = supplierTruthCard(c, A(c)).evidenceHealth.facts.find((x) => x.key === 'cert:CE'); assert.equal(f.status, 'SUPPLIER_CLAIM'); assert.match(f.why, /no document received/);
  const withDoc = docsFor.charger('TB-500').reduce((x, d) => dispatch(x, d, t(9)), c); f = supplierTruthCard(withDoc, A(withDoc)).evidenceHealth.facts.find((x) => x.key === 'cert:CE'); assert.equal(f.status, 'SUPPLIER_CLAIM'); assert.match(f.why, /document matching the model was received: still a supplier document, not proof/);
  const wrong = docsFor.charger('ZZ-999').reduce((x, d) => dispatch(x, d, t(9)), c); f = supplierTruthCard(wrong, A(wrong)).evidenceHealth.facts.find((x) => x.key === 'cert:CE'); assert.equal(f.status, 'CONFLICT');
});

test('truth card: an open contradiction is a CONFLICT fact and HIGH consistency risk; a stable supplier with statements is LOW with a caveat; nothing stated is UNKNOWN', () => {
  let c = imp(tumbler('C'), GOOD); c = imp(c, 'Material: aluminium alloy. USD3.30 for 1000 pcs.', 11); const card = supplierTruthCard(c, A(c));
  assert.equal(card.evidenceHealth.facts.find((f) => f.key === 'material').status, 'CONFLICT'); assert.equal(card.risk.consistency.level, 'HIGH');
  const calm = supplierTruthCard(imp(tumbler('K'), 'Model TB-500. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo.'), A(imp(tumbler('K'), 'Model TB-500. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo.'))); assert.equal(calm.risk.consistency.level, 'LOW'); assert.match(calm.risk.consistency.why[0], /not proof/);
  const bare = tumbler('B'); assert.equal(supplierTruthCard(bare, A(bare)).risk.consistency.level, 'UNKNOWN'); assert.equal(supplierTruthCard(bare, A(bare)).risk.quality.level, 'UNKNOWN');
});

test('truth card: quality risk follows the sample lifecycle; delivery risk compares with a lead time the owner needs only if he entered one', () => {
  let c = imp(tumbler('C'), GOOD); const q = (x) => supplierTruthCard(x, A(x)).risk;
  assert.equal(q(c).quality.level, 'UNKNOWN'); c = dispatch(c, { type: 'SAMPLE_RECORD', status: 'REQUESTED' }, t(10)); assert.equal(q(c).quality.level, 'MEDIUM'); assert.match(q(c).quality.why[0], /not evaluated/);
  c = dispatch(c, { type: 'SAMPLE_RECORD', status: 'RECEIVED' }, t(11)); c = dispatch(c, { type: 'SAMPLE_RECORD', status: 'EVALUATED', verdict: 'PASS', note: 'weld ok' }, t(12)); assert.equal(q(c).quality.level, 'LOW');
  const fail = dispatch(c, { type: 'SAMPLE_RECORD', status: 'EVALUATED', verdict: 'FAIL' }, t(13)); assert.equal(q(fail).quality.level, 'HIGH');
  assert.throws(() => dispatch(c, { type: 'SAMPLE_RECORD', status: 'EVALUATED' }, t(14)), /verdict/); assert.throws(() => dispatch(c, { type: 'SAMPLE_RECORD', status: 'RECEIVED', verdict: 'PASS' }, t(14)), /only an evaluated/); assert.throws(() => dispatch(c, { type: 'SAMPLE_RECORD', status: 'LOST' }, t(14)), /status must be/);
  assert.equal(q(c).delivery.level, 'UNKNOWN'); assert.match(q(c).delivery.why[0], /nothing says when you need/);
  const late = dispatch(c, { type: 'CONTEXT', context: { deliveryNeededByDays: 20 } }, t(12)); assert.equal(q(late).delivery.level, 'HIGH'); const ok = dispatch(c, { type: 'CONTEXT', context: { deliveryNeededByDays: 40 } }, t(12)); assert.equal(q(ok).delivery.level, 'LOW');
});

// ---- external evidence ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const EXT_OK = { provider: 'acme-audit', kind: 'FACTORY_AUDIT', claim: 'Factory audited, 120 staff', status: 'VERIFIED', sourceRef: 'https://example.invalid/report/1', retrievedAt: '2026-10-19T08:00:00Z' };
test('external evidence: the contract exists, a record needs a source and a date, and a declared VERIFIED from an unregistered provider is shown as ESTIMATED with the reason', () => {
  assert.equal(PROVIDER_CONTRACT.name, 'EvidenceProviderContract'); assert.deepEqual(REGISTERED_PROVIDERS, {});
  let c = imp(tumbler('C'), GOOD); c = dispatch(c, { type: 'EXTERNAL_EVIDENCE', evidence: EXT_OK }, t(10));
  const card = supplierTruthCard(c, A(c)); const e = card.external.items[0]; assert.equal(e.declaredStatus, 'VERIFIED'); assert.equal(e.status, 'ESTIMATED'); assert.equal(e.registered, false); assert.match(e.note, /not a registered provider/);
  assert.equal(card.evidenceHealth.counts.VERIFIED, 0); assert.equal(card.external.providers[0], 'acme-audit');
  for (const bad of [{ ...EXT_OK, sourceRef: '' }, { ...EXT_OK, retrievedAt: 'not a date' }, { ...EXT_OK, provider: '' }, { ...EXT_OK, kind: 'GOSSIP' }, { ...EXT_OK, status: 'SURE' }, { ...EXT_OK, claim: '' }]) assert.throws(() => normalizeExternalEvidence(bad, 'now'), ExternalEvidenceError);
  const again = dispatch(c, { type: 'EXTERNAL_EVIDENCE', evidence: { ...EXT_OK, id: c.externalEvidence[0].id } }, t(11)); assert.equal(again.externalEvidence.length, 1, 'the same record is never stored twice');
  const expired = dispatch(c, { type: 'EXTERNAL_EVIDENCE', evidence: { ...EXT_OK, id: 'x2', validUntil: '2026-10-01T00:00:00Z' } }, t(11)); assert.equal(supplierTruthCard(expired, A(expired)).external.items.find((x) => x.id === 'x2').expired, true);
});

// ---- behaviour memory --------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('memory: changed MOQ and price, changed material, a certificate claimed twice without a document, unanswered important questions - all descriptive, all with references', () => {
  let c = imp(tumbler('C', { supplier: 'Ningbo Gifts Co., Ltd' }), GOOD, 9); c = imp(c, 'Model TB-500. Material: aluminium alloy. USD3.10 for 1000 pcs. MOQ 800. FOB Ningbo. CE reports available.', 11);
  c = dispatch(c, { type: 'QUESTION_SHOWN', questionId: 'manufacturer', via: 'SHOWN_TO_SUPPLIER' }, t(12));
  const m = behaviourMemory(c, A(c)); assert.equal(m.descriptive, true); assert.deepEqual(m.changedMoq.values, [500, 800]); assert.ok(m.changedPrice); assert.ok(m.changedMaterial.statements.length === 2 || m.changedMaterial.conflicts.length === 1);
  assert.deepEqual(m.missingCertificateRepeatedly, ['CE']); assert.equal(m.certificates.find((x) => x.claim === 'CE').offers, 2); assert.ok(m.unansweredCritical.some((u) => u.questionId === 'manufacturer'));
  assert.ok(m.supersededTerms.every((s) => s.ref.caseId === 'C' && s.ref.ledgerId)); assert.ok(m.notes.some((n) => /MOQ changed/.test(n))); assert.ok(m.notes.length >= 4); assert.deepEqual(Object.keys(m.reviews).sort(), ['confirmed', 'conflicts', 'corrected', 'pending', 'rejected']);
});

test('memory: the history of a SUPPLIER across several cases groups by name, holds references, and passes recorded recommendations through', () => {
  const a = imp(tumbler('A1', { supplier: 'Ningbo Gifts Co., Ltd' }), GOOD); const b = imp(tumbler('A2', { supplier: 'NINGBO GIFTS CO' }), 'Model TB-700. USD4.10 for 500 pcs. MOQ 300. FOB Ningbo.'); const o = imp(tumbler('Z', { supplier: 'Other Co' }), GOOD);
  assert.equal(supplierKey('Ningbo Gifts Co., Ltd'), supplierKey('NINGBO GIFTS CO')); const h = supplierHistory([a, b, o], { recommendations: [{ id: 'snap-1', caseId: 'A1', value: 'INVESTIGATE', at: 'x', fingerprint: 'f' }] });
  assert.equal(h.length, 2); const g = h.find((x) => x.cases.length === 2); assert.deepEqual(g.cases.map((x) => x.caseId).sort(), ['A1', 'A2']); assert.equal(g.offers.length, 2); assert.deepEqual(g.previousRecommendations.map((r) => r.ref.snapshotId), ['snap-1']); assert.equal(g.duplicatesNothing, true); assert.equal(g.authoritative, 'cases');
  assert.ok(g.offers.every((x) => x.caseId && x.offerId));
});

// ---- evidence status ------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('evidence status: it measures how complete the evidence is - never a probability - with blocking items and what would improve it', () => {
  const bare = tumbler('B'); let s = decisionEvidenceStatus(bare, A(bare), {}); assert.equal(s.evidenceCompleteness, 'INSUFFICIENT_EVIDENCE'); assert.ok(s.blockingCodes.includes('NO_PRICE')); assert.equal(s.notAProbability, true); assert.equal(s.measures, 'evidence completeness'); assert.match(s.rule, /not how likely a purchase is to succeed/);
  const c = imp(tumbler('C'), GOOD); s = decisionEvidenceStatus(c, A(c), { recommendation: { value: 'INVESTIGATE', status: 'RECOMMENDATION_PENDING_APPROVAL' } }); assert.equal(s.evidenceCompleteness, 'WEAK_EVIDENCE'); assert.ok(s.blocking.some((b) => /required document/.test(b))); assert.ok(s.whatWouldImprove.some((x) => /^get /.test(x))); assert.equal(s.recommendation, 'INVESTIGATE'); assert.equal(s.businessDecision, 'NOT_DECIDED');
  assert.equal(s.blockingCodes.filter((x) => x === 'REQUIRED_DOCUMENT_MISSING').length, 1, 'several missing documents are one gap');
});

test('evidence status: it reaches STRONG only when nothing is missing - documents, reviewed facts, a live Safety Gate, an evaluated sample - and drops again when a fact is not reviewed', () => {
  let c = withDocs(importAndConfirm(tumbler('C', { model: 'TB-500' }), { source: 'PASTED_QUOTE', text: GOOD }, t(9)), 'TB-500', t(9));
  c = dispatch(c, { type: 'SAMPLE_RECORD', status: 'EVALUATED', verdict: 'PASS' }, t(10)); c = dispatch(c, { type: 'IDENTIFIER', name: 'manufacturer', value: 'Shenzhen Brightway Electronics Co., Ltd', level: 'USER_STATED' }, t(10));
  const a = A(c); const s = decisionEvidenceStatus(c, a, {});
  assert.deepEqual(s.blockingCodes, [], JSON.stringify(s.blocking)); assert.ok(s.importantCodes.length <= 2, JSON.stringify(s.important));
  const pending = dispatch(c, { type: 'OFFER_IMPORT', source: 'PASTED_QUOTE', text: 'MOQ 700, USD3.00 for 1000 pcs' }, t(11)); const s2 = decisionEvidenceStatus(pending, A(pending), {}); assert.ok(s2.importantCodes.includes('FACTS_TO_REVIEW'));
});

// ---- ask list ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('ask list: the smallest high-value set (2-5), ranked by decision impact, each with a reason and its Chinese review state - never certified', () => {
  let c = imp(tumbler('D'), 'Hello. Model TB-500. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo. CE and RoHS available.'); c = imp(c, 'Sorry: Material: aluminium alloy. Material: stainless steel.', 11);
  const ask = askNow(c, A(c)); assert.ok(ask.items.length >= 2 && ask.items.length <= ASK_MAX, String(ask.items.length)); assert.ok(ask.totalOpen > ask.items.length, 'lower-impact questions are held back');
  assert.deepEqual(ask.items.map((i) => i.weight), ask.items.map((i) => i.weight).slice().sort((x, y) => y - x)); assert.deepEqual(ask.items.map((i) => i.rank), ask.items.map((_, k) => k + 1));
  for (const i of ask.items) { assert.ok(i.why && i.whyFr && i.fr && i.en); if (i.zh) { assert.notEqual(i.zh.review, 'NATIVE_REVIEWED'); assert.equal(i.zh.nativeReviewed, false); assert.ok(['TECHNICAL_ONLY', 'UNREVIEWED', 'MACHINE'].includes(i.zh.review)); } else assert.match(i.zhNote, /none is invented/); }
  assert.equal(ask.chineseNote, CHINESE_NOTE); assert.equal(ask.nativeReviewAvailable, false); assert.match(ask.chineseNote, /NOT reviewed by a native speaker/);
  assert.ok(Object.values(IMPACT).every((v, k, all) => k === 0 || v <= all[k - 1]), 'the impact table is ordered');
});

test('ask list: the material question appears only while the material is unknown; compliance blockers and contradictions rank above commercial detail; the owner\'s progress is kept', () => {
  const noMat = askNow(imp(tumbler('M'), 'Model TB-500. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 20 days.'), A(imp(tumbler('M'), 'Model TB-500. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo. Lead time 20 days.')), { max: 20 });
  assert.ok(noMat.items.some((i) => i.id === 'field:material' && i.kind === 'MATERIAL')); const withMat = imp(tumbler('N'), 'Model TB-500. Material: stainless steel 304. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo.'); assert.ok(!askNow(withMat, A(withMat), { max: 20 }).items.some((i) => i.id === 'field:material'));
  const bad = withDocs(imp(tumbler('X'), GOOD), 'ZZ-999'); const ask = askNow(bad, A(bad)); const kinds = ask.items.map((i) => i.kind); assert.ok(kinds.indexOf('COMPLIANCE_BLOCKER') >= 0 && (kinds.indexOf('LEAD_TIME') < 0 || kinds.indexOf('COMPLIANCE_BLOCKER') < kinds.indexOf('LEAD_TIME')));
  const prog = askNow(bad, A(bad), { askState: { [ask.items[0].id]: { state: 'ASKED', at: 'x' } } }); assert.equal(prog.items.find((i) => i.id === ask.items[0].id).state, 'ASKED');
});

test('evidence status: exactly two critical gaps is WEAK, three is INSUFFICIENT (a contradiction + a document that contradicts the case + missing documents)', () => {
  let c = imp(tumbler('C', { model: 'TB-500' }), 'Model TB-500. Material: stainless steel. USD3.30 for 1000 pcs. MOQ 500. FOB Ningbo.'); c = imp(c, 'Material: aluminium alloy.', 11);
  const two = decisionEvidenceStatus(c, A(c), {}); assert.deepEqual(two.blockingCodes.sort(), ['OPEN_CONTRADICTION', 'REQUIRED_DOCUMENT_MISSING']); assert.equal(two.evidenceCompleteness, 'WEAK_EVIDENCE');
  const bad = docsFor.bottle('ZZ-999').reduce((x, d) => dispatch(x, d, t(12)), c); const three = decisionEvidenceStatus(bad, A(bad), {}); assert.ok(three.blockingCodes.length >= 3, three.blockingCodes.join()); assert.equal(three.evidenceCompleteness, 'INSUFFICIENT_EVIDENCE');
});

test('an owner line of an imported chat that is attributed to the owner is REJECTED as a proposal, with the reason; the words stay on record', () => {
  const chat = '[10:32] Jack Lee: price USD 6.80 for 500 pcs, MOQ 300\n[10:33] Elidjan: and MOQ 700 for me?\n[10:35] Jack Lee: ok';
  let c = dispatch(tumbler('C'), { type: 'OFFER_IMPORT', source: 'CHAT', text: chat }, t(9)); const mine = c.candidates.filter((x) => x.rawText.includes('700')); assert.ok(mine.length >= 1 && mine.every((x) => x.state === 'PROPOSED'));
  for (const e of attributeNameEvents(c, c.offers[0].id, 'Elidjan', 'me')) c = dispatch(c, e, t(10));
  const after = c.candidates.filter((x) => x.rawText.includes('700')); assert.ok(after.every((x) => x.state === 'REJECTED' && x.rejectedReason === 'a line written by the owner, not by the supplier' && x.rawText.length > 0));
  for (const e of attributeNameEvents(c, c.offers[0].id, 'Jack Lee', 'supplier')) c = dispatch(c, e, t(10)); assert.ok(c.candidates.filter((x) => x.rawText.includes('300')).every((x) => x.state === 'PROPOSED'), 'the supplier lines stay proposals');
});
