// The fifteen synthetic test products (A-O). Expected results are NOT always GO: the engine must refuse where evidence is missing, contradictory or the economics fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEWED_RULEBOOK, build, run, ident, traits, extraTraits, importer, ownBrand, commercial, docsFor, doc, eudoc, testReport, NOW, LIVE_CLEAN } from './sourcing-fixtures.js';

const codes = (a) => a.decision.hardBlockers.map((b) => b.code);
const asked = (a) => a.questions.map((q) => q.id);

test('A. simple non-electrical household product -> GO (only GPSR / REACH / language apply, all verified; administrative obligations are listed, not blocking)', () => {
  const events = [...ident({ name: 'Plastic-free storage basket', category: 'household_general', model: 'SB-12' }), ...traits({}), ...importer, ...commercial({ price: 14.99, duty: 6.5, code: '4602.19' })];
  const a = run(build(events), undefined, { rulebook: REVIEWED_RULEBOOK }); const today = run(build(events));
  assert.equal(a.rules.ce.status, 'CE_NOT_APPLICABLE');
  assert.equal(a.decision.dimensions.identification, 'HIGH');
  assert.equal(a.decision.dimensions.marketability, 'GREEN');
  assert.equal(a.decision.dimensions.economics, 'ATTRACTIVE');
  assert.equal(a.decision.verdict, 'GO');
  assert.equal(a.decision.canCommitMoney, true);
  assert.equal(today.decision.verdict, 'GO'); assert.equal(today.decision.dimensions.marketability, 'GREEN'); assert.equal(today.decision.canCommitMoney, true);
  assert.ok(today.decision.adminObligations.length > 0, 'registrations and producer responsibility are listed for the owner');
  assert.ok(today.decision.adminObligations.every((o) => o.materiality === 'OPERATOR_ADMIN'));
  assert.ok(a.maxPurchasePrice.maxUnitPriceMinor > 420, 'the max price must exceed the quote when the product is attractive');
});

test('B. USB charger: no documents -> CONDITIONAL_GO with the missing documents named; full consistent set -> GO', () => {
  const base = [...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230, 'electrical.maxVoltageDc': 20 }), ...importer, ...commercial({ price: 24.99 })];
  const none = run(build(base));
  assert.equal(none.rules.ce.status, 'CE_REQUIRED');
  assert.equal(none.decision.verdict, 'CONDITIONAL_GO');
  assert.ok(codes(none).includes('REQUIRED_DOCUMENT_MISSING'));
  assert.equal(none.decision.canCommitMoney, false);
  assert.ok(asked(none).some((i) => i.startsWith('doc:EU_DOC')) && asked(none).includes('doc:TEST_REPORT'));
  const full = run(build([...base, ...docsFor.charger('PD-65')]), undefined, { rulebook: REVIEWED_RULEBOOK });
  assert.deepEqual(codes(full), [], JSON.stringify(full.decision.hardBlockers));
  assert.equal(full.decision.dimensions.supplierEvidence, 'COMPLETE');
  assert.equal(full.decision.verdict, 'GO');
  const realReview = run(build([...base, ...docsFor.charger('PD-65')]));
  assert.equal(realReview.decision.verdict, 'GO', 'on the real rulebook every applicable material rule is verified enough (LVD is PRIMARY_TEXT_ONLY)');
});

test('C. power bank: lithium + higher-risk regime -> never a plain GO; documents set clears the document blocker but keeps the expert condition', () => {
  const base = [...ident({ name: 'Power bank 10000mAh', category: 'power_bank', model: 'PB-100' }), ...traits({ 'electrical.present': true, 'battery.present': true }), ...extraTraits({ 'electrical.mainsConnected': false, 'electrical.maxVoltageAc': 0, 'electrical.maxVoltageDc': 5, 'battery.chemistry': 'li_ion' }), ...importer, ...commercial({ price: 24.99, code: '8507.60' })];
  const none = run(build(base));
  assert.ok(codes(none).includes('REQUIRED_DOCUMENT_MISSING'));
  assert.ok(none.decision.gaps.missingDocs.some((m) => m.docType === 'UN383'));
  const full = run(build([...base, ...docsFor.powerbank('PB-100')]));
  assert.ok(!codes(full).includes('REQUIRED_DOCUMENT_MISSING'), JSON.stringify(full.decision.gaps.missingDocs));
  assert.equal(full.decision.verdict, 'CONDITIONAL_GO');
  assert.ok(full.decision.conditions.some((c) => /expert or authority confirmation/.test(c)));
  assert.equal(full.decision.canCommitMoney, false);
});

test('D. Bluetooth speaker: RED applies, cybersecurity unresolved keeps it conditional until the connectivity questions are answered', () => {
  const base = [...ident({ name: 'Bluetooth speaker', category: 'bluetooth_speaker', model: 'BT-30' }), ...traits({ 'electrical.present': true, 'battery.present': true, 'radio.present': true }), ...extraTraits({ 'electrical.mainsConnected': false, 'electrical.maxVoltageAc': 0, 'electrical.maxVoltageDc': 5, 'battery.chemistry': 'li_ion' }), ...importer, ...commercial({ price: 29.99, code: '8518.22' })];
  const open = run(build([...base, ...docsFor.bluetooth('BT-30')]));
  assert.equal(open.rules.results.find((r) => r.ruleId === 'eu.red').status, 'APPLIES');
  assert.equal(open.rules.results.find((r) => r.ruleId === 'eu.red_cyber').status, 'UNRESOLVED');
  assert.notEqual(open.decision.verdict, 'GO');
  const answered = run(build([...base, ...extraTraits({ 'radio.internetConnected': false, 'radio.processesPersonalData': false }), ...docsFor.bluetooth('BT-30')]));
  assert.equal(answered.rules.results.find((r) => r.ruleId === 'eu.red_cyber').status, 'NOT_APPLICABLE');
  assert.equal(answered.rules.results.find((r) => r.ruleId === 'eu.lvd').status, 'NOT_APPLICABLE');
});

test('E. children\'s toy: higher-risk regime, no documents -> CONDITIONAL_GO at best, safety risk not LOW; complete set still needs expert confirmation', () => {
  const base = [...ident({ name: 'Wooden puzzle toy', category: 'toy_plastic', model: 'TY-7' }), ...traits({ childrenUse: true }), ...extraTraits({ toy: true }), ...importer, ...commercial({ price: 19.99, code: '9503.00' })];
  const none = run(build(base));
  assert.equal(none.decision.verdict, 'CONDITIONAL_GO');
  assert.ok(codes(none).includes('REQUIRED_DOCUMENT_MISSING'));
  assert.notEqual(none.decision.dimensions.safetyRisk, 'LOW');
  const full = run(build([...base, ...docsFor.toy('TY-7')]));
  assert.ok(!codes(full).includes('REQUIRED_DOCUMENT_MISSING'), JSON.stringify(full.decision.gaps.missingDocs));
  assert.equal(full.decision.verdict, 'CONDITIONAL_GO');
  assert.ok(full.decision.conditions.some((c) => /expert or authority/.test(c)));
});

test('F. food-contact bottle: declaration of compliance and migration test are required; Belgian FASFC rule applies', () => {
  const base = [...ident({ name: 'Stainless drinking bottle', category: 'water_bottle', model: 'WB-5' }), ...traits({ foodContact: true }), ...importer, ...commercial({ price: 16.99, code: '7323.93' })];
  const none = run(build(base));
  assert.ok(none.decision.gaps.missingDocs.some((m) => m.docType === 'FCM_DOC'));
  assert.equal(none.rules.results.find((r) => r.ruleId === 'be.fcm').status, 'APPLIES');
  assert.equal(none.decision.verdict, 'CONDITIONAL_GO');
  const full = run(build([...base, ...docsFor.bottle('WB-5')]));
  assert.ok(!full.decision.gaps.missingDocs.some((m) => m.docType === 'FCM_DOC'), JSON.stringify(full.decision.gaps.missingDocs));
  assert.notEqual(full.decision.verdict, 'GO');
});

test('G. textile item: label with fibre composition is required; with it the product can be GO; not a CE product', () => {
  const base = [...ident({ name: 'Cotton T-shirt', category: 'textile_adult', model: 'TS-9' }), ...traits({ textile: true }), ...importer, ...commercial({ price: 12.99, code: '6109.10', duty: 12 })];
  const none = run(build(base));
  assert.equal(none.rules.ce.status, 'CE_NOT_APPLICABLE');
  assert.ok(none.decision.gaps.missingDocs.some((m) => m.docType === 'LABEL_ARTWORK'));
  const label = run(build([...base, doc('Label artwork: 100% cotton, size M, care: machine wash 30C. Made in China. Importer: Example BV, Rue Test 1, 5000 Namur, Belgium', { id: 'lab', docType: 'LABEL_ARTWORK' })]));
  assert.ok(!label.decision.gaps.missingDocs.some((m) => m.docType === 'LABEL_ARTWORK'));
  assert.equal(label.decision.verdict, 'GO', JSON.stringify(label.decision.conditions));
  const reviewed = run(build([...base, doc('Label artwork: 100% cotton, size M, care: machine wash 30C. Made in China. Importer: Example BV, Rue Test 1, 5000 Namur, Belgium', { id: 'lab', docType: 'LABEL_ARTWORK' })]), undefined, { rulebook: REVIEWED_RULEBOOK });
  assert.equal(reviewed.decision.verdict, 'GO', JSON.stringify(reviewed.decision.conditions));
});

test('H. cosmetic-like product: regulated, never GO from documents alone; a medical claim makes it INFORMATION_INSUFFICIENT', () => {
  const base = [...ident({ name: 'Face cream 50ml', category: 'cosmetic_product', model: 'FC-50' }), ...traits({ cosmetic: true, chemicalMixture: true }), ...importer, ...commercial({ price: 17.99, code: '3304.99' })];
  const plain = run(build(base));
  assert.ok(plain.rules.results.find((r) => r.ruleId === 'eu.cosmetics').requiredEvidence.some((e) => e.id === 'cosm.rp'));
  assert.notEqual(plain.decision.verdict, 'GO');
  const medical = run(build([...base, ...extraTraits({ medical: true })]));
  assert.equal(medical.decision.verdict, 'INSUFFICIENT_INFORMATION');
  assert.equal(medical.decision.dimensions.marketability, 'RED');
  assert.match(medical.decision.nextAction, /medical claim/);
});

test('I. apparent CE logo but no documentation: the logo is not evidence', () => {
  const a = run(build([...ident({ name: 'USB-C charger 30W', category: 'usb_charger', model: 'PD-30' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ price: 19.99 }), { type: 'NOTE', text: 'CE logo printed on the packaging; supplier says "CE certified"' }]));
  assert.equal(a.rules.ce.status, 'CE_REQUIRED');
  assert.ok(codes(a).includes('REQUIRED_DOCUMENT_MISSING'));
  assert.notEqual(a.decision.dimensions.marketability, 'GREEN');
  assert.equal(a.decision.dimensions.supplierEvidence, 'INSUFFICIENT');
  assert.equal(a.evidence.verified.some((e) => /CE/i.test(e.item)), false);
});

test('J. documents for a different model: contradiction -> NO_GO, with a correction request to the supplier', () => {
  const a = run(build([...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ price: 24.99 }), ...docsFor.charger('PD-200')]));
  assert.ok(a.documents.every((d) => d.findings.some((f) => f.code === 'MODEL_MISMATCH')));
  assert.ok(codes(a).includes('DOCUMENT_CONTRADICTS_CASE'));
  assert.equal(a.decision.verdict, 'NO_GO');
  assert.equal(a.decision.dimensions.supplierEvidence, 'CONTRADICTORY');
  assert.ok(asked(a).some((i) => i.endsWith(':fix')));
  assert.match(a.questions.find((q) => q.id.endsWith(':fix')).zh, /PD-65/);
});

test('K. Safety Gate: similar product -> risk MEDIUM, exact match -> NO_GO even with perfect documents', () => {
  const base = [...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65', brand: 'Brightway' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ price: 24.99 }), ...docsFor.charger('PD-65')];
  const similar = run(build(base), { safety: { alerts: [{ caseNumber: 'SR/1/26', category: 'Electrical appliances and equipment', product: 'USB charger', name: 'Mains charger', brand: 'Other', model: 'ZZ-1', riskType: 'Electric shock', danger: 'Insulation fails', countryOfOrigin: 'China', level: 'Serious risk' }], source: LIVE_CLEAN.source } });
  assert.equal(similar.safety.status, 'SIMILAR_PRODUCT_RISK');
  assert.equal(similar.decision.dimensions.safetyRisk, 'MEDIUM');
  assert.notEqual(similar.decision.verdict, 'NO_GO');
  const exact = run(build(base), { safety: { alerts: [{ caseNumber: 'SR/2/26', category: 'Electrical appliances and equipment', product: 'USB charger', brand: 'Brightway', model: 'PD-65', riskType: 'Electric shock', countryOfOrigin: 'China', level: 'Serious risk' }], source: LIVE_CLEAN.source } });
  assert.equal(exact.safety.status, 'EXACT_MATCH');
  assert.equal(exact.decision.verdict, 'NO_GO');
  assert.ok(codes(exact).includes('SAFETY_ALERT_EXACT_MATCH'));
  assert.equal(exact.decision.dimensions.safetyRisk, 'HIGH');
});

test('L. economically attractive but compliance-blocked -> NO_GO (a probable Safety Gate match outweighs a great margin)', () => {
  const a = run(build([...ident({ name: 'Plush toy', category: 'plush_toy', model: 'PL-7701' }), ...traits({ childrenUse: true, textile: true }), ...extraTraits({ toy: true }), ...importer, ...commercial({ unitPrice: 1.2, price: 24.99, code: '9503.00' }), ...docsFor.toy('PL-7701')]),
    { safety: { alerts: [{ caseNumber: 'SR/3/26', category: 'Toys', product: 'Plush', name: 'Soft toy', brand: 'Another', model: 'PL-7701', riskType: 'Choking', danger: 'small parts detach', countryOfOrigin: 'China', level: 'Serious risk' }], source: LIVE_CLEAN.source } });
  assert.equal(a.decision.dimensions.economics, 'ATTRACTIVE');
  assert.equal(a.safety.status, 'PROBABLE_MATCH');
  assert.equal(a.decision.verdict, 'NO_GO');
  assert.equal(a.decision.dimensions.marketability, 'RED');
});

test('M. compliant-looking documents but terrible economics -> NO_GO with the price that WOULD work', () => {
  const a = run(build([...ident({ name: 'USB-C charger 65W', category: 'usb_charger', model: 'PD-65' }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial({ unitPrice: 9.5, price: 8.99 }), ...docsFor.charger('PD-65')]));
  assert.equal(a.decision.dimensions.supplierEvidence, 'COMPLETE');
  assert.equal(a.decision.dimensions.economics, 'UNATTRACTIVE');
  assert.equal(a.decision.verdict, 'NO_GO');
  assert.ok(codes(a).includes('NEGATIVE_UNIT_ECONOMICS'));
  assert.ok(a.maxPurchasePrice.maxUnitPriceMinor < 950);
  assert.match(a.decision.nextAction, /renegotiate/);
});

test('N. insufficient identification -> INFORMATION_INSUFFICIENT with the priority questions, never a guess', () => {
  const a = run(build([{ type: 'NAME', name: 'gadget' }]));
  assert.equal(a.decision.verdict, 'INSUFFICIENT_INFORMATION');
  assert.equal(a.decision.dimensions.identification, 'LOW');
  assert.ok(codes(a).includes('PRODUCT_IDENTITY_UNRESOLVED'));
  assert.equal(a.rules.ce.status, 'CE_APPLICABILITY_UNRESOLVED');
  assert.ok(['model', 'manufacturer', 'price'].every((q) => asked(a).includes(q)));
  assert.equal(a.maxPurchasePrice.maxUnitPriceMinor, null);
});

test('O. own brand / private label: HIGH manufacturer-duty warning, technical file required, never GO', () => {
  const a = run(build([...ident({ name: 'Ceramic mug', category: 'tableware_glass_ceramic', model: 'MG-3' }), ...traits({ foodContact: true }), ...ownBrand, ...commercial({ price: 14.99, code: '6912.00' }), ...docsFor.bottle('MG-3')]));
  assert.equal(a.role.warnings[0].code, 'OWN_BRAND_MANUFACTURER_DUTIES');
  assert.equal(a.role.warnings[0].severity, 'HIGH');
  assert.ok(a.decision.conditionBlockers.some((b) => b.code === 'OWN_BRAND_MANUFACTURER_DUTIES'));
  assert.ok(a.rules.results.find((r) => r.ruleId === 'eu.gpsr').requiredEvidence.some((e) => e.id === 'gpsr.risk_analysis' && e.requirement === 'REQUIRED'));
  assert.ok(asked(a).includes('own_brand_docs'));
  assert.notEqual(a.decision.verdict, 'GO');
});

test('the decision never carries an opaque score and always states what it is not', () => {
  const a = run(build([{ type: 'NAME', name: 'gadget' }]));
  assert.equal(JSON.stringify(a.decision).includes('"score"'), false);
  assert.match(a.decision.note, /not a lawyer, customs authority, laboratory/);
});
