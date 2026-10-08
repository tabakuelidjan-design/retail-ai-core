import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as branding from '../src/branding/index.js';
import {
  GUARDIAN_OUTCOME,
  GUARDIAN_REASON,
  SNAPSHOT_SOURCE_KIND,
  SNAPSHOT_STATUS,
  approveBrandCore,
  approveBrandMemory,
  buildBrandContext,
  buildBrandIdentity,
  buildBrandCoreProposal,
  buildBrandMemoryDraft,
  evaluateBrandGuardian,
  fidelityGateObservation,
  normalizeBrandSnapshot,
  normalizeCandidateManifest,
  normalizeSemanticAssessment,
  proposeBrandCoreRevision,
  submitBrandMemoryForReview,
} from '../src/branding/index.js';
import { evaluateHardFidelityGate } from '../src/creative-fidelity/fidelity-gates.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const tenant = (merchantId = M1) => ({ merchantId, source: 'env' });
const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const brandOf = (brandId, name) => buildBrandIdentity({
  tenant: tenant(), brandId, name, createdAt: '2026-10-01T09:00:00Z', defaultLocale: 'fr-BE', supportedLocales: ['fr-BE', 'nl-BE'],
});
const brand = () => brandOf(B1, 'House Brand');
const actor = (merchantId = M1) => ({ user_id: 'user-owner-1', role: 'OWNER', merchant_id: merchantId });
const EVALUATED_AT = '2026-10-08T12:00:00Z';

// ------------------------------------------------------------------ fixtures (real Core -> Memory -> Context flow)
const snapshot = (status = SNAPSHOT_STATUS.READY) => normalizeBrandSnapshot({
  id: 'snapshot-1', merchant_id: M1, brand_id: B1, version: 1, status,
  created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
  evidence: [{
    id: 'e1', provenance: 'observed', statement: 'Observed', completeness: 'COMPLETE',
    source: { system: 'internal', observed_at: '2026-10-08T08:00:00Z', kind: SNAPSHOT_SOURCE_KIND.INTERNAL_FACT },
  }],
});
const decisions = () => ({
  category: 'category', buying_contexts: ['context'], value_proposition: 'Value', positioning: 'Position',
  core_promise: 'Promise', reasons_to_believe: ['Reason'], personality: ['clear'],
  voice: { traits: ['clear'], do: ['be specific'], dont: ['invent'] }, exclusions: ['do not mislead'],
  distinctive_assets: [], evidence_refs: ['e1'],
});
const approveCore = (proposal, activeCore = null) => approveBrandCore({
  proposal, snapshot: snapshot(), tenant: tenant(), brand: brand(), resolvedActor: actor(), activeCore, approvedAt: '2026-10-08T10:30:00Z',
}).approvedCore;
const coreV1 = () => approveCore(buildBrandCoreProposal({
  id: 'core-v1', tenant: tenant(), brand: brand(), createdAt: '2026-10-08T10:00:00Z', snapshot: snapshot(), decisions: decisions(),
}).core);
const coreV2 = (v1) => approveCore(proposeBrandCoreRevision({
  approvedCore: v1, snapshot: snapshot(), tenant: tenant(), brand: brand(), id: 'core-v2', createdAt: '2026-10-08T11:00:00Z',
  changes: { positioning: 'Updated' },
}).core, v1);

const rule = (over = {}) => ({
  id: 'r1', rule_type: 'COLOR', subject: 'logo.color', operator: 'EQUALS', value: '#112233',
  severity: 'BLOCK', scope: 'GLOBAL', source_ref: 'brand-core://core-v1', ...over,
});
const memoryFor = (core, rules, { approve = true } = {}) => {
  const draft = buildBrandMemoryDraft({
    tenant: tenant(), brand: brand(), id: 'mem-v1', createdAt: '2026-10-08T12:00:00Z', core,
    content: { hard_rules: rules, design_tokens: { colors: { primary: '#112233' } } },
  }).memory;
  const reviewed = submitBrandMemoryForReview({ memory: draft, core, tenant: tenant(), brand: brand() });
  if (!approve) return reviewed;
  return approveBrandMemory({
    memory: reviewed, core, tenant: tenant(), brand: brand(), resolvedActor: actor(), approvedAt: '2026-10-08T13:00:00Z',
  }).approvedMemory;
};
const contextFor = (rules, { snapshotStatus } = {}) => {
  const core = coreV1();
  return buildBrandContext({
    tenant: tenant(), brand: brand(), core, memory: memoryFor(core, rules), snapshot: snapshotStatus ? snapshot(snapshotStatus) : null,
  });
};

const obs = (subject, coverage, values = [], evidence_refs = []) => ({ subject, coverage, values, evidence_refs });
const gate = (coverage, status = null, evidence_refs = []) => ({ subject: 'product_fidelity', coverage, status, evidence_refs });
const manifest = (content_kind, channels = {}) => ({ content_kind, ...channels });

const run = (rules, candidateManifest, extra = {}) => evaluateBrandGuardian({
  tenant: tenant(), brandContext: contextFor(rules), candidateManifest, targetRef: 'creative://asset-1',
  evaluatedAt: EVALUATED_AT, ...extra,
});
// outcome of the single rule of a one-rule Memory
const one = (r, candidateManifest) => {
  const report = run([r], candidateManifest);
  return { outcome: report.rule_results[0].outcome, reason: report.rule_results[0].reason, report };
};

const gateRule = (over = {}) => rule({
  id: 'g1', rule_type: 'EXTERNAL_GATE', subject: 'product_fidelity', operator: 'STATUS_IN', value: ['PASS'],
  source_ref: 'external-policy://creative-fidelity', ...over,
});
const reqRule = (over = {}) => rule({ id: 'q1', rule_type: 'ASSET_REF', subject: 'logo', operator: 'REQUIRED', value: true, ...over });
const textRule = (operator, value, over = {}) => rule({ id: 't1', rule_type: 'TEXT', subject: 'body', operator, value, ...over });

// ------------------------------------------------------------------ Manifest (1-12)
test('1. unknown manifest and observation fields are refused (no raw media)', () => {
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'TEXT', raw_media: 'AAAA' }), /not part of the candidate manifest/);
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'TEXT', assets: [{ ...obs('a', 'COMPLETE'), pixels: [] }] }), /not part of the candidate manifest/);
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'TEXT', external_gates: [{ ...gate('COMPLETE', 'PASS'), values: [] }] }), /not part of the candidate manifest/);
});

test('2. an invalid or missing content_kind is refused', () => {
  for (const content_kind of ['GLOBAL', 'tweet', undefined, null]) {
    assert.throws(() => normalizeCandidateManifest({ content_kind }), /content_kind/);
  }
});

test('3. an invalid or missing coverage is refused (exactly COMPLETE / PARTIAL / UNAVAILABLE)', () => {
  assert.deepEqual(Object.values(branding.OBSERVATION_COVERAGE), ['COMPLETE', 'PARTIAL', 'UNAVAILABLE']);
  for (const coverage of ['FULL', 'complete', 0.9, undefined]) {
    assert.throws(() => normalizeCandidateManifest({ content_kind: 'TEXT', text: [obs('body', coverage)] }), /coverage/);
  }
});

test('4. an empty subject is refused', () => {
  for (const subject of ['', '  ', undefined]) {
    assert.throws(() => normalizeCandidateManifest({ content_kind: 'TEXT', text: [obs(subject, 'COMPLETE')] }), /subject/);
  }
});

test('5. a subject appears once per channel (values go in values[]); the same subject may exist in two channels', () => {
  assert.throws(
    () => normalizeCandidateManifest({ content_kind: 'IMAGE', colors: [obs('logo', 'COMPLETE', ['#112233']), obs('logo', 'PARTIAL', ['#FFFFFF'])] }),
    /lists the same subject twice/,
  );
  const ok = normalizeCandidateManifest({
    content_kind: 'IMAGE',
    colors: [obs('logo', 'COMPLETE', ['#112233', '#ffffff'])],
    assets: [obs('logo', 'COMPLETE', ['asset://logo'])],
  });
  assert.deepEqual(ok.colors[0].values, ['#112233', '#FFFFFF']);
});

test('6. an invalid asset ref is refused', () => {
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', assets: [obs('logo', 'COMPLETE', ['my logo.png'])] }), /opaque/);
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', assets: [obs('logo', 'COMPLETE', ['asset://a', 'asset://a'])] }), /duplicates/);
});

test('7. an invalid color is refused', () => {
  for (const bad of ['red', '#12', '#GGGGGG', '112233']) {
    assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', colors: [obs('logo', 'COMPLETE', [bad])] }), /hex/);
  }
});

test('8. an empty typography family is refused', () => {
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', typography: [obs('heading', 'COMPLETE', [' '])] }), /values\[0\]/);
});

test('9. an invalid claim ref is refused', () => {
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'TEXT', claims: [obs('price', 'COMPLETE', ['cheapest'])] }), /claim:\/\//);
});

test('10. an unknown external gate is refused', () => {
  assert.throws(() => normalizeCandidateManifest({
    content_kind: 'IMAGE', external_gates: [{ subject: 'brand_elegance', coverage: 'COMPLETE', status: 'PASS', evidence_refs: [] }],
  }), /not a known external gate/);
});

test('11. an invalid gate status is refused; COMPLETE needs a status; UNAVAILABLE cannot carry values or a status', () => {
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', external_gates: [gate('COMPLETE', 'GREAT')] }), /unknown to gate/);
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', external_gates: [gate('COMPLETE', null)] }), /needs a status/);
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', external_gates: [gate('UNAVAILABLE', 'PASS')] }), /cannot carry a status/);
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', colors: [obs('logo', 'UNAVAILABLE', ['#112233'])] }), /cannot carry values/);
});

test('12. the manifest is deeply frozen, and omitted channels are empty (no observation at all)', () => {
  const m = normalizeCandidateManifest({ content_kind: 'TEXT', text: [obs('body', 'COMPLETE', ['hello'], ['ev://1'])] });
  assert.equal(Object.isFrozen(m), true);
  assert.equal(Object.isFrozen(m.text[0].values), true);
  assert.throws(() => { m.text[0].values.push('x'); }, TypeError);
  assert.throws(() => { m.text[0].coverage = 'PARTIAL'; }, TypeError);
  assert.deepEqual(m.assets, []);
  assert.deepEqual(m.external_gates, []);
});

// ------------------------------------------------------------------ Coverage (13-20)
const img = (channels) => manifest('IMAGE', channels);

test('13. COMPLETE + absence + REQUIRED is a violation (FAIL with a BLOCK rule)', () => {
  const r = one(reqRule(), img({ assets: [obs('logo', 'COMPLETE', [])] }));
  assert.equal(r.outcome, 'FAIL');
  assert.equal(r.reason, GUARDIAN_REASON.REQUIRED_VALUE_MISSING);
});

test('14. PARTIAL + absence + REQUIRED is NOT_MEASURABLE', () => {
  const r = one(reqRule(), img({ assets: [obs('logo', 'PARTIAL', [])] }));
  assert.equal(r.outcome, 'NOT_MEASURABLE');
  assert.equal(r.reason, GUARDIAN_REASON.MEASUREMENT_PARTIAL);
});

test('15. PARTIAL + presence + REQUIRED is PASS', () => {
  const r = one(reqRule(), img({ assets: [obs('logo', 'PARTIAL', ['asset://logo'])] }));
  assert.equal(r.outcome, 'PASS');
  assert.equal(r.reason, GUARDIAN_REASON.RULE_PASSED);
});

test('16. UNAVAILABLE is always NOT_MEASURABLE', () => {
  for (const r of [reqRule(), rule(), rule({ operator: 'ONE_OF', value: ['#112233', '#FFFFFF'] })]) {
    const cats = { ASSET_REF: 'assets', COLOR: 'colors' };
    const out = one(r, img({ [cats[r.rule_type]]: [obs(r.subject, 'UNAVAILABLE')] }));
    assert.equal(out.outcome, 'NOT_MEASURABLE', r.operator);
    assert.equal(out.reason, GUARDIAN_REASON.MEASUREMENT_UNAVAILABLE);
  }
});

test('17. PARTIAL cannot prove EQUALS (all seen values conform, or none seen)', () => {
  for (const values of [['#112233'], []]) {
    const r = one(rule(), img({ colors: [obs('logo.color', 'PARTIAL', values)] }));
    assert.equal(r.outcome, 'NOT_MEASURABLE');
    assert.equal(r.reason, GUARDIAN_REASON.MEASUREMENT_PARTIAL);
  }
});

test('18. PARTIAL can prove an EQUALS violation', () => {
  const r = one(rule(), img({ colors: [obs('logo.color', 'PARTIAL', ['#112233', '#AABBCC'])] }));
  assert.equal(r.outcome, 'FAIL');
  assert.equal(r.reason, GUARDIAN_REASON.OBSERVED_VALUE_MISMATCH);
  assert.match(r.report.rule_results[0].observed_summary, /offending=#AABBCC/);
});

test('19. PARTIAL cannot prove ONE_OF', () => {
  const r = one(rule({ operator: 'ONE_OF', value: ['#112233', '#FFFFFF'] }), img({ colors: [obs('logo.color', 'PARTIAL', ['#112233'])] }));
  assert.equal(r.outcome, 'NOT_MEASURABLE');
});

test('20. PARTIAL can prove a ONE_OF violation', () => {
  const r = one(rule({ operator: 'ONE_OF', value: ['#112233', '#FFFFFF'] }), img({ colors: [obs('logo.color', 'PARTIAL', ['#AABBCC'])] }));
  assert.equal(r.outcome, 'FAIL');
  assert.equal(r.reason, GUARDIAN_REASON.OBSERVED_VALUE_NOT_ALLOWED);
});

test('COMPLETE EQUALS / ONE_OF: conforming values pass, no value or a foreign value fails', () => {
  const eq = rule();
  assert.equal(one(eq, img({ colors: [obs('logo.color', 'COMPLETE', ['#112233'])] })).outcome, 'PASS');
  assert.equal(one(eq, img({ colors: [obs('logo.color', 'COMPLETE', [])] })).outcome, 'FAIL');
  assert.equal(one(eq, img({ colors: [obs('logo.color', 'COMPLETE', ['#112233', '#FFFFFF'])] })).outcome, 'FAIL');
  const oneOf = rule({ operator: 'ONE_OF', value: ['#112233', '#FFFFFF'] });
  assert.equal(one(oneOf, img({ colors: [obs('logo.color', 'COMPLETE', ['#112233', '#FFFFFF'])] })).outcome, 'PASS');
  assert.equal(one(oneOf, img({ colors: [obs('logo.color', 'COMPLETE', [])] })).outcome, 'FAIL');
  assert.equal(one(oneOf, img({ colors: [obs('logo.color', 'COMPLETE', ['#112233', '#000000'])] })).outcome, 'FAIL');
});

test('absence after a complete measurement is NOT the same as no measurement at all', () => {
  const measuredAbsent = one(reqRule(), img({ assets: [obs('logo', 'COMPLETE', [])] }));
  const neverMeasured = one(reqRule(), img({}));
  assert.equal(measuredAbsent.outcome, 'FAIL');
  assert.equal(neverMeasured.outcome, 'NOT_MEASURABLE');
  assert.equal(neverMeasured.reason, GUARDIAN_REASON.OBSERVATION_NOT_PROVIDED);
  assert.equal(neverMeasured.report.rule_results[0].observed_summary, 'no observation');
});

test('subjects match exactly (case-sensitive, no fuzzy matching): another or near-identical subject is not an observation', () => {
  for (const subject of ['logo.colour', 'Logo.color', 'logo', 'background.color']) {
    const r = one(rule(), img({ colors: [obs(subject, 'COMPLETE', ['#112233'])] }));
    assert.equal(r.outcome, 'NOT_MEASURABLE', subject);
    assert.equal(r.reason, GUARDIAN_REASON.OBSERVATION_NOT_PROVIDED);
  }
});

test('typography, claims and assets use the same exact-value semantics through their own channel', () => {
  const typo = rule({ id: 'ty', rule_type: 'TYPOGRAPHY', subject: 'heading', value: 'Example Sans' });
  assert.equal(one(typo, img({ typography: [obs('heading', 'COMPLETE', ['Example Sans'])] })).outcome, 'PASS');
  assert.equal(one(typo, img({ typography: [obs('heading', 'COMPLETE', ['Comic Sans'])] })).outcome, 'FAIL');
  const claim = rule({ id: 'cl', rule_type: 'CLAIM_REF', subject: 'price', operator: 'ONE_OF', value: ['claim://a', 'claim://b'], source_ref: 'claim://a' });
  assert.equal(one(claim, manifest('TEXT', { claims: [obs('price', 'COMPLETE', ['claim://b'])] })).outcome, 'PASS');
  assert.equal(one(claim, manifest('TEXT', { claims: [obs('price', 'COMPLETE', ['claim://z'])] })).outcome, 'FAIL');
  // a color observation never answers a typography rule
  assert.equal(one(typo, img({ colors: [obs('heading', 'COMPLETE', ['#112233'])] })).reason, GUARDIAN_REASON.OBSERVATION_NOT_PROVIDED);
});

// ------------------------------------------------------------------ Text (21-28)
const txt = (coverage, ...fragments) => manifest('TEXT', { text: [obs('body', coverage, fragments)] });

test('21. COMPLETE + CONTAINS found -> PASS', () => {
  assert.equal(one(textRule('CONTAINS', 'free shipping'), txt('COMPLETE', 'Enjoy free shipping today')).outcome, 'PASS');
});
test('22. COMPLETE + CONTAINS absent -> violation (FAIL, or REVIEW_REQUIRED for a REVIEW rule)', () => {
  const r = one(textRule('CONTAINS', 'free shipping'), txt('COMPLETE', 'Hello'));
  assert.equal(r.outcome, 'FAIL');
  assert.equal(r.reason, GUARDIAN_REASON.REQUIRED_TEXT_MISSING);
  assert.equal(one(textRule('CONTAINS', 'free shipping', { severity: 'REVIEW' }), txt('COMPLETE', 'Hello')).outcome, 'REVIEW_REQUIRED');
});
test('23. PARTIAL + CONTAINS found -> PASS', () => {
  assert.equal(one(textRule('CONTAINS', 'free shipping'), txt('PARTIAL', 'free shipping')).outcome, 'PASS');
});
test('24. PARTIAL + CONTAINS absent -> NOT_MEASURABLE', () => {
  const r = one(textRule('CONTAINS', 'free shipping'), txt('PARTIAL', 'Hello'));
  assert.equal(r.outcome, 'NOT_MEASURABLE');
  assert.equal(r.reason, GUARDIAN_REASON.MEASUREMENT_PARTIAL);
});
test('25. COMPLETE + NOT_CONTAINS absent -> PASS', () => {
  assert.equal(one(textRule('NOT_CONTAINS', 'cheapest'), txt('COMPLETE', 'Hello')).outcome, 'PASS');
  assert.equal(one(textRule('NOT_CONTAINS', 'cheapest'), txt('COMPLETE')).outcome, 'PASS', 'a complete measurement of no text');
});
test('26. COMPLETE + NOT_CONTAINS found -> violation', () => {
  const r = one(textRule('NOT_CONTAINS', 'cheapest'), txt('COMPLETE', 'The cheapest ever'));
  assert.equal(r.outcome, 'FAIL');
  assert.equal(r.reason, GUARDIAN_REASON.FORBIDDEN_TEXT_FOUND);
  assert.equal(one(textRule('NOT_CONTAINS', 'cheapest', { severity: 'REVIEW' }), txt('COMPLETE', 'cheapest')).outcome, 'REVIEW_REQUIRED');
});
test('27. PARTIAL + NOT_CONTAINS absent -> NOT_MEASURABLE (a partial reading cannot prove absence)', () => {
  assert.equal(one(textRule('NOT_CONTAINS', 'cheapest'), txt('PARTIAL', 'Hello')).outcome, 'NOT_MEASURABLE');
});
test('28. PARTIAL + NOT_CONTAINS found -> violation', () => {
  assert.equal(one(textRule('NOT_CONTAINS', 'cheapest'), txt('PARTIAL', 'so cheapest')).outcome, 'FAIL');
});

test('text matching concatenates only fragments of the SAME subject, after one shared normalization', () => {
  const rules = [textRule('CONTAINS', 'free shipping')];
  const m = manifest('TEXT', { text: [obs('body', 'COMPLETE', ['Enjoy FREE', '  shipping  now']), obs('footer', 'COMPLETE', ['free shipping'])] });
  assert.equal(one(rules[0], m).outcome, 'PASS', 'case-insensitive, whitespace-collapsed, fragments of one subject joined');
  const other = manifest('TEXT', { text: [obs('body', 'COMPLETE', ['Hello']), obs('footer', 'COMPLETE', ['free shipping'])] });
  assert.equal(one(rules[0], other).outcome, 'FAIL', 'a fragment of another subject never counts');
  assert.equal(one(textRule('REQUIRED', true), txt('COMPLETE', 'x')).outcome, 'PASS');
  assert.equal(one(textRule('REQUIRED', true), txt('COMPLETE')).outcome, 'FAIL');
});

// ------------------------------------------------------------------ Severity (29-32)
test('29. BLOCK + violation -> FAIL', () => {
  assert.equal(one(rule({ severity: 'BLOCK' }), img({ colors: [obs('logo.color', 'COMPLETE', ['#000000'])] })).outcome, 'FAIL');
});
test('30. REVIEW + violation -> REVIEW_REQUIRED', () => {
  assert.equal(one(rule({ severity: 'REVIEW' }), img({ colors: [obs('logo.color', 'COMPLETE', ['#000000'])] })).outcome, 'REVIEW_REQUIRED');
});
test('31. PASS stays PASS with BLOCK (and REVIEW)', () => {
  for (const severity of ['BLOCK', 'REVIEW']) {
    assert.equal(one(rule({ severity }), img({ colors: [obs('logo.color', 'COMPLETE', ['#112233'])] })).outcome, 'PASS');
  }
});
test('32. NOT_MEASURABLE stays NOT_MEASURABLE with BLOCK (and REVIEW)', () => {
  for (const severity of ['BLOCK', 'REVIEW']) {
    assert.equal(one(rule({ severity }), img({ colors: [obs('logo.color', 'PARTIAL', [])] })).outcome, 'NOT_MEASURABLE');
  }
});

// ------------------------------------------------------------------ Scope (33-37)
test('33. a GLOBAL rule applies to every content kind', () => {
  for (const kind of ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']) {
    const report = run([rule()], manifest(kind, { colors: [obs('logo.color', 'COMPLETE', ['#112233'])] }));
    assert.equal(report.rule_results.length, 1, kind);
    assert.deepEqual(report.not_applicable_rule_ids, []);
  }
});
test('34. an IMAGE rule applies to an IMAGE', () => {
  const report = run([rule({ scope: 'IMAGE' })], img({ colors: [obs('logo.color', 'COMPLETE', ['#112233'])] }));
  assert.equal(report.rule_results.length, 1);
  assert.equal(report.outcome, 'PASS');
});
test('35. an IMAGE rule is not applicable to TEXT', () => {
  const report = run([rule({ scope: 'IMAGE' }), textRule('NOT_CONTAINS', 'cheapest')], txt('COMPLETE', 'Hello'));
  assert.deepEqual(report.rule_results.map((r) => r.rule_id), ['t1']);
  assert.deepEqual(report.not_applicable_rule_ids, ['r1']);
});
test('36. a non-applicable rule never lowers the result', () => {
  const report = run([rule({ scope: 'IMAGE' }), textRule('NOT_CONTAINS', 'cheapest')], txt('COMPLETE', 'Hello'));
  assert.equal(report.hard_outcome, 'PASS');
  assert.equal(report.outcome, 'PASS');
});
test('37. zero applicable rule -> NOT_MEASURABLE with NO_APPLICABLE_HARD_RULES (never "compliant")', () => {
  const report = run([rule({ scope: 'IMAGE' })], txt('COMPLETE', 'Hello'));
  assert.equal(report.rule_results.length, 0);
  assert.equal(report.hard_outcome, 'NOT_MEASURABLE');
  assert.equal(report.hard_outcome_reason, GUARDIAN_REASON.NO_APPLICABLE_HARD_RULES);
  assert.equal(report.outcome, 'NOT_MEASURABLE');
});

// ------------------------------------------------------------------ External gate (38-43)
test('38. product_fidelity with an allowed status -> PASS', () => {
  const r = one(gateRule(), img({ external_gates: [gate('COMPLETE', 'PASS', ['fidelity://run-1'])] }));
  assert.equal(r.outcome, 'PASS');
  assert.deepEqual(r.report.rule_results[0].evidence_refs, ['fidelity://run-1']);
});

test('39. product_fidelity with a status outside STATUS_IN -> FAIL (REVIEW_REQUIRED for a REVIEW rule)', () => {
  const r = one(gateRule(), img({ external_gates: [gate('COMPLETE', 'FAIL')] }));
  assert.equal(r.outcome, 'FAIL');
  assert.equal(r.reason, GUARDIAN_REASON.EXTERNAL_GATE_STATUS_NOT_ALLOWED);
  assert.equal(one(gateRule({ severity: 'REVIEW' }), img({ external_gates: [gate('COMPLETE', 'FAIL')] })).outcome, 'REVIEW_REQUIRED');
});

test('40. an absent, unavailable or unmeasurable gate is NOT_MEASURABLE, never a brand violation', () => {
  for (const external_gates of [[], [gate('UNAVAILABLE')], [gate('COMPLETE', 'NOT_MEASURABLE')]]) {
    for (const r of [gateRule(), gateRule({ operator: 'REQUIRED', value: true })]) {
      const out = one(r, img({ external_gates }));
      assert.equal(out.outcome, 'NOT_MEASURABLE', JSON.stringify(external_gates));
      assert.equal(out.reason, GUARDIAN_REASON.EXTERNAL_GATE_NOT_MEASURED);
    }
  }
  assert.equal(one(gateRule({ operator: 'REQUIRED', value: true }), img({ external_gates: [gate('COMPLETE', 'FAIL')] })).outcome, 'PASS', 'REQUIRED only asks for a usable result');
  assert.equal(one(gateRule(), img({ external_gates: [gate('PARTIAL', 'PASS')] })).outcome, 'NOT_MEASURABLE', 'a partial gate cannot prove compliance');
  assert.equal(one(gateRule(), img({ external_gates: [gate('PARTIAL', 'FAIL')] })).outcome, 'FAIL', 'but it can prove a violation');
});

test('41. an unknown gate is refused by the manifest (so it can never reach a rule)', () => {
  assert.throws(() => normalizeCandidateManifest(img({ external_gates: [{ subject: 'looks_premium', coverage: 'COMPLETE', status: 'PASS', evidence_refs: [] }] })), /known external gate/);
});

test('42. Guardian never recomputes creative-fidelity; it only reads a status', async () => {
  for (const file of ['guardian.js', 'candidate-manifest.js']) {
    const source = await readFile(`src/branding/${file}`, 'utf8');
    // neither imports nor calls the product-fidelity engine (a doc comment may name it)
    assert.equal(/evaluateHardFidelityGate\(|from '[^']*fidelity-gates/.test(source), false, file);
  }
  // identical status, different "evidence": the verdict depends on the status alone
  const a = one(gateRule(), img({ external_gates: [gate('COMPLETE', 'PASS', ['x://1'])] })).outcome;
  const b = one(gateRule(), img({ external_gates: [gate('COMPLETE', 'PASS', ['y://2', 'y://3'])] })).outcome;
  assert.equal(a, b);
});

test('43. the creative-fidelity adapter feeds the manifest and the gate rule', () => {
  const pass = evaluateHardFidelityGate({ requiredChecks: ['PRODUCT_IDENTITY'], observations: [{ code: 'PRODUCT_IDENTITY', outcome: 'PASS' }] });
  const fail = evaluateHardFidelityGate({
    requiredChecks: ['PRODUCT_IDENTITY', 'LOGO'], observations: [{ code: 'PRODUCT_IDENTITY', outcome: 'PASS' }, { code: 'LOGO', outcome: 'FAIL' }],
  });
  const failPartial = evaluateHardFidelityGate({
    requiredChecks: ['PRODUCT_IDENTITY', 'LOGO', 'TEXT'], observations: [{ code: 'LOGO', outcome: 'FAIL' }],
  });
  const unmeasured = evaluateHardFidelityGate({ requiredChecks: ['PRODUCT_IDENTITY'], observations: [] });

  assert.deepEqual(fidelityGateObservation({ gate: pass, evidenceRefs: ['fidelity://1'] }),
    { subject: 'product_fidelity', coverage: 'COMPLETE', status: 'PASS', evidence_refs: ['fidelity://1'] });
  assert.equal(fidelityGateObservation({ gate: fail }).coverage, 'COMPLETE');
  assert.equal(fidelityGateObservation({ gate: failPartial }).coverage, 'PARTIAL');
  assert.equal(fidelityGateObservation({ gate: unmeasured }).coverage, 'UNAVAILABLE');
  assert.equal(fidelityGateObservation({ gate: unmeasured }).status, null);

  const outcomes = [pass, fail, failPartial, unmeasured].map((g) => one(gateRule(), img({ external_gates: [fidelityGateObservation({ gate: g })] })).outcome);
  assert.deepEqual(outcomes, ['PASS', 'FAIL', 'FAIL', 'NOT_MEASURABLE']);
});

// ------------------------------------------------------------------ Brand context (44-49)
const candidate = img({ colors: [obs('logo.color', 'COMPLETE', ['#112233'])] });
const evaluateWith = (brandContext, extra = {}) => evaluateBrandGuardian({
  tenant: tenant(), brandContext, candidateManifest: candidate, targetRef: 'creative://asset-1', evaluatedAt: EVALUATED_AT, ...extra,
});

test('44. a GATED Brand Context is refused', () => {
  const gated = buildBrandContext({ tenant: tenant(), brand: brand(), core: coreV1(), memory: null });
  assert.equal(gated.status, 'GATED');
  assert.throws(() => evaluateWith(gated), /GUARDIAN_REQUIRES_READY_BRAND_CONTEXT.*BRAND_MEMORY_MISSING/);
});

test('45. a Memory that is not approved is refused through the Brand Context', () => {
  const core = coreV1();
  const context = buildBrandContext({ tenant: tenant(), brand: brand(), core, memory: memoryFor(core, [rule()], { approve: false }) });
  assert.throws(() => evaluateWith(context), /GUARDIAN_REQUIRES_READY_BRAND_CONTEXT.*BRAND_MEMORY_NOT_APPROVED/);
});

test('46. a tenant mismatch is refused', () => {
  assert.throws(() => evaluateBrandGuardian({
    tenant: tenant(M2), brandContext: contextFor([rule()]), candidateManifest: candidate, targetRef: 't', evaluatedAt: EVALUATED_AT,
  }), /GUARDIAN_REQUIRES_READY_BRAND_CONTEXT.*TENANT_MISMATCH/);
});

test('47. a Core/Memory mismatch is refused upstream, and a forged READY flag does not bypass it', () => {
  const v1 = coreV1();
  const memory = memoryFor(v1, [rule()]);
  const gated = buildBrandContext({ tenant: tenant(), brand: brand(), core: coreV2(v1), memory });
  assert.equal(gated.status, 'GATED');
  assert.throws(() => evaluateWith(gated), /BRAND_MEMORY_CORE_MISMATCH/);
  const forged = { status: 'READY', reasons: [], review_signals: [], core: coreV2(v1), memory };
  assert.throws(() => evaluateWith(forged), /GUARDIAN_REQUIRES_READY_BRAND_CONTEXT.*BRAND_MEMORY_CORE_MISMATCH/);
});

test('48. a STALE Snapshot with an otherwise READY context: Guardian works normally', () => {
  const context = contextFor([rule()], { snapshotStatus: SNAPSHOT_STATUS.STALE });
  assert.equal(context.status, 'READY');
  assert.equal(evaluateWith(context).outcome, 'PASS');
});

test('49. BRAND_SNAPSHOT_STALE is propagated without changing the outcome', () => {
  const stale = evaluateWith(contextFor([rule()], { snapshotStatus: SNAPSHOT_STATUS.STALE }));
  const fresh = evaluateWith(contextFor([rule()]));
  assert.deepEqual(stale.brand_review_signals, ['BRAND_SNAPSHOT_STALE']);
  assert.deepEqual(fresh.brand_review_signals, []);
  assert.equal(stale.outcome, fresh.outcome);
  assert.equal(stale.hard_outcome, fresh.hard_outcome);
  // a forged unknown signal is refused
  assert.throws(() => evaluateWith({ ...contextFor([rule()]), review_signals: ['ALL_GOOD'] }), /unknown signal/);
});

// ------------------------------------------------------------------ Semantic lane (50-55)
const semantic = (outcome, over = {}) => ({ outcome, method: 'MODEL', evidence_refs: ['model://run-1'], note: 'advisory', ...over });
const passingManifest = candidate;
const failingManifest = img({ colors: [obs('logo.color', 'COMPLETE', ['#000000'])] });
const unmeasuredManifest = img({});

test('50. a MODEL can never settle a hard rule', () => {
  // there is no per-rule check input any more: the old checks API is refused
  assert.throws(() => evaluateWith(contextFor([rule()]), { checks: [{ rule_id: 'r1', method: 'MODEL', outcome: 'PASS' }] }), /checks is not part of the Guardian input/);
  // a semantic assessment cannot name a rule
  assert.throws(() => normalizeSemanticAssessment({ ...semantic('PASS'), rule_id: 'r1' }), /not part of the semantic assessment contract/);
  // and a semantic PASS never rescues a hard rule that was not measured, nor a violation
  const ctx = contextFor([rule()]);
  const nm = evaluateWith(ctx, { semanticAssessment: semantic('PASS') });
  assert.equal(nm.outcome, 'PASS'); // candidate is conform here, for the control case
  const unmeasured = evaluateBrandGuardian({ tenant: tenant(), brandContext: ctx, candidateManifest: unmeasuredManifest, targetRef: 't', evaluatedAt: EVALUATED_AT, semanticAssessment: semantic('PASS') });
  assert.equal(unmeasured.outcome, 'NOT_MEASURABLE');
  const failed = evaluateBrandGuardian({ tenant: tenant(), brandContext: ctx, candidateManifest: failingManifest, targetRef: 't', evaluatedAt: EVALUATED_AT, semanticAssessment: semantic('PASS', { method: 'HUMAN' }) });
  assert.equal(failed.outcome, 'FAIL');
});

test('51. semantic PASS + hard PASS -> overall PASS', () => {
  const report = evaluateWith(contextFor([rule()]), { semanticAssessment: semantic('PASS') });
  assert.equal(report.hard_outcome, 'PASS');
  assert.equal(report.semantic_outcome, 'PASS');
  assert.equal(report.outcome, 'PASS');
});

test('52. semantic REVIEW_REQUIRED + hard PASS -> overall REVIEW_REQUIRED (hard stays PASS)', () => {
  const report = evaluateWith(contextFor([rule()]), { semanticAssessment: semantic('REVIEW_REQUIRED') });
  assert.equal(report.hard_outcome, 'PASS');
  assert.equal(report.outcome, 'REVIEW_REQUIRED');
});

test('53. semantic NOT_MEASURABLE + hard PASS -> overall PASS plus a Guardian review signal', () => {
  const report = evaluateWith(contextFor([rule()]), { semanticAssessment: semantic('NOT_MEASURABLE', { method: 'HUMAN' }) });
  assert.equal(report.hard_outcome, 'PASS');
  assert.equal(report.semantic_outcome, 'NOT_MEASURABLE');
  assert.equal(report.outcome, 'PASS');
  assert.deepEqual(report.guardian_review_signals, ['BRAND_SEMANTIC_NOT_MEASURABLE']);
});

test('54. a semantic FAIL is refused; method is MODEL or HUMAN only', () => {
  assert.throws(() => normalizeSemanticAssessment(semantic('FAIL')), /unsupported/);
  assert.throws(() => normalizeSemanticAssessment(semantic('PASS', { method: 'DETERMINISTIC' })), /unsupported/);
  assert.throws(() => evaluateWith(contextFor([rule()]), { semanticAssessment: semantic('FAIL') }), /unsupported/);
  assert.deepEqual(Object.values(branding.SEMANTIC_OUTCOME), ['PASS', 'REVIEW_REQUIRED', 'NOT_MEASURABLE']);
});

test('55. an absent semantic assessment does not prevent a hard PASS and changes nothing', () => {
  const report = evaluateWith(contextFor([rule()]));
  assert.equal(report.semantic_outcome, null);
  assert.equal(report.semantic_assessment, null);
  assert.deepEqual(report.guardian_review_signals, []);
  assert.equal(report.outcome, 'PASS');
});

test('a semantic assessment never lowers a hard failure or an unmeasured hard result', () => {
  const ctx = contextFor([rule()]);
  const hardFail = evaluateBrandGuardian({ tenant: tenant(), brandContext: ctx, candidateManifest: failingManifest, targetRef: 't', evaluatedAt: EVALUATED_AT, semanticAssessment: semantic('REVIEW_REQUIRED') });
  assert.equal(hardFail.outcome, 'FAIL');
  const hardNm = evaluateBrandGuardian({ tenant: tenant(), brandContext: ctx, candidateManifest: unmeasuredManifest, targetRef: 't', evaluatedAt: EVALUATED_AT, semanticAssessment: semantic('REVIEW_REQUIRED') });
  assert.equal(hardNm.outcome, 'NOT_MEASURABLE');
});

// ------------------------------------------------------------------ Report / authority (56-64)
const multiRules = () => [
  rule({ id: 'a', subject: 'logo.color' }),
  textRule('NOT_CONTAINS', 'cheapest', { id: 'b' }),
];
const multiManifest = ({ color = '#112233', textCoverage = 'COMPLETE', text = 'Hello' } = {}) => manifest('IMAGE', {
  colors: [obs('logo.color', 'COMPLETE', [color], ['ev://color'])],
  text: [obs('body', textCoverage, [text], ['ev://text'])],
});

test('56. every applicable rule PASS -> PASS', () => {
  const report = run(multiRules(), multiManifest());
  assert.deepEqual(report.rule_results.map((r) => r.outcome), ['PASS', 'PASS']);
  assert.equal(report.outcome, 'PASS');
});

test('57. one applicable rule NOT_MEASURABLE -> overall NOT_MEASURABLE', () => {
  const report = run(multiRules(), multiManifest({ textCoverage: 'PARTIAL' }));
  assert.equal(report.outcome, 'NOT_MEASURABLE');
  assert.equal(report.hard_outcome, 'NOT_MEASURABLE');
});

test('58. REVIEW_REQUIRED + PASS -> REVIEW_REQUIRED', () => {
  const rules = [rule({ id: 'a', severity: 'REVIEW' }), textRule('NOT_CONTAINS', 'cheapest', { id: 'b' })];
  assert.equal(run(rules, multiManifest({ color: '#000000' })).outcome, 'REVIEW_REQUIRED');
});

test('59. FAIL outranks REVIEW_REQUIRED, which outranks NOT_MEASURABLE', () => {
  const rules = [rule({ id: 'a', severity: 'REVIEW' }), textRule('NOT_CONTAINS', 'cheapest', { id: 'b' })];
  assert.equal(run(rules, multiManifest({ color: '#000000', text: 'cheapest' })).outcome, 'FAIL');
  assert.equal(run(rules, multiManifest({ color: '#000000', textCoverage: 'PARTIAL' })).outcome, 'REVIEW_REQUIRED');
});

test('60. execution_decision is null: the Guardian decides nothing, even on FAIL', () => {
  for (const color of ['#112233', '#000000']) {
    const report = run([rule()], img({ colors: [obs('logo.color', 'COMPLETE', [color])] }));
    assert.equal(report.execution_decision, null);
    assert.equal(report.policy_note, 'GUARDIAN_REPORT_IS_NOT_AN_EXECUTION_POLICY_DECISION');
  }
});

test('61. no publish / override / execute / force function is exported', () => {
  const forbidden = /override|force|publish|execute|anyway|bypass|approve(Guardian|Candidate)/i;
  const exportedFunctions = Object.entries(branding).filter(([, value]) => typeof value === 'function').map(([name]) => name);
  assert.deepEqual(exportedFunctions.filter((name) => forbidden.test(name)), []);
  assert.ok(exportedFunctions.includes('evaluateBrandGuardian'));
});

test('62. rule results carry the evidence refs of the observation they used', () => {
  const report = run(multiRules(), multiManifest());
  assert.deepEqual(report.rule_results.find((r) => r.rule_id === 'a').evidence_refs, ['ev://color']);
  assert.deepEqual(report.rule_results.find((r) => r.rule_id === 'b').evidence_refs, ['ev://text']);
  // no observation, no invented evidence
  assert.deepEqual(one(reqRule(), img({})).report.rule_results[0].evidence_refs, []);
});

test('63. not_applicable_rule_ids is exact', () => {
  const rules = [rule({ id: 'g' }), rule({ id: 'i', scope: 'IMAGE' }), rule({ id: 'v', scope: 'VIDEO' }), rule({ id: 'd', scope: 'DOCUMENT' })];
  const report = run(rules, img({ colors: [obs('logo.color', 'COMPLETE', ['#112233'])] }));
  assert.deepEqual(report.rule_results.map((r) => r.rule_id), ['g', 'i']);
  assert.deepEqual(report.not_applicable_rule_ids, ['v', 'd']);
});

test('64. same inputs -> same report (id and time only change when the explicit inputs change)', () => {
  const ctx = contextFor(multiRules());
  const input = { tenant: tenant(), brandContext: ctx, candidateManifest: multiManifest(), targetRef: 'creative://asset-1', evaluatedAt: EVALUATED_AT };
  const a = evaluateBrandGuardian(input);
  const b = evaluateBrandGuardian(input);
  assert.deepEqual(a, b);
  assert.match(a.id, /^gr_[0-9a-f]{32}$/);
  const later = evaluateBrandGuardian({ ...input, evaluatedAt: '2026-10-09T12:00:00Z' });
  assert.notEqual(later.id, a.id);
  assert.deepEqual({ ...later, id: a.id, evaluated_at: a.evaluated_at }, a);
});

// ------------------------------------------------------------------ extra guarantees
test('the report is traceable, compact and read-only', () => {
  const long = 'x'.repeat(4000);
  const report = run([textRule('NOT_CONTAINS', 'cheapest')], txt('COMPLETE', long));
  const r = report.rule_results[0];
  assert.deepEqual(Object.keys(r).sort(), ['evidence_refs', 'observed_summary', 'outcome', 'reason', 'rule_id', 'rule_type', 'scope', 'severity', 'subject']);
  assert.ok(r.observed_summary.length < 80);
  assert.equal(JSON.stringify(report).includes(long), false, 'no raw text is copied into the report');
  assert.deepEqual(report.core_ref, { id: 'core-v1', version: 1 });
  assert.deepEqual(report.memory_ref, { id: 'mem-v1', version: 1 });
  assert.equal(report.merchant_id, M1);
  assert.equal(report.content_kind, 'TEXT');
  assert.equal(report.target_ref, 'creative://asset-1');
  assert.equal(Object.isFrozen(report), true);
  assert.throws(() => { report.outcome = 'PASS'; }, TypeError);
  assert.throws(() => { report.rule_results.push({}); }, TypeError);
});

test('content_kind has one source of truth: the manifest (no separate contentKind input)', () => {
  assert.throws(() => evaluateWith(contextFor([rule()]), { contentKind: 'IMAGE' }), /contentKind is not part of the Guardian input/);
  assert.throws(() => evaluateWith(contextFor([rule()]), { checks: [] }), /not part of the Guardian input/);
});

test('the engine is pure: no network, filesystem, clock, randomness or model call in the evaluation sources', async () => {
  for (const file of ['guardian.js', 'candidate-manifest.js', 'hard-rules.js']) {
    const source = await readFile(`src/branding/${file}`, 'utf8');
    assert.equal(/Date\.now|new Date\(|Math\.random|randomUUID|node:fs|node:http|node:net|node:child_process|fetch\(|process\.env/.test(source), false, file);
  }
});

test('Guardian does not reintroduce Creative Quality rule types', () => {
  assert.deepEqual(Object.values(branding.BRAND_RULE_TYPE).sort(),
    ['ASSET_REF', 'CLAIM_REF', 'COLOR', 'EXTERNAL_GATE', 'TEXT', 'TYPOGRAPHY']);
  assert.equal(Object.values(GUARDIAN_OUTCOME).length, 4);
});

// ------------------------------------------------------------------ Brand Identity (multi-brand) in the Guardian
const chainFor = (brandIdentity, tag) => {
  const snap = normalizeBrandSnapshot({
    id: `snap-${tag}`, merchant_id: M1, brand_id: brandIdentity.brand_id, version: 1, status: 'READY',
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
    evidence: [{
      id: 'e1', provenance: 'observed', statement: 'Observed', completeness: 'COMPLETE',
      source: { system: 'internal', observed_at: '2026-10-08T08:00:00Z', kind: SNAPSHOT_SOURCE_KIND.INTERNAL_FACT },
    }],
  });
  const core = approveBrandCore({
    proposal: buildBrandCoreProposal({
      id: `core-${tag}`, tenant: tenant(), brand: brandIdentity, createdAt: '2026-10-08T10:00:00Z', snapshot: snap, decisions: decisions(),
    }).core,
    snapshot: snap, tenant: tenant(), brand: brandIdentity, resolvedActor: actor(), approvedAt: '2026-10-08T10:30:00Z',
  }).approvedCore;
  const draft = buildBrandMemoryDraft({
    tenant: tenant(), brand: brandIdentity, id: `mem-${tag}`, createdAt: '2026-10-08T12:00:00Z', core,
    content: { hard_rules: [rule()], design_tokens: { colors: { primary: '#112233' } } },
  }).memory;
  const memory = approveBrandMemory({
    memory: submitBrandMemoryForReview({ memory: draft, core, tenant: tenant(), brand: brandIdentity }),
    core, tenant: tenant(), brand: brandIdentity, resolvedActor: actor(), approvedAt: '2026-10-08T13:00:00Z',
  }).approvedMemory;
  return { core, memory, context: buildBrandContext({ tenant: tenant(), brand: brandIdentity, core, memory }) };
};

test('Brand 26. the report carries merchant_id and brand_id taken from the READY Brand Context', () => {
  const report = run([rule()], candidate);
  assert.equal(report.merchant_id, M1);
  assert.equal(report.brand_id, B1);
  assert.deepEqual(report.core_ref, { id: 'core-v1', version: 1 });
  assert.deepEqual(report.memory_ref, { id: 'mem-v1', version: 1 });
});

test('Brand 27. the Guardian never infers or accepts a brand from the candidate or from its own inputs', () => {
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', brand_id: B2 }), /not part of the candidate manifest/);
  assert.throws(() => evaluateWith(contextFor([rule()]), { brand_id: B2 }), /brand_id is not part of the Guardian input/);
  assert.throws(() => evaluateWith(contextFor([rule()]), { brand: brandOf(B2, 'Other') }), /brand is not part of the Guardian input/);
  // a manifest cannot smuggle one in through a subject either: the brand stays the context's
  const report = run([rule()], img({ colors: [obs('logo.color', 'COMPLETE', ['#112233'])], assets: [obs(B2, 'COMPLETE', ['asset://x'])] }));
  assert.equal(report.brand_id, B1);
});

test('Brand: Core and Memory must belong to the context brand, even behind a forged READY flag', () => {
  const a = contextFor([rule()]);
  const b = chainFor(brandOf(B2, 'Webshop Brand'), 'b');
  const forgedCore = { ...a, core: b.core };
  assert.throws(() => evaluateWith(forgedCore), /GUARDIAN_REQUIRES_READY_BRAND_CONTEXT.*BRAND_CORE_BRAND_MISMATCH/);
  const forgedMemory = { ...a, memory: b.memory };
  assert.throws(() => evaluateWith(forgedMemory), /GUARDIAN_REQUIRES_READY_BRAND_CONTEXT.*BRAND_MEMORY_BRAND_MISMATCH/);
  const forgedBrand = { ...a, brand: brandOf(B2, 'Webshop Brand') };
  assert.throws(() => evaluateWith(forgedBrand), /GUARDIAN_REQUIRES_READY_BRAND_CONTEXT.*BRAND_CORE_BRAND_MISMATCH/);
  assert.throws(() => evaluateWith({ ...a, brand: null }), /GUARDIAN_REQUIRES_READY_BRAND_CONTEXT/);
});

test('Brand: two brands of the same merchant are evaluated independently', () => {
  const a = contextFor([rule()]);
  const b = chainFor(brandOf(B2, 'Webshop Brand'), 'b').context;
  assert.equal(b.status, 'READY');
  const reportA = evaluateWith(a);
  const reportB = evaluateWith(b);
  assert.equal(reportA.merchant_id, reportB.merchant_id);
  assert.deepEqual([reportA.brand_id, reportB.brand_id], [B1, B2]);
  assert.notEqual(reportA.id, reportB.id);
  assert.deepEqual(reportB.memory_ref, { id: 'mem-b', version: 1 });
});

// ------------------------------------------------------------------ EXTERNAL_GATE: what a gate reports vs what a rule may call compliant
test('Gate registry: STATUS_IN can only list the statuses the gate declares admissible (product_fidelity: PASS only)', () => {
  assert.deepEqual(branding.EXTERNAL_GATES.product_fidelity.allowed_rule_statuses, ['PASS']);
  assert.equal('statuses' in branding.EXTERNAL_GATES.product_fidelity, false, 'one explicit name per notion');
  assert.deepEqual(branding.EXTERNAL_GATES.product_fidelity.observable_statuses, ['PASS', 'FAIL', 'NOT_MEASURABLE']);
  for (const value of [['FAIL'], ['NOT_MEASURABLE'], ['PASS', 'FAIL'], ['PASS', 'NOT_MEASURABLE']]) {
    assert.throws(() => memoryFor(coreV1(), [gateRule({ value })]), /cannot be configured as a compliant status/, JSON.stringify(value));
  }
  assert.throws(() => memoryFor(coreV1(), [gateRule({ value: ['GREAT'] })]), /unknown to gate/);
  assert.equal(memoryFor(coreV1(), [gateRule({ value: ['PASS'] })]).hard_rules[0].value[0], 'PASS');
});

test('Gate registry: the manifest may still REPORT FAIL / NOT_MEASURABLE, and they are never compliant', () => {
  for (const status of ['FAIL', 'NOT_MEASURABLE']) {
    const m = normalizeCandidateManifest(img({ external_gates: [gate('COMPLETE', status)] }));
    assert.equal(m.external_gates[0].status, status);
  }
  assert.equal(one(gateRule(), img({ external_gates: [gate('COMPLETE', 'FAIL')] })).outcome, 'FAIL');
  assert.equal(one(gateRule(), img({ external_gates: [gate('COMPLETE', 'NOT_MEASURABLE')] })).outcome, 'NOT_MEASURABLE');
});

// ------------------------------------------------------------------ Trust of the inputs
test('Trust: the manifest and the semantic assessment are documented as trusted-adapter inputs, never raw client payloads', async () => {
  const doc = await readFile('docs/architecture/branding-v1-contract.md', 'utf8');
  assert.match(doc, /### Trust of the inputs/);
  assert.match(doc, /candidateManifest.*semanticAssessment.*trusted adapters or server context/s);
  assert.match(doc, /never be built directly from an untrusted client payload/);
  assert.match(doc, /authenticates neither/);
  for (const file of ['guardian.js', 'candidate-manifest.js']) {
    const source = await readFile(`src/branding/${file}`, 'utf8');
    assert.match(source, /untrusted client payload/, file);
  }
});

// ------------------------------------------------------------------ Guardian delegates the gate to buildBrandContext
test('Guardian rebuilds the gate with the canonical buildBrandContext and does not duplicate its logic', async () => {
  const raw = await readFile('src/branding/guardian.js', 'utf8');
  const source = raw.replace(/\/\/.*$/gm, ''); // code only: comments may name the reasons
  assert.match(source, /import \{ buildBrandContext \} from '\.\/interfaces\.js'/);
  assert.match(source, /buildBrandContext\(\{/);
  // none of the gate's own reason codes is re-implemented in the Guardian
  for (const reason of ['BRAND_TENANT_MISMATCH', 'BRAND_CORE_BRAND_MISMATCH', 'BRAND_MEMORY_BRAND_MISMATCH', 'BRAND_MEMORY_CORE_MISMATCH', 'BRAND_IDENTITY_MISSING', 'BRAND_INACTIVE']) {
    assert.equal(source.includes(reason), false, reason);
  }
  // parity: for each broken context, the refusal carries exactly the reasons buildBrandContext reports
  const a = contextFor([rule()]);
  const b = chainFor(brandOf(B2, 'Webshop Brand'), 'b');
  const inactive = buildBrandIdentity({
    tenant: tenant(), brandId: B1, name: 'Retired', status: 'INACTIVE', createdAt: '2026-10-01T09:00:00Z',
    defaultLocale: 'fr-BE', supportedLocales: ['fr-BE'],
  });
  const variants = [
    { ...a, core: b.core },
    { ...a, memory: b.memory },
    { ...a, brand: brandOf(B2, 'Webshop Brand') },
    { ...a, brand: null },
    { ...a, brand: inactive },
    { ...a, memory: null },
  ];
  for (const variant of variants) {
    const expected = buildBrandContext({ tenant: tenant(), brand: variant.brand, core: variant.core, memory: variant.memory });
    assert.equal(expected.status, 'GATED');
    assert.throws(
      () => evaluateWith(variant),
      (error) => error.message === `GUARDIAN_REQUIRES_READY_BRAND_CONTEXT: ${expected.reasons.join(', ')}`,
      JSON.stringify(expected.reasons),
    );
  }
});
