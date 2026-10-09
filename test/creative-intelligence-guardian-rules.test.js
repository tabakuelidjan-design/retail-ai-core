import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as P from '../src/creative-intelligence/production.js';
import * as CI from '../src/creative-intelligence/index.js';
import { evaluateBrandGuardian } from '../src/branding/index.js';
import { evaluateHardFidelityGate, requiredChecksFromInvariants } from '../src/creative-fidelity/fidelity-gates.js';
import { buildBrandPackage } from '../scripts/build-benchmark-brand-package.mjs';
import { createBenchmarkResolver } from '../scripts/benchmark-resources.mjs';
import { buildMemoryFlow } from './branding-v11-world.js';
import {
  AT, backgroundLayer, buildDocument, measurementInput, productLayer, renderCandidate, sha,
} from './fidelity-measurement-world.js';

// Brand Guardian hard rules R1-R3 on a manifest built from the actual document and the actual Fidelity gate (`// GR-N` markers).
// The rules live in the approved HABB Brand Memory v3; the documents are synthetic.

const json = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
const config = await json('benchmarks/creative-intelligence/habb-creative-benchmark-001.json');
const pkg = await json('benchmarks/creative-intelligence/habb-brand-canonical-v1.json');
const expression = (await json(pkg.inputs.expression_file)).expression_system;
const brand = buildBrandPackage(pkg.inputs, expression);
const roles = config.typography.roles;
const resolver = createBenchmarkResolver(config, { privatePayloads: false });
const tenant = { merchantId: config.merchant.merchant_id };
const loaded = {};
for (const [name, r] of Object.entries(roles)) loaded[name] = await P.loadRealFont({ resolver, font_ref: r.font_ref, instance_ref: r.instance_ref, variations: r.variations, tenant });
const dejavuBytes = new Uint8Array(await readFile(new URL('./fixtures/fonts/DejaVuSans.ttf', import.meta.url)));
const dejavu = P.createRealFont({
  font_ref: 'font-instance://test/dejavu', bytes: dejavuBytes, metadata: { family: 'DejaVu Sans', style: 'normal', weight: 400, version: '2.37', format: 'ttf', content_hash: sha(dejavuBytes), license_ref: 'license://fixture-font' },
});
const fonts = P.createRealFontRegistry([...Object.values(loaded), dejavu]);
const REQUIRED = requiredChecksFromInvariants(['PRESERVE_PRODUCT_GEOMETRY', 'PRESERVE_PIECE_COUNT', 'PRESERVE_PRODUCT_COLOR', 'PRESERVE_TEXT_EXACTLY']);

let z = 20;
const textLayer = (id, fontRef, color, content = 'Vos souvenirs. Votre création.') => ({
  id, type: 'TEXT', z_index: z++, geometry: { x: 80, y: 80, width: 900, height: 160, rotation_deg: 0 }, visibility: 'VISIBLE', locked: false, source_ref: null, constraints: [], effects: [],
  provenance: { origin: 'ENGINE', producer_ref: null, evidence_refs: [] }, content, font_ref: fontRef, font_size: 72, min_font_size: 44, line_height: 1.15, tracking: 0, alignment: 'START', max_lines: 2, color,
  box: { padding: 0, vertical_align: 'TOP' }, overflow_policy: 'RELAYOUT_REQUIRED', locale: 'fr-BE', direction: 'LTR', text_role: 'HEADLINE', text_kind: 'NON_CLAIM_CREATIVE_TEXT', claim_ref: null, approved_digest: null,
});
const doc = (layers) => buildDocument({ layers: [backgroundLayer(), productLayer(), ...layers] });
const validDoc = () => doc([textLayer('headline', roles.headline.instance_ref, '#183247')]);

const fidelityGate = (observations) => evaluateHardFidelityGate({ observations, requiredChecks: REQUIRED });
const passingGate = () => fidelityGate(P.measureProductFidelity(measurementInput(renderCandidate({ document: validDoc(), fonts }))));
const guardian = (document, gate, memoryContext = brand.context) => evaluateBrandGuardian({
  tenant: brand.tenant, brandContext: memoryContext, candidateManifest: P.buildCandidateManifest({ document, fonts, fidelityGate: gate }), targetRef: 'benchmark:test', evaluatedAt: AT,
});
const rule = (report, id) => report.rule_results.find((r) => r.rule_id === id);

test('The approved Memory carries exactly the three minimum hard rules, with the approved values', () => {
  const rules = brand.memory.hard_rules;
  // GR-1 R1 / R2 / R3 exist with the approved values; nothing benchmark-specific is in Memory
  assert.deepEqual(rules.map((r) => r.id), ['habb-palette-closed', 'habb-typography-two-families', 'habb-product-fidelity-gate']);
  assert.deepEqual([...rules[0].value], ['#183247', '#C56E54', '#FBF8F3', '#FFFFFF', '#0F2A52', '#C0392B']);
  assert.deepEqual([...rules[1].value], ['Playfair Display', 'Montserrat']);
  assert.deepEqual([...rules[2].value], ['PASS']);
  assert.ok(rules.every((r) => r.severity === 'BLOCK' && r.scope === 'IMAGE' && r.source_ref.startsWith('decision://habb/')));
  assert.doesNotMatch(JSON.stringify(rules), /asset:\/\/|claim:\/\/|product:\/\//);
  // cream stays an allowed token without being a required background
  assert.ok(rules[0].value.includes('#FBF8F3'));
  assert.equal(brand.memory.design_tokens.colors.cream, '#FBF8F3');
});

test('Complete valid evidence passes; the allowlists are allowlists, not requirements', () => {
  // GR-2 valid declared colours + allowed families + a PASS fidelity gate: every hard rule PASS
  const report = guardian(validDoc(), passingGate());
  assert.equal(report.hard_outcome, 'PASS');
  assert.equal(report.outcome, 'PASS');
  assert.deepEqual(report.rule_results.map((r) => [r.rule_id, r.outcome]), [['habb-palette-closed', 'PASS'], ['habb-typography-two-families', 'PASS'], ['habb-product-fidelity-gate', 'PASS']]);
  // a creative that uses only ONE of the six colours and ONE of the two families still passes
  const minimal = guardian(doc([textLayer('only', roles.price.instance_ref, '#FFFFFF')]), passingGate());
  assert.equal(minimal.outcome, 'PASS');
  // each of the six approved colours is accepted, including the two historical ones
  for (const colour of ['#183247', '#C56E54', '#FBF8F3', '#FFFFFF', '#0F2A52', '#C0392B']) {
    assert.equal(rule(guardian(doc([textLayer('t', roles.headline.instance_ref, colour)]), passingGate()), 'habb-palette-closed').outcome, 'PASS', colour);
  }
  // the manifest reflects the document: declared colours only (the photograph's pixels are never observed)
  const manifest = P.buildCandidateManifest({ document: validDoc(), fonts, fidelityGate: passingGate() });
  assert.deepEqual(manifest.colors[0].values, ['#183247', '#FFFFFF']);
  assert.equal(manifest.colors[0].coverage, 'COMPLETE');
  assert.deepEqual(manifest.typography[0].values, ['Playfair Display']);
});

test('R1 and R2: a declared colour or family outside the approved sets FAILS', () => {
  // GR-3 an off-palette declared headline colour (#000000) fails R1 and the Guardian outcome
  const black = guardian(doc([textLayer('headline', roles.headline.instance_ref, '#000000')]), passingGate());
  assert.equal(rule(black, 'habb-palette-closed').outcome, 'FAIL');
  assert.equal(rule(black, 'habb-palette-closed').reason, 'OBSERVED_VALUE_NOT_ALLOWED');
  assert.equal(black.outcome, 'FAIL');
  // an off-palette canvas / fill is declared colour too
  const fill = buildDocument({ layers: [backgroundLayer('#EFE9E1'), productLayer(), textLayer('headline', roles.headline.instance_ref, '#183247')] });
  assert.equal(rule(guardian(fill, passingGate()), 'habb-palette-closed').outcome, 'FAIL'); // the sand tone is not in the allowlist
  // GR-4 a third font family fails R2
  const third = guardian(doc([textLayer('headline', 'font-instance://test/dejavu', '#183247')]), passingGate());
  assert.equal(rule(third, 'habb-typography-two-families').outcome, 'FAIL');
  assert.equal(third.outcome, 'FAIL');
  // an unresolvable family is NOT_MEASURABLE (never guessed, never a pass)
  const unknown = guardian(doc([textLayer('headline', 'font-instance://test/unknown', '#183247')]), passingGate());
  assert.equal(rule(unknown, 'habb-typography-two-families').outcome, 'NOT_MEASURABLE');
});

test('R3: the Guardian consumes the Fidelity outcome and never recomputes it', () => {
  const clean = renderCandidate({ document: validDoc(), fonts });
  // GR-5 a STRETCHED product: Fidelity FAIL -> R3 FAIL -> Guardian FAIL (the chain, evaluated in that order)
  const stretched = renderCandidate({ document: validDoc(), fonts, mutateSvg: (svg) => svg.replace('xMidYMid meet', 'none') });
  const failGate = fidelityGate(P.measureProductFidelity(measurementInput(stretched)));
  assert.equal(failGate.outcome, 'FAIL');
  const failed = guardian(validDoc(), failGate);
  assert.equal(rule(failed, 'habb-product-fidelity-gate').outcome, 'FAIL');
  assert.equal(rule(failed, 'habb-palette-closed').outcome, 'PASS');
  assert.equal(failed.outcome, 'FAIL');
  // GR-6 Fidelity NOT_MEASURABLE -> R3 NOT_MEASURABLE -> the Guardian is NOT_MEASURABLE (never a PASS)
  const unmeasurable = fidelityGate(P.measureProductFidelity(measurementInput(clean, { text_regions: [] })));
  assert.equal(unmeasurable.outcome, 'NOT_MEASURABLE');
  const blocked = guardian(validDoc(), unmeasurable);
  assert.equal(rule(blocked, 'habb-product-fidelity-gate').outcome, 'NOT_MEASURABLE');
  assert.equal(blocked.outcome, 'NOT_MEASURABLE');
  // a candidate with product imagery but no fidelity observation at all: NOT_MEASURABLE, not compliance
  const manifest = P.buildCandidateManifest({ document: validDoc(), fonts, fidelityGate: null });
  assert.deepEqual(manifest.external_gates, []);
  assert.equal(rule(guardian(validDoc(), null), 'habb-product-fidelity-gate').outcome, 'NOT_MEASURABLE');
  // Guardian never recomputes: a FAIL gate stays FAIL however clean the candidate would measure
  assert.equal(rule(guardian(validDoc(), failGate), 'habb-product-fidelity-gate').outcome, 'FAIL');
});

test('Aggregation: worst wins, zero applicable rules is NOT_MEASURABLE, the semantic lane is advisory', () => {
  // GR-7 FAIL beats NOT_MEASURABLE beats PASS (an off-palette colour with an unmeasurable gate is a FAIL)
  const mixed = guardian(doc([textLayer('headline', roles.headline.instance_ref, '#000000')]), fidelityGate([]));
  assert.equal(mixed.hard_outcome, 'FAIL');
  // GR-8 zero applicable hard rules stays NOT_MEASURABLE in general (a Memory without rules proves nothing)
  const bare = buildMemoryFlow({ content: { design_tokens: { colors: { primary: '#112233' } } } });
  const none = evaluateBrandGuardian({
    tenant: bare.tenant, brandContext: bare.context, candidateManifest: P.buildCandidateManifest({ document: validDoc(), fonts, fidelityGate: passingGate() }), targetRef: 'benchmark:test', evaluatedAt: AT,
  });
  assert.equal(none.hard_outcome, 'NOT_MEASURABLE');
  assert.equal(none.hard_outcome_reason, 'NO_APPLICABLE_HARD_RULES');
  // a rule that does not apply to the content kind is not applicable, never a pass: the rules are IMAGE-scoped
  const documentKind = P.buildCandidateManifest({ document: validDoc(), fonts, fidelityGate: passingGate() });
  const asDocument = evaluateBrandGuardian({
    tenant: brand.tenant, brandContext: brand.context, candidateManifest: { ...documentKind, content_kind: 'DOCUMENT' }, targetRef: 'benchmark:test', evaluatedAt: AT,
  });
  assert.equal(asDocument.hard_outcome, 'NOT_MEASURABLE');
  assert.equal(asDocument.rule_results.length, 0);
  // GR-9 the semantic lane never makes a hard PASS: absent -> PASS stays PASS; an advisory REVIEW_REQUIRED can only raise it
  assert.equal(guardian(validDoc(), passingGate()).outcome, 'PASS');
  const reviewed = evaluateBrandGuardian({
    tenant: brand.tenant,
    brandContext: brand.context,
    candidateManifest: P.buildCandidateManifest({ document: validDoc(), fonts, fidelityGate: passingGate() }),
    targetRef: 'benchmark:test',
    evaluatedAt: AT,
    semanticAssessment: { outcome: 'REVIEW_REQUIRED', method: 'HUMAN', evidence_refs: [], note: null },
  });
  assert.equal(reviewed.outcome, 'REVIEW_REQUIRED');
  // and a hard FAIL is never rescued by a semantic PASS
  const rescued = evaluateBrandGuardian({
    tenant: brand.tenant,
    brandContext: brand.context,
    candidateManifest: P.buildCandidateManifest({ document: doc([textLayer('headline', roles.headline.instance_ref, '#000000')]), fonts, fidelityGate: passingGate() }),
    targetRef: 'benchmark:test',
    evaluatedAt: AT,
    semanticAssessment: { outcome: 'PASS', method: 'HUMAN', evidence_refs: [], note: null },
  });
  assert.equal(rescued.outcome, 'FAIL');
  assert.ok(CI.CI_VERSION);
});
