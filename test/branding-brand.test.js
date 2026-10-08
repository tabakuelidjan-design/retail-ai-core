import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAND_CONTEXT_STATUS,
  BRAND_STATUS,
  approveBrandCore,
  approveBrandMemory,
  buildBrandContext,
  buildBrandCoreProposal,
  buildBrandIdentity,
  buildBrandMemoryDraft,
  buildBrandSnapshotV1,
  buildCoreDecisionPacket,
  buildSnapshotResearchPlan,
  creativeBrandInterface,
  marketingBrandInterface,
  normalizeBrandIdentity,
  normalizeBrandSnapshot,
  proposeBrandCoreRevision,
  proposeBrandMemoryRevision,
  resolveBrand,
  selectActiveBrandCore,
  selectActiveBrandMemory,
  submitBrandMemoryForReview,
  validateBrandHierarchy,
  validateBrandMemory,
} from '../src/branding/index.js';

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const B1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const B3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const tenant = (merchantId = M1) => ({ merchantId, source: 'env' });
const actor = (merchantId = M1) => ({ user_id: 'user-owner-1', role: 'OWNER', merchant_id: merchantId });

const identity = (over = {}) => ({
  brand_id: B1,
  merchant_id: M1,
  name: 'House Brand',
  status: 'ACTIVE',
  created_at: '2026-10-01T09:00:00Z',
  parent_brand_id: null,
  default_locale: 'fr-BE',
  supported_locales: ['fr-BE', 'nl-BE', 'en-GB'],
  ...over,
});
const brandOf = (merchantId, brandId, name, over = {}) => buildBrandIdentity({
  tenant: tenant(merchantId), brandId, name, createdAt: '2026-10-01T09:00:00Z',
  defaultLocale: 'fr-BE', supportedLocales: ['fr-BE', 'nl-BE'], ...over,
});
const brandA = () => brandOf(M1, B1, 'House Brand');
const brandB = () => brandOf(M1, B2, 'Webshop Brand');

// ------------------------------------------------------------------ one governed chain per brand
const decisions = () => ({
  category: 'category', buying_contexts: ['context'], value_proposition: 'Value', positioning: 'Position',
  core_promise: 'Promise', reasons_to_believe: ['Reason'], personality: ['clear'],
  voice: { traits: ['clear'], do: ['be specific'], dont: ['invent'] }, exclusions: ['do not mislead'],
  distinctive_assets: [], evidence_refs: ['e1'],
});
const snapshotFor = (brand, tag, status = 'READY') => normalizeBrandSnapshot({
  id: `snap-${tag}`, merchant_id: brand.merchant_id, brand_id: brand.brand_id, version: 1, status,
  created_at: '2026-10-08T09:00:00Z', observed_at: '2026-10-08T09:00:00Z',
  evidence: [{
    id: 'e1', provenance: 'observed', statement: 'Observed', completeness: 'COMPLETE',
    source: { system: 'internal', observed_at: '2026-10-08T08:00:00Z', kind: 'INTERNAL_FACT' },
  }],
});
const rule = () => ({
  id: 'r1', rule_type: 'TEXT', subject: 'text.body', operator: 'NOT_CONTAINS', value: 'cheapest',
  severity: 'BLOCK', scope: 'GLOBAL', source_ref: 'brand-core://core',
});
const chain = (brand, tag) => {
  const t = tenant(brand.merchant_id);
  const snap = snapshotFor(brand, tag);
  const proposal = buildBrandCoreProposal({
    id: `core-${tag}`, tenant: t, brand, createdAt: '2026-10-08T10:00:00Z', snapshot: snap, decisions: decisions(),
  }).core;
  const coreResult = approveBrandCore({
    proposal, snapshot: snap, tenant: t, brand, resolvedActor: actor(brand.merchant_id), approvedAt: '2026-10-08T10:30:00Z',
  });
  const core = coreResult.approvedCore;
  const draft = buildBrandMemoryDraft({
    tenant: t, brand, id: `mem-${tag}`, createdAt: '2026-10-08T12:00:00Z', core,
    content: { hard_rules: [rule()], design_tokens: { colors: { primary: '#112233' } } },
  }).memory;
  const reviewed = submitBrandMemoryForReview({ memory: draft, core, tenant: t, brand });
  const memoryResult = approveBrandMemory({
    memory: reviewed, core, tenant: t, brand, resolvedActor: actor(brand.merchant_id), approvedAt: '2026-10-08T13:00:00Z',
  });
  return { brand, snap, core, memory: memoryResult.approvedMemory, coreResult, memoryResult };
};

// ------------------------------------------------------------------ Brand Identity (1-9)
test('1. brand_id is mandatory, a UUID, and distinct from merchant_id', () => {
  assert.throws(() => normalizeBrandIdentity(identity({ brand_id: undefined })), /brand_id/);
  assert.throws(() => normalizeBrandIdentity(identity({ brand_id: 'house-brand' })), /brand UUID/);
  assert.throws(() => normalizeBrandIdentity(identity({ brand_id: M1 })), /distinct from brand.merchant_id/);
  assert.equal(normalizeBrandIdentity(identity({ brand_id: B1.toUpperCase() })).brand_id, B1, 'normalized lower-case');
  // governed documents carry it too
  assert.throws(() => normalizeBrandSnapshot({ ...snapshotFor(brandA(), 'x'), brand_id: undefined }), /snapshot.brand_id/);
  assert.throws(() => normalizeBrandSnapshot({ ...snapshotFor(brandA(), 'x'), brand_id: M1 }), /distinct from snapshot.merchant_id/);
});

test('2. merchant_id comes from the canonical tenant, and a brand of another tenant is refused', () => {
  const brand = brandA();
  assert.equal(brand.merchant_id, M1);
  assert.throws(() => buildBrandIdentity({ tenant: { merchantId: M1 }, brandId: B1, name: 'x', createdAt: '2026-10-01T09:00:00Z', defaultLocale: 'fr-BE', supportedLocales: ['fr-BE'] }),
    /canonical tenant source/);
  assert.throws(() => buildBrandIdentity({ tenant: tenant('not-a-uuid'), brandId: B1, name: 'x', createdAt: '2026-10-01T09:00:00Z', defaultLocale: 'fr-BE', supportedLocales: ['fr-BE'] }),
    /tenant UUID/);
  assert.equal(resolveBrand(tenant(M1), brand).brandId, B1);
  assert.throws(() => resolveBrand(tenant(M2), brand), /BRAND_TENANT_MISMATCH/);
  assert.throws(() => resolveBrand(tenant(M1), null), /BRAND_IDENTITY_MISSING/);
});

test('3. an empty name is refused (the name is the brand name, not the legal or tenant name)', () => {
  for (const name of ['', '   ', undefined]) assert.throws(() => normalizeBrandIdentity(identity({ name })), /name/);
  assert.throws(() => normalizeBrandIdentity(identity({ name: 'x'.repeat(121) })), /too long/);
});

test('4. default_locale is mandatory; a valid locale is normalized to its canonical BCP 47 form, an invalid one is refused', () => {
  assert.throws(() => normalizeBrandIdentity(identity({ default_locale: undefined })), /default_locale/);
  // normalization instead of a casing error
  const cases = { 'fr-be': 'fr-BE', 'FR-be': 'fr-BE', 'nl-BE': 'nl-BE', 'EN-gb': 'en-GB', 'zh-hant-tw': 'zh-Hant-TW', 'ES-419': 'es-419', FR: 'fr', iw: 'he' };
  for (const [input, expected] of Object.entries(cases)) {
    const brand = normalizeBrandIdentity(identity({ default_locale: input, supported_locales: [input] }));
    assert.equal(brand.default_locale, expected, input);
    assert.deepEqual(brand.supported_locales, [expected], input);
  }
  // not BCP 47, or outside the stored shape language[-Script][-REGION]
  for (const bad of ['fr_BE', 'french', 'f', 'fr-', 'fr-Belgium', 'fr-BE-u-ca-gregory', 'fr-BE-x-private', 'i-klingon', '12-34']) {
    assert.throws(() => normalizeBrandIdentity(identity({ default_locale: bad, supported_locales: [bad] })), /BCP 47/, bad);
  }
  for (const ok of ['fr-BE', 'nl-BE', 'en-GB', 'fr', 'zh-Hant-TW', 'es-419']) {
    assert.equal(normalizeBrandIdentity(identity({ default_locale: ok, supported_locales: [ok] })).default_locale, ok);
  }
});

test('4b. default_locale and supported_locales are compared after normalization', () => {
  const brand = normalizeBrandIdentity(identity({ default_locale: 'nl-be', supported_locales: ['FR-be', 'nl-BE'] }));
  assert.equal(brand.default_locale, 'nl-BE');
  assert.deepEqual(brand.supported_locales, ['fr-BE', 'nl-BE']);
  assert.throws(() => normalizeBrandIdentity(identity({ default_locale: 'en-gb', supported_locales: ['fr-BE'] })), /must be one of/);
});

test('5. supported_locales cannot be empty or missing', () => {
  assert.throws(() => normalizeBrandIdentity(identity({ supported_locales: [] })), /non-empty array/);
  assert.throws(() => normalizeBrandIdentity(identity({ supported_locales: undefined })), /non-empty array/);
});

test('6. default_locale must be one of supported_locales', () => {
  assert.throws(() => normalizeBrandIdentity(identity({ default_locale: 'en-GB', supported_locales: ['fr-BE', 'nl-BE'] })), /must be one of/);
});

test('7. duplicate locales are refused, including duplicates that only differ by casing', () => {
  assert.throws(() => normalizeBrandIdentity(identity({ supported_locales: ['fr-BE', 'nl-BE', 'fr-BE'] })), /duplicates/);
  assert.throws(() => normalizeBrandIdentity(identity({ supported_locales: ['fr-BE', 'FR-be'] })), /duplicates/);
});

test('8. parent_brand_id: null or another brand of the SAME merchant, without cycles', () => {
  const parent = normalizeBrandIdentity(identity());
  const child = normalizeBrandIdentity(identity({ brand_id: B2, name: 'Sub brand', parent_brand_id: B1 }));
  assert.equal(parent.parent_brand_id, null);
  assert.equal(validateBrandHierarchy([parent, child], tenant()).ok, true);

  assert.throws(() => normalizeBrandIdentity(identity({ parent_brand_id: B1 })), /cannot reference the brand itself/);
  assert.throws(() => normalizeBrandIdentity(identity({ parent_brand_id: 'house' })), /brand UUID/);

  assert.ok(validateBrandHierarchy([child], tenant()).reasons.includes('BRAND_PARENT_NOT_FOUND'));
  const foreignParent = normalizeBrandIdentity(identity({ brand_id: B1, merchant_id: M2 }));
  const result = validateBrandHierarchy([foreignParent, child], tenant());
  assert.ok(result.reasons.includes('BRAND_PARENT_TENANT_MISMATCH'));
  assert.ok(result.reasons.includes('BRAND_TENANT_MISMATCH'));

  const a = normalizeBrandIdentity(identity({ brand_id: B1, parent_brand_id: B2 }));
  const b = normalizeBrandIdentity(identity({ brand_id: B2, name: 'B', parent_brand_id: B1 }));
  assert.ok(validateBrandHierarchy([a, b], tenant()).reasons.includes('BRAND_PARENT_CYCLE'));
});

test('8b. hierarchy validation is only as complete as the graph the caller supplies (registry = open dependency)', async () => {
  const child = normalizeBrandIdentity(identity({ brand_id: B2, name: 'Sub brand', parent_brand_id: B1 }));
  // the parent exists in the registry but was not supplied: never a false "ok"
  const result = validateBrandHierarchy([child], tenant());
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ['BRAND_PARENT_NOT_FOUND']);
  const { readFile } = await import('node:fs/promises');
  const doc = await readFile('docs/architecture/branding-v1-contract.md', 'utf8');
  assert.match(doc, /complete only over the brand graph the caller supplies/);
  assert.match(doc, /persistent `brands` registry, which remains an \*\*open dependency\*\*/);
});

test('9. Brand Identity is deeply frozen, minimal (no portfolio or Core/Memory content) and has a light status', () => {
  const brand = brandA();
  assert.equal(Object.isFrozen(brand), true);
  assert.equal(Object.isFrozen(brand.supported_locales), true);
  assert.throws(() => { brand.name = 'x'; }, TypeError);
  assert.throws(() => { brand.supported_locales.push('de-BE'); }, TypeError);
  for (const key of ['positioning', 'value_proposition', 'voice', 'design_tokens', 'hard_rules', 'portfolio_strategy', 'brand_equity', 'endorsement']) {
    assert.throws(() => normalizeBrandIdentity(identity({ [key]: 'x' })), /not part of Brand Identity V1/, key);
  }
  assert.deepEqual(Object.values(BRAND_STATUS), ['ACTIVE', 'INACTIVE']);
  assert.throws(() => normalizeBrandIdentity(identity({ status: 'APPROVED' })), /unsupported/);
});

// ------------------------------------------------------------------ Snapshot (10-11)
test('10. a Snapshot of another brand is refused everywhere it is consumed', () => {
  const planA = buildSnapshotResearchPlan({ tenant: tenant(), brand: brandA() });
  assert.equal(planA.brand_id, B1);
  assert.throws(() => buildBrandSnapshotV1({
    id: 's', tenant: tenant(), brand: brandB(), createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z', researchPlan: planA,
  }), /SNAPSHOT_RESEARCH_PLAN_BRAND_MISMATCH/);

  const snapA = snapshotFor(brandA(), 'a');
  assert.throws(() => buildBrandCoreProposal({
    id: 'c', tenant: tenant(), brand: brandB(), createdAt: '2026-10-08T10:00:00Z', snapshot: snapA, decisions: decisions(),
  }), /CORE_SNAPSHOT_BRAND_MISMATCH/);
});

test('11. two brands of the same merchant can each have their own Snapshot', () => {
  const build = (brand, id) => buildBrandSnapshotV1({
    id, tenant: tenant(), brand, createdAt: '2026-10-08T10:00:00Z', observedAt: '2026-10-08T10:00:00Z',
    researchPlan: buildSnapshotResearchPlan({ tenant: tenant(), brand }),
  }).snapshot;
  const a = build(brandA(), 'snap-a');
  const b = build(brandB(), 'snap-b');
  assert.equal(a.merchant_id, b.merchant_id);
  assert.notEqual(a.brand_id, b.brand_id);
  assert.deepEqual([a.brand_id, b.brand_id], [B1, B2]);
});

// ------------------------------------------------------------------ Core (12-14)
test('12. a Core must have the same brand_id as its Snapshot', () => {
  const snapA = snapshotFor(brandA(), 'a');
  const proposalA = buildBrandCoreProposal({
    id: 'core-a', tenant: tenant(), brand: brandA(), createdAt: '2026-10-08T10:00:00Z', snapshot: snapA, decisions: decisions(),
  });
  assert.equal(proposalA.core.brand_id, snapA.brand_id);
  // approving with the snapshot of the other brand
  assert.throws(() => approveBrandCore({
    proposal: proposalA.core, snapshot: snapshotFor(brandB(), 'b'), tenant: tenant(), brand: brandA(),
    resolvedActor: actor(), approvedAt: '2026-10-08T10:30:00Z',
  }), /CORE_SNAPSHOT_BRAND_MISMATCH/);
  // approving a brand A proposal as brand B
  assert.throws(() => approveBrandCore({
    proposal: proposalA.core, snapshot: snapA, tenant: tenant(), brand: brandB(),
    resolvedActor: actor(), approvedAt: '2026-10-08T10:30:00Z',
  }), /CORE_BRAND_MISMATCH/);
});

test('13. two APPROVED Cores for the same merchant AND the same brand are refused', () => {
  const { core } = chain(brandA(), 'a');
  assert.equal(selectActiveBrandCore([core], tenant(), brandA()).id, 'core-a');
  assert.throws(() => selectActiveBrandCore([core, { ...core, id: 'core-a2' }], tenant(), brandA()), /MULTIPLE_APPROVED_BRAND_CORES/);

  // a second proposal for the SAME brand must supersede the active one
  const snap = snapshotFor(brandA(), 'a2');
  const other = buildBrandCoreProposal({
    id: 'core-a2', tenant: tenant(), brand: brandA(), createdAt: '2026-10-08T10:00:00Z', snapshot: snap, decisions: decisions(),
  }).core;
  assert.throws(() => approveBrandCore({
    proposal: other, snapshot: snap, tenant: tenant(), brand: brandA(), resolvedActor: actor(), activeCore: core, approvedAt: '2026-10-08T10:30:00Z',
  }), /CORE_ACTIVE_CORE_MUST_BE_SUPERSEDED/);
});

test('14. one APPROVED Core per brand: different brands of one merchant each keep their own', () => {
  const a = chain(brandA(), 'a');
  const b = chain(brandB(), 'b'); // approved without any activeCore although brand A already has one
  assert.equal(a.core.status, 'APPROVED');
  assert.equal(b.core.status, 'APPROVED');
  assert.equal(selectActiveBrandCore([a.core, b.core], tenant(), brandA()).id, 'core-a');
  assert.equal(selectActiveBrandCore([a.core, b.core], tenant(), brandB()).id, 'core-b');
  // another brand's active Core cannot be passed as the one to supersede
  const snap = snapshotFor(brandB(), 'b2');
  const next = proposeBrandCoreRevision({
    approvedCore: b.core, snapshot: snap, tenant: tenant(), brand: brandB(), id: 'core-b2', createdAt: '2026-10-08T11:00:00Z', changes: { positioning: 'New' },
  }).core;
  assert.throws(() => approveBrandCore({
    proposal: next, snapshot: snap, tenant: tenant(), brand: brandB(), resolvedActor: actor(), activeCore: a.core, approvedAt: '2026-10-08T11:30:00Z',
  }), /CORE_ACTIVE_CORE_BRAND_MISMATCH/);
  assert.throws(() => proposeBrandCoreRevision({
    approvedCore: a.core, snapshot: snap, tenant: tenant(), brand: brandB(), id: 'x', createdAt: '2026-10-08T11:00:00Z',
  }), /CORE_BRAND_MISMATCH/);
});

// ------------------------------------------------------------------ Memory (15-17)
test('15. Memory.brand_id must equal Core.brand_id', () => {
  const a = chain(brandA(), 'a');
  assert.throws(() => buildBrandMemoryDraft({
    tenant: tenant(), brand: brandB(), id: 'm', createdAt: '2026-10-08T12:00:00Z', core: a.core,
    content: { design_tokens: { colors: { primary: '#112233' } } },
  }), /MEMORY_CORE_BRAND_MISMATCH/);
  assert.ok(validateBrandMemory(a.memory, { core: chain(brandB(), 'b').core }).reasons.includes('MEMORY_CORE_BRAND_MISMATCH'));
  assert.equal(a.memory.brand_id, a.core.brand_id);
  // submitting / approving as the wrong brand is refused too
  const draft = buildBrandMemoryDraft({
    tenant: tenant(), brand: brandA(), id: 'm2', createdAt: '2026-10-08T12:00:00Z', core: a.core,
    content: { design_tokens: { colors: { primary: '#112233' } } },
  }).memory;
  assert.throws(() => submitBrandMemoryForReview({ memory: draft, core: a.core, tenant: tenant(), brand: brandB() }), /MEMORY_BRAND_MISMATCH/);
});

test('16. two APPROVED Memories for the same brand are refused', () => {
  const a = chain(brandA(), 'a');
  assert.equal(selectActiveBrandMemory([a.memory], tenant(), brandA()).id, 'mem-a');
  assert.throws(() => selectActiveBrandMemory([a.memory, { ...a.memory, id: 'mem-x' }], tenant(), brandA()), /MULTIPLE_APPROVED_BRAND_MEMORIES/);

  const sibling = submitBrandMemoryForReview({
    memory: buildBrandMemoryDraft({
      tenant: tenant(), brand: brandA(), id: 'mem-other', createdAt: '2026-10-08T12:00:00Z', core: a.core,
      content: { design_tokens: { colors: { primary: '#112233' } } },
    }).memory,
    core: a.core, tenant: tenant(), brand: brandA(),
  });
  assert.throws(() => approveBrandMemory({
    memory: sibling, core: a.core, tenant: tenant(), brand: brandA(), resolvedActor: actor(), activeMemory: a.memory, approvedAt: '2026-10-08T14:00:00Z',
  }), /MEMORY_ACTIVE_MEMORY_MUST_BE_SUPERSEDED/);
});

test('17. APPROVED Memories of different brands of one merchant coexist', () => {
  const a = chain(brandA(), 'a');
  const b = chain(brandB(), 'b');
  assert.equal(a.memory.status, 'APPROVED');
  assert.equal(b.memory.status, 'APPROVED');
  assert.equal(selectActiveBrandMemory([a.memory, b.memory], tenant(), brandA()).id, 'mem-a');
  assert.equal(selectActiveBrandMemory([a.memory, b.memory], tenant(), brandB()).id, 'mem-b');
  // another brand's active Memory cannot be the one superseded
  const rev = proposeBrandMemoryRevision({
    approvedMemory: b.memory, core: b.core, tenant: tenant(), brand: brandB(), id: 'mem-b2', createdAt: '2026-10-08T14:00:00Z',
  }).memory;
  assert.throws(() => approveBrandMemory({
    memory: rev, core: b.core, tenant: tenant(), brand: brandB(), resolvedActor: actor(), activeMemory: a.memory, approvedAt: '2026-10-08T15:00:00Z',
  }), /MEMORY_ACTIVE_MEMORY_BRAND_MISMATCH/);
  assert.throws(() => proposeBrandMemoryRevision({
    approvedMemory: a.memory, core: a.core, tenant: tenant(), brand: brandB(), id: 'x', createdAt: '2026-10-08T14:00:00Z',
  }), /MEMORY_BRAND_MISMATCH/);
});

// ------------------------------------------------------------------ Brand Context (18-23)
const ctx = (over = {}) => {
  const a = chain(brandA(), 'a');
  return buildBrandContext({ tenant: tenant(), brand: brandA(), snapshot: a.snap, core: a.core, memory: a.memory, ...over });
};

test('18. no brand -> GATED (BRAND_IDENTITY_MISSING)', () => {
  const context = ctx({ brand: null });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(context.reasons.includes('BRAND_IDENTITY_MISSING'));
  assert.equal(context.brand, null);
  assert.throws(() => marketingBrandInterface(context), /BRAND_IDENTITY_MISSING/);
});

test('19. a brand of another tenant -> GATED (BRAND_TENANT_MISMATCH)', () => {
  const context = ctx({ brand: brandOf(M2, B3, 'Foreign Brand') });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(context.reasons.includes('BRAND_TENANT_MISMATCH'));
});

test('20. a Snapshot of the wrong brand -> GATED (BRAND_SNAPSHOT_BRAND_MISMATCH)', () => {
  const context = ctx({ snapshot: snapshotFor(brandB(), 'b') });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(context.reasons.includes('BRAND_SNAPSHOT_BRAND_MISMATCH'));
});

test('21. a Core of the wrong brand -> GATED (BRAND_CORE_BRAND_MISMATCH)', () => {
  const context = ctx({ core: chain(brandB(), 'b').core });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(context.reasons.includes('BRAND_CORE_BRAND_MISMATCH'));
});

test('22. a Memory of the wrong brand -> GATED (BRAND_MEMORY_BRAND_MISMATCH)', () => {
  const context = ctx({ memory: chain(brandB(), 'b').memory });
  assert.equal(context.status, BRAND_CONTEXT_STATUS.GATED);
  assert.ok(context.reasons.includes('BRAND_MEMORY_BRAND_MISMATCH'));
  assert.ok(context.reasons.includes('BRAND_MEMORY_CORE_MISMATCH') || context.reasons.includes('MEMORY_CORE_BRAND_MISMATCH'));
});

test('23. everything consistent -> READY, and the views say which brand they are about', () => {
  const context = ctx();
  assert.equal(context.status, BRAND_CONTEXT_STATUS.READY);
  assert.deepEqual(context.reasons, []);
  assert.equal(context.brand.brand_id, B1);

  const marketing = marketingBrandInterface(context);
  const creative = creativeBrandInterface(context);
  for (const view of [marketing, creative]) {
    assert.deepEqual(view.brand, { brand_id: B1, name: 'House Brand', default_locale: 'fr-BE', supported_locales: ['fr-BE', 'nl-BE'] });
    assert.equal(Object.isFrozen(view.brand), true);
    for (const leak of ['merchant_id', 'created_at', 'parent_brand_id', 'status']) assert.equal(leak in view.brand, false, leak);
  }
});

test('an INACTIVE brand is GATED and cannot start governed work', () => {
  const inactive = brandOf(M1, B1, 'Retired', { status: 'INACTIVE' });
  assert.ok(ctx({ brand: inactive }).reasons.includes('BRAND_INACTIVE'));
  assert.throws(() => buildSnapshotResearchPlan({ tenant: tenant(), brand: inactive }), /BRAND_INACTIVE/);
  assert.equal(resolveBrand(tenant(), inactive, { requireActive: false }).brandId, B1);
});

test('two brands of the same merchant produce two independent READY contexts', () => {
  const a = chain(brandA(), 'a');
  const b = chain(brandB(), 'b');
  const ctxA = buildBrandContext({ tenant: tenant(), brand: brandA(), core: a.core, memory: a.memory });
  const ctxB = buildBrandContext({ tenant: tenant(), brand: brandB(), core: b.core, memory: b.memory });
  assert.equal(ctxA.status, 'READY');
  assert.equal(ctxB.status, 'READY');
  assert.notEqual(marketingBrandInterface(ctxA).brand.brand_id, marketingBrandInterface(ctxB).brand.brand_id);
  // crossing them is refused
  assert.equal(buildBrandContext({ tenant: tenant(), brand: brandA(), core: b.core, memory: b.memory }).status, 'GATED');
});

// ------------------------------------------------------------------ Decision events (24-25)
test('24. the Core approval event identifies merchant, brand and subject', () => {
  const { coreResult } = chain(brandA(), 'a');
  const event = coreResult.decisionEvent;
  assert.equal(event.type, 'BRAND_CORE_APPROVED');
  assert.equal(event.merchant_id, M1);
  assert.equal(event.brand_id, B1);
  assert.deepEqual(event.subject, { kind: 'brand_core', id: 'core-a', version: 1 });
  assert.equal(coreResult.approvedCore.approval.decision_event_id, event.id);
  assert.equal(buildCoreDecisionPacket({ proposal: coreResult.approvedCore, snapshot: snapshotFor(brandA(), 'a') }).brand_id, B1);
});

test('25. the Memory approval event identifies merchant, brand and subject; the event id depends on the brand', () => {
  const { memoryResult } = chain(brandA(), 'a');
  const event = memoryResult.decisionEvent;
  assert.equal(event.type, 'BRAND_MEMORY_APPROVED');
  assert.equal(event.merchant_id, M1);
  assert.equal(event.brand_id, B1);
  assert.deepEqual(event.subject, { kind: 'brand_memory', id: 'mem-a', version: 1 });
  // same ids/version/time, different brand -> different event
  const sameIdsOtherBrand = chain(brandOf(M1, B2, 'Other'), 'a');
  assert.notEqual(sameIdsOtherBrand.memoryResult.decisionEvent.id, event.id);
  assert.notEqual(sameIdsOtherBrand.coreResult.decisionEvent.id, chain(brandA(), 'a').coreResult.decisionEvent.id);
});

// Guardian (mandate tests 26-27: brand_id in the report, never inferred from the candidate) is covered
// against the V1 engine in test/branding-guardian.test.js ("Brand 26", "Brand 27" and the multi-brand tests).
