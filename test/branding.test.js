import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAND_CONTEXT_STATUS,
  BRAND_RULE_TYPE,
  CLAIM_KIND,
  DEFAULT_MAX_DIRECT_COMPETITORS,
  EVIDENCE_PROVENANCE,
  GOVERNED_DOCUMENT_STATUS,
  RULE_OPERATOR,
  RULE_SEVERITY,
  SNAPSHOT_REFRESH_TRIGGER,
  SNAPSHOT_RESEARCH_QUESTION,
  SNAPSHOT_SOURCE_KIND,
  SNAPSHOT_STATUS,
  SNAPSHOT_TOPIC,
  approveBrandCore,
  buildBrandContext,
  buildBrandIdentity,
  buildBrandCoreProposal,
  buildBrandSnapshotV1,
  buildCoreDecisionPacket,
  buildSnapshotResearchPlan,
  creativeBrandInterface,
  detectSnapshotContradictions,
  evaluateSnapshotRefresh,
  marketingBrandInterface,
  normalizeBrandCore,
  normalizeBrandMemory,
  normalizeBrandSnapshot,
  proposeBrandCoreRevision,
  selectActiveBrandCore,
  validateCoreForApproval,
  validateBrandMemory,
  validateSnapshotReadiness,
} from '../src/branding/index.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const tenant = (merchantId = M1) => ({ merchantId, source: 'env' });
const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const B3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// A brand of the given merchant (the server-side registry would issue it); B1 for M1, B3 for others.
const brand = (merchantId = M1, over = {}) => buildBrandIdentity({
  tenant: tenant(merchantId),
  brandId: merchantId === M1 ? B1 : B3,
  name: 'Brand One',
  createdAt: '2026-10-01T09:00:00Z',
  defaultLocale: 'fr-BE',
  supportedLocales: ['fr-BE', 'nl-BE'],
  ...over,
});
// Stands for the actor the trusted server/Socle context would hand to Branding.
const resolvedActor = (merchantId = M1, over = {}) => ({
  user_id: 'user-owner-1',
  role: 'OWNER',
  merchant_id: merchantId,
  ...over,
});

const approvalRecord = {
  decision_event_id: 'bde_test',
  approved_by: 'user-owner-1',
  approver_role: 'OWNER',
  approved_at: '2026-10-08T11:00:00Z',
};

const coreApproved = (over = {}) => normalizeBrandCore({
  id: 'core-1',
  merchant_id: M1, brand_id: B1,
  version: 1,
  status: GOVERNED_DOCUMENT_STATUS.APPROVED,
  created_at: '2026-10-08T10:00:00Z',
  category: 'category',
  buying_contexts: ['need-a-solution'],
  value_proposition: 'Useful value proposition',
  positioning: 'Clear position',
  core_promise: 'Core promise',
  reasons_to_believe: ['Observed capability'],
  personality: ['clear'],
  voice: { traits: ['clear'], do: ['be specific'], dont: ['invent'] },
  exclusions: ['do not mislead'],
  distinctive_assets: [],
  evidence_refs: ['e1'],
  snapshot_ref: { id: 'snapshot-core-1', version: 1 },
  approval: approvalRecord,
  ...over,
});

const memoryWith = (hardRules, over = {}) => normalizeBrandMemory({
  id: 'memory-1',
  merchant_id: M1, brand_id: B1,
  version: 1,
  status: GOVERNED_DOCUMENT_STATUS.APPROVED,
  created_at: '2026-10-08T10:30:00Z',
  core_ref: { id: 'core-1', version: 1 },
  identity_references: { primary_logo_ref: 'asset://logo-primary' },
  design_tokens: { colors: { primary: '#112233' } },
  hard_rules: hardRules,
  semantic_context: { voice_traits: ['clear'] },
  external_references: { production_asset_refs: ['production://template-1'], claim_refs: ['claim://price-policy'] },
  approval: { ...approvalRecord, approved_at: '2026-10-08T11:05:00Z' },
  ...over,
});

const wordingRule = {
  id: 'r1',
  rule_type: BRAND_RULE_TYPE.TEXT,
  subject: 'text.body',
  operator: RULE_OPERATOR.NOT_CONTAINS,
  value: 'forbidden',
  severity: RULE_SEVERITY.BLOCK,
  scope: 'GLOBAL',
  source_ref: 'brand-core://core-1',
};
const memoryApproved = () => memoryWith([wordingRule]);

const evidence = (over = {}) => ({
  id: 'e1',
  provenance: EVIDENCE_PROVENANCE.OBSERVED,
  statement: 'Observed statement',
  source: {
    system: 'merchant_site',
    ref: 'https://example.test',
    observed_at: '2026-10-08T08:00:00Z',
    kind: SNAPSHOT_SOURCE_KIND.OWNED_SURFACE,
  },
  completeness: 'COMPLETE',
  ...over,
});

// ---------------------------------------------------------------- Snapshot / evidence

test('claim kind (FACT/INFERENCE/HYPOTHESIS) and evidence provenance are separate fields', () => {
  const snapshot = normalizeBrandSnapshot({
    id: 'snapshot-1',
    merchant_id: M1, brand_id: B1,
    version: 1,
    status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-08T09:00:00Z',
    observed_at: '2026-10-08T09:00:00Z',
    evidence: [evidence()],
    positioning: [{ id: 'f1', statement: 'Observed position', claim_kind: CLAIM_KIND.FACT, evidence_refs: ['e1'] }],
    refresh_triggers: [{ type: SNAPSHOT_REFRESH_TRIGGER.OFFER_PORTFOLIO_CHANGED, occurred_at: '2026-10-08T08:30:00Z' }],
  });
  assert.equal(validateSnapshotReadiness(snapshot).ok, true);
  assert.equal(snapshot.evidence[0].provenance, 'observed');
  assert.equal('claim_kind' in snapshot.evidence[0], false);
  assert.equal('provenance' in snapshot.positioning[0], false);
});

test('a FACT claim backed only by inferred or unavailable evidence is rejected', () => {
  for (const provenance of [EVIDENCE_PROVENANCE.INFERRED, EVIDENCE_PROVENANCE.UNAVAILABLE]) {
    const snapshot = normalizeBrandSnapshot({
      id: 's', merchant_id: M1, brand_id: B1, version: 1, status: SNAPSHOT_STATUS.READY,
      created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
      evidence: [evidence({ provenance })],
      positioning: [{ id: 'f1', statement: 'x', claim_kind: CLAIM_KIND.FACT, evidence_refs: ['e1'] }],
    });
    assert.ok(validateSnapshotReadiness(snapshot).reasons.includes('FACT_REQUIRES_OBSERVED_EVIDENCE'));
  }
});

test('an INFERENCE may rest on inferred evidence', () => {
  const snapshot = normalizeBrandSnapshot({
    id: 's', merchant_id: M1, brand_id: B1, version: 1, status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
    evidence: [evidence({ provenance: EVIDENCE_PROVENANCE.INFERRED })],
    positioning: [{ id: 'f1', statement: 'x', claim_kind: CLAIM_KIND.INFERENCE, evidence_refs: ['e1'] }],
  });
  assert.equal(validateSnapshotReadiness(snapshot).ok, true);
});

test('snapshot READY without evidence is rejected by readiness validation', () => {
  const snapshot = normalizeBrandSnapshot({
    id: 'snapshot-1', merchant_id: M1, brand_id: B1, version: 1, status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
  });
  assert.ok(validateSnapshotReadiness(snapshot).reasons.includes('SNAPSHOT_READY_WITHOUT_EVIDENCE'));
});

test('documents only accept a canonical tenant UUID as merchant_id', () => {
  assert.throws(() => normalizeBrandSnapshot({
    id: 's', merchant_id: 'merchant-1', version: 1, status: SNAPSHOT_STATUS.DRAFT,
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
  }), /tenant UUID/);
});

test('builders take a resolved tenant, not a free merchant id', () => {
  assert.throws(() => buildSnapshotResearchPlan({ tenant: { merchantId: M1 } }), /canonical tenant source/);
  assert.throws(() => buildSnapshotResearchPlan({ tenant: { merchantId: 'x', source: 'env' } }), /tenant UUID/);
  assert.throws(() => buildSnapshotResearchPlan({}), /tenant must be an object/);
});

// ---------------------------------------------------------------- Core document

test('approved core requires operationally useful fields and approval record', () => {
  assert.equal(validateCoreForApproval(coreApproved()).ok, true);

  const weak = normalizeBrandCore({
    id: 'c', merchant_id: M1, brand_id: B1, version: 1, status: GOVERNED_DOCUMENT_STATUS.APPROVED,
    created_at: '2026-10-08T09:00:00Z',
  });
  const result = validateCoreForApproval(weak);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('CONCRETE_EXCLUSION_REQUIRED'));
  assert.ok(result.reasons.includes('APPROVAL_RECORD_REQUIRED'));
});

test('priority distinctive assets are intentionally bounded', () => {
  assert.throws(() => coreApproved({
    distinctive_assets: [1, 2, 3, 4].map((i) => ({ id: `a${i}`, type: 'OTHER', description: `asset ${i}` })),
  }), /at most 3/);
});

test('approved memory must bind to the approved core of the same merchant/version', () => {
  const core = coreApproved();
  assert.equal(validateBrandMemory(memoryApproved(), { core }).ok, true);
  const wrongCore = coreApproved({ merchant_id: M2 });
  assert.ok(
    validateBrandMemory(memoryApproved(), { core: wrongCore }).reasons
      .includes('CORE_MEMORY_MERCHANT_MISMATCH'),
  );
});

test('empty Brand Memory is never considered ready', () => {
  const empty = normalizeBrandMemory({
    id: 'mem', merchant_id: M1, brand_id: B1, version: 1,
    status: GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED,
    created_at: '2026-10-08T10:00:00Z',
    core_ref: { id: 'core-1', version: 1 },
  });
  assert.ok(validateBrandMemory(empty, { core: coreApproved() }).reasons.includes('BRAND_MEMORY_EMPTY'));
});

// ---------------------------------------------------------------- Context / interfaces

test('brand context gates Marketing and Creative when Core or Memory are missing', () => {
  const gated = buildBrandContext({ tenant: tenant(), brand: brand(), core: coreApproved(), memory: null });
  assert.equal(gated.status, BRAND_CONTEXT_STATUS.GATED);
  assert.equal(gated.memory, null);
  assert.ok(gated.reasons.includes('BRAND_MEMORY_MISSING'));
  assert.throws(() => marketingBrandInterface(gated), /gated/);
});

test('brand context is gated for another tenant', () => {
  const context = buildBrandContext({ tenant: tenant(M2), brand: brand(M2), core: coreApproved(), memory: memoryApproved() });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(context.reasons.includes('BRAND_CORE_TENANT_MISMATCH'));
  assert.ok(context.reasons.includes('BRAND_MEMORY_TENANT_MISMATCH'));
});

test('ready brand context exposes narrow Marketing and Creative interfaces', () => {
  const context = buildBrandContext({ tenant: tenant(), brand: brand(), core: coreApproved(), memory: memoryApproved() });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);
  assert.deepEqual(context.review_signals, []);

  const marketing = marketingBrandInterface(context);
  const creative = creativeBrandInterface(context);
  assert.equal(marketing.core_promise, 'Core promise');
  assert.deepEqual(creative.external_references.production_asset_refs, ['production://template-1']);
  assert.equal('budget' in marketing, false);
  assert.equal('publish' in creative, false);
});

test('a STALE snapshot is a review signal, never an automatic block', () => {
  const stale = normalizeBrandSnapshot({
    id: 'snapshot-core-1', merchant_id: M1, brand_id: B1, version: 1, status: SNAPSHOT_STATUS.STALE,
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
  });
  const context = buildBrandContext({
    tenant: tenant(), brand: brand(), core: coreApproved(), memory: memoryApproved(), snapshot: stale,
  });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);
  assert.deepEqual(context.review_signals, ['BRAND_SNAPSHOT_STALE']);
  assert.deepEqual(marketingBrandInterface(context).review_signals, ['BRAND_SNAPSHOT_STALE']);
  assert.deepEqual(creativeBrandInterface(context).review_signals, ['BRAND_SNAPSHOT_STALE']);
});

test('a newer snapshot than the one behind the Core raises an outdated-reference signal', () => {
  const newer = normalizeBrandSnapshot({
    id: 'snapshot-core-2', merchant_id: M1, brand_id: B1, version: 1, status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-09T09:00:00Z', observed_at: '2026-10-09T09:00:00Z',
  });
  const context = buildBrandContext({
    tenant: tenant(), brand: brand(), core: coreApproved(), memory: memoryApproved(), snapshot: newer,
  });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);
  assert.deepEqual(context.review_signals, ['BRAND_SNAPSHOT_REFERENCE_OUTDATED']);
});

// ---------------------------------------------------------------- Guardian

test('generic branding source contains no merchant-specific architecture', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const files = (await readdir('src/branding')).filter((name) => name.endsWith('.js'));
  assert.equal(files.includes('lifecycle.js'), false);
  for (const file of files) {
    const source = await readFile(`src/branding/${file}`, 'utf8');
    assert.equal(/habb|namur|tyeso/i.test(source), false, file);
  }
});

// ---------------------------------------------------------------- Snapshot engine

test('research plan competitor cap is a configurable default, not a hard invariant', () => {
  assert.equal(DEFAULT_MAX_DIRECT_COMPETITORS, 3);
  assert.throws(() => buildSnapshotResearchPlan({
    tenant: tenant(), brand: brand(), directCompetitors: ['c1', 'c2', 'c3', 'c4'],
  }), /at most 3/);

  const plan = buildSnapshotResearchPlan({ tenant: tenant(), brand: brand(), directCompetitors: ['c1', 'c2', 'c3'] });
  assert.equal(plan.max_direct_competitors, 3);
  assert.equal(plan.continuous_crawling, false);
  assert.equal(plan.questions.length, 4);

  const wider = buildSnapshotResearchPlan({
    tenant: tenant(), brand: brand(), directCompetitors: ['c1', 'c2', 'c3', 'c4'], maxDirectCompetitors: 5,
  });
  assert.equal(wider.max_direct_competitors, 5);
  assert.equal(wider.direct_competitors.length, 4);
  assert.throws(() => buildSnapshotResearchPlan({ tenant: tenant(), brand: brand(), maxDirectCompetitors: 0 }), /integer >= 1/);
});

test('Brand Snapshot rejects competitor evidence outside the explicit research plan', () => {
  const plan = buildSnapshotResearchPlan({ tenant: tenant(), brand: brand(), directCompetitors: ['competitor-1'] });
  assert.throws(() => buildBrandSnapshotV1({
    id: 's1', tenant: tenant(), brand: brand(), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
    researchPlan: plan,
    evidence: [evidence({
      source: {
        system: 'public_web', ref: 'https://example.test', observed_at: '2026-10-08T09:00:00Z',
        kind: SNAPSHOT_SOURCE_KIND.DIRECT_COMPETITOR, subject_ref: 'competitor-2',
      },
    })],
  }), /DIRECT_COMPETITOR_OUTSIDE_RESEARCH_PLAN/);
});

test('Brand Snapshot rejects a research plan built for another tenant', () => {
  const plan = buildSnapshotResearchPlan({ tenant: tenant(M2), brand: brand(M2) });
  assert.throws(() => buildBrandSnapshotV1({
    id: 's1', tenant: tenant(M1), brand: brand(M1), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
    researchPlan: plan,
  }), /SNAPSHOT_RESEARCH_PLAN_MERCHANT_MISMATCH/);
});

test('Brand Snapshot detects structured contradictions instead of resolving them by guess', () => {
  const claim = (id, value, ref) => ({
    id, topic: SNAPSHOT_TOPIC.POSITIONING, subject: 'brand', attribute: 'price_tier', value,
    statement: `claim ${id}`, claim_kind: 'FACT', evidence_refs: [ref],
  });
  const contradictions = detectSnapshotContradictions([claim('c1', 'premium', 'e1'), claim('c2', 'budget', 'e2')]);
  assert.equal(contradictions.length, 1);
  assert.deepEqual(contradictions[0].claim_ids, ['c1', 'c2']);
});

test('Brand Snapshot makes evidence gaps explicit and never fabricates missing answers', () => {
  const plan = buildSnapshotResearchPlan({ tenant: tenant(), brand: brand(), directCompetitors: ['competitor-1'] });
  const result = buildBrandSnapshotV1({
    id: 's1', tenant: tenant(), brand: brand(), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
    researchPlan: plan,
    evidence: [evidence({
      statement: 'Competitor exists', completeness: 'PARTIAL',
      source: {
        system: 'public_web', ref: 'https://example.test', observed_at: '2026-10-08T09:00:00Z',
        kind: SNAPSHOT_SOURCE_KIND.DIRECT_COMPETITOR, subject_ref: 'competitor-1',
      },
    })],
    claims: [{
      id: 'c1', topic: SNAPSHOT_TOPIC.COMPETITOR, subject: 'competitor-1', attribute: 'relevance', value: true,
      statement: 'Competitor 1 is directly relevant', claim_kind: 'FACT', evidence_refs: ['e1'],
    }],
  });

  assert.equal(result.research.coverage.status, 'PARTIAL');
  assert.ok(result.research.coverage.missing_questions.includes(SNAPSHOT_RESEARCH_QUESTION.WHAT_CUSTOMERS_VALUE_OR_REJECT));
  assert.ok(result.snapshot.evidence_gaps.length >= 1);
  assert.equal(result.snapshot.evidence_gaps.every((gap) => gap.claim_kind === 'HYPOTHESIS'), true);
});

test('Brand Snapshot refuses a FACT resting on non-observed evidence', () => {
  const plan = buildSnapshotResearchPlan({ tenant: tenant(), brand: brand() });
  assert.throws(() => buildBrandSnapshotV1({
    id: 's1', tenant: tenant(), brand: brand(), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
    researchPlan: plan,
    evidence: [evidence({ provenance: EVIDENCE_PROVENANCE.INFERRED })],
    claims: [{
      id: 'c1', topic: SNAPSHOT_TOPIC.POSITIONING, subject: 'brand', attribute: 'a', value: 1,
      statement: 's', claim_kind: 'FACT', evidence_refs: ['e1'],
    }],
  }), /FACT_REQUIRES_OBSERVED_EVIDENCE/);
});

test('hypotheses do not satisfy Snapshot research coverage', () => {
  const plan = buildSnapshotResearchPlan({ tenant: tenant(), brand: brand() });
  const result = buildBrandSnapshotV1({
    id: 's1', tenant: tenant(), brand: brand(), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
    researchPlan: plan,
    evidence: [evidence({
      provenance: EVIDENCE_PROVENANCE.INFERRED, statement: 'Unverified customer idea', completeness: 'PARTIAL',
      source: { system: 'manual_note', observed_at: '2026-10-08T09:00:00Z', kind: SNAPSHOT_SOURCE_KIND.MERCHANT_PROVIDED },
    })],
    claims: [{
      id: 'c1', topic: SNAPSHOT_TOPIC.CUSTOMER_EXPECTATION, subject: 'customer', attribute: 'priority', value: 'speed',
      statement: 'Customers may value speed', claim_kind: 'HYPOTHESIS', evidence_refs: ['e1'],
    }],
  });
  assert.equal(
    result.research.coverage.missing_questions.includes(SNAPSHOT_RESEARCH_QUESTION.WHAT_CUSTOMERS_VALUE_OR_REJECT),
    true,
  );
});

test('material refresh events make Snapshot stale without rewriting Brand Core', () => {
  const snapshot = normalizeBrandSnapshot({
    id: 's1', merchant_id: M1, brand_id: B1, version: 1, status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
    evidence: [evidence()],
  });
  const refresh = evaluateSnapshotRefresh({
    snapshot,
    events: [{ type: SNAPSHOT_REFRESH_TRIGGER.OFFER_PORTFOLIO_CHANGED, occurred_at: '2026-10-08T10:00:00Z', source_ref: 'catalog://change-1' }],
  });
  assert.equal(refresh.refresh_required, true);
  assert.equal(refresh.next_snapshot_status, SNAPSHOT_STATUS.STALE);
  assert.equal(refresh.core_update, null);
  assert.match(refresh.policy_note, /NEVER_REWRITES_BRAND_CORE/);
});

// ---------------------------------------------------------------- Core governance

const readySnapshotForCore = (status = SNAPSHOT_STATUS.READY) => normalizeBrandSnapshot({
  id: 'snapshot-core-1', merchant_id: M1, brand_id: B1, version: 1, status,
  created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
  evidence: [evidence({
    id: 'e-core-1', statement: 'Observed capability',
    source: { system: 'internal', observed_at: '2026-10-08T08:00:00Z', kind: SNAPSHOT_SOURCE_KIND.INTERNAL_FACT },
  })],
});

const fullCoreDecisions = () => ({
  category: 'category',
  buying_contexts: ['buying-context'],
  value_proposition: 'Value proposition',
  positioning: 'Positioning',
  core_promise: 'Promise',
  reasons_to_believe: ['Observed capability'],
  personality: ['clear'],
  voice: { traits: ['clear'], do: ['be specific'], dont: ['invent'] },
  exclusions: ['do not mislead'],
  distinctive_assets: [],
  evidence_refs: ['e-core-1'],
});

const proposal = (over = {}) => buildBrandCoreProposal({
  id: 'core-v1', tenant: tenant(), brand: brand(), createdAt: '2026-10-08T10:00:00Z',
  snapshot: readySnapshotForCore(), decisions: fullCoreDecisions(), ...over,
});

test('Brand Core proposal is always review-required and never auto-approved', () => {
  const result = proposal();
  assert.equal(result.core.status, GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED);
  assert.equal(result.core.approval, null);
  assert.equal(result.auto_approved, false);
  assert.equal(result.approval_readiness.ok, true);
  assert.deepEqual(result.review_signals, []);
});

test('a STALE snapshot flags the proposal for review but does not block it; DRAFT does', () => {
  const stale = proposal({ snapshot: readySnapshotForCore(SNAPSHOT_STATUS.STALE) });
  assert.deepEqual(stale.review_signals, ['BRAND_SNAPSHOT_STALE']);
  assert.equal(stale.core.status, GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED);
  assert.deepEqual(
    buildCoreDecisionPacket({ proposal: stale.core, snapshot: readySnapshotForCore(SNAPSHOT_STATUS.STALE) }).review_signals,
    ['BRAND_SNAPSHOT_STALE'],
  );
  assert.throws(
    () => proposal({ snapshot: readySnapshotForCore(SNAPSHOT_STATUS.DRAFT) }),
    /CORE_REQUIRES_READY_SNAPSHOT/,
  );
});

test('Brand Core cannot cite evidence absent from its Snapshot', () => {
  assert.throws(
    () => proposal({ decisions: { ...fullCoreDecisions(), evidence_refs: ['missing'] } }),
    /CORE_REFERENCES_UNKNOWN_EVIDENCE/,
  );
});

test('Brand Core proposal requires a resolved tenant matching the snapshot', () => {
  assert.throws(() => proposal({ tenant: tenant(M2), brand: brand(M2) }), /CORE_SNAPSHOT_MERCHANT_MISMATCH/);
  assert.throws(() => proposal({ tenant: { merchantId: M1 } }), /canonical tenant source/);
});

const approve = (over = {}) => approveBrandCore({
  proposal: proposal().core,
  snapshot: readySnapshotForCore(),
  tenant: tenant(), brand: brand(),
  resolvedActor: resolvedActor(),
  approvedAt: '2026-10-08T10:30:00Z',
  note: 'Approved after review',
  ...over,
});

test('Brand Core approval records a resolved identity and emits a ledger-compatible decision event', () => {
  const result = approve();
  // uniform approval contract: approvedX / supersededX / decisionEvent (+ reviewSignals for Core)
  assert.deepEqual(Object.keys(result).sort(), ['approvedCore', 'decisionEvent', 'reviewSignals', 'supersededCore']);
  assert.deepEqual(result.reviewSignals, []);
  const { approvedCore: core, supersededCore: superseded, decisionEvent: event } = result;
  assert.equal(core.status, GOVERNED_DOCUMENT_STATUS.APPROVED);
  assert.equal(superseded, null);
  assert.equal(core.approval.approved_by, 'user-owner-1');
  assert.equal(core.approval.approver_role, 'OWNER');
  assert.equal(core.approval.decision_event_id, event.id);
  assert.match(event.id, /^bde_[0-9a-f]{32}$/);
  assert.equal(event.type, 'BRAND_CORE_APPROVED');
  assert.deepEqual(event.subject, { kind: 'brand_core', id: 'core-v1', version: 1 });
  assert.equal(event.merchant_id, M1);
  assert.equal(event.supersedes, null);
  // deterministic: replaying the same decision gives the same event id
  assert.equal(approve().decisionEvent.id, event.id);
});

test('approval is refused without a present, same-tenant, authorized resolved actor', () => {
  assert.throws(() => approve({ resolvedActor: null }), /RESOLVED_ACTOR_MISSING/);
  assert.throws(() => approve({ resolvedActor: 'owner-1' }), /resolved_actor must be an object/);
  assert.throws(() => approve({ resolvedActor: resolvedActor(M2) }), /RESOLVED_ACTOR_TENANT_MISMATCH/);
  assert.throws(() => approve({ resolvedActor: resolvedActor(M1, { role: 'INTERN' }) }), /unsupported/);
  assert.throws(() => approve({ resolvedActor: resolvedActor(M1, { user_id: ' ' }) }), /user_id/);
  assert.throws(() => approve({ tenant: tenant(M2), brand: brand(M2), resolvedActor: resolvedActor(M2) }), /CORE_TENANT_MISMATCH/);
});

test('an authenticated flag is not a substitute for a resolved actor', () => {
  // the domain ignores any such flag: only presence, tenant and role are checked
  const { merchant_id: _omitted, ...noTenant } = resolvedActor();
  assert.throws(() => approve({ resolvedActor: { ...noTenant, authenticated: true } }), /merchant_id/);
});

test('approval is refused while the reference Snapshot is not READY, even though preparation is allowed', () => {
  const staleSnapshot = readySnapshotForCore(SNAPSHOT_STATUS.STALE);
  const prepared = proposal({ snapshot: staleSnapshot });
  assert.equal(prepared.core.status, GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED);
  assert.throws(
    () => approve({ proposal: prepared.core, snapshot: staleSnapshot }),
    /CORE_APPROVAL_REQUIRES_READY_SNAPSHOT/,
  );
  // once the Snapshot is READY again, the same proposal can be approved
  assert.equal(
    approve({ proposal: prepared.core, snapshot: readySnapshotForCore() }).approvedCore.status,
    GOVERNED_DOCUMENT_STATUS.APPROVED,
  );
});

test('an already APPROVED Core stays usable when its Snapshot becomes STALE', () => {
  const core = approve().approvedCore;
  const stale = readySnapshotForCore(SNAPSHOT_STATUS.STALE);
  const memory = memoryWith([wordingRule], { core_ref: { id: core.id, version: core.version } });
  const context = buildBrandContext({ tenant: tenant(), brand: brand(), core, memory, snapshot: stale });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);
  assert.deepEqual(context.review_signals, ['BRAND_SNAPSHOT_STALE']);
});

test('approval is refused for a proposal that is not review-required or not ready', () => {
  assert.throws(() => approve({ proposal: coreApproved() }), /CORE_MUST_BE_REVIEW_REQUIRED_BEFORE_APPROVAL/);
  const weak = proposal({ decisions: { ...fullCoreDecisions(), exclusions: [] } }).core;
  assert.throws(() => approve({ proposal: weak }), /CORE_NOT_READY_FOR_APPROVAL/);
});

test('approving V2 supersedes V1 and emits a superseding decision event', () => {
  const v1 = approve().approvedCore;
  const v2Proposal = proposeBrandCoreRevision({
    approvedCore: v1, snapshot: readySnapshotForCore(), tenant: tenant(), brand: brand(), id: 'core-v2',
    createdAt: '2026-10-08T11:00:00Z', changes: { positioning: 'Updated positioning' },
  }).core;

  assert.equal(v1.positioning, 'Positioning');
  assert.equal(v2Proposal.version, 2);
  assert.equal(v2Proposal.status, GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED);
  assert.equal(v2Proposal.supersedes_id, 'core-v1');

  const result = approve({ proposal: v2Proposal, activeCore: v1, approvedAt: '2026-10-08T12:00:00Z' });
  assert.equal(result.approvedCore.status, GOVERNED_DOCUMENT_STATUS.APPROVED);
  assert.equal(result.supersededCore.id, 'core-v1');
  assert.equal(result.supersededCore.status, GOVERNED_DOCUMENT_STATUS.SUPERSEDED);
  assert.deepEqual(result.decisionEvent.supersedes, { kind: 'brand_core', id: 'core-v1', version: 1 });
  assert.equal(v1.status, GOVERNED_DOCUMENT_STATUS.APPROVED, 'the input object is never mutated');
});

test('two APPROVED Cores can never coexist for one tenant', () => {
  const v1 = approve().approvedCore;
  // a fresh v1-style proposal that does not supersede the active core
  assert.throws(
    () => approve({ proposal: proposal({ id: 'core-other' }).core, activeCore: v1 }),
    /CORE_ACTIVE_CORE_MUST_BE_SUPERSEDED/,
  );
  // a superseding proposal with no active core to supersede
  const orphan = proposal({ id: 'core-v2', version: 2, supersedesId: 'core-v1' }).core;
  assert.throws(() => approve({ proposal: orphan }), /CORE_SUPERSEDES_UNKNOWN_ACTIVE_CORE/);
  // a non-approved "active" core
  assert.throws(
    () => approve({ proposal: orphan, activeCore: proposal().core }),
    /CORE_ACTIVE_CORE_NOT_APPROVED/,
  );
  // store guard
  assert.equal(selectActiveBrandCore([v1], tenant(), brand()).id, 'core-v1');
  assert.equal(selectActiveBrandCore([v1], tenant(M2), brand(M2)), null);
  assert.throws(
    () => selectActiveBrandCore([v1, { ...v1, id: 'core-x' }], tenant(), brand()),
    /MULTIPLE_APPROVED_BRAND_CORES/,
  );
});

test('Brand Core decision packet exposes evidence and requires human approval', () => {
  const snapshot = readySnapshotForCore();
  const packet = buildCoreDecisionPacket({ proposal: proposal().core, snapshot });
  assert.equal(packet.approval_required, true);
  assert.equal(packet.auto_apply, false);
  assert.equal(packet.evidence.length, 1);
  assert.equal('budget' in packet.decisions, false);
});
