// Regulatory closure: review metadata invariants, product-specific applicability, own brand / private label, Belgian layers, batteries dates, verdict materiality,
// source freshness, phrasebook preservation, customs adapter contract. Failing tests were written first for every correction (see docs/sourcing-regulatory-closure.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RULEBOOK, REVIEW, REVIEW_STATUSES, REVIEW_BLOCKING, REVIEW_MAX_AGE_DAYS } from '../src/sourcing/core/rulebook/index.js';
import { economicOperator } from '../src/sourcing/core/operator.js';
import { assess, dispatch } from '../src/sourcing/core/case.js';
import { buildQuestions } from '../src/sourcing/core/supplier.js';
import { validateLookupResult, CUSTOMS_LOOKUP_CONTRACT } from '../src/sourcing/adapters/customs-contract.js';
import { REVIEWED_RULEBOOK, NOW, build, run, ident, traits, extraTraits, importer, ownBrand, commercial, docsFor, doc } from './sourcing-fixtures.js';

const status = (a, id) => a.rules.results.find((r) => r.ruleId === id).status;
const byId = Object.fromEntries(RULEBOOK.map((r) => [r.id, r]));

// ---- review metadata ----------------------------------------------------------------------------------------------------------------------------------------------------
test('review records: every rule has instrument / article / consolidation / application / interpretation / uncertainty / last-checked, statuses are the five classes', () => {
  for (const rule of RULEBOOK) {
    const v = rule.review; assert.ok(v, rule.id);
    assert.ok(['VERIFIED_CURRENT', 'PRIMARY_TEXT_ONLY', 'NEEDS_EXPERT_REVIEW', 'INCOMPLETE', 'UNVERIFIED'].includes(v.status), `${rule.id}: ${v.status}`);
    assert.match(v.checkedAt, /^2026-10-03$/); assert.ok(v.interpretation.length > 40 && v.uncertainty.length > 15, rule.id);
    assert.ok(Array.isArray(v.instruments) && v.instruments.length > 0, rule.id); assert.ok(Array.isArray(v.applicationDates), rule.id);
    for (const i of v.instruments) { assert.ok(i.name && i.reference, rule.id); assert.ok('consolidated' in i || i.supporting, `${rule.id}: ${i.name}`); }
  }
  assert.equal(RULEBOOK.length, 31, 'no rule was added'); assert.deepEqual(REVIEW_STATUSES, ['VERIFIED_CURRENT', 'PRIMARY_TEXT_ONLY', 'NEEDS_EXPERT_REVIEW', 'INCOMPLETE', 'UNVERIFIED']);
});

test('no upgrade without evidence: VERIFIED_CURRENT needs a consolidated text, no later amending act or corrigendum, and application dates checked; counts are pinned', () => {
  const counts = Object.fromEntries(REVIEW_STATUSES.map((s) => [s, 0]));
  for (const rule of RULEBOOK) {
    const v = rule.review; counts[v.status] += 1;
    if (v.status !== 'VERIFIED_CURRENT') continue;
    const main = v.instruments.filter((i) => !i.supporting); assert.ok(main.length > 0, rule.id); assert.equal(v.applicationDatesChecked, true, rule.id);
    for (const i of main) { assert.ok(typeof i.consolidated === 'string' && /^\d{4}-\d{2}-\d{2}$|^Justel/.test(i.consolidated), `${rule.id}: ${i.name} has no consolidated version`); assert.ok(String(i.amendingActsAfter).startsWith('none'), `${rule.id}: ${i.name}`); assert.ok(String(i.corrigendaAfter).startsWith('none'), `${rule.id}: ${i.name}: a corrigendum after the consolidation was not read`); }
  }
  assert.deepEqual(counts, { VERIFIED_CURRENT: 13, PRIMARY_TEXT_ONLY: 12, NEEDS_EXPERT_REVIEW: 1, INCOMPLETE: 2, UNVERIFIED: 3 });
  // the rules whose dates stay ambiguous or unread are NOT upgraded
  for (const id of ['eu.batteries']) assert.equal(byId[id].review.status, 'NEEDS_EXPERT_REVIEW');
  for (const id of ['transport.lithium', 'amazon.category_documents', 'amazon.dangerous_goods']) assert.equal(byId[id].review.status, 'UNVERIFIED');
  for (const id of ['be.packaging', 'amazon.gpsr_listing']) assert.equal(byId[id].review.status, 'INCOMPLETE');
  for (const id of ['eu.lvd', 'eu.red_cyber', 'eu.toys', 'eu.fcm', 'eu.textiles', 'eu.cosmetics']) assert.equal(byId[id].review.status, 'PRIMARY_TEXT_ONLY', `${id}: a corrigendum / amending act after the consolidation (or no consolidated text) keeps it below VERIFIED_CURRENT`);
});

test('batteries: dates resolved from the consolidated text are recorded; the labelling date stays explicitly UNRESOLVED', () => {
  const v = byId['eu.batteries'].review; const dates = v.applicationDates.join(' | ');
  for (const d of ['2024-02-18', '2024-08-18', '2025-08-18', '2027-02-18', '2027-08-18']) assert.ok(dates.includes(d), d);
  assert.match(dates, /UNRESOLVED/); assert.match(dates, /LATER of 2026-08-18/); assert.match(v.uncertainty, /implementing act/); assert.match(byId['eu.batteries'].notes, /LABELLING date is unresolved/);
  assert.match(byId['eu.batteries'].whyApplies, /removable/);
});

// ---- applicability boundaries -------------------------------------------------------------------------------------------------------------------------------------------
const cat = (name, category, t = {}, x = {}) => [...ident({ name, category, model: 'M-1' }), ...traits(t), ...extraTraits(x), ...importer, ...commercial({ price: 20 })];

test('global obligations and category-specific obligations stay distinct', () => {
  const house = run(build(cat('Storage box', 'household_general')));
  for (const rule of RULEBOOK.filter((x) => !x.channel)) {
    assert.ok(['GLOBAL', 'CATEGORY'].includes(rule.scope), rule.id);
    if (rule.scope === 'GLOBAL') assert.notEqual(status(house, rule.id), 'NOT_APPLICABLE', `${rule.id} is global`);
    else assert.equal(status(house, rule.id) === 'APPLIES', false, `${rule.id} must not apply to a plain household product`);
  }
});

test('CE is not universal; RED only for radio; LVD / EMC depend on the product', () => {
  const house = run(build(cat('Storage box', 'household_general'))); assert.equal(house.rules.ce.status, 'CE_NOT_APPLICABLE');
  const charger = run(build(cat('Charger', 'usb_charger', { 'electrical.present': true }, { 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 })));
  assert.equal(status(charger, 'eu.lvd'), 'APPLIES'); assert.equal(status(charger, 'eu.emc'), 'APPLIES'); assert.equal(status(charger, 'eu.red'), 'NOT_APPLICABLE');
  const earbuds = run(build(cat('Earbuds', 'bluetooth_earbuds', { 'electrical.present': true, 'battery.present': true, 'radio.present': true }, { 'electrical.maxVoltageAc': 0, 'electrical.maxVoltageDc': 5 })));
  assert.equal(status(earbuds, 'eu.red'), 'APPLIES'); assert.equal(status(earbuds, 'eu.lvd'), 'NOT_APPLICABLE'); assert.equal(status(earbuds, 'eu.emc'), 'NOT_APPLICABLE');
  const lowV = run(build(cat('USB light', 'usb_cable', { 'electrical.present': true }, { 'electrical.mainsConnected': false, 'electrical.maxVoltageAc': 0, 'electrical.maxVoltageDc': 5 })));
  assert.equal(status(lowV, 'eu.lvd'), 'NOT_APPLICABLE', '5 V DC is below the 75 V DC lower limit'); assert.equal(status(lowV, 'eu.emc'), 'APPLIES');
});

test('toys need the toy classification; food contact needs food contact; cosmetics need the cosmetic trait; battery rules need a battery', () => {
  const kids = run(build(cat('Kids T-shirt', 'textile_children', { childrenUse: true, textile: true }, { toy: false })));
  assert.equal(status(kids, 'eu.toys'), 'NOT_APPLICABLE', 'for children is not the same as a toy'); assert.equal(status(kids, 'eu.textiles'), 'APPLIES');
  const toy = run(build(cat('Puzzle', 'toy_plastic', { childrenUse: true }, { toy: true }))); assert.equal(status(toy, 'eu.toys'), 'APPLIES');
  assert.equal(status(run(build(cat('Mug', 'tableware_glass_ceramic', { foodContact: true }))), 'eu.fcm'), 'APPLIES'); assert.equal(status(run(build(cat('Mug', 'tableware_glass_ceramic', { foodContact: true }))), 'be.fcm'), 'APPLIES');
  assert.equal(status(run(build(cat('Box', 'household_general'))), 'eu.fcm'), 'NOT_APPLICABLE');
  assert.equal(status(run(build(cat('Cream', 'cosmetic_product', { cosmetic: true, chemicalMixture: true }))), 'eu.cosmetics'), 'APPLIES'); assert.equal(status(run(build(cat('Shirt', 'textile_adult', { textile: true }))), 'eu.cosmetics'), 'NOT_APPLICABLE');
  const pb = run(build(cat('Power bank', 'power_bank', { 'electrical.present': true, 'battery.present': true }, { 'battery.chemistry': 'li_ion', 'electrical.maxVoltageAc': 0, 'electrical.maxVoltageDc': 5 })));
  for (const id of ['eu.batteries', 'transport.lithium', 'be.bebat']) assert.equal(status(pb, id), 'APPLIES', id);
  assert.equal(status(run(build(cat('Box', 'household_general'))), 'eu.batteries'), 'NOT_APPLICABLE');
  const noRadio = run(build(cat('Wired speaker', 'bluetooth_speaker', { 'electrical.present': true, 'battery.present': true, 'radio.present': false }, { 'electrical.maxVoltageAc': 0, 'electrical.maxVoltageDc': 5 })));
  assert.equal(status(noRadio, 'eu.charger'), 'NOT_APPLICABLE', 'the common charger rule is a RED rule: radio equipment only (RED Art. 3(4), Annex Ia)');
});

test('a standalone battery is a CE-regime product (Batteries Regulation, Reg. 2019/1020 Art. 4(5)) even without any other electrical trait', () => {
  const cell = run(build(cat('18650 cell', 'battery_standalone', { 'battery.present': true }, { 'battery.chemistry': 'li_ion' })));
  assert.equal(cell.rules.ce.status, 'CE_REQUIRED'); assert.equal(status(cell, 'eu.nlf_operator'), 'APPLIES'); assert.equal(status(cell, 'eu.batteries'), 'APPLIES');
});

test('rule texts corrected against the consolidated sources', () => {
  assert.match(byId['eu.reach'].whyApplies, /one tonne/); assert.match(byId['eu.reach'].whyApplies, /0\.1 % w\/w/); assert.match(byId['eu.reach'].whyApplies, /45 days/);
  assert.equal(/formaldehyde/i.test(byId['eu.textiles'].whyApplies), false, 'formaldehyde was not verified as a textile restriction');
  assert.match(byId['eu.toys'].whyApplies, /presumption of conformity/); assert.equal(/EN 71 testing[^,]*are required/.test(byId['eu.toys'].whyApplies), false);
  assert.match(byId['eu.fcm'].whyApplies, /2026-07-20|20 July 2026/); assert.match(byId['customs.eori'].whyApplies, /2027/);
});

// ---- own brand / private label ---------------------------------------------------------------------------------------------------------------------------------------------
const op = (placing) => economicOperator({ manufacturerEstablishedInEU: false, euAuthorisedRepresentative: false, ...placing });

test('own brand: imported unchanged under the manufacturer brand = importer; own name or trademark = manufacturer (deterministic, with the legal basis)', () => {
  const unchanged = op({ underOwnNameOrBrand: false, modifiedProduct: false, repackaged: false, changedInstructionsOrLabels: false });
  assert.deepEqual(unchanged.roles, ['IMPORTER']); assert.equal(unchanged.ownBrand, false); assert.equal(unchanged.status, 'DETERMINATE'); assert.equal(unchanged.warnings.length, 0);
  const own = op({ underOwnNameOrBrand: true });
  assert.ok(own.roles.includes('MANUFACTURER_OBLIGATIONS_MAY_APPLY') && own.roles.includes('IMPORTER')); assert.equal(own.ownBrand, true); assert.equal(own.warnings[0].severity, 'HIGH');
  assert.ok(own.basis.some((b) => /GPSR Art\. 13\(1\)/.test(b)) && own.basis.some((b) => /LVD Art\. 10|EMC Art\. 11|RED Art\. 14/.test(b)));
});

test('own brand: modification, repackaging and label changes follow explicit rules, never a casual "just a distributor"', () => {
  const modAffects = op({ underOwnNameOrBrand: false, modifiedProduct: true, modificationAffectsCompliance: true });
  assert.equal(modAffects.ownBrand, true); assert.ok(modAffects.warnings.some((w) => w.code === 'MODIFICATION_AFFECTS_COMPLIANCE')); assert.equal(modAffects.status, 'DETERMINATE');
  const modHarmless = op({ underOwnNameOrBrand: false, modifiedProduct: true, modificationAffectsCompliance: false });
  assert.equal(modHarmless.ownBrand, false); assert.equal(modHarmless.status, 'DETERMINATE');
  const modUnknown = op({ underOwnNameOrBrand: false, modifiedProduct: true });
  assert.equal(modUnknown.status, 'UNRESOLVED'); assert.equal(modUnknown.ownBrand, null, 'not decided: the question is asked'); assert.ok(modUnknown.unresolved.some((u) => u.code === 'MODIFICATION_EFFECT_UNKNOWN'));
  const repackOwn = op({ underOwnNameOrBrand: false, repackaged: true, repackagedUnderOwnName: true }); assert.equal(repackOwn.ownBrand, true); assert.ok(repackOwn.basis.some((b) => /Blue Guide/.test(b)));
  const repackOther = op({ underOwnNameOrBrand: false, repackaged: true, repackagedUnderOwnName: false }); assert.equal(repackOther.ownBrand, false);
  const translated = op({ underOwnNameOrBrand: false, changedInstructionsOrLabels: true, changedSafetyInformation: false }); assert.equal(translated.ownBrand, false);
  const safetyChanged = op({ underOwnNameOrBrand: false, changedInstructionsOrLabels: true, changedSafetyInformation: true }); assert.equal(safetyChanged.status, 'UNRESOLVED'); assert.ok(safetyChanged.unresolved.some((u) => u.code === 'SAFETY_INFORMATION_CHANGED'));
  const backCompat = op({ underOwnNameOrBrand: false, substantialModification: true }); assert.equal(backCompat.ownBrand, true);
});

test('own brand flows into the case: unresolved status asks a question and keeps the verdict conditional; GPSR technical documentation is not required for harmonised products', () => {
  const base = cat('USB charger', 'usb_charger', { 'electrical.present': true }, { 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 });
  const a = run(build([...base.filter((e) => e.type !== 'PLACING'), { type: 'PLACING', placing: { underOwnNameOrBrand: false, manufacturerEstablishedInEU: false, modifiedProduct: true } }]), undefined, { rulebook: REVIEWED_RULEBOOK });
  assert.equal(a.role.status, 'UNRESOLVED'); assert.ok(a.questions.some((q) => q.id === 'modification_effect')); assert.notEqual(a.decision.verdict, 'GO');
  const own = run(build([...base.filter((e) => e.type !== 'PLACING'), ...ownBrand]));
  const gpsr = own.rules.results.find((r) => r.ruleId === 'eu.gpsr').requiredEvidence.find((e) => e.id === 'gpsr.risk_analysis'); assert.equal(gpsr.requirement, 'NOT_APPLICABLE', 'harmonised product: Arts 9-18 GPSR do not apply');
  assert.equal(own.rules.results.find((r) => r.ruleId === 'eu.nlf_operator').requiredEvidence.find((e) => e.id === 'nlf.own_brand').requirement, 'REQUIRED');
  const plain = run(build([...cat('Storage box', 'household_general').filter((e) => e.type !== 'PLACING'), ...ownBrand]));
  assert.equal(plain.rules.results.find((r) => r.ruleId === 'eu.gpsr').requiredEvidence.find((e) => e.id === 'gpsr.risk_analysis').requirement, 'REQUIRED', 'non-harmonised: the risk analysis and technical documentation are the owner\'s');
});

// ---- Belgium: legal obligation vs scheme vs optional service ---------------------------------------------------------------------------------------------------------------------
test('Belgium overlay distinguishes EU / Belgium / regional requirements from scheme and optional services', () => {
  const layer = (id) => byId[id].layer;
  assert.equal(layer('eu.gpsr'), 'EU'); assert.equal(layer('be.language'), 'BELGIUM'); assert.equal(layer('be.bipt'), 'BELGIUM'); assert.equal(layer('be.fcm'), 'BELGIUM');
  for (const id of ['be.recupel', 'be.bebat', 'be.packaging']) assert.equal(layer(id), 'REGIONAL', id);
  const kinds = (id) => byId[id].requiredEvidence.map((e) => `${e.obligation}`);
  assert.ok(kinds('be.bebat').includes('LEGAL') && kinds('be.bebat').includes('OPTIONAL_SERVICE'), 'Bebat membership is an optional service, the regional registration is the obligation');
  assert.ok(kinds('be.recupel').includes('LEGAL') && kinds('be.recupel').includes('SCHEME_SERVICE'));
  assert.ok(kinds('be.packaging').includes('LEGAL') && kinds('be.packaging').includes('SCHEME_SERVICE'));
  for (const rule of RULEBOOK) for (const e of rule.requiredEvidence) assert.ok(['LEGAL', 'SCHEME_SERVICE', 'OPTIONAL_SERVICE'].includes(e.obligation), `${rule.id}.${e.id}`);
  // an optional service / scheme item never counts as a missing legal document
  const pb = run(build(cat('Power bank', 'power_bank', { 'electrical.present': true, 'battery.present': true }, { 'battery.chemistry': 'li_ion', 'electrical.maxVoltageAc': 0, 'electrical.maxVoltageDc': 5 })));
  const bebat = pb.rules.results.find((r) => r.ruleId === 'be.bebat').requiredEvidence;
  assert.equal(bebat.find((e) => e.obligation === 'OPTIONAL_SERVICE').requirement, 'RECOMMENDED'); assert.equal(bebat.find((e) => e.obligation === 'LEGAL').requirement, 'REQUIRED');
});

// ---- verdict materiality + freshness -----------------------------------------------------------------------------------------------------------------------------------------
const chargerOk = [...cat('USB charger', 'usb_charger', { 'electrical.present': true }, { 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...docsFor.charger('M-1')];
test('only applicable MATERIAL rules influence the product verdict: an unverified administrative rule is listed but never caps the verdict', () => {
  const a = run(build(chargerOk), undefined, { rulebook: RULEBOOK.map((r) => ({ ...r })) });
  assert.ok(RULEBOOK.every((r) => ['PRODUCT_COMPLIANCE', 'OPERATOR_ADMIN', 'CHANNEL'].includes(r.materiality)));
  const adminUnverified = a.rules.results.filter((r) => r.status === 'APPLIES' && r.materiality === 'OPERATOR_ADMIN' && REVIEW_BLOCKING.includes(r.review.status));
  assert.ok(adminUnverified.length > 0, 'be.packaging (INCOMPLETE) applies to every product');
  assert.ok(a.decision.adminObligations.length > 0); assert.ok(a.decision.adminObligations.every((o) => o.materiality === 'OPERATOR_ADMIN'));
  const material = a.decision.rulebookReview.unreviewedApplicable; assert.ok(material.every((m) => byId[m.ruleId].materiality === 'PRODUCT_COMPLIANCE'));
  // a charger: LVD is PRIMARY_TEXT_ONLY and not blocking; every material applicable rule is verified enough -> GREEN is possible and GO is reachable on the real rulebook
  assert.equal(material.length, 0, JSON.stringify(material)); assert.equal(a.decision.dimensions.marketability, 'GREEN'); assert.equal(a.decision.verdict, 'GO', JSON.stringify(a.decision.conditions));
});

test('a material applicable rule that is NEEDS_EXPERT_REVIEW / INCOMPLETE / UNVERIFIED (or whose review is stale) keeps GREEN and GO away, with an explicit reason', () => {
  const pb = [...cat('Power bank', 'power_bank', { 'electrical.present': true, 'battery.present': true }, { 'battery.chemistry': 'li_ion', 'electrical.maxVoltageAc': 0, 'electrical.maxVoltageDc': 5 }), ...docsFor.powerbank('M-1')];
  const a = run(build(pb)); assert.notEqual(a.decision.dimensions.marketability, 'GREEN'); assert.equal(a.decision.verdict, 'CONDITIONAL_GO');
  assert.ok(a.decision.rulebookReview.unreviewedApplicable.some((m) => m.ruleId === 'eu.batteries' && m.status === 'NEEDS_EXPERT_REVIEW'));
  assert.ok(a.decision.conditions.some((c) => /rulebook not yet verified/.test(c) && /BATTERIES/.test(c)));
  const stale = run(build(chargerOk), undefined, {}); assert.equal(stale.decision.verdict, 'GO');
  const later = assess(build(chargerOk), { now: new Date('2027-06-01T00:00:00Z'), externals: { safety: { alerts: [], source: { mode: 'LIVE_VERIFIED', fetchedAt: '2027-06-01T00:00:00Z', newestPublication: '2027-05-29' } } } });
  assert.notEqual(later.decision.verdict, 'GO', 'a review older than 180 days is no longer current'); assert.ok(later.decision.rulebookReview.unreviewedApplicable.some((m) => m.status === 'STALE_REVIEW'));
  assert.ok(later.decision.conditions.some((c) => /STALE_REVIEW/.test(c))); assert.equal(REVIEW_MAX_AGE_DAYS, 180);
});

test('source freshness: every source and review keeps source, official URL, instrument, article, checkedAt, consolidation and application dates', () => {
  for (const rule of RULEBOOK) {
    for (const s of rule.sources) { assert.ok(s.title && s.checkedAt && s.verification, `${rule.id}`); }
    assert.ok(rule.review.checkedAt && rule.review.instruments.every((i) => i.reference), rule.id);
  }
  const a = run(build(chargerOk)); const lvd = a.rules.results.find((r) => r.ruleId === 'eu.lvd'); assert.equal(lvd.review.instruments[0].consolidated, '2026-05-30'); assert.match(lvd.review.instruments[0].articles, /Art\. 1/);
  assert.ok(lvd.reviewFreshness && lvd.reviewFreshness.ageDays === 0 && lvd.reviewFreshness.status === 'FRESH');
});

// ---- phrasebook preservation ---------------------------------------------------------------------------------------------------------------------------------------------------
test('phrasebook (technical review only; linguistic review stays pending): model numbers, standards, regulation names and units survive verbatim, even with placeholder-looking text', () => {
  const nasty = ['PD-65/EU', 'GaN 65W {qty} $&', "BT-30 'A' \"B\"", 'X1 {model} {docEn}', 'Ω-50 V2.1 (EU)'];
  for (const model of nasty) {
    const c = build([...ident({ name: 'x', category: 'usb_charger', model: model.replace(/[^\w\-/ ]/g, 'X') }), ...traits({ 'electrical.present': true }), ...extraTraits({ 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 }), ...importer, ...commercial()]);
    c.identity = JSON.parse(JSON.stringify(c.identity)); c.identity.identifiers.model = model;
    const a = assess(c, { now: NOW });
    const qs = a.questions.filter((q) => q.docType);
    assert.ok(qs.length > 0); for (const q of qs) { assert.ok(q.en.includes(model), `${model} / ${q.id} (en)`); assert.ok(q.zh.includes(model), `${model} / ${q.id} (zh)`); assert.equal(/\{\w+\}/.test(q.en.replace(model, '')), false, 'no unfilled placeholder'); }
  }
  const a = run(build([...cat('USB charger', 'usb_charger', { 'electrical.present': true }, { 'electrical.mainsConnected': true, 'electrical.maxVoltageAc': 230 })]));
  const dq = a.questions.find((q) => q.id.startsWith('doc:EU_DOC')); assert.match(dq.en, /Directive 2014\/\d+\/EU/); assert.match(dq.zh, /Directive 2014\/\d+\/EU/);
  const price = a.questions.find((q) => q.id === 'price'); if (price) assert.match(price.zh, /MOQ/);
  assert.match(a.supplierSheet.note.zh, /Chinese|中文/);
});

// ---- customs adapter contract ----------------------------------------------------------------------------------------------------------------------------------------------------
test('customs: the future official-lookup adapter contract is explicit; a lookup cannot confirm a code on its own and never picks the cheapest', () => {
  assert.equal(CUSTOMS_LOOKUP_CONTRACT.source, 'EU TARIC / EBTI (official)'); assert.ok(CUSTOMS_LOOKUP_CONTRACT.mustNot.includes('select a code because its duty is lower'));
  const good = { source: 'TARIC', retrievedAt: '2026-10-03T10:00:00Z', origin: 'CN', goodsCode: '8507600010', validFrom: '2026-01-01', measures: [{ type: 'Third country duty', ratePct: 2.7, validFrom: '2026-01-01', additionalCode: null }], candidates: [{ code: '8507600010', description: 'x', confidence: 'MEDIUM' }] };
  assert.equal(validateLookupResult(good).ok, true);
  assert.equal(validateLookupResult({ ...good, origin: undefined }).ok, false); assert.equal(validateLookupResult({ ...good, measures: [{ type: 'duty' }] }).ok, false);
  const picks = validateLookupResult({ ...good, chosenCode: '8507600010', candidates: [{ code: '1', confidence: 'LOW' }, { code: '2', confidence: 'LOW' }] }); assert.equal(picks.ok, false); assert.match(picks.errors.join(' '), /cannot choose/);
  assert.equal(validateLookupResult({ ...good, candidates: [] }).ok, false);
});
