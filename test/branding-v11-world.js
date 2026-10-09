// A real Brand flow (Snapshot -> Core -> Memory -> Context) built with the real Branding functions, parameterized by the Memory content, so
// that Brand Memory V1 / V1.1 can be exercised end to end. Generic and synthetic: no merchant-specific rule.

import {
  approveBrandCore, approveBrandMemory, buildBrandContext, buildBrandCoreProposal, buildBrandIdentity, buildBrandMemoryDraft,
  normalizeBrandSnapshot, proposeBrandMemoryRevision, submitBrandMemoryForReview,
} from '../src/branding/index.js';

export const MERCHANT = '11111111-1111-4111-8111-111111111111';
export const OTHER_MERCHANT = '22222222-2222-4222-8222-222222222222';
export const BRAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const tenant = (merchantId = MERCHANT) => ({ merchantId, source: 'env' });
export const brandOf = (supportedLocales = ['fr-BE', 'nl-BE', 'ar-MA'], merchantId = MERCHANT) => buildBrandIdentity({
  tenant: tenant(merchantId), brandId: BRAND, name: 'Brand', createdAt: '2026-10-01T09:00:00Z', defaultLocale: supportedLocales[0], supportedLocales,
});
const actor = (merchantId = MERCHANT) => ({ user_id: 'user-owner-1', role: 'OWNER', merchant_id: merchantId });

export const colorRule = { id: 'r1', rule_type: 'COLOR', subject: 'logo.color', operator: 'EQUALS', value: '#112233', severity: 'BLOCK', scope: 'GLOBAL', source_ref: 'brand-core://core-v1' };

/** A sample, GENERIC expression system (no merchant): a few guidelines, one locale override. */
export const sampleExpression = () => ({
  photography: {
    principles: ['natural directional light', 'one clear subject'],
    do: ['keep the product in sharp focus'],
    dont: ['avoid cluttered backgrounds'],
    reference_asset_refs: ['approved-asset://photo-ref-1'],
  },
  composition: { principles: ['generous negative space', 'the product stays visually dominant'], dont: ['avoid crowded compositions'] },
  locale_overrides: { 'fr-BE': { composition: { principles: ['leave extra room for longer French headlines'] } } },
});

export function buildCore(merchantId = MERCHANT, supportedLocales) {
  const t = tenant(merchantId);
  const brand = brandOf(supportedLocales, merchantId);
  const snapshot = normalizeBrandSnapshot({
    id: 'snapshot-1', merchant_id: merchantId, brand_id: BRAND, version: 1, status: 'READY',
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
    evidence: [{ id: 'e1', provenance: 'observed', statement: 'Observed', completeness: 'COMPLETE', source: { system: 'internal', observed_at: '2026-10-08T08:00:00Z', kind: 'INTERNAL_FACT' } }],
  });
  const proposal = buildBrandCoreProposal({
    id: 'core-v1', tenant: t, brand, createdAt: '2026-10-08T10:00:00Z', snapshot,
    decisions: {
      category: 'category', buying_contexts: ['context'], value_proposition: 'Value', positioning: 'Position', core_promise: 'Promise',
      reasons_to_believe: ['Reason'], personality: ['clear'], voice: { traits: ['clear'], do: ['be specific'], dont: ['invent'] },
      exclusions: ['do not mislead'], distinctive_assets: [], evidence_refs: ['e1'],
    },
  }).core;
  const core = approveBrandCore({ proposal, snapshot, tenant: t, brand, resolvedActor: actor(merchantId), approvedAt: '2026-10-08T10:30:00Z' }).approvedCore;
  return {
    tenant: t, brand, snapshot, core,
  };
}

/** Draft -> review -> approve a Memory. `content` is the Memory content (hard rules, tokens, expression_system...). */
export function buildMemoryFlow({ content = { hard_rules: [colorRule], design_tokens: { colors: { primary: '#112233' } } }, supportedLocales, merchantId = MERCHANT } = {}) {
  const world = buildCore(merchantId, supportedLocales);
  const { tenant: t, brand, core } = world;
  const draft = buildBrandMemoryDraft({ tenant: t, brand, id: 'mem-v1', createdAt: '2026-10-08T12:00:00Z', core, content });
  const reviewed = submitBrandMemoryForReview({ memory: draft.memory, core, tenant: t, brand });
  const approval = approveBrandMemory({ memory: reviewed, core, tenant: t, brand, resolvedActor: actor(merchantId), approvedAt: '2026-10-08T13:00:00Z' });
  const context = buildBrandContext({ tenant: t, brand, core, memory: approval.approvedMemory, snapshot: world.snapshot });
  return {
    ...world, draft: draft.memory, reviewed, approved: approval.approvedMemory, event: approval.decisionEvent, context,
  };
}

export function reviseMemory(flow, changes, id = 'mem-v2') {
  const revision = proposeBrandMemoryRevision({ approvedMemory: flow.approved, core: flow.core, tenant: flow.tenant, brand: flow.brand, id, createdAt: '2026-10-09T09:00:00Z', changes });
  const approval = approveBrandMemory({
    memory: revision.memory, core: flow.core, tenant: flow.tenant, brand: flow.brand, resolvedActor: actor(), activeMemory: flow.approved, approvedAt: '2026-10-09T10:00:00Z',
  });
  return { revision, ...approval };
}
