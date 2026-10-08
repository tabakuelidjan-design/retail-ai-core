import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as m3 from '../src/marketing/m3.js';
import * as m2 from '../src/marketing/m2.js';
import * as understand from '../src/marketing/understand.js';
import * as lostDemand from '../src/marketing/lost-demand.js';
import * as calendarSignals from '../src/marketing/calendar-signals.js';
import * as manualObservation from '../src/marketing/manual-observation.js';
import * as phase3 from '../src/marketing/phase3-contract.js';
import * as measurementBuild from '../src/marketing/build.js';
import {
  ACTIVATION_READINESS, BRIEF_READINESS, MARKETING_CREATE_VERSION, VALIDATION_STATUS, buildActivationManifest, buildCreativeBrief,
  buildCreativeHandoff, buildCreativeValidationReport, evaluateActivationReadiness, evaluateBriefReadiness, evaluateCreateGate,
  normalizeActivationManifest, normalizeCreativeBrief, normalizeSelectedCreativeCandidate, normalizeSocleCreateAuthorization,
} from '../src/marketing/m3.js';
import {
  MarketingUnderstandError, assessMateriality, buildMarketingContext, buildMarketingFinding,
} from '../src/marketing/understand.js';
import { assessLeverFitness, buildMarketingPushProposal, buildSocleDecisionPackage } from '../src/marketing/m2.js';
import {
  approveBrandCore, approveBrandMemory, buildBrandContext, buildBrandCoreProposal, buildBrandIdentity, buildBrandMemoryDraft,
  creativeBrandInterface, fidelityGateObservation, normalizeBrandSnapshot, submitBrandMemoryForReview,
} from '../src/branding/index.js';
import { evaluateHardFidelityGate } from '../src/creative-fidelity/fidelity-gates.js';

// ------------------------------------------------------------------ fixtures
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tenant = (merchantId = M1) => ({ merchantId, source: 'env' });
const FINDING_AT = '2026-10-08T12:00:00Z';
const M2_AT = '2026-10-08T13:00:00Z';
const T = '2026-10-09T10:00:00Z'; // the M3 clock

const brandOf = (merchantId, brandId) => buildBrandIdentity({
  tenant: tenant(merchantId), brandId, name: 'Brand', createdAt: '2026-10-01T09:00:00Z', defaultLocale: 'fr-BE', supportedLocales: ['fr-BE', 'nl-BE'],
});

const colorRule = { id: 'r1', rule_type: 'COLOR', subject: 'logo.color', operator: 'EQUALS', value: '#112233', severity: 'BLOCK', scope: 'GLOBAL', source_ref: 'brand-core://core-v1' };
const gateRule = { id: 'g1', rule_type: 'EXTERNAL_GATE', subject: 'product_fidelity', operator: 'STATUS_IN', value: ['PASS'], severity: 'BLOCK', scope: 'IMAGE', source_ref: 'brand-core://core-v1' };

// A real Core -> Memory -> Context flow, as Branding itself builds it.
function readyBrandContext({ merchantId = M1, brandId = B1, rules = [colorRule] } = {}) {
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
  const draft = buildBrandMemoryDraft({ tenant: t, brand, id: 'mem-v1', createdAt: '2026-10-08T12:00:00Z', core, content: { hard_rules: rules, design_tokens: { colors: { primary: '#112233' } } } }).memory;
  const reviewed = submitBrandMemoryForReview({ memory: draft, core, tenant: t, brand });
  const memory = approveBrandMemory({ memory: reviewed, core, tenant: t, brand, resolvedActor: actor, approvedAt: '2026-10-08T13:00:00Z' }).approvedMemory;
  return buildBrandContext({ tenant: t, brand, core, memory });
}
const BRAND = readyBrandContext();
const BRAND_GATE = readyBrandContext({ rules: [colorRule, gateRule] });
const GATED = buildBrandContext({ tenant: tenant(), brand: brandOf(M1, B1), core: null, memory: null });

const axisOf = (status) => ({ status, reason_codes: ['REASON'], evidence_refs: ['ev/fit'] });
const allFit = (over = {}) => assessLeverFitness({ FINDING_FIT: axisOf('FIT'), AUDIENCE_FIT: axisOf('FIT'), CHANNEL_FIT: axisOf('FIT'), MEASUREMENT_FIT: axisOf('FIT'), ...over });
const plan = { baseline_ref: 'metric/baseline', primary_metric_ref: 'metric/orders', observation_window: { start: '2026-10-10T00:00:00Z', end: '2026-10-24T00:00:00Z' }, control_method: 'TIME', eligibility_status: 'ELIGIBLE', success_criterion_ref: 'criterion/ok', failure_criterion_ref: 'criterion/ko' };
const pushFields = (over = {}) => ({
  action_mode: 'TEST_SMALL', lever_family: 'VISIBILITY', objective: 'Make the unserved demand visible in store.', subject_refs: ['category://phone-cases'],
  audience: { mode: 'GENERAL' }, channels: ['STORE_FRONT'], lever_fitness: allFit(), resource_requirements: {},
  estimated_lead_time: { value: 2, unit: 'DAYS', basis: 'OWNER_DECIDED' }, valid_execution_window: { start: '2026-10-09T00:00:00Z', end: '2026-10-20T00:00:00Z' },
  measurement_plan: plan, claim_refs: ['claim://approved-1'], policy_requirement_refs: ['policy://promo'], consent_requirement_refs: ['consent://optin'],
  promotion_rule_refs: ['promo-rule://threshold'], reversibility: { status: 'FULLY_REVERSIBLE', reason_codes: ['REMOVABLE'] }, expires_at: '2026-10-25T00:00:00Z', ...over,
});

// A brand-scoped M1 Finding (the only way to obtain one), then M2 Push -> Package, then the Socle authorization (given, never built here).
const findingFor = ({ merchantId = M1, brandId = B1, brandContext = BRAND, over = {} } = {}) => {
  const t = tenant(merchantId);
  const ctx = brandId
    ? buildMarketingContext({ tenant: t, asOf: FINDING_AT, brandId, brandContext })
    : buildMarketingContext({ tenant: t, asOf: FINDING_AT });
  return buildMarketingFinding({
    tenant: t, context: ctx, finding_type: 'OPPORTUNITY', subject_refs: ['category://phone-cases'], statement: 'Demand that the offer does not serve.',
    window: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' }, evidence_refs: ['ev/1'],
    materiality: assessMateriality({ CUSTOMER: { status: 'MATERIAL', reason_codes: ['R'], evidence_refs: ['ev/1'] } }),
    domain_fit: { status: 'MARKETING_RELEVANT', reason_codes: ['FITS'] }, created_at: FINDING_AT, expires_at: '2026-10-30T12:00:00Z', ...over,
  });
};
const FINDING = findingFor();
const pushOf = (finding_ = FINDING, over = {}) => buildMarketingPushProposal({ tenant: tenant(finding_.merchant_id), finding: finding_, asOf: M2_AT, ...pushFields(over) });
const packageOf = (finding_, proposals, testSmall) => buildSocleDecisionPackage({
  tenant: tenant(finding_.merchant_id), finding: finding_, asOf: M2_AT, proposals, do_nothing: { reason_codes: ['BASELINE_OK'], evidence_refs: ['ev/base'] },
  test_small_disposition: testSmall ?? { status: 'INCLUDED', proposal_ref: proposals[0].push_id }, expires_at: '2026-10-24T00:00:00Z',
});
const authFor = (pkg_, push_, over = {}) => ({
  authorization_ref: 'auth://create-1', decision_ref: 'decision://socle-1', package_ref: pkg_.package_id, push_ref: push_.push_id, scope: 'CREATE', status: 'APPROVED',
  authorized_at: '2026-10-08T13:30:00Z', expires_at: '2026-10-22T00:00:00Z', ...over,
});
const PUSH = pushOf();
const PKG = packageOf(FINDING, [PUSH]);
const AUTH = authFor(PKG, PUSH);

const ctx = (over = {}) => ({ tenant: tenant(), finding: FINDING, decisionPackage: PKG, push: PUSH, authorization: AUTH, brandContext: BRAND, asOf: T, ...over });

const dImage = (over = {}) => ({
  content_kind: 'IMAGE', channel: 'STORE_FRONT', placement: 'WINDOW_POSTER', format_ref: 'format://poster-a3', locale: 'fr-BE', needed_by: '2026-10-15T00:00:00Z',
  source_asset_refs: ['asset://product-1'], mandatory_content_refs: ['content://legal-line'], requirement_refs: ['req://print-ready'], ...over,
});
const dText = (over = {}) => ({ content_kind: 'TEXT', channel: 'STORE_FRONT', placement: 'STORE_POSTER', format_ref: 'format://caption', locale: 'nl-BE', needed_by: '2026-10-14T00:00:00Z', ...over });
const briefFields = (over = {}) => ({
  message_intent: 'Make the unserved demand visible.', cta_intent: 'Invite people to ask in store.', deliverables: [dImage(), dText()],
  source_asset_refs: ['asset://product-1'], mandatory_content_refs: ['content://legal-line'], prohibited_content_refs: ['content://forbidden-claims'],
  locales: ['fr-BE', 'nl-BE'], brief_limitations: ['DRAFT_INTENT'], expires_at: '2026-10-20T00:00:00Z', ...over,
});
const brief = (over = {}, c = ctx()) => buildCreativeBrief({ ...c, ...briefFields(over) });
const BRIEF = brief();
const imageSpec = BRIEF.deliverables.find((d) => d.content_kind === 'IMAGE');
const textSpec = BRIEF.deliverables.find((d) => d.content_kind === 'TEXT');

const candidateOf = (spec, over = {}) => ({
  candidate_id: `cand-${spec.content_kind.toLowerCase()}-1`, merchant_id: M1, brand_id: B1, brief_ref: BRIEF.brief_id, deliverable_ref: spec.deliverable_id,
  selection_ref: 'selection://ci-run-1', content_kind: spec.content_kind, channel: spec.channel, asset_refs: ['asset://out-1'], provenance_ref: 'provenance://ci-run-1',
  selected_at: '2026-10-10T09:00:00Z', candidate_expires_at: '2026-10-18T00:00:00Z', ...over,
});
const manifestOf = (kind, color = '#112233') => ({ content_kind: kind, colors: [{ subject: 'logo.color', coverage: 'COMPLETE', values: [color], evidence_refs: ['ev/color'] }] });
const entryOf = (spec, { color, over, semanticAssessment, validation } = {}) => ({
  candidate: candidateOf(spec, over), candidateManifest: manifestOf(spec.content_kind, color), ...(semanticAssessment ? { semanticAssessment } : {}), ...(validation ? { validation } : {}),
});
const ENTRIES = [entryOf(imageSpec), entryOf(textSpec)];
const manifestFields = (over = {}) => ({ candidates: ENTRIES, activation_window: { start: '2026-10-12T00:00:00Z', end: '2026-10-17T00:00:00Z' }, expires_at: '2026-10-18T00:00:00Z', ...over });
const activation = (over = {}, c = ctx()) => buildActivationManifest({ ...c, brief: BRIEF, ...manifestFields(over) });
const MANIFEST = activation();
const live = (over = {}) => ({ ...ctx(), brief: BRIEF, candidates: ENTRIES, ...over });

const code = (fn) => {
  try { fn(); } catch (error) { assert.ok(error instanceof MarketingUnderstandError, `expected MarketingUnderstandError, got ${error}`); return error.code; }
  assert.fail('expected an error');
  return null;
};
const detailOf = (fn) => { try { fn(); } catch (error) { return error.detail; } return assert.fail('expected an error'); };
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));
const everyObject = (v, visit) => { if (v && typeof v === 'object') { visit(v); Object.values(v).forEach((x) => everyObject(x, visit)); } };
const keysDeep = (v, out = new Set()) => { everyObject(v, (o) => Object.keys(o).forEach((k) => out.add(k))); return out; };
const read = (name) => readFile(new URL(`../src/marketing/${name}.js`, import.meta.url), 'utf8');
const M3_FILES = ['m3-constants', 'm3-validation', 'create-authorization', 'create-gate', 'creative-brief', 'creative-handoff', 'creative-candidate', 'creative-validation', 'activation-manifest', 'm3'];
const stripComments = (text) => text.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*')).join('\n');
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------ Authorization (1-12)

test('Authorization: a valid CREATE authorization is accepted; scope, status, refs, window and bounds are enforced', () => {
  const ok = normalizeSocleCreateAuthorization(AUTH, { decisionPackage: PKG, push: PUSH }); // 1
  assert.deepEqual({ ...ok }, { ...AUTH, authorized_at: '2026-10-08T13:30:00.000Z', expires_at: '2026-10-22T00:00:00.000Z' });
  const norm = (over) => normalizeSocleCreateAuthorization(authFor(PKG, PUSH, over), { decisionPackage: PKG, push: PUSH });
  assert.equal(code(() => norm({ scope: 'PUBLISH' })), 'MKT_M3_AUTH_INVALID_SCOPE'); // 2
  assert.equal(code(() => norm({ scope: 'create' })), 'MKT_M3_AUTH_INVALID_SCOPE');
  assert.equal(code(() => norm({ status: 'PENDING' })), 'MKT_M3_AUTH_INVALID_STATUS'); // 3
  assert.equal(code(() => norm({ status: 'REJECTED' })), 'MKT_M3_AUTH_INVALID_STATUS');
  assert.equal(code(() => norm({ package_ref: 'mpk_other' })), 'MKT_M3_AUTH_PACKAGE_MISMATCH'); // 4
  assert.equal(code(() => norm({ push_ref: 'mpp_other' })), 'MKT_M3_AUTH_PUSH_MISMATCH'); // 5
  assert.equal(code(() => norm({ authorized_at: '2026-10-22T00:00:01Z' })), 'MKT_M3_AUTH_INVALID_WINDOW'); // 6
  assert.equal(norm({ authorized_at: '2026-10-22T00:00:00Z' }).authorized_at, '2026-10-22T00:00:00.000Z'); // equal is allowed by the rule
  assert.equal(code(() => norm({ expires_at: '2026-10-25T00:00:01Z' })), 'MKT_M3_AUTH_OUTLIVES_PUSH'); // 7
  assert.equal(norm({ expires_at: PKG.expires_at }).expires_at, PKG.expires_at); // equal to the package expiry (the tighter bound) is allowed
  assert.equal(code(() => norm({ expires_at: '2026-10-24T00:00:01Z' })), 'MKT_M3_AUTH_OUTLIVES_PACKAGE'); // 8: after the package, before the Push
  for (const key of ['approved_by', 'budget', 'campaign', 'model']) assert.equal(code(() => norm({ [key]: 'x' })), 'MKT_UNKNOWN_KEY', key); // 10
  assert.equal(code(() => norm({ authorization_ref: 'has space' })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => norm({ decision_ref: 'https://x.example/decision' })), 'MKT_INVALID_FIELD'); // an opaque ref, not a location
  assert.ok(isDeepFrozen(ok)); // 11
  assert.equal(code(() => normalizeSocleCreateAuthorization(AUTH, {})), 'MKT_INVALID_FIELD');
});

test('Authorization: staleness is a live property, and Marketing never creates an authorization', () => {
  const expired = evaluateCreateGate(ctx({ asOf: '2026-10-22T00:00:00Z' })); // 9: asOf >= expires_at
  assert.equal(expired.status, 'STALE');
  assert.deepEqual([...expired.reason_codes], ['AUTHORIZATION_EXPIRED']);
  assert.equal(evaluateCreateGate(ctx({ asOf: '2026-10-08T13:00:00Z' })).status, 'NOT_AUTHORIZED'); // not valid yet (authorized_at in the future)
  // 12: nothing creates, issues, grants or derives an authorization
  const names = Object.keys(m3);
  assert.deepEqual(names.filter((n) => typeof m3[n] === 'function' && /^(build|create|issue|grant|derive|mint|make|generate|approve|authorize)\w*Authorization/i.test(n)), []);
  assert.deepEqual(names.filter((n) => typeof m3[n] === 'function' && /Authorization/.test(n)), ['normalizeSocleCreateAuthorization']); // the only authorization function validates a form
  assert.equal(code(() => buildCreativeBrief({ ...ctx({ authorization: undefined }), ...briefFields() })), 'MKT_M3_CREATE_NOT_READY');
  assert.equal(detailOf(() => buildCreativeBrief({ ...ctx({ authorization: null }), ...briefFields() })).status, 'NOT_AUTHORIZED');
  assert.deepEqual([...evaluateCreateGate(ctx({ authorization: null })).reason_codes], ['AUTHORIZATION_MISSING']);
});

// ------------------------------------------------------------------ Live pre-create gate (13-27)

test('Live gate: a live-ready package and Push, a valid authorization and a READY Brand Context give READY_FOR_CREATIVE', () => {
  const gate = evaluateCreateGate(ctx());
  assert.deepEqual({ ...gate, reason_codes: [...gate.reason_codes] }, { status: 'READY_FOR_CREATIVE', reason_codes: ['AUTHORIZED_READY_BRANDED'] }); // 13 / 15 / 24
  assert.equal(PKG.package_status, 'READY_FOR_SOCLE');
  assert.equal(m2.evaluatePackageStatus(PKG, { tenant: tenant(), finding: FINDING, asOf: T }), 'READY_FOR_SOCLE'); // the live M2 answers the gate relies on
  assert.equal(m2.evaluatePushReadiness(PUSH, { tenant: tenant(), finding: FINDING, asOf: T }).status, 'READY_FOR_SOCLE');
  assert.ok(isDeepFrozen(gate));
});

test('Live gate: a stale package, Push, authorization or Finding refuses CREATE', () => {
  const at = (asOf) => evaluateCreateGate(ctx({ asOf }));
  const reasons = (asOf) => [...at(asOf).reason_codes];
  assert.equal(at('2026-10-24T00:00:00Z').status, 'STALE'); // 14
  assert.ok(reasons('2026-10-24T00:00:00Z').includes('PACKAGE_EXPIRED'));
  assert.ok(!reasons('2026-10-24T00:00:00Z').includes('PUSH_EXPIRED')); // the Push (10-25) outlives its package (10-24)
  assert.ok(reasons('2026-10-25T00:00:00Z').includes('PUSH_EXPIRED')); // 16
  assert.ok(reasons('2026-10-22T00:00:00Z').includes('AUTHORIZATION_EXPIRED'));
  assert.ok(reasons('2026-10-30T12:00:00Z').includes('FINDING_EXPIRED'));
  assert.equal(code(() => buildCreativeBrief({ ...ctx({ asOf: '2026-10-25T00:00:00Z' }), ...briefFields() })), 'MKT_M3_CREATE_NOT_READY');
  assert.equal(detailOf(() => buildCreativeBrief({ ...ctx({ asOf: '2026-10-25T00:00:00Z' }), ...briefFields() })).status, 'STALE');
});

test('Live gate: a Push that needs evidence or is not eligible refuses CREATE (PUSH_NOT_READY)', () => {
  for (const [label, over, expected] of [
    ['NEEDS_EVIDENCE', { lever_fitness: allFit({ AUDIENCE_FIT: axisOf('UNKNOWN') }) }, 'PUSH_NEEDS_EVIDENCE'], // 17
    ['NOT_ELIGIBLE', { lever_fitness: allFit({ CHANNEL_FIT: axisOf('NOT_FIT') }) }, 'PUSH_NOT_ELIGIBLE'], // 18
  ]) {
    const weak = pushOf(FINDING, { lever_variant: label, ...over });
    const pkg_ = packageOf(FINDING, [PUSH, weak]); // the package is READY thanks to the other Push
    const c = ctx({ decisionPackage: pkg_, push: weak, authorization: authFor(pkg_, weak) });
    const gate = evaluateCreateGate(c);
    assert.equal(gate.status, 'PUSH_NOT_READY', label);
    assert.ok([...gate.reason_codes].includes(expected), label);
    assert.equal(code(() => buildCreativeBrief({ ...c, ...briefFields() })), 'MKT_M3_CREATE_NOT_READY', label);
  }
  // a package that is itself not ready cannot carry a CREATE either
  const onlyWeak = pushOf(FINDING, { lever_variant: 'ONLY', lever_fitness: allFit({ AUDIENCE_FIT: axisOf('UNKNOWN') }) });
  const weakPkg = packageOf(FINDING, [onlyWeak]);
  const gate = evaluateCreateGate(ctx({ decisionPackage: weakPkg, push: onlyWeak, authorization: authFor(weakPkg, onlyWeak) }));
  assert.equal(gate.status, 'PUSH_NOT_READY');
  assert.ok([...gate.reason_codes].includes('PACKAGE_NEEDS_EVIDENCE'));
});

test('Live gate scope: the Push must be in the package; tenant, brand and Finding must match; a brandless Push is refused', () => {
  const stranger = pushOf(FINDING, { lever_variant: 'STRANGER' });
  assert.equal(code(() => evaluateCreateGate(ctx({ push: stranger, authorization: authFor(PKG, stranger) }))), 'MKT_M3_PUSH_NOT_IN_PACKAGE'); // 19
  assert.equal(code(() => evaluateCreateGate(ctx({ tenant: tenant(M2) }))), 'MKT_FINDING_TENANT_MISMATCH'); // 20
  assert.equal(code(() => evaluateCreateGate(ctx({ brandContext: readyBrandContext({ brandId: B2 }) }))), 'MKT_M3_BRAND_MISMATCH'); // 21: READY, but another brand
  const otherFinding = findingFor({ over: { statement: 'A different problem entirely.' } }); // 22
  assert.equal(code(() => evaluateCreateGate(ctx({ finding: otherFinding }))), 'MKT_M2_PUSH_DERIVED_MISMATCH');
  const otherPush = pushOf(otherFinding);
  const otherPkg = packageOf(otherFinding, [otherPush]);
  assert.equal(code(() => evaluateCreateGate(ctx({ decisionPackage: otherPkg, authorization: authFor(otherPkg, PUSH) }))), 'MKT_M2_PACKAGE_SCOPE_MISMATCH');
  // 23: brandless
  const brandless = findingFor({ brandId: null });
  const brandlessPush = pushOf(brandless);
  const brandlessPkg = packageOf(brandless, [brandlessPush]);
  assert.equal(brandlessPush.brand_id, null);
  assert.equal(code(() => evaluateCreateGate(ctx({ finding: brandless, push: brandlessPush, decisionPackage: brandlessPkg, authorization: authFor(brandlessPkg, brandlessPush) }))), 'MKT_M3_BRAND_REQUIRED');
  assert.equal(code(() => buildCreativeBrief({ ...ctx({ finding: brandless, push: brandlessPush, decisionPackage: brandlessPkg, authorization: authFor(brandlessPkg, brandlessPush) }), ...briefFields() })), 'MKT_M3_BRAND_REQUIRED');
});

test('Live gate: a Brand Context that is missing, GATED or not rebuildable is BRAND_GATED, and a flag alone is not trusted', () => {
  assert.equal(BRAND.status, 'READY');
  assert.equal(GATED.status, 'GATED');
  const gated = evaluateCreateGate(ctx({ brandContext: GATED })); // 25
  assert.deepEqual({ ...gated, reason_codes: [...gated.reason_codes] }, { status: 'BRAND_GATED', reason_codes: ['BRAND_CONTEXT_NOT_READY'] });
  assert.equal(evaluateCreateGate(ctx({ brandContext: null })).status, 'BRAND_GATED');
  assert.equal(evaluateCreateGate(ctx({ brandContext: { status: 'READY', brand: null, core: null, memory: null } })).status, 'BRAND_GATED'); // a forged READY flag
  assert.equal(detailOf(() => buildCreativeBrief({ ...ctx({ brandContext: GATED }), ...briefFields() })).status, 'BRAND_GATED');
  // precedence: STALE > NOT_AUTHORIZED > PUSH_NOT_READY > BRAND_GATED
  assert.equal(evaluateCreateGate(ctx({ brandContext: GATED, authorization: null })).status, 'NOT_AUTHORIZED');
  assert.equal(evaluateCreateGate(ctx({ brandContext: GATED, asOf: '2026-10-25T00:00:00Z' })).status, 'STALE');
});

test('Live gate: a stored Push readiness and a stored package status are never read - the live evaluators decide', () => {
  const stored = clone(PUSH);
  assert.equal(stored.readiness.status, 'READY_FOR_SOCLE'); // the snapshot at created_at
  // 26: the snapshot stays READY, the live answer follows the clock
  assert.equal(evaluateCreateGate(ctx({ push: stored, asOf: '2026-10-25T00:00:00Z' })).status, 'STALE');
  assert.equal(m2.evaluatePushReadiness(stored, { tenant: tenant(), finding: FINDING, asOf: '2026-10-25T00:00:00Z' }).status, 'STALE');
  // a forged snapshot cannot make a non-ready Push ready
  const weak = pushOf(FINDING, { lever_variant: 'WEAK', lever_fitness: allFit({ CHANNEL_FIT: axisOf('NOT_FIT') }) });
  const weakPkg = packageOf(FINDING, [PUSH, weak]);
  const forgedPush = { ...clone(weak), readiness: { status: 'READY_FOR_SOCLE', reason_codes: ['FORGED'] } };
  assert.equal(code(() => evaluateCreateGate(ctx({ push: forgedPush, decisionPackage: weakPkg, authorization: authFor(weakPkg, weak) }))), 'MKT_M2_PUSH_DERIVED_MISMATCH');
  // 27: same for the package
  const storedPkg = clone(PKG);
  assert.equal(storedPkg.package_status, 'READY_FOR_SOCLE');
  assert.equal(evaluateCreateGate(ctx({ decisionPackage: storedPkg, asOf: '2026-10-24T00:00:00Z' })).status, 'STALE');
  const nothing = packageOf(FINDING, [weak]);
  assert.equal(nothing.package_status, 'NO_ELIGIBLE_MARKETING_ACTION');
  const forgedPkg = { ...clone(nothing), package_status: 'READY_FOR_SOCLE' };
  assert.equal(code(() => evaluateCreateGate(ctx({ decisionPackage: forgedPkg, push: weak, authorization: authFor(nothing, weak) }))), 'MKT_M2_PACKAGE_DERIVED_MISMATCH');
});

// ------------------------------------------------------------------ Creative Brief (28-59)

test('Brief: valid; merchant, brand, Finding, Push and decision are derived; objective, audience, channels and refs are copied', () => {
  const b = brief(); // 28
  assert.deepEqual(Object.keys(b), [
    'brief_id', 'schema_version', 'merchant_id', 'brand_id', 'finding_ref', 'push_ref', 'decision_ref', 'authorization_ref', 'objective', 'subject_refs', 'audience',
    'channels', 'message_intent', 'cta_intent', 'claim_refs', 'policy_requirement_refs', 'consent_requirement_refs', 'promotion_rule_refs', 'source_asset_refs',
    'mandatory_content_refs', 'prohibited_content_refs', 'locales', 'deliverables', 'brief_limitations', 'created_at', 'expires_at',
  ]);
  assert.equal(b.schema_version, 'marketing-m3-create.v1');
  assert.equal(MARKETING_CREATE_VERSION, 'marketing-m3-create.v1');
  assert.equal(b.merchant_id, M1); // 29
  assert.equal(b.brand_id, B1); // 30
  assert.equal(b.finding_ref, FINDING.finding_id); // 31
  assert.equal(b.push_ref, PUSH.push_id); // 32
  assert.equal(b.decision_ref, 'decision://socle-1'); // 33
  assert.equal(b.authorization_ref, 'auth://create-1');
  assert.equal(b.objective, PUSH.objective); // 34
  assert.deepEqual(b.audience, PUSH.audience); // 35
  assert.deepEqual(b.channels, PUSH.channels); // 36
  assert.deepEqual([b.claim_refs, b.policy_requirement_refs, b.consent_requirement_refs, b.promotion_rule_refs], [PUSH.claim_refs, PUSH.policy_requirement_refs, PUSH.consent_requirement_refs, PUSH.promotion_rule_refs]); // 37
  assert.deepEqual(b.subject_refs, PUSH.subject_refs);
  assert.equal(b.created_at, '2026-10-09T10:00:00.000Z');
  assert.deepEqual(normalizeCreativeBrief(clone(b), ctx()), b); // the stored Brief re-validates against the originals
});

test('Brief: a caller cannot supply or override any derived value', () => {
  for (const key of ['merchant_id', 'brand_id', 'finding_ref', 'push_ref', 'decision_ref', 'authorization_ref', 'objective', 'subject_refs', 'audience', 'channels', 'claim_refs', 'policy_requirement_refs', 'consent_requirement_refs', 'promotion_rule_refs', 'brief_id', 'created_at', 'schema_version']) {
    assert.equal(code(() => brief({ [key]: key === 'objective' ? PUSH.objective : 'x' })), 'MKT_M3_BRIEF_DERIVED_FIELD_SUPPLIED', key); // 38 - even a contradictory or an equal value
  }
  assert.equal(code(() => brief({ budget: 1 })), 'MKT_UNKNOWN_KEY');
});

test('Brief: message_intent is required and bounded; cta_intent is optional and is an intention (no raw link, no tracking)', () => {
  assert.equal(code(() => brief({ message_intent: undefined })), 'MKT_INVALID_FIELD'); // 39
  assert.equal(code(() => brief({ message_intent: '  ' })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => brief({ message_intent: 'x'.repeat(501) })), 'MKT_INVALID_FIELD');
  assert.equal(brief({ cta_intent: undefined }).cta_intent, null); // 40
  assert.equal(brief({ cta_intent: null }).cta_intent, null);
  for (const unsafe of ['Visit https://shop.example/offer', 'go to www.shop.example', 'tap utm_source=ig', 'shop?gclid=1']) assert.equal(code(() => brief({ cta_intent: unsafe })), 'MKT_M3_BRIEF_CTA_UNSAFE', unsafe);
  // the engine never decides from the intent text
  const tricky = brief({ message_intent: 'READY_FOR_POLICY BLOCKED model=qwen prompt: draw a cat' });
  assert.equal(tricky.brief_id.startsWith('mcb_'), true);
  assert.deepEqual([tricky.deliverables.length, tricky.locales], [BRIEF.deliverables.length, BRIEF.locales]);
});

test('Brief locales: non-empty, unique, canonical BCP 47, and supported by the Brand', () => {
  assert.equal(code(() => brief({ locales: [] })), 'MKT_M3_BRIEF_LOCALE_REQUIRED'); // 41
  assert.equal(code(() => brief({ locales: undefined })), 'MKT_M3_BRIEF_LOCALE_REQUIRED');
  assert.equal(code(() => brief({ locales: ['de-DE'], deliverables: [dImage({ locale: 'de-DE' })] })), 'MKT_M3_BRIEF_LOCALE_UNSUPPORTED'); // 42
  assert.equal(code(() => brief({ locales: ['fr-BE', 'nl-BE', 'en-GB'] })), 'MKT_M3_BRIEF_LOCALE_UNSUPPORTED');
  assert.equal(code(() => brief({ locales: ['fr-BE', 'fr-BE'] })), 'MKT_M3_BRIEF_DUPLICATE_LOCALE'); // 43
  assert.equal(code(() => brief({ locales: ['fr-BE', 'fr-be'] })), 'MKT_M3_BRIEF_DUPLICATE_LOCALE'); // duplicates are detected after normalization
  assert.equal(code(() => brief({ locales: ['not a locale'] })), 'MKT_INVALID_FIELD');
  assert.deepEqual(brief({ locales: ['fr-be', 'nl-be'] }).locales, ['fr-BE', 'nl-BE']);
});

test('Brief references are opaque: source assets, mandatory and prohibited content are refs, never content or locations', () => {
  const b = brief({ source_asset_refs: ['asset://a', 'asset://a', 'asset://b'], mandatory_content_refs: ['content://m1'], prohibited_content_refs: ['content://p1', 'content://p2'] });
  assert.deepEqual(b.source_asset_refs, ['asset://a', 'asset://b']); // 44
  assert.deepEqual(b.mandatory_content_refs, ['content://m1']); // 45
  assert.deepEqual(b.prohibited_content_refs, ['content://p1', 'content://p2']); // 46
  for (const field of ['source_asset_refs', 'mandatory_content_refs', 'prohibited_content_refs']) {
    for (const bad of ['Free shipping on everything!', 'someone@example.com', 'https://cdn.example/a.png', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'asset://x?sig=abc']) {
      assert.equal(code(() => brief({ [field]: [bad] })), 'MKT_INVALID_FIELD', `${field}: ${bad}`);
    }
  }
  assert.deepEqual(brief({ brief_limitations: ['LIMIT_A', 'LIMIT_A'] }).brief_limitations, ['LIMIT_A']);
  assert.equal(code(() => brief({ brief_limitations: ['a sentence about the brief'] })), 'MKT_INVALID_FIELD');
});

test('Brief expiry is bounded by the Finding, the Push, the package and the authorization (each bound reported)', () => {
  // chain in the fixture: authorization 10-22 < package 10-24 < push 10-25 < finding 10-30
  assert.equal(brief({ expires_at: '2026-10-22T00:00:00Z' }).expires_at, '2026-10-22T00:00:00.000Z'); // equal to the tightest bound is allowed
  const bound = (expires_at) => detailOf(() => brief({ expires_at })).bound;
  assert.equal(code(() => brief({ expires_at: '2026-10-22T00:00:01Z' })), 'MKT_M3_BRIEF_OUTLIVES_GOVERNING'); // 50
  assert.equal(bound('2026-10-22T00:00:01Z'), 'authorization');
  assert.equal(bound('2026-10-24T00:00:01Z'), 'package'); // 49: after the package, hence after the authorization too - the package is reported first
  assert.equal(bound('2026-10-25T00:00:01Z'), 'push'); // 48
  assert.equal(bound('2026-10-30T12:00:01Z'), 'finding'); // 47
  assert.equal(code(() => brief({ expires_at: '2026-10-09T10:00:00Z' })), 'MKT_M3_BRIEF_INVALID_EXPIRY'); // not after created_at
  assert.equal(code(() => brief({ expires_at: undefined })), 'MKT_M3_BRIEF_INVALID_EXPIRY');
});

test('Brief: no prompt, model, provider, style, layout, composition, camera, lighting, font or color can be stored (anywhere in the input)', () => {
  const FORBIDDEN = ['prompt', 'negative_prompt', 'model', 'model_id', 'provider', 'style', 'visual_style', 'art_direction', 'composition', 'layout', 'camera', 'lens', 'lighting', 'font', 'typography', 'color_palette', 'hex', 'seed', 'sampler', 'steps', 'cfg', 'render_engine'];
  assert.deepEqual([...m3.FORBIDDEN_BRIEF_KEYS].sort(), [...FORBIDDEN].sort());
  for (const key of FORBIDDEN) {
    assert.equal(code(() => brief({ [key]: 'x' })), 'MKT_M3_FORBIDDEN_CREATIVE_FIELD', `top-level ${key}`); // 51-55
    assert.equal(code(() => brief({ deliverables: [dImage({ [key]: 'x' }), dText()] })), 'MKT_M3_FORBIDDEN_CREATIVE_FIELD', `in a deliverable: ${key}`);
    assert.equal(code(() => brief({ source_asset_refs: [], mandatory_content_refs: [], deliverables: [dImage(), dText()], brief_limitations: [], extra: { nested: [{ [key.toUpperCase()]: 1 }] } })), 'MKT_M3_FORBIDDEN_CREATIVE_FIELD', `nested, upper-case ${key}`);
  }
  const keys = keysDeep(BRIEF);
  for (const key of FORBIDDEN) assert.equal(keys.has(key), false, key); // nothing hidden survives in the output either
});

test('Brief: deep-frozen, deterministic id, same input same id, input never mutated', () => {
  const fields = briefFields();
  const before = structuredClone(fields);
  const a = buildCreativeBrief({ ...ctx(), ...fields });
  assert.ok(isDeepFrozen(a)); // 56
  assert.match(a.brief_id, /^mcb_[0-9a-f]{32}$/); // 57
  assert.equal(buildCreativeBrief({ ...ctx(), ...briefFields() }).brief_id, a.brief_id); // 58
  assert.notEqual(brief({ message_intent: 'Another intention.' }).brief_id, a.brief_id);
  assert.notEqual(brief({}, ctx({ asOf: '2026-10-09T11:00:00Z' })).brief_id, a.brief_id);
  assert.deepEqual(fields, before); // 59
  assert.equal(Object.isFrozen(fields.deliverables), false);
  assert.equal(Object.isFrozen(fields.deliverables[0]), false);
  // the order of the deliverables carries no meaning
  assert.equal(brief({ deliverables: [dText(), dImage()] }).brief_id, a.brief_id);
});

// ------------------------------------------------------------------ Deliverables (60-77)

test('Deliverable: content kinds are exactly the Branding CONTENT_KIND (TEXT, IMAGE, VIDEO, DOCUMENT)', async () => {
  const branding = await import('../src/branding/constants.js');
  assert.deepEqual(Object.keys(branding.CONTENT_KIND), ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']);
  assert.doesNotMatch(await read('creative-brief'), /CONTENT_KIND\s*=\s*Object|const CONTENT_KIND/); // reused, never redefined
  for (const kind of ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']) { // 60-63
    const b = brief({ deliverables: [dImage({ content_kind: kind })] });
    assert.equal(b.deliverables[0].content_kind, kind, kind);
  }
  assert.equal(code(() => brief({ deliverables: [dImage({ content_kind: 'AUDIO' })] })), 'MKT_M3_DELIVERABLE_INVALID_KIND'); // 64
  assert.equal(code(() => brief({ deliverables: [dImage({ content_kind: 'image' })] })), 'MKT_M3_DELIVERABLE_INVALID_KIND');
  assert.equal(code(() => brief({ deliverables: [] })), 'MKT_M3_BRIEF_DELIVERABLE_REQUIRED');
  assert.equal(code(() => brief({ deliverables: undefined })), 'MKT_M3_BRIEF_DELIVERABLE_REQUIRED');
});

test('Deliverable: the channel comes from the Push, the placement is a token, the format is a mandatory ref', () => {
  assert.equal(brief({ deliverables: [dImage({ channel: 'STORE_FRONT' })] }).deliverables[0].channel, 'STORE_FRONT'); // 65
  assert.equal(code(() => brief({ deliverables: [dImage({ channel: 'TIKTOK' })] })), 'MKT_M3_DELIVERABLE_CHANNEL_NOT_IN_PUSH'); // 66: not introduced silently by M3
  assert.equal(code(() => brief({ deliverables: [dImage({ channel: 'store_front' })] })), 'MKT_INVALID_FIELD');
  for (const placement of ['FEED_POST', 'STORY', 'REEL', 'EMAIL_BODY', 'STORE_POSTER', 'WINDOW_POSTER', 'LANDING_HERO', 'ANY_FUTURE_PLACEMENT']) {
    assert.equal(brief({ deliverables: [dImage({ placement })] }).deliverables[0].placement, placement, placement); // 67: extensible, no logic by placement
  }
  for (const bad of ['window poster', 'window_poster', '', undefined, 'X'.repeat(65)]) { // 68
    assert.equal(code(() => brief({ deliverables: [dImage({ placement: bad })] })), 'MKT_M3_DELIVERABLE_INVALID_PLACEMENT', String(bad));
  }
  assert.equal(code(() => brief({ deliverables: [dImage({ format_ref: undefined })] })), 'MKT_M3_DELIVERABLE_FORMAT_REQUIRED'); // 69
  assert.equal(code(() => brief({ deliverables: [dImage({ format_ref: '  ' })] })), 'MKT_M3_DELIVERABLE_FORMAT_REQUIRED');
  assert.equal(code(() => brief({ deliverables: [dImage({ format_ref: '1080x1920 mp4 h264' })] })), 'MKT_INVALID_FIELD'); // a ref, not the dimensions / codec
});

test('Deliverable: the locale must be a Brief locale; needed_by must be after the Brief and within the Push window and the authorization', () => {
  assert.equal(brief({ deliverables: [dImage({ locale: 'fr-be' })] }).deliverables[0].locale, 'fr-BE'); // 70
  assert.equal(code(() => brief({ locales: ['fr-BE'], deliverables: [dImage({ locale: 'nl-BE' })] })), 'MKT_M3_DELIVERABLE_LOCALE_UNSUPPORTED');
  assert.equal(code(() => brief({ deliverables: [dImage({ locale: 'xx-XX' })] })), 'MKT_M3_DELIVERABLE_LOCALE_UNSUPPORTED');
  const limit = (needed_by) => detailOf(() => brief({ deliverables: [dImage({ needed_by })] })).limit;
  assert.equal(limit('2026-10-09T10:00:00Z'), 'brief_created_at'); // 71: not after created_at
  assert.equal(limit('2026-10-01T00:00:00Z'), 'brief_created_at');
  assert.equal(brief({ deliverables: [dImage({ needed_by: '2026-10-09T10:00:01Z' })] }).deliverables[0].needed_by, '2026-10-09T10:00:01.000Z');
  assert.equal(brief({ deliverables: [dImage({ needed_by: '2026-10-20T00:00:00Z' })] }).deliverables[0].needed_by, '2026-10-20T00:00:00.000Z'); // == push window end: allowed
  assert.equal(limit('2026-10-20T00:00:01Z'), 'push_execution_window_end'); // 72
  assert.equal(code(() => brief({ deliverables: [dImage({ needed_by: 'soon' })] })), 'MKT_M3_DELIVERABLE_NEEDED_BY_INVALID');
  // 73: the authorization bound, isolated by a Push whose window ends after the authorization expiry
  const widePush = pushOf(FINDING, { lever_variant: 'WIDE', valid_execution_window: { start: '2026-10-09T00:00:00Z', end: '2026-10-24T00:00:00Z' } });
  const widePkg = packageOf(FINDING, [widePush]);
  const wideCtx = ctx({ push: widePush, decisionPackage: widePkg, authorization: authFor(widePkg, widePush) });
  assert.equal(detailOf(() => brief({ deliverables: [dImage({ needed_by: '2026-10-22T00:00:01Z' })] }, wideCtx)).limit, 'authorization_expiry');
  assert.equal(brief({ deliverables: [dImage({ needed_by: '2026-10-22T00:00:00Z' })] }, wideCtx).deliverables[0].needed_by, '2026-10-22T00:00:00.000Z');
});

test('Deliverable: deterministic id, duplicates refused, references only (no raw media, no credentialed URL)', () => {
  const [a] = brief({ deliverables: [dImage()] }).deliverables;
  assert.match(a.deliverable_id, /^mdl_[0-9a-f]{32}$/); // 74
  assert.equal(brief({ deliverables: [dImage()] }).deliverables[0].deliverable_id, a.deliverable_id);
  assert.notEqual(brief({ deliverables: [dImage({ placement: 'STORY' })] }).deliverables[0].deliverable_id, a.deliverable_id);
  assert.equal(code(() => brief({ deliverables: [dImage(), dImage()] })), 'MKT_M3_DELIVERABLE_DUPLICATE'); // 75
  assert.equal(brief({ deliverables: [dImage(), dImage({ placement: 'STORY' })] }).deliverables.length, 2); // different content, not a duplicate
  assert.equal(code(() => brief({ deliverables: [dImage({ deliverable_id: 'mdl_forged' })] })), 'MKT_M3_DELIVERABLE_ID_MISMATCH');
  for (const field of ['source_asset_refs', 'mandatory_content_refs', 'requirement_refs']) { // 76 / 77
    for (const bad of ['https://cdn.example/a.png', 'https://u:p@cdn.example/a.png', 'data:image/png;base64,iVBOR', 'blob:abc', 'asset://a?X-Signature=abc', 'A'.repeat(300)]) {
      assert.equal(code(() => brief({ deliverables: [dImage({ [field]: [bad] })] })), 'MKT_INVALID_FIELD', `${field}: ${bad.slice(0, 30)}`);
    }
  }
  assert.deepEqual(a.source_asset_refs, ['asset://product-1']);
});

// ------------------------------------------------------------------ Handoff (78-87)

test('Handoff: valid; the exact creativeBrandInterface is reused; Brand Memory is not rebuilt; scope, expiry and snapshot are correct', async () => {
  const h = buildCreativeHandoff({ ...ctx(), brief: BRIEF }); // 78
  assert.deepEqual(Object.keys(h), ['handoff_id', 'schema_version', 'creative_brief', 'brand_interface', 'created_at', 'expires_at', 'status_snapshot']);
  assert.deepEqual(h.brand_interface, creativeBrandInterface(BRAND)); // 79: exactly what Branding exposes
  assert.deepEqual(h.creative_brief, BRIEF);
  const source = await read('creative-handoff');
  assert.match(source, /creativeBrandInterface\(/);
  assert.doesNotMatch(stripComments(source), /memory\.js|design_tokens|hard_rules|buildBrandMemory|identity_references/); // 80: Brand Memory is neither imported nor rebuilt
  assert.deepEqual([h.brand_interface.brand.brand_id, h.creative_brief.brand_id, h.creative_brief.merchant_id], [B1, B1, M1]); // 81
  assert.equal(h.expires_at, BRIEF.expires_at); // 82 default
  assert.equal(buildCreativeHandoff({ ...ctx(), brief: BRIEF, expires_at: '2026-10-19T00:00:00Z' }).expires_at, '2026-10-19T00:00:00.000Z');
  assert.equal(code(() => buildCreativeHandoff({ ...ctx(), brief: BRIEF, expires_at: '2026-10-20T00:00:01Z' })), 'MKT_M3_HANDOFF_OUTLIVES_BRIEF');
  assert.equal(code(() => buildCreativeHandoff({ ...ctx(), brief: BRIEF, expires_at: '2026-10-09T10:00:00Z' })), 'MKT_INVALID_FIELD');
  assert.deepEqual({ ...h.status_snapshot }, { status: 'READY_FOR_CREATIVE', as_of: '2026-10-09T10:00:00.000Z' }); // 83
  assert.match(h.handoff_id, /^mch_[0-9a-f]{32}$/); // 87
  assert.equal(buildCreativeHandoff({ ...ctx(), brief: BRIEF }).handoff_id, h.handoff_id);
  assert.ok(isDeepFrozen(h)); // 86
});

test('Handoff: the live gate is separate from the snapshot; no model, provider or routing can be expressed', () => {
  // 84: the snapshot says READY, the live gate decides
  const h = buildCreativeHandoff({ ...ctx(), brief: BRIEF });
  assert.equal(h.status_snapshot.status, 'READY_FOR_CREATIVE');
  assert.equal(evaluateBriefReadiness(BRIEF, ctx({ asOf: '2026-10-21T00:00:00Z' })).status, 'STALE');
  assert.equal(h.status_snapshot.status, 'READY_FOR_CREATIVE'); // still the old snapshot
  assert.equal(code(() => buildCreativeHandoff({ ...ctx({ asOf: '2026-10-21T00:00:00Z' }), brief: BRIEF })), 'MKT_M3_CREATE_NOT_READY');
  assert.equal(code(() => buildCreativeHandoff({ ...ctx({ brandContext: GATED }), brief: BRIEF })), 'MKT_M3_CREATE_NOT_READY');
  assert.equal(code(() => buildCreativeHandoff({ ...ctx({ brandContext: readyBrandContext({ brandId: B2 }) }), brief: BRIEF })), 'MKT_M3_BRAND_MISMATCH');
  // 85
  for (const key of ['model', 'provider', 'model_id', 'prompt']) assert.equal(code(() => buildCreativeHandoff({ ...ctx(), brief: BRIEF, [key]: 'x' })), 'MKT_M3_FORBIDDEN_CREATIVE_FIELD', key);
  for (const key of ['router', 'route', 'engine']) assert.equal(code(() => buildCreativeHandoff({ ...ctx(), brief: BRIEF, [key]: 'x' })), 'MKT_UNKNOWN_KEY', key);
  assert.equal(code(() => buildCreativeHandoff({ ...ctx(), brief: { ...clone(BRIEF), message_intent: 'tampered' } })), 'MKT_M3_BRIEF_DERIVED_MISMATCH');
  const names = Object.keys(h.brand_interface).join(' ');
  assert.doesNotMatch(names, /provider|model_id|router/);
});

// ------------------------------------------------------------------ Selected candidate (88-103)

test('Candidate: a valid candidate is accepted; merchant, brand, brief, deliverable, kind, channel and expiry are scoped to the Brief', () => {
  const c = normalizeSelectedCreativeCandidate(candidateOf(imageSpec), { brief: BRIEF }); // 88
  assert.deepEqual(Object.keys(c), ['candidate_id', 'merchant_id', 'brand_id', 'brief_ref', 'deliverable_ref', 'selection_ref', 'content_kind', 'channel', 'asset_refs', 'provenance_ref', 'selected_at', 'candidate_expires_at']);
  const norm = (over) => normalizeSelectedCreativeCandidate(candidateOf(imageSpec, over), { brief: BRIEF });
  assert.equal(code(() => norm({ merchant_id: M2 })), 'MKT_M3_CANDIDATE_TENANT_MISMATCH'); // 89
  assert.equal(code(() => norm({ brand_id: B2 })), 'MKT_M3_CANDIDATE_BRAND_MISMATCH'); // 90
  assert.equal(code(() => norm({ brief_ref: 'mcb_other' })), 'MKT_M3_CANDIDATE_BRIEF_MISMATCH'); // 91
  assert.equal(code(() => norm({ deliverable_ref: 'mdl_unknown' })), 'MKT_M3_CANDIDATE_UNKNOWN_DELIVERABLE'); // 92
  assert.equal(code(() => norm({ content_kind: 'VIDEO' })), 'MKT_M3_CANDIDATE_KIND_MISMATCH'); // 93
  assert.equal(code(() => norm({ content_kind: 'POSTER' })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => norm({ channel: 'EMAIL' })), 'MKT_M3_CANDIDATE_CHANNEL_MISMATCH'); // 94
  assert.equal(code(() => norm({ candidate_expires_at: '2026-10-20T00:00:01Z' })), 'MKT_M3_CANDIDATE_OUTLIVES_BRIEF'); // 95
  assert.equal(norm({ candidate_expires_at: '2026-10-20T00:00:00Z' }).candidate_expires_at, '2026-10-20T00:00:00.000Z');
  assert.equal(code(() => norm({ candidate_expires_at: '2026-10-10T09:00:00Z' })), 'MKT_M3_CANDIDATE_INVALID_EXPIRY');
  assert.equal(code(() => normalizeSelectedCreativeCandidate(candidateOf(imageSpec), {})), 'MKT_INVALID_FIELD');
});

test('Candidate: id, selection, assets and provenance are required; no prompt, model, provider, cost or score; deep-frozen', () => {
  const norm = (over) => normalizeSelectedCreativeCandidate(candidateOf(imageSpec, over), { brief: BRIEF });
  assert.equal(code(() => norm({ candidate_id: undefined })), 'MKT_INVALID_FIELD'); // 96: the id comes from Creative Intelligence
  assert.equal(code(() => norm({ candidate_id: 'has space' })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => norm({ selection_ref: undefined })), 'MKT_INVALID_FIELD'); // 97
  assert.equal(code(() => norm({ asset_refs: [] })), 'MKT_INVALID_FIELD'); // 98
  assert.equal(code(() => norm({ asset_refs: undefined })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => norm({ asset_refs: ['https://cdn.example/out.png'] })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => norm({ provenance_ref: undefined })), 'MKT_INVALID_FIELD'); // 99
  for (const key of ['prompt', 'negative_prompt', 'model', 'model_id', 'provider']) assert.equal(code(() => norm({ [key]: 'x' })), 'MKT_M3_FORBIDDEN_CREATIVE_FIELD', key); // 100
  for (const key of ['quality', 'quality_score', 'score', 'rating', 'cost', 'price']) assert.equal(code(() => norm({ [key]: 0.9 })), 'MKT_M3_FORBIDDEN_CREATIVE_FIELD', key); // 101
  for (const key of ['winner', 'winner_score', 'rank', 'ranking_score']) assert.equal(code(() => norm({ [key]: 1 })), 'MKT_M3_FORBIDDEN_CREATIVE_FIELD', key); // 102
  assert.equal(code(() => norm({ extra: { nested: { provider: 'x' } } })), 'MKT_M3_FORBIDDEN_CREATIVE_FIELD');
  assert.equal(code(() => norm({ extra: 1 })), 'MKT_UNKNOWN_KEY');
  assert.ok(isDeepFrozen(norm({}))); // 103
});

// ------------------------------------------------------------------ Candidate manifest / Creative Fidelity (104-111)

const validate = (entry, c = ctx(), b = BRIEF) => buildCreativeValidationReport({ ...c, brief: b, ...entry });
const gateEntry = (status) => {
  const observations = { PASS: [{ code: 'PRODUCT_IDENTITY', outcome: 'PASS' }], FAIL: [{ code: 'PRODUCT_IDENTITY', outcome: 'FAIL' }], NOT_MEASURABLE: [] }[status];
  const fidelity = evaluateHardFidelityGate({ requiredChecks: ['PRODUCT_IDENTITY'], observations });
  const manifest = { ...manifestOf('IMAGE'), external_gates: [fidelityGateObservation({ gate: fidelity, evidenceRefs: ['fidelity://run-1'] })] };
  return { candidate: candidateOf(imageSpec), candidateManifest: manifest };
};

test('Candidate manifest: normalized by Branding, and its content kind must match the candidate', () => {
  const r = validate(entryOf(imageSpec)); // 104
  assert.equal(r.guardian_report.content_kind, 'IMAGE');
  assert.equal(code(() => validate({ candidate: candidateOf(imageSpec), candidateManifest: manifestOf('TEXT') })), 'MKT_M3_CANDIDATE_MANIFEST_KIND_MISMATCH'); // 105
  assert.equal(code(() => validate({ candidate: candidateOf(imageSpec), candidateManifest: { ...manifestOf('IMAGE'), score: 1 } })), 'MKT_M3_CANDIDATE_MANIFEST_INVALID');
  assert.equal(code(() => validate({ candidate: candidateOf(imageSpec), candidateManifest: { content_kind: 'POSTER' } })), 'MKT_M3_CANDIDATE_MANIFEST_INVALID');
  assert.equal(code(() => validate({ candidate: candidateOf(imageSpec), candidateManifest: null })), 'MKT_M3_CANDIDATE_MANIFEST_INVALID');
  // 111: a manifest holds facts, never media - Branding refuses a raw-media field and M3 reports it
  assert.equal(code(() => validate({ candidate: candidateOf(imageSpec), candidateManifest: { ...manifestOf('IMAGE'), raw_media: 'AAAA' } })), 'MKT_M3_CANDIDATE_MANIFEST_INVALID');
  const withAsset = (value) => ({ candidate: candidateOf(imageSpec), candidateManifest: { ...manifestOf('IMAGE'), assets: [{ subject: 'hero', coverage: 'COMPLETE', values: [value], evidence_refs: [] }] } });
  assert.equal(validate(withAsset('asset://hero-1')).guardian_report.content_kind, 'IMAGE'); // an opaque asset ref is fine
  for (const raw of ['data:image/png;base64,AAAA', 'https://cdn.example/out.png', 'file:///tmp/out.png', 'blob:abc', 'ftp://host/out.png']) {
    assert.equal(code(() => validate(withAsset(raw))), 'MKT_M3_CANDIDATE_MANIFEST_INVALID', raw); // 111: media and locations never enter a manifest
  }
});

test('Creative Fidelity handoff: its result reaches the Guardian through the existing external gate, unchanged; M3 recomputes nothing', async () => {
  const brandCtx = ctx({ brandContext: BRAND_GATE });
  const pass = validate(gateEntry('PASS'), brandCtx); // 106
  assert.equal(pass.guardian_report.outcome, 'PASS');
  assert.equal(pass.validation_status, 'READY_FOR_ACTIVATION_POLICY');
  const gateResult = (report) => report.guardian_report.rule_results.find((x) => x.rule_id === 'g1');
  assert.equal(gateResult(pass).outcome, 'PASS');
  const fail_ = validate(gateEntry('FAIL'), brandCtx); // 107: the Guardian sees the FAIL as is
  assert.equal(gateResult(fail_).outcome, 'FAIL');
  assert.equal(gateResult(fail_).reason, 'EXTERNAL_GATE_STATUS_NOT_ALLOWED');
  assert.equal(fail_.validation_status, 'BLOCKED');
  const unmeasured = validate(gateEntry('NOT_MEASURABLE'), brandCtx); // 108
  assert.equal(gateResult(unmeasured).outcome, 'NOT_MEASURABLE');
  assert.equal(gateResult(unmeasured).reason, 'EXTERNAL_GATE_NOT_MEASURED');
  assert.equal(unmeasured.validation_status, 'NOT_MEASURABLE');
  // a required gate with no observation at all is NOT_MEASURABLE, not a pass
  const absent = validate({ candidate: candidateOf(imageSpec), candidateManifest: manifestOf('IMAGE') }, brandCtx);
  assert.equal(gateResult(absent).outcome, 'NOT_MEASURABLE');
  // 109 / 110: M3 never calls or recomputes Creative Fidelity
  for (const name of M3_FILES) {
    const text = stripComments(await read(name));
    assert.doesNotMatch(text, /creative-fidelity|evaluateHardFidelityGate|fidelityGateObservation|requiredChecksFromInvariants|FIDELITY_CHECK/, name);
  }
  assert.match(gateResult(fail_).observed_summary, /status=FAIL/); // the Guardian read the adapter's observation as it was
});

// ------------------------------------------------------------------ Guardian integration (112-124)

test('Guardian mapping is exact: PASS -> READY_FOR_ACTIVATION_POLICY, REVIEW_REQUIRED -> REVIEW_REQUIRED, FAIL -> BLOCKED, NOT_MEASURABLE -> NOT_MEASURABLE', () => {
  const pass = validate(entryOf(imageSpec)); // 112
  assert.deepEqual([pass.guardian_report.outcome, pass.validation_status], ['PASS', 'READY_FOR_ACTIVATION_POLICY']);
  const review = validate(entryOf(imageSpec, { semanticAssessment: { outcome: 'REVIEW_REQUIRED', method: 'HUMAN', evidence_refs: ['review://note-1'] } })); // 113
  assert.deepEqual([review.guardian_report.outcome, review.validation_status], ['REVIEW_REQUIRED', 'REVIEW_REQUIRED']);
  const blocked = validate(entryOf(imageSpec, { color: '#000000' })); // 114
  assert.deepEqual([blocked.guardian_report.outcome, blocked.validation_status], ['FAIL', 'BLOCKED']);
  const unmeasured = validate({ candidate: candidateOf(imageSpec), candidateManifest: { content_kind: 'IMAGE' } }); // 115
  assert.deepEqual([unmeasured.guardian_report.outcome, unmeasured.validation_status], ['NOT_MEASURABLE', 'NOT_MEASURABLE']);
  assert.deepEqual({ ...m3.GUARDIAN_TO_VALIDATION }, { PASS: 'READY_FOR_ACTIVATION_POLICY', REVIEW_REQUIRED: 'REVIEW_REQUIRED', FAIL: 'BLOCKED', NOT_MEASURABLE: 'NOT_MEASURABLE' });
  assert.deepEqual(Object.values(VALIDATION_STATUS), ['READY_FOR_ACTIVATION_POLICY', 'REVIEW_REQUIRED', 'BLOCKED', 'NOT_MEASURABLE']);
  // REVIEW_REQUIRED is never promoted to a pass, and a semantic review never rescues a hard FAIL
  assert.equal(validate(entryOf(imageSpec, { color: '#000000', semanticAssessment: { outcome: 'PASS', method: 'HUMAN' } })).validation_status, 'BLOCKED');
});

test('Guardian integration: target and clock, no execution decision or override, optional advisory semantic lane, scope, determinism', async () => {
  const r = validate(entryOf(imageSpec));
  assert.equal(r.guardian_report.target_ref, 'cand-image-1'); // 116
  assert.equal(r.guardian_report.evaluated_at, '2026-10-09T10:00:00.000Z'); // 117
  assert.equal(r.evaluated_at, '2026-10-09T10:00:00.000Z');
  assert.equal(r.execution_decision, null); // 118
  assert.equal(r.guardian_report.execution_decision, null);
  assert.equal(code(() => validate({ ...entryOf(imageSpec), execution_decision: 'PUBLISH' })), 'MKT_UNKNOWN_KEY');
  assert.doesNotMatch(Object.keys(m3).join(' '), /override|force|publishAnyway|forcePass|approveActivation|approve/i); // 119
  assert.deepEqual(validate({ candidate: candidateOf(imageSpec), candidateManifest: manifestOf('IMAGE') }).guardian_report.semantic_outcome, null); // 120: optional
  assert.equal(validate(entryOf(imageSpec, { semanticAssessment: { outcome: 'NOT_MEASURABLE', method: 'MODEL' } })).validation_status, 'READY_FOR_ACTIVATION_POLICY');
  assert.equal(code(() => validate(entryOf(imageSpec, { semanticAssessment: { outcome: 'FAIL', method: 'MODEL' } }))), 'MKT_M3_SEMANTIC_ASSESSMENT_INVALID'); // 121: the semantic lane has no FAIL
  assert.equal(code(() => validate(entryOf(imageSpec, { semanticAssessment: { outcome: 'PASS', method: 'MODEL', rule_id: 'r1' } }))), 'MKT_M3_SEMANTIC_ASSESSMENT_INVALID');
  assert.deepEqual([r.merchant_id, r.brand_id, r.brief_ref, r.candidate_ref, r.deliverable_ref], [M1, B1, BRIEF.brief_id, 'cand-image-1', imageSpec.deliverable_id]); // 122
  assert.deepEqual([r.guardian_report.merchant_id, r.guardian_report.brand_id], [M1, B1]);
  assert.equal(code(() => validate(entryOf(imageSpec, { over: { brand_id: B2 } }))), 'MKT_M3_CANDIDATE_BRAND_MISMATCH');
  assert.equal(code(() => validate(entryOf(imageSpec), ctx({ brandContext: readyBrandContext({ brandId: B2 }) }))), 'MKT_M3_BRAND_MISMATCH');
  assert.equal(code(() => validate(entryOf(imageSpec), ctx({ brandContext: GATED }))), 'MKT_M3_CREATE_NOT_READY');
  assert.equal(validate(entryOf(imageSpec)).validation_id, r.validation_id); // 123
  assert.match(r.validation_id, /^mcv_[0-9a-f]{32}$/);
  assert.notEqual(validate(entryOf(imageSpec, { color: '#000000' })).validation_id, r.validation_id);
  assert.ok(isDeepFrozen(r)); // 124
  assert.equal(code(() => validate(entryOf(imageSpec, { over: { candidate_expires_at: '2026-10-09T10:00:00Z' } }))), 'MKT_M3_CANDIDATE_INVALID_EXPIRY');
  assert.equal(code(() => validate(entryOf(imageSpec), ctx(), { ...clone(BRIEF), message_intent: 'tampered' })), 'MKT_M3_BRIEF_DERIVED_MISMATCH');
  assert.equal(code(() => validate(entryOf(imageSpec), ctx(), { ...clone(BRIEF), expires_at: '2026-10-09T10:00:00Z' })), 'MKT_M3_BRIEF_INVALID_EXPIRY');
  // a candidate that has expired at asOf is never validated (candidate_expires_at = 10-18; the live gate itself is still READY then)
  assert.equal(code(() => validate(entryOf(imageSpec), ctx({ asOf: '2026-10-18T00:00:00Z' }))), 'MKT_M3_CANDIDATE_STALE');
  assert.equal(validate(entryOf(imageSpec), ctx({ asOf: '2026-10-17T23:59:59Z' })).validation_status, 'READY_FOR_ACTIVATION_POLICY');
  assert.equal(code(() => activation({}, ctx({ asOf: '2026-10-18T00:00:00Z' }))), 'MKT_M3_CANDIDATE_STALE');
  assert.match(await read('creative-validation'), /evaluateBrandGuardian\(/);
});

// ------------------------------------------------------------------ Activation Manifest (125-148)

test('Activation Manifest: valid, deterministic, every deliverable exactly once, channel / placement / format / locale preserved, frozen', () => {
  const m = MANIFEST; // 125
  assert.deepEqual(Object.keys(m), [
    'activation_manifest_id', 'schema_version', 'merchant_id', 'brand_id', 'finding_ref', 'push_ref', 'decision_ref', 'authorization_ref', 'brief_ref', 'created_at',
    'expires_at', 'activation_window', 'deliveries', 'measurement_plan_ref', 'claim_refs', 'policy_requirement_refs', 'consent_requirement_refs',
    'promotion_rule_refs', 'unresolved_requirement_refs', 'review_signals', 'readiness', 'execution_decision',
  ]);
  assert.match(m.activation_manifest_id, /^mam_[0-9a-f]{32}$/); // 126
  assert.equal(activation().activation_manifest_id, m.activation_manifest_id);
  assert.equal(activation({ candidates: [...ENTRIES].reverse() }).activation_manifest_id, m.activation_manifest_id); // the order of the candidates carries no meaning
  assert.deepEqual(m.deliveries.map((d) => d.deliverable_ref).sort(), BRIEF.deliverables.map((d) => d.deliverable_id).sort()); // 127
  assert.equal(new Set(m.deliveries.map((d) => d.deliverable_ref)).size, BRIEF.deliverables.length);
  for (const d of m.deliveries) {
    const spec = BRIEF.deliverables.find((x) => x.deliverable_id === d.deliverable_ref);
    assert.deepEqual([d.channel, d.placement, d.format_ref, d.locale], [spec.channel, spec.placement, spec.format_ref, spec.locale]); // 132-135
    assert.deepEqual(Object.keys(d), ['deliverable_ref', 'candidate_ref', 'channel', 'placement', 'format_ref', 'locale', 'validation_ref', 'validation_status']);
    assert.equal(d.validation_status, 'READY_FOR_ACTIVATION_POLICY');
  }
  assert.deepEqual([m.merchant_id, m.brand_id, m.finding_ref, m.push_ref, m.decision_ref, m.authorization_ref, m.brief_ref], [M1, B1, FINDING.finding_id, PUSH.push_id, 'decision://socle-1', 'auth://create-1', BRIEF.brief_id]);
  assert.ok(isDeepFrozen(m)); // 148
  assert.deepEqual(normalizeActivationManifest(clone(m), { ...ctx(), brief: BRIEF, candidates: ENTRIES }), m);
});

test('Activation Manifest: a deliverable cannot be forgotten, doubled, delivered by an unknown candidate or backed by a mismatching validation', () => {
  assert.equal(code(() => activation({ candidates: [ENTRIES[0]] })), 'MKT_M3_ACTIVATION_DELIVERABLE_MISSING'); // 128
  assert.equal(code(() => activation({ candidates: [] })), 'MKT_M3_ACTIVATION_DELIVERABLE_MISSING');
  assert.equal(code(() => activation({ candidates: undefined })), 'MKT_M3_ACTIVATION_DELIVERABLE_MISSING');
  const twin = entryOf(imageSpec, { over: { candidate_id: 'cand-image-2' } });
  assert.equal(code(() => activation({ candidates: [...ENTRIES, twin] })), 'MKT_M3_ACTIVATION_DUPLICATE_DELIVERABLE'); // 129
  assert.equal(code(() => activation({ candidates: [entryOf(imageSpec), entryOf(imageSpec)] })), 'MKT_M3_ACTIVATION_DUPLICATE_DELIVERABLE');
  assert.equal(code(() => activation({ candidates: [ENTRIES[0], entryOf({ ...textSpec, deliverable_id: 'mdl_unknown' })] })), 'MKT_M3_CANDIDATE_UNKNOWN_DELIVERABLE'); // 130
  const stored = clone(MANIFEST);
  stored.deliveries[0].candidate_ref = 'cand-not-supplied';
  assert.equal(code(() => normalizeActivationManifest(stored, { ...ctx(), brief: BRIEF, candidates: ENTRIES })), 'MKT_M3_ACTIVATION_UNKNOWN_CANDIDATE');
  // 131: a supplied validation is only CROSS-CHECKED against the Guardian result
  const goodReport = validate(entryOf(imageSpec));
  assert.equal(activation({ candidates: [entryOf(imageSpec, { validation: goodReport }), ENTRIES[1]] }).activation_manifest_id, MANIFEST.activation_manifest_id);
  const forgedReport = { ...clone(goodReport), validation_status: 'READY_FOR_ACTIVATION_POLICY', guardian_report: { ...clone(goodReport.guardian_report), outcome: 'FAIL' } };
  assert.equal(code(() => activation({ candidates: [entryOf(imageSpec, { validation: forgedReport }), ENTRIES[1]] })), 'MKT_M3_ACTIVATION_VALIDATION_MISMATCH');
  const otherCandidateReport = validate(entryOf(imageSpec, { over: { candidate_id: 'cand-other' } }));
  assert.equal(code(() => activation({ candidates: [entryOf(imageSpec, { validation: otherCandidateReport }), ENTRIES[1]] })), 'MKT_M3_ACTIVATION_VALIDATION_MISMATCH');
  assert.equal(code(() => activation({ candidates: [{ ...ENTRIES[0], extra: 1 }, ENTRIES[1]] })), 'MKT_UNKNOWN_KEY');
});

test('Activation Manifest: measurement plan referenced not copied; claims, policy, consent and promotions carried as refs; no decision, connector or schedule', () => {
  const m = MANIFEST;
  assert.equal(m.measurement_plan_ref, `${PUSH.push_id}#measurement`); // 136
  assert.equal(JSON.stringify(m).includes('success_criterion_ref'), false); // referenced, never duplicated
  assert.deepEqual(m.claim_refs, PUSH.claim_refs); // 137
  assert.deepEqual(m.policy_requirement_refs, PUSH.policy_requirement_refs); // 138
  assert.deepEqual(m.consent_requirement_refs, PUSH.consent_requirement_refs); // 139
  assert.deepEqual(m.promotion_rule_refs, PUSH.promotion_rule_refs); // 140
  for (const ref of [...PUSH.claim_refs, ...PUSH.policy_requirement_refs, ...PUSH.consent_requirement_refs, ...PUSH.promotion_rule_refs]) assert.ok(m.unresolved_requirement_refs.includes(ref), ref); // visible to the Socle, never validated here
  assert.deepEqual(m.review_signals, ['POLICY_CLEARANCE_REQUIRED']);
  assert.equal(m.execution_decision, null); // 141
  assert.equal(code(() => activation({ execution_decision: true })), 'MKT_UNKNOWN_KEY');
  assert.equal(code(() => activation({ execution_decision: null })), 'MKT_UNKNOWN_KEY');
  for (const key of ['connector', 'publish', 'publish_at', 'schedule', 'cron', 'job', 'webhook', 'send', 'recipients', 'email', 'phone']) assert.equal(code(() => activation({ [key]: 'x' })), 'MKT_UNKNOWN_KEY', key); // 142-144
  const keys = keysDeep(m);
  for (const forbidden of ['connector', 'publish', 'schedule', 'cron', 'job', 'webhook', 'recipients', 'email', 'phone', 'approved', 'winner', 'score']) assert.equal(keys.has(forbidden), false, forbidden);
});

test('Activation Manifest: expiry and activation window are bounded by everything that governs them', () => {
  const bound = (over) => detailOf(() => activation(over)).bound;
  // chain: candidates 10-18 < brief 10-20 < authorization 10-22 < package 10-24 < push 10-25 < finding 10-30
  assert.equal(activation({ expires_at: '2026-10-18T00:00:00Z' }).expires_at, '2026-10-18T00:00:00.000Z'); // 145
  assert.equal(code(() => activation({ expires_at: '2026-10-18T00:00:01Z' })), 'MKT_M3_ACTIVATION_OUTLIVES_GOVERNING');
  const longLived = [entryOf(imageSpec, { over: { candidate_expires_at: '2026-10-20T00:00:00Z' } }), entryOf(textSpec, { over: { candidate_expires_at: '2026-10-20T00:00:00Z' } })];
  assert.equal(bound({ expires_at: '2026-10-18T00:00:01Z' }), 'candidate'); // the candidates are the tightest bound
  assert.equal(bound({ candidates: longLived, expires_at: '2026-10-20T00:00:01Z' }), 'brief');
  assert.equal(bound({ candidates: longLived, expires_at: '2026-10-22T00:00:01Z' }), 'authorization');
  assert.equal(bound({ candidates: longLived, expires_at: '2026-10-24T00:00:01Z' }), 'package');
  assert.equal(bound({ candidates: longLived, expires_at: '2026-10-25T00:00:01Z' }), 'push');
  assert.equal(bound({ candidates: longLived, expires_at: '2026-10-30T12:00:01Z' }), 'finding');
  assert.equal(code(() => activation({ expires_at: '2026-10-09T10:00:00Z' })), 'MKT_M3_ACTIVATION_INVALID_EXPIRY');
  assert.equal(code(() => activation({ expires_at: undefined })), 'MKT_M3_ACTIVATION_INVALID_EXPIRY');
  // 146 / 147: a sub-window is accepted, a wider one refused (each bound)
  const window = (start, end) => ({ activation_window: { start, end } });
  assert.deepEqual({ ...activation(window('2026-10-13T00:00:00Z', '2026-10-14T00:00:00Z')).activation_window }, { start: '2026-10-13T00:00:00.000Z', end: '2026-10-14T00:00:00.000Z' });
  assert.equal(activation(window('2026-10-09T00:00:00Z', '2026-10-18T00:00:00Z')).activation_window.end, '2026-10-18T00:00:00.000Z'); // == tightest bound
  assert.equal(code(() => activation(window('2026-10-09T00:00:00Z', '2026-10-18T00:00:01Z'))), 'MKT_M3_ACTIVATION_WINDOW_WIDER');
  assert.equal(bound(window('2026-10-09T00:00:00Z', '2026-10-18T00:00:01Z')), 'candidate_expiry');
  assert.equal(bound(window('2026-10-08T23:59:59Z', '2026-10-17T00:00:00Z')), 'push_window_start');
  // the Push window end / authorization / brief bounds, isolated with longer-lived candidates
  const longEntries = [entryOf(imageSpec, { over: { candidate_expires_at: '2026-10-20T00:00:00Z' } }), entryOf(textSpec, { over: { candidate_expires_at: '2026-10-20T00:00:00Z' } })];
  assert.equal(bound({ candidates: longEntries, activation_window: { start: '2026-10-12T00:00:00Z', end: '2026-10-20T00:00:01Z' } }), 'push_window_end');
  assert.equal(code(() => activation(window('2026-10-17T00:00:00Z', '2026-10-17T00:00:00Z'))), 'MKT_M3_ACTIVATION_WINDOW_INVALID');
  assert.equal(code(() => activation(window('2026-10-18T00:00:00Z', '2026-10-17T00:00:00Z'))), 'MKT_M3_ACTIVATION_WINDOW_INVALID');
  assert.equal(code(() => activation({ activation_window: undefined })), 'MKT_M3_ACTIVATION_WINDOW_INVALID');
  assert.equal(code(() => activation({ activation_window: { start: '2026-10-12T00:00:00Z', end: '2026-10-17T00:00:00Z', cron: '* * * * *' } })), 'MKT_UNKNOWN_KEY'); // a constraint, not a scheduled job
});

// ------------------------------------------------------------------ Activation readiness (149-164)

const withStatuses = (image, text) => {
  const pick = (spec, s) => ({
    PASS: entryOf(spec), BLOCKED: entryOf(spec, { color: '#000000' }), REVIEW: entryOf(spec, { semanticAssessment: { outcome: 'REVIEW_REQUIRED', method: 'HUMAN' } }),
    UNMEASURED: { candidate: candidateOf(spec), candidateManifest: { content_kind: spec.content_kind } },
  }[s]);
  return [pick(imageSpec, image), pick(textSpec, text)];
};
const manifestWith = (image, text) => { const entries = withStatuses(image, text); return { entries, manifest: activation({ candidates: entries }) }; };

test('Activation readiness: all PASS is READY_FOR_POLICY; BLOCKED > REVIEW_REQUIRED > NOT_MEASURABLE > READY', () => {
  assert.deepEqual({ ...MANIFEST.readiness }, { status: 'READY_FOR_POLICY', reason_codes: ['ALL_DELIVERABLES_VALIDATED'] }); // 149
  const expected = [
    ['REVIEW', 'PASS', 'REVIEW_REQUIRED'], // 150
    ['BLOCKED', 'PASS', 'BLOCKED'], // 151
    ['UNMEASURED', 'PASS', 'NOT_MEASURABLE'], // 152
    ['BLOCKED', 'REVIEW', 'BLOCKED'], // 153
    ['REVIEW', 'UNMEASURED', 'REVIEW_REQUIRED'], // 154
    ['BLOCKED', 'UNMEASURED', 'BLOCKED'],
    ['PASS', 'PASS', 'READY_FOR_POLICY'],
  ];
  for (const [image, text, status] of expected) {
    const { entries, manifest } = manifestWith(image, text);
    assert.equal(manifest.readiness.status, status, `${image}/${text}`);
    assert.equal(evaluateActivationReadiness(manifest, live({ candidates: entries })).status, status, `live ${image}/${text}`);
  }
  assert.deepEqual(Object.values(ACTIVATION_READINESS), ['READY_FOR_POLICY', 'REVIEW_REQUIRED', 'BLOCKED', 'NOT_MEASURABLE', 'STALE']);
});

test('Activation readiness: STALE as soon as any governing object has expired (Finding, Push, package, authorization, Brief, candidate, manifest)', () => {
  const at = (asOf) => evaluateActivationReadiness(MANIFEST, live({ asOf }));
  const stale = (asOf) => { const r = at(asOf); assert.equal(r.status, 'STALE', asOf); return [...r.reason_codes]; };
  assert.equal(at('2026-10-17T00:00:00Z').status, 'READY_FOR_POLICY');
  assert.ok(stale('2026-10-18T00:00:00Z').includes('CANDIDATE_EXPIRED')); // 160
  assert.ok(stale('2026-10-18T00:00:00Z').includes('MANIFEST_EXPIRED'));
  assert.ok(stale('2026-10-20T00:00:00Z').includes('BRIEF_EXPIRED')); // 159
  assert.ok(stale('2026-10-22T00:00:00Z').includes('AUTHORIZATION_EXPIRED')); // 158
  assert.ok(stale('2026-10-24T00:00:00Z').includes('PACKAGE_EXPIRED')); // 157
  assert.ok(stale('2026-10-25T00:00:00Z').includes('PUSH_EXPIRED')); // 156
  assert.ok(stale('2026-10-30T12:00:00Z').includes('FINDING_EXPIRED')); // 155
  // STALE beats BLOCKED
  const { entries, manifest } = manifestWith('BLOCKED', 'PASS');
  assert.equal(evaluateActivationReadiness(manifest, live({ candidates: entries, asOf: '2026-10-18T00:00:00Z' })).status, 'STALE');
});

test('Activation readiness: a Brand Context that is GATED blocks (BLOCKED), whatever the manifest says', () => {
  const r = evaluateActivationReadiness(MANIFEST, live({ brandContext: GATED })); // 161
  assert.equal(r.status, 'BLOCKED');
  assert.deepEqual([...r.reason_codes], ['BRAND_GATED', 'BRAND_CONTEXT_NOT_READY']);
  assert.equal(evaluateActivationReadiness(MANIFEST, live({ authorization: null })).status, 'BLOCKED');
  assert.equal(code(() => activation({}, ctx({ brandContext: GATED }))), 'MKT_M3_CREATE_NOT_READY');
});

test('Activation readiness: stored validation status and stored readiness are never a live authority; READY_FOR_POLICY is not an execution approval', () => {
  // 162: a stored manifest that claims READY_FOR_POLICY while the Guardian now says BLOCKED
  const blockedNow = [entryOf(imageSpec, { color: '#000000' }), ENTRIES[1]];
  assert.equal(MANIFEST.readiness.status, 'READY_FOR_POLICY'); // the stored snapshot
  assert.equal(code(() => evaluateActivationReadiness(MANIFEST, live({ candidates: blockedNow }))), 'MKT_M3_ACTIVATION_DERIVED_MISMATCH');
  // the live answer is the Guardian's, whatever the stored fields say
  const forgedStatus = clone(MANIFEST);
  forgedStatus.deliveries[0].validation_status = 'BLOCKED';
  assert.equal(code(() => evaluateActivationReadiness(forgedStatus, live())), 'MKT_M3_ACTIVATION_DERIVED_MISMATCH');
  // 163
  const forgedReadiness = { ...clone(MANIFEST), readiness: { status: 'READY_FOR_POLICY', reason_codes: ['FORGED'] } };
  assert.equal(code(() => evaluateActivationReadiness(forgedReadiness, live())), 'MKT_M3_ACTIVATION_DERIVED_MISMATCH');
  const { entries, manifest } = manifestWith('BLOCKED', 'PASS');
  const forgedReady = { ...clone(manifest), readiness: { status: 'READY_FOR_POLICY', reason_codes: ['FORGED'] } };
  assert.equal(code(() => evaluateActivationReadiness(forgedReady, live({ candidates: entries }))), 'MKT_M3_ACTIVATION_DERIVED_MISMATCH');
  assert.equal(code(() => normalizeActivationManifest({ ...clone(MANIFEST), execution_decision: 'PUBLISH' }, { ...ctx(), brief: BRIEF, candidates: ENTRIES })), 'MKT_M3_ACTIVATION_DERIVED_MISMATCH');
  // a manifest also needs the originals and a clock: nothing is read from the object alone
  assert.equal(code(() => evaluateActivationReadiness(MANIFEST, { ...live(), tenant: undefined })), 'MKT_TENANT_INVALID');
  assert.equal(code(() => evaluateActivationReadiness(MANIFEST, { ...live(), asOf: undefined })), 'MKT_INVALID_TIMESTAMP');
  assert.equal(code(() => evaluateActivationReadiness(MANIFEST, { ...live(), finding: undefined })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => evaluateActivationReadiness(MANIFEST, { ...live(), brief: undefined })), 'MKT_INVALID_FIELD');
  assert.equal(code(() => evaluateActivationReadiness(MANIFEST, { ...live(), model: 'x' })), 'MKT_UNKNOWN_KEY');
  // 164: READY_FOR_POLICY says nothing about execution
  const ready = evaluateActivationReadiness(MANIFEST, live());
  assert.equal(ready.status, 'READY_FOR_POLICY');
  assert.equal(MANIFEST.execution_decision, null);
  assert.doesNotMatch(JSON.stringify(ready), /approved|authorized|publish|execute/i);
  assert.ok(isDeepFrozen(ready));
  // a stored Brief status is not an authority either
  assert.equal(evaluateBriefReadiness(BRIEF, ctx({ asOf: '2026-10-20T00:00:00Z' })).status, 'STALE');
  assert.equal(code(() => evaluateBriefReadiness({ ...clone(BRIEF), message_intent: 'tampered' }, ctx())), 'MKT_M3_BRIEF_DERIVED_MISMATCH');
  assert.equal(evaluateBriefReadiness(BRIEF, ctx()).status, 'READY_FOR_CREATIVE');
  assert.equal(evaluateBriefReadiness(BRIEF, ctx({ authorization: null })).status, 'NOT_AUTHORIZED');
  assert.equal(evaluateBriefReadiness(BRIEF, ctx({ brandContext: GATED })).status, 'BRAND_GATED');
});

// ------------------------------------------------------------------ Domain boundaries (165-185)

test('Domain boundaries: M3 exposes preparation contracts only - no generation, provider, routing, evaluation, publish, send, schedule or execution function', () => {
  const functions = Object.entries(m3).filter(([, v]) => typeof v === 'function').map(([k]) => k).sort();
  assert.deepEqual(functions, [
    'buildActivationManifest', 'buildCreativeBrief', 'buildCreativeHandoff', 'buildCreativeValidationReport', 'evaluateActivationReadiness', 'evaluateBriefReadiness',
    'evaluateCreateGate', 'normalizeActivationManifest', 'normalizeCreativeBrief', 'normalizeSelectedCreativeCandidate', 'normalizeSocleCreateAuthorization',
  ]);
  assert.doesNotMatch(Object.keys(m3).join(' '), /generate|render|draw|image|video|text(?!ure)|copy|prompt|provider|route|routing|alibaba|openai|runway|qwen|choose|select(?!ed)|rank|score|judge|publish|send|schedule|execute|post|override|force|approve|authorize|issue|grant/i); // 165-181
});

test('Static scope: no clock, randomness, network, database, filesystem, provider or model call, and no merchant-specific code in any M3 file', async () => {
  for (const name of M3_FILES) {
    const text = stripComments(await read(name));
    assert.doesNotMatch(text, /Date\.now|new Date\(\)|Math\.random|randomUUID|process\.env|fetch\(|axios|XMLHttpRequest|require\(|writeFile|readFile|createClient|supabase/i, name); // 182-184
    assert.doesNotMatch(text, /openai|anthropic|gemini|qwen|alibaba|runway|minimax/i, name); // 185
    assert.doesNotMatch(await read(name), /habb|shopify|namur|belgi/i, name);
    assert.doesNotMatch(text, /\bpublish\b|\bsend\b|\bschedule\b|execution_decision:\s*true|forcePublish|publishAnyway|approveActivation|overrideGuardian/, name);
    // the forbidden-key LISTS (data) legitimately contain words such as prompt / provider / winner / score: only m3-constants may
    if (name !== 'm3-constants') assert.doesNotMatch(text, /\bprompt\b|negative_prompt|model_id|\bprovider\b|selected_option|\bwinner\b|\bscore\b/, name);
    for (const call of text.matchAll(/new Date\(([^)]*)\)/g)) assert.notEqual(call[1].trim(), '', `${name}: new Date() without argument`);
  }
  // the only things M3 imports from other domains are the Branding public contracts and the M1 / M2 primitives
  const allowed = /^(\.\/|\.\.\/branding\/(interfaces|constants|candidate-manifest|guardian)\.js$)/;
  for (const name of M3_FILES) {
    for (const spec of [...(await read(name)).matchAll(/from '([^']+)'/g)].map((m) => m[1])) {
      assert.match(spec, allowed, `${name} imports ${spec}`);
      assert.doesNotMatch(spec, /creative-fidelity|marketing-creative|alibaba|gemini|minimax|finance|inventory|customers|metrics|sync|shopify|supabase|connectors|index\.js$/, `${name} imports ${spec}`);
    }
  }
  // branding and guardian are reused, never modified or re-implemented
  assert.doesNotMatch(await read('creative-validation'), /function evaluateBrandGuardian|function evaluateHardRules|function normalizeCandidateManifest/);
});

// ------------------------------------------------------------------ Non-regression (186-192)

test('Non-regression: M1, M1.5, M2 and Measurement keep their public surface; the experimental providers are not activated', async () => {
  assert.deepEqual(Object.keys(understand).sort(), [
    'AXIS_NOT_ASSESSED', 'CITED_SIGNAL_EXPIRED', 'CONTEXT_INPUT_CATEGORY', 'CONTEXT_VERSION', 'DOMAIN_FIT_STATUS', 'FINDING_TYPE', 'FRESHNESS', 'MATERIALITY_AXIS',
    'MATERIALITY_OVERALL', 'MATERIALITY_STATUS', 'MKT_ERROR', 'MarketingUnderstandError', 'READINESS', 'RESERVED_SIGNAL_TYPES', 'SIGNAL_CLASS', 'SIGNAL_CLASS_LIMITATION',
    'TARGET_DOMAIN', 'TESTABILITY', 'UNDERSTAND_VERSION', 'assessMateriality', 'buildDomainFit', 'buildMarketSignal', 'buildMarketingContext', 'buildMarketingFinding',
    'evaluateFindingReadiness', 'findingFreshness', 'isMarketSignalExpired', 'marketSignalFreshness', 'normalizeMarketSignal', 'normalizeMarketingFinding',
    'normalizeMaterialityAssessment',
  ].sort()); // 186
  assert.deepEqual(Object.keys(lostDemand).sort(), ['LOST_DEMAND_KIND', 'LOST_DEMAND_SIGNAL_TYPE', 'produceLostDemandSignal']); // 187
  assert.deepEqual(Object.keys(calendarSignals).sort(), ['CALENDAR_KIND', 'CALENDAR_SIGNAL_TYPE', 'produceCalendarSignal']);
  assert.deepEqual(Object.keys(manualObservation), ['produceManualObservationSignal']);
  assert.deepEqual(Object.entries(m2).filter(([, v]) => typeof v === 'function').map(([k]) => k).sort(), [ // 188
    'assessLeverFitness', 'buildAudienceIntent', 'buildEstimatedLeadTime', 'buildExecutionWindow', 'buildMarketingPushProposal', 'buildMeasurementPlan', 'buildResourceRequirements',
    'buildReversibility', 'buildSocleDecisionPackage', 'evaluateLeadTimeFit', 'evaluatePackageStatus', 'evaluatePushReadiness', 'normalizeLeverFitness',
    'normalizeMarketingPushProposal', 'normalizeSocleDecisionPackage',
  ]);
  assert.deepEqual(Object.keys(phase3), ['phase3Inputs']); // 191
  assert.equal(typeof measurementBuild.buildMarketingFacts, 'function');
  assert.equal(typeof (await import('../src/branding/guardian.js')).evaluateBrandGuardian, 'function'); // reused, present
  const cli = await read('index');
  assert.doesNotMatch(cli, /m3|creative-brief|activation-manifest/); // the CLI is untouched
  // M3 consumed only M1/M2 contracts through their public builders, and the experimental provider lanes stay unreferenced
  for (const name of M3_FILES) assert.doesNotMatch(stripComments(await read(name)), /marketing-creative/, name);
  // 189 / 190 / 192: the Branding and Creative Fidelity suites and the full suite are executed by the Marketing V1 workflow
});

// ------------------------------------------------------------------ coverage matrix (doc <-> tests)

test('Coverage matrix: the doc maps all 192 mandate cases, and every test it names exists', async () => {
  const doc = await readFile(new URL('../docs/architecture/marketing-m3-create-contract.md', import.meta.url), 'utf8');
  const self = await readFile(new URL(import.meta.url), 'utf8');
  const matrix = doc.slice(doc.indexOf('<!-- coverage-matrix:start -->'), doc.indexOf('<!-- coverage-matrix:end -->'));
  const rows = [...matrix.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ n: Number(m[1]), name: m[3] }));
  assert.ok(rows.length >= 192);
  assert.deepEqual(rows.map((r) => r.n), Array.from({ length: rows.length }, (_, i) => i + 1)); // contiguous: the mandate numbering 1-192 is never reshuffled
  for (const { n, name } of rows) {
    const known = name.startsWith('(CI)') || self.includes(`test('${name}'`);
    assert.ok(known, `mandate case ${n} names a test that does not exist: ${name}`);
  }
});
