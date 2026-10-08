// Shared fixtures for the Marketing M4 tests: a REAL chain Finding -> Push -> Decision Package -> Brief -> candidates -> ActivationManifest,
// built with the M1 / M2 / M3 public builders (nothing is forged), parametrized by the MeasurementPlan.
import assert from 'node:assert/strict';

import {
  buildActivationManifest, buildCreativeBrief,
} from '../src/marketing/m3.js';
import { MarketingUnderstandError, assessMateriality, buildMarketingContext, buildMarketingFinding } from '../src/marketing/understand.js';
import { assessLeverFitness, buildMarketingPushProposal, buildSocleDecisionPackage } from '../src/marketing/m2.js';
import {
  approveBrandCore, approveBrandMemory, buildBrandContext, buildBrandCoreProposal, buildBrandIdentity, buildBrandMemoryDraft,
  normalizeBrandSnapshot, submitBrandMemoryForReview,
} from '../src/branding/index.js';

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

// The MeasurementPlan variants M4 cares about. Observation window: 2026-10-10 -> 2026-10-24.
export const PLANS = {
  NONE: { control_method: 'NONE', eligibility_status: 'NOT_ELIGIBLE' },
  TIME: { control_method: 'TIME', eligibility_status: 'ELIGIBLE' },
  HOLDOUT: { control_method: 'HOLDOUT', eligibility_status: 'ELIGIBLE', eligibility_evidence_refs: ['ev/holdout-design'] },
};
export const MEASURE = { baseline_ref: 'metric/baseline', primary_metric_ref: 'metric/orders', guardrail_metric_refs: ['metric/returns'], observation_window: { start: '2026-10-10T00:00:00Z', end: '2026-10-24T00:00:00Z' }, success_criterion_ref: 'criterion/ok', failure_criterion_ref: 'criterion/ko', stop_rule_refs: ['stop/low-stock', 'stop/complaints'] };

const candidateFor = (brief, spec) => ({
  candidate_id: `cand-${spec.content_kind.toLowerCase()}-1`, merchant_id: M1, brand_id: B1, brief_ref: brief.brief_id, deliverable_ref: spec.deliverable_id,
  selection_ref: 'selection://ci-run-1', content_kind: spec.content_kind, channel: spec.channel, asset_refs: ['asset://out-1'], provenance_ref: 'provenance://ci-run-1',
  selected_at: '2026-10-10T09:00:00Z', candidate_expires_at: '2026-10-18T00:00:00Z',
});
const manifestFor = (kind) => ({ content_kind: kind, colors: [{ subject: 'logo.color', coverage: 'COMPLETE', values: ['#112233'], evidence_refs: ['ev/color'] }] });

/** A REAL chain for a given MeasurementPlan variant (name in PLANS). Returns every original M4 needs. */
export function chainFor(planName = 'HOLDOUT', { channels = ['STORE_FRONT'], hypothesis = false } = {}) {
  const t = tenant();
  const finding = FINDING;
  const measurement_plan = { ...MEASURE, ...PLANS[planName] };
  const hypothesis_ref = hypothesis ? finding.hypotheses[0]?.hypothesis_id : undefined;
  const push = pushOf(finding, { measurement_plan, channels, ...(hypothesis_ref ? { hypothesis_ref } : {}) });
  const decisionPackage = packageOf(finding, [push]);
  const authorization = authFor(decisionPackage, push);
  const context = { tenant: t, finding, decisionPackage, push, authorization, brandContext: BRAND, asOf: T };
  const brief = buildCreativeBrief({ ...context, ...briefFields({ deliverables: [dImage({ channel: channels[0] }), dText({ channel: channels[0] })] }) });
  const specs = brief.deliverables;
  const candidates = specs.map((spec) => ({ candidate: candidateFor(brief, spec), candidateManifest: manifestFor(spec.content_kind) }));
  const activationManifest = buildActivationManifest({
    ...context, brief, candidates, activation_window: { start: '2026-10-12T00:00:00Z', end: '2026-10-17T00:00:00Z' }, expires_at: '2026-10-18T00:00:00Z',
  });
  return { tenant: t, finding, push, decisionPackage, brief, activationManifest, planName };
}

export { M1, M2, B1, B2, tenant };
