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
  SNAPSHOT_STATUS,
  aggregateGuardianOutcome,
  assertBrandStatusTransition,
  buildBrandContext,
  buildGuardianPlan,
  buildGuardianReport,
  creativeBrandInterface,
  marketingBrandInterface,
  normalizeBrandCore,
  normalizeBrandMemory,
  normalizeBrandSnapshot,
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
