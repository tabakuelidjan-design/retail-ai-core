import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, applyCategory, addEvidence } from '../src/sourcing/core/identity.js';
import { evaluateRules } from '../src/sourcing/core/rules-engine.js';
import { economicOperator } from '../src/sourcing/core/operator.js';
import { RULEBOOK } from '../src/sourcing/core/rulebook/index.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const ctx = (role, channels = ['own_site']) => ({ market: 'EU-BE', channels, consumerSales: true, role });
const run = (identity, role = economicOperator({ underOwnNameOrBrand: false, manufacturerEstablishedInEU: false }), channels, docs = []) => evaluateRules({ identity, context: ctx(role, channels), rulebook: RULEBOOK, docs, now: NOW });
const by = (r, id) => r.results.find((x) => x.ruleId === id);
const withCat = (c) => applyCategory(createIdentity({ workingName: c }), c);

test('household item: CE not applicable, GPSR applies, no electrical regimes', () => {
  const r = run(withCat('household_general'));
  assert.equal(r.ce.status, 'CE_NOT_APPLICABLE');
  assert.equal(by(r, 'eu.gpsr').status, 'APPLIES');
  for (const id of ['eu.lvd', 'eu.emc', 'eu.red', 'eu.rohs', 'eu.batteries', 'eu.weee', 'eu.toys']) assert.equal(by(r, id).status, 'NOT_APPLICABLE', id);
});

test('mains USB charger: LVD + EMC + RoHS + WEEE apply, RED does not', () => {
  const r = run(withCat('usb_charger'));
  assert.equal(r.ce.status, 'CE_REQUIRED');
  for (const id of ['eu.lvd', 'eu.emc', 'eu.rohs', 'eu.weee', 'be.recupel']) assert.equal(by(r, id).status, 'APPLIES', id);
  assert.equal(by(r, 'eu.red').status, 'NOT_APPLICABLE');
  assert.ok(r.expectedStandardFamilies.includes('LVD'));
});

test('power bank: LVD not applicable at 5 V DC, batteries + UN 38.3 apply, missing documents listed', () => {
  const r = run(withCat('power_bank'));
  assert.equal(by(r, 'eu.lvd').status, 'NOT_APPLICABLE');
  assert.equal(by(r, 'eu.batteries').status, 'APPLIES');
  assert.equal(by(r, 'transport.lithium').status, 'APPLIES');
  assert.ok(by(r, 'transport.lithium').missingEvidence.some((m) => m.docType === 'UN383'));
});

test('Bluetooth device: RED applies and replaces LVD and EMC; cybersecurity stays unresolved until connectivity is known', () => {
  const r = run(withCat('bluetooth_speaker'));
  assert.equal(by(r, 'eu.red').status, 'APPLIES');
  assert.equal(by(r, 'eu.lvd').status, 'NOT_APPLICABLE');
  assert.equal(by(r, 'eu.emc').status, 'NOT_APPLICABLE');
  assert.equal(by(r, 'eu.red_cyber').status, 'UNRESOLVED');
  assert.ok(by(r, 'eu.red_cyber').unknownReads.length > 0);
});

test('unknown product: CE applicability unresolved, never assumed', () => {
  const r = run(createIdentity({ workingName: 'mystery item' }));
  assert.equal(r.ce.status, 'CE_APPLICABILITY_UNRESOLVED');
  assert.equal(by(r, 'eu.lvd').status, 'UNRESOLVED');
});

test('amazon rules only when amazon is a target channel', () => {
  const id = withCat('power_bank');
  assert.equal(run(id).results.some((x) => x.ruleId.startsWith('amazon.')), false);
  const r = run(id, undefined, ['own_site', 'amazon']);
  assert.equal(by(r, 'amazon.dangerous_goods').status, 'APPLIES');
});

test('every result carries sources, freshness and a verification level', () => {
  const r = run(withCat('toy_plastic'));
  const t = by(r, 'eu.toys');
  assert.ok(t.sources.length >= 2 && t.ruleVersion);
  assert.ok(['FRESH', 'STALE', 'UNCHECKED'].includes(t.freshness));
  assert.ok(['VERIFIED_ON_OFFICIAL_PAGE', 'PARTLY_VERIFIED', 'UNVERIFIED_EXPERT_CHECK_NEEDED'].includes(t.sourceVerification));
  const stale = evaluateRules({ identity: withCat('toy_plastic'), context: ctx(economicOperator({})), rulebook: RULEBOOK, now: new Date('2027-10-03') });
  assert.equal(stale.results.find((x) => x.ruleId === 'eu.toys').freshness, 'STALE');
});

test('own brand turns on the manufacturer duties and keeps the HIGH warning', () => {
  const role = economicOperator({ underOwnNameOrBrand: true, manufacturerEstablishedInEU: false });
  assert.equal(role.warnings[0].severity, 'HIGH');
  assert.equal(role.ownBrand, true);
  const r = run(withCat('household_general'), role);
  assert.ok(by(r, 'eu.gpsr').requiredEvidence.some((e) => e.id === 'gpsr.risk_analysis' && e.requirement === 'REQUIRED'));
});

test('a document is PRESENT only when the right type covers the regulation and shows no concern', () => {
  const id = withCat('usb_charger');
  const docs = [{ id: 'd1', docType: 'EU_DOC', extraction: { directives: ['2014/35/EU', '2014/30/EU'], standards: [] }, inspection: { consistency: 'NO_ISSUE_FOUND' } }];
  const r = run(id, undefined, undefined, docs);
  assert.equal(by(r, 'eu.lvd').requiredEvidence.find((e) => e.id === 'lvd.doc').coverage.status, 'PRESENT');
  const bad = run(id, undefined, undefined, [{ ...docs[0], inspection: { consistency: 'INCONSISTENT' } }]);
  assert.equal(by(bad, 'eu.lvd').requiredEvidence.find((e) => e.id === 'lvd.doc').coverage.status, 'PRESENT_WITH_CONCERNS');
  const wrong = run(id, undefined, undefined, [{ ...docs[0], extraction: { directives: ['2009/48/EC'] } }]);
  assert.equal(by(wrong, 'eu.lvd').requiredEvidence.find((e) => e.id === 'lvd.doc').coverage.status, 'DOES_NOT_COVER_THIS_REGULATION');
});
