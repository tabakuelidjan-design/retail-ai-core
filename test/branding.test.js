import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAND_CONTEXT_STATUS,
  BRAND_RULE_TYPE,
  EVIDENCE_KIND,
  GOVERNED_DOCUMENT_STATUS,
  GUARDIAN_METHOD,
  GUARDIAN_OUTCOME,
  RULE_ENFORCEMENT,
  RULE_OPERATOR,
  RULE_SEVERITY,
  SNAPSHOT_REFRESH_TRIGGER,
  SNAPSHOT_RESEARCH_QUESTION,
  SNAPSHOT_SOURCE_KIND,
  SNAPSHOT_STATUS,
  SNAPSHOT_TOPIC,
  aggregateGuardianOutcome,
  assertBrandStatusTransition,
  approveBrandCore,
  buildBrandContext,
  buildBrandCoreProposal,
  buildBrandSnapshotV1,
  buildGuardianPlan,
  buildSnapshotResearchPlan,
  buildGuardianReport,
  buildCoreDecisionPacket,
  creativeBrandInterface,
  detectSnapshotContradictions,
  evaluateSnapshotRefresh,
  marketingBrandInterface,
  normalizeBrandCore,
  normalizeBrandMemory,
  normalizeBrandSnapshot,
  proposeBrandCoreRevision,
  validateCoreForApproval,
  validateMemoryForApproval,
  validateSnapshotReadiness,
} from '../src/branding/index.js';

const coreApproved = () => normalizeBrandCore({
  id: 'core-1',
  merchant_id: 'merchant-1',
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
  approval: {
    approved_by: 'owner-1',
    approved_at: '2026-10-08T11:00:00Z',
  },
});

const memoryApproved = () => normalizeBrandMemory({
  id: 'memory-1',
  merchant_id: 'merchant-1',
  version: 1,
  status: GOVERNED_DOCUMENT_STATUS.APPROVED,
  created_at: '2026-10-08T10:30:00Z',
  core_ref: { id: 'core-1', version: 1 },
  hard_rules: [{
    id: 'r1',
    rule_type: BRAND_RULE_TYPE.WORDING,
    subject: 'forbidden phrase',
    enforcement: RULE_ENFORCEMENT.DETERMINISTIC,
    severity: RULE_SEVERITY.BLOCK,
    constraint: { operator: RULE_OPERATOR.NOT_CONTAINS, value: 'forbidden' },
  }],
  design_tokens: { 'color.primary': { '$type': 'color', '$value': '#112233' } },
  semantic_context: { tone: ['clear'] },
  asset_refs: ['asset://logo-primary'],
  production_asset_refs: ['production://template-1'],
  approval: {
    approved_by: 'owner-1',
    approved_at: '2026-10-08T11:05:00Z',
  },
});

test('snapshot distinguishes facts, inferences and hypotheses and keeps provenance', () => {
  const snapshot = normalizeBrandSnapshot({
    id: 'snapshot-1',
    merchant_id: 'merchant-1',
    version: 1,
    status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-08T09:00:00Z',
    observed_at: '2026-10-08T09:00:00Z',
    evidence: [{
      id: 'e1',
      evidence_kind: EVIDENCE_KIND.FACT,
      statement: 'Observed statement',
      source: { system: 'merchant_site', ref: 'https://example.test', observed_at: '2026-10-08T08:00:00Z' },
      completeness: 'COMPLETE',
    }],
    positioning: [{ id: 'f1', statement: 'Observed position', evidence_kind: EVIDENCE_KIND.FACT, evidence_refs: ['e1'] }],
    refresh_triggers: [{ type: SNAPSHOT_REFRESH_TRIGGER.OFFER_PORTFOLIO_CHANGED, occurred_at: '2026-10-08T08:30:00Z' }],
  });
  assert.equal(validateSnapshotReadiness(snapshot).ok, true);
});

test('snapshot READY without evidence is rejected by readiness validation', () => {
  const snapshot = normalizeBrandSnapshot({
    id: 'snapshot-1', merchant_id: 'm1', version: 1, status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
  });
  assert.ok(validateSnapshotReadiness(snapshot).reasons.includes('SNAPSHOT_READY_WITHOUT_EVIDENCE'));
});

test('approved core requires operationally useful fields and approval record', () => {
  const core = coreApproved();
  assert.equal(validateCoreForApproval(core).ok, true);

  const weak = normalizeBrandCore({
    id: 'c', merchant_id: 'm1', version: 1, status: GOVERNED_DOCUMENT_STATUS.APPROVED,
    created_at: '2026-10-08T09:00:00Z',
  });
  const result = validateCoreForApproval(weak);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('CONCRETE_EXCLUSION_REQUIRED'));
  assert.ok(result.reasons.includes('APPROVAL_RECORD_REQUIRED'));
});

test('priority distinctive assets are intentionally bounded', () => {
  assert.throws(() => normalizeBrandCore({
    ...coreApproved(),
    distinctive_assets: [1, 2, 3, 4].map((i) => ({
      id: `a${i}`, type: 'OTHER', description: `asset ${i}`,
    })),
  }), /at most 3/);
});

test('approved memory must bind to the approved core of the same merchant/version', () => {
  const core = coreApproved();
  const memory = memoryApproved();
  assert.equal(validateMemoryForApproval(memory, { core }).ok, true);

  const wrongCore = normalizeBrandCore({ ...core, merchant_id: 'merchant-2' });
  assert.ok(
    validateMemoryForApproval(memory, { core: wrongCore }).reasons
      .includes('CORE_MEMORY_MERCHANT_MISMATCH'),
  );
});

test('empty Brand Memory is never considered ready', () => {
  const core = coreApproved();
  const empty = normalizeBrandMemory({
    id: 'mem', merchant_id: 'merchant-1', version: 1,
    status: GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED,
    created_at: '2026-10-08T10:00:00Z',
    core_ref: { id: core.id, version: core.version },
  });
  assert.ok(validateMemoryForApproval(empty, { core }).reasons.includes('BRAND_MEMORY_EMPTY'));
});

test('brand context gates Marketing and Creative when Core or Memory are not approved', () => {
  const gated = buildBrandContext({ core: coreApproved(), memory: null });
  assert.equal(gated.status, BRAND_CONTEXT_STATUS.GATED);
  assert.equal(gated.memory, null);
  assert.ok(gated.reasons.includes('BRAND_MEMORY_MISSING'));
});

test('ready brand context exposes narrow Marketing and Creative interfaces', () => {
  const context = buildBrandContext({ core: coreApproved(), memory: memoryApproved() });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);

  const marketing = marketingBrandInterface(context);
  const creative = creativeBrandInterface(context);
  assert.equal(marketing.core_promise, 'Core promise');
  assert.deepEqual(creative.production_asset_refs, ['production://template-1']);
  assert.equal('budget' in marketing, false);
  assert.equal('publish' in creative, false);
});

test('Brand Guardian runs deterministic work before qualitative work', () => {
  const memory = normalizeBrandMemory({
    ...memoryApproved(),
    hard_rules: [
      {
        id: 'det', rule_type: 'COLOR', subject: 'primary',
        enforcement: 'DETERMINISTIC', severity: 'BLOCK',
        constraint: { operator: 'EQUALS', value: '#112233' },
      },
      {
        id: 'qual', rule_type: 'TONE', subject: 'voice',
        enforcement: 'QUALITATIVE', severity: 'REVIEW',
        constraint: { operator: 'CUSTOM', value: 'clear and calm' },
      },
      {
        id: 'hybrid', rule_type: 'PRODUCT_FIDELITY', subject: 'product',
        enforcement: 'HYBRID', severity: 'BLOCK',
        constraint: { operator: 'REFERENCE', value: 'asset://source' },
      },
    ],
  });
  const plan = buildGuardianPlan(memory);
  assert.deepEqual(plan.deterministic_first.map((x) => x.rule_id), ['det', 'hybrid']);
  assert.deepEqual(plan.qualitative_second.map((x) => x.rule_id), ['qual', 'hybrid']);
});

test('Guardian outcome precedence is FAIL > REVIEW_REQUIRED > NOT_MEASURABLE > PASS', () => {
  assert.equal(aggregateGuardianOutcome([]), GUARDIAN_OUTCOME.NOT_MEASURABLE);
  assert.equal(aggregateGuardianOutcome([{ outcome: 'PASS' }]), GUARDIAN_OUTCOME.PASS);
  assert.equal(aggregateGuardianOutcome([{ outcome: 'PASS' }, { outcome: 'NOT_MEASURABLE' }]), GUARDIAN_OUTCOME.NOT_MEASURABLE);
  assert.equal(aggregateGuardianOutcome([{ outcome: 'REVIEW_REQUIRED' }, { outcome: 'NOT_MEASURABLE' }]), GUARDIAN_OUTCOME.REVIEW_REQUIRED);
  assert.equal(aggregateGuardianOutcome([{ outcome: 'FAIL' }, { outcome: 'REVIEW_REQUIRED' }]), GUARDIAN_OUTCOME.FAIL);
});

test('Guardian report explicitly does not make the execution decision', () => {
  const report = buildGuardianReport({
    id: 'g1',
    merchant_id: 'merchant-1',
    memory_ref: { id: 'memory-1', version: 1 },
    target_ref: 'creative://asset-1',
    created_at: '2026-10-08T12:00:00Z',
    checks: [{
      id: 'c1',
      rule_id: 'r1',
      outcome: GUARDIAN_OUTCOME.FAIL,
      method: GUARDIAN_METHOD.DETERMINISTIC,
      evidence_refs: ['ocr://1'],
    }],
  });
  assert.equal(report.outcome, GUARDIAN_OUTCOME.FAIL);
  assert.equal(report.execution_decision, null);
  assert.equal(report.policy_note, 'GUARDIAN_REPORT_IS_NOT_AN_EXECUTION_POLICY_DECISION');
});

test('approved governed documents cannot silently return to draft', () => {
  assert.equal(assertBrandStatusTransition('CORE', 'DRAFT', 'REVIEW_REQUIRED'), true);
  assert.equal(assertBrandStatusTransition('CORE', 'REVIEW_REQUIRED', 'APPROVED'), true);
  assert.throws(() => assertBrandStatusTransition('CORE', 'APPROVED', 'DRAFT'), /invalid CORE status transition/);
  assert.equal(assertBrandStatusTransition('SNAPSHOT', 'READY', 'STALE'), true);
});

test('generic branding source contains no merchant-specific architecture', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  for (const file of (await readdir('src/branding')).filter((name) => name.endsWith('.js'))) {
    const source = await readFile(`src/branding/${file}`, 'utf8');
    assert.equal(/habb|namur|tyeso/i.test(source), false, file);
  }
});


test('Brand Snapshot research scope is deliberately bounded to three direct competitors', () => {
  assert.throws(() => buildSnapshotResearchPlan({
    merchantId: 'm1',
    directCompetitors: ['c1', 'c2', 'c3', 'c4'],
  }), /at most 3/);

  const plan = buildSnapshotResearchPlan({
    merchantId: 'm1',
    directCompetitors: ['c1', 'c2', 'c3'],
  });
  assert.equal(plan.max_direct_competitors, 3);
  assert.equal(plan.continuous_crawling, false);
  assert.equal(plan.questions.length, 4);
});

test('Brand Snapshot rejects competitor evidence outside the explicit research plan', () => {
  const plan = buildSnapshotResearchPlan({
    merchantId: 'm1',
    directCompetitors: ['competitor-1'],
  });

  assert.throws(() => buildBrandSnapshotV1({
    id: 's1',
    merchantId: 'm1',
    createdAt: '2026-10-08T10:00:00Z',
    observedAt: '2026-10-08T10:00:00Z',
    researchPlan: plan,
    evidence: [{
      id: 'e1',
      evidence_kind: 'FACT',
      statement: 'Observed competitor message',
      source: {
        system: 'public_web',
        ref: 'https://example.test',
        observed_at: '2026-10-08T09:00:00Z',
        kind: SNAPSHOT_SOURCE_KIND.DIRECT_COMPETITOR,
        subject_ref: 'competitor-2',
      },
      completeness: 'COMPLETE',
    }],
  }), /DIRECT_COMPETITOR_OUTSIDE_RESEARCH_PLAN/);
});

test('Brand Snapshot detects structured contradictions instead of resolving them by guess', () => {
  const contradictions = detectSnapshotContradictions([
    {
      id: 'c1',
      topic: SNAPSHOT_TOPIC.POSITIONING,
      subject: 'brand',
      attribute: 'price_tier',
      value: 'premium',
      statement: 'Owned site says premium',
      evidence_kind: 'FACT',
      evidence_refs: ['e1'],
    },
    {
      id: 'c2',
      topic: SNAPSHOT_TOPIC.POSITIONING,
      subject: 'brand',
      attribute: 'price_tier',
      value: 'budget',
      statement: 'Current assortment is budget-led',
      evidence_kind: 'FACT',
      evidence_refs: ['e2'],
    },
  ]);
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].kind, 'FACT_FACT');
});

test('Brand Snapshot makes evidence gaps explicit and never fabricates missing answers', () => {
  const plan = buildSnapshotResearchPlan({
    merchantId: 'm1',
    directCompetitors: ['competitor-1'],
  });

  const result = buildBrandSnapshotV1({
    id: 's1',
    merchantId: 'm1',
    createdAt: '2026-10-08T10:00:00Z',
    observedAt: '2026-10-08T10:00:00Z',
    researchPlan: plan,
    evidence: [{
      id: 'e1',
      evidence_kind: 'FACT',
      statement: 'Competitor exists',
      source: {
        system: 'public_web',
        ref: 'https://example.test',
        observed_at: '2026-10-08T09:00:00Z',
        kind: SNAPSHOT_SOURCE_KIND.DIRECT_COMPETITOR,
        subject_ref: 'competitor-1',
      },
      completeness: 'PARTIAL',
    }],
    claims: [{
      id: 'c1',
      topic: SNAPSHOT_TOPIC.COMPETITOR,
      subject: 'competitor-1',
      attribute: 'relevance',
      value: true,
      statement: 'Competitor 1 is directly relevant',
      evidence_kind: 'FACT',
      evidence_refs: ['e1'],
    }],
  });

  assert.equal(result.research.coverage.status, 'PARTIAL');
  assert.ok(
    result.research.coverage.missing_questions
      .includes(SNAPSHOT_RESEARCH_QUESTION.WHAT_CUSTOMERS_VALUE_OR_REJECT),
  );
  assert.ok(result.snapshot.evidence_gaps.length >= 1);
  assert.equal(
    result.snapshot.evidence_gaps.every((gap) => gap.evidence_kind === 'HYPOTHESIS'),
    true,
  );
});

test('hypotheses do not satisfy Snapshot research coverage', () => {
  const plan = buildSnapshotResearchPlan({ merchantId: 'm1' });
  const result = buildBrandSnapshotV1({
    id: 's1',
    merchantId: 'm1',
    createdAt: '2026-10-08T10:00:00Z',
    observedAt: '2026-10-08T10:00:00Z',
    researchPlan: plan,
    evidence: [{
      id: 'e1',
      evidence_kind: 'HYPOTHESIS',
      statement: 'Unverified customer idea',
      source: {
        system: 'manual_note',
        observed_at: '2026-10-08T09:00:00Z',
        kind: SNAPSHOT_SOURCE_KIND.MERCHANT_PROVIDED,
      },
      completeness: 'PARTIAL',
    }],
    claims: [{
      id: 'c1',
      topic: SNAPSHOT_TOPIC.CUSTOMER_EXPECTATION,
      subject: 'customer',
      attribute: 'priority',
      value: 'speed',
      statement: 'Customers may value speed',
      evidence_kind: 'HYPOTHESIS',
      evidence_refs: ['e1'],
    }],
  });

  assert.equal(
    result.research.coverage.missing_questions
      .includes(SNAPSHOT_RESEARCH_QUESTION.WHAT_CUSTOMERS_VALUE_OR_REJECT),
    true,
  );
});

test('material refresh events make Snapshot stale without rewriting Brand Core', () => {
  const snapshot = normalizeBrandSnapshot({
    id: 's1',
    merchant_id: 'm1',
    version: 1,
    status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-08T09:00:00Z',
    observed_at: '2026-10-08T09:00:00Z',
    evidence: [{
      id: 'e1',
      evidence_kind: 'FACT',
      statement: 'Observed',
      source: {
        system: 'owned',
        observed_at: '2026-10-08T08:00:00Z',
        kind: SNAPSHOT_SOURCE_KIND.OWNED_SURFACE,
      },
      completeness: 'COMPLETE',
    }],
  });

  const refresh = evaluateSnapshotRefresh({
    snapshot,
    events: [{
      type: SNAPSHOT_REFRESH_TRIGGER.OFFER_PORTFOLIO_CHANGED,
      occurred_at: '2026-10-08T10:00:00Z',
      source_ref: 'catalog://change-1',
    }],
  });

  assert.equal(refresh.refresh_required, true);
  assert.equal(refresh.next_snapshot_status, SNAPSHOT_STATUS.STALE);
  assert.equal(refresh.core_update, null);
  assert.match(refresh.policy_note, /NEVER_REWRITES_BRAND_CORE/);
});


function readySnapshotForCore() {
  return normalizeBrandSnapshot({
    id: 'snapshot-core-1',
    merchant_id: 'merchant-1',
    version: 1,
    status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-08T09:00:00Z',
    observed_at: '2026-10-08T09:00:00Z',
    evidence: [{
      id: 'e-core-1',
      evidence_kind: 'FACT',
      statement: 'Observed capability',
      source: {
        system: 'internal',
        observed_at: '2026-10-08T08:00:00Z',
        kind: SNAPSHOT_SOURCE_KIND.INTERNAL_FACT,
      },
      completeness: 'COMPLETE',
    }],
  });
}

function fullCoreDecisions() {
  return {
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
  };
}

test('Brand Core proposal is always review-required and never auto-approved', () => {
  const snapshot = readySnapshotForCore();
  const result = buildBrandCoreProposal({
    id: 'core-proposal-1',
    merchantId: 'merchant-1',
    createdAt: '2026-10-08T10:00:00Z',
    snapshot,
    decisions: fullCoreDecisions(),
  });
  assert.equal(result.core.status, GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED);
  assert.equal(result.core.approval, null);
  assert.equal(result.auto_approved, false);
  assert.equal(result.approval_readiness.ok, true);
});

test('Brand Core proposal cannot use a stale Snapshot', () => {
  const snapshot = normalizeBrandSnapshot({
    ...readySnapshotForCore(),
    status: SNAPSHOT_STATUS.STALE,
  });
  assert.throws(() => buildBrandCoreProposal({
    id: 'core-proposal-1',
    merchantId: 'merchant-1',
    createdAt: '2026-10-08T10:00:00Z',
    snapshot,
    decisions: fullCoreDecisions(),
  }), /CORE_REQUIRES_READY_SNAPSHOT/);
});

test('Brand Core cannot cite evidence absent from its Snapshot', () => {
  const snapshot = readySnapshotForCore();
  assert.throws(() => buildBrandCoreProposal({
    id: 'core-proposal-1',
    merchantId: 'merchant-1',
    createdAt: '2026-10-08T10:00:00Z',
    snapshot,
    decisions: { ...fullCoreDecisions(), evidence_refs: ['missing'] },
  }), /CORE_REFERENCES_UNKNOWN_EVIDENCE/);
});

test('Brand Core approval is explicit and records the human authority', () => {
  const snapshot = readySnapshotForCore();
  const proposal = buildBrandCoreProposal({
    id: 'core-proposal-1',
    merchantId: 'merchant-1',
    createdAt: '2026-10-08T10:00:00Z',
    snapshot,
    decisions: fullCoreDecisions(),
  }).core;

  const approved = approveBrandCore({
    proposal,
    snapshot,
    approvedBy: 'owner-1',
    approvedAt: '2026-10-08T10:30:00Z',
    note: 'Approved after review',
  });

  assert.equal(approved.status, GOVERNED_DOCUMENT_STATUS.APPROVED);
  assert.equal(approved.approval.approved_by, 'owner-1');
  assert.deepEqual(approved.snapshot_ref, { id: snapshot.id, version: snapshot.version });
});

test('Brand Core revision creates a new review version and never mutates the approved version', () => {
  const snapshot = readySnapshotForCore();
  const proposal = buildBrandCoreProposal({
    id: 'core-v1',
    merchantId: 'merchant-1',
    createdAt: '2026-10-08T10:00:00Z',
    snapshot,
    decisions: fullCoreDecisions(),
  }).core;
  const approved = approveBrandCore({
    proposal,
    snapshot,
    approvedBy: 'owner-1',
    approvedAt: '2026-10-08T10:30:00Z',
  });

  const revision = proposeBrandCoreRevision({
    approvedCore: approved,
    snapshot,
    id: 'core-v2',
    createdAt: '2026-10-08T11:00:00Z',
    changes: { positioning: 'Updated positioning' },
  }).core;

  assert.equal(approved.positioning, 'Positioning');
  assert.equal(approved.version, 1);
  assert.equal(revision.positioning, 'Updated positioning');
  assert.equal(revision.version, 2);
  assert.equal(revision.status, GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED);
  assert.equal(revision.supersedes_id, 'core-v1');
});

test('Brand Core decision packet exposes evidence and requires human approval', () => {
  const snapshot = readySnapshotForCore();
  const proposal = buildBrandCoreProposal({
    id: 'core-proposal-1',
    merchantId: 'merchant-1',
    createdAt: '2026-10-08T10:00:00Z',
    snapshot,
    decisions: fullCoreDecisions(),
  }).core;

  const packet = buildCoreDecisionPacket({ proposal, snapshot });
  assert.equal(packet.approval_required, true);
  assert.equal(packet.auto_apply, false);
  assert.equal(packet.evidence.length, 1);
  assert.equal('budget' in packet.decisions, false);
});
