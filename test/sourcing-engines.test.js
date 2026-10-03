import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDocument, inspectDocument, crossCheckDocuments } from '../src/sourcing/core/docinspect.js';
import { matchSafetyGate } from '../src/sourcing/core/safety.js';
import { hsCandidates, customsAssessment } from '../src/sourcing/core/customs.js';
import { createIdentity, addEvidence, effective, applyCategory, identificationConfidence } from '../src/sourcing/core/identity.js';
import { newCase, dispatch, assess, whatIf, recordDecision } from '../src/sourcing/core/case.js';
import { summarizeMarket, amazonReadiness } from '../src/sourcing/core/amazon.js';
import { buildQuestions, supplierSheet, negotiationBrief } from '../src/sourcing/core/supplier.js';
import { build, run, ident, traits, extraTraits, importer, commercial, docsFor, doc, eudoc, testReport, NOW, MFR } from './sourcing-fixtures.js';

const inspect = (text, identity = { model: 'PD-65', manufacturer: MFR, category: 'usb_charger' }, extra = {}) => { const extraction = extractDocument({ text, ...extra }); return { extraction, ...inspectDocument({ extraction, identity, now: NOW, expectedFamilies: ['LVD', 'EMC'] }) }; };

test('document inspection: a consistent declaration raises no finding, and says it is not proof', () => {
  const r = inspect(eudoc({ model: 'PD-65', directives: ['2014/35/EU', '2014/30/EU'], standards: ['EN 62368-1:2014', 'EN 55032:2015'] }));
  assert.equal(r.consistency, 'NO_ISSUE_FOUND', JSON.stringify(r.findings));
  assert.match(r.note, /NOT proof/);
});

test('document inspection: model mismatch, manufacturer mismatch, missing pages, expiry, unrelated standards, unknown lab', () => {
  const mm = inspect(eudoc({ model: 'PD-200', directives: ['2014/35/EU'], standards: ['EN 62368-1'] }));
  assert.ok(mm.findings.some((f) => f.code === 'MODEL_MISMATCH' && f.severity === 'INCONSISTENT'));
  const mf = inspect(eudoc({ model: 'PD-65', mfr: 'Totally Other Plastics Group', directives: ['2014/35/EU'], standards: ['EN 62368-1'] }));
  assert.ok(mf.findings.some((f) => f.code === 'MANUFACTURER_MISMATCH'));
  const pages = inspect(`${testReport({ model: 'PD-65', standards: ['EN 62368-1'] })}\nPage 1 of 6`);
  assert.ok(pages.findings.some((f) => f.code === 'MISSING_PAGES'));
  const exp = inspect(`${eudoc({ model: 'PD-65', directives: ['2014/35/EU'], standards: ['EN 62368-1'] })}\nValid until: 2025-01-01`);
  assert.ok(exp.findings.some((f) => f.code === 'EXPIRED_OR_DATE_CONCERN' && /validity ended/.test(f.detail)));
  const un = inspect(testReport({ model: 'PD-65', standards: ['EN 71-1:2014', 'EN 14682:2014'] }));
  assert.ok(un.findings.some((f) => f.code === 'UNRELATED_STANDARD'));
  const lab = inspect(testReport({ model: 'PD-65', standards: ['EN 62368-1'], accredited: false }));
  assert.ok(lab.findings.some((f) => f.code === 'UNKNOWN_LAB'));
});

test('document inspection: several independent inconsistencies are SUSPICIOUS, never "fake"; a "CE certificate" is flagged as misrepresented', () => {
  const r = inspect(eudoc({ model: 'PD-200', mfr: 'Totally Other Plastics Group', directives: ['2014/35/EU'], standards: ['EN 62368-1'] }) + '\nValid until: 2024-01-01');
  assert.equal(r.consistency, 'SUSPICIOUS');
  assert.match(r.note, /NOT proof of forgery/);
  assert.equal(JSON.stringify(r).toLowerCase().includes('fake'), false);
  const ce = inspect('This is the CE certificate of the product, issued by a laboratory. Model: PD-65. Standards EN 62368-1. Manufacturer: ' + MFR, undefined, { claimedType: 'CE certificate', fileName: 'CE certificate.pdf' });
  assert.ok(ce.findings.some((f) => f.code === 'DOCUMENT_TYPE_MISREPRESENTED'));
});

test('document inspection: almost no text (a scan) is INSUFFICIENT_EVIDENCE, not guessed', () => {
  const r = inspect('scan');
  assert.equal(r.consistency, 'INSUFFICIENT_EVIDENCE');
});

test('cross-check between documents: a test report dated after the declaration, a report that was never supplied', () => {
  const d1 = { id: 'dc', extraction: extractDocument({ text: eudoc({ model: 'PD-65', directives: ['2014/35/EU'], standards: ['EN 62368-1'], date: '2026-03-01' }) + '\nReport No.: ZZ99887766' }) };
  const d2 = { id: 'tr', extraction: extractDocument({ text: testReport({ model: 'PD-65', standards: ['EN 62368-1'], date: '2026-04-01', issue: '2026-04-05' }) }) };
  const out = crossCheckDocuments([d1, d2]);
  assert.ok(out.some((f) => /dated AFTER/.test(f.detail)));
  assert.ok(out.some((f) => /references report ZZ99887766/.test(f.detail)));
});

test('Safety Gate matching: barcode and brand+model exact, model-only probable, no match is NOT safe, offline is NOT a clean result', () => {
  const id = { brand: 'Acme', model: 'PB-1000', gtin: '4006381333931', name: 'Power bank', category: 'power_bank' };
  const src = { mode: 'LIVE_VERIFIED', fetchedAt: NOW.toISOString() };
  assert.equal(matchSafetyGate({ identity: id, alerts: [{ caseNumber: 'A', barcode: '4006381333931' }], source: src }).status, 'EXACT_MATCH');
  assert.equal(matchSafetyGate({ identity: id, alerts: [{ caseNumber: 'A', brand: 'ACME', model: 'pb 1000' }], source: src }).status, 'EXACT_MATCH');
  assert.equal(matchSafetyGate({ identity: id, alerts: [{ caseNumber: 'A', brand: 'Other', model: 'PB-1000' }], source: src }).status, 'PROBABLE_MATCH');
  const none = matchSafetyGate({ identity: id, alerts: [{ caseNumber: 'A', brand: 'Other', model: 'Z', category: 'Toys', product: 'Doll' }], source: src });
  assert.equal(none.status, 'NO_MATCH_FOUND'); assert.match(none.note, /NO MATCH FOUND does not prove safety/);
  const off = matchSafetyGate({ identity: id, alerts: null, source: { mode: 'OFFLINE_VERIFICATION_REQUIRED' } });
  assert.equal(off.status, 'NOT_CHECKED'); assert.match(off.note, /not a clean result and does not prove safety/);
});

test('customs: candidates are hints, no duty is invented, the cheapest heading is never picked, a BTI makes it binding', () => {
  const id = applyCategory(createIdentity({ workingName: 'power bank' }), 'power_bank');
  const cands = hsCandidates(id); assert.ok(cands.length >= 2);
  const none = customsAssessment({ candidates: cands, now: NOW });
  assert.equal(none.status, 'CLASSIFICATION_REQUIRES_CONFIRMATION'); assert.equal(none.duty.ratePct, null); assert.equal(none.chosenCode, null);
  assert.ok(none.notes.some((n) => /CUSTOMS CLASSIFICATION REQUIRES CONFIRMATION/.test(n)) && none.notes.some((n) => /cheapest is NOT assumed/.test(n)));
  const user = customsAssessment({ candidates: cands, chosenCode: '8507.60', duty: { ratePct: 2.7, kind: 'USER_ENTERED' }, now: NOW });
  assert.equal(user.status, 'CLASSIFICATION_CHOSEN_UNCONFIRMED'); assert.equal(user.duty.factClass, 'ESTIMATE');
  const bti = customsAssessment({ candidates: cands, chosenCode: '8507.60', bti: { number: 'BE-123', validUntil: '2027-01-01' }, now: NOW });
  assert.equal(bti.status, 'CLASSIFICATION_BINDING_BTI');
  const exp = customsAssessment({ candidates: cands, chosenCode: '8507.60', bti: { number: 'BE-123', validUntil: '2025-01-01' }, now: NOW });
  assert.equal(exp.status, 'CLASSIFICATION_CHOSEN_UNCONFIRMED');
  const ad = customsAssessment({ candidates: cands, chosenCode: '8507.60', duty: { ratePct: 2.7, measures: [{ type: 'Anti-dumping duty' }] }, now: NOW });
  assert.equal(ad.tradeMeasureWarning, true);
});

test('identity: unknown stays unknown, the owner can correct their own answer, documents and suppliers can contradict each other', () => {
  let id = createIdentity({});
  assert.equal(effective(id, 'battery.present').known, false);
  id = addEvidence(id, 'battery.present', { value: true, level: 'PROBABLE' });
  assert.equal(effective(id, 'battery.present').level, 'PROBABLE');
  id = addEvidence(id, 'battery.present', { value: false, level: 'USER_STATED' });
  assert.equal(effective(id, 'battery.present').value, false);
  id = addEvidence(id, 'battery.present', { value: true, level: 'USER_STATED' });
  assert.equal(effective(id, 'battery.present').value, true, 'the latest user statement wins');
  id = addEvidence(id, 'model', { value: 'A-1', level: 'SUPPLIER_CLAIMED' }); id = addEvidence(id, 'model', { value: 'A-2', level: 'SUPPLIER_CLAIMED' });
  const m = effective(id, 'model'); assert.equal(m.known, false); assert.equal(m.contradiction, true);
  assert.equal(identificationConfidence(id).level, 'LOW');
});

test('identity: a category profile alone never reaches HIGH identification', () => {
  const id = applyCategory(createIdentity({}), 'usb_charger');
  assert.notEqual(identificationConfidence(id).level, 'HIGH');
  assert.ok(identificationConfidence(id).assumedFromProfileOnly.length > 0);
});

test('market: observations are dated and typed, similar listings are not permission, unavailable stays unavailable', () => {
  const s = summarizeMarket([{ marketplace: 'amazon.fr', price: '19.90', observedAt: '2026-10-01T10:00:00Z' }, { marketplace: 'amazon.fr', price: '24.90', observedAt: '2026-09-01T10:00:00Z' }, { marketplace: 'amazon.de', price: '21.00', kind: 'ESTIMATE', observedAt: '2026-10-02T10:00:00Z' }], NOW);
  assert.equal(s.byMarketplace.find((m) => m.marketplace === 'amazon.be').status, 'UNAVAILABLE');
  assert.equal(s.byMarketplace.find((m) => m.marketplace === 'amazon.fr').status, 'OBSERVED');
  assert.equal(s.byMarketplace.find((m) => m.marketplace === 'amazon.de').status, 'ESTIMATED');
  assert.equal(s.referencePriceMinor, 2240);
  assert.ok(s.caveats.some((c) => /not that you may sell this product/.test(c)));
  assert.equal(summarizeMarket([], NOW).referencePriceMinor, null);
});

test('Amazon readiness is separate from legal marketability and is never "approved": READY needs a Seller Central check that came back open', () => {
  const base = [...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ price: 24.99 }), ...docsFor.charger('PD-65'), { type: 'CONTEXT', context: { channels: ['own_site', 'amazon'] } },
    doc('Label artwork: manufacturer Shenzhen Brightway Electronics Co., Ltd, Longhua District, Shenzhen, China. Importer Example BV, Rue Test 1, 5000 Namur, Belgium. EU responsible person: Example BV. Model PD-65 input 100-240V', { id: 'lab', docType: 'LABEL_ARTWORK' })];
  const unknown = run(build(base)); assert.equal(unknown.amazon.requested, true);
  assert.notEqual(unknown.amazon.status, 'READY');
  assert.ok(unknown.amazon.notes.some((n) => /NOT checked/.test(n)));
  assert.ok(unknown.amazon.notes.some((n) => /never means Amazon approval/.test(n)));
  const restricted = run(build([...base, { type: 'AMAZON', amazon: { restricted: true } }]));
  assert.equal(restricted.amazon.status, 'NOT_READY'); assert.ok(restricted.decision.hardBlockers.concat(restricted.decision.conditionBlockers).some((b) => b.code === 'AMAZON_CATEGORY_RESTRICTION'));
  const own = run(build([...base.filter((e) => !(e.type === 'CONTEXT')), { type: 'CONTEXT', context: { channels: ['own_site'] } }]));
  assert.equal(own.amazon.status, 'NOT_REQUESTED');
});

test('Amazon economics: fees are never invented - unknown fees give an upper bound and the verdict cannot be GO', () => {
  const c = build([...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ price: 24.99 }), ...docsFor.charger('PD-65'), { type: 'CONTEXT', context: { channels: ['amazon'] } },
    { type: 'SALE_AMAZON', sale: { sellingPriceGross: 24.99, vatRatePct: 21, lines: [{ key: 'referral', kind: 'pct_of_gross', status: 'UNKNOWN' }, { key: 'fulfilment', kind: 'per_unit', status: 'UNKNOWN' }] } }]);
  const a = run(c); assert.equal(a.economicsAmazon.status, 'UPPER_BOUND'); assert.equal(a.economicsAmazon.contributionIsUpperBound, true);
  assert.notEqual(a.decision.verdict, 'GO'); assert.ok(a.decision.conditions.some((x) => /Amazon economics are incomplete/.test(x)));
});

test('what-if: a new supplier price recomputes everything without touching the case', () => {
  const c = build([...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ unitPrice: 9.5, price: 8.99 }), ...docsFor.charger('PD-65')]);
  const before = JSON.stringify(c);
  const w = whatIf(c, { unitPrice: 4.2 }, { now: NOW, externals: { safety: { alerts: [], source: { mode: 'LIVE_VERIFIED', fetchedAt: NOW.toISOString() } } } });
  assert.equal(JSON.stringify(c), before);
  assert.equal(w.current.verdict, 'NO_GO');
  assert.ok(w.whatIf.landedPerUnitMinor < w.current.landedPerUnitMinor);
  assert.equal(typeof w.withinMaxPrice, 'boolean');
});

test('decision history is append-only and records only real changes', () => {
  let c = build([{ type: 'NAME', name: 'gadget' }]);
  const a1 = run(c); c = recordDecision(c, a1, NOW); c = recordDecision(c, a1, NOW);
  assert.equal(c.decisions.length, 1);
  c = dispatch(c, { type: 'CATEGORY', category: 'household_general' }, NOW);
  const a2 = run(c); c = recordDecision(c, a2, NOW);
  assert.ok(c.decisions.length >= 1);
  assert.equal(c.decisions[0].verdict, 'INSUFFICIENT_INFORMATION');
  assert.throws(() => dispatch(c, { type: 'NOPE' }, NOW), /unknown case event/);
});

test('supplier sheet: EN + 中文, model numbers verbatim, honest about being a fixed phrasebook; negotiation brief is arithmetic, not a forecast', () => {
  const a = run(build([...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65/EU' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ price: 24.99 })]));
  const sheet = a.supplierSheet; assert.match(sheet.note.en, /Fixed phrasebook/); assert.match(sheet.note.zh, /固定用语/);
  const withModel = a.questions.filter((q) => q.docType); assert.ok(withModel.length > 0);
  for (const q of withModel) { assert.ok(q.en.includes('PD-65/EU') && q.zh.includes('PD-65/EU'), q.id); }
  assert.ok(a.questions.every((q) => /[一-鿿]/.test(q.zh)));
  assert.ok(sheet.items.every((i) => i.en && i.zh));
  const n = a.negotiation; assert.match(n.nothingPredicted, /not a market forecast/);
  assert.ok(n.walkAwayUnitPrice.minor > n.targetUnitPrice.minor);
  assert.ok(n.documentsBeforeDeposit.length > 0);
});

test('evidence classes stay separate: the CE logo / supplier claims are claims, calculated values are calculated, the category guess is assumed', () => {
  const a = run(build([...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65' }), ...importer, ...commercial({ price: 24.99 })]));
  assert.ok(a.evidence.assumed.length > 0, 'profile traits are assumed, not facts');
  assert.ok(a.evidence.supplierClaims.some((e) => e.item === 'supplier quote'));
  assert.ok(a.evidence.calculated.some((e) => e.item === 'landed cost per unit'));
  assert.ok(a.evidence.estimated.some((e) => e.item === 'customs duty rate'));
  assert.ok(a.evidence.verified.every((e) => e.item === 'EU Safety Gate check'));
});
