import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  EXPRESSION_DOMAINS, EXPRESSION_KEYS, buildBrandContext, buildBrandMemoryDraft, creativeBrandInterface, isExpressionNonEmpty, marketingBrandInterface,
  normalizeBrandMemory, normalizeExpressionSystem, validateBrandMemory, validateSchemaSubset,
} from '../src/branding/index.js';
import {
  BRAND, brandOf, buildCore, buildMemoryFlow, colorRule, reviseMemory, sampleExpression, tenant,
} from './branding-v11-world.js';

// `// PC2-N text` markers are rows of the PRE-C2 coverage matrix (docs/architecture/creative-pre-c2-foundation.md).

const throwsMsg = (fn, pattern) => assert.throws(fn, pattern);
const withExpression = (expression_system) => ({ hard_rules: [colorRule], design_tokens: { colors: { primary: '#112233' } }, expression_system });
const isDeepFrozen = (v) => v == null || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));

test('Brand Memory V1.1: expression_system is an additive, optional, governed sixth category', async () => {
  const legacy = buildMemoryFlow();
  const v11 = buildMemoryFlow({ content: withExpression(sampleExpression()) });
  // PC2-14 a legacy V1 Memory stays valid, keeps exactly its V1 shape and is still a READY context
  assert.ok(!('expression_system' in legacy.approved));
  assert.equal(legacy.context.status, 'READY');
  assert.equal(validateBrandMemory(legacy.approved, { core: legacy.core }).ok, true);
  assert.equal(normalizeBrandMemory(JSON.parse(JSON.stringify(legacy.approved))).id, legacy.approved.id);
  // the legacy document still passes the V1 schema, unchanged
  const schema = JSON.parse(await readFile('schemas/branding/brand-memory-v1.schema.json', 'utf8'));
  assert.equal(validateSchemaSubset(schema, JSON.parse(JSON.stringify(legacy.approved))).ok, true);
  // PC2-15 an expression_system is accepted, normalized and valid against the schema
  assert.equal(v11.context.status, 'READY');
  assert.deepEqual(Object.keys(v11.approved.expression_system), ['photography', 'composition', 'locale_overrides']);
  assert.deepEqual(v11.approved.expression_system.composition.do, []);
  assert.equal(validateSchemaSubset(schema, JSON.parse(JSON.stringify(v11.approved))).ok, true);
  assert.deepEqual([...EXPRESSION_DOMAINS, 'locale_overrides'], [...EXPRESSION_KEYS]);
  assert.deepEqual(Object.keys(schema.$defs.expression_overrides.properties), [...EXPRESSION_DOMAINS]);
  // PC2-16 an unknown expression key is refused (anywhere: top level, domain, guideline, override)
  throwsMsg(() => normalizeExpressionSystem({ sound: { principles: ['x'] } }), /not part of Brand Memory V1.1/);
  throwsMsg(() => normalizeExpressionSystem({ photography: { principles: ['x'], mood: 'warm' } }), /not part of/);
  throwsMsg(() => normalizeExpressionSystem({ locale_overrides: { 'fr-BE': { layout: { principles: ['x'] } } } }), /not part of/);
  throwsMsg(() => normalizeExpressionSystem({ locale_overrides: { 'fr-BE': { locale_overrides: {} } } }), /not part of/);
  assert.equal(validateSchemaSubset(schema, { ...JSON.parse(JSON.stringify(v11.approved)), expression_system: { sound: {} } }).ok, false);
  // PC2-17 guideline lists and texts are bounded
  const many = Array.from({ length: 21 }, (_, i) => `rule ${i}`);
  throwsMsg(() => normalizeExpressionSystem({ photography: { principles: many } }), /at most 20/);
  throwsMsg(() => normalizeExpressionSystem({ photography: { principles: ['x'.repeat(301)] } }), /too long/);
  throwsMsg(() => normalizeExpressionSystem({ photography: { principles: ['same', 'same'] } }), /duplicates/);
  throwsMsg(() => normalizeExpressionSystem({ photography: { principles: [''] } }), /non-empty/);
  assert.equal(normalizeExpressionSystem({ photography: { principles: Array.from({ length: 20 }, (_, i) => `rule ${i}`) } }).photography.principles.length, 20);
  // PC2-18 a raw URL / location is refused as a reference and inside a text
  for (const bad of ['https://cdn.example.com/a.jpg', 'data:image/png;base64,AAAA', 'file:///a.png', 'cdn.example.com/a.jpg', 'has space']) {
    throwsMsg(() => normalizeExpressionSystem({ photography: { reference_asset_refs: [bad] } }), /opaque reference/);
  }
  throwsMsg(() => normalizeExpressionSystem({ photography: { principles: ['see https://example.com/look'] } }), /URL/);
  assert.deepEqual(normalizeExpressionSystem({ photography: { reference_asset_refs: ['approved-asset://p-1'] } }).photography.reference_asset_refs, ['approved-asset://p-1']);
  // PC2-19 no prompt, model, seed or score: as a key or as generation-parameter text
  for (const key of ['prompt', 'model', 'seed', 'premium_score', 'provider']) {
    throwsMsg(() => normalizeExpressionSystem({ photography: { [key]: 'x' } }), /not part of/);
  }
  for (const text of ['sunny beach --ar 16:9', 'seed: 42', 'use midjourney for this', 'negative prompt: blur', 'stable diffusion look']) {
    throwsMsg(() => normalizeExpressionSystem({ composition: { principles: [text] } }), /generation parameter/);
  }
  // hard rules are not expression guidelines: an exact colour, a claim or a policy reference is refused here
  throwsMsg(() => normalizeExpressionSystem({ composition: { principles: ['background must be #112233'] } }), /exact colour/);
  throwsMsg(() => normalizeExpressionSystem({ composition: { do: ['always say claim://price-25'] } }), /hard rule/);
  throwsMsg(() => normalizeExpressionSystem({ composition: { do: ['follow external-policy://promo'] } }), /hard rule/);
  // PC2-20 locale overrides: canonical keys only (never silently rewritten), partial, sorted
  throwsMsg(() => normalizeExpressionSystem({ locale_overrides: { 'fr-be': { composition: { principles: ['x'] } } } }), /canonical locale/);
  throwsMsg(() => normalizeExpressionSystem({ locale_overrides: { french: { composition: { principles: ['x'] } } } }), /canonical locale/);
  throwsMsg(() => normalizeExpressionSystem({ locale_overrides: { 'fr-BE': {} } }), /overrides nothing/);
  const ordered = normalizeExpressionSystem({ locale_overrides: { 'nl-BE': { motion: { principles: ['calm'] } }, 'ar-MA': { photography: { principles: ['warm'] } } } });
  assert.deepEqual(Object.keys(ordered.locale_overrides), ['ar-MA', 'nl-BE']);
  assert.deepEqual(Object.keys(ordered.locale_overrides['ar-MA']), ['photography']);
  // PC2-21 an override for a locale the brand does not support is refused at the governed boundary (draft; the brand is available)
  const { tenant: t, brand, core } = buildCore();
  const content = withExpression({ composition: { principles: ['x'] }, locale_overrides: { 'de-DE': { composition: { principles: ['y'] } } } });
  throwsMsg(() => buildBrandMemoryDraft({ tenant: t, brand, id: 'mem-x', createdAt: '2026-10-08T12:00:00Z', core, content }), /EXPRESSION_LOCALE_NOT_SUPPORTED/);
  throwsMsg(() => buildMemoryFlow({ content: withExpression({ locale_overrides: { 'ar-MA': { composition: { principles: ['y'] } } } }), supportedLocales: ['fr-BE', 'nl-BE'] }), /EXPRESSION_LOCALE_NOT_SUPPORTED/);
  assert.ok(buildMemoryFlow({ content: withExpression({ locale_overrides: { 'ar-MA': { composition: { principles: ['y'] } } } }) }));
  // PC2-22 an expression change is a REVISION: a new Memory version, REVIEW_REQUIRED first, approved by a human, the old one superseded
  const next = reviseMemory(v11, { expression_system: { ...sampleExpression(), motion: { principles: ['slow and calm'] } } });
  assert.equal(next.revision.memory.version, v11.approved.version + 1);
  assert.equal(next.revision.memory.status, 'REVIEW_REQUIRED');
  assert.equal(next.revision.auto_approved, false);
  assert.equal(next.approvedMemory.version, 2);
  assert.equal(next.supersededMemory.status, 'SUPERSEDED');
  assert.deepEqual(Object.keys(next.approvedMemory.expression_system), ['photography', 'composition', 'motion', 'locale_overrides']);
  assert.ok(!('motion' in v11.approved.expression_system));
  // a legacy Memory can gain an expression system only through the same governed revision
  const gained = reviseMemory(legacy, { expression_system: sampleExpression() });
  assert.equal(gained.approvedMemory.version, 2);
  assert.ok(isExpressionNonEmpty(gained.approvedMemory.expression_system));
  // PC2-23 an approved Memory is immutable (deeply frozen); a revision never mutates it
  assert.ok(isDeepFrozen(v11.approved));
  assert.throws(() => { v11.approved.expression_system.photography.principles.push('x'); }, TypeError);
  assert.throws(() => { v11.approved.expression_system.motion = {}; }, TypeError);
  assert.ok(!('motion' in v11.approved.expression_system));
  // PC2-24 the exact Core binding is unchanged: a Memory bound to another Core version is still GATED
  assert.deepEqual(v11.approved.core_ref, { id: core.id, version: core.version });
  const otherCore = { ...v11.core, version: 2 };
  assert.ok(buildBrandContext({ tenant: v11.tenant, brand: v11.brand, core: otherCore, memory: v11.approved }).reasons.includes('BRAND_MEMORY_CORE_MISMATCH'));
  // PC2-25 the creative interface exposes the expression system (and states absence explicitly for a legacy Memory)
  assert.deepEqual(creativeBrandInterface(v11.context).expression_system, JSON.parse(JSON.stringify(v11.approved.expression_system)));
  assert.equal(creativeBrandInterface(legacy.context).expression_system, null);
  assert.equal(isExpressionNonEmpty(creativeBrandInterface(legacy.context).expression_system), false);
  assert.ok(isDeepFrozen(creativeBrandInterface(v11.context)));
  // PC2-26 the marketing interface does not inherit the visual-expression payload
  const marketing = marketingBrandInterface(v11.context);
  assert.ok(!('expression_system' in marketing));
  assert.ok(!JSON.stringify(marketing).includes('natural directional light'));
  assert.ok(!JSON.stringify(marketing).includes('generous negative space'));
  assert.equal(brandOf().brand_id, BRAND);
  assert.equal(tenant().merchantId, brand.merchant_id);
});

test('An empty expression system is not an expression system', () => {
  assert.equal(isExpressionNonEmpty(null), false);
  assert.equal(isExpressionNonEmpty({}), false);
  assert.equal(isExpressionNonEmpty(normalizeExpressionSystem({ photography: {} })), false);
  assert.equal(isExpressionNonEmpty(normalizeExpressionSystem({ photography: { principles: ['x'] } })), true);
  assert.equal(isExpressionNonEmpty(normalizeExpressionSystem({ locale_overrides: { 'fr-BE': { motion: { dont: ['x'] } } } })), true);
});
