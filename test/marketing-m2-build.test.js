import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as m2 from '../src/marketing/m2.js';
import * as understand from '../src/marketing/understand.js';
import * as lostDemand from '../src/marketing/lost-demand.js';
import * as calendarSignals from '../src/marketing/calendar-signals.js';
import * as manualObservation from '../src/marketing/manual-observation.js';
import * as signalProducer from '../src/marketing/signal-producer.js';
import * as leverFitnessModule from '../src/marketing/lever-fitness.js';
import * as resourceModule from '../src/marketing/resource-requirements.js';
import * as measurementModule from '../src/marketing/measurement-plan.js';
import * as pushModule from '../src/marketing/push-proposal.js';
import * as packageModule from '../src/marketing/socle-decision-package.js';
import * as phase3 from '../src/marketing/phase3-contract.js';
import * as measurementBuild from '../src/marketing/build.js';
import {
  M2_VERSION, assessLeverFitness, buildAudienceIntent, buildEstimatedLeadTime, buildExecutionWindow, buildMarketingPushProposal,
  buildMeasurementPlan, buildResourceRequirements, buildReversibility, buildSocleDecisionPackage, evaluateLeadTimeFit,
  evaluatePackageStatus, evaluatePushReadiness, normalizeLeverFitness, normalizeMarketingPushProposal,
} from '../src/marketing/m2.js';
import {
  MarketingUnderstandError, assessMateriality, buildMarketingContext, buildMarketingFinding, buildMarketSignal,
} from '../src/marketing/understand.js';
import {
  approveBrandCore, approveBrandMemory, buildBrandContext, buildBrandCoreProposal, buildBrandIdentity, buildBrandMemoryDraft,
  normalizeBrandSnapshot, submitBrandMemoryForReview,
} from '../src/branding/index.js';

// ------------------------------------------------------------------ fixtures
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tenant = (merchantId = M1) => ({ merchantId, source: 'env' });
const FINDING_AT = '2026-10-08T12:00:00Z';
const ASOF = '2026-10-08T13:00:00Z';

const brandOf = (merchantId, brandId) => buildBrandIdentity({
  tenant: tenant(merchantId), brandId, name: 'Brand', createdAt: '2026-10-01T09:00:00Z', defaultLocale: 'fr-BE', supportedLocales: ['fr-BE'],
});

// A real Core -> Memory -> Context flow, as Branding itself builds it.
function readyBrandContext(merchantId = M1, brandId = B1) {
  const t = tenant(merchantId);
  const brand = brandOf(merchantId, brandId);
  const snapshot = normalizeBrandSnapshot({
    id: 'snapshot-1', merchant_id: merchantId, brand_id: brandId, version: 1, status: 'READY',
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
    evidence: [{ id: 'e1', provenance: 'observed', statement: 'Observed', completeness: 'COMPLETE', source: { system: 'internal', observed_at: '2026-10-08T08:00:00Z', kind: 'INTERNAL_FACT' } }],
  });
  const actor = { user_id: 'user-owner-1', role: 'OWNER', merchant_id: merchantId };
  const proposal = buildBrandCoreProposal({
    id: 'core-v1', tenant: t, brand, createdAt: '2026-10-08T10:00:00Z', snapshot,
    decisions: {
      category: 'category', buying_contexts: ['context'], value_proposition: 'Value', positioning: 'Position', core_promise: 'Promise',
      reasons_to_believe: ['Reason'], personality: ['clear'], voice: { traits: ['clear'], do: ['be specific'], dont: ['invent'] },
      exclusions: ['do not mislead'], distinctive_assets: [], evidence_refs: ['e1'],
    },
  }).core;
  const core = approveBrandCore({ proposal, snapshot, tenant: t, brand, resolvedActor: actor, approvedAt: '2026-10-08T10:30:00Z' }).approvedCore;
  const draft = buildBrandMemoryDraft({ tenant: t, brand, id: 'mem-v1', createdAt: '2026-10-08T12:00:00Z', core, content: { hard_rules: [], design_tokens: { colors: { primary: '#112233' } } } }).memory;
  const reviewed = submitBrandMemoryForReview({ memory: draft, core, tenant: t, brand });
  const memory = approveBrandMemory({ memory: reviewed, core, tenant: t, brand, resolvedActor: actor, approvedAt: '2026-10-08T13:00:00Z' }).approvedMemory;
  return buildBrandContext({ tenant: t, brand, core, memory });
}

const axisOf = (status, over = {}) => ({ status, reason_codes: ['REASON'], evidence_refs: ['ev/fit'], ...over });
const mat = (status = 'MATERIAL') => assessMateriality({ CUSTOMER: { status, reason_codes: ['R'], evidence_refs: ['ev/1'] } });
const fitOf = (over = {}) => ({ status: 'MARKETING_RELEVANT', reason_codes: ['FITS'], evidence_refs: [], target_domains: [], ...over });

// A real M1 Finding (the only way to obtain one). READY_FOR_BUILD until 2026-10-30.
const finding = (over = {}, { merchantId = M1, scoped = false } = {}) => {
  const t = tenant(merchantId);
  const ctx = scoped
    ? buildMarketingContext({ tenant: t, asOf: FINDING_AT, brandId: B1, brandContext: readyBrandContext(merchantId, B1) })
    : buildMarketingContext({ tenant: t, asOf: FINDING_AT });
  return buildMarketingFinding({
    tenant: t, context: ctx, finding_type: 'OPPORTUNITY', subject_refs: ['category://phone-cases'], statement: 'Demand that the offer does not serve.',
    window: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' }, evidence_refs: ['ev/1'], materiality: mat(), domain_fit: fitOf(),
    created_at: FINDING_AT, expires_at: '2026-10-30T12:00:00Z',
    hypotheses: [{ statement: 'The offer is not visible enough.', mechanism: 'low visibility could reduce discovery', supporting_evidence_refs: ['ev/1'], testability: 'TESTABLE_NOW' }],
    ...over,
  });
};
const F = finding();
const HYPOTHESIS_ID = F.hypotheses[0].hypothesis_id;

const allFit = (over = {}) => assessLeverFitness({
  FINDING_FIT: axisOf('FIT'), AUDIENCE_FIT: axisOf('FIT'), CHANNEL_FIT: axisOf('FIT'), MEASUREMENT_FIT: axisOf('FIT'), ...over,
});
const plan = (over = {}) => ({
  baseline_ref: 'metric/baseline-4w', primary_metric_ref: 'metric/orders', guardrail_metric_refs: ['metric/margin'],
  observation_window: { start: '2026-10-10T00:00:00Z', end: '2026-10-24T00:00:00Z' }, control_method: 'TIME', eligibility_status: 'ELIGIBLE',
  eligibility_evidence_refs: [], success_criterion_ref: 'criterion/success', failure_criterion_ref: 'criterion/failure', stop_rule_refs: ['rule/stop'], ...over,
});
const pushFields = (over = {}) => ({
  action_mode: 'TEST_SMALL', lever_family: 'VISIBILITY', lever_variant: 'STORE_FRONT', objective: 'Make the unserved demand visible in store.',
  subject_refs: ['category://phone-cases'], audience: { mode: 'GENERAL' }, channels: ['STORE_FRONT'], lever_fitness: allFit(),
  resource_requirements: { human_time: { min_minutes: 30, max_minutes: 60, basis: 'OWNER_DECIDED' } },
  estimated_lead_time: { value: 2, unit: 'DAYS', basis: 'OWNER_DECIDED' },
  valid_execution_window: { start: '2026-10-09T00:00:00Z', end: '2026-10-20T00:00:00Z' },
  measurement_plan: plan(), reversibility: { status: 'FULLY_REVERSIBLE', reason_codes: ['REMOVABLE'] }, expires_at: '2026-10-25T00:00:00Z', ...over,
});
const push = (over = {}, extra = {}) => buildMarketingPushProposal({ tenant: tenant(), finding: F, asOf: ASOF, ...pushFields(over), ...extra });
const pkgFields = (proposals, over = {}) => ({
  proposals, do_nothing: { reason_codes: ['BASELINE_ACCEPTABLE'], evidence_refs: ['ev/base'] },
  test_small_disposition: { status: 'NOT_APPLICABLE', reason_codes: ['NOT_PROPOSED'], evidence_refs: ['ev/ts'] }, expires_at: '2026-10-25T00:00:00Z', ...over,
});
const pkg = (proposals, over = {}, extra = {}) => buildSocleDecisionPackage({ tenant: tenant(), finding: F, asOf: ASOF, ...pkgFields(proposals, over), ...extra });
const included = (p) => ({ test_small_disposition: { status: 'INCLUDED', proposal_ref: p.push_id } });

const code = (fn) => {
  try { fn(); } catch (error) { assert.ok(error instanceof MarketingUnderstandError, `expected MarketingUnderstandError, got ${error}`); return error.code; }
  assert.fail('expected an error');
  return null;
};
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const everyObject = (v, visit) => { if (v && typeof v === 'object') { visit(v); Object.values(v).forEach((x) => everyObject(x, visit)); } };
const keysDeep = (v, out = new Set()) => { everyObject(v, (o) => Object.keys(o).forEach((k) => out.add(k))); return out; };
const read = (name) => readFile(new URL(`../src/marketing/${name}.js`, import.meta.url), 'utf8');
const M2_FILES = ['m2-constants', 'm2-validation', 'lever-fitness', 'resource-requirements', 'measurement-plan', 'push-proposal', 'socle-decision-package', 'm2'];
const stripComments = (text) => text.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*')).join('\n');

// ------------------------------------------------------------------ Finding gate (1-11)

test('Finding gate: only a READY_FOR_BUILD Finding builds a Push; STALE, REFER_TO_DOMAIN, NOT_MEASURABLE and NO_MATERIAL_SIGNAL are refused', () => {
  assert.equal(push().finding_ref, F.finding_id); // READY accepted
  const notReady = (finding_, asOf = ASOF) => code(() => buildMarketingPushProposal({ tenant: tenant(), finding: finding_, asOf, ...pushFields() }));
  assert.equal(notReady(F, '2026-10-30T12:00:00Z'), 'MKT_M2_FINDING_NOT_READY'); // stale at asOf
  try { buildMarketingPushProposal({ tenant: tenant(), finding: F, asOf: '2026-11-15T00:00:00Z', ...pushFields() }); assert.fail('x'); } catch (e) { assert.equal(e.detail.readiness, 'STALE'); }
  const refer = finding({ domain_fit: fitOf({ status: 'REFER_TO_DOMAIN', target_domains: ['INVENTORY'], evidence_refs: ['ev/1'] }) });
  assert.equal(notReady(refer), 'MKT_M2_FINDING_NOT_READY');
  const notMeasurable = finding({ finding_type: 'NOT_MEASURABLE', subject_refs: [], evidence_refs: [], hypotheses: [], data_gaps: [{ gap_code: 'NO_DATA', description: 'nothing measured' }] });
  assert.equal(notReady(notMeasurable), 'MKT_M2_FINDING_NOT_READY');
  const noSignal = finding({ finding_type: 'NO_MATERIAL_SIGNAL', subject_refs: [], evidence_refs: [], hypotheses: [], materiality: mat('NOT_MATERIAL') });
  assert.equal(notReady(noSignal), 'MKT_M2_FINDING_NOT_READY');
  for (const [f, status] of [[refer, 'REFER_TO_DOMAIN'], [notMeasurable, 'NOT_MEASURABLE'], [noSignal, 'NO_MATERIAL_SIGNAL']]) {
    try { buildMarketingPushProposal({ tenant: tenant(), finding: f, asOf: ASOF, ...pushFields() }); assert.fail('x'); } catch (e) { assert.equal(e.detail.readiness, status); }
  }
  assert.equal(code(() => buildMarketingPushProposal({ tenant: tenant(), asOf: ASOF, ...pushFields() })), 'MKT_INVALID_FIELD'); // no Finding at all
});

test('Finding gate: tenant and brand scope come from the Finding and are verified, never supplied', () => {
  assert.equal(code(() => buildMarketingPushProposal({ tenant: tenant(M2), finding: F, asOf: ASOF, ...pushFields() })), 'MKT_FINDING_TENANT_MISMATCH');
  assert.equal(code(() => buildMarketingPushProposal({ finding: F, asOf: ASOF, ...pushFields() })), 'MKT_TENANT_INVALID');
  const scoped = finding({}, { scoped: true });
  assert.equal(scoped.brand_id, B1);
  const p = buildMarketingPushProposal({ tenant: tenant(), finding: scoped, asOf: ASOF, ...pushFields() });
  assert.deepEqual([p.merchant_id, p.brand_id], [M1, B1]); // brand scope kept
  assert.equal(push().brand_id, null); // merchant-wide stays merchant-wide
  assert.equal(code(() => buildMarketingPushProposal({ tenant: tenant(), brand: brandOf(M1, B2), finding: scoped, asOf: ASOF, ...pushFields() })), 'MKT_FINDING_BRAND_MISMATCH');
  assert.equal(buildMarketingPushProposal({ tenant: tenant(), brand: brandOf(M1, B1), finding: scoped, asOf: ASOF, ...pushFields() }).brand_id, B1);
});

test('Finding gate: hypothesis_ref must exist in the Finding when given', () => {
  assert.equal(push({ hypothesis_ref: HYPOTHESIS_ID }).hypothesis_ref, HYPOTHESIS_ID);
  assert.equal(push().hypothesis_ref, null); // absent accepted
  assert.equal(code(() => push({ hypothesis_ref: 'mhy_unknown' })), 'MKT_M2_HYPOTHESIS_UNKNOWN');
});

// ------------------------------------------------------------------ Lever fitness (12-23)

test('Lever Fitness: deterministic aggregation, visible axes, no score', () => {
  assert.equal(allFit().overall, 'FIT'); // 12
  assert.deepEqual(allFit().deciding_axes, ['FINDING_FIT', 'AUDIENCE_FIT', 'CHANNEL_FIT', 'MEASUREMENT_FIT']);
  const notFit = allFit({ CHANNEL_FIT: axisOf('NOT_FIT'), AUDIENCE_FIT: axisOf('UNKNOWN') }); // 13
  assert.deepEqual([notFit.overall, notFit.deciding_axes], ['NOT_FIT', ['CHANNEL_FIT']]); // NOT_FIT dominates UNKNOWN
  const unknown = allFit({ AUDIENCE_FIT: axisOf('UNKNOWN') }); // 14
  assert.deepEqual([unknown.overall, unknown.deciding_axes], ['UNKNOWN', ['AUDIENCE_FIT']]);
  const na = allFit({ AUDIENCE_FIT: axisOf('NOT_APPLICABLE'), CHANNEL_FIT: axisOf('NOT_APPLICABLE') }); // 15
  assert.equal(na.overall, 'FIT');
  const allNa = assessLeverFitness(Object.fromEntries(['FINDING_FIT', 'AUDIENCE_FIT', 'CHANNEL_FIT', 'MEASUREMENT_FIT'].map((k) => [k, axisOf('NOT_APPLICABLE')]))); // 16
  assert.deepEqual([allNa.overall, allNa.deciding_axes], ['UNKNOWN', []]);
  const partial = assessLeverFitness({ FINDING_FIT: axisOf('FIT') }); // an unassessed axis is UNKNOWN, never silently FIT
  assert.equal(partial.overall, 'UNKNOWN');
  assert.deepEqual(partial.axes.CHANNEL_FIT, { status: 'UNKNOWN', reason_codes: ['AXIS_NOT_ASSESSED'], evidence_refs: [] });
  assert.equal(assessLeverFitness().overall, 'UNKNOWN');
});

test('Lever Fitness: evidence and reasons are required where they carry meaning; axes and statuses are closed', () => {
  assert.equal(code(() => assessLeverFitness({ FINDING_FIT: axisOf('FIT', { evidence_refs: [] }) })), 'MKT_M2_FITNESS_EVIDENCE_REQUIRED'); // 17
  assert.equal(code(() => assessLeverFitness({ FINDING_FIT: axisOf('NOT_FIT', { evidence_refs: [] }) })), 'MKT_M2_FITNESS_EVIDENCE_REQUIRED'); // 18
  assert.equal(code(() => assessLeverFitness({ FINDING_FIT: axisOf('UNKNOWN', { reason_codes: [] }) })), 'MKT_M2_FITNESS_REASON_REQUIRED'); // 19
  assert.equal(code(() => assessLeverFitness({ FINDING_FIT: axisOf('NOT_APPLICABLE', { reason_codes: [] }) })), 'MKT_M2_FITNESS_REASON_REQUIRED');
  assert.equal(code(() => assessLeverFitness({ CREATIVE_FIT: axisOf('FIT') })), 'MKT_M2_FITNESS_INVALID_AXIS'); // 20
  assert.equal(code(() => assessLeverFitness({ FINDING_FIT: axisOf('GREAT') })), 'MKT_M2_FITNESS_INVALID_STATUS'); // 21
  assert.equal(code(() => assessLeverFitness({ FINDING_FIT: { ...axisOf('FIT'), score: 9 } })), 'MKT_UNKNOWN_KEY');
});

test('Lever Fitness: no score or weight anywhere; deep-frozen; a forged overall is refused when re-validated', async () => {
  const a = allFit({ CHANNEL_FIT: axisOf('UNKNOWN') });
  const keys = keysDeep(a);
  for (const forbidden of ['score', 'weight', 'rank', 'ranking_score', 'confidence']) assert.equal(keys.has(forbidden), false, forbidden); // 22
  everyObject(a, (o) => Object.values(o).forEach((v) => assert.notEqual(typeof v, 'number')));
  assert.ok(isDeepFrozen(a)); // 23
  assert.deepEqual(normalizeLeverFitness(JSON.parse(JSON.stringify(a))), a);
  assert.equal(code(() => normalizeLeverFitness({ ...JSON.parse(JSON.stringify(a)), overall: 'FIT' })), 'MKT_M2_FITNESS_OVERALL_MISMATCH');
  assert.equal(code(() => normalizeLeverFitness({ ...JSON.parse(JSON.stringify(a)), deciding_axes: [] })), 'MKT_M2_FITNESS_OVERALL_MISMATCH');
  assert.doesNotMatch(stripComments(await read('lever-fitness')), /\bscore\b|\bweight/i);
});

// ------------------------------------------------------------------ Lever registry (24-31)

test('Lever: five families, optional extensible variant, mandatory for TEST_SMALL and ACTION', () => {
  for (const family of ['VISIBILITY', 'OFFER', 'CRM_LIFECYCLE', 'SEARCH_LOCAL', 'PAID_ACQUISITION']) assert.equal(push({ lever_family: family }).lever_family, family); // 24
  assert.deepEqual(Object.keys(m2.LEVER_FAMILY), ['VISIBILITY', 'OFFER', 'CRM_LIFECYCLE', 'SEARCH_LOCAL', 'PAID_ACQUISITION']);
  assert.equal(code(() => push({ lever_family: 'AFFILIATE' })), 'MKT_M2_LEVER_INVALID_FAMILY'); // 25
  assert.equal(code(() => push({ lever_family: 'visibility' })), 'MKT_M2_LEVER_INVALID_FAMILY');
  for (const variant of ['ORGANIC_SOCIAL', 'STORE_FRONT', 'EMAIL', 'PAID_SEARCH', 'PAID_SOCIAL', 'LOCAL_LISTING', 'BUNDLE', 'CROSS_SELL', 'ANY_FUTURE_VARIANT']) {
    assert.equal(push({ lever_variant: variant }).lever_variant, variant, variant); // 26: extensible, no core logic
  }
  assert.equal(push({ lever_variant: undefined }).lever_variant, null);
  for (const bad of ['paid search', 'paid_search', '1BAD', '', 'X'.repeat(65)]) assert.equal(code(() => push({ lever_variant: bad })), 'MKT_INVALID_FIELD', bad); // 27
  assert.equal(code(() => push({ action_mode: 'TEST_SMALL', lever_family: undefined })), 'MKT_M2_LEVER_INVALID_FAMILY'); // 28
  assert.equal(code(() => push({ action_mode: 'ACTION', lever_family: undefined })), 'MKT_M2_LEVER_INVALID_FAMILY'); // 29
  assert.equal(push({ action_mode: 'ACTION' }).action_mode, 'ACTION');
  assert.equal(code(() => push({ action_mode: 'DO_NOTHING' })), 'MKT_M2_ACTION_MODE_INVALID'); // DO_NOTHING is not an action_mode
  assert.equal(code(() => push({ action_mode: undefined })), 'MKT_M2_ACTION_MODE_INVALID');
});

test('Lever: B2B, partnership, prospecting, direct sales and pricing are not Marketing levers (family, variant or channel)', () => {
  for (const token of ['B2B', 'PARTNERSHIP', 'PROSPECTING', 'DIRECT_SALES', 'PRICING']) {
    assert.equal(code(() => push({ lever_family: token })), 'MKT_M2_LEVER_FORBIDDEN', `family ${token}`); // 30 / 31
    assert.equal(code(() => push({ lever_variant: token })), 'MKT_M2_LEVER_FORBIDDEN', `variant ${token}`);
    assert.equal(code(() => push({ channels: [token] })), 'MKT_M2_LEVER_FORBIDDEN', `channel ${token}`);
  }
  // no pricing authority can be expressed
  for (const key of ['price', 'new_price', 'price_change', 'discount_percent', 'set_price']) assert.equal(code(() => push({ [key]: 1 })), 'MKT_UNKNOWN_KEY', key);
});

// ------------------------------------------------------------------ Audience (32-39)

test('Audience: GENERAL, SEGMENT_REF and DEFINITION, each with its own requirements', () => {
  assert.deepEqual({ ...buildAudienceIntent({ mode: 'GENERAL' }) }, { mode: 'GENERAL', segment_ref: null, criteria_refs: [], exclusion_refs: [], materialization_required: false }); // 32 / 36
  assert.equal(buildAudienceIntent({ mode: 'SEGMENT_REF', segment_ref: 'segment://vip' }).segment_ref, 'segment://vip');
  assert.equal(code(() => buildAudienceIntent({ mode: 'SEGMENT_REF' })), 'MKT_M2_AUDIENCE_SEGMENT_REQUIRED'); // 33
  assert.equal(code(() => buildAudienceIntent({ mode: 'SEGMENT_REF', segment_ref: 'has space' })), 'MKT_INVALID_FIELD');
  const def = buildAudienceIntent({ mode: 'DEFINITION', criteria_refs: ['criteria://recent-buyers'], exclusion_refs: ['criteria://refunded'] });
  assert.deepEqual([def.criteria_refs, def.exclusion_refs], [['criteria://recent-buyers'], ['criteria://refunded']]);
  assert.equal(code(() => buildAudienceIntent({ mode: 'DEFINITION' })), 'MKT_M2_AUDIENCE_CRITERIA_REQUIRED'); // 34
  assert.equal(code(() => buildAudienceIntent({ mode: 'DEFINITION', exclusion_refs: ['criteria://x'] })), 'MKT_M2_AUDIENCE_CRITERIA_REQUIRED');
  assert.equal(def.materialization_required, true); // 35: a DEFINITION is never executable as is
  assert.equal(code(() => buildAudienceIntent({ mode: 'DEFINITION', criteria_refs: ['c/1'], materialization_required: false })), 'MKT_M2_AUDIENCE_MATERIALIZATION_REQUIRED');
  assert.equal(buildAudienceIntent({ mode: 'DEFINITION', criteria_refs: ['c/1'], materialization_required: true }).materialization_required, true);
  assert.equal(code(() => buildAudienceIntent({ mode: 'GENERAL', segment_ref: 'segment://vip' })), 'MKT_M2_AUDIENCE_FIELD_NOT_ALLOWED'); // 36
  assert.equal(code(() => buildAudienceIntent({ mode: 'GENERAL', criteria_refs: ['c/1'] })), 'MKT_M2_AUDIENCE_FIELD_NOT_ALLOWED');
  assert.equal(code(() => buildAudienceIntent({ mode: 'SEGMENT_REF', segment_ref: 'segment://vip', criteria_refs: ['c/1'] })), 'MKT_M2_AUDIENCE_FIELD_NOT_ALLOWED'); // 37
  assert.equal(code(() => buildAudienceIntent({ mode: 'DEFINITION', segment_ref: 'segment://vip', criteria_refs: ['c/1'] })), 'MKT_M2_AUDIENCE_FIELD_NOT_ALLOWED');
  assert.equal(code(() => buildAudienceIntent({ mode: 'EVERYONE' })), 'MKT_M2_AUDIENCE_INVALID_MODE');
  assert.ok(isDeepFrozen(def));
});

test('Audience privacy: no customer profile, no list, no PII, no query language can be expressed', () => {
  for (const key of ['customer_name', 'email', 'phone', 'customers', 'customer_list', 'crm_profile', 'transcript', 'query', 'sql', 'filter', 'age', 'segment_definition']) {
    assert.equal(code(() => buildAudienceIntent({ mode: 'GENERAL', [key]: 'x' })), 'MKT_UNKNOWN_KEY', key); // 38 / 39
  }
  assert.equal(code(() => buildAudienceIntent({ mode: 'DEFINITION', criteria_refs: ['someone@example.com'] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => buildAudienceIntent({ mode: 'DEFINITION', criteria_refs: ["age > 30 AND city = 'Namur'"] })), 'MKT_INVALID_FIELD'); // no query DSL
  assert.equal(code(() => buildAudienceIntent({ mode: 'SEGMENT_REF', segment_ref: '0470 12 34 56' })), 'MKT_INVALID_FIELD');
});

// ------------------------------------------------------------------ Resources (40-52)

test('Resources: an empty object is valid; cash is a declared requirement with a currency, a range and a basis', () => {
  const empty = buildResourceRequirements({});
  assert.deepEqual({ ...empty }, { cash: null, human_time: null, operational_capacity_refs: [], inventory_requirement_refs: [], creative_capacity_refs: [], contact_capacity_refs: [], other_resource_refs: [] }); // 40
  assert.equal(buildResourceRequirements().cash, null);
  const r = buildResourceRequirements({ cash: { currency: 'EUR', min: 0, max: 250.5, basis: 'OWNER_DECIDED' } }); // 41
  assert.deepEqual({ ...r.cash }, { currency: 'EUR', min: 0, max: 250.5, basis: 'OWNER_DECIDED', evidence_refs: [] });
  const equalBounds = buildResourceRequirements({ cash: { currency: 'EUR', min: 100, max: 100, basis: 'PLANNED_LIMIT' } });
  assert.equal(equalBounds.cash.min, equalBounds.cash.max);
  const cash = (over) => ({ cash: { currency: 'EUR', min: 10, max: 20, basis: 'OWNER_DECIDED', ...over } });
  assert.equal(code(() => buildResourceRequirements(cash({ min: 30, max: 20 }))), 'MKT_M2_RESOURCE_INVALID_RANGE'); // 42
  assert.equal(code(() => buildResourceRequirements(cash({ min: -1 }))), 'MKT_M2_RESOURCE_INVALID_RANGE'); // 43
  assert.equal(code(() => buildResourceRequirements(cash({ max: -5, min: -9 }))), 'MKT_M2_RESOURCE_INVALID_RANGE');
  for (const currency of ['eur', 'EURO', 'E1R', '', undefined, 978]) assert.equal(code(() => buildResourceRequirements(cash({ currency }))), 'MKT_INVALID_FIELD', String(currency)); // 44
  for (const bad of ['10', Number.NaN, Number.POSITIVE_INFINITY, null, {}]) assert.equal(code(() => buildResourceRequirements(cash({ min: bad, max: 20 }))), 'MKT_INVALID_FIELD', String(bad));
});

test('Resources: every material number needs a closed basis; a model guess is not a basis; sourced bases need evidence', () => {
  const cash = (over) => ({ cash: { currency: 'EUR', min: 10, max: 20, basis: 'OWNER_DECIDED', ...over } });
  assert.equal(code(() => buildResourceRequirements(cash({ basis: 'GUESS' }))), 'MKT_M2_INVALID_BASIS'); // 45
  assert.equal(code(() => buildResourceRequirements(cash({ basis: undefined }))), 'MKT_M2_INVALID_BASIS');
  assert.equal(code(() => buildResourceRequirements(cash({ basis: 'AI_ESTIMATE' }))), 'MKT_M2_INVALID_BASIS'); // 46
  assert.equal(code(() => buildResourceRequirements(cash({ basis: 'MODEL_GUESS' }))), 'MKT_M2_INVALID_BASIS');
  assert.deepEqual(Object.keys(m2.NUMBER_BASIS), ['OWNER_DECIDED', 'DOMAIN_FACT', 'DETERMINISTIC_CALCULATION', 'EXTERNAL_QUOTE', 'PLANNED_LIMIT']);
  for (const basis of ['DOMAIN_FACT', 'DETERMINISTIC_CALCULATION', 'EXTERNAL_QUOTE']) {
    assert.equal(code(() => buildResourceRequirements(cash({ basis }))), 'MKT_M2_RESOURCE_EVIDENCE_REQUIRED', basis);
    assert.deepEqual(buildResourceRequirements(cash({ basis, evidence_refs: ['ev/quote-1'] })).cash.evidence_refs, ['ev/quote-1']);
  }
});

test('Resources: human time, opaque refs, closed schema, and no availability conclusion', () => {
  const ht = (over) => ({ human_time: { min_minutes: 30, max_minutes: 90, basis: 'OWNER_DECIDED', ...over } });
  assert.deepEqual({ ...buildResourceRequirements(ht({})).human_time }, { min_minutes: 30, max_minutes: 90, basis: 'OWNER_DECIDED', evidence_refs: [] }); // 47
  assert.equal(code(() => buildResourceRequirements(ht({ min_minutes: 100 }))), 'MKT_M2_RESOURCE_INVALID_RANGE'); // 48
  assert.equal(code(() => buildResourceRequirements(ht({ min_minutes: -5, max_minutes: 10 }))), 'MKT_M2_RESOURCE_INVALID_RANGE'); // 49
  assert.equal(code(() => buildResourceRequirements(ht({ basis: 'AI_ESTIMATE' }))), 'MKT_M2_INVALID_BASIS');
  const refs = buildResourceRequirements({
    operational_capacity_refs: ['capacity://workshop-week-42'], inventory_requirement_refs: ['inventory://case-x', 'inventory://case-x'],
    creative_capacity_refs: ['creative://photo-slot'], contact_capacity_refs: ['contact://email-weekly'], other_resource_refs: ['resource://display-stand'],
  });
  assert.deepEqual(refs.inventory_requirement_refs, ['inventory://case-x']); // 50: opaque, de-duplicated, never expanded
  assert.equal(code(() => buildResourceRequirements({ inventory_requirement_refs: ['10 units in stock'] })), 'MKT_INVALID_FIELD');
  for (const key of ['available', 'is_available', 'sufficient', 'budget_available', 'stock_ok', 'capacity_ok', 'approved', 'max_spend', 'acceptable_cac']) {
    assert.equal(code(() => buildResourceRequirements({ [key]: true })), 'MKT_UNKNOWN_KEY', key); // 51 / 52: a requirement is never an availability verdict
  }
  assert.equal(code(() => buildResourceRequirements({ cash: { currency: 'EUR', min: 1, max: 2, basis: 'OWNER_DECIDED', available: true } })), 'MKT_UNKNOWN_KEY');
  assert.ok(isDeepFrozen(refs));
});

// ------------------------------------------------------------------ Lead time / execution window (53-62)

test('Lead time: HOURS and DAYS, closed unit, non-negative value, mandatory basis', () => {
  assert.equal(buildEstimatedLeadTime({ value: 6, unit: 'HOURS', basis: 'OWNER_DECIDED' }).unit, 'HOURS'); // 53
  assert.equal(buildEstimatedLeadTime({ value: 2.5, unit: 'DAYS', basis: 'PLANNED_LIMIT' }).value, 2.5); // 54
  assert.equal(buildEstimatedLeadTime({ value: 0, unit: 'DAYS', basis: 'OWNER_DECIDED' }).value, 0);
  assert.equal(code(() => buildEstimatedLeadTime({ value: 1, unit: 'WEEKS', basis: 'OWNER_DECIDED' })), 'MKT_M2_LEAD_TIME_INVALID_UNIT'); // 55
  assert.equal(code(() => buildEstimatedLeadTime({ value: 1, unit: 'BUSINESS_DAYS', basis: 'OWNER_DECIDED' })), 'MKT_M2_LEAD_TIME_INVALID_UNIT');
  assert.equal(code(() => buildEstimatedLeadTime({ value: -1, unit: 'DAYS', basis: 'OWNER_DECIDED' })), 'MKT_M2_LEAD_TIME_INVALID_VALUE'); // 56
  assert.equal(code(() => buildEstimatedLeadTime({ value: '2', unit: 'DAYS', basis: 'OWNER_DECIDED' })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => buildEstimatedLeadTime({ value: 1, unit: 'DAYS' })), 'MKT_M2_INVALID_BASIS'); // 57
  assert.equal(code(() => buildEstimatedLeadTime({ value: 1, unit: 'DAYS', basis: 'AI_ESTIMATE' })), 'MKT_M2_INVALID_BASIS');
  assert.equal(code(() => buildEstimatedLeadTime({ value: 1, unit: 'DAYS', basis: 'EXTERNAL_QUOTE' })), 'MKT_M2_RESOURCE_EVIDENCE_REQUIRED');
  assert.equal(code(() => buildExecutionWindow({ start: '2026-10-20T00:00:00Z', end: '2026-10-09T00:00:00Z' })), 'MKT_M2_EXECUTION_WINDOW_INVALID');
  assert.equal(code(() => buildExecutionWindow({ start: '2026-10-09T00:00:00Z', end: '2026-10-09T00:00:00Z' })), 'MKT_M2_EXECUTION_WINDOW_INVALID'); // end must be after start
  assert.equal(code(() => buildExecutionWindow({ start: '2026-10-09', end: '2026-10-20T00:00:00Z' })), 'MKT_M2_EXECUTION_WINDOW_INVALID');
});

test('Lead time fit: candidate_start = max(asOf, window.start); completion = start + lead time; completion <= window.end is FIT', () => {
  const win = { start: '2026-10-09T00:00:00Z', end: '2026-10-12T00:00:00Z' };
  const lead = (value, unit = 'DAYS') => ({ value, unit, basis: 'OWNER_DECIDED' });
  const fit = evaluateLeadTimeFit(lead(2), win, '2026-10-08T00:00:00Z'); // 58
  assert.deepEqual({ ...fit }, { status: 'FIT', as_of: '2026-10-08T00:00:00.000Z', candidate_start: '2026-10-09T00:00:00.000Z', completion: '2026-10-11T00:00:00.000Z' });
  assert.equal(evaluateLeadTimeFit(lead(3), win, '2026-10-08T00:00:00Z').status, 'FIT'); // completion == window.end is allowed
  assert.equal(evaluateLeadTimeFit(lead(3, 'DAYS'), win, '2026-10-09T00:00:01Z').status, 'NOT_FIT'); // 59: asOf inside the window eats the time
  assert.equal(evaluateLeadTimeFit(lead(73, 'HOURS'), win, '2026-10-08T00:00:00Z').status, 'NOT_FIT');
  assert.equal(evaluateLeadTimeFit(lead(72, 'HOURS'), win, '2026-10-08T00:00:00Z').status, 'FIT');
  assert.equal(evaluateLeadTimeFit(lead(1), win, '2026-10-13T00:00:00Z').status, 'NOT_FIT'); // asOf already past the window
  const later = evaluateLeadTimeFit(lead(1), win, '2026-10-09T12:00:00Z'); // asOf inside the window: starts now
  assert.equal(later.candidate_start, '2026-10-09T12:00:00.000Z');
  const future = evaluateLeadTimeFit(lead(1), win, '2026-10-01T00:00:00Z'); // 60: window starts in the future
  assert.equal(future.candidate_start, '2026-10-09T00:00:00.000Z');
  assert.equal(evaluateLeadTimeFit(lead(0), win, '2026-10-01T00:00:00Z').completion, '2026-10-09T00:00:00.000Z');
  assert.ok(isDeepFrozen(fit));
});

test('Lead time: explicit clock only, DAYS = 24 hours exactly, no business days', async () => {
  const win = { start: '2026-10-09T00:00:00Z', end: '2026-12-01T00:00:00Z' };
  const lead = { value: 1, unit: 'DAYS', basis: 'OWNER_DECIDED' };
  assert.equal(code(() => evaluateLeadTimeFit(lead, win)), 'MKT_INVALID_TIMESTAMP'); // 61
  assert.equal(code(() => evaluateLeadTimeFit(lead, win, 'tomorrow')), 'MKT_INVALID_TIMESTAMP');
  assert.equal(evaluateLeadTimeFit(lead, win, new Date('2026-10-09T00:00:00Z')).completion, '2026-10-10T00:00:00.000Z');
  // 62: one DAY is exactly 24 hours, also across the 2026-10-25 DST change and across a weekend
  const days = evaluateLeadTimeFit({ ...lead, value: 3 }, { start: '2026-10-23T00:00:00Z', end: '2026-12-01T00:00:00Z' }, '2026-10-23T00:00:00Z');
  const hours = evaluateLeadTimeFit({ ...lead, value: 72, unit: 'HOURS' }, { start: '2026-10-23T00:00:00Z', end: '2026-12-01T00:00:00Z' }, '2026-10-23T00:00:00Z');
  assert.equal(days.completion, hours.completion);
  assert.equal(days.completion, '2026-10-26T00:00:00.000Z'); // Fri + 3 days = Mon: no business-day logic
  assert.equal(m2.LEAD_TIME_MS.DAYS, 24 * m2.LEAD_TIME_MS.HOURS);
  const doc = await readFile(new URL('../docs/architecture/marketing-m2-build-contract.md', import.meta.url), 'utf8');
  assert.match(doc, /DAYS = 24 hours/);
  assert.equal(code(() => buildEstimatedLeadTime({ ...lead, value: 100001 })), 'MKT_M2_LEAD_TIME_INVALID_VALUE'); // capped, so no date can overflow
  assert.equal(evaluateLeadTimeFit({ ...lead, value: 100000 }, { start: '2026-10-09T00:00:00Z', end: '2027-01-01T00:00:00Z' }, '2026-10-09T00:00:00Z').status, 'NOT_FIT');
});

// ------------------------------------------------------------------ Measurement plan (63-79)

test('MeasurementPlan: NONE, TIME and HOLDOUT, with the required refs and a valid observation window', () => {
  assert.equal(buildMeasurementPlan(plan({ control_method: 'NONE' })).control_method, 'NONE'); // 63
  assert.equal(buildMeasurementPlan(plan({ control_method: 'TIME' })).control_method, 'TIME'); // 64
  const holdout = buildMeasurementPlan(plan({ control_method: 'HOLDOUT', eligibility_status: 'ELIGIBLE', eligibility_evidence_refs: ['ev/holdout-eligible'] })); // 65
  assert.equal(holdout.control_method, 'HOLDOUT');
  assert.equal(code(() => buildMeasurementPlan(plan({ control_method: 'AB_TEST' }))), 'MKT_M2_MEASUREMENT_INVALID_CONTROL');
  assert.equal(code(() => buildMeasurementPlan(plan({ control_method: 'GEO' }))), 'MKT_M2_MEASUREMENT_INVALID_CONTROL');
  assert.equal(code(() => buildMeasurementPlan(plan({ control_method: 'HOLDOUT', eligibility_status: 'UNKNOWN', eligibility_evidence_refs: ['ev/x'] }))), 'MKT_M2_MEASUREMENT_HOLDOUT_NOT_ELIGIBLE'); // 66
  assert.equal(code(() => buildMeasurementPlan(plan({ control_method: 'HOLDOUT', eligibility_status: 'NOT_ELIGIBLE', eligibility_evidence_refs: ['ev/x'] }))), 'MKT_M2_MEASUREMENT_HOLDOUT_NOT_ELIGIBLE'); // 67
  assert.equal(code(() => buildMeasurementPlan(plan({ control_method: 'HOLDOUT', eligibility_status: 'ELIGIBLE', eligibility_evidence_refs: [] }))), 'MKT_M2_MEASUREMENT_EVIDENCE_REQUIRED'); // 68
  assert.equal(code(() => buildMeasurementPlan(plan({ eligibility_status: 'MAYBE' }))), 'MKT_M2_MEASUREMENT_INVALID_ELIGIBILITY');
  assert.equal(code(() => buildMeasurementPlan(plan({ primary_metric_ref: undefined }))), 'MKT_INVALID_FIELD'); // 69
  assert.equal(code(() => buildMeasurementPlan(plan({ primary_metric_ref: 'a formula: orders / sessions' }))), 'MKT_INVALID_FIELD'); // a ref, not a formula or DSL
  assert.equal(code(() => buildMeasurementPlan(plan({ baseline_ref: undefined }))), 'MKT_INVALID_FIELD'); // 70
  assert.equal(buildMeasurementPlan(plan()).baseline_ref, 'metric/baseline-4w');
  assert.deepEqual({ ...buildMeasurementPlan(plan()).observation_window }, { start: '2026-10-10T00:00:00.000Z', end: '2026-10-24T00:00:00.000Z' }); // 71
  assert.equal(code(() => buildMeasurementPlan(plan({ observation_window: { start: '2026-10-24T00:00:00Z', end: '2026-10-10T00:00:00Z' } }))), 'MKT_M2_MEASUREMENT_INVALID_WINDOW'); // 72
  assert.equal(code(() => buildMeasurementPlan(plan({ observation_window: { start: '2026-10-10T00:00:00Z', end: '2026-10-10T00:00:00Z' } }))), 'MKT_M2_MEASUREMENT_INVALID_WINDOW');
  assert.equal(code(() => buildMeasurementPlan(plan({ observation_window: undefined }))), 'MKT_M2_MEASUREMENT_INVALID_WINDOW');
  assert.equal(code(() => buildMeasurementPlan(plan({ success_criterion_ref: undefined }))), 'MKT_INVALID_FIELD'); // 73
  assert.equal(code(() => buildMeasurementPlan(plan({ failure_criterion_ref: undefined }))), 'MKT_INVALID_FIELD'); // 74
  assert.deepEqual(buildMeasurementPlan(plan({ stop_rule_refs: ['rule/a', 'rule/a', 'rule/b'] })).stop_rule_refs, ['rule/a', 'rule/b']); // 75
  assert.ok(isDeepFrozen(holdout));
});

test('MeasurementPlan: incrementality_candidate is derived and is never a causal claim', () => {
  assert.equal(buildMeasurementPlan(plan({ control_method: 'NONE' })).incrementality_candidate, false); // 76
  assert.equal(buildMeasurementPlan(plan({ control_method: 'TIME' })).incrementality_candidate, false); // 77
  assert.equal(buildMeasurementPlan(plan({ control_method: 'HOLDOUT', eligibility_evidence_refs: ['ev/h'] })).incrementality_candidate, true); // 78
  assert.equal(buildMeasurementPlan(plan({ control_method: 'TIME', eligibility_status: 'ELIGIBLE' })).incrementality_candidate, false); // ELIGIBLE alone is not enough
  assert.equal(code(() => buildMeasurementPlan(plan({ control_method: 'TIME', incrementality_candidate: true }))), 'MKT_M2_MEASUREMENT_INCREMENTALITY_MISMATCH');
  assert.equal(buildMeasurementPlan(plan({ control_method: 'TIME', incrementality_candidate: false })).incrementality_candidate, false);
  // 79: no causal claim anywhere
  for (const control of ['NONE', 'TIME', 'HOLDOUT']) {
    const p = buildMeasurementPlan(plan({ control_method: control, eligibility_evidence_refs: ['ev/h'] }));
    everyObject(p, (o) => { assert.notEqual(o.causal_claim, true); assert.notEqual(o.causal_claims, true); });
    assert.equal('causal_claim' in p, false);
  }
  for (const key of ['formula', 'power', 'sample_size', 'significance', 'causal_claim', 'uplift']) assert.equal(code(() => buildMeasurementPlan(plan({ [key]: 1 }))), 'MKT_UNKNOWN_KEY', key); // no formula/DSL, no power calc
});

// ------------------------------------------------------------------ Reversibility (80-84)

test('Reversibility: four statuses, mandatory reasons, evidence kept, no score', () => {
  for (const status of ['FULLY_REVERSIBLE', 'PARTIALLY_REVERSIBLE', 'HARD_TO_REVERSE', 'UNKNOWN']) {
    assert.equal(buildReversibility({ status, reason_codes: ['WHY'] }).status, status); // 80
  }
  assert.equal(code(() => buildReversibility({ status: 'EASY', reason_codes: ['WHY'] })), 'MKT_M2_REVERSIBILITY_INVALID_STATUS'); // 81
  assert.equal(code(() => buildReversibility({ status: 'UNKNOWN', reason_codes: [] })), 'MKT_M2_REVERSIBILITY_REASON_REQUIRED'); // 82
  assert.equal(code(() => buildReversibility({ status: 'UNKNOWN' })), 'MKT_M2_REVERSIBILITY_REASON_REQUIRED');
  assert.deepEqual(buildReversibility({ status: 'HARD_TO_REVERSE', reason_codes: ['PRINTED_RUN'], evidence_refs: ['ev/print-quote', 'ev/print-quote'] }).evidence_refs, ['ev/print-quote']); // 83
  const keys = keysDeep(buildReversibility({ status: 'UNKNOWN', reason_codes: ['WHY'] })); // 84
  for (const forbidden of ['score', 'level', 'percent', 'probability']) assert.equal(keys.has(forbidden), false, forbidden);
  assert.equal(code(() => buildReversibility({ status: 'UNKNOWN', reason_codes: ['WHY'], score: 3 })), 'MKT_UNKNOWN_KEY');
});

// ------------------------------------------------------------------ Push (85-107)

test('Push: an ACTION and a TEST_SMALL are valid; ids are deterministic and sensitive to the lever', () => {
  const action = push({ action_mode: 'ACTION', lever_family: 'OFFER', lever_variant: 'BUNDLE', channels: ['STORE_FRONT', 'EMAIL'] }); // 85
  assert.deepEqual([action.action_mode, action.lever_family, action.channels, action.schema_version], ['ACTION', 'OFFER', ['STORE_FRONT', 'EMAIL'], M2_VERSION]);
  assert.equal(M2_VERSION, 'marketing-m2-build.v1');
  const small = push(); // 86
  assert.equal(small.action_mode, 'TEST_SMALL');
  assert.match(small.push_id, /^mpp_[0-9a-f]{32}$/); // 87
  assert.equal(push().push_id, small.push_id); // 88
  assert.equal(JSON.stringify(push()), JSON.stringify(small));
  assert.notEqual(push({ lever_family: 'OFFER' }).push_id, small.push_id); // 89
  assert.notEqual(push({ lever_variant: 'EMAIL' }).push_id, small.push_id);
  assert.notEqual(push({ action_mode: 'ACTION' }).push_id, small.push_id);
  assert.deepEqual(Object.keys(small), [
    'push_id', 'schema_version', 'merchant_id', 'brand_id', 'finding_ref', 'hypothesis_ref', 'action_mode', 'lever_family', 'lever_variant',
    'objective', 'subject_refs', 'audience', 'channels', 'lever_fitness', 'resource_requirements', 'estimated_lead_time',
    'valid_execution_window', 'lead_time_fit', 'measurement_plan', 'claim_refs', 'policy_requirement_refs', 'consent_requirement_refs',
    'promotion_rule_refs', 'risk_refs', 'unknown_refs', 'reversibility', 'created_at', 'expires_at', 'readiness',
  ]);
  assert.equal(code(() => push({ subject_refs: [] })), 'MKT_M2_PUSH_SUBJECT_REQUIRED');
  assert.equal(code(() => push({ channels: [] })), 'MKT_M2_PUSH_CHANNEL_REQUIRED');
  assert.equal(code(() => push({ channels: ['store front'] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => push({ objective: '' })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => push({ objective: 'x'.repeat(301) })), 'MKT_INVALID_FIELD');
});

test('Push: merchant, brand, finding_ref and created_at are derived - supplying any of them is refused', () => {
  const p = push();
  assert.deepEqual([p.merchant_id, p.brand_id, p.finding_ref, p.created_at], [M1, null, F.finding_id, '2026-10-08T13:00:00.000Z']); // 90 / 93
  assert.equal(code(() => push({ merchant_id: M2 })), 'MKT_UNKNOWN_KEY'); // 91
  assert.equal(code(() => push({ brand_id: B1 })), 'MKT_UNKNOWN_KEY'); // 92
  assert.equal(code(() => push({ finding_ref: 'mfd_other' })), 'MKT_UNKNOWN_KEY');
  for (const key of ['push_id', 'created_at', 'readiness', 'lead_time_fit', 'schema_version']) assert.equal(code(() => push({ [key]: 'x' })), 'MKT_UNKNOWN_KEY', key);
  assert.equal(code(() => buildMarketingPushProposal({ tenant: tenant(), finding: F, ...pushFields() })), 'MKT_INVALID_TIMESTAMP'); // no implicit clock
});

test('Push freshness: expires_at must be after creation and cannot outlive the Finding', () => {
  assert.equal(push({ expires_at: F.expires_at }).expires_at, F.expires_at); // 94: equal to the Finding is allowed
  assert.equal(push({ expires_at: '2026-10-30T12:00:00Z' }).expires_at, '2026-10-30T12:00:00.000Z');
  assert.equal(code(() => push({ expires_at: '2026-10-30T12:00:01Z' })), 'MKT_M2_PUSH_OUTLIVES_FINDING'); // 95
  assert.equal(code(() => push({ expires_at: '2026-10-08T13:00:00Z' })), 'MKT_M2_PUSH_INVALID_EXPIRY'); // equal to created_at
  assert.equal(code(() => push({ expires_at: '2026-10-01T00:00:00Z' })), 'MKT_M2_PUSH_INVALID_EXPIRY');
  assert.equal(code(() => push({ expires_at: 'next week' })), 'MKT_M2_PUSH_INVALID_EXPIRY');
  const p = push(); // 96
  assert.equal(evaluatePushReadiness(p, '2026-10-10T00:00:00Z').status, 'READY_FOR_SOCLE');
  assert.deepEqual({ ...evaluatePushReadiness(p, '2026-10-25T00:00:00Z') }, { status: 'STALE', reason_codes: ['PROPOSAL_EXPIRED'] }); // at expiry
  assert.equal(evaluatePushReadiness(p, '2026-12-01T00:00:00Z').status, 'STALE');
  assert.equal(code(() => evaluatePushReadiness(p)), 'MKT_INVALID_TIMESTAMP');
});

test('Push readiness: NOT_FIT / NOT_FIT lead time / UNKNOWN fitness / READY, with the precedence STALE > NOT_ELIGIBLE > NEEDS_EVIDENCE > READY', () => {
  const notFit = push({ lever_fitness: allFit({ CHANNEL_FIT: axisOf('NOT_FIT') }) }); // 97
  assert.deepEqual({ ...notFit.readiness }, { status: 'NOT_ELIGIBLE', reason_codes: ['LEVER_FITNESS_NOT_FIT'] });
  const late = push({ estimated_lead_time: { value: 30, unit: 'DAYS', basis: 'OWNER_DECIDED' } }); // 98: cannot finish before the window ends
  assert.deepEqual({ ...late.readiness }, { status: 'NOT_ELIGIBLE', reason_codes: ['LEAD_TIME_NOT_FIT'] });
  assert.equal(late.lead_time_fit.status, 'NOT_FIT');
  const unknown = push({ lever_fitness: allFit({ AUDIENCE_FIT: axisOf('UNKNOWN') }) }); // 99
  assert.deepEqual({ ...unknown.readiness }, { status: 'NEEDS_EVIDENCE', reason_codes: ['LEVER_FITNESS_UNKNOWN'] });
  const eligibilityUnknown = push({ measurement_plan: plan({ eligibility_status: 'UNKNOWN' }) });
  assert.deepEqual({ ...eligibilityUnknown.readiness }, { status: 'NEEDS_EVIDENCE', reason_codes: ['MEASUREMENT_ELIGIBILITY_UNKNOWN'] });
  const ready = push(); // 100
  assert.deepEqual({ ...ready.readiness }, { status: 'READY_FOR_SOCLE', reason_codes: ['FIT_AND_MEASURABLE'] });
  assert.equal(push({ lever_fitness: allFit({ CHANNEL_FIT: axisOf('NOT_FIT'), AUDIENCE_FIT: axisOf('UNKNOWN') }), measurement_plan: plan({ eligibility_status: 'UNKNOWN' }) }).readiness.status, 'NOT_ELIGIBLE'); // NOT_ELIGIBLE beats NEEDS_EVIDENCE
  assert.equal(evaluatePushReadiness(notFit, '2026-12-01T00:00:00Z').status, 'STALE'); // STALE beats everything
  // the live evaluation re-computes the lead time at the new clock
  const tight = push({ estimated_lead_time: { value: 5, unit: 'DAYS', basis: 'OWNER_DECIDED' }, valid_execution_window: { start: '2026-10-09T00:00:00Z', end: '2026-10-15T00:00:00Z' } });
  assert.equal(tight.readiness.status, 'READY_FOR_SOCLE');
  assert.equal(evaluatePushReadiness(tight, '2026-10-12T00:00:00Z').status, 'NOT_ELIGIBLE'); // too late to finish by 10-15
  // 101: a TEST_SMALL that is hard to reverse is not eligible; an ACTION is judged by the Socle, not excluded here
  const hard = { status: 'HARD_TO_REVERSE', reason_codes: ['PRINTED_RUN'] };
  assert.deepEqual({ ...push({ reversibility: hard }).readiness }, { status: 'NOT_ELIGIBLE', reason_codes: ['TEST_SMALL_HARD_TO_REVERSE'] });
  assert.equal(push({ action_mode: 'ACTION', reversibility: hard }).readiness.status, 'READY_FOR_SOCLE');
  assert.equal(push({ reversibility: { status: 'PARTIALLY_REVERSIBLE', reason_codes: ['PART'] } }).readiness.status, 'READY_FOR_SOCLE');
  assert.ok(isDeepFrozen(evaluatePushReadiness(ready, ASOF)));
});

test('Push: claims, policy, consent, promotion rules, risks and unknowns are opaque refs - Marketing validates none of them', () => {
  const p = push({
    claim_refs: ['claim://approved-1'], policy_requirement_refs: ['policy://promo-rules'], consent_requirement_refs: ['consent://email-optin'],
    promotion_rule_refs: ['promo-rule://threshold'], risk_refs: ['risk://stockout', 'risk://stockout'], unknown_refs: ['unknown://margin-verdict'],
  });
  assert.deepEqual([p.claim_refs, p.policy_requirement_refs, p.consent_requirement_refs, p.promotion_rule_refs], [['claim://approved-1'], ['policy://promo-rules'], ['consent://email-optin'], ['promo-rule://threshold']]); // 102
  assert.deepEqual([p.risk_refs, p.unknown_refs], [['risk://stockout'], ['unknown://margin-verdict']]); // 103
  assert.equal(p.readiness.status, 'READY_FOR_SOCLE'); // being listed is not being cleared, and does not block either
  assert.equal(code(() => push({ claim_refs: ['Free shipping on all orders!'] })), 'MKT_INVALID_FIELD');
  for (const key of ['claims_valid', 'compliant', 'consent_given', 'policy_cleared']) assert.equal(code(() => push({ [key]: true })), 'MKT_UNKNOWN_KEY', key);
});

test('Push: no execution, no approval, no budget authority can be expressed; READY_FOR_SOCLE is not approval', () => {
  const p = push();
  const keys = keysDeep(p);
  for (const forbidden of ['approved', 'approval', 'approved_by', 'execute', 'execution', 'publish', 'send', 'buy_ads', 'authorized', 'budget_authorized', 'reserved', 'policy_cleared', 'decision', 'winner', 'selected']) {
    assert.equal(keys.has(forbidden), false, forbidden); // 104 / 105
    assert.equal(code(() => push({ [forbidden]: true })), 'MKT_UNKNOWN_KEY', forbidden);
  }
  assert.equal(p.readiness.status, 'READY_FOR_SOCLE');
  assert.equal('approved' in p, false);
});

test('Push: deep-frozen output, caller inputs untouched, JSON round-trip re-validates, a forged field is refused', () => {
  const fields = pushFields({ claim_refs: ['claim://a'] });
  const before = structuredClone(fields);
  const p = buildMarketingPushProposal({ tenant: tenant(), finding: F, asOf: ASOF, ...fields });
  assert.ok(isDeepFrozen(p)); // 106
  assert.deepEqual(structuredClone({ ...fields, lever_fitness: null }), structuredClone({ ...before, lever_fitness: null })); // 107
  assert.equal(Object.isFrozen(fields.audience), false);
  assert.equal(Object.isFrozen(fields.resource_requirements), false);
  assert.equal(Object.isFrozen(fields.measurement_plan), false);
  assert.equal(Object.isFrozen(F) && true, true); // the Finding was already frozen by M1 and is not mutated further
  const stored = JSON.parse(JSON.stringify(p));
  assert.equal(JSON.stringify(normalizeMarketingPushProposal(stored, { tenant: tenant(), finding: F })), JSON.stringify(p));
  for (const forged of [{ readiness: { status: 'READY_FOR_SOCLE', reason_codes: ['FORGED'] } }, { push_id: 'mpp_forged' }, { lead_time_fit: { ...p.lead_time_fit, status: 'NOT_FIT' } }, { finding_ref: 'mfd_other' }, { channels: ['EMAIL'] }]) {
    assert.equal(code(() => normalizeMarketingPushProposal({ ...stored, ...forged }, { tenant: tenant(), finding: F })), 'MKT_M2_PUSH_DERIVED_MISMATCH', Object.keys(forged)[0]);
  }
  assert.equal(code(() => normalizeMarketingPushProposal({ ...stored, winner: true }, { tenant: tenant(), finding: F })), 'MKT_UNKNOWN_KEY');
});

// ------------------------------------------------------------------ DO_NOTHING / TEST_SMALL (108-114)

test('DO_NOTHING: always present in the package, separate from the proposals, with reasons', () => {
  const p = push();
  const withEvidence = pkg([p], included(p)); // 108
  assert.deepEqual({ ...withEvidence.do_nothing }, { reason_codes: ['BASELINE_ACCEPTABLE'], evidence_refs: ['ev/base'] });
  assert.equal(withEvidence.proposals.some((x) => x.action_mode === 'DO_NOTHING'), false); // never a proposal
  assert.equal(code(() => pkg([p], { ...included(p), do_nothing: undefined })), 'MKT_M2_PACKAGE_DO_NOTHING_REQUIRED');
  assert.equal(code(() => pkg([p], { ...included(p), do_nothing: null })), 'MKT_M2_PACKAGE_DO_NOTHING_REQUIRED');
  assert.equal(code(() => pkg([p], { ...included(p), do_nothing: { reason_codes: [], evidence_refs: ['ev/x'] } })), 'MKT_M2_PACKAGE_DO_NOTHING_REQUIRED'); // 109
  assert.equal(code(() => pkg([p], { ...included(p), do_nothing: { evidence_refs: ['ev/x'] } })), 'MKT_M2_PACKAGE_DO_NOTHING_REQUIRED');
  assert.equal(code(() => pkg([p], { ...included(p), do_nothing: { reason_codes: ['WHY'], recommended: true } })), 'MKT_UNKNOWN_KEY');
  assert.deepEqual(pkg([p], { ...included(p), do_nothing: { reason_codes: ['WHY'] } }).do_nothing.evidence_refs, []); // evidence is optional when proposals exist
});

test('TEST_SMALL is always explicitly considered: INCLUDED points at a TEST_SMALL proposal, NOT_APPLICABLE is reasoned and evidenced', () => {
  const small = push();
  const action = push({ action_mode: 'ACTION', lever_family: 'OFFER' });
  const a = pkg([small, action], included(small)); // 110
  assert.deepEqual({ ...a.test_small_disposition }, { status: 'INCLUDED', proposal_ref: small.push_id });
  assert.equal(code(() => pkg([small, action], included(action))), 'MKT_M2_PACKAGE_TEST_SMALL_DISPOSITION_INVALID'); // 111: ACTION is not a TEST_SMALL
  assert.equal(code(() => pkg([small], { test_small_disposition: { status: 'INCLUDED', proposal_ref: 'mpp_unknown' } })), 'MKT_M2_PACKAGE_TEST_SMALL_DISPOSITION_INVALID');
  assert.equal(code(() => pkg([small], { test_small_disposition: { status: 'INCLUDED' } })), 'MKT_M2_PACKAGE_TEST_SMALL_DISPOSITION_INVALID'); // INCLUDED without proposal_ref
  const na = pkg([action]); // NOT_APPLICABLE is valid when no TEST_SMALL exists
  assert.deepEqual({ ...na.test_small_disposition }, { status: 'NOT_APPLICABLE', reason_codes: ['NOT_PROPOSED'], evidence_refs: ['ev/ts'] });
  assert.equal(code(() => pkg([action], { test_small_disposition: { status: 'NOT_APPLICABLE', evidence_refs: ['ev/ts'] } })), 'MKT_M2_PACKAGE_TEST_SMALL_DISPOSITION_INVALID'); // 112
  assert.equal(code(() => pkg([action], { test_small_disposition: { status: 'NOT_APPLICABLE', reason_codes: ['WHY'] } })), 'MKT_M2_PACKAGE_TEST_SMALL_DISPOSITION_INVALID'); // 113
  assert.equal(code(() => pkg([small], { test_small_disposition: { status: 'NOT_APPLICABLE', reason_codes: ['WHY'], evidence_refs: ['ev/x'] } })), 'MKT_M2_PACKAGE_TEST_SMALL_DISPOSITION_INVALID'); // contradicts a TEST_SMALL in the package
  assert.equal(code(() => pkg([small], { test_small_disposition: undefined })), 'MKT_M2_PACKAGE_TEST_SMALL_DISPOSITION_INVALID'); // 114: never silently skipped
  assert.equal(code(() => pkg([small], { test_small_disposition: { status: 'MAYBE' } })), 'MKT_M2_PACKAGE_TEST_SMALL_DISPOSITION_INVALID');
  assert.equal(code(() => pkg([small], { test_small_disposition: { status: 'INCLUDED', proposal_ref: small.push_id, winner: true } })), 'MKT_UNKNOWN_KEY');
});

// ------------------------------------------------------------------ Decision package (115-133)

test('Decision package: valid, deterministic, one finding, one tenant, one brand', () => {
  const p = push();
  const a = pkg([p], included(p)); // 115
  assert.match(a.package_id, /^mpk_[0-9a-f]{32}$/); // 116
  assert.equal(pkg([p], included(p)).package_id, a.package_id);
  assert.deepEqual([a.merchant_id, a.brand_id, a.finding_ref, a.schema_version, a.created_at], [M1, null, F.finding_id, M2_VERSION, '2026-10-08T13:00:00.000Z']);
  assert.notEqual(pkg([p], { ...included(p), do_nothing: { reason_codes: ['OTHER'] } }).package_id, a.package_id);
  // 117: another Finding
  const other = finding({ statement: 'A different problem entirely.' });
  const foreign = buildMarketingPushProposal({ tenant: tenant(), finding: other, asOf: ASOF, ...pushFields() });
  assert.equal(code(() => pkg([foreign], included(foreign))), 'MKT_M2_PACKAGE_SCOPE_MISMATCH');
  try { pkg([foreign], included(foreign)); } catch (e) { assert.equal(e.detail.scope, 'finding'); }
  // 118: another tenant (a Push whose merchant_id is another merchant's)
  const otherTenantFinding = finding({}, { merchantId: M2 });
  const otherTenantPush = buildMarketingPushProposal({ tenant: tenant(M2), finding: otherTenantFinding, asOf: ASOF, ...pushFields() });
  assert.equal(code(() => pkg([otherTenantPush], included(otherTenantPush))), 'MKT_M2_PACKAGE_SCOPE_MISMATCH');
  assert.equal(code(() => buildSocleDecisionPackage({ tenant: tenant(M2), finding: F, asOf: ASOF, ...pkgFields([p]) })), 'MKT_FINDING_TENANT_MISMATCH');
  // 119: another brand
  const scoped = finding({}, { scoped: true });
  const brandPush = buildMarketingPushProposal({ tenant: tenant(), finding: scoped, asOf: ASOF, ...pushFields() });
  assert.equal(code(() => pkg([brandPush], included(brandPush))), 'MKT_M2_PACKAGE_SCOPE_MISMATCH'); // brand-scoped Push in a merchant-wide package
  assert.equal(code(() => buildSocleDecisionPackage({ tenant: tenant(), finding: scoped, asOf: ASOF, ...pkgFields([p], included(p)) })), 'MKT_M2_PACKAGE_SCOPE_MISMATCH'); // merchant-wide Push in a brand package
  // each scope check in isolation: a Push that matches the package everywhere except ONE of merchant / brand / finding
  const tamper = (changes) => ({ ...JSON.parse(JSON.stringify(p)), ...changes });
  for (const [changes, scopeName] of [[{ merchant_id: M2 }, 'merchant'], [{ brand_id: B1 }, 'brand'], [{ finding_ref: 'mfd_other' }, 'finding']]) {
    assert.equal(code(() => pkg([tamper(changes)], included(p))), 'MKT_M2_PACKAGE_SCOPE_MISMATCH', scopeName);
    try { pkg([tamper(changes)], included(p)); assert.fail('x'); } catch (e) { assert.equal(e.detail.scope, scopeName); }
  }
  const okBrand = buildSocleDecisionPackage({ tenant: tenant(), finding: scoped, asOf: ASOF, ...pkgFields([brandPush], included(brandPush)) });
  assert.equal(okBrand.brand_id, B1);
  assert.equal(code(() => buildSocleDecisionPackage({ tenant: tenant(), brand: brandOf(M1, B2), finding: scoped, asOf: ASOF, ...pkgFields([brandPush], included(brandPush)) })), 'MKT_FINDING_BRAND_MISMATCH');
});

test('Decision package: duplicates, count, forged proposals and expiry are enforced', () => {
  const p = push();
  assert.equal(code(() => pkg([p, p], included(p))), 'MKT_M2_PACKAGE_DUPLICATE_PUSH'); // 120
  const many = Array.from({ length: 11 }, (_, i) => push({ lever_variant: `VARIANT_${i}` }));
  assert.equal(code(() => pkg(many, included(many[0]))), 'MKT_M2_PACKAGE_TOO_MANY_PROPOSALS');
  const ten = pkg(many.slice(0, 10), included(many[0]));
  assert.equal(ten.proposals.length, 10);
  const forged = { ...JSON.parse(JSON.stringify(p)), readiness: { status: 'READY_FOR_SOCLE', reason_codes: ['FORGED'] } };
  assert.equal(code(() => pkg([forged], included(p))), 'MKT_M2_PUSH_DERIVED_MISMATCH');
  // expiry: <= finding, <= every proposal
  assert.equal(pkg([p], { ...included(p), expires_at: p.expires_at }).expires_at, p.expires_at); // 121 / 122: equal allowed
  assert.equal(code(() => pkg([p], { ...included(p), expires_at: '2026-10-25T00:00:01Z' })), 'MKT_M2_PACKAGE_OUTLIVES_PROPOSAL'); // 122
  const longPush = push({ expires_at: '2026-10-30T12:00:00Z' });
  assert.equal(code(() => pkg([longPush], { ...included(longPush), expires_at: '2026-10-30T12:00:01Z' })), 'MKT_M2_PACKAGE_OUTLIVES_FINDING'); // 121
  assert.equal(pkg([longPush], { ...included(longPush), expires_at: '2026-10-30T12:00:00Z' }).expires_at, '2026-10-30T12:00:00.000Z');
  assert.equal(code(() => pkg([p], { ...included(p), expires_at: '2026-10-08T13:00:00Z' })), 'MKT_M2_PACKAGE_INVALID_EXPIRY');
  assert.equal(code(() => pkg([p], { ...included(p), expires_at: undefined })), 'MKT_M2_PACKAGE_INVALID_EXPIRY');
});

test('Decision package status: READY / NEEDS_EVIDENCE / NO_ELIGIBLE_MARKETING_ACTION / STALE are states, never decisions', () => {
  const ready = push({ lever_variant: 'READY_ONE' });
  const needs = push({ lever_variant: 'NEEDS_ONE', lever_fitness: allFit({ AUDIENCE_FIT: axisOf('UNKNOWN') }) });
  const notEligible = push({ lever_variant: 'NOT_ELIGIBLE_ONE', lever_fitness: allFit({ CHANNEL_FIT: axisOf('NOT_FIT') }) });
  assert.equal(pkg([ready, needs, notEligible], included(ready)).package_status, 'READY_FOR_SOCLE'); // 123: one READY is enough
  assert.equal(pkg([ready], included(ready)).package_status, 'READY_FOR_SOCLE');
  assert.equal(pkg([needs, notEligible], included(needs)).package_status, 'NEEDS_EVIDENCE'); // 124
  assert.equal(pkg([notEligible], included(notEligible)).package_status, 'NO_ELIGIBLE_MARKETING_ACTION'); // 125: all NOT_ELIGIBLE
  const hardSmall = push({ lever_variant: 'HARD_ONE', reversibility: { status: 'HARD_TO_REVERSE', reason_codes: ['PRINTED_RUN'] } });
  assert.equal(pkg([hardSmall], included(hardSmall)).package_status, 'NO_ELIGIBLE_MARKETING_ACTION');
  // 126: zero proposals only with an explicit, evidenced justification
  const empty = pkg([], { do_nothing: { reason_codes: ['NO_MARKETING_LEVER_FITS'], evidence_refs: ['ev/why'] } });
  assert.deepEqual([empty.package_status, empty.proposals.length], ['NO_ELIGIBLE_MARKETING_ACTION', 0]);
  assert.equal(code(() => pkg([], { do_nothing: { reason_codes: ['NO_MARKETING_LEVER_FITS'] } })), 'MKT_M2_PACKAGE_EMPTY_NEEDS_JUSTIFICATION');
  assert.equal(code(() => pkg([], { do_nothing: { reason_codes: ['NO_MARKETING_LEVER_FITS'], evidence_refs: [] } })), 'MKT_M2_PACKAGE_EMPTY_NEEDS_JUSTIFICATION');
  assert.equal(pkg(undefined, { do_nothing: { reason_codes: ['X'], evidence_refs: ['ev/why'] } }).proposals.length, 0);
  // 127: stale
  const a = pkg([ready], included(ready));
  assert.equal(evaluatePackageStatus(a, '2026-10-10T00:00:00Z'), 'READY_FOR_SOCLE');
  assert.equal(evaluatePackageStatus(a, a.expires_at), 'STALE');
  assert.equal(evaluatePackageStatus(a, '2026-12-01T00:00:00Z'), 'STALE');
  assert.equal(evaluatePackageStatus(empty, '2026-12-01T00:00:00Z'), 'STALE');
  assert.equal(code(() => evaluatePackageStatus(a)), 'MKT_INVALID_TIMESTAMP');
  assert.equal(code(() => evaluatePackageStatus({ proposals: [] }, ASOF)), 'MKT_INVALID_FIELD');
  // the status follows the live lead-time fit: it can degrade before the package expires
  const tight = push({ lever_variant: 'TIGHT', estimated_lead_time: { value: 5, unit: 'DAYS', basis: 'OWNER_DECIDED' }, valid_execution_window: { start: '2026-10-09T00:00:00Z', end: '2026-10-15T00:00:00Z' } });
  const t = pkg([tight], included(tight));
  assert.equal(t.package_status, 'READY_FOR_SOCLE');
  assert.equal(evaluatePackageStatus(t, '2026-10-12T00:00:00Z'), 'NO_ELIGIBLE_MARKETING_ACTION');
  // 'STALE' is also refused as a build-time finding state
  assert.equal(code(() => buildSocleDecisionPackage({ tenant: tenant(), finding: F, asOf: '2026-11-15T00:00:00Z', ...pkgFields([]) })), 'MKT_M2_FINDING_NOT_READY');
});

test('Decision package: no winner, no ranking, no score, no selected or recommended option; order carries no meaning', () => {
  const a = push({ lever_variant: 'AAA' });
  const b = push({ lever_variant: 'BBB', lever_family: 'OFFER' });
  const c = push({ lever_variant: 'CCC', lever_family: 'SEARCH_LOCAL' });
  const p1 = pkg([a, b, c], included(a));
  const p2 = pkg([c, a, b], included(a));
  assert.equal(p1.package_id, p2.package_id); // same set, same package, whatever the input order
  assert.deepEqual(p1.proposals.map((x) => x.push_id), [...p1.proposals.map((x) => x.push_id)].sort()); // canonical order: by id, not by merit
  const keys = keysDeep(p1);
  for (const forbidden of ['winner', 'best_option', 'recommended_option', 'selected_option', 'ranking_score', 'rank', 'score', 'recommendation', 'chosen', 'preferred', 'priority']) {
    assert.equal(keys.has(forbidden), false, forbidden); // 128 / 129 / 130
    assert.equal(code(() => pkg([a], { ...included(a), [forbidden]: 'x' })), 'MKT_UNKNOWN_KEY', forbidden);
  }
  everyObject(p1.do_nothing, (o) => Object.values(o).forEach((v) => assert.notEqual(typeof v, 'number')));
  assert.deepEqual(Object.keys(p1), ['package_id', 'schema_version', 'merchant_id', 'brand_id', 'finding_ref', 'created_at', 'expires_at', 'proposals', 'do_nothing', 'test_small_disposition', 'unresolved_requirement_refs', 'review_signals', 'package_status']);
  assert.notEqual(p1.do_nothing, undefined); // 131
  assert.notEqual(p1.test_small_disposition, undefined); // 132
  assert.ok(isDeepFrozen(p1)); // 133
});

test('Decision package: what is still unresolved is made visible for the Socle, not resolved', () => {
  const rich = push({
    lever_variant: 'RICH', action_mode: 'ACTION', audience: { mode: 'DEFINITION', criteria_refs: ['criteria://recent-buyers'] },
    resource_requirements: {
      cash: { currency: 'EUR', min: 0, max: 100, basis: 'OWNER_DECIDED' }, inventory_requirement_refs: ['inventory://case-x'],
      operational_capacity_refs: ['capacity://print-week'], human_time: { min_minutes: 10, max_minutes: 20, basis: 'OWNER_DECIDED' },
    },
    claim_refs: ['claim://a'], policy_requirement_refs: ['policy://promo'], consent_requirement_refs: ['consent://optin'], promotion_rule_refs: ['promo-rule://r'],
    unknown_refs: ['unknown://margin'], reversibility: { status: 'HARD_TO_REVERSE', reason_codes: ['PRINTED'] },
  });
  const unknownRev = push({ reversibility: { status: 'UNKNOWN', reason_codes: ['NOT_ASSESSED'] } });
  const a = pkg([rich, unknownRev], included(unknownRev));
  assert.deepEqual(a.review_signals, ['FINANCE_VERDICT_REQUIRED', 'INVENTORY_VERDICT_REQUIRED', 'CAPACITY_VERDICT_REQUIRED', 'POLICY_CLEARANCE_REQUIRED', 'REVERSIBILITY_UNKNOWN', 'HARD_TO_REVERSE_PRESENT']);
  for (const ref of ['claim://a', 'policy://promo', 'consent://optin', 'promo-rule://r', 'unknown://margin', 'capacity://print-week', 'inventory://case-x', 'criteria://recent-buyers']) {
    assert.ok(a.unresolved_requirement_refs.includes(ref), ref);
  }
  assert.deepEqual(a.unresolved_requirement_refs, [...new Set(a.unresolved_requirement_refs)]);
  assert.deepEqual(pkg([push()], included(push())).review_signals, ['CAPACITY_VERDICT_REQUIRED']); // the human_time of the default fixture
  assert.deepEqual(pkg([push({ resource_requirements: {} })], included(push({ resource_requirements: {} }))).review_signals, []);
  assert.equal(a.package_status, 'READY_FOR_SOCLE'); // visible, never a verdict
});

// ------------------------------------------------------------------ Domain boundaries (134-147)

test('Domain boundaries: M2 exposes proposal contracts only - no finance, inventory, customer, creative, guardian, publish, send, ads, price, stock or approval function', async () => {
  const exported = Object.keys(m2).join(' ');
  assert.doesNotMatch(exported, /publish|send|buyAds|buy_ads|changePrice|setPrice|changeStock|execute|approve|authoriz|reserve|recommend|rank|select|winner|margin|budget|stock|profit|cac/i); // 134-144
  const allowedFunctions = [
    'assessLeverFitness', 'normalizeLeverFitness', 'buildResourceRequirements', 'buildEstimatedLeadTime', 'buildExecutionWindow', 'evaluateLeadTimeFit',
    'buildMeasurementPlan', 'buildReversibility', 'buildAudienceIntent', 'buildMarketingPushProposal', 'normalizeMarketingPushProposal',
    'evaluatePushReadiness', 'buildSocleDecisionPackage', 'evaluatePackageStatus',
  ];
  assert.deepEqual(Object.entries(m2).filter(([, v]) => typeof v === 'function').map(([k]) => k).sort(), [...allowedFunctions].sort());
  for (const name of M2_FILES) {
    const text = await read(name);
    for (const spec of [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1])) {
      assert.doesNotMatch(spec, /creative|guardian|fidelity|inventory|finance|customers|metrics|sync|shopify|supabase|connectors|branding/i, `${name} imports ${spec}`); // 137 / 138 / 134-136
    }
  }
  // Marketing does not compute: the only arithmetic M2 owns is the lead-time completion and range checks
  const resources = stripComments(await read('resource-requirements'));
  assert.doesNotMatch(resources, /\.reduce\(|Math\.(sum|avg)|\*\s*0\.\d|margin|stock|available|\bcac\b|roas|profit/i);
});

test('Static scope: no clock, randomness, network, database, filesystem, LLM or merchant-specific code in any M2 file', async () => {
  for (const name of M2_FILES) {
    const code_ = stripComments(await read(name));
    assert.doesNotMatch(code_, /Date\.now|new Date\(\)|Math\.random|randomUUID|process\.env|fetch\(|axios|XMLHttpRequest|require\(|writeFile|readFile|createClient|supabase/i, name); // 145 / 146
    assert.doesNotMatch(code_, /openai|anthropic|gemini|qwen|\bprompt\b/i, name); // 147
    assert.doesNotMatch(code_, /\bpublish\b|\bsend\b|buyAds|selected_option|\bwinner\b|\bscore\b/i, name);
    assert.doesNotMatch(await read(name), /habb|shopify|namur|belgi/i, name);
  }
  // the only time M2 reads is through an explicit asOf; the new Date(...) calls all have an argument
  for (const name of ['resource-requirements', 'push-proposal', 'socle-decision-package']) {
    for (const call of (await read(name)).matchAll(/new Date\(([^)]*)\)/g)) assert.notEqual(call[1].trim(), '', `${name}: new Date() without argument`);
  }
});

// ------------------------------------------------------------------ Non-regression (148-151)

test('Non-regression: M1, M1.5 and Measurement keep exactly their public surface; M2 added no field to them', async () => {
  assert.deepEqual(Object.keys(understand).sort(), [
    'AXIS_NOT_ASSESSED', 'CITED_SIGNAL_EXPIRED', 'CONTEXT_INPUT_CATEGORY', 'CONTEXT_VERSION', 'DOMAIN_FIT_STATUS', 'FINDING_TYPE', 'FRESHNESS',
    'MATERIALITY_AXIS', 'MATERIALITY_OVERALL', 'MATERIALITY_STATUS', 'MKT_ERROR', 'MarketingUnderstandError', 'READINESS', 'RESERVED_SIGNAL_TYPES',
    'SIGNAL_CLASS', 'SIGNAL_CLASS_LIMITATION', 'TARGET_DOMAIN', 'TESTABILITY', 'UNDERSTAND_VERSION', 'assessMateriality', 'buildDomainFit',
    'buildMarketSignal', 'buildMarketingContext', 'buildMarketingFinding', 'evaluateFindingReadiness', 'findingFreshness', 'isMarketSignalExpired',
    'marketSignalFreshness', 'normalizeMarketSignal', 'normalizeMarketingFinding', 'normalizeMaterialityAssessment',
  ].sort()); // 148
  assert.deepEqual(Object.keys(lostDemand).sort(), ['LOST_DEMAND_KIND', 'LOST_DEMAND_SIGNAL_TYPE', 'produceLostDemandSignal']); // 149
  assert.deepEqual(Object.keys(calendarSignals).sort(), ['CALENDAR_KIND', 'CALENDAR_SIGNAL_TYPE', 'produceCalendarSignal']);
  assert.deepEqual(Object.keys(manualObservation).sort(), ['produceManualObservationSignal']);
  assert.deepEqual(Object.keys(signalProducer).sort(), ['PRODUCER_ERROR', 'isMissing', 'produceMarketSignal', 'requireField']);
  assert.deepEqual(Object.keys(phase3), ['phase3Inputs']); // 150
  assert.equal(typeof measurementBuild.buildMarketingFacts, 'function');
  // internal modules stay internal: M2 internals are not on the public M2 surface
  for (const internal of ['gateFinding', 'readinessOf', 'canonical', 'nonNegativeNumber', 'numberBasis']) assert.equal(internal in m2, false, internal);
  assert.equal(typeof pushModule.gateFinding, 'function'); // shared between M2 modules only
  assert.equal(typeof packageModule.buildSocleDecisionPackage, 'function');
  assert.equal(typeof leverFitnessModule.assessLeverFitness, 'function');
  assert.equal(typeof resourceModule.evaluateLeadTimeFit, 'function');
  assert.equal(typeof measurementModule.buildMeasurementPlan, 'function');
  // M2 consumes real M1.5 signals through the unchanged M1 pipeline (a signal is only ever evidence, never a Push)
  const signal = buildMarketSignal({
    tenant: tenant(), signal_class: 'INTERNAL_MEASUREMENT', signal_type: 'LOST_DEMAND_ZERO_RESULT_SEARCH', subject_refs: ['query://charger'], source_ref: 'site-search/export-1',
    detected_at: '2026-10-08T10:00:00Z', expires_at: '2026-10-22T10:00:00Z', evidence_refs: ['ev/1'], provenance: { source_system: 'trusted_adapter', completeness: 'PARTIAL', evidence_kind: 'observed' },
  });
  const ctx = buildMarketingContext({ tenant: tenant(), asOf: FINDING_AT, marketSignals: [signal] });
  const f = buildMarketingFinding({
    tenant: tenant(), context: ctx, finding_type: 'OPPORTUNITY', subject_refs: ['query://charger'], statement: 'Searches with no result.',
    window: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' }, evidence_refs: [signal.signal_id], materiality: mat(), domain_fit: fitOf(),
    created_at: FINDING_AT, expires_at: '2026-10-22T10:00:00Z',
  });
  const p = buildMarketingPushProposal({ tenant: tenant(), finding: f, asOf: ASOF, ...pushFields({ expires_at: '2026-10-22T10:00:00Z' }) });
  assert.equal(p.finding_ref, f.finding_id);
  assert.equal(code(() => buildMarketingPushProposal({ tenant: tenant(), finding: f, asOf: ASOF, ...pushFields({ expires_at: '2026-10-22T10:00:01Z' }) })), 'MKT_M2_PUSH_OUTLIVES_FINDING'); // the M1 evidence bound still reaches M2
  // 151: the full suite (npm test, CI "Marketing V1") must stay green - asserted by the CI run, not by this file
});

// ------------------------------------------------------------------ coverage matrix (doc <-> tests)

test('Coverage matrix: the doc maps all 151 mandate cases, and every test it names exists', async () => {
  const doc = await readFile(new URL('../docs/architecture/marketing-m2-build-contract.md', import.meta.url), 'utf8');
  const self = await readFile(new URL(import.meta.url), 'utf8');
  const matrix = doc.slice(doc.indexOf('<!-- coverage-matrix:start -->'), doc.indexOf('<!-- coverage-matrix:end -->'));
  const rows = [...matrix.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ n: Number(m[1]), name: m[3] }));
  assert.deepEqual(rows.map((r) => r.n), Array.from({ length: 151 }, (_, i) => i + 1));
  for (const { n, name } of rows) {
    const known = name.startsWith('(CI)') || self.includes(`test('${name}'`);
    assert.ok(known, `mandate case ${n} names a test that does not exist: ${name}`);
  }
});
