import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAND_CONTEXT_STATUS,
  BRAND_RULE_TYPE,
  CLAIM_KIND,
  DEFAULT_MAX_DIRECT_COMPETITORS,
  EVIDENCE_PROVENANCE,
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
  approveBrandCore,
  buildBrandContext,
  buildBrandCoreProposal,
  buildBrandSnapshotV1,
  buildCoreDecisionPacket,
  buildGuardianPlan,
  buildGuardianReport,
  buildSnapshotResearchPlan,
  creativeBrandInterface,
  detectSnapshotContradictions,
  evaluateSnapshotRefresh,
  guardianCheckFromFidelityGate,
  marketingBrandInterface,
  normalizeBrandCore,
  normalizeBrandMemory,
  normalizeBrandSnapshot,
  proposeBrandCoreRevision,
  selectActiveBrandCore,
  validateCoreForApproval,
  validateMemoryForApproval,
  validateSnapshotReadiness,
} from '../src/branding/index.js';
import { evaluateHardFidelityGate } from '../src/creative-fidelity/fidelity-gates.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const tenant = (merchantId = M1) => ({ merchantId, source: 'env' });
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
  merchant_id: M1,
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
  merchant_id: M1,
  version: 1,
  status: GOVERNED_DOCUMENT_STATUS.APPROVED,
  created_at: '2026-10-08T10:30:00Z',
  core_ref: { id: 'core-1', version: 1 },
  hard_rules: hardRules,
  design_tokens: { 'color.primary': { $type: 'color', $value: '#112233' } },
  semantic_context: { tone: ['clear'] },
  asset_refs: ['asset://logo-primary'],
  production_asset_refs: ['production://template-1'],
  approval: { ...approvalRecord, approved_at: '2026-10-08T11:05:00Z' },
  ...over,
});

const wordingRule = {
  id: 'r1',
  rule_type: BRAND_RULE_TYPE.WORDING,
  subject: 'forbidden phrase',
  enforcement: RULE_ENFORCEMENT.DETERMINISTIC,
  severity: RULE_SEVERITY.BLOCK,
  constraint: { operator: RULE_OPERATOR.NOT_CONTAINS, value: 'forbidden' },
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
    merchant_id: M1,
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
      id: 's', merchant_id: M1, version: 1, status: SNAPSHOT_STATUS.READY,
      created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
      evidence: [evidence({ provenance })],
      positioning: [{ id: 'f1', statement: 'x', claim_kind: CLAIM_KIND.FACT, evidence_refs: ['e1'] }],
    });
    assert.ok(validateSnapshotReadiness(snapshot).reasons.includes('FACT_REQUIRES_OBSERVED_EVIDENCE'));
  }
});

test('an INFERENCE may rest on inferred evidence', () => {
  const snapshot = normalizeBrandSnapshot({
    id: 's', merchant_id: M1, version: 1, status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
    evidence: [evidence({ provenance: EVIDENCE_PROVENANCE.INFERRED })],
    positioning: [{ id: 'f1', statement: 'x', claim_kind: CLAIM_KIND.INFERENCE, evidence_refs: ['e1'] }],
  });
  assert.equal(validateSnapshotReadiness(snapshot).ok, true);
});

test('snapshot READY without evidence is rejected by readiness validation', () => {
  const snapshot = normalizeBrandSnapshot({
    id: 'snapshot-1', merchant_id: M1, version: 1, status: SNAPSHOT_STATUS.READY,
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
    id: 'c', merchant_id: M1, version: 1, status: GOVERNED_DOCUMENT_STATUS.APPROVED,
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
  assert.equal(validateMemoryForApproval(memoryApproved(), { core }).ok, true);
  const wrongCore = coreApproved({ merchant_id: M2 });
  assert.ok(
    validateMemoryForApproval(memoryApproved(), { core: wrongCore }).reasons
      .includes('CORE_MEMORY_MERCHANT_MISMATCH'),
  );
});

test('empty Brand Memory is never considered ready', () => {
  const empty = normalizeBrandMemory({
    id: 'mem', merchant_id: M1, version: 1,
    status: GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED,
    created_at: '2026-10-08T10:00:00Z',
    core_ref: { id: 'core-1', version: 1 },
  });
  assert.ok(validateMemoryForApproval(empty, { core: coreApproved() }).reasons.includes('BRAND_MEMORY_EMPTY'));
});

// ---------------------------------------------------------------- Context / interfaces

test('brand context gates Marketing and Creative when Core or Memory are missing', () => {
  const gated = buildBrandContext({ tenant: tenant(), core: coreApproved(), memory: null });
  assert.equal(gated.status, BRAND_CONTEXT_STATUS.GATED);
  assert.equal(gated.memory, null);
  assert.ok(gated.reasons.includes('BRAND_MEMORY_MISSING'));
  assert.throws(() => marketingBrandInterface(gated), /gated/);
});

test('brand context is gated for another tenant', () => {
  const context = buildBrandContext({ tenant: tenant(M2), core: coreApproved(), memory: memoryApproved() });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(context.reasons.includes('BRAND_CORE_TENANT_MISMATCH'));
  assert.ok(context.reasons.includes('BRAND_MEMORY_TENANT_MISMATCH'));
});

test('ready brand context exposes narrow Marketing and Creative interfaces', () => {
  const context = buildBrandContext({ tenant: tenant(), core: coreApproved(), memory: memoryApproved() });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);
  assert.deepEqual(context.review_signals, []);

  const marketing = marketingBrandInterface(context);
  const creative = creativeBrandInterface(context);
  assert.equal(marketing.core_promise, 'Core promise');
  assert.deepEqual(creative.production_asset_refs, ['production://template-1']);
  assert.equal('budget' in marketing, false);
  assert.equal('publish' in creative, false);
});

test('a STALE snapshot is a review signal, never an automatic block', () => {
  const stale = normalizeBrandSnapshot({
    id: 'snapshot-core-1', merchant_id: M1, version: 1, status: SNAPSHOT_STATUS.STALE,
    created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
  });
  const context = buildBrandContext({
    tenant: tenant(), core: coreApproved(), memory: memoryApproved(), snapshot: stale,
  });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);
  assert.deepEqual(context.review_signals, ['BRAND_SNAPSHOT_STALE']);
  assert.deepEqual(marketingBrandInterface(context).review_signals, ['BRAND_SNAPSHOT_STALE']);
  assert.deepEqual(creativeBrandInterface(context).review_signals, ['BRAND_SNAPSHOT_STALE']);
});

test('a newer snapshot than the one behind the Core raises an outdated-reference signal', () => {
  const newer = normalizeBrandSnapshot({
    id: 'snapshot-core-2', merchant_id: M1, version: 1, status: SNAPSHOT_STATUS.READY,
    created_at: '2026-10-09T09:00:00Z', observed_at: '2026-10-09T09:00:00Z',
  });
  const context = buildBrandContext({
    tenant: tenant(), core: coreApproved(), memory: memoryApproved(), snapshot: newer,
  });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);
  assert.deepEqual(context.review_signals, ['BRAND_SNAPSHOT_REFERENCE_OUTDATED']);
});

// ---------------------------------------------------------------- Guardian

test('Brand Guardian plans deterministic work first and delegates product fidelity', () => {
  const memory = memoryWith([
    { id: 'det', rule_type: 'COLOR', subject: 'primary', enforcement: 'DETERMINISTIC', severity: 'BLOCK', constraint: { operator: 'EQUALS', value: '#112233' } },
    { id: 'qual', rule_type: 'TONE', subject: 'voice', enforcement: 'QUALITATIVE', severity: 'REVIEW', constraint: { operator: 'REFERENCE', value: 'semantic_context.tone' } },
    { id: 'hybrid', rule_type: 'WORDING', subject: 'claims', enforcement: 'HYBRID', severity: 'BLOCK', constraint: { operator: 'NOT_CONTAINS', value: 'x' } },
    { id: 'fid', rule_type: 'PRODUCT_FIDELITY', subject: 'product', enforcement: 'HYBRID', severity: 'BLOCK', constraint: { operator: 'REFERENCE', value: 'asset://source' } },
  ]);
  const plan = buildGuardianPlan(memory);
  assert.deepEqual(plan.deterministic_first.map((x) => x.rule_id), ['det', 'hybrid', 'fid']);
  assert.deepEqual(plan.qualitative_second.map((x) => x.rule_id), ['qual', 'hybrid']);
  assert.equal(plan.deterministic_first.find((x) => x.rule_id === 'fid').delegate_to, 'creative-fidelity');
});

test('removed rule vocabulary (CUSTOM operator, VISUAL and LAYOUT rules) is rejected', () => {
  const base = { id: 'x', subject: 's', enforcement: 'QUALITATIVE', severity: 'REVIEW' };
  assert.throws(() => memoryWith([{ ...base, rule_type: 'TONE', constraint: { operator: 'CUSTOM', value: 'v' } }]), /unsupported/);
  assert.throws(() => memoryWith([{ ...base, rule_type: 'VISUAL', constraint: { operator: 'REFERENCE', value: 'v' } }]), /unsupported/);
  assert.throws(() => memoryWith([{ ...base, rule_type: 'LAYOUT', constraint: { operator: 'REFERENCE', value: 'v' } }]), /unsupported/);
});

test('Guardian outcome precedence is FAIL > REVIEW_REQUIRED > NOT_MEASURABLE > PASS', () => {
  assert.equal(aggregateGuardianOutcome([]), GUARDIAN_OUTCOME.NOT_MEASURABLE);
  assert.equal(aggregateGuardianOutcome([{ outcome: 'PASS' }]), GUARDIAN_OUTCOME.PASS);
  assert.equal(aggregateGuardianOutcome([{ outcome: 'PASS' }, { outcome: 'NOT_MEASURABLE' }]), GUARDIAN_OUTCOME.NOT_MEASURABLE);
  assert.equal(aggregateGuardianOutcome([{ outcome: 'REVIEW_REQUIRED' }, { outcome: 'NOT_MEASURABLE' }]), GUARDIAN_OUTCOME.REVIEW_REQUIRED);
  assert.equal(aggregateGuardianOutcome([{ outcome: 'FAIL' }, { outcome: 'REVIEW_REQUIRED' }]), GUARDIAN_OUTCOME.FAIL);
});

const check = (over) => ({
  id: 'c1', rule_id: 'r1', outcome: 'PASS', method: GUARDIAN_METHOD.DETERMINISTIC, evidence_refs: [], ...over,
});
const report = (memory, checks, over = {}) => buildGuardianReport({
  id: 'g1', tenant: tenant(), memory, target_ref: 'creative://asset-1', created_at: '2026-10-08T12:00:00Z', checks, ...over,
});

test('Guardian never returns PASS while a required rule has not been checked', () => {
  const memory = memoryWith([wordingRule, { ...wordingRule, id: 'r2' }]);
  const partial = report(memory, [check({ rule_id: 'r1' })]);
  assert.equal(partial.outcome, GUARDIAN_OUTCOME.NOT_MEASURABLE);
  assert.equal(partial.rules.find((r) => r.rule_id === 'r2').reason, 'RULE_NOT_CHECKED');

  const complete = report(memory, [check({ id: 'a', rule_id: 'r1' }), check({ id: 'b', rule_id: 'r2' })]);
  assert.equal(complete.outcome, GUARDIAN_OUTCOME.PASS);
  assert.equal(report(memory, []).outcome, GUARDIAN_OUTCOME.NOT_MEASURABLE);
});

test('Guardian cannot PASS a memory with no rules', () => {
  assert.equal(report(memoryWith([]), []).outcome, GUARDIAN_OUTCOME.NOT_MEASURABLE);
});

test('Guardian report does not make the execution decision and uses the memory it was given', () => {
  const result = report(memoryApproved(), [check({ outcome: 'FAIL', evidence_refs: ['ocr://1'] })]);
  assert.equal(result.outcome, GUARDIAN_OUTCOME.FAIL);
  assert.equal(result.execution_decision, null);
  assert.equal(result.policy_note, 'GUARDIAN_REPORT_IS_NOT_AN_EXECUTION_POLICY_DECISION');
  assert.deepEqual(result.memory_ref, { id: 'memory-1', version: 1 });
});

test('rule severity is honoured: a failed REVIEW rule asks for review, a failed BLOCK rule fails', () => {
  const reviewRule = { ...wordingRule, id: 'r1', severity: RULE_SEVERITY.REVIEW };
  assert.equal(report(memoryWith([reviewRule]), [check({ outcome: 'FAIL' })]).outcome, GUARDIAN_OUTCOME.REVIEW_REQUIRED);
  assert.equal(report(memoryWith([wordingRule]), [check({ outcome: 'FAIL' })]).outcome, GUARDIAN_OUTCOME.FAIL);
});

test('a model judgment cannot settle a deterministic rule nor produce a hard FAIL', () => {
  const det = report(memoryWith([wordingRule]), [check({ method: GUARDIAN_METHOD.MODEL, outcome: 'PASS' })]);
  assert.equal(det.outcome, GUARDIAN_OUTCOME.NOT_MEASURABLE);
  assert.deepEqual(det.rules[0].ignored_check_ids, ['c1']);

  const qual = { ...wordingRule, enforcement: RULE_ENFORCEMENT.QUALITATIVE, rule_type: 'TONE' };
  const modelFail = report(memoryWith([qual]), [check({ method: GUARDIAN_METHOD.MODEL, outcome: 'FAIL' })]);
  assert.equal(modelFail.outcome, GUARDIAN_OUTCOME.REVIEW_REQUIRED);
});

test('a HYBRID rule is not satisfied by a model PASS alone', () => {
  const hybrid = { ...wordingRule, enforcement: RULE_ENFORCEMENT.HYBRID };
  assert.equal(
    report(memoryWith([hybrid]), [check({ method: GUARDIAN_METHOD.MODEL })]).outcome,
    GUARDIAN_OUTCOME.NOT_MEASURABLE,
  );
  assert.equal(
    report(memoryWith([hybrid]), [check({ id: 'a' }), check({ id: 'b', method: GUARDIAN_METHOD.MODEL })]).outcome,
    GUARDIAN_OUTCOME.PASS,
  );
});

test('Guardian consumes the creative-fidelity gate for product fidelity instead of duplicating it', () => {
  const fidelityRule = {
    id: 'r1', rule_type: BRAND_RULE_TYPE.PRODUCT_FIDELITY, subject: 'product',
    enforcement: RULE_ENFORCEMENT.HYBRID, severity: RULE_SEVERITY.BLOCK,
    constraint: { operator: RULE_OPERATOR.REFERENCE, value: 'asset://source' },
  };
  const memory = memoryWith([fidelityRule]);

  const failed = guardianCheckFromFidelityGate({
    id: 'c1', ruleId: 'r1',
    gate: evaluateHardFidelityGate({
      requiredChecks: ['PRODUCT_IDENTITY', 'LOGO'],
      observations: [{ code: 'PRODUCT_IDENTITY', outcome: 'PASS' }, { code: 'LOGO', outcome: 'FAIL' }],
    }),
  });
  assert.equal(failed.method, GUARDIAN_METHOD.FIDELITY_GATE);
  assert.equal(failed.outcome, GUARDIAN_OUTCOME.FAIL);
  assert.match(failed.note, /failed:LOGO/);
  assert.equal(report(memory, [failed]).outcome, GUARDIAN_OUTCOME.FAIL);

  const passed = guardianCheckFromFidelityGate({
    id: 'c1', ruleId: 'r1',
    gate: evaluateHardFidelityGate({
      requiredChecks: ['PRODUCT_IDENTITY'],
      observations: [{ code: 'PRODUCT_IDENTITY', outcome: 'PASS' }],
    }),
  });
  assert.equal(report(memory, [passed]).outcome, GUARDIAN_OUTCOME.PASS);

  const unmeasured = guardianCheckFromFidelityGate({
    id: 'c1', ruleId: 'r1',
    gate: evaluateHardFidelityGate({ requiredChecks: ['PRODUCT_IDENTITY'], observations: [] }),
  });
  assert.equal(report(memory, [unmeasured]).outcome, GUARDIAN_OUTCOME.NOT_MEASURABLE);

  // an ad-hoc deterministic check cannot stand in for the fidelity gate
  assert.equal(
    report(memory, [check({ method: GUARDIAN_METHOD.DETERMINISTIC })]).outcome,
    GUARDIAN_OUTCOME.NOT_MEASURABLE,
  );
});

test('Guardian refuses unknown rules, unapproved memory and a foreign tenant', () => {
  assert.throws(() => report(memoryApproved(), [check({ rule_id: 'ghost' })]), /UNKNOWN_RULE/);
  assert.throws(
    () => report(memoryWith([wordingRule], { status: GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED, approval: null }), []),
    /GUARDIAN_REQUIRES_APPROVED_MEMORY/,
  );
  assert.throws(
    () => buildGuardianReport({
      id: 'g', tenant: tenant(M2), memory: memoryApproved(), target_ref: 't',
      created_at: '2026-10-08T12:00:00Z', checks: [],
    }),
    /GUARDIAN_TENANT_MISMATCH/,
  );
});

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
    tenant: tenant(), directCompetitors: ['c1', 'c2', 'c3', 'c4'],
  }), /at most 3/);

  const plan = buildSnapshotResearchPlan({ tenant: tenant(), directCompetitors: ['c1', 'c2', 'c3'] });
  assert.equal(plan.max_direct_competitors, 3);
  assert.equal(plan.continuous_crawling, false);
  assert.equal(plan.questions.length, 4);

  const wider = buildSnapshotResearchPlan({
    tenant: tenant(), directCompetitors: ['c1', 'c2', 'c3', 'c4'], maxDirectCompetitors: 5,
  });
  assert.equal(wider.max_direct_competitors, 5);
  assert.equal(wider.direct_competitors.length, 4);
  assert.throws(() => buildSnapshotResearchPlan({ tenant: tenant(), maxDirectCompetitors: 0 }), /integer >= 1/);
});

test('Brand Snapshot rejects competitor evidence outside the explicit research plan', () => {
  const plan = buildSnapshotResearchPlan({ tenant: tenant(), directCompetitors: ['competitor-1'] });
  assert.throws(() => buildBrandSnapshotV1({
    id: 's1', tenant: tenant(), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
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
  const plan = buildSnapshotResearchPlan({ tenant: tenant(M2) });
  assert.throws(() => buildBrandSnapshotV1({
    id: 's1', tenant: tenant(M1), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
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
  const plan = buildSnapshotResearchPlan({ tenant: tenant(), directCompetitors: ['competitor-1'] });
  const result = buildBrandSnapshotV1({
    id: 's1', tenant: tenant(), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
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
  const plan = buildSnapshotResearchPlan({ tenant: tenant() });
  assert.throws(() => buildBrandSnapshotV1({
    id: 's1', tenant: tenant(), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
    researchPlan: plan,
    evidence: [evidence({ provenance: EVIDENCE_PROVENANCE.INFERRED })],
    claims: [{
      id: 'c1', topic: SNAPSHOT_TOPIC.POSITIONING, subject: 'brand', attribute: 'a', value: 1,
      statement: 's', claim_kind: 'FACT', evidence_refs: ['e1'],
    }],
  }), /FACT_REQUIRES_OBSERVED_EVIDENCE/);
});

test('hypotheses do not satisfy Snapshot research coverage', () => {
  const plan = buildSnapshotResearchPlan({ tenant: tenant() });
  const result = buildBrandSnapshotV1({
    id: 's1', tenant: tenant(), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
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
    id: 's1', merchant_id: M1, version: 1, status: SNAPSHOT_STATUS.READY,
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
  id: 'snapshot-core-1', merchant_id: M1, version: 1, status,
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
  id: 'core-v1', tenant: tenant(), createdAt: '2026-10-08T10:00:00Z',
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
  assert.throws(() => proposal({ tenant: tenant(M2) }), /CORE_SNAPSHOT_MERCHANT_MISMATCH/);
  assert.throws(() => proposal({ tenant: { merchantId: M1 } }), /canonical tenant source/);
});

const approve = (over = {}) => approveBrandCore({
  proposal: proposal().core,
  snapshot: readySnapshotForCore(),
  tenant: tenant(),
  resolvedActor: resolvedActor(),
  approvedAt: '2026-10-08T10:30:00Z',
  note: 'Approved after review',
  ...over,
});

test('Brand Core approval records a resolved identity and emits a ledger-compatible decision event', () => {
  const { core, superseded, decision_event: event } = approve();
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
  assert.equal(approve().decision_event.id, event.id);
});

test('approval is refused without a present, same-tenant, authorized resolved actor', () => {
  assert.throws(() => approve({ resolvedActor: null }), /RESOLVED_ACTOR_MISSING/);
  assert.throws(() => approve({ resolvedActor: 'owner-1' }), /resolved_actor must be an object/);
  assert.throws(() => approve({ resolvedActor: resolvedActor(M2) }), /RESOLVED_ACTOR_TENANT_MISMATCH/);
  assert.throws(() => approve({ resolvedActor: resolvedActor(M1, { role: 'INTERN' }) }), /unsupported/);
  assert.throws(() => approve({ resolvedActor: resolvedActor(M1, { user_id: ' ' }) }), /user_id/);
  assert.throws(() => approve({ tenant: tenant(M2), resolvedActor: resolvedActor(M2) }), /CORE_TENANT_MISMATCH/);
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
    approve({ proposal: prepared.core, snapshot: readySnapshotForCore() }).core.status,
    GOVERNED_DOCUMENT_STATUS.APPROVED,
  );
});

test('an already APPROVED Core stays usable when its Snapshot becomes STALE', () => {
  const core = approve().core;
  const stale = readySnapshotForCore(SNAPSHOT_STATUS.STALE);
  const memory = memoryWith([wordingRule], { core_ref: { id: core.id, version: core.version } });
  const context = buildBrandContext({ tenant: tenant(), core, memory, snapshot: stale });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);
  assert.deepEqual(context.review_signals, ['BRAND_SNAPSHOT_STALE']);
});

test('approval is refused for a proposal that is not review-required or not ready', () => {
  assert.throws(() => approve({ proposal: coreApproved() }), /CORE_MUST_BE_REVIEW_REQUIRED_BEFORE_APPROVAL/);
  const weak = proposal({ decisions: { ...fullCoreDecisions(), exclusions: [] } }).core;
  assert.throws(() => approve({ proposal: weak }), /CORE_NOT_READY_FOR_APPROVAL/);
});

test('approving V2 supersedes V1 and emits a superseding decision event', () => {
  const v1 = approve().core;
  const v2Proposal = proposeBrandCoreRevision({
    approvedCore: v1, snapshot: readySnapshotForCore(), tenant: tenant(), id: 'core-v2',
    createdAt: '2026-10-08T11:00:00Z', changes: { positioning: 'Updated positioning' },
  }).core;

  assert.equal(v1.positioning, 'Positioning');
  assert.equal(v2Proposal.version, 2);
  assert.equal(v2Proposal.status, GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED);
  assert.equal(v2Proposal.supersedes_id, 'core-v1');

  const result = approve({ proposal: v2Proposal, activeCore: v1, approvedAt: '2026-10-08T12:00:00Z' });
  assert.equal(result.core.status, GOVERNED_DOCUMENT_STATUS.APPROVED);
  assert.equal(result.superseded.id, 'core-v1');
  assert.equal(result.superseded.status, GOVERNED_DOCUMENT_STATUS.SUPERSEDED);
  assert.deepEqual(result.decision_event.supersedes, { kind: 'brand_core', id: 'core-v1', version: 1 });
  assert.equal(v1.status, GOVERNED_DOCUMENT_STATUS.APPROVED, 'the input object is never mutated');
});

test('two APPROVED Cores can never coexist for one tenant', () => {
  const v1 = approve().core;
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
  assert.equal(selectActiveBrandCore([v1], tenant()).id, 'core-v1');
  assert.equal(selectActiveBrandCore([v1], tenant(M2)), null);
  assert.throws(
    () => selectActiveBrandCore([v1, { ...v1, id: 'core-x' }], tenant()),
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
