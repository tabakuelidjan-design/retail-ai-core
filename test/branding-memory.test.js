import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  APPROVER_ROLE,
  BRAND_CONTEXT_STATUS,
  BRAND_RULE_TYPE,
  CONTENT_KIND,
  DECISION_EVENT_TYPE,
  EXTERNAL_GATES,
  GOVERNED_DOCUMENT_STATUS,
  HARD_RULE_MATRIX,
  RULE_OPERATOR,
  RULE_SCOPE,
  RULE_SEVERITY,
  SNAPSHOT_SOURCE_KIND,
  SNAPSHOT_STATUS,
  approveBrandCore,
  approveBrandMemory,
  buildBrandContext,
  buildBrandCoreProposal,
  buildBrandMemoryDraft,
  creativeBrandInterface,
  marketingBrandInterface,
  normalizeBrandMemory,
  normalizeBrandSnapshot,
  normalizeCandidateManifest,
  normalizeDesignTokens,
  normalizeHardRule,
  proposeBrandCoreRevision,
  proposeBrandMemoryRevision,
  selectActiveBrandMemory,
  submitBrandMemoryForReview,
  validateBrandMemory,
  validateSchemaSubset,
} from '../src/branding/index.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const tenant = (merchantId = M1) => ({ merchantId, source: 'env' });
const actor = (merchantId = M1, over = {}) => ({
  user_id: 'user-owner-1', role: 'OWNER', merchant_id: merchantId, ...over,
});

// ------------------------------------------------------------------ fixtures (real Core flow)
const snapshot = (status = SNAPSHOT_STATUS.READY) => normalizeBrandSnapshot({
  id: 'snapshot-1', merchant_id: M1, version: 1, status,
  created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
  evidence: [{
    id: 'e1', provenance: 'observed', statement: 'Observed', completeness: 'COMPLETE',
    source: { system: 'internal', observed_at: '2026-10-08T08:00:00Z', kind: SNAPSHOT_SOURCE_KIND.INTERNAL_FACT },
  }],
});

const coreDecisions = () => ({
  category: 'category',
  buying_contexts: ['context'],
  value_proposition: 'Value',
  positioning: 'Position',
  core_promise: 'Promise',
  reasons_to_believe: ['Reason'],
  personality: ['clear'],
  voice: { traits: ['clear'], do: ['be specific'], dont: ['invent'] },
  exclusions: ['do not mislead'],
  distinctive_assets: [{ id: 'da1', type: 'LOGO', description: 'Primary mark', asset_ref: 'asset://logo-primary' }],
  evidence_refs: ['e1'],
});

const coreV1Proposal = () => buildBrandCoreProposal({
  id: 'core-v1', tenant: tenant(), createdAt: '2026-10-08T10:00:00Z', snapshot: snapshot(), decisions: coreDecisions(),
}).core;
const approveCore = (proposal, activeCore = null) => approveBrandCore({
  proposal, snapshot: snapshot(), tenant: tenant(), resolvedActor: actor(), activeCore, approvedAt: '2026-10-08T10:30:00Z',
}).approvedCore;
const coreV1 = () => approveCore(coreV1Proposal());
const coreV2 = (v1 = coreV1()) => approveCore(proposeBrandCoreRevision({
  approvedCore: v1, snapshot: snapshot(), tenant: tenant(), id: 'core-v2',
  createdAt: '2026-10-08T11:00:00Z', changes: { positioning: 'Updated' },
}).core, v1);

const rule = (over = {}) => ({
  id: 'r1', rule_type: 'TEXT', subject: 'text.body', operator: 'NOT_CONTAINS', value: 'forbidden',
  severity: 'BLOCK', scope: 'GLOBAL', source_ref: 'brand-core://core-v1', ...over,
});

const content = (over = {}) => ({
  identity_references: {
    primary_logo_ref: 'asset://logo-primary',
    approved_logo_refs: ['asset://logo-mono'],
  },
  design_tokens: {
    colors: { primary: '#112233', secondary: '#ffffff' },
    typography: { heading: { family: 'Example Sans', weights: [700, 600] }, body: { family: 'Example Sans', weights: [400] } },
  },
  hard_rules: [
    rule(),
    rule({ id: 'r2', rule_type: 'COLOR', subject: 'color.primary', operator: 'EQUALS', value: '#112233', scope: 'IMAGE' }),
    rule({
      id: 'r3', rule_type: 'CLAIM_REF', subject: 'claim.price', operator: 'ONE_OF',
      value: ['claim://price-policy'], source_ref: 'claim://price-policy',
    }),
    rule({
      id: 'r4', rule_type: 'EXTERNAL_GATE', subject: 'product_fidelity', operator: 'STATUS_IN', value: ['PASS'],
      scope: 'IMAGE', source_ref: 'external-policy://creative-fidelity',
    }),
  ],
  semantic_context: {
    voice_traits: ['clear'], do: ['be specific'], dont: ['exaggerate'],
    brand_style_summary: 'Sober and credible.', on_brand_examples: ['Example A'], off_brand_examples: ['Example B'],
  },
  external_references: {
    production_asset_refs: ['production://template-1'], claim_refs: ['claim://price-policy'],
    policy_refs: ['external-policy://creative-fidelity'],
  },
  ...over,
});

const draft = (core = coreV1(), over = {}) => buildBrandMemoryDraft({
  tenant: tenant(), id: 'mem-v1', createdAt: '2026-10-08T12:00:00Z', core, content: content(), ...over,
}).memory;
const reviewed = (core = coreV1(), memory = draft(core)) => submitBrandMemoryForReview({ memory, core, tenant: tenant() });
const approveMemory = (over = {}) => {
  const core = over.core ?? coreV1();
  return approveBrandMemory({
    memory: reviewed(core), core, tenant: tenant(), resolvedActor: actor(), approvedAt: '2026-10-08T13:00:00Z', ...over,
  });
};

// ------------------------------------------------------------------ Core binding
test('1. a Memory cannot be built without a Core', () => {
  assert.throws(() => buildBrandMemoryDraft({ tenant: tenant(), id: 'm', createdAt: '2026-10-08T12:00:00Z', core: null, content: content() }),
    /MEMORY_REQUIRES_APPROVED_CORE/);
});

test('2. a Memory cannot be built on a Core that is not APPROVED', () => {
  assert.throws(() => draft(coreV1Proposal()), /MEMORY_REQUIRES_APPROVED_CORE/);
});

test('3. a Memory cannot be built on another tenant\'s Core', () => {
  assert.throws(() => draft(coreV1(), { tenant: tenant(M2) }), /MEMORY_CORE_TENANT_MISMATCH/);
});

test('4. an incorrect core_ref is refused at validation and at approval', () => {
  const memoryOnV1 = reviewed(coreV1());
  const v2 = coreV2();
  assert.ok(validateBrandMemory(memoryOnV1, { core: v2 }).reasons.includes('BRAND_MEMORY_CORE_MISMATCH'));
  assert.throws(
    () => approveBrandMemory({
      memory: memoryOnV1, core: v2, tenant: tenant(), resolvedActor: actor(), approvedAt: '2026-10-08T13:00:00Z',
    }),
    /BRAND_MEMORY_CORE_MISMATCH/,
  );
});

test('5. when the active Core changes, the Brand Context is GATED with BRAND_MEMORY_CORE_MISMATCH', () => {
  const v1 = coreV1();
  const memory = approveMemory({ core: v1 }).approvedMemory;
  const ready = buildBrandContext({ tenant: tenant(), core: v1, memory });
  assert.equal(ready.status, BRAND_CONTEXT_STATUS.READY);

  const gated = buildBrandContext({ tenant: tenant(), core: coreV2(v1), memory });
  assert.equal(gated.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(gated.reasons.includes('BRAND_MEMORY_CORE_MISMATCH'));
  assert.throws(() => marketingBrandInterface(gated), /gated/);
});

test('6. a STALE Snapshot with compatible Core and Memory stays READY with a review signal', () => {
  const v1 = coreV1();
  const memory = approveMemory({ core: v1 }).approvedMemory;
  const context = buildBrandContext({ tenant: tenant(), core: v1, memory, snapshot: snapshot(SNAPSHOT_STATUS.STALE) });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);
  assert.deepEqual(context.review_signals, ['BRAND_SNAPSHOT_STALE']);
});

// ------------------------------------------------------------------ Hard rules
test('7. no non-deterministic escape hatch can enter a hard rule', () => {
  for (const operator of ['CUSTOM', 'EXECUTE_CODE', 'PROMPT', 'LLM_DECIDE']) {
    assert.equal(Object.values(RULE_OPERATOR).includes(operator), false);
    assert.throws(() => normalizeHardRule(rule({ operator })), /unsupported/);
  }
});

test('8. an unknown rule type is refused (V1 has exactly six)', () => {
  assert.deepEqual(Object.values(BRAND_RULE_TYPE).sort(),
    ['ASSET_REF', 'CLAIM_REF', 'COLOR', 'EXTERNAL_GATE', 'TEXT', 'TYPOGRAPHY']);
  for (const rule_type of ['TONE', 'VISUAL', 'LAYOUT', 'LOGO', 'WORDING', 'PRODUCT_FIDELITY']) {
    assert.throws(() => normalizeHardRule(rule({ rule_type })), /unsupported/);
  }
});

test('9. an unknown operator is refused', () => {
  assert.throws(() => normalizeHardRule(rule({ operator: 'LOOKS_LIKE' })), /unsupported/);
});

const SAMPLE = {
  ASSET_REF: { EQUALS: 'asset://a', ONE_OF: ['asset://a', 'asset://b'], REQUIRED: true },
  COLOR: { EQUALS: '#112233', ONE_OF: ['#112233', '#ffffff'], REQUIRED: true },
  TYPOGRAPHY: { EQUALS: 'Example Sans', ONE_OF: ['Example Sans', 'Other Serif'], REQUIRED: true },
  TEXT: { CONTAINS: 'foo', NOT_CONTAINS: 'bar', REQUIRED: true },
  CLAIM_REF: { EQUALS: 'claim://a', ONE_OF: ['claim://a', 'claim://b'], REQUIRED: true },
  EXTERNAL_GATE: { STATUS_IN: ['PASS'], REQUIRED: true },
};

test('10. the type x operator matrix is exact: every allowed pair passes, every other pair is refused', () => {
  for (const type of Object.values(BRAND_RULE_TYPE)) {
    for (const operator of Object.values(RULE_OPERATOR)) {
      const subject = type === 'EXTERNAL_GATE' ? 'product_fidelity' : 'subject.x';
      if (HARD_RULE_MATRIX[type].includes(operator)) {
        const normalized = normalizeHardRule(rule({ rule_type: type, operator, subject, value: SAMPLE[type][operator] }));
        assert.equal(normalized.operator, operator, `${type}/${operator}`);
      } else {
        assert.throws(
          () => normalizeHardRule(rule({ rule_type: type, operator, subject, value: 'x' })),
          /not allowed/,
          `${type}/${operator}`,
        );
      }
    }
  }
});

test('11. ASSET_REF + CONTAINS is refused', () => {
  assert.throws(() => normalizeHardRule(rule({ rule_type: 'ASSET_REF', operator: 'CONTAINS', value: 'a' })), /not allowed/);
});

test('12. TEXT keeps only CONTAINS, NOT_CONTAINS and REQUIRED; pattern matching is out of V1', () => {
  assert.deepEqual(HARD_RULE_MATRIX.TEXT, ['CONTAINS', 'NOT_CONTAINS', 'REQUIRED']);
  for (const operator of ['CONTAINS', 'NOT_CONTAINS']) {
    assert.equal(normalizeHardRule(rule({ operator, value: 'foo' })).operator, operator);
  }
  assert.equal(normalizeHardRule(rule({ operator: 'REQUIRED', value: true })).value, true);
  assert.equal(Object.values(RULE_OPERATOR).includes('MATCHES_PATTERN'), false);
  assert.throws(() => normalizeHardRule(rule({ operator: 'MATCHES_PATTERN', value: '^[A-Z]+$' })), /unsupported/);
});

test('13. EXTERNAL_GATE + STATUS_IN is accepted for a known gate and known statuses', () => {
  const normalized = normalizeHardRule(rule({
    rule_type: 'EXTERNAL_GATE', subject: 'product_fidelity', operator: 'STATUS_IN', value: ['PASS'],
    source_ref: 'external-policy://creative-fidelity',
  }));
  assert.deepEqual(normalized.value, ['PASS']);
  assert.equal(EXTERNAL_GATES.product_fidelity.source, 'creative-fidelity');
});

test('14. EXTERNAL_GATE + CONTAINS is refused; unknown gates and statuses are refused', () => {
  const gate = { rule_type: 'EXTERNAL_GATE', subject: 'product_fidelity', source_ref: 'external-policy://x' };
  assert.throws(() => normalizeHardRule(rule({ ...gate, operator: 'CONTAINS', value: 'PASS' })), /not allowed/);
  assert.throws(() => normalizeHardRule(rule({ ...gate, operator: 'STATUS_IN', value: ['GREAT'] })), /unknown to gate/);
  assert.throws(() => normalizeHardRule(rule({ ...gate, subject: 'brand_elegance', operator: 'STATUS_IN', value: ['PASS'] })), /not a known external gate/);
});

test('15. an unknown severity is refused (only BLOCK and REVIEW)', () => {
  assert.deepEqual(Object.values(RULE_SEVERITY), ['BLOCK', 'REVIEW']);
  assert.throws(() => normalizeHardRule(rule({ severity: 'WARN' })), /unsupported/);
  assert.throws(() => normalizeHardRule(rule({ severity: undefined })), /severity/);
});

test('16. an unknown scope is refused (no per-platform scope in V1); scope defaults to GLOBAL', () => {
  assert.deepEqual(Object.values(RULE_SCOPE), ['GLOBAL', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']);
  assert.throws(() => normalizeHardRule(rule({ scope: 'INSTAGRAM' })), /unsupported/);
  assert.equal(normalizeHardRule(rule({ scope: undefined })).scope, 'GLOBAL');
});

test('17. a missing or non-standard source_ref is refused explicitly (every rule must say why it exists)', () => {
  assert.throws(() => normalizeHardRule(rule({ source_ref: undefined })), /HARD_RULE_SOURCE_REF_REQUIRED/);
  assert.throws(() => normalizeHardRule(rule({ source_ref: 'because-i-said-so' })), /known provenance scheme/);
  for (const scheme of ['brand-core', 'decision', 'approved-asset', 'claim', 'external-policy']) {
    assert.equal(normalizeHardRule(rule({ source_ref: `${scheme}://x` })).source_ref, `${scheme}://x`);
  }
});

test('hard rule values are validated per type, and unknown fields are refused', () => {
  assert.throws(() => normalizeHardRule(rule({ rule_type: 'COLOR', operator: 'EQUALS', value: 'blue' })), /hex/);
  assert.throws(() => normalizeHardRule(rule({ rule_type: 'CLAIM_REF', operator: 'EQUALS', value: 'cheapest' })), /claim:\/\//);
  assert.throws(() => normalizeHardRule(rule({ rule_type: 'COLOR', operator: 'ONE_OF', value: [] })), /non-empty/);
  assert.throws(() => normalizeHardRule(rule({ rule_type: 'COLOR', operator: 'ONE_OF', value: ['#112233', '#112233'] })), /duplicates/);
  assert.throws(() => normalizeHardRule(rule({ operator: 'REQUIRED', value: 'yes' })), /must be true/);
  assert.throws(() => normalizeHardRule(rule({ tone: 'elegant' })), /not part of the hard rule contract/);
  assert.equal(normalizeHardRule(rule({ rule_type: 'COLOR', operator: 'EQUALS', value: '#aabbcc' })).value, '#AABBCC');
});

test('duplicate rule ids are refused at document level', () => {
  assert.throws(() => draft(coreV1(), { content: content({ hard_rules: [rule(), rule()] }) }), /duplicate ids/);
});

// ------------------------------------------------------------------ Design tokens
test('18. an invalid HEX color is refused; duplicate color values are refused', () => {
  for (const bad of ['#12', '112233', '#GGGGGG', '#1122334', 'red']) {
    assert.throws(() => normalizeDesignTokens({ colors: { primary: bad } }), /hex/, bad);
  }
  assert.throws(() => normalizeDesignTokens({ colors: { a: '#112233', b: '#112233' } }), /duplicates the value/);
  assert.throws(() => normalizeDesignTokens({ colors: { Primary: '#112233' } }), /kebab-case/);
});

test('19. an empty font family is refused', () => {
  assert.throws(() => normalizeDesignTokens({ typography: { body: { family: ' ', weights: [400] } } }), /family/);
  assert.throws(() => normalizeDesignTokens({ typography: { body: { weights: [400] } } }), /family/);
});

test('20. invalid font weights are refused', () => {
  for (const weights of [[], [0], [1001], [400.5], ['400'], [400, 400]]) {
    assert.throws(() => normalizeDesignTokens({ typography: { body: { family: 'Sans', weights } } }), /weights/, JSON.stringify(weights));
  }
});

test('21. valid tokens are accepted and normalized; tokens beyond colors/typography are out of scope', () => {
  const tokens = normalizeDesignTokens({
    colors: { primary: '#112233', secondary: '#ffffff' },
    typography: { heading: { family: 'Example Sans', weights: [700, 600] } },
  });
  assert.deepEqual(tokens.colors, { primary: '#112233', secondary: '#FFFFFF' });
  assert.deepEqual(tokens.typography.heading.weights, [600, 700]);
  for (const key of ['spacing', 'radius', 'shadow', 'grid', 'breakpoints', 'motion']) {
    assert.throws(() => normalizeDesignTokens({ [key]: {} }), /not part of Brand Memory V1/);
  }
});

// ------------------------------------------------------------------ Approval and versioning
test('22. a DRAFT cannot be approved directly; it must be submitted for review first', () => {
  const memory = draft();
  assert.equal(memory.status, GOVERNED_DOCUMENT_STATUS.DRAFT);
  assert.throws(
    () => approveBrandMemory({ memory, core: coreV1(), tenant: tenant(), resolvedActor: actor(), approvedAt: '2026-10-08T13:00:00Z' }),
    /MEMORY_MUST_BE_REVIEW_REQUIRED_BEFORE_APPROVAL/,
  );
  assert.equal(reviewed().status, GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED);
  assert.throws(() => submitBrandMemoryForReview({ memory: reviewed(), core: coreV1(), tenant: tenant() }), /MUST_BE_DRAFT_TO_SUBMIT/);
});

test('23. approval without a resolved actor is refused', () => {
  assert.throws(() => approveMemory({ resolvedActor: null }), /RESOLVED_ACTOR_MISSING/);
});

test('24. an actor from another tenant is refused', () => {
  assert.throws(() => approveMemory({ resolvedActor: actor(M2) }), /RESOLVED_ACTOR_TENANT_MISMATCH/);
  assert.throws(() => approveMemory({ tenant: tenant(M2), resolvedActor: actor(M2) }), /MEMORY_TENANT_MISMATCH/);
});

test('25. an unauthorized role is refused; authorized roles are exactly OWNER and AUTHORIZED_REVIEWER', () => {
  assert.deepEqual(Object.values(APPROVER_ROLE).sort(), ['AUTHORIZED_REVIEWER', 'OWNER']);
  assert.throws(() => approveMemory({ resolvedActor: actor(M1, { role: 'INTERN' }) }), /unsupported/);
  assert.equal(approveMemory({ resolvedActor: actor(M1, { role: 'AUTHORIZED_REVIEWER' }) }).approvedMemory.approval.approver_role, 'AUTHORIZED_REVIEWER');
});

test('26. approval produces a BRAND_MEMORY_APPROVED decision event reusing the Core event model', () => {
  const result = approveMemory();
  assert.deepEqual(Object.keys(result).sort(), ['approvedMemory', 'decisionEvent', 'supersededMemory']);
  const { approvedMemory, supersededMemory, decisionEvent } = result;
  assert.equal(approvedMemory.status, GOVERNED_DOCUMENT_STATUS.APPROVED);
  assert.equal(supersededMemory, null);
  assert.equal(decisionEvent.type, DECISION_EVENT_TYPE.BRAND_MEMORY_APPROVED);
  assert.deepEqual(decisionEvent.subject, { kind: 'brand_memory', id: 'mem-v1', version: 1 });
  assert.equal(decisionEvent.merchant_id, M1);
  assert.match(decisionEvent.id, /^bde_[0-9a-f]{32}$/);
  assert.equal(approvedMemory.approval.decision_event_id, decisionEvent.id);
  assert.equal(approvedMemory.approval.approved_by, 'user-owner-1');
  assert.equal(approveMemory().decisionEvent.id, decisionEvent.id, 'deterministic id');
});

const v2For = (v1Memory, core) => proposeBrandMemoryRevision({
  approvedMemory: v1Memory, core, tenant: tenant(), id: 'mem-v2', createdAt: '2026-10-08T14:00:00Z',
  changes: { semantic_context: { ...content().semantic_context, brand_style_summary: 'Updated.' } },
}).memory;

test('27. approving V2 supersedes V1 with a superseding decision event', () => {
  const core = coreV1();
  const v1 = approveMemory({ core }).approvedMemory;
  const v2 = v2For(v1, core);
  assert.equal(v2.status, GOVERNED_DOCUMENT_STATUS.REVIEW_REQUIRED);
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedes_id, 'mem-v1');

  const result = approveBrandMemory({
    memory: v2, core, tenant: tenant(), resolvedActor: actor(), activeMemory: v1, approvedAt: '2026-10-08T15:00:00Z',
  });
  assert.equal(result.approvedMemory.status, GOVERNED_DOCUMENT_STATUS.APPROVED);
  assert.equal(result.supersededMemory.id, 'mem-v1');
  assert.equal(result.supersededMemory.status, GOVERNED_DOCUMENT_STATUS.SUPERSEDED);
  assert.deepEqual(result.decisionEvent.supersedes, { kind: 'brand_memory', id: 'mem-v1', version: 1 });
});

test('a new Memory version can move to a newer Core and supersede the old Memory', () => {
  const v1Core = coreV1();
  const v1 = approveMemory({ core: v1Core }).approvedMemory;
  const v2Core = coreV2(v1Core);
  const v2 = v2For(v1, v2Core);
  assert.deepEqual(v2.core_ref, { id: 'core-v2', version: 2 });
  const result = approveBrandMemory({
    memory: v2, core: v2Core, tenant: tenant(), resolvedActor: actor(), activeMemory: v1, approvedAt: '2026-10-08T15:00:00Z',
  });
  assert.equal(buildBrandContext({ tenant: tenant(), core: v2Core, memory: result.approvedMemory }).status, BRAND_CONTEXT_STATUS.READY);
});

test('28. two active APPROVED Memories are refused explicitly', () => {
  const core = coreV1();
  const v1 = approveMemory({ core }).approvedMemory;
  const sibling = reviewed(core, draft(core, { id: 'mem-other' }));
  assert.throws(
    () => approveBrandMemory({ memory: sibling, core, tenant: tenant(), resolvedActor: actor(), activeMemory: v1, approvedAt: '2026-10-08T15:00:00Z' }),
    /MEMORY_ACTIVE_MEMORY_MUST_BE_SUPERSEDED/,
  );
  const orphan = proposeBrandMemoryRevision({
    approvedMemory: v1, core, tenant: tenant(), id: 'mem-v2', createdAt: '2026-10-08T14:00:00Z',
  }).memory;
  assert.throws(
    () => approveBrandMemory({ memory: orphan, core, tenant: tenant(), resolvedActor: actor(), approvedAt: '2026-10-08T15:00:00Z' }),
    /MEMORY_SUPERSEDES_UNKNOWN_ACTIVE_MEMORY/,
  );
  assert.throws(
    () => approveBrandMemory({ memory: orphan, core, tenant: tenant(), resolvedActor: actor(), activeMemory: reviewed(core), approvedAt: '2026-10-08T15:00:00Z' }),
    /MEMORY_ACTIVE_MEMORY_NOT_APPROVED/,
  );
  assert.equal(selectActiveBrandMemory([v1], tenant()).id, 'mem-v1');
  assert.equal(selectActiveBrandMemory([v1], tenant(M2)), null);
  assert.throws(
    () => selectActiveBrandMemory([v1, { ...v1, id: 'mem-x' }], tenant()),
    /MULTIPLE_APPROVED_BRAND_MEMORIES/,
  );
});

test('29. an approved version is immutable and never mutated by a revision', () => {
  const core = coreV1();
  const v1 = approveMemory({ core }).approvedMemory;
  const before = JSON.stringify(v1);
  assert.equal(Object.isFrozen(v1), true);
  assert.throws(() => { v1.status = 'DRAFT'; }, TypeError);
  assert.throws(() => { v1.hard_rules.push({}); }, TypeError);
  assert.throws(() => { v1.design_tokens.colors.primary = '#000000'; }, TypeError);

  const v2 = v2For(v1, core);
  assert.equal(JSON.stringify(v1), before);
  assert.equal(v1.semantic_context.brand_style_summary, 'Sober and credible.');
  assert.equal(v2.semantic_context.brand_style_summary, 'Updated.');
  assert.throws(() => proposeBrandMemoryRevision({ approvedMemory: reviewed(core), core, tenant: tenant(), id: 'x', createdAt: '2026-10-08T14:00:00Z' }),
    /REVISION_REQUIRES_APPROVED_MEMORY/);
});

// ------------------------------------------------------------------ Content rules
test('an empty Memory is not approvable, but no logo is mandatory', () => {
  const core = coreV1();
  const empty = buildBrandMemoryDraft({ tenant: tenant(), id: 'm-empty', createdAt: '2026-10-08T12:00:00Z', core, content: {} });
  assert.deepEqual(empty.readiness.reasons, ['BRAND_MEMORY_EMPTY']);
  assert.throws(() => submitBrandMemoryForReview({ memory: empty.memory, core, tenant: tenant() }), /BRAND_MEMORY_EMPTY/);

  const noLogo = buildBrandMemoryDraft({
    tenant: tenant(), id: 'm-nologo', createdAt: '2026-10-08T12:00:00Z', core,
    content: { design_tokens: { colors: { primary: '#112233' } } },
  });
  assert.equal(noLogo.readiness.ok, true);
  assert.equal(noLogo.memory.identity_references.primary_logo_ref, null);
});

test('Distinctive Brand Assets live only in the Core: Memory has no list of its own', () => {
  const core = coreV1();
  assert.throws(
    () => draft(core, { content: content({ identity_references: { distinctive_asset_refs: ['asset://x'] } }) }),
    /distinctive_asset_refs is not part of Brand Memory V1/,
  );
  assert.equal('distinctive_asset_refs' in draft(core).identity_references, false);
  // Creative reads them from the Core, through the Creative interface
  const context = buildBrandContext({ tenant: tenant(), core, memory: approveMemory({ core }).approvedMemory });
  const view = creativeBrandInterface(context);
  assert.deepEqual(view.distinctive_assets, JSON.parse(JSON.stringify(core.distinctive_assets)));
  assert.equal(view.distinctive_assets[0].asset_ref, 'asset://logo-primary');
  assert.throws(() => { view.distinctive_assets[0].asset_ref = 'x'; }, TypeError);
});

test('identity references are opaque refs: no binary, no whitespace, no repeated primary logo', () => {
  const ids = (identity_references) => draft(coreV1(), { content: content({ identity_references }) });
  assert.throws(() => ids({ primary_logo_ref: 'my logo.png' }), /opaque/);
  assert.throws(() => ids({ primary_logo_ref: 'asset://a', approved_logo_refs: ['asset://a'] }), /must not repeat the primary/);
  assert.throws(() => ids({ approved_logo_refs: ['asset://b', 'asset://b'] }), /duplicates/);
  assert.throws(() => ids({ logo_binary: 'data' }), /not part of Brand Memory V1/);
});

test('out-of-scope data cannot enter Brand Memory (budget, strategy, catalog, pricing...)', () => {
  const core = coreV1();
  const base = draft(core);
  for (const key of ['budget', 'campaign_strategy', 'competitors', 'product_catalog', 'pricing', 'ai_look_score']) {
    assert.throws(() => normalizeBrandMemory({ ...base, [key]: {} }), /not part of Brand Memory V1/, key);
    assert.throws(() => buildBrandMemoryDraft({ tenant: tenant(), id: 'm', createdAt: '2026-10-08T12:00:00Z', core, content: { [key]: {} } }), /not part of Brand Memory V1/, key);
  }
  assert.throws(() => draft(core, { content: content({ semantic_context: { budget: 'x' } }) }), /not part of Brand Memory V1/);
  assert.throws(() => draft(core, { content: content({ external_references: { price_list: [] } }) }), /not part of Brand Memory V1/);
  assert.throws(() => draft(core, { content: content({ external_references: { claim_refs: ['cheapest'] } }) }), /claim:\/\//);
});

// ------------------------------------------------------------------ Interfaces
const readyContext = () => {
  const core = coreV1();
  return buildBrandContext({ tenant: tenant(), core, memory: approveMemory({ core }).approvedMemory });
};

test('30. Marketing gets a narrow view without approval internals', () => {
  const view = marketingBrandInterface(readyContext());
  assert.deepEqual(view.core_ref, { id: 'core-v1', version: 1 });
  assert.deepEqual(view.memory_ref, { id: 'mem-v1', version: 1 });
  assert.deepEqual(view.claim_refs, ['claim://price-policy']);
  assert.deepEqual(view.hard_rules.map((r) => r.id).sort(), ['r1', 'r3'], 'only TEXT and CLAIM_REF rules');
  assert.equal(view.semantic_context.brand_style_summary, 'Sober and credible.');
  const serialized = JSON.stringify(view);
  for (const leak of ['approval', 'decision_event_id', 'bde_', 'approved_by', 'created_at', 'design_tokens', 'identity_references']) {
    assert.equal(serialized.includes(leak), false, leak);
  }
});

test('31. Creative gets identity, tokens and rules read-only (no write capability)', () => {
  const view = creativeBrandInterface(readyContext());
  assert.equal(view.identity_references.primary_logo_ref, 'asset://logo-primary');
  assert.equal(view.design_tokens.colors.primary, '#112233');
  assert.equal(view.hard_rules.length, 4);
  assert.deepEqual(view.external_references.production_asset_refs, ['production://template-1']);
  assert.equal(JSON.stringify(view).includes('decision_event_id'), false);
  assert.throws(() => { view.design_tokens.colors.primary = '#000000'; }, TypeError);
  assert.throws(() => { view.hard_rules.push({}); }, TypeError);
  assert.throws(() => { view.identity_references.primary_logo_ref = 'x'; }, TypeError);
  assert.throws(() => { view.hard_rules[0].value = 'x'; }, TypeError);
  assert.equal(Object.keys(view).some((key) => /write|update|publish|approve/i.test(key)), false);
});

test('32. the Brand Context is GATED without a validated, approved Memory', () => {
  const core = coreV1();
  const none = buildBrandContext({ tenant: tenant(), core, memory: null });
  assert.equal(none.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(none.reasons.includes('BRAND_MEMORY_MISSING'));

  const unapproved = buildBrandContext({ tenant: tenant(), core, memory: reviewed(core) });
  assert.equal(unapproved.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(unapproved.reasons.includes('BRAND_MEMORY_NOT_APPROVED'));
  assert.throws(() => creativeBrandInterface(unapproved), /gated/);

  const otherTenant = buildBrandContext({ tenant: tenant(M2), core, memory: approveMemory({ core }).approvedMemory });
  assert.equal(otherTenant.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(otherTenant.reasons.includes('BRAND_MEMORY_TENANT_MISMATCH'));
});

// ------------------------------------------------------------------ Schema (executed, not decorative)
const schemaOf = async () => JSON.parse(await readFile('schemas/branding/brand-memory-v1.schema.json', 'utf8'));

test('33. a valid normalized Memory passes the schema (draft, reviewed and approved)', async () => {
  const schema = await schemaOf();
  const core = coreV1();
  for (const memory of [draft(core), reviewed(core), approveMemory({ core }).approvedMemory]) {
    const result = validateSchemaSubset(schema, JSON.parse(JSON.stringify(memory)));
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  }
});

test('34. an invalid Memory really fails the schema validator', async () => {
  const schema = await schemaOf();
  const good = JSON.parse(JSON.stringify(approveMemory().approvedMemory));
  const mutate = (fn) => { const copy = JSON.parse(JSON.stringify(good)); fn(copy); return copy; };
  const bad = {
    'unknown top-level field': mutate((m) => { m.budget = 1; }),
    'missing core_ref': mutate((m) => { delete m.core_ref; }),
    'bad status': mutate((m) => { m.status = 'LIVE'; }),
    'non-uuid tenant': mutate((m) => { m.merchant_id = 'merchant-1'; }),
    'unknown rule type': mutate((m) => { m.hard_rules[0].rule_type = 'TONE'; }),
    'unknown operator': mutate((m) => { m.hard_rules[0].operator = 'CUSTOM'; }),
    'unknown severity': mutate((m) => { m.hard_rules[0].severity = 'WARN'; }),
    'unknown scope': mutate((m) => { m.hard_rules[0].scope = 'INSTAGRAM'; }),
    'rule without source_ref': mutate((m) => { delete m.hard_rules[0].source_ref; }),
    'rule with bad source_ref': mutate((m) => { m.hard_rules[0].source_ref = 'nowhere'; }),
    'bad hex': mutate((m) => { m.design_tokens.colors.primary = 'blue'; }),
    'empty family': mutate((m) => { m.design_tokens.typography.body.family = ''; }),
    'bad weight': mutate((m) => { m.design_tokens.typography.body.weights = [0]; }),
    'bad claim ref': mutate((m) => { m.external_references.claim_refs = ['cheapest']; }),
    'unknown semantic field': mutate((m) => { m.semantic_context.audience = 'x'; }),
    'bad approver role': mutate((m) => { m.approval.approver_role = 'GUEST'; }),
  };
  for (const [label, doc] of Object.entries(bad)) {
    assert.equal(validateSchemaSubset(schema, doc).ok, false, label);
  }
});

test('schema enums cannot drift from the code constants', async () => {
  const schema = await schemaOf();
  const rule = schema.$defs.hard_rule.properties;
  assert.deepEqual(rule.rule_type.enum, Object.values(BRAND_RULE_TYPE));
  assert.deepEqual(rule.operator.enum, Object.values(RULE_OPERATOR));
  assert.deepEqual(rule.severity.enum, Object.values(RULE_SEVERITY));
  assert.deepEqual(rule.scope.enum, Object.values(RULE_SCOPE));
  assert.deepEqual(schema.properties.status.enum, Object.values(GOVERNED_DOCUMENT_STATUS));
  assert.deepEqual(schema.properties.approval.properties.approver_role.enum, Object.values(APPROVER_ROLE));
});

test('the schema validator refuses keywords it does not enforce, even in unreached branches', () => {
  assert.throws(() => validateSchemaSubset({ type: 'object', properties: { a: { oneOf: [] } } }, {}), /UNSUPPORTED_SCHEMA_KEYWORD: oneOf/);
  assert.throws(() => validateSchemaSubset({ $defs: { x: { patternProperties: {} } }, type: 'object' }, {}), /UNSUPPORTED_SCHEMA_KEYWORD/);
  assert.throws(() => validateSchemaSubset({ $ref: '#/$defs/missing' }, 1), /UNRESOLVED_SCHEMA_REF/);
  assert.equal(validateSchemaSubset({ type: 'integer', minimum: 1 }, 0).ok, false);
});

// ------------------------------------------------------------------ Candidate manifest contract
test('the candidate manifest contract is defined and strict (evaluation is Guardian V1)', () => {
  const manifest = normalizeCandidateManifest({
    content_kind: 'IMAGE',
    asset_refs: ['asset://x'],
    detected_colors: ['#112233', '#ffffff'],
    typography: [{ family: 'Example Sans' }],
    text_content: 'Hello',
    claim_refs: ['claim://price-policy'],
    external_gate_results: [{ gate: 'product_fidelity', status: 'PASS' }],
  });
  assert.deepEqual(manifest.detected_colors, ['#112233', '#FFFFFF']);
  assert.equal(Object.isFrozen(manifest), true);
  assert.deepEqual(Object.values(CONTENT_KIND), ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']);
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'GLOBAL' }), /unsupported/);
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'TEXT', score: 9 }), /not part of the candidate manifest/);
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', external_gate_results: [{ gate: 'x', status: 'PASS' }] }), /known external gate/);
  assert.throws(() => normalizeCandidateManifest({ content_kind: 'IMAGE', external_gate_results: [{ gate: 'product_fidelity', status: 'OK' }] }), /unknown to gate/);
  assert.deepEqual(normalizeCandidateManifest({ content_kind: 'TEXT' }).asset_refs, []);
});

test('the same rule set is rebuilt identically from a draft (no hidden state)', () => {
  const core = coreV1();
  assert.equal(JSON.stringify(draft(core)), JSON.stringify(draft(core)));
  assert.equal(RULE_SCOPE.GLOBAL, 'GLOBAL');
});
