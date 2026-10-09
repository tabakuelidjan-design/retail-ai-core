// A REAL Marketing M3 world, built with the real Marketing and Branding builders (Finding -> Push -> Package -> Authorization ->
// Brand Context -> CreativeBrief -> CreativeHandoffPackage). Nothing here is a fixture invented for Creative Intelligence: the same
// chain the M3 suite uses, rebuilt locally because that suite does not export it (and M3 is deliberately not modified).

import { buildCreativeBrief, buildCreativeHandoff } from '../src/marketing/m3.js';
import { assessMateriality, buildMarketingContext, buildMarketingFinding } from '../src/marketing/understand.js';
import { assessLeverFitness, buildMarketingPushProposal, buildSocleDecisionPackage } from '../src/marketing/m2.js';
import {
  approveBrandCore, approveBrandMemory, buildBrandContext, buildBrandCoreProposal, buildBrandIdentity, buildBrandMemoryDraft,
  normalizeBrandSnapshot, submitBrandMemoryForReview,
} from '../src/branding/index.js';

export const M1 = '11111111-1111-4111-8111-111111111111';
export const M2 = '22222222-2222-4222-8222-222222222222';
export const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const tenant = (merchantId = M1) => ({ merchantId, source: 'env' });
const FINDING_AT = '2026-10-08T12:00:00Z';
const M2_AT = '2026-10-08T13:00:00Z';
export const M3_CLOCK = '2026-10-09T10:00:00Z';

const brandOf = (merchantId, brandId) => buildBrandIdentity({
  tenant: tenant(merchantId), brandId, name: 'Brand', createdAt: '2026-10-01T09:00:00Z', defaultLocale: 'fr-BE', supportedLocales: ['fr-BE', 'nl-BE'],
});
const colorRule = { id: 'r1', rule_type: 'COLOR', subject: 'logo.color', operator: 'EQUALS', value: '#112233', severity: 'BLOCK', scope: 'GLOBAL', source_ref: 'brand-core://core-v1' };

function readyBrandContext({ merchantId = M1, brandId = B1 } = {}) {
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
  const draft = buildBrandMemoryDraft({ tenant: t, brand, id: 'mem-v1', createdAt: '2026-10-08T12:00:00Z', core, content: { hard_rules: [colorRule], design_tokens: { colors: { primary: '#112233' } } } }).memory;
  const reviewed = submitBrandMemoryForReview({ memory: draft, core, tenant: t, brand });
  const memory = approveBrandMemory({ memory: reviewed, core, tenant: t, brand, resolvedActor: actor, approvedAt: '2026-10-08T13:00:00Z' }).approvedMemory;
  return buildBrandContext({ tenant: t, brand, core, memory });
}

const axisOf = (status) => ({ status, reason_codes: ['REASON'], evidence_refs: ['ev/fit'] });
const allFit = () => assessLeverFitness({ FINDING_FIT: axisOf('FIT'), AUDIENCE_FIT: axisOf('FIT'), CHANNEL_FIT: axisOf('FIT'), MEASUREMENT_FIT: axisOf('FIT') });
const plan = { baseline_ref: 'metric/baseline', primary_metric_ref: 'metric/orders', observation_window: { start: '2026-10-10T00:00:00Z', end: '2026-10-24T00:00:00Z' }, control_method: 'TIME', eligibility_status: 'ELIGIBLE', success_criterion_ref: 'criterion/ok', failure_criterion_ref: 'criterion/ko' };

/** The real chain, ending in a real CreativeHandoffPackage. Returns every original so a test can compare field by field. */
export function buildM3World({ deliverables } = {}) {
  const brandContext = readyBrandContext();
  const t = tenant();
  const context = buildMarketingContext({ tenant: t, asOf: FINDING_AT, brandId: B1, brandContext });
  const finding = buildMarketingFinding({
    tenant: t, context, finding_type: 'OPPORTUNITY', subject_refs: ['category://phone-cases'], statement: 'Demand that the offer does not serve.',
    window: { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' }, evidence_refs: ['ev/1'],
    materiality: assessMateriality({ CUSTOMER: { status: 'MATERIAL', reason_codes: ['R'], evidence_refs: ['ev/1'] } }),
    domain_fit: { status: 'MARKETING_RELEVANT', reason_codes: ['FITS'] }, created_at: FINDING_AT, expires_at: '2026-10-30T12:00:00Z',
  });
  const push = buildMarketingPushProposal({
    tenant: t, finding, asOf: M2_AT, action_mode: 'TEST_SMALL', lever_family: 'VISIBILITY', objective: 'Make the unserved demand visible in store.',
    subject_refs: ['category://phone-cases'], audience: { mode: 'GENERAL' }, channels: ['STORE_FRONT'], lever_fitness: allFit(), resource_requirements: {},
    estimated_lead_time: { value: 2, unit: 'DAYS', basis: 'OWNER_DECIDED' }, valid_execution_window: { start: '2026-10-09T00:00:00Z', end: '2026-10-20T00:00:00Z' },
    measurement_plan: plan, claim_refs: ['claim://approved-1'], policy_requirement_refs: ['policy://promo'], consent_requirement_refs: ['consent://optin'],
    promotion_rule_refs: ['promo-rule://threshold'], reversibility: { status: 'FULLY_REVERSIBLE', reason_codes: ['REMOVABLE'] }, expires_at: '2026-10-25T00:00:00Z',
  });
  const decisionPackage = buildSocleDecisionPackage({
    tenant: t, finding, asOf: M2_AT, proposals: [push], do_nothing: { reason_codes: ['BASELINE_OK'], evidence_refs: ['ev/base'] },
    test_small_disposition: { status: 'INCLUDED', proposal_ref: push.push_id }, expires_at: '2026-10-24T00:00:00Z',
  });
  const authorization = {
    authorization_ref: 'auth://create-1', decision_ref: 'decision://socle-1', package_ref: decisionPackage.package_id, push_ref: push.push_id, scope: 'CREATE',
    status: 'APPROVED', authorized_at: '2026-10-08T13:30:00Z', expires_at: '2026-10-22T00:00:00Z',
  };
  const image = {
    content_kind: 'IMAGE', channel: 'STORE_FRONT', placement: 'WINDOW_POSTER', format_ref: 'format://poster-a3', locale: 'fr-BE', needed_by: '2026-10-15T00:00:00Z',
    source_asset_refs: ['asset://product-2'], mandatory_content_refs: ['content://spec-line'], requirement_refs: ['req://print-ready'],
  };
  const text = { content_kind: 'TEXT', channel: 'STORE_FRONT', placement: 'STORE_POSTER', format_ref: 'format://caption', locale: 'nl-BE', needed_by: '2026-10-14T00:00:00Z' };
  const originals = { tenant: t, finding, decisionPackage, push, authorization, brandContext, asOf: M3_CLOCK };
  const creative_brief = buildCreativeBrief({
    ...originals,
    message_intent: 'Make the unserved demand visible.', cta_intent: 'Invite people to ask in store.', deliverables: deliverables ?? [image, text],
    source_asset_refs: ['asset://product-1'], mandatory_content_refs: ['content://legal-line'], prohibited_content_refs: ['content://forbidden-claims'],
    locales: ['fr-BE', 'nl-BE'], brief_limitations: ['DRAFT_INTENT'], expires_at: '2026-10-20T00:00:00Z',
  });
  const handoff = buildCreativeHandoff({ ...originals, brief: creative_brief });
  return {
    handoff, brief: creative_brief, push, finding, brandContext, imageSpec: creative_brief.deliverables.find((d) => d.content_kind === 'IMAGE'),
    textSpec: creative_brief.deliverables.find((d) => d.content_kind === 'TEXT'),
  };
}

/** What a trusted Format Resolver would answer for the poster format: a platform-level FORMAT with its technical facts. */
export const posterFormat = (over = {}) => ({
  ref: 'format://poster-a3',
  kind: 'FORMAT',
  merchant_id: null,
  version: 1,
  status: 'ACTIVE',
  metadata: {
    canvas: { width: 2000, height: 2800 },
    aspect_ratio: '5:7',
    physical_or_digital: 'PHYSICAL',
    viewing_distance_m: 2,
    expected_dwell_time_s: 3,
    safe_zones: [{ zone_id: 'safe', x: 100, y: 100, width: 1800, height: 2600 }],
    forbidden_zones: [],
    production_constraints: ['PRINT_READY'],
  },
  ...over,
});
